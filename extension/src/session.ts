// One collaboration session (host or guest), wired to the daemon.

import * as path from "node:path";
import * as vscode from "vscode";
import { DocBinding, type EditorPort } from "./binding.ts";
import { DaemonClient, type Msg } from "./daemon.ts";
import { GuestFs, type GuestFsBackend } from "./guestFs.ts";
import { type LangArgs, SemanticTokensRegistry, executeOnHost, registerGuestProviders, revive, reviveDiagnostics, serialize } from "./lang.ts";
import { Presence } from "./presence.ts";

export type Role = "Host" | "Guest";
export interface Peer {
  id: number;
  name: string;
  role: Role;
}

const REQUEST_TIMEOUT_MS = 15_000;

function editorPort(doc: vscode.TextDocument): EditorPort {
  return {
    getText: () => doc.getText(),
    apply: async (r) => {
      const we = new vscode.WorkspaceEdit();
      we.replace(doc.uri, new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), r.text);
      return vscode.workspace.applyEdit(we);
    },
  };
}

interface Waiter<T> {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

export class Session implements vscode.Disposable, GuestFsBackend {
  readonly role: Role;
  readonly sessionId: string;
  readonly invite: string;
  me: number;
  readonly peers = new Map<number, Peer>();
  connected = true;
  private readonly rootUri: vscode.Uri | undefined;
  private readonly client: DaemonClient;
  private readonly log: vscode.LogOutputChannel;
  private readonly bindings = new Map<string, DocBinding>();
  private readonly openWaiters = new Map<string, Waiter<string | null>[]>();
  private readonly requests = new Map<number, Waiter<any>>();
  private readonly seededByMe = new Set<string>();
  private readonly diagTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reopening = new Set<string>();
  private nextId = 1;
  private disposables: vscode.Disposable[] = [];
  private readonly presence: Presence;
  private diagnostics: vscode.DiagnosticCollection | undefined;
  /** Bumped on every pushed diagnostics update, so a slower pull can't overwrite it. */
  private readonly diagPushes = new Map<string, number>();
  private semantic: SemanticTokensRegistry | undefined;
  private disposed = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly ended = new vscode.EventEmitter<string>();
  /** Fires when the session is over (reason). */
  readonly onDidEnd = this.ended.event;

  static async attach(port: number, token: string, log: vscode.LogOutputChannel): Promise<Session> {
    const client = await DaemonClient.connect(port, token);
    const hello = await new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("daemon did not respond")), 10_000);
      client.once("message", (m: Msg) => {
        clearTimeout(timer);
        if (m.t === "hello") resolve(m);
        else reject(new Error(`unexpected first message ${m.t}`));
      });
      client.once("close", () => reject(new Error("daemon closed the connection")));
    });
    return new Session(client, hello, log);
  }

  private constructor(client: DaemonClient, hello: Msg, log: vscode.LogOutputChannel) {
    this.client = client;
    this.log = log;
    this.role = hello.role;
    this.me = hello.me;
    this.sessionId = hello.session;
    this.invite = hello.invite;
    this.rootUri = hello.root ? vscode.Uri.file(hello.root) : undefined;
    for (const p of hello.peers as Peer[]) this.peers.set(p.id, p);

    client.on("message", (m: Msg) => {
      try {
        this.onMessage(m);
      } catch (e) {
        this.log.error(`handling ${m.t}: ${e}`);
      }
    });
    client.on("close", () => this.end("lost connection to the mls daemon"));

    this.presence = new Presence({
      bindingFor: (d) => this.bindingFor(d),
      bindingByPath: (p) => this.bindings.get(p),
      uriFor: (p) => this.uriFor(p),
      send: (p, data) => this.client.send({ t: "presence", path: p, data }),
      peerName: (id) => this.peers.get(id)?.name ?? `peer ${id}`,
    });
    this.disposables.push(
      this.presence,
      vscode.workspace.onDidChangeTextDocument((e) => {
        const b = this.bindingFor(e.document);
        if (b && e.contentChanges.length) {
          b.onEditorChange(e.contentChanges.map((c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })));
        }
      }),
      vscode.workspace.onDidOpenTextDocument((d) => this.onOpened(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.onClosed(d)),
    );

    if (this.role === "Guest") {
      this.diagnostics = vscode.languages.createDiagnosticCollection("ferroshare");
      const req = (method: string, args: LangArgs) => this.lang(method, args);
      this.semantic = new SemanticTokensRegistry(req, (u) => GuestFs.pathOf(u));
      this.disposables.push(this.diagnostics, this.semantic, ...registerGuestProviders(req, (u) => GuestFs.pathOf(u)));
      // Re-attach documents that survived a window reload.
      for (const d of vscode.workspace.textDocuments) if (this.isOurs(d.uri)) void this.openText(this.pathOf(d.uri)!);
    } else {
      this.disposables.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
          for (const uri of e.uris) {
            const p = this.pathOf(uri);
            if (p && this.bindings.has(p)) this.pushDiagnostics(p);
          }
        }),
      );
    }
  }

  // ------------------------------------------------------------ paths

  private isOurs(uri: vscode.Uri): boolean {
    return this.role === "Guest" ? uri.scheme === "mls" && uri.authority === this.sessionId : this.pathOf(uri) !== null;
  }

  /** Workspace-relative `a/b.cs`, or null if the URI isn't part of the share. */
  pathOf(uri: vscode.Uri): string | null {
    if (this.role === "Guest") return uri.scheme === "mls" && uri.authority === this.sessionId ? GuestFs.pathOf(uri) : null;
    if (uri.scheme !== "file" || !this.rootUri) return null;
    const rel = path.relative(this.rootUri.fsPath, uri.fsPath);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    const p = rel.split(path.sep).join("/");
    return p === ".git" || p.startsWith(".git/") ? null : p;
  }

  uriFor(p: string): vscode.Uri {
    if (this.role === "Guest") return vscode.Uri.from({ scheme: "mls", authority: this.sessionId, path: "/" + p });
    return vscode.Uri.joinPath(this.rootUri!, ...p.split("/"));
  }

  bindingFor(doc: vscode.TextDocument): DocBinding | undefined {
    const p = this.pathOf(doc.uri);
    return p === null ? undefined : this.bindings.get(p);
  }

  peerName(id: number): string {
    return this.peers.get(id)?.name ?? `peer ${id}`;
  }

  get hostName(): string {
    return [...this.peers.values()].find((p) => p.role === "Host")?.name ?? "host";
  }

  // --------------------------------------------------------- messages

  private onMessage(m: Msg): void {
    switch (m.t) {
      case "peerJoined":
        this.peers.set(m.peer.id, m.peer);
        if (m.peer.id !== this.me) void vscode.window.showInformationMessage(`${m.peer.name} joined the session.`);
        this.changed.fire();
        break;
      case "peerLeft": {
        const name = this.peerName(m.id);
        this.peers.delete(m.id);
        this.presence.removePeer(m.id);
        void vscode.window.showInformationMessage(`${name} left the session.`);
        this.changed.fire();
        break;
      }
      case "peers":
        this.me = m.me;
        this.peers.clear();
        for (const p of m.peers as Peer[]) this.peers.set(p.id, p);
        this.changed.fire();
        break;
      case "status":
        this.connected = m.connected;
        this.changed.fire();
        break;
      case "ended":
        this.end(m.reason);
        break;
      case "docState":
        this.onDocState(m.path, Buffer.from(m.update, "base64"));
        break;
      case "openFailed":
        this.settleOpen(m.path, m.error === "binary" ? null : new Error(m.error));
        break;
      case "update": {
        const b = this.bindings.get(m.path);
        if (!b) break;
        b.applyRemote(Buffer.from(m.update, "base64"));
        if (this.role === "Host" && !b.attached) void this.ensureHostDoc(m.path);
        break;
      }
      case "readDoc":
        void this.onReadDoc(m.path);
        break;
      case "fsResult":
      case "langResponse":
        this.settleRequest(m.id, m.ok, m.err);
        break;
      case "presence":
        if (this.presence.onRemote(m.from, m.path, m.data)) this.changed.fire();
        break;
      case "save":
        void this.onSave(m.path);
        break;
      case "langRequest":
        void this.onLangRequest(m.from, m.id, m.method, m.args);
        break;
      case "diagnostics":
        this.diagPushes.set(m.path, (this.diagPushes.get(m.path) ?? 0) + 1);
        this.diagnostics?.set(this.uriFor(m.path), reviveDiagnostics(m.json, (p) => this.uriFor(p)));
        break;
      case "error":
        void vscode.window.showErrorMessage(`Ferroshare: ${m.message}`);
        break;
    }
  }

  // -------------------------------------------------------- documents

  private onDocState(p: string, state: Uint8Array): void {
    let b = this.bindings.get(p);
    if (b) {
      b.applyRemote(state);
    } else {
      b = new DocBinding(p, state, (u) => this.client.send({ t: "update", path: p, update: Buffer.from(u).toString("base64") }), (msg) => this.log.warn(msg));
      this.bindings.set(p, b);
    }
    if (this.role === "Host") {
      void this.ensureHostDoc(p);
      this.pushDiagnostics(p);
    } else {
      const doc = vscode.workspace.textDocuments.find((d) => this.pathOf(d.uri) === p);
      if (doc && !b.attached) this.attachGuestDoc(b, doc);
      this.settleOpen(p, b.text());
    }
    updateContextKey();
  }

  /** Host: keep the shared document open in VS Code so language servers see live text. */
  private async ensureHostDoc(p: string): Promise<void> {
    const b = this.bindings.get(p);
    if (!b || b.attached || this.reopening.has(p)) return;
    this.reopening.add(p);
    try {
      const doc = await vscode.workspace.openTextDocument(this.uriFor(p));
      if (!b.attached && !this.disposed) b.attach(editorPort(doc), this.seededByMe.delete(p));
    } catch (e) {
      this.log.error(`could not open ${p}: ${e}`);
    } finally {
      this.reopening.delete(p);
    }
  }

  private attachGuestDoc(b: DocBinding, doc: vscode.TextDocument): void {
    b.attach(editorPort(doc), false);
    void this.semantic?.ensure(doc);
    const pushesBefore = this.diagPushes.get(b.path) ?? 0;
    void this.langRaw("diagnostics", { path: b.path })
      .then((json) => {
        if ((this.diagPushes.get(b.path) ?? 0) === pushesBefore) this.diagnostics?.set(doc.uri, reviveDiagnostics(json, (q) => this.uriFor(q)));
      })
      .catch(() => {});
  }

  private onOpened(doc: vscode.TextDocument): void {
    const b = this.bindingFor(doc);
    if (!b || b.attached) return;
    if (this.role === "Guest") this.attachGuestDoc(b, doc);
    else b.attach(editorPort(doc), false);
    updateContextKey();
  }

  private onClosed(doc: vscode.TextDocument): void {
    const b = this.bindingFor(doc);
    if (!b) return;
    b.detach();
    if (this.role === "Guest") {
      this.bindings.delete(b.path);
      b.destroy();
      this.diagnostics?.delete(doc.uri);
      this.client.send({ t: "close", path: b.path });
    }
    // Host: the binding stays; the buffer is reopened on the next change.
  }

  private async onReadDoc(p: string): Promise<void> {
    let text: string | null = null;
    try {
      text = (await vscode.workspace.openTextDocument(this.uriFor(p))).getText();
      this.seededByMe.add(p);
    } catch (e) {
      this.log.warn(`could not read ${p} from editor, daemon will use disk: ${e}`);
    }
    this.client.send({ t: "docText", path: p, text });
  }

  private async onSave(p: string): Promise<void> {
    const b = this.bindings.get(p);
    if (!b) return;
    await this.ensureHostDoc(p);
    await b.settle();
    const doc = vscode.workspace.textDocuments.find((d) => this.pathOf(d.uri) === p);
    if (doc?.isDirty) await doc.save();
  }

  private settleOpen(p: string, result: string | null | Error): void {
    const waiters = this.openWaiters.get(p) ?? [];
    this.openWaiters.delete(p);
    for (const w of waiters) result instanceof Error ? w.reject(result) : w.resolve(result);
  }

  // -------------------------------------------------- guest fs backend

  openText(p: string): Promise<string | null> {
    const b = this.bindings.get(p);
    if (b) return Promise.resolve(b.text());
    return new Promise((resolve, reject) => {
      const list = this.openWaiters.get(p);
      if (list) return list.push({ resolve, reject });
      this.openWaiters.set(p, [{ resolve, reject }]);
      this.client.send({ t: "open", path: p });
      setTimeout(() => this.settleOpen(p, new Error(`timed out opening ${p}`)), REQUEST_TIMEOUT_MS);
    });
  }

  isShared(p: string): boolean {
    return this.bindings.has(p);
  }

  async save(p: string): Promise<void> {
    this.client.send({ t: "save", path: p });
  }

  fs(op: Record<string, string>): Promise<any> {
    const id = this.nextId++;
    this.client.send({ t: "fs", id, op });
    return this.waitFor(id);
  }

  // ------------------------------------------------- language features

  /** Guest: run a language feature on the host. */
  async lang(method: string, args: LangArgs): Promise<any> {
    return revive(JSON.parse(await this.langRaw(method, args)), (p) => this.uriFor(p));
  }

  private langRaw(method: string, args: LangArgs): Promise<string> {
    const id = this.nextId++;
    this.client.send({ t: "langRequest", id, method, args: JSON.stringify(args) });
    return this.waitFor(id);
  }

  private async onLangRequest(from: number, id: number, method: string, argsJson: string): Promise<void> {
    try {
      const a = JSON.parse(argsJson) as LangArgs;
      if (!this.bindings.has(a.path)) throw new Error(`${a.path} is not shared`);
      await this.ensureHostDoc(a.path);
      await this.bindings.get(a.path)!.settle();
      const r = await executeOnHost(method, a, this.uriFor(a.path));
      const ok = JSON.stringify(serialize(r, (u) => this.pathOf(u)) ?? null);
      this.client.send({ t: "langResponse", to: from, id, ok, err: null });
    } catch (e) {
      this.client.send({ t: "langResponse", to: from, id, ok: null, err: String(e) });
    }
  }

  private pushDiagnostics(p: string): void {
    clearTimeout(this.diagTimers.get(p));
    this.diagTimers.set(
      p,
      setTimeout(() => {
        this.diagTimers.delete(p);
        const diags = vscode.languages.getDiagnostics(this.uriFor(p));
        this.client.send({ t: "diagnostics", path: p, json: JSON.stringify(serialize(diags, (u) => this.pathOf(u))) });
      }, 300),
    );
  }

  private waitFor<T>(id: number): Promise<T> {
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      setTimeout(() => this.settleRequest(id, null, "timed out waiting for the host"), REQUEST_TIMEOUT_MS);
    });
  }

  private settleRequest(id: number, ok: unknown, err: string | null): void {
    const w = this.requests.get(id);
    if (!w) return;
    this.requests.delete(id);
    if (err !== null && err !== undefined) w.reject(new Error(err));
    else w.resolve(ok);
  }

  // ------------------------------------------------------------- misc

  undo(doc: vscode.TextDocument, redo: boolean): boolean {
    const b = this.bindingFor(doc);
    if (!b) return false;
    if (redo) b.undo.redo();
    else b.undo.undo();
    return true;
  }

  participants() {
    return this.presence.participants();
  }

  locate(id: number) {
    return this.presence.locate(id);
  }

  leave(): void {
    this.client.send({ t: "leave" });
    this.end("you left the session");
  }

  private end(reason: string): void {
    if (this.disposed) return;
    this.dispose();
    this.ended.fire(reason);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.requests.values()) w.reject(new Error("session ended"));
    this.requests.clear();
    for (const p of [...this.openWaiters.keys()]) this.settleOpen(p, new Error("session ended"));
    for (const t of this.diagTimers.values()) clearTimeout(t);
    for (const b of this.bindings.values()) b.destroy();
    this.bindings.clear();
    for (const d of this.disposables) d.dispose();
    this.client.close();
    updateContextKey();
  }
}

let current: Session | undefined;
export function setCurrentForContext(s: Session | undefined): void {
  current = s;
  updateContextKey();
}

/** `mls.inSharedDoc` drives the undo/redo keybindings. */
export function updateContextKey(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const inShared = !!(current && doc && current.bindingFor(doc));
  void vscode.commands.executeCommand("setContext", "mls.inSharedDoc", inShared);
}

// One collaboration session (host or guest), wired to the daemon.

import * as path from "node:path";
import * as vscode from "vscode";
import { DocBinding, type EditorPort } from "./binding.ts";
import { DaemonClient, type Msg } from "./daemon.ts";
import { type FsChange, GuestFs, type GuestFsBackend } from "./guestFs.ts";
import { type LangArgs, SemanticTokensRegistry, executeOnHost, registerGuestProviders, revive, reviveDiagnostics, serialize } from "./lang.ts";
import { Presence } from "./presence.ts";
import { SharedTerminal } from "./terminals.ts";

export type Role = "Host" | "Guest";
export interface Peer {
  id: number;
  name: string;
  role: Role;
}

const REQUEST_TIMEOUT_MS = 15_000;

const isUnder = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");

/** `FileExists: …` etc., so the guest's VS Code can tell errors apart. */
function fsErrorText(e: unknown): string {
  if (e instanceof vscode.FileSystemError && e.code) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

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
  private readonly filesChanged = new vscode.EventEmitter<FsChange>();
  readonly onDidChangeFiles = this.filesChanged.event;
  readonly terminals = new Map<number, SharedTerminal>();
  /** Guest: renames I asked for (`from\nto`). Renames by others move my open tabs. */
  private readonly ownRenames = new Set<string>();
  /** Guest: someone else's rename, about to be replayed on my open tabs (from -> to). */
  private readonly moves = new Map<string, string>();
  /** Guest: new locations of a replay still in progress; their documents attach after it. */
  private readonly arriving = new Set<string>();
  /** Host: guests' renames I'm carrying out, so they aren't reported back as mine. */
  private readonly applyingRenames = new Set<string>();

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
      const shared = (uris: readonly vscode.Uri[]) => uris.map((u) => this.pathOf(u)).filter((p): p is string => p !== null);
      const notify = (c: Partial<FsChange>) => {
        if (c.created?.length || c.changed?.length || c.removed?.length || c.renamed?.length) this.client.send({ t: "fsNotify", ...c });
      };
      this.disposables.push(
        vscode.languages.onDidChangeDiagnostics((e) => {
          for (const uri of e.uris) {
            const p = this.pathOf(uri);
            if (p && this.bindings.has(p)) this.pushDiagnostics(p);
          }
        }),
        // The host's own file operations, so guests' explorers and documents follow.
        vscode.workspace.onDidCreateFiles((e) => notify({ created: shared(e.files) })),
        vscode.workspace.onDidDeleteFiles((e) => notify({ removed: shared(e.files) })),
        vscode.workspace.onDidRenameFiles((e) => {
          const c: FsChange = { created: [], changed: [], removed: [], renamed: [] };
          for (const f of e.files) {
            const [from, to] = [this.pathOf(f.oldUri), this.pathOf(f.newUri)];
            if (from !== null && to !== null) {
              if (!this.applyingRenames.delete(`${from}\n${to}`)) c.renamed.push([from, to]);
            } else if (from !== null) c.removed.push(from);
            else if (to !== null) c.created.push(to);
          }
          notify(c);
        }),
      );
    }
    this.disposables.push(this.filesChanged);
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
      case "fsApply":
        void this.onFsApply(m.id, m.op);
        break;
      case "fsChanged":
        this.onFilesChanged({ created: m.created, changed: m.changed, removed: m.removed, renamed: m.renamed ?? [] });
        break;
      case "termOpened":
        this.onTermOpened(m.id, m.name, m.writable);
        break;
      case "termOutput":
        this.terminals.get(m.id)?.output(Buffer.from(m.data, "base64"));
        break;
      case "termSize": {
        const t = this.terminals.get(m.id);
        if (t) {
          t.size = { cols: m.cols, rows: m.rows };
          t.sizedFor = m.by;
          this.changed.fire();
        }
        break;
      }
      case "termClosed": {
        const t = this.terminals.get(m.id);
        this.terminals.delete(m.id);
        t?.exit(m.code === null || m.code === undefined ? "terminal closed" : `process exited with code ${m.code}`);
        this.changed.fire();
        break;
      }
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
      if (doc && !b.attached && !this.moving(p)) this.attachGuestDoc(b, doc);
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
    if (!b || b.attached || this.moving(b.path)) return;
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

  // ------------------------------------------------------ file changes

  /** Host: carry out a guest's file change (already checked by the daemon's sandbox). */
  private async onFsApply(id: number, op: any): Promise<void> {
    try {
      if (op.write) {
        await vscode.workspace.fs.writeFile(this.uriFor(op.write.path), Buffer.from(op.write.data, "base64"));
      } else if (op.createDir !== undefined) {
        await vscode.workspace.fs.createDirectory(this.uriFor(op.createDir));
      } else if (op.delete) {
        const uri = this.uriFor(op.delete.path);
        try {
          await vscode.workspace.fs.delete(uri, { recursive: op.delete.recursive, useTrash: true });
        } catch (e) {
          if (e instanceof vscode.FileSystemError && e.code === "FileNotFound") throw e;
          this.log.warn(`no trash for ${op.delete.path} (${e}); deleting permanently`);
          await vscode.workspace.fs.delete(uri, { recursive: op.delete.recursive, useTrash: false });
        }
      } else if (op.rename) {
        // Through a WorkspaceEdit, so the host's open editors and unsaved
        // changes move along (and language servers can update imports).
        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(this.uriFor(op.rename.from), this.uriFor(op.rename.to), { overwrite: op.rename.overwrite });
        const key = `${op.rename.from}\n${op.rename.to}`;
        this.applyingRenames.add(key);
        try {
          if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`could not rename ${op.rename.from}`);
        } finally {
          setTimeout(() => this.applyingRenames.delete(key), 1000);
        }
      } else {
        throw new Error(`unknown file operation ${JSON.stringify(op)}`);
      }
      this.client.send({ t: "fsApplied", id, err: null });
    } catch (e) {
      this.log.warn(`guest file change failed: ${fsErrorText(e)}`);
      this.client.send({ t: "fsApplied", id, err: fsErrorText(e) });
    }
  }

  /**
   * Files changed. Shared documents below removed paths are gone; those below
   * renamed paths come back under the new name (the daemon sends a
   * `docState` for each right after this).
   */
  private onFilesChanged(c: FsChange): void {
    const gone = [...c.removed, ...c.renamed.map(([from]) => from)];
    for (const [p, b] of [...this.bindings]) {
      if (!gone.some((r) => isUnder(p, r))) continue;
      b.destroy();
      this.bindings.delete(p);
      if (this.role === "Guest") this.diagnostics?.delete(this.uriFor(p));
    }
    if (this.role === "Guest") {
      for (const [from, to] of c.renamed) {
        if (this.ownRenames.delete(`${from}\n${to}`)) continue; // VS Code moved my tabs already
        const open = vscode.workspace.textDocuments.some((d) => {
          const p = d.isClosed ? null : this.pathOf(d.uri);
          return p !== null && isUnder(p, from);
        });
        if (open) void this.followRename(from, to);
      }
    }
    this.filesChanged.fire(c);
    updateContextKey();
  }

  /**
   * Guest: someone else renamed files I have open. Move my tabs (and unsaved
   * changes) the way VS Code does for my own renames, by replaying the
   * rename here. GuestFs recognises the replay and doesn't send it to the
   * host again; the documents are attached once they're at the new name.
   */
  private async followRename(from: string, to: string): Promise<void> {
    this.moves.set(from, to);
    this.arriving.add(to);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(this.uriFor(from), this.uriFor(to), { overwrite: true });
      if (!(await vscode.workspace.applyEdit(edit))) this.log.warn(`could not move tabs from ${from} to ${to}`);
    } catch (e) {
      this.log.warn(`could not move tabs from ${from} to ${to}: ${e}`);
    } finally {
      this.moves.delete(from);
      this.arriving.delete(to);
    }
    for (const d of vscode.workspace.textDocuments) {
      const p = this.pathOf(d.uri);
      if (p !== null && isUnder(p, to) && !d.isClosed) this.onOpened(d);
    }
  }

  private moving(p: string): boolean {
    return [...this.arriving].some((to) => isUnder(p, to));
  }

  moveOf(p: string): { from: string; to: string } | undefined {
    for (const [from, to] of this.moves) if (isUnder(p, from) || isUnder(p, to)) return { from, to };
    return undefined;
  }

  /** GuestFs did the replayed rename: from now on the files are where they really are. */
  moveReplayed(from: string): void {
    this.moves.delete(from);
  }

  // --------------------------------------------------------- terminals

  /** Host: start sharing a new terminal. */
  shareTerminal(writable: boolean): void {
    const shell = vscode.env.shell || null;
    const name = shell ? shell.split(/[\\/]/).pop()!.replace(/\.exe$/i, "") : "terminal";
    this.client.send({ t: "termOpen", name, shell, writable });
  }

  private onTermOpened(id: number, name: string, writable: boolean): void {
    const existing = this.terminals.get(id);
    if (existing) {
      existing.reset(); // the daemon replays the history next
      return;
    }
    const t = new SharedTerminal(
      id,
      name,
      writable,
      this.role === "Host",
      {
        input: (i, data) => this.client.send({ t: "termInput", id: i, data }),
        resize: (i, cols, rows) => this.client.send({ t: "termResize", id: i, cols, rows }),
        fit: (i) => this.client.send({ t: "termFit", id: i }),
        close: (i) => this.client.send({ t: "termClose", id: i }),
      },
      this.hostName,
    );
    this.terminals.set(id, t);
    t.show(this.role === "Guest");
    if (this.role === "Guest") {
      void vscode.window.showInformationMessage(`${this.hostName} shared a terminal${writable ? " you can type in" : " (read-only)"}.`);
    }
    this.changed.fire();
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

  fs(op: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    this.client.send({ t: "fs", id, op });
    const reply = this.waitFor(id);
    const r = op.rename as { from: string; to: string } | undefined;
    if (r) {
      const key = `${r.from}\n${r.to}`;
      this.ownRenames.add(key);
      reply.catch(() => this.ownRenames.delete(key));
    }
    return reply;
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
    for (const t of this.terminals.values()) t.exit("session ended");
    this.terminals.clear();
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

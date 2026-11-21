import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { findDaemon, spawnDaemon } from "./daemon.ts";
import { GuestFs, type GuestFsBackend } from "./guestFs.ts";
import { Session, setCurrentForContext, updateContextKey } from "./session.ts";
import { SessionView } from "./sessionView.ts";

let session: Session | undefined;
let ctx: vscode.ExtensionContext;
let log: vscode.LogOutputChannel;
let status: vscode.StatusBarItem;
let view: SessionView;

interface Saved {
  port: number;
  token: string;
}

const HOST_KEY = "mls.host";
const guestKey = (session: string) => `mls.guest.${session}`;

export function activate(context: vscode.ExtensionContext): { view: SessionView; session: () => Session | undefined } {
  ctx = context;
  log = vscode.window.createOutputChannel("Ferroshare", { log: true });

  // The guest file system must be registered synchronously, before VS Code
  // asks for the mls:// workspace folder; it waits for the session to attach.
  let resolveBackend!: (b: GuestFsBackend) => void;
  let rejectBackend!: (e: Error) => void;
  const backend = new Promise<GuestFsBackend>((res, rej) => {
    resolveBackend = res;
    rejectBackend = rej;
  });
  backend.catch(() => {});
  const guestFs = new GuestFs(backend);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider("mls", guestFs, { isCaseSensitive: true }), guestFs);

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "mls.menu";
  view = new SessionView(() => session);
  context.subscriptions.push(status, log, vscode.window.registerTreeDataProvider("mls.session", view));
  render();
  status.show();

  const cmd = (id: string, f: (...a: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...a) => {
        try {
          await f(...a);
        } catch (e) {
          log.error(`${id}: ${e}`);
          void vscode.window.showErrorMessage(`Ferroshare: ${e instanceof Error ? e.message : e}`);
        }
      }),
    );
  cmd("mls.menu", menu);
  cmd("mls.host", host);
  cmd("mls.join", join);
  cmd("mls.copyInvite", copyInvite);
  cmd("mls.goToParticipant", goToParticipant);
  cmd("mls.leave", leave);
  cmd("mls.shareTerminal", shareTerminal);
  cmd("mls.showTerminal", showTerminal);
  cmd("mls.fitTerminal", fitTerminal);
  cmd("mls.undo", () => undoRedo(false));
  cmd("mls.redo", () => undoRedo(true));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateContextKey()));

  // Re-attach to a running session after a window reload.
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder?.uri.scheme === "mls") {
    // MLS_TEST_ATTACH: integration tests attach without going through the join flow.
    const testAttach = process.env.MLS_TEST_ATTACH ? (JSON.parse(process.env.MLS_TEST_ATTACH) as Saved) : undefined;
    const saved = testAttach ?? context.globalState.get<Saved>(guestKey(folder.uri.authority));
    const attach = saved ? attachTo(saved) : Promise.reject(new Error("This session is no longer available."));
    attach.then(resolveBackend, (e) => {
      rejectBackend(e);
      void context.globalState.update(guestKey(folder.uri.authority), undefined);
      void vscode.window
        .showErrorMessage(`Ferroshare: could not rejoin (${e.message}). The host may have ended the session.`, "Close Folder")
        .then((c) => c && vscode.commands.executeCommand("workbench.action.closeFolder"));
    });
  } else {
    rejectBackend(new Error("not a guest window"));
    const saved = context.workspaceState.get<Saved>(HOST_KEY);
    if (saved) attachTo(saved).catch(() => context.workspaceState.update(HOST_KEY, undefined));
  }
  return { view, session: () => session }; // exposed for the integration tests
}

export function deactivate(): void {
  // Deliberately don't end the session: the daemon keeps it alive across
  // window reloads and leaves on its own if no editor comes back.
  session?.dispose();
}

async function attachTo(saved: Saved): Promise<Session> {
  const s = await Session.attach(saved.port, saved.token, log);
  session = s;
  setCurrentForContext(s);
  s.onDidChange(render);
  s.onDidEnd((reason) => {
    if (session === s) session = undefined;
    setCurrentForContext(undefined);
    render();
    if (s.role === "Host") {
      void ctx.workspaceState.update(HOST_KEY, undefined);
      void vscode.window.showInformationMessage(`Ferroshare session ended: ${reason}.`);
    } else {
      void ctx.globalState.update(guestKey(s.sessionId), undefined);
      void vscode.window
        .showWarningMessage(`Ferroshare session ended: ${reason}.`, "Close Folder")
        .then((c) => c && vscode.commands.executeCommand("workbench.action.closeFolder"));
    }
  });
  render();
  return s;
}

function render(): void {
  view.refresh();
  void vscode.commands.executeCommand("setContext", "mls.active", !!session);
  void vscode.commands.executeCommand("setContext", "mls.isHost", session?.role === "Host");
  if (!session) {
    status.text = "$(broadcast) Ferroshare";
    status.tooltip = "Host or join a collaboration session";
  } else if (!session.connected) {
    status.text = "$(sync~spin) Ferroshare: reconnecting…";
    status.tooltip = "Lost connection to the relay; edits are kept and will sync when it's back.";
  } else {
    const others = [...session.peers.values()].filter((p) => p.id !== session!.me);
    status.text = session.role === "Host" ? `$(broadcast) Hosting · ${others.length}` : `$(broadcast) ${session.hostName}'s session`;
    status.tooltip = others.length ? `With ${others.map((p) => p.name).join(", ")}` : "Waiting for others to join";
  }
}

function config() {
  const c = vscode.workspace.getConfiguration("ferroshare");
  return {
    relayUrl: c.get<string>("relayUrl", "ws://localhost:7777"),
    name: c.get<string>("displayName") || os.userInfo().username,
    daemonPath: c.get<string>("daemonPath", ""),
  };
}

function logFile(): string {
  const dir = ctx.globalStorageUri.fsPath;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `mls-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
}

async function menu(): Promise<void> {
  type Item = vscode.QuickPickItem & { run: () => unknown };
  const items: Item[] = !session
    ? [
        { label: "$(broadcast) Host session", description: "Share this folder", run: host },
        { label: "$(link) Join session", description: "Paste an invite link", run: join },
      ]
    : [
        ...(session.role === "Host"
          ? [
              { label: "$(copy) Copy invite link", run: copyInvite },
              { label: "$(terminal) Share terminal", description: "Run a shell others can watch or use", run: shareTerminal },
            ]
          : []),
        ...(session.terminals.size ? [{ label: "$(terminal) Show shared terminal", run: showTerminal }] : []),
        { label: "$(person) Go to participant", run: goToParticipant },
        { label: session.role === "Host" ? "$(debug-stop) End session" : "$(sign-out) Leave session", run: leave },
      ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Ferroshare" });
  await pick?.run();
}

async function host(): Promise<void> {
  if (session) throw new Error("You're already in a session.");
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== "file") throw new Error("Open a local folder to share first.");
  const c = config();
  const exe = findDaemon(ctx.extensionPath, c.daemonPath);
  const ready = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Starting Ferroshare session…" }, () =>
    spawnDaemon(exe, ["host", "--relay", c.relayUrl, "--root", folder.uri.fsPath, "--name", c.name], logFile()),
  );
  await ctx.workspaceState.update(HOST_KEY, { port: ready.port, token: ready.token });
  await attachTo(ready);
  await vscode.env.clipboard.writeText(ready.invite);
  if (/^wss?:\/\/(localhost|127\.|\[::1\])/.test(c.relayUrl)) {
    void vscode.window
      .showWarningMessage(
        `Session started, but the invite uses ${c.relayUrl}, which only works on this computer. For friends elsewhere, set ferroshare.relayUrl to an address they can reach (e.g. ws://your-public-ip:7777).`,
        "Change Relay URL",
      )
      .then((choice) => choice && vscode.commands.executeCommand("workbench.action.openSettings", "ferroshare.relayUrl"));
  } else {
    void vscode.window
      .showInformationMessage("Session started. The invite link is on your clipboard — send it to your friends.", "Copy Again")
      .then((choice) => choice && vscode.env.clipboard.writeText(ready.invite));
  }
}

async function join(inviteArg?: string): Promise<void> {
  if (session) throw new Error("You're already in a session.");
  const clip = (await vscode.env.clipboard.readText()).trim();
  const invite =
    inviteArg ??
    (await vscode.window.showInputBox({
      title: "Join Ferroshare session",
      prompt: "Paste the invite link from the host",
      placeHolder: "wss://relay.example.com#session.token.key",
      value: /^wss?:\/\/\S+#\S+\.\S+$/.test(clip) ? clip : "",
      ignoreFocusOut: true,
      validateInput: (v) => (/^wss?:\/\/\S+#\S+\.\S+$/.test(v.trim()) ? null : "Invite links look like wss://relay.example.com#session.token.key"),
    }));
  if (!invite) return;
  const c = config();
  const exe = findDaemon(ctx.extensionPath, c.daemonPath);
  const ready = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Joining Ferroshare session…" }, () =>
    spawnDaemon(exe, ["join", invite.trim(), "--name", c.name], logFile()),
  );
  await ctx.globalState.update(guestKey(ready.session), { port: ready.port, token: ready.token });
  const uri = vscode.Uri.from({ scheme: "mls", authority: ready.session, path: "/" });
  // Opening the folder (re)starts the extension in that window, which then attaches.
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: !!vscode.workspace.workspaceFolders?.length });
}

async function copyInvite(): Promise<void> {
  if (!session) throw new Error("Not in a session.");
  await vscode.env.clipboard.writeText(session.invite);
  void vscode.window.showInformationMessage("Invite link copied.");
}

async function goToParticipant(id?: number): Promise<void> {
  if (!session) throw new Error("Not in a session.");
  const s = session;
  if (typeof id === "number") return jumpTo(s, id, s.peerName(id));
  const items = [...s.peers.values()]
    .filter((p) => p.id !== s.me)
    .map((p) => {
      const where = s.participants().find((x) => x.id === p.id)?.path;
      return { label: p.name, description: where || "(not in a shared file)", id: p.id };
    });
  if (!items.length) return void vscode.window.showInformationMessage("Nobody else is here yet.");
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Jump to…" });
  if (pick) await jumpTo(s, pick.id, pick.label);
}

async function jumpTo(s: Session, id: number, name: string): Promise<void> {
  const loc = s.locate(id);
  if (!loc) return void vscode.window.showInformationMessage(`${name} isn't in a shared file right now.`);
  const doc = await vscode.workspace.openTextDocument(loc.uri);
  const pos = doc.positionAt(loc.offset);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos) });
}

async function shareTerminal(): Promise<void> {
  if (session?.role !== "Host") throw new Error("Only the host can share a terminal.");
  const s = session;
  const pick = await vscode.window.showQuickPick(
    [
      { label: "$(eye) Read-only", description: "Guests watch the output", writable: false },
      { label: "$(terminal) Read/write", description: "Guests can type too", detail: "They can run any command on this computer, as you.", writable: true },
    ],
    { placeHolder: "Share a terminal" },
  );
  if (!pick) return;
  if (pick.writable) {
    const ok = await vscode.window.showWarningMessage(
      "Guests will be able to run any command on this computer, as you. Only do this with people you trust.",
      { modal: true },
      "Share Read/Write",
    );
    if (!ok) return;
  }
  s.shareTerminal(pick.writable);
}

async function showTerminal(id?: number): Promise<void> {
  if (!session) throw new Error("Not in a session.");
  const terms = [...session.terminals.values()];
  if (typeof id === "number") return session.terminals.get(id)?.show(false);
  if (!terms.length) {
    return void vscode.window.showInformationMessage(
      session.role === "Host" ? "No shared terminals. Use Share Terminal to start one." : `${session.hostName} hasn't shared a terminal.`,
    );
  }
  const pick = terms.length === 1 ? terms[0] : (await vscode.window.showQuickPick(terms.map((t) => ({ label: t.title, t })), { placeHolder: "Show terminal" }))?.t;
  pick?.show(false);
}

/** Size a shared terminal to fit my panel: the one clicked in the Session view, the active one, or a pick. */
async function fitTerminal(arg?: number | { id: number }): Promise<void> {
  if (!session) throw new Error("Not in a session.");
  const terms = [...session.terminals.values()];
  const id = typeof arg === "number" ? arg : arg?.id;
  const pick =
    (id !== undefined ? session.terminals.get(id) : undefined) ??
    terms.find((t) => t.owns(vscode.window.activeTerminal)) ??
    (terms.length === 1 ? terms[0] : (await vscode.window.showQuickPick(terms.map((t) => ({ label: t.title, t })), { placeHolder: "Fit which terminal to your panel?" }))?.t);
  if (!pick) {
    if (!terms.length) void vscode.window.showInformationMessage("There are no shared terminals.");
    return;
  }
  pick.fit();
}

async function leave(): Promise<void> {
  if (!session) return;
  if (session.role === "Host") {
    const ok = await vscode.window.showWarningMessage("End the session for everyone?", { modal: true }, "End Session");
    if (!ok) return;
  }
  session.leave();
}

async function undoRedo(redo: boolean): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !session?.undo(ed.document, redo)) {
    await vscode.commands.executeCommand(redo ? "redo" : "undo");
  }
}


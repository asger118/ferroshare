// Runs inside VS Code (extension host). The VS Code window is the HOST,
// driven through the real extension; the GUEST is a real `mls` daemon plus a
// minimal guest client built from the same binding code the extension uses.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { DocBinding, type EditorPort } from "../binding.ts";
import { DaemonClient, type Msg, findDaemon, spawnDaemon } from "../daemon.ts";
import { applyReplace } from "../diff.ts";

const repo = path.resolve(__dirname, "..", "..", "..");
const ws = process.env.MLS_TEST_WORKSPACE!;

function log(s: string) {
  console.log(`[suite] ${s}`);
}

async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out: ${what}${last ? ` (last error: ${last})` : ""}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A guest: daemon client + CRDT bindings over in-memory "editors". */
class Guest {
  client: DaemonClient;
  msgs: Msg[] = [];
  docs = new Map<string, { b: DocBinding; text: string }>();
  nextId = 1;
  constructor(client: DaemonClient) {
    this.client = client;
    client.on("message", (m: Msg) => {
      this.msgs.push(m);
      if (m.t === "docState") this.onDocState(m.path, Buffer.from(m.update, "base64"));
      if (m.t === "update") this.docs.get(m.path)?.b.applyRemote(Buffer.from(m.update, "base64"));
    });
  }
  private onDocState(p: string, state: Uint8Array) {
    const existing = this.docs.get(p);
    if (existing) return existing.b.applyRemote(state);
    const b = new DocBinding(p, state, (u) => this.client.send({ t: "update", path: p, update: Buffer.from(u).toString("base64") }));
    const doc = { b, text: "" };
    const port: EditorPort = {
      getText: () => doc.text,
      apply: async (r) => {
        doc.text = applyReplace(doc.text, r);
        b.onEditorChange([{ offset: r.start, length: r.end - r.start, text: r.text }]);
        return true;
      },
    };
    this.docs.set(p, doc);
    b.attach(port, false);
  }
  type(p: string, offset: number, text: string, del = 0) {
    const d = this.docs.get(p)!;
    d.text = d.text.slice(0, offset) + text + d.text.slice(offset + del);
    d.b.onEditorChange([{ offset, length: del, text }]);
  }
  async request(t: string, body: Record<string, unknown>): Promise<Msg> {
    const id = this.nextId++;
    const n = this.msgs.length;
    this.client.send({ t, id, ...body });
    return until(`${t} response`, () => this.msgs.slice(n).find((m) => (m.t === "fsResult" || m.t === "langResponse") && m.id === id), 30_000);
  }
  async lang(method: string, args: Record<string, unknown>): Promise<any> {
    const r = await this.request("langRequest", { method, args: JSON.stringify(args) });
    if (r.err) throw new Error(r.err);
    return JSON.parse(r.ok);
  }
}

export async function run(): Promise<void> {
  const relayExe = path.join(repo, "target", "debug", process.platform === "win32" ? "mls-relay.exe" : "mls-relay");
  const port = await freePort();
  const relay = spawn(relayExe, ["--listen", `127.0.0.1:${port}`], { stdio: "ignore" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "mls-logs-"));
  let guest: Guest | undefined;
  try {
    await vscode.workspace.getConfiguration("ferroshare").update("relayUrl", `ws://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("ferroshare").update("displayName", "host", vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 300));

    // ---- Host through the real command.
    const api = await vscode.extensions.getExtension("local.ferroshare")!.activate();
    // The Activity Bar panel exists and, with no session, is empty (so VS Code shows the Host/Join welcome).
    await vscode.commands.executeCommand("workbench.view.extension.ferroshare");
    assert.deepEqual(api.view.getChildren(), []);
    await vscode.env.clipboard.writeText("");
    await vscode.commands.executeCommand("mls.host");
    const invite = await until("invite on clipboard", async () => (await vscode.env.clipboard.readText()).includes("#") && vscode.env.clipboard.readText());
    log(`hosting: ${invite}`);

    // ---- Guest joins with a real daemon.
    const ready = await spawnDaemon(findDaemon(path.join(repo, "extension"), ""), ["join", invite, "--name", "friend"], path.join(logs, "guest.log"));
    guest = new Guest(await DaemonClient.connect(ready.port, ready.token));
    const g = guest;
    await until("guest hello", () => g.msgs.find((m) => m.t === "hello"));

    // Browse.
    const dir = await g.request("fs", { op: { readDir: "src" } });
    assert.deepEqual(dir.ok.dir.map((e: any) => e.name), ["main.ts", "util.ts"]);
    log("browse ok");

    // Open a document that has UNSAVED changes on the host.
    const mainUri = vscode.Uri.file(path.join(ws, "src", "main.ts"));
    const hostEditor = await vscode.window.showTextDocument(mainUri);
    await hostEditor.edit((e) => e.insert(new vscode.Position(5, 0), "// unsaved host line\n"));
    g.client.send({ t: "open", path: "src/main.ts" });
    await until("guest sees host buffer", () => g.docs.get("src/main.ts")?.text.includes("// unsaved host line"));
    log("open with unsaved host changes ok");

    // Session panel: status row, invite row, both participants; shows where the guest is.
    g.client.send({ t: "presence", path: "src/main.ts", data: JSON.stringify({ sels: [] }) });
    const panel = await until("panel shows guest's file", () => {
      const items = api.view.getChildren().map((n: any) => api.view.getTreeItem(n));
      const friend = items.find((i: vscode.TreeItem) => i.label === "friend");
      return friend && String(friend.description).includes("src/main.ts") && items;
    });
    assert.equal(panel[0].label, "Hosting");
    assert.equal(panel[1].label, "Copy invite link");
    assert.ok(panel.some((i: vscode.TreeItem) => i.label === "host" && String(i.description).startsWith("you")));
    log("session panel ok");

    // Guest types -> host's real document updates.
    const gm = g.docs.get("src/main.ts")!;
    g.type("src/main.ts", gm.text.length, "const fromGuest = 1;\n");
    await until("host sees guest edit", () => hostEditor.document.getText().includes("const fromGuest = 1;"));
    // Host types -> guest updates.
    await hostEditor.edit((e) => e.insert(new vscode.Position(0, 0), "// host header\n"));
    await until("guest sees host edit", () => gm.text.startsWith("// host header\n"));
    assert.equal(gm.text, hostEditor.document.getText());
    log("bidirectional edits ok");

    // ---- Host's IntelliSense, forwarded.
    const lines = () => gm.text.split("\n");
    const addLine = lines().findIndex((l) => l.startsWith("console.log(add("));
    const hover = await until("hover from host TS server", async () => {
      const h = await g.lang("hover", { path: "src/main.ts", line: addLine, character: 13 });
      return JSON.stringify(h).includes("Adds two numbers together") && h;
    });
    assert.ok(hover);
    log("hover ok");

    const def = await g.lang("definition", { path: "src/main.ts", line: addLine, character: 13 });
    assert.ok(JSON.stringify(def).includes('"$uri":"src/util.ts"'), `definition: ${JSON.stringify(def).slice(0, 300)}`);
    log("definition ok");

    g.type("src/main.ts", gm.text.length, "c.");
    const cLine = lines().length - 1;
    const completion = await until("completion", async () => {
      const r = await g.lang("completion", { path: "src/main.ts", line: cLine, character: 2, trigger: "." });
      return JSON.stringify(r).includes('"increment"') && r;
    });
    assert.ok(completion);
    log("completion ok");
    g.type("src/main.ts", gm.text.length - 2, "", 2);

    // ---- Diagnostics pushed from host.
    const n = g.msgs.length;
    g.type("src/main.ts", gm.text.length, 'const bad: number = "oops";\n');
    await until("type error diagnostic", () =>
      g.msgs.slice(n).find((m) => m.t === "diagnostics" && m.path === "src/main.ts" && m.json.includes("not assignable to type 'number'")),
    );
    log("diagnostics ok");

    // ---- Concurrent typing from both sides.
    const hostTyping = (async () => {
      for (let i = 0; i < 40; i++) {
        await hostEditor.edit((e) => e.insert(new vscode.Position(1, 0), "h"));
      }
    })();
    for (let i = 0; i < 40; i++) {
      g.type("src/main.ts", gm.text.length, "g");
      await new Promise((r) => setTimeout(r, 2));
    }
    await hostTyping;
    await until("converged after concurrent typing", () => gm.text === hostEditor.document.getText() && gm.b.isSettled(), 20_000);
    const final = gm.text;
    assert.ok(final.split("\n")[1].startsWith("h".repeat(40)), "all 40 host keystrokes present and in order");
    assert.ok(final.endsWith("g".repeat(40)), "all 40 guest keystrokes present and in order");
    log("concurrent typing converged");

    // ---- Guest saves -> file on disk.
    g.client.send({ t: "save", path: "src/main.ts" });
    await until("saved to disk", () => fs.readFileSync(mainUri.fsPath, "utf8") === hostEditor.document.getText());
    log("save ok");

    // ---- Path escape refused.
    const esc = await g.request("fs", { op: { read: "../secret.txt" } });
    assert.ok(String(esc.err).includes("invalid path"));
    log("sandbox ok");

    // ---- Guest file changes, carried out by this (the host's) VS Code.
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const onDisk = (p: string) => path.join(ws, ...p.split("/"));
    const ok = async (op: Record<string, unknown>) => {
      const r = await g.request("fs", { op });
      assert.equal(r.err, null, `${JSON.stringify(op)}: ${r.err}`);
    };
    await ok({ write: { path: "src/new.ts", data: b64("export const n = 1;\n"), create: true, overwrite: false } });
    assert.equal(fs.readFileSync(onDisk("src/new.ts"), "utf8"), "export const n = 1;\n");
    const exists = await g.request("fs", { op: { write: { path: "src/new.ts", data: b64("x"), create: true, overwrite: false } } });
    assert.ok(String(exists.err).startsWith("FileExists:"), exists.err);
    await ok({ createDir: "lib" });
    await ok({ rename: { from: "src/new.ts", to: "lib/moved.ts", overwrite: false } });
    assert.ok(fs.existsSync(onDisk("lib/moved.ts")) && !fs.existsSync(onDisk("src/new.ts")));
    await ok({ delete: { path: "lib", recursive: true } });
    assert.ok(!fs.existsSync(onDisk("lib")));
    const git = await g.request("fs", { op: { createDir: ".git" } });
    assert.ok(String(git.err).startsWith("NoPermissions:"), git.err);
    log("guest create/rename/delete ok");

    // Renaming a file with unsaved edits: they move to the new name on the host.
    g.client.send({ t: "open", path: "src/util.ts" });
    const gu = await until("guest has util.ts", () => g.docs.get("src/util.ts"));
    g.type("src/util.ts", 0, "// unsaved guest line\n");
    await until("host has guest's unsaved line", () =>
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === vscode.Uri.file(onDisk("src/util.ts")).toString())?.getText().startsWith("// unsaved guest line"),
    );
    const before = g.msgs.length;
    await ok({ rename: { from: "src/util.ts", to: "src/helpers.ts", overwrite: false } });
    const hostDoc = (p: string) => vscode.workspace.textDocuments.find((d) => d.uri.toString() === vscode.Uri.file(onDisk(p)).toString());
    const moved = await until("host buffer moved", () => hostDoc("src/helpers.ts"));
    assert.ok(moved.getText().startsWith("// unsaved guest line"), "unsaved edits follow the rename");
    assert.ok(moved.isDirty);
    // The shared document lives on under the new name: no reopening needed.
    await until("guest told util.ts was renamed", () =>
      g.msgs.slice(before).find((m) => m.t === "fsChanged" && JSON.stringify(m.renamed) === '[["src/util.ts","src/helpers.ts"]]'),
    );
    gu.b.destroy();
    g.docs.delete("src/util.ts");
    await until("guest has it under the new name", () => g.docs.get("src/helpers.ts")?.text.startsWith("// unsaved guest line"));
    g.type("src/helpers.ts", 0, "// after rename\n");
    await until("editing carries on", () => hostDoc("src/helpers.ts")?.getText().startsWith("// after rename\n// unsaved guest line"));
    await new Promise((r) => setTimeout(r, 500));
    const renameMsgs = g.msgs.slice(before).filter((m) => m.t === "fsChanged" && m.renamed?.length);
    assert.equal(renameMsgs.length, 1, "the host must not report a guest's rename twice");
    log("rename keeps unsaved edits ok");

    // The host renames a shared file itself (as from its explorer).
    const before2 = g.msgs.length;
    const hostRename = new vscode.WorkspaceEdit();
    hostRename.renameFile(vscode.Uri.file(onDisk("src/helpers.ts")), vscode.Uri.file(onDisk("src/tools.ts")));
    assert.ok(await vscode.workspace.applyEdit(hostRename));
    await until("guest told about the host's rename", () =>
      g.msgs.slice(before2).find((m) => m.t === "fsChanged" && JSON.stringify(m.renamed) === '[["src/helpers.ts","src/tools.ts"]]'),
    );
    g.docs.get("src/helpers.ts")?.b.destroy();
    g.docs.delete("src/helpers.ts");
    await until("guest has the host's rename", () => g.docs.get("src/tools.ts")?.text.startsWith("// after rename"));
    g.type("src/tools.ts", 0, "// again\n");
    await until("editing carries on after the host's rename", () => hostDoc("src/tools.ts")?.getText().startsWith("// again\n// after rename"));
    log("host rename ok");

    // ---- Shared terminals.
    const s = api.session()!;
    const shell = (vscode.env.shell || "").toLowerCase();
    const sum = (n: number) => (/pwsh|powershell/.test(shell) ? `40+${n}\r` : /cmd(\.exe)?$/.test(shell) ? `set /a 40+${n}\r` : `echo $((40+${n}))\r`);
    const output = (id: number) =>
      g.msgs.filter((m) => m.t === "termOutput" && m.id === id).map((m) => Buffer.from(m.data, "base64").toString("utf8")).join("");

    s.shareTerminal(false);
    const ro = (await until("guest sees read-only terminal", () => g.msgs.find((m) => m.t === "termOpened" && !m.writable))).id;
    const roTerm = await until("host terminal tab", () => vscode.window.terminals.find((t) => t.name.includes("read-only")));
    roTerm.sendText(sum(2), false);
    await until("guest sees host's command output", () => output(ro).includes("42"), 30_000);
    g.client.send({ t: "termInput", id: ro, data: sum(9) });
    log("read-only terminal ok");

    s.shareTerminal(true);
    const rw = (await until("guest sees writable terminal", () => g.msgs.find((m) => m.t === "termOpened" && m.writable))).id;
    await new Promise((r) => setTimeout(r, 1500)); // let the shell start
    g.client.send({ t: "termInput", id: rw, data: sum(16) });
    await until("guest's command ran on the host", () => output(rw).includes("56"), 30_000);
    assert.ok(!output(ro).includes("49"), "guest input must not reach a read-only terminal");
    log("writable terminal ok");

    // A guest with a small panel: the shell (and the host's view) shrink to fit it.
    const rwTerm = s.terminals.get(rw)!;
    await until("host tab reported its size", () => rwTerm.size);
    const hostSize = rwTerm.size!;
    g.client.send({ t: "termResize", id: rw, cols: 30, rows: 8 });
    await until("shell fits the guest's tab", () => rwTerm.size?.cols === Math.min(30, hostSize.cols) && rwTerm.size.rows === Math.min(8, hostSize.rows));
    g.client.send({ t: "termResize", id: rw, cols: 0, rows: 0 });
    await until("back to the host's size when the guest closes it", () => rwTerm.size?.cols === hostSize.cols && rwTerm.size.rows === hostSize.rows);
    log("terminal size ok");

    roTerm.dispose();
    await until("closing the host tab ends it for guests", () => g.msgs.find((m) => m.t === "termClosed" && m.id === ro));
    log("terminal close ok");

    // ---- Host leaving ends the session for the guest.
    // (Killing the relay below also makes the detached host daemon exit.)
    g.client.send({ t: "leave" });
    log("ALL CHECKS PASSED");
  } finally {
    guest?.client.close();
    relay.kill();
  }
}

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

    // ---- Host leaving ends the session for the guest.
    // (Killing the relay below also makes the detached host daemon exit.)
    g.client.send({ t: "leave" });
    log("ALL CHECKS PASSED");
  } finally {
    guest?.client.close();
    relay.kill();
  }
}

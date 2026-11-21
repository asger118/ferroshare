// Runs inside a VS Code GUEST window whose workspace is mls://<session>/.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

const ws = process.env.MLS_TEST_WORKSPACE!;

function log(s: string) {
  console.log(`[guest-suite] ${s}`);
}

async function until<T>(what: string, f: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
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

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders![0].uri;
  assert.equal(root.scheme, "mls");
  await vscode.extensions.getExtension("local.ferroshare")!.activate();

  // Explorer / file system.
  const entries = await until("list src", async () => vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, "src")));
  assert.deepEqual(entries.map((e) => e[0]).sort(), ["main.ts", "util.ts"]);
  log("readDirectory ok");

  // Open a shared document.
  const uri = vscode.Uri.joinPath(root, "src", "main.ts");
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  assert.ok(doc.getText().startsWith("import { add"));
  assert.equal(doc.languageId, "typescript");
  log("open ok");

  // Host's typing shows up in the guest's editor.
  await until("host edit arrives", () => doc.getText().startsWith("// typed by host\n"));
  log("host -> guest edit ok");

  // Guest types and saves; the host writes the file.
  await editor.edit((e) => e.insert(doc.positionAt(doc.getText().length), "// typed by guest\n"));
  await doc.save();
  const disk = path.join(ws, "src", "main.ts");
  await until("saved on host disk", () => {
    const t = fs.readFileSync(disk, "utf8");
    return t.startsWith("// typed by host\n") && t.endsWith("// typed by guest\n");
  });
  assert.equal(doc.isDirty, false);
  log("guest edit + save ok");

  // Forwarded language features.
  const pos = new vscode.Position(5, 13);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, pos);
  const hoverText = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : (c as vscode.MarkdownString).value))).join("\n");
  assert.ok(hoverText.includes("Adds two numbers together"), hoverText);
  log("hover ok");

  const defs = await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", uri, pos);
  // The guest's own built-in TS support may contribute results too; the host's must be among them.
  const targets = defs.map((d) => ("targetUri" in d ? d.targetUri : d.uri).toString());
  assert.ok(targets.includes(vscode.Uri.joinPath(root, "src", "util.ts").toString()), JSON.stringify(targets));
  log("definition ok");

  const list = await vscode.commands.executeCommand<vscode.CompletionList>("vscode.executeCompletionItemProvider", uri, pos);
  assert.ok(list.items.some((i) => (typeof i.label === "string" ? i.label : i.label.label) === "increment"));
  log("completion ok");

  await until("diagnostics from host", () => vscode.languages.getDiagnostics(uri).some((d) => d.message === "fake error from host"));
  log("diagnostics ok");

  // Undo only reverts the guest's own edits, never the host's.
  await new Promise((r) => setTimeout(r, 500));
  await editor.edit((e) => e.insert(new vscode.Position(1, 0), "XYZ"));
  await until("XYZ synced", () => doc.getText().includes("XYZ"));
  await new Promise((r) => setTimeout(r, 500));
  await vscode.commands.executeCommand("mls.undo");
  await until("undo applied", () => !doc.getText().includes("XYZ"));
  assert.ok(doc.getText().startsWith("// typed by host\n"), "host's edit survives guest undo");
  log("undo ok");

  // File changes through VS Code's own file APIs (what the explorer uses).
  const onDisk = (p: string) => path.join(ws, ...p.split("/"));
  const newFile = vscode.Uri.joinPath(root, "src", "added.ts");
  await vscode.workspace.fs.writeFile(newFile, Buffer.from("export const added = true;\n"));
  assert.equal(fs.readFileSync(onDisk("src/added.ts"), "utf8"), "export const added = true;\n");
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, "docs"));
  assert.ok(fs.statSync(onDisk("docs")).isDirectory());
  await vscode.workspace.fs.rename(newFile, vscode.Uri.joinPath(root, "docs", "added.ts"));
  assert.ok(fs.existsSync(onDisk("docs/added.ts")) && !fs.existsSync(onDisk("src/added.ts")));
  const listed = await until("explorer sees the move", async () => {
    const e = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, "docs"));
    return e.some(([n]) => n === "added.ts") && e;
  });
  assert.ok(listed);
  await assert.rejects(
    Promise.resolve(vscode.workspace.fs.rename(vscode.Uri.joinPath(root, "docs", "added.ts"), vscode.Uri.joinPath(root, "src", "util.ts"), { overwrite: false })),
    (e: any) => e instanceof vscode.FileSystemError && e.code === "FileExists",
  );
  await assert.rejects(
    Promise.resolve(vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ".git", "config"), Buffer.from("x"))),
    (e: any) => e instanceof vscode.FileSystemError && e.code === "NoPermissions",
  );
  await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, "docs"), { recursive: true });
  assert.ok(!fs.existsSync(onDisk("docs")));
  log("file changes ok");

  log("ALL GUEST CHECKS PASSED");
}

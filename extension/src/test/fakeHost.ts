// A scripted host editor for the guest-side integration test: real host
// daemon, real CRDT bindings, canned language-feature answers.

import * as fs from "node:fs";
import * as path from "node:path";
import { DocBinding, type EditorPort } from "../binding.ts";
import { DaemonClient, type Msg } from "../daemon.ts";
import { applyReplace } from "../diff.ts";

const ANSWERS: Record<string, unknown> = {
  hover: [{ contents: [{ $md: "**add**: Adds two numbers together.", $icons: false }], range: { $range: [4, 12, 4, 15] } }],
  definition: [{ uri: { $uri: "src/util.ts", $raw: "" }, range: { $range: [1, 16, 1, 19] } }],
  completion: { isIncomplete: false, items: [{ label: "increment", kind: 1, detail: "(method) Counter.increment(): void" }] },
};

const FAKE_DIAGNOSTICS = [{ range: { $range: [0, 0, 0, 6] }, message: "fake error from host", severity: 0, source: "fake" }];

export class FakeHost {
  /** Like the real host's editor, but straight to disk. */
  private applyFs(op: any): void {
    const p = (rel: string) => path.join(this.root, ...rel.split("/"));
    if (op.write) fs.writeFileSync(p(op.write.path), Buffer.from(op.write.data, "base64"));
    else if (op.createDir !== undefined) fs.mkdirSync(p(op.createDir));
    else if (op.delete) fs.rmSync(p(op.delete.path), { recursive: op.delete.recursive });
    else if (op.rename) fs.renameSync(p(op.rename.from), p(op.rename.to));
  }

  docs = new Map<string, { b: DocBinding; text: string }>();
  saves: string[] = [];
  private client: DaemonClient;
  private root: string;

  constructor(client: DaemonClient, root: string) {
    this.client = client;
    this.root = root;
    client.on("message", (m: Msg) => this.onMessage(m));
    // The guest suite (another process) asks for a rename on the host by
    // writing "from\nto" to <workspace>.rename.
    const request = `${root}.rename`;
    setInterval(() => {
      if (!fs.existsSync(request)) return;
      const [from, to] = fs.readFileSync(request, "utf8").split("\n");
      fs.rmSync(request);
      this.applyFs({ rename: { from, to } });
      this.client.send({ t: "fsNotify", renamed: [[from, to]] });
    }, 100).unref();
  }

  private onMessage(m: Msg): void {
    switch (m.t) {
      case "readDoc":
        this.client.send({ t: "docText", path: m.path, text: null }); // use disk
        break;
      case "docState": {
        const doc = { b: undefined as unknown as DocBinding, text: "" };
        doc.b = new DocBinding(m.path, Buffer.from(m.update, "base64"), (u) =>
          this.client.send({ t: "update", path: m.path, update: Buffer.from(u).toString("base64") }),
        );
        const port: EditorPort = {
          getText: () => doc.text,
          apply: async (r) => {
            doc.text = applyReplace(doc.text, r);
            doc.b.onEditorChange([{ offset: r.start, length: r.end - r.start, text: r.text }]);
            return true;
          },
        };
        this.docs.set(m.path, doc);
        doc.b.attach(port, false);
        if (m.path === "src/main.ts") {
          // The host types a line shortly after the guest opens the file, and has an error to report.
          setTimeout(() => {
            doc.text = "// typed by host\n" + doc.text;
            doc.b.onEditorChange([{ offset: 0, length: 0, text: "// typed by host\n" }]);
          }, 1000);
          this.client.send({
            t: "diagnostics",
            path: m.path,
            json: JSON.stringify(FAKE_DIAGNOSTICS),
          });
        }
        break;
      }
      case "update":
        this.docs.get(m.path)?.b.applyRemote(Buffer.from(m.update, "base64"));
        break;
      case "fsChanged":
        // Renamed documents come back as a docState under the new name.
        for (const [from] of m.renamed) {
          for (const [p, d] of [...this.docs]) {
            if (p === from || p.startsWith(from + "/")) {
              d.b.destroy();
              this.docs.delete(p);
            }
          }
        }
        break;
      case "save": {
        const d = this.docs.get(m.path);
        if (d) {
          fs.writeFileSync(path.join(this.root, ...m.path.split("/")), d.b.text());
          this.saves.push(m.path);
        }
        break;
      }
      case "fsApply":
        try {
          this.applyFs(m.op);
          this.client.send({ t: "fsApplied", id: m.id, err: null });
        } catch (e: any) {
          this.client.send({ t: "fsApplied", id: m.id, err: e.code === "EEXIST" ? `FileExists: ${e.message}` : String(e.message) });
        }
        break;
      case "langRequest": {
        // Like a real host, a diagnostics pull returns the same live state that was pushed.
        const answer = m.method === "diagnostics" ? (JSON.parse(m.args).path === "src/main.ts" ? FAKE_DIAGNOSTICS : []) : ANSWERS[m.method];
        const ok = JSON.stringify(answer ?? null);
        this.client.send({ t: "langResponse", to: m.from, id: m.id, ok, err: null });
        break;
      }
    }
  }
}

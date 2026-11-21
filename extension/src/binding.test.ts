import assert from "node:assert/strict";
import { test } from "node:test";
import * as Y from "yjs";
import { DocBinding, type EditorPort } from "./binding.ts";
import { type Change, type Replace, applyChanges, applyReplace, diff, transform } from "./diff.ts";

// ------------------------------------------------------------------ diff

test("diff produces minimal replace and round-trips", () => {
  assert.deepEqual(diff("hello world", "hello brave world"), { start: 6, end: 6, text: "brave " });
  assert.equal(diff("same", "same"), null);
  const r = diff("a\r\nb", "a\r\r\nb")!;
  assert.equal(applyReplace("a\r\nb", r), "a\r\r\nb");
  assert.notEqual(r.start, 2, "must not split CRLF");
});

test("diff never splits surrogate pairs", () => {
  const a = "x😀y";
  const b = "x😃y"; // shares the high surrogate
  const r = diff(a, b)!;
  assert.equal(r.start, 1);
  assert.equal(applyReplace(a, r), b);
});

test("diff fuzz round-trip", () => {
  const rnd = mulberry32(1);
  for (let i = 0; i < 2000; i++) {
    const a = randomText(rnd, 20);
    const b = randomText(rnd, 20);
    const r = diff(a, b);
    assert.equal(r ? applyReplace(a, r) : a, b);
  }
});

test("transform shifts changes past a pending gap", () => {
  const gap: Replace = { start: 5, end: 5, text: "XYZ" }; // remote inserted 3 chars at 5
  assert.deepEqual(transform({ offset: 2, length: 1, text: "a" }, gap), { offset: 2, length: 1, text: "a" });
  assert.deepEqual(transform({ offset: 7, length: 0, text: "a" }, gap), { offset: 10, length: 0, text: "a" });
  // A deletion spanning text the remote replaced keeps the user's insert.
  const del: Replace = { start: 2, end: 6, text: "" };
  assert.deepEqual(transform({ offset: 3, length: 0, text: "q" }, del), { offset: 2, length: 0, text: "q" });
});

// --------------------------------------------------------- simulated peers

class FakeEditor implements EditorPort {
  version = 0;
  binding!: DocBinding;
  text: string;
  private rnd: () => number;
  private rejectStale: boolean;
  constructor(text: string, rnd: () => number, rejectStale: boolean) {
    this.text = text;
    this.rnd = rnd;
    this.rejectStale = rejectStale;
  }
  getText() {
    return this.text;
  }
  apply(r: Replace): Promise<boolean> {
    const v = this.version;
    return new Promise((resolve) =>
      setTimeout(() => {
        // Real VS Code rejects workspace edits made against a stale version.
        if (this.rejectStale && this.version !== v) return resolve(false);
        const start = Math.min(r.start, this.text.length);
        const end = Math.min(Math.max(r.end, start), this.text.length);
        this.text = this.text.slice(0, start) + r.text + this.text.slice(end);
        this.version++;
        this.binding.onEditorChange([{ offset: start, length: end - start, text: r.text }]);
        resolve(true);
      }, Math.floor(this.rnd() * 3)),
    );
  }
  type(c: Change) {
    this.text = applyChanges(this.text, [c]);
    this.version++;
    this.binding.onEditorChange([c]);
  }
}

class Network {
  inFlight = 0;
  peers: DocBinding[] = [];
  private rnd: () => number;
  constructor(rnd: () => number) {
    this.rnd = rnd;
  }
  broadcast(from: DocBinding, update: Uint8Array) {
    for (const p of this.peers) {
      if (p === from) continue;
      this.inFlight++;
      // Random delay => arbitrary reordering between messages.
      setTimeout(() => {
        this.inFlight--;
        p.applyRemote(update);
      }, Math.floor(this.rnd() * 6));
    }
  }
}

function makePeers(n: number, initial: string, rnd: () => number, rejectStale: boolean) {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, initial);
  const state = Y.encodeStateAsUpdate(seed);
  const net = new Network(rnd);
  const editors: FakeEditor[] = [];
  for (let i = 0; i < n; i++) {
    let b!: DocBinding;
    b = new DocBinding("f.cs", state, (u) => net.broadcast(b, u));
    const ed = new FakeEditor(i === 0 ? initial : "", rnd, rejectStale);
    ed.binding = b;
    b.attach(ed, false);
    net.peers.push(b);
    editors.push(ed);
  }
  return { net, editors };
}

async function quiesce(net: Network, editors: FakeEditor[]) {
  for (let i = 0; i < 2000; i++) {
    await sleep(5);
    if (net.inFlight === 0 && net.peers.every((p) => p.isSettled())) {
      await sleep(10);
      if (net.inFlight === 0 && net.peers.every((p) => p.isSettled())) return;
    }
  }
  assert.fail("did not quiesce: " + JSON.stringify(editors.map((e) => e.text)));
}

for (const rejectStale of [true, false]) {
  test(`concurrent random typing converges (rejectStale=${rejectStale})`, async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = mulberry32(seed);
      const { net, editors } = makePeers(3, "class Program\r\n{\r\n}\r\n", rnd, rejectStale);
      await quiesce(net, editors);
      for (let step = 0; step < 120; step++) {
        const ed = editors[Math.floor(rnd() * editors.length)];
        ed.type(randomChange(ed.text, rnd));
        if (rnd() < 0.5) await sleep(Math.floor(rnd() * 3));
      }
      await quiesce(net, editors);
      const texts = editors.map((e) => e.text);
      const ys = net.peers.map((p) => p.text());
      assert.ok(texts.every((t) => t === texts[0]), `seed ${seed}: editors diverged ${JSON.stringify(texts)}`);
      assert.ok(ys.every((t) => t === texts[0]), `seed ${seed}: editor != crdt`);
    }
  });
}

test("keystrokes typed while a remote edit is in flight are not lost", async () => {
  const rnd = mulberry32(42);
  const { net, editors } = makePeers(2, "0123456789", rnd, true);
  await quiesce(net, editors);
  const [a, b] = editors;
  a.type({ offset: 0, length: 0, text: "AAA" });
  // b types repeatedly while a's change is arriving.
  for (let i = 0; i < 20; i++) {
    b.type({ offset: b.text.length, length: 0, text: "b" });
    await sleep(1);
  }
  await quiesce(net, editors);
  assert.equal(a.text, b.text);
  assert.ok(a.text.startsWith("AAA0123456789"));
  assert.equal(a.text.match(/b/g)?.length, 20);
});

test("undo only reverts your own edits", async () => {
  const rnd = mulberry32(7);
  const { net, editors } = makePeers(2, "", rnd, true);
  const [a, b] = editors;
  a.type({ offset: 0, length: 0, text: "hello" });
  await quiesce(net, editors);
  b.type({ offset: 5, length: 0, text: " world" });
  await quiesce(net, editors);
  net.peers[0].undo.undo();
  await quiesce(net, editors);
  assert.equal(a.text, " world");
  assert.equal(b.text, " world");
});

test("host buffer wins on first share (unsaved changes kept)", () => {
  const seed = new Y.Doc();
  seed.getText("content").insert(0, "disk");
  const sent: Uint8Array[] = [];
  const b = new DocBinding("x", Y.encodeStateAsUpdate(seed), (u) => sent.push(u));
  const ed = new FakeEditor("disk + typed", mulberry32(1), true);
  ed.binding = b;
  b.attach(ed, true);
  assert.equal(b.text(), "disk + typed");
  assert.equal(sent.length, 1, "the difference is broadcast to guests");
});

// ----------------------------------------------------------------- helpers

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ["a", "b", "c", " ", "{", "}", "\r\n", "😀", "é"];

function randomText(rnd: () => number, max: number) {
  let s = "";
  const n = Math.floor(rnd() * max);
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
  return s;
}

/** Random edit that, like a real editor, never splits a surrogate pair or CRLF. */
function randomChange(text: string, rnd: () => number): Change {
  const safe = (i: number) => {
    while (i > 0 && i < text.length) {
      const prev = text.charCodeAt(i - 1);
      if ((prev >= 0xd800 && prev <= 0xdbff) || (text[i - 1] === "\r" && text[i] === "\n")) i--;
      else break;
    }
    return i;
  };
  const offset = safe(Math.floor(rnd() * (text.length + 1)));
  const end = rnd() < 0.4 ? safe(Math.min(text.length, offset + Math.floor(rnd() * 4))) : offset;
  return { offset, length: Math.max(0, end - offset), text: rnd() < 0.8 ? randomText(rnd, 3) : "" };
}

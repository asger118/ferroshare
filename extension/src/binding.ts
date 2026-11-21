// Binds one editor buffer to one Yjs document.
//
// The invariant we converge to is `editor text === ytext`. Local keystrokes
// go into Yjs synchronously. Remote changes go into Yjs immediately and are
// pushed to the editor by diffing the two texts ("flush"), so a lost, failed
// or reordered editor edit can never leave the two diverged: the next flush
// simply repairs it. If the user types while a flush is in flight, their
// change is transformed past the pending gap so no keystroke is lost.
//
// No vscode import: the editor is abstracted as an `EditorPort` so this can be
// tested against a simulated editor with the exact async races VS Code has.

import * as Y from "yjs";
import { type Change, type Replace, diff, transform } from "./diff.ts";

export const LOCAL = Symbol("local");

export interface EditorPort {
  getText(): string;
  /** Apply a replacement asynchronously. Resolves false if it was rejected (e.g. the document changed meanwhile). */
  apply(r: Replace): Promise<boolean>;
}

export class DocBinding {
  readonly ydoc = new Y.Doc();
  readonly ytext = this.ydoc.getText("content");
  readonly undo: Y.UndoManager;
  private editor: EditorPort | undefined;
  /** Editor text as of the last change event we processed. */
  private mirror = "";
  /** Known `mirror === ytext` (avoids O(n) compares per keystroke). */
  private inSync = false;
  private inflight: Replace | null = null;
  private flushQueued = false;
  private failures = 0;
  private stuck = 0;
  private yVersion = 0;
  private settleWaiters: Array<() => void> = [];

  readonly path: string;
  private readonly send: (update: Uint8Array) => void;
  private readonly log: (msg: string) => void;

  constructor(path: string, state: Uint8Array, send: (update: Uint8Array) => void, log: (msg: string) => void = () => {}) {
    this.path = path;
    this.send = send;
    this.log = log;
    Y.applyUpdate(this.ydoc, state, "remote");
    this.undo = new Y.UndoManager(this.ytext, { trackedOrigins: new Set([LOCAL]), captureTimeout: 400 });
    this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      this.yVersion++;
      // Local typing, local undo/redo -> broadcast. Remote updates came from the network.
      if (origin === LOCAL || origin === this.undo) this.send(update);
      if (origin === this.undo) {
        this.inSync = false;
        this.queueFlush();
      }
    });
  }

  get attached(): boolean {
    return this.editor !== undefined;
  }

  text(): string {
    return this.ytext.toString();
  }

  /**
   * Connect an editor buffer. `editorWins`: the buffer is authoritative (host
   * just handed us this text, and may have typed since) — otherwise the
   * buffer is brought in line with the shared document.
   */
  attach(editor: EditorPort, editorWins: boolean): void {
    this.editor = editor;
    this.inflight = null;
    this.mirror = editor.getText();
    const y = this.text();
    if (editorWins && y !== this.mirror) {
      const d = diff(y, this.mirror)!;
      this.ydoc.transact(() => this.replaceY(d), LOCAL);
    }
    this.inSync = this.text() === this.mirror;
    this.queueFlush();
  }

  detach(): void {
    this.editor = undefined;
    this.inflight = null;
    this.inSync = false;
    this.resolveSettled();
  }

  applyRemote(update: Uint8Array): void {
    Y.applyUpdate(this.ydoc, update, "remote");
    this.inSync = false;
    this.queueFlush();
  }

  /** Call with the editor's change event (offsets relative to the pre-event text). */
  onEditorChange(changes: readonly Change[]): void {
    const editor = this.editor;
    if (!editor || changes.length === 0) return;
    const after = editor.getText();
    const f = this.inflight;
    if (f && changes.length === 1 && changes[0].offset === f.start && changes[0].length === f.end - f.start && changes[0].text === f.text) {
      // Our own flush landing.
      this.mirror = after;
      return;
    }
    // A user edit (or formatter, or reload from disk on the host).
    const gap = this.inSync ? null : diff(this.mirror, this.text());
    const mapped = (gap ? changes.map((c) => transform(c, gap)) : [...changes]).sort((a, b) => b.offset - a.offset);
    this.ydoc.transact(() => {
      for (const c of mapped) {
        const len = this.ytext.length;
        const start = Math.min(c.offset, len);
        const del = Math.min(c.length, len - start);
        if (del > 0) this.ytext.delete(start, del);
        if (c.text) this.ytext.insert(start, c.text);
      }
    }, LOCAL);
    this.mirror = after;
    if (gap) {
      this.inSync = false;
      this.queueFlush();
    }
  }

  /** Resolves once the editor matches the shared document (or after a timeout). */
  settle(timeoutMs = 1500): Promise<void> {
    if (!this.editor || (this.inSync && !this.inflight)) return Promise.resolve();
    return new Promise((resolve) => {
      this.settleWaiters.push(resolve);
      setTimeout(resolve, timeoutMs);
    });
  }

  isSettled(): boolean {
    return !this.editor || (this.inSync && !this.inflight);
  }

  /** Relative positions survive concurrent edits (used for remote cursors). */
  relativePosition(index: number): unknown {
    return Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.ytext, index));
  }

  absolutePosition(json: unknown): number | null {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(json), this.ydoc);
      return abs ? abs.index : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.detach();
    this.undo.destroy();
    this.ydoc.destroy();
  }

  // ---------------------------------------------------------------------

  private replaceY(r: Replace): void {
    if (r.end > r.start) this.ytext.delete(r.start, r.end - r.start);
    if (r.text) this.ytext.insert(r.start, r.text);
  }

  private resolveSettled(): void {
    const w = this.settleWaiters;
    this.settleWaiters = [];
    for (const r of w) r();
  }

  private queueFlush(delayMs = 0): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    const run = () => {
      this.flushQueued = false;
      void this.flush();
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else queueMicrotask(run);
  }

  private async flush(): Promise<void> {
    const editor = this.editor;
    if (!editor || this.inflight) return;
    const target = this.text();
    const current = editor.getText();
    this.mirror = current;
    const d = diff(current, target);
    if (!d) {
      this.inSync = true;
      this.failures = 0;
      this.stuck = 0;
      this.resolveSettled();
      return;
    }
    this.inSync = false;
    this.inflight = d;
    const yBefore = this.yVersion;
    let ok = false;
    try {
      ok = await editor.apply(d);
    } catch (e) {
      this.log(`apply failed for ${this.path}: ${e}`);
    }
    this.inflight = null;
    if (editor !== this.editor) return;

    if (!ok) {
      // Usually "document changed meanwhile" because the user typed. Retry soon.
      this.failures++;
      this.queueFlush(Math.min(2 * this.failures, 50));
      return;
    }
    this.failures = 0;
    // The editor accepted the edit but still differs although nothing new
    // arrived (e.g. it normalised line endings): adopt the editor's version
    // instead of looping forever.
    const after = editor.getText();
    if (after !== this.text() && this.yVersion === yBefore) {
      if (++this.stuck >= 2) {
        this.log(`${this.path}: editor normalised text; adopting editor version`);
        const fix = diff(this.text(), after)!;
        this.ydoc.transact(() => this.replaceY(fix), LOCAL);
        this.stuck = 0;
      }
    } else {
      this.stuck = 0;
    }
    this.queueFlush();
  }
}

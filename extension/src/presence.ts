// Other participants' cursors and selections, anchored with CRDT-relative
// positions so they stay on the right character while anyone types.

import * as vscode from "vscode";
import type { DocBinding } from "./binding.ts";

const COLORS = ["#e06c75", "#61afef", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#be5046"];

interface PeerState {
  name: string;
  path: string;
  sels: Array<{ a: unknown; h: unknown }>;
  cursor: vscode.TextEditorDecorationType;
  selection: vscode.TextEditorDecorationType;
}

export interface PresenceHost {
  bindingFor(doc: vscode.TextDocument): DocBinding | undefined;
  bindingByPath(path: string): DocBinding | undefined;
  uriFor(path: string): vscode.Uri;
  send(path: string, data: string): void;
  peerName(id: number): string;
}

export class Presence implements vscode.Disposable {
  private peers = new Map<number, PeerState>();
  private disposables: vscode.Disposable[] = [];
  private pending: ReturnType<typeof setTimeout> | undefined;
  private lastSent = "";
  private host: PresenceHost;

  constructor(host: PresenceHost) {
    this.host = host;
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.scheduleSend()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleSend()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.host.bindingFor(e.document)) this.renderAll();
      }),
    );
  }

  private scheduleSend(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.sendNow();
    }, 40);
  }

  sendNow(): void {
    const ed = vscode.window.activeTextEditor;
    const b = ed && this.host.bindingFor(ed.document);
    let path = "";
    let data = "{}";
    if (ed && b) {
      path = b.path;
      const doc = ed.document;
      data = JSON.stringify({
        sels: ed.selections.map((s) => ({ a: b.relativePosition(doc.offsetAt(s.anchor)), h: b.relativePosition(doc.offsetAt(s.active)) })),
      });
    }
    const key = path + data;
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.host.send(path, data);
  }

  /** Returns true if the participant is new or moved to another file. */
  onRemote(from: number, path: string, data: string): boolean {
    let p = this.peers.get(from);
    const moved = !p || p.path !== path;
    if (!p) {
      const color = COLORS[from % COLORS.length];
      p = {
        name: this.host.peerName(from),
        path: "",
        sels: [],
        cursor: vscode.window.createTextEditorDecorationType({
          border: `solid ${color}`,
          borderWidth: "0 0 0 2px",
          after: { contentText: "", color, margin: "0 0 0 2px" },
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
        selection: vscode.window.createTextEditorDecorationType({ backgroundColor: color + "40", borderRadius: "2px" }),
      };
      this.peers.set(from, p);
    }
    p.path = path;
    try {
      p.sels = path ? JSON.parse(data).sels ?? [] : [];
    } catch {
      p.sels = [];
    }
    this.renderAll();
    return moved;
  }

  removePeer(id: number): void {
    const p = this.peers.get(id);
    if (!p) return;
    p.cursor.dispose();
    p.selection.dispose();
    this.peers.delete(id);
  }

  /** Where a participant is, for "go to participant". */
  locate(id: number): { uri: vscode.Uri; offset: number } | undefined {
    const p = this.peers.get(id);
    const b = p?.path ? this.host.bindingByPath(p.path) : undefined;
    if (!p || !b || !p.sels.length) return undefined;
    const offset = b.absolutePosition(p.sels[0].h);
    return offset === null ? undefined : { uri: this.host.uriFor(p.path), offset };
  }

  participants(): Array<{ id: number; name: string; path: string }> {
    return [...this.peers].map(([id, p]) => ({ id, name: p.name, path: p.path }));
  }

  private renderAll(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      const b = this.host.bindingFor(ed.document);
      for (const p of this.peers.values()) {
        const cursors: vscode.DecorationOptions[] = [];
        const selections: vscode.Range[] = [];
        if (b && p.path === b.path) {
          for (const s of p.sels) {
            const a = b.absolutePosition(s.a);
            const h = b.absolutePosition(s.h);
            if (a === null || h === null) continue;
            const doc = ed.document;
            const hp = doc.positionAt(Math.min(h, doc.getText().length));
            cursors.push({
              range: new vscode.Range(hp, hp),
              hoverMessage: p.name,
              renderOptions: { after: { contentText: cursors.length === 0 ? ` ${p.name}` : "" } },
            });
            if (a !== h) selections.push(new vscode.Range(doc.positionAt(Math.min(a, h)), doc.positionAt(Math.max(a, h))));
          }
        }
        ed.setDecorations(p.cursor, cursors);
        ed.setDecorations(p.selection, selections);
      }
    }
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    for (const d of this.disposables) d.dispose();
  }
}

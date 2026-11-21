// The "Ferroshare" panel in the Activity Bar. With no session it is empty,
// so VS Code shows the welcome content (Host / Join buttons) from
// package.json. In a session it shows the connection, the participants and
// the shared terminals.

import * as vscode from "vscode";
import type { Session } from "./session.ts";

type Node = { kind: "status" } | { kind: "invite" } | { kind: "peer"; id: number } | { kind: "terminal"; id: number } | { kind: "shareTerminal" };

export class SessionView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly current: () => Session | undefined;

  constructor(current: () => Session | undefined) {
    this.current = current;
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(node?: Node): Node[] {
    const s = this.current();
    if (node || !s) return [];
    const rank = (id: number) => (id === s.me ? 0 : s.peers.get(id)?.role === "Host" ? 1 : 2);
    const peers = [...s.peers.values()]
      .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
      .map((p): Node => ({ kind: "peer", id: p.id }));
    const terminals = [...s.terminals.keys()].map((id): Node => ({ kind: "terminal", id }));
    return [
      { kind: "status" },
      ...(s.role === "Host" ? [{ kind: "invite" } as Node] : []),
      ...peers,
      ...terminals,
      ...(s.role === "Host" ? [{ kind: "shareTerminal" } as Node] : []),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const s = this.current()!;
    switch (node.kind) {
      case "status": {
        const relay = relayHost(s.invite);
        const item = new vscode.TreeItem(
          !s.connected ? "Reconnecting…" : s.role === "Host" ? "Hosting" : `In ${s.hostName}'s session`,
        );
        item.description = relay;
        item.iconPath = new vscode.ThemeIcon(s.connected ? "broadcast" : "sync~spin");
        item.tooltip = s.connected
          ? `Connected to ${relay}. End-to-end encrypted.`
          : "Lost connection to the relay. Your edits are kept and will sync when it's back.";
        return item;
      }
      case "invite": {
        const item = new vscode.TreeItem("Copy invite link");
        item.iconPath = new vscode.ThemeIcon("copy");
        item.tooltip = "Copy the invite link to send to friends. Treat it like a password.";
        item.command = { command: "mls.copyInvite", title: "Copy invite link" };
        return item;
      }
      case "peer": {
        const p = s.peers.get(node.id);
        const me = node.id === s.me;
        const where = me ? "" : s.participants().find((x) => x.id === node.id)?.path;
        const item = new vscode.TreeItem(p?.name ?? `peer ${node.id}`);
        item.description = [me ? "you" : "", p?.role === "Host" ? "host" : "", where ?? ""].filter(Boolean).join(" · ");
        item.iconPath = new vscode.ThemeIcon(p?.role === "Host" ? "star-full" : "account");
        if (!me) {
          item.tooltip = where ? `${p?.name} is in ${where}. Click to jump to their cursor.` : `${p?.name} isn't in a shared file right now.`;
          item.command = { command: "mls.goToParticipant", title: "Go to participant", arguments: [node.id] };
        }
        return item;
      }
      case "terminal": {
        const t = s.terminals.get(node.id);
        const item = new vscode.TreeItem(t?.name ?? "terminal");
        item.description = t?.writable ? "shared terminal" : "shared terminal · read-only";
        item.iconPath = new vscode.ThemeIcon(t?.writable ? "terminal" : "eye");
        item.tooltip = s.role === "Host" ? "Click to show. Closing the tab stops it for everyone." : "Click to show.";
        item.command = { command: "mls.showTerminal", title: "Show terminal", arguments: [node.id] };
        return item;
      }
      case "shareTerminal": {
        const item = new vscode.TreeItem("Share terminal…");
        item.iconPath = new vscode.ThemeIcon("add");
        item.tooltip = "Start a shell on this computer that guests can watch, or type in.";
        item.command = { command: "mls.shareTerminal", title: "Share terminal" };
        return item;
      }
    }
  }
}

function relayHost(invite: string): string {
  try {
    return new URL(invite.split("#")[0]).host;
  } catch {
    return "";
  }
}

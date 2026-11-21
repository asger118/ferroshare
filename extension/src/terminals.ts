// A shared terminal as a VS Code terminal tab. The shell runs on the host
// (in the daemon's pty); this only renders its output and forwards keys.
//
// Everyone's terminal widget answers the shell's cursor-position queries
// (ESC[6n). Only the host's answer may reach the shell, so guests drop theirs.

import * as vscode from "vscode";

/** Kept for re-showing a closed tab; matches the daemon's scrollback. */
const HISTORY = 256 * 1024;
/** Cursor position report: ESC [ row ; col R */
const CURSOR_REPORT = /\x1b\[\d+;\d+R/g;

export interface TerminalPort {
  input(id: number, data: string): void;
  /** My tab's size (0×0: I closed it). The shell follows the smallest tab. */
  resize(id: number, cols: number, rows: number): void;
  /** Host: kill the shell. */
  close(id: number): void;
}

export class SharedTerminal implements vscode.Pseudoterminal {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly decoder = new TextDecoder("utf-8");
  private history = "";
  private pending: string[] = [];
  private opened = false;
  private terminal: vscode.Terminal | undefined;
  private warnedReadOnly = false;
  private exited = false;
  /** The shell's size: the smallest tab anyone has open. */
  size: { cols: number; rows: number } | undefined;
  readonly id: number;
  readonly name: string;
  readonly writable: boolean;
  private readonly isHost: boolean;
  private readonly port: TerminalPort;
  private readonly hostName: string;

  constructor(id: number, name: string, writable: boolean, isHost: boolean, port: TerminalPort, hostName: string) {
    this.id = id;
    this.name = name;
    this.writable = writable;
    this.isHost = isHost;
    this.port = port;
    this.hostName = hostName;
  }

  get title(): string {
    return this.isHost ? `${this.name} (shared${this.writable ? "" : ", read-only"})` : `${this.hostName}: ${this.name}${this.writable ? "" : " (read-only)"}`;
  }

  /** Show the tab, creating it (with the history so far) if it was closed. */
  show(preserveFocus: boolean): void {
    if (!this.terminal) {
      this.opened = false;
      this.pending = this.history ? [this.history] : [];
      this.terminal = vscode.window.createTerminal({
        name: this.title,
        pty: this,
        iconPath: new vscode.ThemeIcon(this.writable ? "terminal" : "eye"),
        isTransient: true,
      });
    }
    this.terminal.show(preserveFocus);
  }

  get visible(): boolean {
    return !!this.terminal;
  }

  // ------------------------------------------------- vscode.Pseudoterminal

  open(dims: vscode.TerminalDimensions | undefined): void {
    this.opened = true;
    for (const s of this.pending) this.writeEmitter.fire(s);
    this.pending = [];
    if (dims) this.setDimensions(dims);
  }

  close(): void {
    // The user closed the tab. The host's shell dies with it; a guest can reopen it.
    this.terminal = undefined;
    this.opened = false;
    if (this.exited) return;
    if (this.isHost) this.port.close(this.id);
    else this.port.resize(this.id, 0, 0);
  }

  handleInput(data: string): void {
    if (this.exited) return;
    if (!this.isHost) {
      data = data.replace(CURSOR_REPORT, "");
      if (!data) return;
      if (!this.writable) {
        if (!this.warnedReadOnly) {
          this.warnedReadOnly = true;
          void vscode.window.showInformationMessage(`${this.hostName} shared this terminal read-only, so you can watch but not type.`);
        }
        return;
      }
    }
    this.port.input(this.id, data);
  }

  setDimensions(dims: vscode.TerminalDimensions): void {
    if (!this.exited) this.port.resize(this.id, dims.columns, dims.rows);
  }

  // ------------------------------------------------------- from the daemon

  output(bytes: Uint8Array): void {
    this.write(this.decoder.decode(bytes, { stream: true }));
  }

  /** The daemon is replaying the whole history (reconnect or reload). */
  reset(): void {
    this.history = "";
    this.write("\x1bc");
    this.history = "";
  }

  exit(message: string): void {
    this.exited = true;
    this.write(`\r\n\x1b[2m[${message}]\x1b[0m\r\n`);
  }

  private write(s: string): void {
    if (!s) return;
    this.history += s;
    if (this.history.length > HISTORY) {
      const cut = this.history.indexOf("\n", this.history.length - HISTORY);
      this.history = this.history.slice(cut < 0 ? this.history.length - HISTORY : cut + 1);
    }
    if (this.opened) this.writeEmitter.fire(s);
    else if (this.terminal) this.pending.push(s);
  }

  dispose(): void {
    this.writeEmitter.dispose();
  }
}

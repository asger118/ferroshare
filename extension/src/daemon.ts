// Starting the `mls` daemon and talking to it over its control socket.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import * as readline from "node:readline";

export interface Ready {
  port: number;
  token: string;
  session: string;
  invite: string;
}

/** e.g. "win32-x64", "linux-x64", "darwin-arm64": the bin/ subfolder for this machine. */
export const PLATFORM = `${process.platform}-${process.arch}`;

export function findDaemon(extensionPath: string, configured: string): string {
  const exe = process.platform === "win32" ? "mls.exe" : "mls";
  const candidates = [
    configured,
    path.join(extensionPath, "bin", PLATFORM, exe),
    // Development checkout: extension/ lives next to the cargo workspace.
    path.join(extensionPath, "..", "target", "release", exe),
    path.join(extensionPath, "..", "target", "debug", exe),
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    const bundled = fs.existsSync(path.join(extensionPath, "bin"))
      ? fs.readdirSync(path.join(extensionPath, "bin")).filter((d) => d.includes("-"))
      : [];
    throw new Error(
      `this build of Ferroshare has no daemon for ${PLATFORM} (it includes: ${bundled.join(", ") || "none"}). ` +
        `Build it from source with "cargo build --release -p mls" and set ferroshare.daemonPath to target/release/${exe}.`,
    );
  }
  ensureExecutable(found);
  return found;
}

/** A .vsix packaged on Windows carries no Unix permissions, so the daemon may arrive without +x. */
function ensureExecutable(file: string): void {
  if (process.platform === "win32") return;
  try {
    fs.accessSync(file, fs.constants.X_OK);
  } catch {
    fs.chmodSync(file, 0o755);
  }
}

/**
 * Launch a detached daemon (it survives window reloads) and wait for its
 * single "ready" line on stdout.
 */
export function spawnDaemon(exe: string, args: string[], logFile: string): Promise<Ready> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [...args, "--log", logFile], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    const finish = (err: Error | null, ready?: Ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      child.stdout?.destroy();
      child.unref();
      if (err) reject(err);
      else resolve(ready!);
    };
    const timer = setTimeout(() => finish(new Error("timed out starting the mls daemon")), 20_000);
    const rl = readline.createInterface({ input: child.stdout! });
    rl.once("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.error) finish(new Error(msg.error));
        else finish(null, msg as Ready);
      } catch {
        finish(new Error(`unexpected output from daemon: ${line}`));
      }
    });
    child.once("error", (e) => finish(new Error(`could not start ${exe}: ${e.message}`)));
    child.once("exit", (code) => finish(new Error(`mls daemon exited with code ${code}; see ${logFile}`)));
  });
}

export type Msg = { t: string; [k: string]: any };

/** JSON-lines client for the daemon's control socket. Emits "message" and "close". */
export class DaemonClient extends EventEmitter {
  private socket: net.Socket;
  private closed = false;

  private constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    const rl = readline.createInterface({ input: socket });
    rl.on("line", (line) => {
      let msg: Msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      this.emit("message", msg);
    });
    socket.on("close", () => {
      this.closed = true;
      this.emit("close");
    });
    socket.on("error", () => {});
  }

  static connect(port: number, token: string): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.setNoDelay(true);
      socket.once("connect", () => {
        socket.write(JSON.stringify({ t: "auth", token }) + "\n");
        resolve(new DaemonClient(socket));
      });
      socket.once("error", (e) => reject(e));
    });
  }

  send(msg: Msg): void {
    if (!this.closed) this.socket.write(JSON.stringify(msg) + "\n");
  }

  close(): void {
    this.socket.end();
  }
}

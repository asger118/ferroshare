// `mls://<session>/<path>` — the host's workspace as seen by a guest.
//
// Text files are served from the live CRDT document; binary files are
// fetched raw. Saving asks the host to save (so the host's format-on-save
// etc. apply). File stats are kept stable per file: VS Code compares mtimes
// to detect "file changed on disk" conflicts, and the real mtime changes
// whenever the *host* saves — which would otherwise trigger bogus conflicts.
//
// Creating, deleting and renaming go to the host, which checks them against
// its sandbox and carries them out through its own editor.

import * as vscode from "vscode";

export interface FsChange {
  created: string[];
  changed: string[];
  removed: string[];
}

export interface GuestFsBackend {
  fs(op: Record<string, unknown>): Promise<any>;
  /** Text of the live document, or null if the file is binary. */
  openText(path: string): Promise<string | null>;
  save(path: string): Promise<void>;
  isShared(path: string): boolean;
  uriFor(path: string): vscode.Uri;
  /** Files changed on the host (by anyone). */
  readonly onDidChangeFiles: vscode.Event<FsChange>;
}

/** The host prefixes errors VS Code must tell apart with a code. */
function toFsError(e: unknown, uri: vscode.Uri): Error {
  const message = e instanceof Error ? e.message : String(e);
  const m = /^(\w+): (.*)$/s.exec(message);
  switch (m?.[1]) {
    case "FileNotFound":
      return vscode.FileSystemError.FileNotFound(uri);
    case "FileExists":
      return vscode.FileSystemError.FileExists(uri);
    case "FileIsADirectory":
      return vscode.FileSystemError.FileIsADirectory(uri);
    case "NoPermissions":
      return vscode.FileSystemError.NoPermissions(m![2]);
    case "Unavailable":
      return vscode.FileSystemError.Unavailable(m![2]);
    default:
      return new vscode.FileSystemError(message);
  }
}

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const isUnder = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");

const DIR_TTL_MS = 3000;

export class GuestFs implements vscode.FileSystemProvider {
  private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private stats = new Map<string, vscode.FileStat>();
  private dirs = new Map<string, { at: number; entries: [string, vscode.FileType][]; key: string; uri: vscode.Uri }>();
  private backendPromise: Promise<GuestFsBackend>;
  private poll: ReturnType<typeof setInterval> | undefined;

  constructor(backend: Promise<GuestFsBackend>) {
    this.backendPromise = backend;
    backend.then((b) => b.onDidChangeFiles((c) => this.onRemoteChange(b, c))).catch(() => {});
    // Pick up files the host creates/deletes: re-list directories the
    // explorer has open and tell VS Code if they changed.
    this.poll = setInterval(() => void this.refreshDirs(), 5000);
  }

  dispose(): void {
    if (this.poll) clearInterval(this.poll);
  }

  static pathOf(uri: vscode.Uri): string {
    return decodeURIComponent(uri.path).replace(/^\/+/, "").replace(/\/+$/, "");
  }

  private async backend(): Promise<GuestFsBackend> {
    return this.backendPromise;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const path = GuestFs.pathOf(uri);
    if (path === "") return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    const cached = this.stats.get(path);
    if (cached) return cached;
    const b = await this.backend();
    let r: any;
    try {
      r = await b.fs({ stat: path });
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const stat = this.toStat(r.stat);
    this.stats.set(path, stat);
    return stat;
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const path = GuestFs.pathOf(uri);
    const cached = this.dirs.get(path);
    if (cached && Date.now() - cached.at < DIR_TTL_MS) return cached.entries;
    return (await this.list(uri, path)).entries;
  }

  private async list(uri: vscode.Uri, path: string) {
    const b = await this.backend();
    let r: any;
    try {
      r = await b.fs({ readDir: path });
    } catch (e) {
      throw vscode.FileSystemError.FileNotFound(String(e));
    }
    const entries: [string, vscode.FileType][] = [];
    for (const e of r.dir as any[]) {
      const child = path ? `${path}/${e.name}` : e.name;
      if (e.kind === "file" && !this.stats.has(child)) this.stats.set(child, this.toStat(e));
      entries.push([e.name, e.kind === "dir" ? vscode.FileType.Directory : vscode.FileType.File]);
    }
    const listing = { at: Date.now(), entries, key: JSON.stringify(entries), uri };
    this.dirs.set(path, listing);
    return listing;
  }

  private async refreshDirs(): Promise<void> {
    for (const [path, old] of [...this.dirs]) {
      try {
        const fresh = await this.list(old.uri, path);
        if (fresh.key !== old.key) {
          this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: old.uri }]);
        }
      } catch {
        this.dirs.delete(path);
      }
    }
  }

  /** Forget cached stats and listings for `p` (and everything below it) and its folder. */
  private forget(p: string): void {
    for (const k of [...this.stats.keys()]) if (isUnder(k, p)) this.stats.delete(k);
    for (const k of [...this.dirs.keys()]) if (p !== "" && isUnder(k, p)) this.dirs.delete(k);
    this.dirs.delete(parentOf(p));
  }

  private onRemoteChange(b: GuestFsBackend, c: FsChange): void {
    const events: vscode.FileChangeEvent[] = [];
    const parents = new Set<string>();
    const add = (paths: string[], type: vscode.FileChangeType) => {
      for (const p of paths) {
        this.forget(p);
        parents.add(parentOf(p));
        events.push({ type, uri: b.uriFor(p) });
      }
    };
    add(c.removed, vscode.FileChangeType.Deleted);
    add(c.created, vscode.FileChangeType.Created);
    add(c.changed, vscode.FileChangeType.Changed);
    for (const p of parents) events.push({ type: vscode.FileChangeType.Changed, uri: b.uriFor(p) });
    if (events.length) this.emitter.fire(events);
  }

  private async call(uri: vscode.Uri, op: Record<string, unknown>): Promise<any> {
    const b = await this.backend();
    try {
      return await b.fs(op);
    } catch (e) {
      throw toFsError(e, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const path = GuestFs.pathOf(uri);
    const b = await this.backend();
    const text = await b.openText(path);
    let bytes: Uint8Array;
    if (text !== null) {
      bytes = new TextEncoder().encode(text);
    } else {
      const r = await b.fs({ read: path });
      bytes = Buffer.from(r.data, "base64");
    }
    if (!this.stats.has(path)) this.stats.set(path, { type: vscode.FileType.File, ctime: 0, mtime: Date.now(), size: bytes.length });
    return bytes;
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const path = GuestFs.pathOf(uri);
    const b = await this.backend();
    const prev = this.stats.get(path);
    if (b.isShared(path)) {
      // The content is already in the shared document; the host does the actual write.
      await b.save(path);
    } else {
      // A new file, or one nobody has open (pasted, copied, binary).
      const data = Buffer.from(content).toString("base64");
      await this.call(uri, { write: { path, data, create: options.create, overwrite: options.overwrite } });
      this.dirs.delete(parentOf(path));
      if (!prev) this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
    }
    this.stats.set(path, { type: vscode.FileType.File, ctime: prev?.ctime ?? 0, mtime: Math.max(Date.now(), (prev?.mtime ?? 0) + 1), size: content.length });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const path = GuestFs.pathOf(uri);
    await this.call(uri, { createDir: path });
    this.forget(path);
    this.emitter.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const path = GuestFs.pathOf(uri);
    await this.call(uri, { delete: { path, recursive: options.recursive } });
    this.forget(path);
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const from = GuestFs.pathOf(oldUri);
    const to = GuestFs.pathOf(newUri);
    await this.call(oldUri, { rename: { from, to, overwrite: options.overwrite } });
    this.forget(from);
    this.forget(to);
    this.emitter.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);
  }

  private toStat(e: any): vscode.FileStat {
    return {
      type: e.kind === "dir" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: e.mtime,
      mtime: e.mtime,
      size: e.size,
    };
  }
}

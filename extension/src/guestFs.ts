// `mls://<session>/<path>` — the host's workspace as seen by a guest.
//
// Text files are served from the live CRDT document; binary files are
// fetched raw. Saving asks the host to save (so the host's format-on-save
// etc. apply). File stats are kept stable per file: VS Code compares mtimes
// to detect "file changed on disk" conflicts, and the real mtime changes
// whenever the *host* saves — which would otherwise trigger bogus conflicts.

import * as vscode from "vscode";

export interface GuestFsBackend {
  fs(op: Record<string, string>): Promise<any>;
  /** Text of the live document, or null if the file is binary. */
  openText(path: string): Promise<string | null>;
  save(path: string): Promise<void>;
  isShared(path: string): boolean;
}

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

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const path = GuestFs.pathOf(uri);
    const b = await this.backend();
    if (!b.isShared(path)) throw vscode.FileSystemError.NoPermissions("Creating files as a guest isn't supported yet.");
    // The content is already in the shared document; the host does the actual write.
    await b.save(path);
    const prev = this.stats.get(path);
    this.stats.set(path, { type: vscode.FileType.File, ctime: prev?.ctime ?? 0, mtime: Math.max(Date.now(), (prev?.mtime ?? 0) + 1), size: content.length });
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Creating folders as a guest isn't supported yet.");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Deleting files as a guest isn't supported yet.");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Renaming files as a guest isn't supported yet.");
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

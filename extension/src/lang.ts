// IntelliSense for guests, answered by the host's own language extensions
// (C# Dev Kit, clangd, TypeScript, Docker, Makefile tools…). Guests need
// nothing installed: requests are forwarded, executed on the host through
// VS Code's built-in `vscode.execute*Provider` commands, and the results are
// serialised back.

import * as vscode from "vscode";

export interface LangArgs {
  path: string;
  line?: number;
  character?: number;
  trigger?: string;
  newName?: string;
  includeDeclaration?: boolean;
  range?: [number, number, number, number];
  tabSize?: number;
  insertSpaces?: boolean;
}

// ------------------------------------------------------------------ host

/** Only these may be run on the host on a guest's behalf. */
export async function executeOnHost(method: string, a: LangArgs, uri: vscode.Uri): Promise<unknown> {
  const pos = new vscode.Position(a.line ?? 0, a.character ?? 0);
  const run = <T>(cmd: string, ...args: unknown[]) => vscode.commands.executeCommand<T>(cmd, uri, ...args);
  switch (method) {
    case "hover":
      return run("vscode.executeHoverProvider", pos);
    case "completion":
      return run("vscode.executeCompletionItemProvider", pos, a.trigger, 25);
    case "definition":
      return run("vscode.executeDefinitionProvider", pos);
    case "typeDefinition":
      return run("vscode.executeTypeDefinitionProvider", pos);
    case "implementation":
      return run("vscode.executeImplementationProvider", pos);
    case "declaration":
      return run("vscode.executeDeclarationProvider", pos);
    case "references":
      return run("vscode.executeReferenceProvider", pos);
    case "signatureHelp":
      return run("vscode.executeSignatureHelpProvider", pos, a.trigger);
    case "highlights":
      return run("vscode.executeDocumentHighlights", pos);
    case "symbols":
      return run("vscode.executeDocumentSymbolProvider");
    case "rename":
      return run("vscode.executeDocumentRenameProvider", pos, a.newName ?? "");
    case "format":
      return run("vscode.executeFormatDocumentProvider", { tabSize: a.tabSize ?? 4, insertSpaces: a.insertSpaces ?? true });
    case "semanticLegend":
      return run("vscode.provideDocumentSemanticTokensLegend");
    case "semanticTokens":
      return run("vscode.provideDocumentSemanticTokens");
    case "inlayHints": {
      const r = a.range ?? [0, 0, 0, 0];
      return run("vscode.executeInlayHintProvider", new vscode.Range(r[0], r[1], r[2], r[3]));
    }
    case "diagnostics":
      return vscode.languages.getDiagnostics(uri);
    default:
      throw new Error(`method not allowed: ${method}`);
  }
}

/** Serialise VS Code API objects to JSON, mapping workspace URIs to shared paths. */
export function serialize(v: unknown, toPath: (u: vscode.Uri) => string | null, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "function") return undefined;
  if (typeof v !== "object") return v;
  if (depth > 40) return undefined;
  const ser = (x: unknown) => serialize(x, toPath, depth + 1);
  if (v instanceof vscode.Uri) return { $uri: toPath(v), $raw: v.toString() };
  if (v instanceof vscode.Range) return { $range: [v.start.line, v.start.character, v.end.line, v.end.character] };
  if (v instanceof vscode.Position) return { $pos: [v.line, v.character] };
  if (v instanceof vscode.MarkdownString) return { $md: v.value, $icons: v.supportThemeIcons ?? false };
  if (v instanceof vscode.SnippetString) return { $snip: v.value };
  if (v instanceof vscode.TextEdit) return { $edit: [ser(v.range), v.newText] };
  if (v instanceof vscode.WorkspaceEdit) {
    return { $wsedit: v.entries().map(([u, edits]) => [ser(u), edits.map((e) => [ser(e.range), e.newText])]) };
  }
  if (v instanceof Uint32Array) return { $u32: Array.from(v) };
  if (Array.isArray(v)) return v.map(ser);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(v)) {
    // Commands refer to the host's extensions and can't run on the guest.
    if (key === "command") continue;
    // Some API classes keep state in `_field` behind a public getter.
    const name = key.startsWith("_") ? key.slice(1) : key;
    const val = (v as Record<string, unknown>)[name] ?? (v as Record<string, unknown>)[key];
    const s = ser(val);
    if (s !== undefined) out[name] = s;
  }
  return out;
}

// ----------------------------------------------------------------- guest

type Req = (method: string, args: LangArgs) => Promise<unknown>;

/** Turn serialised JSON back into VS Code objects (`toUri` maps shared paths to mls: URIs). */
export function revive(v: unknown, toUri: (path: string) => vscode.Uri): any {
  if (v === null || v === undefined || typeof v !== "object") return v;
  const rev = (x: unknown) => revive(x, toUri);
  if (Array.isArray(v)) return v.map(rev);
  const o = v as Record<string, any>;
  if ("$uri" in o) return o.$uri !== null ? toUri(o.$uri) : vscode.Uri.parse(o.$raw);
  if ("$range" in o) return new vscode.Range(o.$range[0], o.$range[1], o.$range[2], o.$range[3]);
  if ("$pos" in o) return new vscode.Position(o.$pos[0], o.$pos[1]);
  if ("$md" in o) return new vscode.MarkdownString(o.$md, o.$icons);
  if ("$snip" in o) return new vscode.SnippetString(o.$snip);
  if ("$edit" in o) return new vscode.TextEdit(rev(o.$edit[0]), o.$edit[1]);
  if ("$u32" in o) return Uint32Array.from(o.$u32);
  if ("$wsedit" in o) {
    const we = new vscode.WorkspaceEdit();
    for (const [u, edits] of o.$wsedit) {
      const uri = rev(u) as vscode.Uri;
      if (uri.scheme !== "mls") continue; // can't edit files outside the share
      for (const [r, text] of edits) we.replace(uri, rev(r), text);
    }
    return we;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = rev(o[k]);
  return out;
}

const shared = (u: vscode.Uri | undefined) => u?.scheme === "mls";

/** Results as LocationLinks (VS Code rejects mixed Location/LocationLink arrays). Drops locations outside the share. */
function toLinks(r: any): vscode.LocationLink[] {
  if (!r) return [];
  const out: vscode.LocationLink[] = [];
  for (const l of Array.isArray(r) ? r : [r]) {
    if (l.targetUri) {
      if (shared(l.targetUri)) out.push(l as vscode.LocationLink);
    } else if (l.uri && shared(l.uri)) {
      out.push({ targetUri: l.uri, targetRange: l.range, targetSelectionRange: l.range });
    }
  }
  return out;
}

function toLocations(r: any): vscode.Location[] {
  return toLinks(r).map((l) => new vscode.Location(l.targetUri, l.targetSelectionRange ?? l.targetRange));
}

function toDocumentSymbol(s: any): vscode.DocumentSymbol {
  const d = new vscode.DocumentSymbol(s.name, s.detail ?? "", s.kind, s.range, s.selectionRange);
  d.tags = s.tags;
  d.children = (s.children ?? []).map(toDocumentSymbol);
  return d;
}

function toCompletionItem(i: any): vscode.CompletionItem {
  const item = new vscode.CompletionItem(i.label, i.kind);
  Object.assign(item, i);
  if (i.textEdit) {
    // Converted to range + insertText, which the API accepts everywhere.
    item.range = i.textEdit.range;
    item.insertText = i.textEdit.newText;
    delete (item as any).textEdit;
  }
  return item;
}

export function registerGuestProviders(req: Req, pathOf: (u: vscode.Uri) => string): vscode.Disposable[] {
  const sel: vscode.DocumentSelector = { scheme: "mls" };
  const at = (doc: vscode.TextDocument, p: vscode.Position, extra: Partial<LangArgs> = {}): LangArgs => ({
    path: pathOf(doc.uri),
    line: p.line,
    character: p.character,
    ...extra,
  });
  const quiet = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch {
      return fallback;
    }
  };
  const L = vscode.languages;
  return [
    L.registerHoverProvider(sel, {
      provideHover: (d, p) =>
        quiet(async () => {
          const hovers = ((await req("hover", at(d, p))) as any[]) ?? [];
          if (!hovers.length) return undefined;
          return new vscode.Hover(hovers.flatMap((h) => h.contents), hovers[0].range);
        }, undefined),
    }),
    L.registerCompletionItemProvider(
      sel,
      {
        provideCompletionItems: (d, p, _t, ctx) =>
          quiet(async () => {
            const r: any = await req("completion", at(d, p, { trigger: ctx.triggerCharacter }));
            if (!r) return undefined;
            const items = Array.isArray(r) ? r : r.items ?? [];
            return new vscode.CompletionList(items.map(toCompletionItem), !!r.isIncomplete);
          }, undefined),
      },
      ".", ":", ">", "<", '"', "'", "/", "@", "#", "(", "[",
    ),
    L.registerSignatureHelpProvider(
      sel,
      {
        provideSignatureHelp: (d, p, _t, ctx) =>
          quiet(async () => {
            const r: any = await req("signatureHelp", at(d, p, { trigger: ctx.triggerCharacter }));
            if (!r) return undefined;
            const h = new vscode.SignatureHelp();
            h.activeSignature = r.activeSignature ?? 0;
            h.activeParameter = r.activeParameter ?? 0;
            h.signatures = (r.signatures ?? []).map((s: any) => {
              const si = new vscode.SignatureInformation(s.label, s.documentation);
              si.parameters = (s.parameters ?? []).map((p: any) => new vscode.ParameterInformation(p.label, p.documentation));
              si.activeParameter = s.activeParameter;
              return si;
            });
            return h;
          }, undefined),
      },
      { triggerCharacters: ["(", ",", "<"], retriggerCharacters: [")"] },
    ),
    L.registerDefinitionProvider(sel, { provideDefinition: (d, p) => quiet(async () => toLinks(await req("definition", at(d, p))), []) }),
    L.registerTypeDefinitionProvider(sel, { provideTypeDefinition: (d, p) => quiet(async () => toLinks(await req("typeDefinition", at(d, p))), []) }),
    L.registerImplementationProvider(sel, { provideImplementation: (d, p) => quiet(async () => toLinks(await req("implementation", at(d, p))), []) }),
    L.registerDeclarationProvider(sel, { provideDeclaration: (d, p) => quiet(async () => toLinks(await req("declaration", at(d, p))), []) }),
    L.registerReferenceProvider(sel, {
      provideReferences: (d, p) => quiet(async () => toLocations(await req("references", at(d, p))), []),
    }),
    L.registerDocumentHighlightProvider(sel, {
      provideDocumentHighlights: (d, p) =>
        quiet(async () => (((await req("highlights", at(d, p))) as any[]) ?? []).map((h) => new vscode.DocumentHighlight(h.range, h.kind)), []),
    }),
    L.registerDocumentSymbolProvider(sel, {
      provideDocumentSymbols: (d) =>
        quiet(async () => {
          const r = ((await req("symbols", { path: pathOf(d.uri) })) as any[]) ?? [];
          return r.map((s) =>
            s.location ? new vscode.SymbolInformation(s.name, s.kind, s.containerName ?? "", new vscode.Location(d.uri, s.location.range)) : toDocumentSymbol(s),
          ) as vscode.DocumentSymbol[];
        }, []),
    }),
    L.registerRenameProvider(sel, {
      provideRenameEdits: async (d, p, newName) => {
        const r = await req("rename", at(d, p, { newName }));
        if (!r) throw new Error("Nothing to rename here");
        return r as vscode.WorkspaceEdit;
      },
    }),
    L.registerDocumentFormattingEditProvider(sel, {
      provideDocumentFormattingEdits: (d, opts) =>
        quiet(async () => ((await req("format", { path: pathOf(d.uri), tabSize: opts.tabSize, insertSpaces: opts.insertSpaces })) as vscode.TextEdit[]) ?? [], []),
    }),
    L.registerInlayHintsProvider(sel, {
      provideInlayHints: (d, range) =>
        quiet(async () => {
          const r = ((await req("inlayHints", { path: pathOf(d.uri), range: [range.start.line, range.start.character, range.end.line, range.end.character] })) as any[]) ?? [];
          return r.map((h) => {
            const label = typeof h.label === "string" ? h.label : h.label.map((part: any) => ({ value: part.value, tooltip: part.tooltip }));
            const hint = new vscode.InlayHint(h.position, label, h.kind);
            hint.tooltip = h.tooltip;
            hint.paddingLeft = h.paddingLeft;
            hint.paddingRight = h.paddingRight;
            return hint;
          });
        }, []),
    }),
  ];
}

/** Semantic highlighting needs a per-language legend, fetched from the host on first use. */
export class SemanticTokensRegistry implements vscode.Disposable {
  private registered = new Map<string, vscode.Disposable | null>();
  private req: Req;
  private pathOf: (u: vscode.Uri) => string;

  constructor(req: Req, pathOf: (u: vscode.Uri) => string) {
    this.req = req;
    this.pathOf = pathOf;
  }

  async ensure(doc: vscode.TextDocument): Promise<void> {
    const lang = doc.languageId;
    if (this.registered.has(lang)) return;
    this.registered.set(lang, null);
    let legend: any;
    try {
      legend = await this.req("semanticLegend", { path: this.pathOf(doc.uri) });
    } catch {
      this.registered.delete(lang); // retry next time
      return;
    }
    if (!legend?.tokenTypes) return;
    const provider: vscode.DocumentSemanticTokensProvider = {
      provideDocumentSemanticTokens: async (d) => {
        const r: any = await this.req("semanticTokens", { path: this.pathOf(d.uri) });
        if (!r?.data) return undefined;
        return new vscode.SemanticTokens(r.data, r.resultId);
      },
    };
    this.registered.set(
      lang,
      vscode.languages.registerDocumentSemanticTokensProvider(
        { scheme: "mls", language: lang },
        provider,
        new vscode.SemanticTokensLegend(legend.tokenTypes, legend.tokenModifiers),
      ),
    );
  }

  dispose(): void {
    for (const d of this.registered.values()) d?.dispose();
    this.registered.clear();
  }
}

export function reviveDiagnostics(json: string, toUri: (p: string) => vscode.Uri): vscode.Diagnostic[] {
  const arr = revive(JSON.parse(json), toUri) as any[];
  return (arr ?? []).map((d) => {
    const diag = new vscode.Diagnostic(d.range, d.message, d.severity);
    diag.source = d.source;
    diag.code = d.code && typeof d.code === "object" ? { value: d.code.value, target: d.code.target } : d.code;
    diag.tags = d.tags;
    diag.relatedInformation = (d.relatedInformation ?? [])
      .filter((ri: any) => shared(ri.location?.uri))
      .map((ri: any) => new vscode.DiagnosticRelatedInformation(new vscode.Location(ri.location.uri, ri.location.range), ri.message));
    return diag;
  });
}

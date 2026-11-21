// Pure text helpers (no vscode import, so they're unit-testable in Node).
// All offsets are UTF-16 code units, like VS Code and Yjs.

/** Replace `[start, end)` of the old text with `text`. */
export interface Replace {
  start: number;
  end: number;
  text: string;
}

/** A change as reported by the editor: offsets refer to the text *before* the event. */
export interface Change {
  offset: number;
  length: number;
  text: string;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * Smallest single replacement turning `a` into `b` (common prefix/suffix
 * trimmed), never splitting a surrogate pair or a CRLF — VS Code can't place a
 * position in the middle of either.
 */
export function diff(a: string, b: string): Replace | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let s = 0;
  while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
  let e = 0;
  while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;

  const splitsPair = (str: string, i: number) =>
    i > 0 && i < str.length && ((isHigh(str.charCodeAt(i - 1)) && isLow(str.charCodeAt(i))) || (str[i - 1] === "\r" && str[i] === "\n"));
  while (s > 0 && (splitsPair(a, s) || splitsPair(b, s))) s--;
  while (e > 0 && (splitsPair(a, a.length - e) || splitsPair(b, b.length - e))) e--;

  return { start: s, end: a.length - e, text: b.slice(s, b.length - e) };
}

export function applyReplace(text: string, r: Replace): string {
  return text.slice(0, r.start) + r.text + text.slice(r.end);
}

export function applyChanges(text: string, changes: readonly Change[]): string {
  // Editor change offsets are all relative to the pre-event text; apply back to front.
  const sorted = [...changes].sort((x, y) => y.offset - x.offset);
  for (const c of sorted) text = text.slice(0, c.offset) + c.text + text.slice(c.offset + c.length);
  return text;
}

/**
 * Map a change made against text `A` onto text `B`, where `B = applyReplace(A, gap)`.
 * Used when the user types while a remote edit hasn't reached the editor yet:
 * the keystroke is relative to what the user saw, the CRDT already has more.
 * Positions inside the replaced region snap to its end, so typed text is never lost.
 */
export function transform(c: Change, gap: Replace): Change {
  const delta = gap.text.length - (gap.end - gap.start);
  const map = (p: number) => (p <= gap.start ? p : p >= gap.end ? p + delta : gap.start + gap.text.length);
  const start = map(c.offset);
  const end = Math.max(start, map(c.offset + c.length));
  return { offset: start, length: end - start, text: c.text };
}

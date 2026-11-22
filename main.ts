// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON text-editor tool calls), finds the lines each edit names
// with three tiers of whitespace tolerance, and applies every edit to the
// tree or none at all. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`. SPEC.md is the whole contract.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read in its format: exit 2 with `error: parse <N>`. */
class ParseFault extends Error {
  readonly lineNo: number;
  constructor(lineNo: number) {
    super(`error: parse ${lineNo}`);
    this.lineNo = lineNo;
  }
}

/** One edit that cannot be applied: exit 1 with `error: <code> <path>`. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

/** Byte order (UTF-8) for sorting output paths. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

interface FileDoc {
  lines: string[];
  eol: string;
  finalBreak: boolean;
}

/** Split a file's text into its lines, its line break and whether it ends with one. */
function splitFile(text: string): FileDoc {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) parts.pop();
  return { lines: parts, eol, finalBreak };
}

function joinFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.finalBreak ? doc.eol : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ from: string; to: string }> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

/** Detect the format of a patch (SPEC section 4), or null when none matches. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---- matching (SPEC section 5) ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occursAt(lines: string[], at: number, oldLines: string[], tier: number): boolean {
  for (let k = 0; k < oldLines.length; k++) {
    if (!lineMatches(lines[at + k]!, oldLines[k]!, tier)) return false;
  }
  return true;
}

/** Every 0-based position at or after `from` where O occurs at this tier. */
function allOccurrences(lines: string[], oldLines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    if (occursAt(lines, i, oldLines, tier)) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after `from`, or -1. */
function firstTierWith(lines: string[], oldLines: string[], strict: boolean, from = 0): number {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    if (allOccurrences(lines, oldLines, t, from).length > 0) return t;
  }
  return -1;
}

/** The first line at or after `from` equal to a single line at the first tier where one is. */
function findSingleLine(
  lines: string[],
  text: string,
  from: number,
  strict: boolean,
): { tier: number; index: number } | null {
  const top = strict ? 0 : 2;
  for (let t = 0; t <= top; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineMatches(lines[i]!, text, t)) return { tier: t, index: i };
    }
  }
  return null;
}

interface PatchLine {
  text: string;
  /** True for a context line: written as the file's own matched line. */
  context: boolean;
}

/**
 * Render the new lines of a replacement at `pos`: context lines come from the
 * file, and at tier 2 every other line is re-indented from O's first line to
 * the file's first matched line.
 */
function renderNewLines(
  fileLines: string[],
  pos: number,
  oldItems: PatchLine[],
  newItems: PatchLine[],
  tier: number,
): string[] {
  if (oldItems.length === 0) return newItems.map((it) => it.text);
  const ctxAt: number[] = [];
  oldItems.forEach((it, i) => {
    if (it.context) ctxAt.push(i);
  });
  const fileLead = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const patchLead = leadingWs(oldItems[0]!.text);
  let seenCtx = 0;
  return newItems.map((it) => {
    if (it.context) {
      const own = fileLines[pos + ctxAt[seenCtx]!]!;
      seenCtx += 1;
      return own;
    }
    if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(patchLead)) {
        return fileLead + t.slice(patchLead.length);
      }
    }
    return it.text;
  });
}

/** Replace O (at `pos`) by N in a file's lines, rendered as section 5 says. */
function spliceReplacement(
  doc: FileDoc,
  pos: number,
  oldItems: PatchLine[],
  newItems: PatchLine[],
  tier: number,
): FileDoc {
  const lines = doc.lines.slice();
  const rendered = renderNewLines(lines, pos, oldItems, newItems, tier);
  lines.splice(pos, oldItems.length, ...rendered);
  return { lines, eol: doc.eol, finalBreak: doc.finalBreak };
}

// ---- unified diffs (SPEC section 6) ----

interface Hunk {
  /** The -A start line (1-based) of the hunk header. */
  startOld: number;
  oldItems: PatchLine[];
  newItems: PatchLine[];
  /** True when a `\` line follows the hunk's last context or `+` line. */
  noNewlineAtEnd: boolean;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** The path after `--- `/`+++ `: up to the first tab, trimmed, leading `a/`/`b/` removed. */
function cleanDiffPath(raw: string): string {
  let s = raw.split('\t')[0]!.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[at]!);
  if (m === null) throw new ParseFault(at + 1);
  type Raw = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
  const raw: Raw[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      raw.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      raw.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '-') {
      raw.push({ kind: 'old', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '+') {
      raw.push({ kind: 'new', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '\\') {
      raw.push({ kind: 'bs', text: l });
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') raw.pop();
    else break;
  }
  let lastCtxNew = -1;
  raw.forEach((e, i) => {
    if (e.kind === 'ctx' || e.kind === 'new') lastCtxNew = i;
  });
  const noNewlineAtEnd = lastCtxNew >= 0 && raw[lastCtxNew + 1]?.kind === 'bs';
  const oldItems: PatchLine[] = [];
  const newItems: PatchLine[] = [];
  for (const e of raw) {
    if (e.kind === 'ctx') {
      oldItems.push({ text: e.text, context: true });
      newItems.push({ text: e.text, context: true });
    } else if (e.kind === 'old') {
      oldItems.push({ text: e.text, context: false });
    } else if (e.kind === 'new') {
      newItems.push({ text: e.text, context: false });
    }
  }
  return { hunk: { startOld: Number(m[1]), oldItems, newItems, noNewlineAtEnd }, next: j };
}

/** Apply one hunk to a file, with `d` the length drift of this section's earlier hunks. */
function applyHunk(doc: FileDoc, hunk: Hunk, drift: number, strict: boolean, path: string): FileDoc {
  const lines = doc.lines;
  const o = hunk.oldItems;
  const n = hunk.newItems;
  if (o.length === 0) {
    const pos = Math.min(hunk.startOld + drift, lines.length);
    const atEnd = pos === lines.length;
    const rendered = n.map((it) => it.text);
    const next = lines.slice();
    next.splice(pos, 0, ...rendered);
    return {
      lines: next,
      eol: doc.eol,
      finalBreak: atEnd && rendered.length > 0 ? !hunk.noNewlineAtEnd : doc.finalBreak,
    };
  }
  const oldTexts = o.map((it) => it.text);
  const tier = firstTierWith(lines, oldTexts, strict);
  if (tier < 0) throw new EditFailure('no-match', path);
  const spots = allOccurrences(lines, oldTexts, tier);
  const target = hunk.startOld - 1 + drift;
  let best = spots[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of spots) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const endReached = best + o.length === lines.length;
  const out = spliceReplacement(doc, best, o, n, tier);
  return { lines: out.lines, eol: doc.eol, finalBreak: endReached ? !hunk.noNewlineAtEnd : doc.finalBreak };
}

function applyHunks(doc: FileDoc, hunks: Hunk[], strict: boolean, path: string): FileDoc {
  let cur = doc;
  let drift = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, drift, strict, path);
    drift += h.newItems.length - h.oldItems.length;
  }
  return cur;
}

/** Whether a `\` line follows the last `+` line of all the section's hunks. */
function creationNoNewline(hunks: Hunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const entries = hunks[h]!;
    if (entries.newItems.some((it) => !it.context)) return entries.noNewlineAtEnd;
  }
  return false;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (l.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(l);
      if (m === null) throw new ParseFault(i + 1);
      diffOld = m[1]!;
      diffNew = m[2]!;
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      // Section starting at the `--- `/`+++ ` pair; the header loop below consumes it.
    } else {
      i += 1;
      continue;
    }

    let pairOld: string | null = null;
    let pairNew: string | null = null;
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let newFileMode = false;
    let deletedFileMode = false;
    const hunks: Hunk[] = [];
    let newSectionAhead = false;

    // Header: everything before the first hunk.
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) {
        if (HUNK_HEAD.exec(h) === null) throw new ParseFault(i + 1);
        break;
      }
      if (h.startsWith('diff --git ')) {
        newSectionAhead = true;
        break;
      }
      if (h.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (pairOld !== null) {
            newSectionAhead = true;
            break;
          }
          pairOld = cleanDiffPath(h.slice(4));
          pairNew = cleanDiffPath(lines[i + 1]!.slice(4));
          i += 2;
          continue;
        }
        throw new ParseFault(i + 2);
      }
      if (h.startsWith('rename from ')) {
        renameFrom = h.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('rename to ')) {
        renameTo = h.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (h.startsWith('new file mode')) {
        newFileMode = true;
        i += 1;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        deletedFileMode = true;
        i += 1;
        continue;
      }
      i += 1;
    }

    // Hunks, with prose between them ignored.
    if (!newSectionAhead) {
      while (i < n) {
        const h = lines[i]!;
        if (h.startsWith('@@')) {
          const parsed = parseHunk(lines, i);
          hunks.push(parsed.hunk);
          i = parsed.next;
          continue;
        }
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        i += 1;
      }
    }

    const devNull = (p: string | null): string | null => (p === '/dev/null' ? null : p);
    const oldPath = pairOld !== null ? devNull(pairOld) : renameFrom !== null ? renameFrom : diffOld;
    const newPath = pairNew !== null ? devNull(pairNew) : renameTo !== null ? renameTo : diffNew;
    const isCreate = oldPath === null || newFileMode;
    const isDelete = !isCreate && (newPath === null || deletedFileMode);
    const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;

    if (isCreate) {
      const target = newPath;
      edits.push((tree) => {
        if (target === null) return;
        if (!isSafePath(target)) throw new EditFailure('unsafe', target);
        if (tree.get(target) !== null) throw new EditFailure('exists', target);
        const plus: string[] = [];
        for (const hk of hunks) {
          for (const it of hk.newItems) if (!it.context) plus.push(it.text);
        }
        tree.set(target, plus.length === 0 ? '' : plus.join('\n') + (creationNoNewline(hunks) ? '' : '\n'));
      });
    } else if (isDelete) {
      const target = oldPath!;
      edits.push((tree) => {
        if (!isSafePath(target)) throw new EditFailure('unsafe', target);
        if (tree.get(target) === null) throw new EditFailure('missing', target);
        tree.set(target, null);
      });
    } else if (isMove) {
      const from = oldPath!;
      const to = newPath!;
      edits.push((tree) => {
        if (!isSafePath(from)) throw new EditFailure('unsafe', from);
        if (!isSafePath(to)) throw new EditFailure('unsafe', to);
        const cur = tree.get(from);
        if (cur === null) throw new EditFailure('missing', from);
        if (tree.get(to) !== null) throw new EditFailure('exists', to);
        const done = applyHunks(splitFile(cur), hunks, strict, from);
        tree.set(to, joinFile(done));
        tree.set(from, null);
        tree.moves.push({ from, to });
      });
    } else {
      const target = oldPath!;
      edits.push((tree) => {
        if (!isSafePath(target)) throw new EditFailure('unsafe', target);
        const cur = tree.get(target);
        if (cur === null) throw new EditFailure('missing', target);
        const done = applyHunks(splitFile(cur), hunks, strict, target);
        tree.set(target, joinFile(done));
      });
    }
  }
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchAt = i;
    let path: string | null = null;
    for (let j = searchAt - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (isBlank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchAt + 1);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchAt + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') eq = j;
      else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new ParseFault(searchAt + 1);
    const oldLines = lines.slice(searchAt + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const target = path;
    edits.push((tree) => {
      if (!isSafePath(target)) throw new EditFailure('unsafe', target);
      if (oldLines.length === 0) {
        if (tree.get(target) !== null) throw new EditFailure('exists', target);
        tree.set(target, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(target);
      if (cur === null) throw new EditFailure('missing', target);
      const doc = splitFile(cur);
      const tier = firstTierWith(doc.lines, oldLines, strict);
      if (tier < 0) throw new EditFailure('no-match', target);
      const spots = allOccurrences(doc.lines, oldLines, tier);
      if (spots.length > 1) throw new EditFailure('ambiguous', target);
      const oldItems: PatchLine[] = oldLines.map((t) => ({ text: t, context: false }));
      const newItems: PatchLine[] = newLines.map((t) => ({ text: t, context: false }));
      const done = spliceReplacement(doc, spots[0]!, oldItems, newItems, tier);
      tree.set(target, joinFile(done));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

const V4A_ADD = '*** Add File: ';
const V4A_DELETE = '*** Delete File: ';
const V4A_UPDATE = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionKind(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith(V4A_ADD)) return { kind: 'add', path: line.slice(V4A_ADD.length).trim() };
  if (line.startsWith(V4A_DELETE)) return { kind: 'delete', path: line.slice(V4A_DELETE.length).trim() };
  if (line.startsWith(V4A_UPDATE)) return { kind: 'update', path: line.slice(V4A_UPDATE.length).trim() };
  return null;
}

interface V4aChunk {
  anchor: string | null;
  oldItems: PatchLine[];
  newItems: PatchLine[];
  endOfFile: boolean;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const section = v4aSectionKind(line);
    if (section === null) throw new ParseFault(i + 1);
    const sectionAt = i;
    i += 1;

    if (section.kind === 'add') {
      const made: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionKind(l) !== null) break;
        if (l.startsWith('+')) {
          made.push(l.slice(1));
          i += 1;
          continue;
        }
        if (l === '') {
          made.push('');
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      while (made.length > 0 && made[made.length - 1] === '') made.pop();
      const target = section.path;
      edits.push((tree) => {
        if (!isSafePath(target)) throw new EditFailure('unsafe', target);
        if (tree.get(target) !== null) throw new EditFailure('exists', target);
        tree.set(target, made.length === 0 ? '' : made.join('\n') + '\n');
      });
      continue;
    }

    if (section.kind === 'delete') {
      while (i < last) {
        const l = lines[i]!;
        if (isBlank(l)) {
          i += 1;
          continue;
        }
        if (v4aSectionKind(l) !== null) break;
        throw new ParseFault(i + 1);
      }
      const target = section.path;
      edits.push((tree) => {
        if (!isSafePath(target)) throw new EditFailure('unsafe', target);
        if (tree.get(target) === null) throw new EditFailure('missing', target);
        tree.set(target, null);
      });
      continue;
    }

    // Update File.
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith(V4A_MOVE)) {
      moveTo = lines[i]!.slice(V4A_MOVE.length).trim();
      i += 1;
    }
    const chunks: V4aChunk[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (v4aSectionKind(l) !== null) break;
      let anchor: string | null = null;
      if (l.startsWith('@@')) {
        anchor = l.slice(2).trim();
        if (anchor === '') anchor = null;
        i += 1;
      } else if (l.trim() === '*** End of File') {
        throw new ParseFault(i + 1);
      } else if (!(l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '')) {
        throw new ParseFault(i + 1);
      }
      const oldItems: PatchLine[] = [];
      const newItems: PatchLine[] = [];
      let endOfFile = false;
      let chunkEndedBySection = false;
      while (i < last) {
        const b = lines[i]!;
        if (b.startsWith('@@')) break;
        if (b.trim() === '*** End of File') {
          endOfFile = true;
          i += 1;
          break;
        }
        if (v4aSectionKind(b) !== null) {
          chunkEndedBySection = true;
          break;
        }
        if (b.startsWith(' ')) {
          oldItems.push({ text: b.slice(1), context: true });
          newItems.push({ text: b.slice(1), context: true });
          i += 1;
          continue;
        }
        if (b.startsWith('-')) {
          oldItems.push({ text: b.slice(1), context: false });
          i += 1;
          continue;
        }
        if (b.startsWith('+')) {
          newItems.push({ text: b.slice(1), context: false });
          i += 1;
          continue;
        }
        if (b === '') {
          oldItems.push({ text: '', context: true });
          newItems.push({ text: '', context: true });
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      if (i >= last) chunkEndedBySection = true;
      if (chunkEndedBySection) {
        while (oldItems.length > 0 && newItems.length > 0) {
          const t = oldItems[oldItems.length - 1]!;
          const u = newItems[newItems.length - 1]!;
          if (t.context && t.text === '' && u.context && u.text === '') {
            oldItems.pop();
            newItems.pop();
          } else break;
        }
      }
      chunks.push({ anchor, oldItems, newItems, endOfFile });
    }
    while (chunks.length > 0) {
      const t = chunks[chunks.length - 1]!;
      if (t.anchor === null && !t.endOfFile && t.oldItems.length === 0 && t.newItems.length === 0) {
        chunks.pop();
      } else break;
    }
    if (chunks.length === 0 && moveTo === null) throw new ParseFault(sectionAt + 1);

    const target = section.path;
    const dest = moveTo;
    edits.push((tree) => {
      if (!isSafePath(target)) throw new EditFailure('unsafe', target);
      if (dest !== null && !isSafePath(dest)) throw new EditFailure('unsafe', dest);
      const cur = tree.get(target);
      if (cur === null) throw new EditFailure('missing', target);
      if (dest !== null && tree.get(dest) !== null) throw new EditFailure('exists', dest);
      let doc = splitFile(cur);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const found = findSingleLine(doc.lines, chunk.anchor, cursor, strict);
          if (found === null) throw new EditFailure('no-match', target);
          cursor = found.index + 1;
        }
        const oldTexts = chunk.oldItems.map((it) => it.text);
        if (oldTexts.length === 0) {
          const pos = chunk.endOfFile ? doc.lines.length : cursor;
          const rendered = chunk.newItems.map((it) => it.text);
          const next = doc.lines.slice();
          next.splice(pos, 0, ...rendered);
          doc = { lines: next, eol: doc.eol, finalBreak: doc.finalBreak };
          cursor = pos + rendered.length;
          continue;
        }
        const tier = firstTierWith(doc.lines, oldTexts, strict, cursor);
        if (tier < 0) throw new EditFailure('no-match', target);
        let spots = allOccurrences(doc.lines, oldTexts, tier, cursor);
        if (chunk.endOfFile) {
          spots = spots.filter((p) => p + oldTexts.length === doc.lines.length);
        }
        if (spots.length === 0) throw new EditFailure('no-match', target);
        const pos = spots[0]!;
        const done = spliceReplacement(doc, pos, chunk.oldItems, chunk.newItems, tier);
        cursor = pos + done.lines.length - (doc.lines.length - oldTexts.length);
        doc = done;
      }
      tree.set(target, joinFile(doc));
      if (dest !== null) {
        tree.set(dest, joinFile(doc));
        tree.set(target, null);
        tree.moves.push({ from: target, to: dest });
      }
    });
  }
  return edits;
}

// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when the value is not a valid edit object. */
function jsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + toLf(newStr) + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const atLine = o.insert_line;
    const added = splitPatch(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const doc = splitFile(before);
      if (atLine < 0 || atLine > doc.lines.length) throw new EditFailure('no-match', p);
      const next = doc.lines.slice();
      next.splice(atLine, 0, ...added);
      tree.set(p, joinFile({ lines: next, eol: doc.eol, finalBreak: doc.finalBreak }));
    };
  }

  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---- running the CLI (SPEC sections 1, 2, 10) ----

function parseEdits(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return parseUnified(lines, strict);
  if (kind === 'search-replace') return parseSearchReplace(lines, strict);
  return parseV4a(lines, strict);
}

/** Resolve move chains: each head's original path to the final destination. */
function moveChains(moves: Array<{ from: string; to: string }>): Array<{ from: string; to: string }> {
  const step = new Map<string, string>();
  const isDest = new Set<string>();
  for (const m of moves) {
    step.set(m.from, m.to);
    isDest.add(m.to);
  }
  const out: Array<{ from: string; to: string }> = [];
  for (const m of moves) {
    if (isDest.has(m.from)) continue;
    let end = m.to;
    while (step.has(end)) end = step.get(end)!;
    out.push({ from: m.from, to: end });
  }
  return out;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = parseEdits(kind, text, lines, strict);
    if (edits.length === 0) throw new ParseFault(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.lineNo}`] };
    throw e;
  }

  const tree = new Tree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const chain of moveChains(tree.moves)) {
    const wasFrom = tree.original(chain.from);
    const nowFrom = tree.get(chain.from);
    const wasTo = tree.original(chain.to);
    const nowTo = tree.get(chain.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      rows.push({ key: chain.to, line: `R ${chain.from} -> ${chain.to}` });
      covered.add(chain.from);
      covered.add(chain.to);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));

  if (!check) {
    for (const p of [...tree.now.keys()].sort(byteCompare)) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats — unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits — finds the lines each edit names at the first of three matching
// tiers (exact; trailing spaces and tabs ignored; leading ones too), and writes every change or none,
// printing what it changed or why it failed. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]` with the working directory as the root of the tree.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as its lines: its own line break, the lines, and whether it ends with a break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

/** Line equality at a matching tier (section 5): 0 exact, 1 trailing spaces/tabs ignored, 2 leading ones too. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const ra = a.replace(/[ \t]+$/, '');
  const rb = b.replace(/[ \t]+$/, '');
  if (tier === 1) return ra === rb;
  return ra.replace(/^[ \t]+/, '') === rb.replace(/^[ \t]+/, '');
}

function matchAt(lines: string[], o: string[], i: number, tier: number): boolean {
  for (let j = 0; j < o.length; j++) if (!tierEq(lines[i + j]!, o[j]!, tier)) return false;
  return true;
}

/** The first tier at which O occurs in `lines` at or after `from`, with every occurrence there. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i++) if (matchAt(lines, o, i, tier)) positions.push(i);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

type BodyItem = { kind: string; text: string; bare?: boolean };

/**
 * The lines a matched hunk or chunk writes in place of O (section 5): context lines are the file's own
 * matched lines; at tier 2 every other new line that starts with O's first line's indentation P has P
 * replaced by the file's first matched line's indentation F.
 */
function buildResult(body: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2) {
    f = leadWS(fileLines[pos]!);
    const firstOld = body.find((it) => it.kind === ' ' || it.kind === '-');
    p = firstOld === undefined ? '' : leadWS(firstOld.text);
  }
  let oi = 0;
  for (const it of body) {
    if (it.kind === ' ') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (it.kind === '-') {
      oi += 1;
    } else if (it.kind === '+') {
      let t = it.text;
      if (tier === 2 && t.replace(/[ \t]/g, '') !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (the no-final-break mark, section 6). */
function backslashAfter(body: BodyItem[]): boolean {
  let lastContent = -1;
  let lastSlash = -1;
  body.forEach((it, idx) => {
    if (it.kind === '\\') lastSlash = idx;
    else if (it.kind === ' ' || it.kind === '+') lastContent = idx;
  });
  return lastSlash > lastContent;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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
  final(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const { br, lines, final } = splitFile(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(lines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, spaces removed, a/ b/ stripped. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface UHunk {
  a: number;
  body: BodyItem[];
}
interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** Unified diffs (section 6): sections of hunks, applied in order, each hunk placed by content, not by its numbers. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  const pairAt = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { diffOld: m[1]!, diffNew: m[2]!, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i += 1;
      continue;
    }
    if (pairAt(i) && !(sec !== null && inHeader && sec.pairOld === null)) {
      sec = { diffOld: null, diffNew: null, pairOld: headerPath(l), pairNew: headerPath(lines[i + 1]!), renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      inHeader = true;
      i += 2;
      continue;
    }
    if (sec !== null && inHeader) {
      if (pairAt(i)) {
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice(12).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice(10).split('\t')[0]!.trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
      if (!l.startsWith('@@')) {
        i += 1;
        continue;
      }
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const a = parseInt(hm[1]!, 10);
      i += 1;
      const body: BodyItem[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || pairAt(i)) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '', bare: true });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.bare === true) body.pop();
        else break;
      }
      sec.hunks.push({ a, body });
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld ?? s.renameFrom ?? s.diffOld!;
  const newPath = s.pairNew ?? s.renameTo ?? s.diffNew!;
  const isCreate = s.newFile || oldPath === '/dev/null';
  const isDelete = s.delFile || newPath === '/dev/null';
  return (tree) => {
    for (const p of [oldPath, newPath]) if (p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    if (isCreate) {
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const created: string[] = [];
      let lastPlus = -1;
      let lastSlash = -1;
      let k = 0;
      for (const h of s.hunks) for (const it of h.body) {
        if (it.kind === '+') {
          created.push(it.text);
          lastPlus = k;
        } else if (it.kind === '\\') lastSlash = k;
        k += 1;
      }
      const text = created.length === 0 ? '' : created.join('\n') + (lastSlash > lastPlus ? '' : '\n');
      tree.now.set(newPath, text);
      return;
    }
    if (isDelete) {
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (oldPath !== newPath && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const { br, lines: fl, final } = splitFile(before);
    let fin = final;
    let d = 0;
    for (const h of s.hunks) {
      const o: string[] = [];
      let nLen = 0;
      for (const it of h.body) {
        if (it.kind === ' ' || it.kind === '-') o.push(it.text);
        if (it.kind === ' ' || it.kind === '+') nLen += 1;
      }
      if (o.length === 0) {
        const pos = Math.min(h.a + d, fl.length);
        const add = h.body.filter((it) => it.kind === '+').map((it) => it.text);
        const atEnd = pos === fl.length;
        fl.splice(pos, 0, ...add);
        if (atEnd) fin = !backslashAfter(h.body);
        d += nLen;
        continue;
      }
      const found = findTier(fl, o, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      for (const cand of found.positions) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const written = buildResult(h.body, fl, pos, found.tier);
      const atEnd = pos + o.length === fl.length;
      fl.splice(pos, o.length, ...written);
      if (atEnd) fin = !backslashAfter(h.body);
      d += nLen - o.length;
    }
    const text = joinFile(fl, br, fin);
    if (oldPath !== newPath) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, text);
      tree.moves.push([oldPath, newPath]);
    } else tree.now.set(oldPath, text);
  };
}

/** SEARCH/REPLACE blocks (section 7): each block replaces its old lines, which must occur exactly once. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j >= prevEnd; j--) {
      const cand = lines[j]!;
      if (blank(cand) || cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '=======') {
      eq = j;
      break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
      rep = j;
      break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    const o = lines.slice(at + 1, eq);
    const n = lines.slice(eq + 1, rep);
    edits.push(srBlockEdit(path, o, n, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srBlockEdit(path: string, o: string[], n: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (o.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, n.length === 0 ? '' : n.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { br, lines: fl, final } = splitFile(before);
    const found = findTier(fl, o, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const body: BodyItem[] = [...o.map((t) => ({ kind: '-', text: t })), ...n.map((t) => ({ kind: '+', text: t }))];
    const written = buildResult(body, fl, found.positions[0]!, found.tier);
    fl.splice(found.positions[0]!, o.length, ...written);
    tree.now.set(path, joinFile(fl, br, final));
  };
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

const V4A_HEADS: Array<[string, string]> = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'del'],
  ['*** Update File: ', 'upd'],
];

/** V4A patches (section 8): Add, Delete and Update sections; Update chunks walk a cursor through the file. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const headAt = (l: string): [string, string] | null => {
    for (const h of V4A_HEADS) if (l.startsWith(h[0])) return h;
    return null;
  };
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const head = headAt(l);
    if (head === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = head[1];
    const path = l.slice(head[0].length).trim();
    const secLine = i + 1;
    i += 1;
    const body: Array<{ text: string; idx: number }> = [];
    while (i < last && headAt(lines[i]!) === null) {
      body.push({ text: lines[i]!, idx: i });
      i += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) content.push(b.text.slice(1));
        else if (b.text === '') content.push('');
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      body.forEach((b, bi) => {
        const t = b.text;
        if (t.startsWith('*** Move to: ')) {
          if (bi !== 0) throw new Exit2(`error: parse ${b.idx + 1}`);
          moveTo = t.slice(13).trim();
          return;
        }
        if (t.trimEnd() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.idx + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          return;
        }
        if (t.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          return;
        }
        const c = t[0];
        if (t === '' || c === ' ' || c === '-' || c === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${b.idx + 1}`);
            cur = { anchor: null, eof: false, body: [] };
          }
          cur.body.push({ kind: t === '' ? ' ' : c!, text: t === '' ? '' : t.slice(1) });
          return;
        }
        throw new Exit2(`error: parse ${b.idx + 1}`);
      });
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { br, lines: fl, final } = splitFile(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let at = -1;
        for (const tier of tiers) {
          for (let j = cursor; j < fl.length; j++) if (tierEq(fl[j]!, ch.anchor, tier)) {
            at = j;
            break;
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      for (const it of ch.body) if (it.kind === ' ' || it.kind === '-') o.push(it.text);
      if (o.length === 0) {
        const add = ch.body.filter((it) => it.kind === '+').map((it) => it.text);
        const pos = ch.eof ? fl.length : Math.min(cursor, fl.length);
        fl.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (const tier of tiers) {
        for (let j = cursor; j + o.length <= fl.length; j++) {
          if (ch.eof && j + o.length !== fl.length) continue;
          if (matchAt(fl, o, j, tier)) {
            found = { tier, pos: j };
            break;
          }
        }
        if (found !== null) break;
      }
      if (found === null) throw new Fail('no-match', path);
      const written = buildResult(ch.body, fl, found.pos, found.tier);
      fl.splice(found.pos, o.length, ...written);
      cursor = found.pos + written.length;
    }
    const text = joinFile(fl, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      tree.moves.push([path, moveTo]);
    } else tree.now.set(path, text);
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; line: string }> = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (usedOld.has(o) || usedNew.has(n)) continue;
    if (tree.original(o) !== null && tree.final(o) === null && tree.original(n) === null && tree.final(n) !== null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      usedOld.add(o);
      usedNew.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
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

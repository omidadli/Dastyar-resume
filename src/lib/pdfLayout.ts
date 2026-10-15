/**
 * Rebuilds reading-order text from pdf.js text items.
 *
 * A PDF stores glyphs by position, not in reading order. Browsers ("Save as
 * PDF"), Word and most Persian resume builders place RTL text in VISUAL
 * left-to-right order — often one item per glyph, with presentation forms,
 * mirrored brackets and spaces as separate items. Joining items naively (or
 * dropping the space items) turns «علی رضایی» into «عل یر ضای ی», which made
 * keyword matching and the AI see garbage.
 *
 * This module is pure (no pdf.js import) so it can be unit-tested with
 * recorded items:
 *  1. groups items into lines by baseline,
 *  2. finds a real column gutter (an x band no line crosses) — not "items on
 *     both halves", which every full-width line has when glyphs are items,
 *  3. inserts spaces only where there is an actual visual gap,
 *  4. restores logical order with a small bidi pass (RTL runs reversed, LTR
 *     runs such as emails and numbers kept intact, brackets un-mirrored).
 */

export interface PdfTextItem {
  str: string;
  /** Left edge in PDF units. */
  x: number;
  /** Baseline measured from the TOP of the page. */
  y: number;
  w: number;
  /** Font height (0 for some space items). */
  h: number;
}

/** R: Arabic-script letters · L: Latin letters · EN: numbers · N: spaces/punctuation. */
type Cls = 'R' | 'L' | 'EN' | 'N';

// Arabic-script / Hebrew letters — excluding Arabic-Indic and Persian digits.
const RTL_CHAR = /[\u0590-\u05FF\u0600-\u065F\u066A-\u06EF\u06FA-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
const RTL_CHARS = new RegExp(RTL_CHAR.source, 'g');
const LTR_LETTERS = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/g;
const DIGIT = /[0-9\u0660-\u0669\u06F0-\u06F9]/;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

/**
 * Arabic presentation forms: [first code point, number of forms]. Groups of 4
 * are dual-joining letters (isolated, final, initial, medial); groups of 2
 * join only to the right (isolated, final).
 */
const FORM_GROUPS: Array<[number, number]> = [
  [0xfe81, 2], [0xfe83, 2], [0xfe85, 2], [0xfe87, 2], [0xfe89, 4], [0xfe8d, 2], [0xfe8f, 4], [0xfe93, 2],
  [0xfe95, 4], [0xfe99, 4], [0xfe9d, 4], [0xfea1, 4], [0xfea5, 4], [0xfea9, 2], [0xfeab, 2], [0xfead, 2],
  [0xfeaf, 2], [0xfeb1, 4], [0xfeb5, 4], [0xfeb9, 4], [0xfebd, 4], [0xfec1, 4], [0xfec5, 4], [0xfec9, 4],
  [0xfecd, 4], [0xfed1, 4], [0xfed5, 4], [0xfed9, 4], [0xfedd, 4], [0xfee1, 4], [0xfee5, 4], [0xfee9, 4],
  [0xfeed, 2], [0xfeef, 2], [0xfef1, 4], [0xfef5, 2], [0xfef7, 2], [0xfef9, 2], [0xfefb, 2],
  [0xfb56, 4], [0xfb7a, 4], [0xfb8a, 2], [0xfb8e, 4], [0xfb92, 4], [0xfba4, 2], [0xfba6, 4], [0xfbaa, 4], [0xfbfc, 4],
];
/** Dual-joining letters drawn in isolated/final form (they do not join forward). */
const NON_FORWARD_DUAL = new Set<number>();
/** Any letter drawn in isolated/initial form (it does not join backward). */
const NON_BACKWARD = new Set<number>();
for (const [start, n] of FORM_GROUPS) {
  NON_BACKWARD.add(start);
  if (n === 4) {
    NON_FORWARD_DUAL.add(start).add(start + 1);
    NON_BACKWARD.add(start + 2);
  }
}
/** Base (nominal) Persian/Arabic letters that join on both sides. */
const DUAL_JOINING_BASE = /[\u0626\u0628\u062A-\u062E\u0633-\u063A\u0641-\u0647\u064A\u067E\u0686\u06A9\u06AF\u06CC]/;
const ARABIC_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06FA-\u06FC\uFB50-\uFDFF\uFE70-\uFEFC]/;

/**
 * Chrome/Word don't draw the zero-width non-joiner, so «مهارت‌ها» arrives as
 * «مهارتها». A dual-joining letter in isolated/final form followed directly
 * by another letter proves the join was broken there — restore the ZWNJ.
 * Only explicit presentation forms are trusted (base letters are ambiguous).
 */
export function restoreZwnj(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    out += s[i];
    const next = s[i + 1];
    if (!next) continue;
    const cur = s.charCodeAt(i);
    const broken =
      (NON_FORWARD_DUAL.has(cur) && ARABIC_LETTER.test(next)) || // «ه» final + any letter
      (DUAL_JOINING_BASE.test(s[i]) && NON_BACKWARD.has(next.charCodeAt(0))); // dual letter + a fresh start
    if (broken) out += '\u200C';
  }
  return out;
}

const count = (s: string, re: RegExp) => (s.match(re) || []).length;
const isBlank = (s: string) => !s.trim();

function classify(s: string): Cls {
  const r = count(s, RTL_CHARS);
  const l = count(s, LTR_LETTERS);
  if (r === 0 && l === 0) return DIGIT.test(s) ? 'EN' : 'N';
  return r >= l ? 'R' : 'L';
}

/** Single separators that stay inside a number: 1,000 · 09:30 · 1.5 · ۰۹۱۲-۳۴۵ */
const NUMBER_SEPARATOR = /^[+\-.,:/\u066B\u066C]$/;

const mirror = (s: string) => s.replace(/[()[\]{}<>«»]/g, (c) => MIRROR[c] || c);

interface Line {
  y: number;
  h: number;
  items: PdfTextItem[];
}

function buildLines(items: PdfTextItem[]): Line[] {
  const sorted = items.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    const h = it.h || last?.h || 10;
    if (last && Math.abs(it.y - last.y) <= Math.max(2.5, Math.min(h, last.h || h) * 0.45)) {
      last.items.push(it);
      if (it.h > last.h) last.h = it.h;
    } else {
      lines.push({ y: it.y, h: it.h || 10, items: [it] });
    }
  }
  return lines;
}

/** Ink intervals of a line; word gaps are merged so a normal line is one span. */
function spansOf(line: Line): Array<[number, number]> {
  const ink = line.items.filter((i) => !isBlank(i.str) && i.w > 0).sort((a, b) => a.x - b.x);
  const merge = Math.max(8, line.h * 1.2);
  const out: Array<[number, number]> = [];
  for (const it of ink) {
    const a = it.x;
    const b = it.x + it.w;
    const last = out[out.length - 1];
    if (last && a - last[1] < merge) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * x position of a vertical gutter that (almost) no line crosses while plenty
 * of lines sit on each side of it — a genuine two-column layout. `null` for
 * single-column pages.
 */
export function findGutter(lines: Line[], pageWidth: number): number | null {
  const spans = lines.map(spansOf).filter((s) => s.length > 0);
  const n = spans.length;
  if (n < 6 || pageWidth <= 0) return null;
  const maxCross = Math.max(1, Math.floor(n * 0.05));
  const minSide = Math.max(3, Math.ceil(n * 0.15));
  let bestScore = -Infinity;
  let bestXs: number[] = [];
  for (let x = pageWidth * 0.2; x <= pageWidth * 0.8; x += 2) {
    let cross = 0;
    let left = 0;
    let right = 0;
    for (const sp of spans) {
      let l = false;
      let r = false;
      let c = false;
      for (const [a, b] of sp) {
        if (a < x - 1 && b > x + 1) c = true;
        else if (b <= x + 1) l = true;
        else r = true;
      }
      if (c) cross++;
      if (l) left++;
      if (r) right++;
    }
    if (cross > maxCross || left < minSide || right < minSide) continue;
    const score = Math.min(left, right) - cross * 4;
    if (score > bestScore) {
      bestScore = score;
      bestXs = [x];
    } else if (score === bestScore) {
      bestXs.push(x);
    }
  }
  if (!bestXs.length) return null;
  // Centre of the first contiguous band of best positions.
  let end = 0;
  while (end + 1 < bestXs.length && bestXs[end + 1] - bestXs[end] <= 2.01) end++;
  return (bestXs[0] + bestXs[end]) / 2;
}

/** One visual line (items in any order) → logical-order text. */
export function assembleLine(items: PdfTextItem[], rtlDocument: boolean): string {
  const visual = items.filter((i) => i.str.length > 0).sort((a, b) => a.x - b.x);
  if (!visual.length) return '';

  // Spaces from real gaps (many generators position words without a space glyph).
  const seq: Array<{ s: string; cls: Cls }> = [];
  for (let i = 0; i < visual.length; i++) {
    const cur = visual[i];
    const prev = visual[i - 1];
    if (prev && !isBlank(prev.str) && !isBlank(cur.str)) {
      const gap = cur.x - (prev.x + prev.w);
      const size = Math.max(prev.h, cur.h) || 10;
      if (gap > size * 0.22) seq.push({ s: ' ', cls: 'N' });
    }
    seq.push({ s: cur.str, cls: classify(cur.str) });
  }

  const hasR = seq.some((t) => t.cls === 'R');
  const hasL = seq.some((t) => t.cls === 'L');
  const rtl = hasR && (!hasL || rtlDocument);

  const out: Array<{ s: string; mirrored: boolean }> = [];
  if (rtl) {
    // Visual → logical: reverse, then put LTR runs (Latin words, numbers) back.
    const order = seq.slice().reverse().map((t) => ({ ...t }));
    // Unicode bidi W7: a number after Latin text joins the Latin run («IELTS 7»).
    let lastStrong: 'R' | 'L' = 'R';
    for (const t of order) {
      if (t.cls === 'R' || t.cls === 'L') lastStrong = t.cls;
      else if (t.cls === 'EN' && lastStrong === 'L') t.cls = 'L';
    }
    for (const t of order) out.push({ s: t.s, mirrored: true });
    let i = 0;
    while (i < order.length) {
      const c = order[i].cls;
      if (c !== 'L' && c !== 'EN') {
        i++;
        continue;
      }
      // Latin run: neutrals inside are Latin too. Number run: only separators.
      let j = i;
      for (let k = i + 1; k < order.length; k++) {
        const t = order[k];
        if (c === 'L') {
          if (t.cls === 'R' || t.cls === 'EN') break;
          if (t.cls === 'L') j = k;
        } else {
          if (t.cls === 'EN') j = k;
          else if (!(t.cls === 'N' && NUMBER_SEPARATOR.test(t.s.trim()) && t.s.trim().length === 1)) break;
        }
      }
      const run = order.slice(i, j + 1).reverse();
      run.forEach((t, m) => (out[i + m] = { s: t.s, mirrored: false }));
      i = j + 1;
    }
  } else {
    // LTR line: put embedded RTL runs (with the numbers/neutrals inside them) in order.
    for (const t of seq) out.push({ s: t.s, mirrored: false });
    let i = 0;
    while (i < seq.length) {
      if (seq[i].cls !== 'R') {
        i++;
        continue;
      }
      let j = i;
      for (let k = i + 1; k < seq.length && seq[k].cls !== 'L'; k++) if (seq[k].cls === 'R') j = k;
      const run = seq.slice(i, j + 1).reverse();
      run.forEach((t, m) => (out[i + m] = { s: t.s, mirrored: true }));
      i = j + 1;
    }
  }

  return restoreZwnj(out.map((t) => (t.mirrored ? mirror(t.s) : t.s)).join(''))
    .replace(/[ \t\u00A0]+/g, ' ')
    .trim();
}

/** Full page: lines, optional two-column split, logical order. */
export function assemblePageText(items: PdfTextItem[], pageWidth: number, rtlHint?: boolean): string {
  const usable = items.filter((i) => typeof i.str === 'string' && i.str.length > 0 && Number.isFinite(i.x) && Number.isFinite(i.y));
  if (!usable.length) return '';
  const all = usable.map((i) => i.str).join('');
  const rtlDocument = rtlHint ?? count(all, RTL_CHARS) >= count(all, LTR_LETTERS) / 2;
  const lines = buildLines(usable);
  const gutter = findGutter(lines, pageWidth);

  if (gutter === null) {
    return lines
      .map((l) => assembleLine(l.items, rtlDocument))
      .filter(Boolean)
      .join('\n');
  }

  // Two columns: full-width lines (crossing the gutter) stay in place; column
  // lines are buffered and flushed in reading order (right first for RTL).
  const out: string[] = [];
  let leftCol: string[] = [];
  let rightCol: string[] = [];
  const flush = () => {
    const first = rtlDocument ? rightCol : leftCol;
    const second = rtlDocument ? leftCol : rightCol;
    out.push(...first);
    if (first.length && second.length) out.push('');
    out.push(...second);
    leftCol = [];
    rightCol = [];
  };
  for (const line of lines) {
    const crosses = spansOf(line).some(([a, b]) => a < gutter - 1 && b > gutter + 1);
    if (crosses) {
      flush();
      const t = assembleLine(line.items, rtlDocument);
      if (t) out.push(t);
      continue;
    }
    const left = line.items.filter((i) => i.x + i.w / 2 < gutter);
    const right = line.items.filter((i) => i.x + i.w / 2 >= gutter);
    const lt = assembleLine(left, rtlDocument);
    const rt = assembleLine(right, rtlDocument);
    if (lt) leftCol.push(lt);
    if (rt) rightCol.push(rt);
  }
  flush();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

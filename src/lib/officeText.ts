/**
 * Format-independent text extraction helpers shared by the browser and the
 * server (pure — no DOM, no Node APIs, no bundler imports, so they are unit
 * testable).
 *
 *  - Word (DOCX / Word 2003 XML), PowerPoint (PPTX), OpenDocument (ODT/ODS/ODP),
 *    XPS and EPUB → reading-order text from their XML.
 *  - HTML → text; JSON (e.g. JSON Resume, LinkedIn exports) → readable lines.
 *  - Byte decoding with BOM / UTF-8 / UTF-16 / Windows-1256 detection (old
 *    Persian Windows files are often 1256).
 *  - A garbage detector: PDFs with broken font maps extract as mojibake that
 *    *looks* like text; such text must not be trusted over the original file.
 */

export interface ZipEntryLike {
  name: string;
  dir: boolean;
  async(type: 'string'): Promise<string>;
  async(type: 'uint8array'): Promise<Uint8Array>;
}

export interface ZipLike {
  files: Record<string, ZipEntryLike>;
  file(path: string): ZipEntryLike | null;
}

// ---------------------------------------------------------------- XML ----

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ' ';
    try {
      return String.fromCodePoint(code);
    } catch {
      return ' ';
    }
  });
}

function tidyLines(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** `mc:AlternateContent` repeats text boxes in a VML fallback — keep one copy. */
function dropFallbacks(xml: string): string {
  return xml.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, '');
}

/**
 * WordprocessingML (document.xml, headers, footers, Word 2003 XML) → text.
 * Paragraphs → lines, tabs → spaces, deleted revisions and field codes are
 * skipped, text boxes and table cells are kept.
 */
export function wordXmlToText(xml: string): string {
  const src = dropFallbacks(xml)
    .replace(/<w:delText\b[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, '');
  const out: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/?>|<\/w:p>|<w:p\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) out.push(decodeXmlEntities(m[1]));
    else if (m[2] === 'tab') out.push(' ');
    else out.push('\n'); // <w:br/>, <w:cr/>, end of paragraph (also each table cell)
  }
  return tidyLines(out.join(''));
}

/** DrawingML text (PPTX slides, charts, SmartArt). */
export function drawingXmlToText(xml: string): string {
  const src = dropFallbacks(xml);
  const out: string[] = [];
  const re = /<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1] !== undefined || m[2] !== undefined) out.push(decodeXmlEntities(m[1] ?? m[2]));
    else out.push('\n');
  }
  return tidyLines(out.join(''));
}

/** OpenDocument content.xml (ODT / ODS / ODP). */
export function odfXmlToText(xml: string): string {
  return tidyLines(
    decodeXmlEntities(
      xml
        .replace(/<office:annotation\b[\s\S]*?<\/office:annotation>/g, '')
        .replace(/<text:s(?:\s+text:c="(\d+)")?[^>]*\/>/g, (_m, c) => ' '.repeat(Math.min(8, Number(c) || 1)))
        .replace(/<text:tab[^>]*\/>/g, ' ')
        .replace(/<text:line-break[^>]*\/>/g, '\n')
        .replace(/<\/table:table-cell>/g, ' | ')
        .replace(/<\/(text:p|text:h|table:table-row|text:list-item)>/g, '\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

/** XPS / OpenXPS page (FixedPage) → text of its Glyphs elements. */
export function xpsPageToText(xml: string): string {
  const lines: string[] = [];
  const re = /<Glyphs\b[^>]*?UnicodeString="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) lines.push(decodeXmlEntities(m[1]).replace(/^\{\}/, ''));
  return tidyLines(lines.join('\n'));
}

// --------------------------------------------------------------- HTML ----

export function htmlToText(html: string): string {
  return tidyLines(
    decodeXmlEntities(
      html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(script|style|head|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(td|th)>/gi, ' | ')
        .replace(/<li\b[^>]*>/gi, '\n• ')
        .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|table|ul|ol|dt|dd|blockquote|pre)>/gi, '\n')
        .replace(/<(p|div|h[1-6]|tr|section|article|table)\b[^>]*>/gi, '\n')
        .replace(/<a\b[^>]*href="(mailto:|tel:)([^"]+)"[^>]*>/gi, ' $2 ')
        .replace(/<[^>]+>/g, '')
    )
  );
}

// --------------------------------------------------------------- JSON ----

const JSON_SKIP_KEYS = /^(id|uuid|guid|_id|image|picture|photo|avatar|icon|url_hash|meta|\$schema)$/i;

/** Any JSON (JSON Resume, LinkedIn/portal exports) → indented «key: value» lines. */
export function jsonToText(value: unknown, maxChars = 30000): string {
  const lines: string[] = [];
  let size = 0;
  const walk = (v: unknown, key: string, depth: number) => {
    if (size > maxChars || depth > 8) return;
    const pad = '  '.repeat(depth);
    if (v === null || v === undefined || v === '') return;
    if (Array.isArray(v)) {
      if (key) lines.push(`${pad}${key}:`);
      v.slice(0, 200).forEach((item) => walk(item, '', depth + (key ? 1 : 0)));
      return;
    }
    if (typeof v === 'object') {
      if (key) lines.push(`${pad}${key}:`);
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        if (JSON_SKIP_KEYS.test(k)) continue;
        walk(child, k, depth + (key ? 1 : 0));
      }
      return;
    }
    const line = `${pad}${key ? `${key}: ` : '- '}${String(v)}`;
    size += line.length;
    lines.push(line);
  };
  walk(value, '', 0);
  return lines.join('\n').slice(0, maxChars);
}

// ------------------------------------------------------------ archives ----

function entryText(zip: ZipLike, path: string): Promise<string> {
  const f = zip.file(path);
  return f ? f.async('string') : Promise.resolve('');
}

function numbered(names: string[], re: RegExp): string[] {
  return names
    .map((n) => ({ n, m: n.match(re) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((x) => x.n);
}

/** DOCX: headers (contact details often live there), body, footnotes, footers. */
export async function docxText(zip: ZipLike): Promise<string> {
  const names = Object.keys(zip.files);
  const body = wordXmlToText(await entryText(zip, 'word/document.xml'));
  const part = async (re: RegExp) => {
    const texts: string[] = [];
    for (const n of numbered(names, re)) {
      const t = wordXmlToText(await entryText(zip, n));
      if (t && !body.includes(t) && !texts.includes(t)) texts.push(t);
    }
    return texts.join('\n');
  };
  const headers = await part(/^word\/header(\d+)\.xml$/);
  const footers = await part(/^word\/footer(\d+)\.xml$/);
  const notes = wordXmlToText(await entryText(zip, 'word/footnotes.xml'));
  return tidyLines([headers, body, notes, footers].filter((t) => t && t.trim()).join('\n'));
}

export async function pptxText(zip: ZipLike): Promise<string> {
  const names = Object.keys(zip.files);
  const slides = numbered(names, /^ppt\/slides\/slide(\d+)\.xml$/);
  const out: string[] = [];
  for (const s of slides) {
    const t = drawingXmlToText(await entryText(zip, s));
    if (t) out.push(t);
  }
  return tidyLines(out.join('\n\n'));
}

export async function odfText(zip: ZipLike): Promise<string> {
  return odfXmlToText(await entryText(zip, 'content.xml'));
}

export async function xpsText(zip: ZipLike): Promise<string> {
  const pages = Object.keys(zip.files)
    .filter((n) => /\.fpage$/i.test(n))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const out: string[] = [];
  for (const p of pages.slice(0, 30)) out.push(xpsPageToText(await entryText(zip, p)));
  return tidyLines(out.join('\n\n'));
}

export async function epubText(zip: ZipLike, maxChars = 60000): Promise<string> {
  const container = await entryText(zip, 'META-INF/container.xml');
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1];
  let order: string[] = [];
  if (opfPath) {
    const opf = await entryText(zip, opfPath);
    const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const manifest = new Map<string, string>();
    for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
      const id = m[0].match(/\sid="([^"]+)"/)?.[1];
      const href = m[0].match(/\shref="([^"]+)"/)?.[1];
      if (id && href) manifest.set(id, dir + decodeURIComponent(href));
    }
    order = Array.from(opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g))
      .map((m) => manifest.get(m[1]))
      .filter((x): x is string => Boolean(x));
  }
  if (!order.length) order = Object.keys(zip.files).filter((n) => /\.x?html?$/i.test(n)).sort();
  const out: string[] = [];
  let size = 0;
  for (const p of order) {
    if (size > maxChars) break;
    const t = htmlToText(await entryText(zip, p));
    size += t.length;
    out.push(t);
  }
  return tidyLines(out.join('\n\n')).slice(0, maxChars);
}

/** Embedded pictures (largest first) — a resume pasted into Word as an image. */
export function mediaEntries(zip: ZipLike): ZipEntryLike[] {
  return Object.values(zip.files).filter(
    (f) => !f.dir && /^(word|ppt|xl)\/media\/|^Pictures\//i.test(f.name) && /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i.test(f.name)
  );
}

// ------------------------------------------------------------- decoding ----

/** Text bytes → string: BOM, strict UTF-8, UTF-16 without BOM, then Windows-1256. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  // UTF-16 without a BOM: every other byte is zero for Latin text.
  const sample = bytes.subarray(0, Math.min(bytes.length, 2000));
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 ? zeroOdd++ : zeroEven++);
  if (sample.length > 20 && zeroOdd > sample.length * 0.3 && zeroEven < sample.length * 0.05) return new TextDecoder('utf-16le').decode(bytes);
  if (sample.length > 20 && zeroEven > sample.length * 0.3 && zeroOdd < sample.length * 0.05) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

/** Whether bytes look like text (not a binary format). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (!sample.length) return false;
  if ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff)) return true;
  let control = 0;
  let zeros = 0;
  for (const b of sample) {
    if (b === 0) zeros++;
    else if (b < 9 || (b > 13 && b < 32)) control++;
  }
  if (zeros > sample.length * 0.3) return true; // UTF-16 text (checked again on decode)
  return zeros === 0 && control < sample.length * 0.02;
}

/**
 * Printable runs from an unknown binary («strings»), UTF-8 and UTF-16LE,
 * keeping Persian/Arabic letters. Last resort for unknown formats.
 */
export function binaryStrings(bytes: Uint8Array, maxChars = 40000): string {
  const window = bytes.length > 8_000_000 ? bytes.subarray(0, 8_000_000) : bytes;
  const runs: string[] = [];
  // Letters of scripts résumés are written in — random bytes decoded as
  // UTF-16 land in CJK/Hangul blocks and must not count as text.
  const letter = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]/;
  const other = /[0-9\u06F0-\u06F9\u0660-\u0669\s.,;:!?'"()\-_@+#%&*=/\\|\u060C\u061B\u061F\u066B\u066C\u200C\u00AB\u00BB\u2013\u2014]/;
  const collect = (text: string, min: number) => {
    let cur = '';
    for (const ch of text) {
      if (letter.test(ch) || other.test(ch)) cur += ch;
      else {
        if (cur.trim().length >= min) runs.push(cur.trim());
        cur = '';
      }
    }
    if (cur.trim().length >= min) runs.push(cur.trim());
  };
  collect(new TextDecoder('utf-8', { fatal: false }).decode(window), 6);
  // UTF-16LE at both byte alignments (text can start at an odd offset).
  for (const start of [0, 1]) {
    const slice = window.subarray(start, window.length - ((window.length - start) % 2));
    collect(new TextDecoder('utf-16le', { fatal: false }).decode(slice), 5);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let size = 0;
  for (const r of runs) {
    // Real words: a 3-letter streak and mostly letters.
    const letters = Array.from(r).filter((ch) => letter.test(ch)).length;
    if (!/(?:[A-Za-z\u00C0-\u024F]{3}|[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFC]{3}|[\u0400-\u04FF]{3})/.test(r)) continue;
    if (letters / r.length < 0.5 || seen.has(r)) continue;
    if (new Set(r).size < Math.min(6, r.length / 3)) continue; // «āāāāā…» padding, not words
    seen.add(r);
    out.push(r);
    size += r.length;
    if (size > maxChars) break;
  }
  return out.join('\n');
}

// -------------------------------------------------------------- quality ----

export interface TextQuality {
  chars: number;
  letters: number;
  /** Mojibake / private-use glyphs / broken encodings — don't trust it. */
  garbled: boolean;
  /** Enough real content to evaluate from text alone. */
  usable: boolean;
}

export function assessText(text: string): TextQuality {
  const t = (text || '').trim();
  const chars = t.length;
  if (!chars) return { chars: 0, letters: 0, garbled: false, usable: false };
  const letters = (t.match(/\p{L}/gu) || []).length;
  const pua = (t.match(/[\uE000-\uF8FF\uFFFD]/g) || []).length;
  // Persian decoded as Latin-1/1252: «Ø³Ù„Ø§Ù…», «ÇáÓáÇã»
  const mojibake = (t.match(/[ØÙÚÛ][\u0080-\u00BF]|[ÇÈÊËÌÍÎÏÑÒÓÔÕÖ×ÜÝÞßàáâãäåæçèéêëìíîï]{3,}/g) || []).length;
  const controls = (t.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const words = t.split(/\s+/).filter(Boolean);
  const longJunk = words.filter((w) => w.length > 40 && !/^https?:|@/.test(w)).length;
  const garbled =
    pua > chars * 0.05 ||
    mojibake > 6 ||
    controls > chars * 0.02 ||
    (words.length > 20 && longJunk > words.length * 0.2) ||
    (chars > 200 && letters < chars * 0.3);
  return { chars, letters, garbled, usable: !garbled && letters >= 60 };
}

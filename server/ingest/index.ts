/**
 * Universal resume intake — «هر فایلی با هر فرمتی».
 *
 * ingestDocument() identifies a file by its content (magic bytes) rather than
 * trusting the extension, then returns:
 *   - text   — reading-order text for the AI and the local engine;
 *   - files  — attachments the AI can read directly (the original PDF, scans
 *              converted to JPEG, audio/video résumés, pictures embedded in
 *              Office files whose text layer is empty);
 *   - label  — a Persian name of the format for the UI;
 *   - unreadable — an honest, actionable reason when nothing can be read.
 *
 * Covered: PDF (text + scans), DOCX/DOC/ODT/RTF/Word-XML, PPTX/PPT/ODP,
 * XLSX/XLS/ODS/CSV, EPUB, XPS, Apple iWork previews, HTML/MHTML/XML/JSON/TXT/
 * Markdown/vCard, e-mails (EML/MSG with attachments), ZIP/TAR/GZIP archives,
 * every common image format (JPEG/PNG/WebP/HEIC/GIF/BMP/TIFF), audio/video
 * résumés, and a «strings» fallback for anything else.
 */
import zlib from 'zlib';
import type { AiFile } from '../ai/provider';
import { assemblePageText, type PdfTextItem } from '../../src/lib/pdfLayout';
import { rtfToText } from '../../src/lib/rtf';
import { normalizePersianText } from '../../src/lib/normalizeFa';
import {
  assessText,
  binaryStrings,
  decodeTextBytes,
  docxText,
  epubText,
  htmlToText,
  jsonToText,
  looksLikeText,
  mediaEntries,
  odfText,
  odfXmlToText,
  pptxText,
  wordXmlToText,
  xpsText,
  type ZipLike,
} from '../../src/lib/officeText';
import { imageToAiFiles } from './images';
import { looksLikeEmail, parseMime } from './mime';

export type FormatKind =
  | 'pdf'
  | 'docx'
  | 'doc'
  | 'odt'
  | 'rtf'
  | 'pptx'
  | 'ppt'
  | 'odp'
  | 'xlsx'
  | 'xls'
  | 'ods'
  | 'csv'
  | 'epub'
  | 'iwork'
  | 'xps'
  | 'zip'
  | 'ole'
  | 'rar'
  | '7z'
  | 'gzip'
  | 'tar'
  | 'html'
  | 'mhtml'
  | 'xml'
  | 'json'
  | 'eml'
  | 'msg'
  | 'vcf'
  | 'markdown'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'svg'
  | 'encrypted'
  | 'djvu'
  | 'empty'
  | 'unknown';

export interface IngestResult {
  kind: FormatKind;
  /** Persian label, e.g. «Word (DOCX)», «PDF اسکن‌شده», «تصویر TIFF». */
  label: string;
  mime: string;
  text: string;
  files: AiFile[];
  warnings: string[];
  /** Why nothing could be read (null when text or attachments exist). */
  unreadable: string | null;
  pages?: number;
}

const LABELS: Record<FormatKind, string> = {
  pdf: 'PDF',
  docx: 'Word (DOCX)',
  doc: 'Word قدیمی (DOC)',
  odt: 'سند OpenDocument (ODT)',
  rtf: 'RTF',
  pptx: 'پاورپوینت (PPTX)',
  ppt: 'پاورپوینت قدیمی (PPT)',
  odp: 'ارائه OpenDocument (ODP)',
  xlsx: 'اکسل (XLSX)',
  xls: 'اکسل قدیمی (XLS)',
  ods: 'صفحه‌گسترده OpenDocument (ODS)',
  csv: 'CSV',
  epub: 'کتاب الکترونیکی (EPUB)',
  iwork: 'Apple Pages / Keynote / Numbers',
  xps: 'XPS',
  zip: 'فایل فشرده ZIP',
  ole: 'سند قدیمی Office',
  rar: 'فایل فشرده RAR',
  '7z': 'فایل فشرده 7z',
  gzip: 'فایل فشرده GZip',
  tar: 'آرشیو TAR',
  html: 'صفحه وب (HTML)',
  mhtml: 'صفحه وب ذخیره‌شده (MHTML)',
  xml: 'XML',
  json: 'JSON',
  eml: 'ایمیل (EML)',
  msg: 'ایمیل Outlook (MSG)',
  vcf: 'کارت تماس (vCard)',
  markdown: 'Markdown',
  text: 'متن ساده',
  image: 'تصویر',
  audio: 'فایل صوتی',
  video: 'فایل ویدیویی',
  svg: 'تصویر برداری (SVG)',
  encrypted: 'سند رمزگذاری‌شده',
  djvu: 'DjVu',
  empty: 'فایل خالی',
  unknown: 'قالب ناشناخته',
};

/** Raw attachment budget (Gemini inline requests stay under ~20 MB). */
const ATTACH_BUDGET = 18 * 1024 * 1024;
const MAX_TEXT = 60000;
const MAX_DEPTH = 3;

const GEMINI_AUDIO = /^audio\/(wav|mpeg|aiff|aac|ogg|flac|mp4)$/;
const GEMINI_VIDEO = /^video\/(mp4|mpeg|quicktime|x-msvideo|avi|x-flv|webm|x-ms-wmv|3gpp)$/;

function extOf(name: string): string {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

function ascii(buf: Buffer, start: number, end: number): string {
  return buf.toString('latin1', start, Math.min(buf.length, end));
}

function bytesAre(buf: Buffer, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}

async function lib<T = any>(name: string): Promise<T> {
  const mod: any = await import(name);
  return mod.default && (typeof mod.default === 'object' || typeof mod.default === 'function') ? mod.default : mod;
}

async function xlsxLib(): Promise<any> {
  const mod: any = await import('xlsx');
  return mod.default?.read ? mod.default : mod;
}

async function loadZip(buf: Buffer): Promise<ZipLike> {
  const JSZip = await lib<any>('jszip');
  return (await JSZip.loadAsync(buf)) as ZipLike;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    }),
  ]).finally(() => t && clearTimeout(t)) as Promise<T>;
}

// -------------------------------------------------------------- sniffing ----

export interface Sniffed {
  kind: FormatKind;
  mime: string;
}

/** Content-based format detection (the extension is only a tie-breaker). */
export function sniff(buf: Buffer, fileName: string): Sniffed {
  const ext = extOf(fileName);
  if (!buf.length) return { kind: 'empty', mime: '' };
  const head = ascii(buf, 0, 1024);
  if (head.includes('%PDF-')) return { kind: 'pdf', mime: 'application/pdf' };
  if (bytesAre(buf, [0x50, 0x4b, 0x03, 0x04]) || bytesAre(buf, [0x50, 0x4b, 0x05, 0x06])) return { kind: 'zip', mime: 'application/zip' };
  if (bytesAre(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return { kind: 'ole', mime: 'application/x-ole-storage' };
  if (head.startsWith('{\\rtf')) return { kind: 'rtf', mime: 'application/rtf' };
  if (bytesAre(buf, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg' };
  if (bytesAre(buf, [0x89, 0x50, 0x4e, 0x47])) return { kind: 'image', mime: 'image/png' };
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return { kind: 'image', mime: 'image/gif' };
  if (head.startsWith('RIFF')) {
    const sub = ascii(buf, 8, 12);
    if (sub === 'WEBP') return { kind: 'image', mime: 'image/webp' };
    if (sub === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
    if (sub === 'AVI ') return { kind: 'video', mime: 'video/x-msvideo' };
  }
  if (head.startsWith('II*\u0000') || head.startsWith('MM\u0000*')) return { kind: 'image', mime: 'image/tiff' };
  if (head.startsWith('BM') && buf.length > 26) {
    const dib = buf.readUInt32LE(14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib)) return { kind: 'image', mime: 'image/bmp' };
  }
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { kind: 'image', mime: 'image/heic' };
    if (/^avi[fs]$/.test(brand)) return { kind: 'image', mime: 'image/avif' };
    if (/^m4[ab] $/.test(brand)) return { kind: 'audio', mime: 'audio/mp4' };
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime' };
    if (/^3g/.test(brand)) return { kind: 'video', mime: 'video/3gpp' };
    return { kind: 'video', mime: 'video/mp4' };
  }
  if (bytesAre(buf, [0x00, 0x00, 0x01, 0x00]) && ['ico', 'cur'].includes(ext)) return { kind: 'image', mime: 'image/x-icon' };
  if (bytesAre(buf, [0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20])) return { kind: 'image', mime: 'image/jp2' };
  if (head.startsWith('8BPS')) return { kind: 'image', mime: 'image/vnd.adobe.photoshop' };
  if (head.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ['mp3', 'mpga'].includes(ext))) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }
  if (head.startsWith('OggS')) return { kind: 'audio', mime: 'audio/ogg' };
  if (head.startsWith('fLaC')) return { kind: 'audio', mime: 'audio/flac' };
  if (head.startsWith('FORM') && /^AIF[FC]$/.test(ascii(buf, 8, 12))) return { kind: 'audio', mime: 'audio/aiff' };
  if (head.startsWith('#!AMR')) return { kind: 'audio', mime: 'audio/amr' };
  if (bytesAre(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'video', mime: 'video/webm' };
  if (bytesAre(buf, [0x30, 0x26, 0xb2, 0x75])) return { kind: 'video', mime: 'video/x-ms-wmv' };
  if (head.startsWith('Rar!')) return { kind: 'rar', mime: 'application/vnd.rar' };
  if (bytesAre(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: '7z', mime: 'application/x-7z-compressed' };
  if (bytesAre(buf, [0x1f, 0x8b])) return { kind: 'gzip', mime: 'application/gzip' };
  if (ascii(buf, 257, 262) === 'ustar') return { kind: 'tar', mime: 'application/x-tar' };
  if (head.startsWith('AT&TFORM')) return { kind: 'djvu', mime: 'image/vnd.djvu' };

  if (looksLikeText(buf)) {
    const sample = decodeTextBytes(buf.subarray(0, 65536));
    const t = sample.replace(/^\uFEFF/, '').trimStart().slice(0, 4000).toLowerCase();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(t)) return { kind: 'svg', mime: 'image/svg+xml' };
    if (['mht', 'mhtml'].includes(ext) || (/^mime-version:/m.test(t) && /content-type:\s*multipart\/related/.test(t))) {
      return { kind: 'mhtml', mime: 'multipart/related' };
    }
    if (ext === 'eml' || looksLikeEmail(sample)) return { kind: 'eml', mime: 'message/rfc822' };
    if (/^<!doctype html|<html[\s>]|<body[\s>]/.test(t) || ['htm', 'html', 'xhtml'].includes(ext)) return { kind: 'html', mime: 'text/html' };
    if (t.startsWith('<?xml') || ext === 'xml' || /^<[a-z][\w:-]*[\s>]/.test(t)) return { kind: 'xml', mime: 'application/xml' };
    if (/^begin:vcard/.test(t)) return { kind: 'vcf', mime: 'text/vcard' };
    if (/^[{[]/.test(t) && !['csv', 'tsv'].includes(ext)) return { kind: 'json', mime: 'application/json' };
    if (['csv', 'tsv'].includes(ext)) return { kind: 'csv', mime: 'text/csv' };
    if (['md', 'markdown'].includes(ext)) return { kind: 'markdown', mime: 'text/markdown' };
    return { kind: 'text', mime: 'text/plain' };
  }
  return { kind: 'unknown', mime: 'application/octet-stream' };
}

// ------------------------------------------------------------ extraction ----

function result(kind: FormatKind, mime: string, partial: Partial<IngestResult> = {}): IngestResult {
  const text = normalizePersianText(partial.text || '').slice(0, MAX_TEXT);
  const files = partial.files || [];
  return {
    kind,
    label: partial.label || LABELS[kind],
    mime,
    text,
    files,
    warnings: partial.warnings || [],
    unreadable: partial.unreadable ?? (text.trim().length < 20 && !files.length ? 'از این فایل متن یا تصویر قابل‌خواندنی به دست نیامد.' : null),
    ...(partial.pages ? { pages: partial.pages } : {}),
  };
}

async function pdfText(buf: Buffer): Promise<{ text: string; pages: number; encrypted?: boolean }> {
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: true,
    isEvalSupported: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const pdf = await withTimeout<any>(task.promise, 20_000, 'PDF open');
    const pageCount = Math.min(pdf.numPages, 20);
    const out: string[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const it of content.items as any[]) {
        if (typeof it?.str !== 'string' || !it.str.length || !it.transform) continue;
        items.push({ str: it.str, x: it.transform[4], y: viewport.height - it.transform[5], w: it.width || 0, h: it.height || 0 });
      }
      let pageText = items.length ? assemblePageText(items, viewport.width) : '';
      try {
        const links: string[] = [];
        for (const ann of (await page.getAnnotations()) || []) {
          const url = String(ann?.url || ann?.unsafeUrl || '');
          if (/^mailto:/i.test(url)) links.push(`ایمیل: ${url.replace(/^mailto:/i, '')}`);
          else if (/^tel:/i.test(url)) links.push(`تلفن: ${url.replace(/^tel:/i, '')}`);
          else if (/^https?:\/\//i.test(url)) links.push(`لینک: ${url}`);
        }
        if (links.length) pageText += `\n[لینک‌ها]: ${links.join(' · ')}`;
      } catch {
        /* annotations are optional */
      }
      out.push(pageText);
      page.cleanup?.();
    }
    return { text: out.join('\n\n'), pages: pdf.numPages };
  } catch (err: any) {
    if (err?.name === 'PasswordException' || /password/i.test(String(err?.message))) return { text: '', pages: 0, encrypted: true };
    throw err;
  } finally {
    try {
      await task.destroy(); // pdf.js v6: the loading task owns the document
    } catch {
      /* already gone */
    }
  }
}

async function ingestPdf(buf: Buffer): Promise<IngestResult> {
  const { text, pages, encrypted } = await pdfText(buf).catch(() => ({ text: '', pages: 0, encrypted: false }));
  if (encrypted) {
    return result('encrypted', 'application/pdf', {
      label: 'PDF رمزدار',
      unreadable: 'فایل PDF رمز عبور دارد؛ نسخه بدون رمز را بارگذاری کنید.',
    });
  }
  const q = assessText(text);
  const files: AiFile[] = buf.length <= ATTACH_BUDGET ? [{ mimeType: 'application/pdf', base64: buf.toString('base64'), fileName: 'resume.pdf' }] : [];
  const warnings: string[] = [];
  if (!files.length) warnings.push('حجم PDF برای ارسال مستقیم به هوش مصنوعی زیاد است؛ فقط متن آن تحلیل شد.');
  if (q.garbled) warnings.push('متن لایه PDF درهم بود (فونت معیوب)؛ خود فایل به هوش مصنوعی داده شد.');
  const scanned = !q.usable;
  return result('pdf', 'application/pdf', {
    label: scanned ? 'PDF اسکن‌شده' : 'PDF',
    text: q.garbled ? '' : text,
    files,
    warnings,
    pages,
    unreadable: !files.length && !q.usable && !text.trim() ? 'این PDF متن قابل‌انتخاب ندارد و برای خواندن تصویری هم بیش از حد بزرگ است.' : null,
  });
}

/** Pictures embedded in an Office file whose text layer is (nearly) empty. */
async function embeddedImages(zip: ZipLike, limit = 4): Promise<AiFile[]> {
  const entries = mediaEntries(zip);
  const loaded: Array<{ name: string; data: Buffer }> = [];
  for (const e of entries.slice(0, 12)) loaded.push({ name: e.name, data: Buffer.from(await e.async('uint8array')) });
  loaded.sort((a, b) => b.data.length - a.data.length);
  const files: AiFile[] = [];
  let budget = ATTACH_BUDGET;
  for (const img of loaded) {
    if (files.length >= limit || img.data.length < 15_000) break; // icons, logos, bullets
    const s = sniff(img.data, img.name);
    if (s.kind !== 'image') continue;
    const converted = await imageToAiFiles(img.data, s.mime, img.name).catch(() => null);
    for (const f of converted || []) {
      budget -= f.base64.length * 0.75;
      if (budget < 0) break;
      files.push(f);
    }
  }
  return files;
}

async function officeResult(kind: FormatKind, mime: string, zip: ZipLike, text: string): Promise<IngestResult> {
  const q = assessText(text);
  if (q.usable) return result(kind, mime, { text });
  const files = await embeddedImages(zip);
  return result(kind, mime, {
    text,
    files,
    warnings: files.length ? ['متن سند اندک بود؛ تصویرهای داخل فایل هم برای هوش مصنوعی فرستاده شد.'] : [],
  });
}

async function ingestSpreadsheet(buf: Buffer, kind: FormatKind, mime: string): Promise<IngestResult> {
  const XLSX = await xlsxLib();
  let wb: any;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true, sheetRows: 500 });
  } catch (err: any) {
    if (/password|encrypt/i.test(String(err?.message))) {
      return result('encrypted', mime, { unreadable: 'فایل اکسل رمز عبور دارد؛ نسخه بدون رمز را بارگذاری کنید.' });
    }
    throw err;
  }
  const parts: string[] = [];
  for (const name of wb.SheetNames.slice(0, 8)) {
    // A tab separator: SheetJS quotes/strips cells when the separator contains spaces.
    const csv: string = XLSX.utils.sheet_to_csv(wb.Sheets[name], { FS: '\t', blankrows: false, strip: true });
    const cleaned = csv
      .split('\n')
      .map((l) => l.split('\t').map((c) => c.replace(/^"(.*)"$/s, '$1').replace(/""/g, '"').trim()).filter(Boolean).join(' | '))
      .filter((l) => l.length > 0)
      .join('\n');
    if (cleaned) parts.push(wb.SheetNames.length > 1 ? `— برگه «${name}» —\n${cleaned}` : cleaned);
  }
  return result(kind, mime, { text: parts.join('\n\n') });
}

/** OLE stream names that leak into a «strings» scan of old Office files. */
const OLE_NOISE = /^(Root Entry|WordDocument|[01]Table|Data|CompObj|ObjectPool|Sh33tJ5|\W?(Document)?SummaryInformation|PowerPoint Document|Current User|Pictures|Workbook|Book|MsoDataStore|Macros|VBA)$/;

function oleStrings(buf: Buffer): string {
  return binaryStrings(new Uint8Array(buf))
    .split('\n')
    .filter((l) => !OLE_NOISE.test(l.trim()))
    .join('\n');
}

async function ingestDoc(buf: Buffer): Promise<IngestResult> {
  try {
    const WordExtractor = await lib<any>('word-extractor');
    const doc = await withTimeout<any>(new WordExtractor().extract(buf), 20_000, 'DOC');
    const pieces = [
      doc.getHeaders?.({ includeFooters: true }),
      doc.getBody?.(),
      doc.getTextboxes?.({ includeHeadersAndFooters: false, includeBody: true }),
      doc.getFootnotes?.(),
    ]
      .map((t: unknown) => (typeof t === 'string' ? t.trim() : ''))
      .filter(Boolean);
    const text = Array.from(new Set(pieces)).join('\n');
    if (assessText(text).letters >= 30) return result('doc', 'application/msword', { text });
  } catch {
    /* fall back to strings below */
  }
  const text = oleStrings(buf);
  return result('doc', 'application/msword', {
    text,
    warnings: text ? ['متن فایل Word قدیمی به‌صورت تقریبی خوانده شد؛ برای دقت بیشتر آن را با فرمت DOCX یا PDF ذخیره کنید.'] : [],
  });
}

async function ingestOle(buf: Buffer, fileName: string, depth: number): Promise<IngestResult> {
  let names: string[] = [];
  let cfb: any = null;
  try {
    const XLSX = await xlsxLib();
    cfb = XLSX.CFB.read(buf, { type: 'buffer' });
    names = (cfb.FileIndex || []).map((f: any) => String(f.name));
  } catch {
    /* unreadable container */
  }
  const ext = extOf(fileName);
  if (names.includes('EncryptedPackage') || names.includes('EncryptionInfo')) {
    return result('encrypted', 'application/x-ole-storage', { unreadable: 'سند Office رمز عبور دارد؛ نسخه بدون رمز را بارگذاری کنید.' });
  }
  if (names.includes('WordDocument') || (!names.length && ext === 'doc')) return ingestDoc(buf);
  if (names.includes('Workbook') || names.includes('Book') || (!names.length && ext === 'xls')) return ingestSpreadsheet(buf, 'xls', 'application/vnd.ms-excel');
  if (names.some((n) => n.startsWith('__substg1.0_'))) return ingestMsg(cfb, depth);
  const text = oleStrings(buf);
  const kind: FormatKind = names.includes('PowerPoint Document') || ext === 'ppt' ? 'ppt' : 'ole';
  return result(kind, 'application/x-ole-storage', {
    text,
    warnings: text ? ['متن این فایل قدیمی Office به‌صورت تقریبی خوانده شد؛ برای دقت بیشتر آن را PDF کنید.'] : [],
    unreadable: text ? null : 'متنی از این فایل قدیمی Office خوانده نشد؛ آن را با فرمت PDF یا DOCX ذخیره و دوباره بارگذاری کنید.',
  });
}

async function ingestMsg(cfb: any, depth: number): Promise<IngestResult> {
  const index: any[] = cfb.FileIndex || [];
  const paths: string[] = cfb.FullPaths || [];
  const byPath = new Map<string, any>();
  index.forEach((f, i) => byPath.set(paths[i], f));
  const str = (f: any) => {
    if (!f?.content) return '';
    const b = Buffer.from(f.content);
    return /001F$/i.test(f.name) ? b.toString('utf16le') : decodeTextBytes(new Uint8Array(b));
  };
  const top = (prop: string) => {
    for (const [p, f] of byPath) if (/^Root Entry\/[^/]+$/.test(p) && f.name === `__substg1.0_${prop}`) return f;
    return null;
  };
  const subject = str(top('0037001F') || top('0037001E'));
  let body = str(top('1000001F') || top('1000001E'));
  if (!body.trim()) {
    const html = top('10130102');
    if (html?.content) body = htmlToText(decodeTextBytes(new Uint8Array(Buffer.from(html.content))));
  }
  const attachments: Array<{ fileName: string; data: Buffer }> = [];
  for (const p of paths) {
    const m = p.match(/^(Root Entry\/__attach_version1\.0_#[0-9A-Fa-f]{8})\/?$/);
    if (!m) continue;
    const data = byPath.get(`${m[1]}/__substg1.0_37010102`);
    if (!data?.content) continue;
    const name = str(byPath.get(`${m[1]}/__substg1.0_3707001F`)) || str(byPath.get(`${m[1]}/__substg1.0_3704001F`)) || 'attachment';
    attachments.push({ fileName: name.replace(/\u0000/g, ''), data: Buffer.from(data.content) });
  }
  return mergeEmail('msg', 'application/vnd.ms-outlook', subject, '', body, attachments, depth);
}

async function mergeEmail(
  kind: FormatKind,
  mime: string,
  subject: string,
  from: string,
  body: string,
  attachments: Array<{ fileName: string; data: Buffer }>,
  depth: number
): Promise<IngestResult> {
  const sections: string[] = [];
  const head = [subject && `موضوع: ${subject}`, from && `فرستنده: ${from}`].filter(Boolean).join('\n');
  if (head || body.trim()) sections.push(`${head}\n${body.trim()}`.trim());
  const files: AiFile[] = [];
  const warnings: string[] = [];
  let used = 0;
  for (const a of attachments.slice(0, 8)) {
    if (/\.(p7s|asc|ics|sig)$/i.test(a.fileName)) continue;
    const s = sniff(a.data, a.fileName);
    if (s.kind === 'image' && a.data.length < 12_000) continue; // signatures, logos
    const inner = await ingestDocument(a.data, a.fileName, depth + 1);
    if (inner.text.trim()) sections.push(`— پیوست: ${a.fileName} (${inner.label}) —\n${inner.text}`);
    for (const f of inner.files) {
      used += f.base64.length * 0.75;
      if (used > ATTACH_BUDGET) break;
      files.push(f);
    }
    warnings.push(...inner.warnings);
  }
  if (attachments.length) warnings.unshift(`${attachments.length.toLocaleString('fa-IR')} پیوست ایمیل هم خوانده شد.`);
  return result(kind, mime, { text: sections.join('\n\n'), files, warnings });
}

const JUNK_ENTRY = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)|(^|\/)\._/i;

function entryPriority(name: string): number {
  const n = name.toLowerCase();
  let p = 0;
  if (/resume|cv|رزومه|سوابق/.test(n)) p -= 10;
  const ext = extOf(n);
  if (['pdf', 'docx', 'doc', 'odt', 'rtf'].includes(ext)) p -= 5;
  else if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'tif', 'tiff'].includes(ext)) p -= 1;
  return p;
}

async function ingestEntries(kind: FormatKind, mime: string, entries: Array<{ name: string; data: Buffer }>, depth: number): Promise<IngestResult> {
  const usable = entries.filter((e) => e.data.length > 0 && !JUNK_ENTRY.test(e.name)).sort((a, b) => entryPriority(a.name) - entryPriority(b.name));
  if (!usable.length) return result(kind, mime, { unreadable: 'فایل فشرده خالی است.' });
  const sections: string[] = [];
  const files: AiFile[] = [];
  const warnings: string[] = [];
  let used = 0;
  for (const e of usable.slice(0, 6)) {
    const inner = await ingestDocument(e.data, e.name, depth + 1);
    const short = e.name.split('/').pop() || e.name;
    if (inner.text.trim()) sections.push(`— فایل: ${short} (${inner.label}) —\n${inner.text}`);
    for (const f of inner.files) {
      used += f.base64.length * 0.75;
      if (used > ATTACH_BUDGET || files.length >= 8) break;
      files.push(f);
    }
    warnings.push(...inner.warnings);
  }
  warnings.unshift(
    usable.length > 6
      ? `از ${usable.length.toLocaleString('fa-IR')} فایل داخل بسته، ۶ فایل مرتبط‌تر خوانده شد.`
      : `${usable.length.toLocaleString('fa-IR')} فایل داخل بسته خوانده شد.`
  );
  return result(kind, mime, { text: sections.join('\n\n'), files, warnings });
}

function parseTar(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = [];
  let off = 0;
  while (off + 512 <= buf.length && out.length < 200) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const size = parseInt(buf.toString('latin1', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8) || 0;
    const type = String.fromCharCode(buf[off + 156] || 48);
    const prefix = buf.toString('utf8', off + 345, off + 500).replace(/\0.*$/s, '');
    if (type === '0' || type === '\0') out.push({ name: prefix ? `${prefix}/${name}` : name, data: buf.subarray(off + 512, off + 512 + size) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function ingestZip(buf: Buffer, fileName: string, depth: number): Promise<IngestResult> {
  const zip = await loadZip(buf);
  const names = Object.keys(zip.files);
  const has = (p: string) => names.includes(p);
  const mimetype = has('mimetype') ? (await zip.file('mimetype')!.async('string')).trim() : '';
  if (has('word/document.xml')) {
    let text = await docxText(zip);
    if (assessText(text).letters < 20) {
      try {
        const mammoth = await lib<any>('mammoth');
        text = (await mammoth.extractRawText({ buffer: buf })).value || text;
      } catch {
        /* keep what we have */
      }
    }
    return officeResult('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip, text);
  }
  if (has('ppt/presentation.xml')) return officeResult('pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip, await pptxText(zip));
  if (has('xl/workbook.xml')) {
    const r = await ingestSpreadsheet(buf, 'xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (assessText(r.text).usable) return r;
    return officeResult('xlsx', r.mime, zip, r.text);
  }
  if (/opendocument\.text/.test(mimetype)) return officeResult('odt', mimetype, zip, await odfText(zip));
  if (/opendocument\.spreadsheet/.test(mimetype)) return ingestSpreadsheet(buf, 'ods', mimetype);
  if (/opendocument\.presentation/.test(mimetype)) return officeResult('odp', mimetype, zip, await odfText(zip));
  if (mimetype === 'application/epub+zip') return result('epub', mimetype, { text: await epubText(zip) });
  if (names.some((n) => /\.fpage$/i.test(n))) return result('xps', 'application/oxps', { text: await xpsText(zip) });
  const preview = names.find((n) => /^QuickLook\/Preview\.pdf$/i.test(n));
  const thumb = names.find((n) => /^(preview(-web)?\.jpg|QuickLook\/Thumbnail\.jpg)$/i.test(n));
  if (has('Index/Document.iwa') || preview || (thumb && names.some((n) => n.startsWith('Index/')))) {
    if (preview) {
      const inner = await ingestPdf(Buffer.from(await zip.file(preview)!.async('uint8array')));
      return { ...inner, kind: 'iwork', label: LABELS.iwork, warnings: ['پیش‌نمایش PDF داخل فایل Apple خوانده شد.', ...inner.warnings] };
    }
    if (thumb) {
      const data = Buffer.from(await zip.file(thumb)!.async('uint8array'));
      return result('iwork', 'application/x-iwork', {
        files: (await imageToAiFiles(data, 'image/jpeg', 'preview.jpg')) || [],
        warnings: ['فقط تصویر پیش‌نمایش فایل Apple در دسترس بود؛ برای دقت کامل خروجی PDF بفرستید.'],
      });
    }
    return result('iwork', 'application/x-iwork', { unreadable: 'فایل Pages/Keynote پیش‌نمایش ندارد؛ از آن خروجی PDF بگیرید و دوباره بارگذاری کنید.' });
  }
  const entries: Array<{ name: string; data: Buffer }> = [];
  for (const n of names) {
    const f = zip.files[n];
    if (f.dir || JUNK_ENTRY.test(n)) continue;
    entries.push({ name: n, data: Buffer.from(await f.async('uint8array')) });
    if (entries.length >= 40) break;
  }
  return ingestEntries('zip', 'application/zip', entries, depth);
}

function ingestXml(xml: string): IngestResult {
  if (/<w:wordDocument|<pkg:package|<w:document[\s>]/.test(xml)) return result('docx', 'application/xml', { label: 'Word XML', text: wordXmlToText(xml) });
  if (/<office:document[\s>]/.test(xml)) return result('odt', 'application/xml', { label: 'OpenDocument XML', text: odfXmlToText(xml) });
  // Generic XML (e.g. Europass): element text, one per line.
  const text = xml
    .replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<\/[^>]+>/g, '\n')
    .replace(/<[^>]+>/g, ' ');
  return result('xml', 'application/xml', { text: htmlToText(text) });
}

/**
 * Reads any file. Never throws: failures come back as `unreadable` with a
 * Persian reason (and whatever partial text could be salvaged).
 */
export async function ingestDocument(buf: Buffer, fileName: string, depth = 0): Promise<IngestResult> {
  const s = sniff(buf, fileName);
  const ext = extOf(fileName);
  try {
    if (depth > MAX_DEPTH) return result(s.kind, s.mime, { unreadable: 'فایل‌های تودرتو بیش از حد عمیق بودند.' });
    switch (s.kind) {
      case 'empty':
        return result('empty', '', { unreadable: 'فایل خالی است (حجم صفر بایت).' });
      case 'pdf':
        return await ingestPdf(buf);
      case 'zip':
        return await ingestZip(buf, fileName, depth);
      case 'ole':
        return await ingestOle(buf, fileName, depth);
      case 'rtf':
        return result('rtf', s.mime, { text: rtfToText(buf.toString('latin1')) });
      case 'image': {
        const label = `تصویر ${s.mime.split('/')[1].replace('x-icon', 'ICO').replace('vnd.adobe.photoshop', 'PSD').toUpperCase()}`;
        const files = await imageToAiFiles(buf, s.mime, fileName).catch(() => null);
        if (files?.length) return result('image', s.mime, { label, files });
        return result('image', s.mime, {
          label,
          unreadable: `قالب تصویر «${label.replace('تصویر ', '')}» روی سرور خوانده نمی‌شود؛ آن را به JPG یا PNG تبدیل کنید (اسکرین‌شات یا «ذخیره به‌عنوان» کافی است).`,
        });
      }
      case 'audio':
      case 'video': {
        const ok = (s.kind === 'audio' ? GEMINI_AUDIO : GEMINI_VIDEO).test(s.mime) && buf.length <= ATTACH_BUDGET;
        if (!ok) {
          return result(s.kind, s.mime, {
            unreadable:
              buf.length > ATTACH_BUDGET
                ? `حجم رزومه ${s.kind === 'audio' ? 'صوتی' : 'ویدیویی'} بیش از ۱۸ مگابایت است؛ نسخه کوتاه‌تر یا فشرده‌تر بفرستید.`
                : `این قالب ${s.kind === 'audio' ? 'صوتی' : 'ویدیویی'} (${s.mime}) پشتیبانی نمی‌شود؛ آن را به MP3 یا MP4 تبدیل کنید.`,
          });
        }
        return result(s.kind, s.mime, {
          files: [{ mimeType: s.mime, base64: buf.toString('base64'), fileName }],
          warnings: ['رزومه صوتی/ویدیویی فقط با کلید Gemini قابل تحلیل است.'],
        });
      }
      case 'gzip': {
        const inner = zlib.gunzipSync(buf, { maxOutputLength: 80 * 1024 * 1024 });
        const innerName = fileName.replace(/\.(t?gz|gzip)$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : '')) || 'file';
        const r = await ingestDocument(inner, innerName, depth + 1);
        return { ...r, warnings: ['فایل فشرده GZip باز شد.', ...r.warnings] };
      }
      case 'tar':
        return await ingestEntries('tar', s.mime, parseTar(buf), depth);
      case 'rar':
      case '7z':
        return result(s.kind, s.mime, {
          unreadable: `فایل فشرده ${s.kind.toUpperCase()} پشتیبانی نمی‌شود؛ آن را به ZIP تبدیل کنید یا فایل‌های داخلش را جداگانه بفرستید.`,
        });
      case 'html':
        return result('html', s.mime, { text: htmlToText(decodeTextBytes(new Uint8Array(buf))) });
      case 'mhtml': {
        const m = parseMime(buf);
        return result('mhtml', s.mime, { text: [m.html ? htmlToText(m.html) : '', m.text].filter(Boolean).join('\n') });
      }
      case 'eml': {
        const m = parseMime(buf);
        const body = m.text.trim() ? m.text : htmlToText(m.html);
        return await mergeEmail('eml', s.mime, m.subject, m.from, body, m.attachments, depth);
      }
      case 'xml':
        return ingestXml(decodeTextBytes(new Uint8Array(buf)));
      case 'svg': {
        const text = htmlToText(
          decodeTextBytes(new Uint8Array(buf))
            .replace(/<\/?svg\b[^>]*>/gi, '\n') // htmlToText drops whole <svg> elements
            .replace(/<\/(text|tspan)>/gi, '\n')
        );
        return result('svg', s.mime, {
          text,
          unreadable: assessText(text).letters < 30 ? 'فایل SVG متن قابل‌خواندنی ندارد؛ آن را به PNG یا PDF تبدیل کنید.' : null,
        });
      }
      case 'json': {
        const raw = decodeTextBytes(new Uint8Array(buf));
        try {
          return result('json', s.mime, { text: jsonToText(JSON.parse(raw)) });
        } catch {
          return result('text', 'text/plain', { text: raw });
        }
      }
      case 'vcf':
      case 'csv':
      case 'markdown':
      case 'text':
        return result(s.kind, s.mime, { text: decodeTextBytes(new Uint8Array(buf)) });
      case 'djvu':
      case 'unknown':
      default: {
        const text = binaryStrings(new Uint8Array(buf));
        const q = assessText(text);
        if (q.letters >= 80) {
          return result(s.kind, s.mime, {
            label: ext ? `${LABELS[s.kind]} (.${ext})` : LABELS[s.kind],
            text,
            warnings: ['قالب فایل شناخته نشد؛ متن آن به‌صورت تقریبی بیرون کشیده شد.'],
          });
        }
        return result(s.kind, s.mime, {
          label: ext ? `${LABELS[s.kind]} (.${ext})` : LABELS[s.kind],
          unreadable: `قالب این فایل${ext ? ` («.${ext}»)` : ''} شناخته نشد و متنی از آن خوانده نشد؛ لطفاً آن را به PDF، Word یا تصویر تبدیل کنید.`,
        });
      }
    }
  } catch (err: any) {
    // Corrupt or truncated file: salvage readable strings if any.
    const text = s.kind === 'image' || s.kind === 'audio' || s.kind === 'video' ? '' : binaryStrings(new Uint8Array(buf));
    const q = assessText(text);
    return result(s.kind, s.mime, {
      text: q.letters >= 80 ? text : '',
      warnings: q.letters >= 80 ? ['فایل آسیب‌دیده بود؛ بخشی از متن آن بازیابی شد.'] : [],
      unreadable: q.letters >= 80 ? null : `فایل آسیب‌دیده است یا باز نشد (${LABELS[s.kind]})؛ نسخه سالم یا PDF آن را بارگذاری کنید.`,
    });
  }
}

const EXT_KIND: Record<string, FormatKind> = {
  pdf: 'pdf', docx: 'docx', doc: 'doc', odt: 'odt', rtf: 'rtf', pptx: 'pptx', ppt: 'ppt', odp: 'odp',
  xlsx: 'xlsx', xls: 'xls', ods: 'ods', csv: 'csv', epub: 'epub', html: 'html', htm: 'html', txt: 'text',
  md: 'markdown', json: 'json', xml: 'xml', eml: 'eml', msg: 'msg', vcf: 'vcf', zip: 'zip',
};

/** Persian format label from the file name alone (when the browser already extracted the text). */
export function labelForFileName(fileName: string): string | null {
  const kind = EXT_KIND[extOf(fileName)];
  return kind ? LABELS[kind] : null;
}

/** Formats whose text the browser already extracts well (no server pass needed). */
export function clientExtractsWell(fileName: string): boolean {
  return ['pdf', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(extOf(fileName));
}

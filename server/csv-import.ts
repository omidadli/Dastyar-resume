/**
 * «ورود پروفایل از فایل» — LinkedIn Recruiter (and any other export) as CSV.
 *
 * Why this exists: not every organization has a contracted people-search API.
 * A recruiter with a LinkedIn Recruiter seat can export the people they found
 * (or copy the table) and bring them into HOVIDA the same way an API result is
 * brought in: same screening engine, same duplicate detection, same provenance.
 * No key, no scraping, nothing leaves the server.
 *
 * The parser is deliberately dependency-free and forgiving:
 *   • comma, semicolon and tab separators (Excel in fa-IR writes «;»)
 *   • quoted fields with "" escapes and embedded newlines
 *   • a UTF-8 BOM, CRLF or LF line endings
 *   • Persian and English header names, in any order
 * Columns that are missing are simply left empty — a name plus one useful column
 * is already enough to screen someone.
 */
import type { SourcingProfile } from '../src/types/integrations';

export interface CsvColumnMap {
  fullName: number | null;
  firstName: number | null;
  lastName: number | null;
  headline: number | null;
  location: number | null;
  profileUrl: number | null;
  currentCompany: number | null;
  currentTitle: number | null;
  openToWork: number | null;
  skills: number | null;
  education: number | null;
  email: number | null;
  notes: number | null;
}

export interface CsvParseResult {
  /** Header cells as they appear in the file. */
  headers: string[];
  /** Where each field was found (null = not in this file). */
  mapping: CsvColumnMap;
  /** Field names that were recognised, in Persian, for the preview. */
  recognised: string[];
  rows: string[][];
  separator: string;
  /** Non-fatal problems: a row without a name, a column that looked truncated… */
  warnings: string[];
}

export interface CsvProfilesResult {
  profiles: SourcingProfile[];
  headers: string[];
  separator: string;
  recognised: string[];
  /** How many data rows the file had (before anything was dropped). */
  totalRows: number;
  /** Rows that had no usable name. */
  skippedRows: number;
  /** The file reports «open to work» for some people, so filtering is honest. */
  hasOpenToWorkColumn: boolean;
  warnings: string[];
}

/** Candidate header spellings → our field. Order matters only for tie-breaks. */
const HEADER_ALIASES: Record<keyof CsvColumnMap, string[]> = {
  fullName: ['full name', 'name', 'نام و نام خانوادگی', 'نام کامل', 'نام'],
  firstName: ['first name', 'firstname', 'given name', 'نام کوچک', 'نام'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'نام خانوادگی', 'فامیل'],
  headline: ['headline', 'title', 'job title', 'current title', 'position', 'عنوان', 'عنوان شغلی', 'سِمَت', 'سمت'],
  location: ['location', 'geo', 'city', 'country', 'region', 'شهر', 'موقعیت مکانی', 'مکان'],
  profileUrl: ['profile url', 'linkedin url', 'url', 'profile', 'link', 'لینک', 'لینک پروفایل', 'آدرس پروفایل'],
  currentCompany: ['current company', 'company', 'company name', 'employer', 'شرکت', 'شرکت فعلی', 'نام شرکت'],
  currentTitle: ['current title', 'current position', 'position', 'role', 'نقش', 'عنوان فعلی'],
  openToWork: ['open to work', 'open to work?', 'opentowork', 'actively looking', 'آماده همکاری', 'آمادهٔ همکاری', 'وضعیت همکاری', 'در جست‌وجوی کار'],
  skills: ['skills', 'top skills', 'مهارت‌ها', 'مهارت'],
  education: ['education', 'school', 'degree', 'تحصیلات', 'مدرک'],
  email: ['email', 'e-mail', 'email address', 'ایمیل', 'رایانامه'],
  notes: ['notes', 'summary', 'about', 'description', 'یادداشت', 'خلاصه', 'درباره'],
};

function normaliseHeader(cell: string): string {
  return String(cell || '')
    .replace(/\uFEFF/g, '')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[«»"'()؛:?؟]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Picks the most specific alias that matches a header cell. */
function matchHeader(cell: string): keyof CsvColumnMap | null {
  const h = normaliseHeader(cell);
  if (!h) return null;
  let best: { key: keyof CsvColumnMap; score: number } | null = null;
  for (const [key, aliases] of Object.entries(HEADER_ALIASES) as Array<[keyof CsvColumnMap, string[]]>) {
    for (const alias of aliases) {
      const a = normaliseHeader(alias);
      // Exact match wins over a containment match («current title» vs «title»).
      const score = h === a ? 100 + a.length : h.includes(a) ? a.length : 0;
      if (score > 0 && (!best || score > best.score)) best = { key, score };
    }
  }
  return best?.key ?? null;
}

/** Guesses the separator from the header line (outside quotes). */
function detectSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/)[0] || '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ',';
}

/** RFC 4180 parser: quotes, "" escapes, embedded newlines, CRLF/LF. */
export function parseCsv(text: string, separator?: string): { rows: string[][]; separator: string } {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  const sep = separator || detectSeparator(raw);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === sep) {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop completely empty trailing rows (trailing newline).
  return { rows: rows.filter((r) => r.some((c) => c.trim() !== '')), separator: sep };
}

/**
 * Reads a file: headers, where each field is, and the data rows. A file without
 * a recognisable header row is still read positionally, with a warning.
 */
export function readCsv(text: string, separator?: string): CsvParseResult {
  const { rows, separator: sep } = parseCsv(text, separator);
  const warnings: string[] = [];
  if (!rows.length) {
    return { headers: [], mapping: emptyMapping(), recognised: [], rows: [], separator: sep, warnings: ['فایل خالی است.'] };
  }

  const first = rows[0];
  const mapping = emptyMapping();
  const taken = new Set<keyof CsvColumnMap>();
  first.forEach((cell, index) => {
    const key = matchHeader(cell);
    if (!key || taken.has(key) || mapping[key] !== null) return;
    // «Current title» and «title» both map to headline-ish fields: keep the first.
    mapping[key] = index;
    taken.add(key);
  });

  const hasHeader = Object.values(mapping).some((v) => v !== null);
  if (!hasHeader) {
    warnings.push('ردیف عنوان ستون‌ها شناخته نشد؛ ستون اول «نام» و ستون دوم «عنوان شغلی» فرض شد.');
    mapping.fullName = 0;
    if (first.length > 1) mapping.headline = 1;
    if (first.length > 2) mapping.location = 2;
    if (first.length > 3) mapping.currentCompany = 3;
    return { headers: [], mapping, recognised: recognisedFields(mapping), rows, separator: sep, warnings };
  }

  // «Name» and «First name» both matched `fullName`/`firstName`: prefer the split
  // pair when both halves exist, because it is unambiguous.
  if (mapping.firstName !== null && mapping.lastName !== null) mapping.fullName = null;

  const dataRows = rows.slice(1);
  if (!dataRows.length) warnings.push('فایل هیچ ردیف داده‌ای ندارد.');
  return { headers: first, mapping, recognised: recognisedFields(mapping), rows: dataRows, separator: sep, warnings };
}

function emptyMapping(): CsvColumnMap {
  return {
    fullName: null,
    firstName: null,
    lastName: null,
    headline: null,
    location: null,
    profileUrl: null,
    currentCompany: null,
    currentTitle: null,
    openToWork: null,
    skills: null,
    education: null,
    email: null,
    notes: null,
  };
}

const FIELD_LABEL: Record<keyof CsvColumnMap, string> = {
  fullName: 'نام',
  firstName: 'نام کوچک',
  lastName: 'نام خانوادگی',
  headline: 'عنوان/سِمَت',
  location: 'شهر',
  profileUrl: 'لینک پروفایل',
  currentCompany: 'شرکت',
  currentTitle: 'عنوان فعلی',
  openToWork: 'وضعیت همکاری',
  skills: 'مهارت‌ها',
  education: 'تحصیلات',
  email: 'ایمیل',
  notes: 'خلاصه',
};

function recognisedFields(mapping: CsvColumnMap): string[] {
  return (Object.keys(mapping) as Array<keyof CsvColumnMap>)
    .filter((key) => mapping[key] !== null)
    .map((key) => FIELD_LABEL[key]);
}

/** yes / true / «بله» / «آماده همکاری» … → true; empty → null (unknown). */
export function parseOpenToWork(cell: string): boolean | null {
  const v = normaliseHeader(cell);
  if (!v) return null;
  if (/^(yes|y|true|1|بله|آری|دارد)$/.test(v)) return true;
  if (/^(no|n|false|0|خیر|نه|ندارد)$/.test(v)) return false;
  if (/open|آماده|جست‌وجو|جستجو|looking|actively/.test(v)) return true;
  if (/closed|not|غیر|نمی/.test(v)) return false;
  return null;
}

function clean(value: unknown, max = 400): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function splitList(cell: string): string[] {
  return String(cell || '')
    .split(/[،,;|·•\n]/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function cellAt(row: string[], index: number | null): string {
  return index === null ? '' : String(row[index] ?? '');
}

/**
 * Turns rows into the same profile shape a provider returns, so everything
 * downstream (screening, duplicate detection, provenance) is unchanged.
 */
export function profilesFromCsv(text: string, separator?: string): CsvProfilesResult {
  const parsed = readCsv(text, separator);
  const { mapping } = parsed;
  const warnings = [...parsed.warnings];
  const seen = new Set<string>();
  const profiles: SourcingProfile[] = [];
  let skipped = 0;

  parsed.rows.forEach((row, index) => {
    const first = clean(cellAt(row, mapping.firstName), 80);
    const last = clean(cellAt(row, mapping.lastName), 80);
    const single = clean(cellAt(row, mapping.fullName), 120);
    const fullName = (single || [first, last].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
    if (!fullName || fullName.length < 2) {
      skipped += 1;
      return;
    }
    const profileUrl = clean(cellAt(row, mapping.profileUrl), 400);
    const key = profileUrl ? profileUrl.toLowerCase() : fullName.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`«${fullName}» در فایل تکرار شده بود و یک‌بار شمرده شد.`);
      return;
    }
    seen.add(key);

    const title = clean(cellAt(row, mapping.currentTitle), 160);
    const headline = clean(cellAt(row, mapping.headline), 300) || title;
    const company = clean(cellAt(row, mapping.currentCompany), 160);
    const reported = mapping.openToWork === null ? null : parseOpenToWork(cellAt(row, mapping.openToWork));
    const emailRaw = clean(cellAt(row, mapping.email), 200);
    const emailCell = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailRaw) ? emailRaw : '';
    const notesCell = clean(cellAt(row, mapping.notes), 600);

    profiles.push({
      // Position-based and stable: the same file always produces the same ids.
      id: `csv-${index + 1}`,
      fullName,
      headline,
      location: clean(cellAt(row, mapping.location), 160),
      profileUrl,
      // Only what the file says; an absent/ambiguous cell stays «نامشخص» (false here).
      openToWork: reported === true,
      currentCompany: company || null,
      experiences: (title || company)
        ? [{ title: title || (headline ? headline : ''), company, period: '', description: '' }]
        : [],
      education: splitList(cellAt(row, mapping.education)).filter((e) => e !== '—'),
      skills: splitList(cellAt(row, mapping.skills)),
      // Kept on the profile: the e-mail is used by the invitation flow and the
      // notes are read by the screening engine, exactly like a provider field.
      email: emailCell || null,
      notes: notesCell || null,
    });
  });

  if (!profiles.length) {
    warnings.push('هیچ ردیف قابل‌استفاده‌ای پیدا نشد؛ مطمئن شوید ستون «نام» در فایل هست.');
  }
  return {
    profiles,
    headers: parsed.headers,
    separator: parsed.separator,
    recognised: parsed.recognised,
    totalRows: parsed.rows.length,
    skippedRows: skipped,
    hasOpenToWorkColumn: mapping.openToWork !== null,
    warnings: Array.from(new Set(warnings)),
  };
}

/** «از ۱۲ ردیف فایل، ۱۰ پروفایل ساخته شد؛ ۲ ردیف نام نداشت.» */
export function csvSummary(result: CsvProfilesResult, kept: number, filteredOut: number, openToWorkOnly: boolean): string {
  const fa = (n: number) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const parts = [`از ${fa(result.totalRows)} ردیف فایل، ${fa(result.profiles.length)} پروفایل خوانده شد`];
  if (result.skippedRows > 0) parts.push(`${fa(result.skippedRows)} ردیف نام نداشت و کنار گذاشته شد`);
  if (!result.hasOpenToWorkColumn) {
    parts.push('ستون «آمادهٔ همکاری» در فایل نبود، بنابراین وضعیت همه «نامشخص» است و فیلتر اعمال نشد');
  } else if (openToWorkOnly && filteredOut > 0) {
    parts.push(`${fa(filteredOut)} نفر در فایل «آمادهٔ همکاری» نبودند و نمایش داده نشدند`);
  }
  return `${parts.join('؛ ')}. ${fa(kept)} پروفایل برای بررسی آماده است.`;
}

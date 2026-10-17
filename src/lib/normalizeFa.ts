/**
 * Normalization utilities for Persian language text and numerals.
 */

// Convert Persian and Arabic digits to English digits (for internal matching/parsing)
export function toEnglishDigits(str: string): string {
  if (!str) return '';
  const fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  const ar = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  let res = str;
  for (let i = 0; i < 10; i++) {
    res = res.replaceAll(fa[i], i.toString()).replaceAll(ar[i], i.toString());
  }
  return res;
}

// Convert English digits to Persian digits for display
export function toPersianDigits(num: number | string | null | undefined): string {
  if (num === null || num === undefined) return '';
  const str = num.toString();
  const fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  return str.replace(/\d/g, (d) => fa[parseInt(d, 10)]);
}

// Format file size in readable Persian format («۱۲٫۵ کیلوبایت» — Persian decimal separator)
export function formatFileSize(bytes: number): string {
  const fa = (n: number) => n.toLocaleString('fa-IR', { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${fa(bytes)} بایت`;
  if (bytes < 1024 * 1024) return `${fa(bytes / 1024)} کیلوبایت`;
  return `${fa(bytes / (1024 * 1024))} مگابایت`;
}

// Normalize Persian text: Arabic letters to Persian, zero-width spaces, multiple spaces
export function normalizePersianText(raw: string): string {
  if (!raw) return '';

  const nfkc = raw.normalize('NFKC');
  return nfkc
    // Byte-order marks are file artefacts, not text
    .replace(/\uFEFF/g, '')
    // Windows / old-Mac line breaks
    .replace(/\r\n?/g, '\n')
    // Arabic Yeh and Alef Maksura to Persian Ye
    .replace(/[\u064A\u0649]/g, 'ی')
    // Arabic Kaf to Persian Ke
    .replace(/\u0643/g, 'ک')
    // Heh with Yeh above (ۀ) to Heh + Hamza above (هٔ)
    .replace(/\u06C0/g, 'هٔ')
    // Remove tatweel (kashida)
    .replace(/\u0640/g, '')
    // Zero-width space works as a half-space in Persian documents (ZWJ is left alone)
    .replace(/\u200B/g, '\u200C')
    // One half-space is enough, and none next to a real space
    .replace(/\u200C{2,}/g, '\u200C')
    .replace(/[ \t]*\u200C[ \t]+|[ \t]+\u200C/g, ' ')
    // Collapse repeated whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/ \n/g, '\n')
    // Collapse repeated newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Search-grade normalisation for Persian/English text: Arabic ي/ك/ى/ة → Persian,
 * diacritics and tatweel removed, every digit system → ASCII, ZWNJ → space,
 * lower-case. Use with `matchesSearch` so «رزومه‌ها», «رزومه ها» and
 * «رزومهها» all find each other.
 */
export function normalizeForSearch(raw: string | null | undefined): string {
  if (!raw) return '';
  return toEnglishDigits(String(raw).normalize('NFKC'))
    .replace(/[\u064A\u0649\u06CC]/g, 'ی')
    .replace(/\u0643/g, 'ک')
    // ة and the other heh letters (ۀ, ہ, ە) search as ه, so «برنامۀ» finds «برنامه»
    .replace(/[\u0629\u06C0\u06C1\u06D5]/g, 'ه')
    .replace(/[\u0622\u0623\u0625\u0671]/g, 'ا')
    .replace(/\u0624/g, 'و')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when every word of `query` appears in the haystack (space-insensitive). */
export function matchesSearch(haystack: Array<string | null | undefined>, query: string): boolean {
  const q = normalizeForSearch(query);
  if (!q) return true;
  const hay = normalizeForSearch(haystack.filter(Boolean).join(' '));
  const hayTight = hay.replace(/\s+/g, '');
  return q.split(' ').every((word) => hay.includes(word) || hayTight.includes(word));
}

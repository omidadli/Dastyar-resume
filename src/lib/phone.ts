import { toEnglishDigits } from './normalizeFa';

/** Normalize an Iranian mobile number to the wa.me format 989xxxxxxxxx. */
export function normalizeIranMobile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = toEnglishDigits(raw).replace(/[^\d]/g, '');
  // Common patterns: 09xxxxxxxxx, 989xxxxxxxxx, 00989xxxxxxxxx, 9xxxxxxxxx
  const m = s.match(/(?:0098|98|0)?(9\d{9})$/);
  if (m) return '98' + m[1];
  return null;
}

export function whatsappLink(raw: string | null | undefined, text?: string): string | null {
  const n = normalizeIranMobile(raw);
  if (!n) return null;
  const t = text ? `?text=${encodeURIComponent(text)}` : '';
  return `https://wa.me/${n}${t}`;
}

export function smsLink(raw: string | null | undefined, body?: string): string | null {
  if (!raw) return null;
  const n = normalizeIranMobile(raw);
  if (!n) return null;
  const b = body ? `?&body=${encodeURIComponent(body)}` : '';
  return `sms:${n.startsWith('98') ? '0' + n.slice(2) : n}${b}`;
}

/**
 * mailto: needs %20 for spaces (RFC 6068) — URLSearchParams writes «+», which
 * Outlook, Gmail and Apple Mail show literally — and CRLF line breaks.
 */
export function mailLink(email: string | null | undefined, subject?: string, body?: string): string | null {
  const to = (email || '').trim();
  if (!to || /\s/.test(to)) return null;
  const enc = (v: string) => encodeURIComponent(v.replace(/\r?\n/g, '\r\n'));
  const params = [subject ? `subject=${enc(subject)}` : '', body ? `body=${enc(body)}` : ''].filter(Boolean).join('&');
  return `mailto:${to}${params ? `?${params}` : ''}`;
}

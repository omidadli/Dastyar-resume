import { toPersianDigits } from './normalizeFa';
import { JALALI_MONTH_NAMES, gregorianToJalali } from '../utils/jalali';

export { toPersianDigits };

/** 1234 → «۱٬۲۳۴» */
export function faNumber(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('fa-IR', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function faPercent(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${toPersianDigits(Math.round(n))}٪`;
}

/** Jalali date of an ISO instant in Tehran, e.g. «۱۲ مهر ۱۴۰۵». */
export function faDate(iso: string | null | undefined, withYear = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const j = gregorianToJalali(Number(parts.year), Number(parts.month), Number(parts.day));
  return `${toPersianDigits(j.day)} ${JALALI_MONTH_NAMES[j.month - 1]}${withYear ? ` ${toPersianDigits(j.year)}` : ''}`;
}

/** «همین حالا» / «۵ دقیقه پیش» / «دیروز» / «۳ روز پیش» / date. */
export function faRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (isNaN(t)) return '—';
  const diff = Math.max(0, Date.now() - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'همین حالا';
  if (min < 60) return `${toPersianDigits(min)} دقیقه پیش`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${toPersianDigits(hours)} ساعت پیش`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'دیروز';
  if (days < 7) return `${toPersianDigits(days)} روز پیش`;
  if (days < 30) return `${toPersianDigits(Math.floor(days / 7))} هفته پیش`;
  return faDate(iso);
}

export function faDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `${toPersianDigits(Math.max(1, Math.round(seconds)))} ثانیه`;
  const m = Math.round(seconds / 60);
  return `${toPersianDigits(m)} دقیقه`;
}

export function initials(name: string | null | undefined): string {
  const clean = (name || '').replace(/[._\-()[\]0-9]+/g, ' ').trim();
  if (!clean) return '؟';
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return `${parts[0][0]}${parts[parts.length - 1][0]}`;
}

export function greeting(now = new Date()): string {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', hour12: false }).format(now));
  if (h >= 5 && h < 12) return 'صبح بخیر';
  if (h >= 12 && h < 17) return 'روز بخیر';
  if (h >= 17 && h < 21) return 'عصر بخیر';
  return 'شب بخیر';
}

export function plural(n: number, noun: string): string {
  return `${faNumber(n)} ${noun}`;
}

/** Candidate display name with an honest fallback to the file name. */
export function candidateName(r: { candidateName: string | null; fileName: string }): string {
  return r.candidateName || r.fileName.replace(/\.[a-z0-9]+$/i, '');
}

/** ASCII Jalali date (YYYY/MM/DD) for N days before today in Tehran — for API filters. */
export function jalaliDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const j = gregorianToJalali(Number(parts.year), Number(parts.month), Number(parts.day));
  return `${j.year}/${String(j.month).padStart(2, '0')}/${String(j.day).padStart(2, '0')}`;
}

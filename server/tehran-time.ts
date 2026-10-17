/**
 * Asia/Tehran wall-clock helper.
 * The server may run in any timezone (Render runs UTC, 3.5h behind Tehran);
 * every Jalali stamp (resume received, message sent), Jalali "today" and the
 * date filters of lists and reports must follow Iranian local time, not the
 * host clock.
 */
import { JalaliDate, formatJalaliDate, gregorianToJalali, toPersianDigits } from '../src/utils/jalali';

export interface TehranNow {
  jalali: JalaliDate;
  /** Canonical Persian-digit Jalali string, e.g. ۱۴۰۵/۰۶/۱۷ */
  jalaliString: string;
  /** HH:MM in Persian digits (Tehran wall clock). */
  timeStr: string;
  /** Minutes since Tehran midnight (for shift delay/overtime math). */
  minutes: number;
  /** Date object carrying Tehran wall-clock values in local fields. */
  date: Date;
}

export function tehranNow(): TehranNow {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
  const hourRaw = Number(parts.hour); // en-GB may emit "24" at midnight
  const hour = hourRaw === 24 ? 0 : hourRaw;
  const minute = Number(parts.minute);
  const date = new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), hour, minute);
  const jalali = gregorianToJalali(date.getFullYear(), date.getMonth() + 1, date.getDate());
  return {
    jalali,
    jalaliString: formatJalaliDate(jalali, true),
    timeStr: toPersianDigits(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`),
    minutes: hour * 60 + minute,
    date,
  };
}

const DAY_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Tehran calendar day of an instant, as a local-fields Date at midnight. */
export function tehranWallDate(d: Date): Date {
  const parts: Record<string, string> = {};
  for (const p of DAY_FMT.formatToParts(d)) parts[p.type] = p.value;
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

/** Jalali date of an instant in Tehran (not in the host's timezone). */
export function tehranJalaliOf(d: Date): JalaliDate {
  const w = tehranWallDate(d);
  return gregorianToJalali(w.getFullYear(), w.getMonth() + 1, w.getDate());
}

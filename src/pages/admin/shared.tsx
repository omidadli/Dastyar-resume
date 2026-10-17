import React from 'react';
import type { LucideIcon } from 'lucide-react';
import type { AiPurpose, KeyHealth } from '../../types/admin';
import { faDate, faRelative, toPersianDigits } from '../../lib/format';

/** Page title row used by every admin section. */
export function AdminHeader({ title, subtitle, actions }: { title: string; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div className="min-w-0">
        <h1 className="text-[22px] sm:text-[24px] font-extrabold text-ink leading-tight">{title}</h1>
        {subtitle && <p className="text-[13.5px] text-ink-3 mt-1.5 leading-relaxed max-w-[760px]">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function MiniStat({ icon: Icon, label, value, note, tone = 'neutral' }: { icon: LucideIcon; label: string; value: React.ReactNode; note?: React.ReactNode; tone?: 'neutral' | 'brand' | 'review' | 'low' }) {
  const chip = {
    neutral: 'bg-line-2 text-ink-2',
    brand: 'bg-brand-soft text-brand-strong',
    review: 'bg-review-soft text-review-ink',
    low: 'bg-low-soft text-low-ink',
  }[tone];
  return (
    <div className="hv-card p-3 sm:p-4 flex flex-col sm:flex-row items-start gap-2 sm:gap-3">
      <span className={`w-8 h-8 sm:w-10 sm:h-10 rounded-[10px] sm:rounded-[12px] flex items-center justify-center shrink-0 ${chip}`}>
        <Icon className="w-4 h-4 sm:w-5 sm:h-5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <p className="text-[12px] text-ink-3 font-medium leading-snug">{label}</p>
        <p className="text-[18px] sm:text-[21px] font-extrabold text-ink leading-tight mt-1 hv-num">{value}</p>
        {note && <p className="text-[11px] sm:text-[11.5px] text-ink-3 mt-1 leading-snug">{note}</p>}
      </div>
    </div>
  );
}

export const HEALTH_LABEL: Record<KeyHealth, string> = {
  ready: 'آماده',
  cooling: 'در استراحت',
  limited: 'رسیده به سقف',
  invalid: 'نامعتبر',
  disabled: 'غیرفعال',
};

export function HealthBadge({ health }: { health: KeyHealth }) {
  const cls = {
    ready: 'bg-high-soft text-high-ink',
    cooling: 'bg-review-soft text-review-ink',
    limited: 'bg-review-soft text-review-ink',
    invalid: 'bg-low-soft text-low-ink',
    disabled: 'bg-line-2 text-ink-3',
  }[health];
  const dot = { ready: 'bg-high', cooling: 'bg-review', limited: 'bg-review', invalid: 'bg-low', disabled: 'bg-ink-4' }[health];
  return (
    <span className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-full text-[11.5px] font-bold ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dot} ${health === 'ready' ? 'animate-pulse' : ''}`} />
      {HEALTH_LABEL[health]}
    </span>
  );
}

/** Date + time in Tehran, Jalali calendar. */
export function faDateTime(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const time = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' }).format(d);
  return `${faDate(d.toISOString())}، ${time}`;
}

export function faAgo(ts: number | string | null | undefined): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  return faRelative(new Date(ts).toISOString());
}

export function faIn(ts: number | null | undefined): string {
  if (!ts) return '';
  const sec = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (sec < 60) return `${toPersianDigits(sec)} ثانیه دیگر`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${toPersianDigits(min)} دقیقه دیگر`;
  return `${toPersianDigits(Math.round(min / 60))} ساعت دیگر`;
}

export function faBytes(n: number): string {
  if (!n) return '۰';
  const units = ['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('fa-IR', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

export const PURPOSE_LABEL: Record<AiPurpose, string> = {
  evaluate: 'تحلیل رزومه',
  deep: 'بازبینی دقیق',
  understand: 'پرسش‌نامه شغل',
  calibrate: 'هم‌سنجی',
  message: 'پیش‌نویس پیام',
  test: 'آزمایش اتصال',
  lab: 'آزمایشگاه رفتار',
  other: 'سایر',
};

export const AUDIT_LABEL: Record<string, string> = {
  'admin.claim': 'دریافت نقش مدیر سامانه',
  'org.rename': 'تغییر نام فضای کاری',
  'org.suspend': 'تعلیق فضای کاری',
  'org.unsuspend': 'رفع تعلیق فضای کاری',
  'org.delete': 'حذف فضای کاری',
  'org.extend_demo': 'تمدید نسخه نمایشی',
  'org.convert_demo': 'تبدیل نمایشی به دائمی',
  'org.support': 'ورود پشتیبانی',
  'user.update': 'ویرایش کاربر',
  'user.reset_password': 'بازنشانی رمز عبور',
  'user.revoke_sessions': 'بستن نشست‌ها',
  'user.delete': 'حذف کاربر',
  'ai.settings': 'تنظیمات هوش مصنوعی',
  'ai.key_add': 'افزودن کلید',
  'ai.key_update': 'ویرایش کلید',
  'ai.key_delete': 'حذف کلید',
  'ai.key_reorder': 'تغییر ترتیب کلیدها',
  'ai.key_test': 'آزمایش کلید',
  'ai.key_reset': 'بازنشانی وضعیت کلید',
  'behavior.save': 'ذخیره رفتار هوش مصنوعی',
  'behavior.reset': 'بازگردانی رفتار پیش‌فرض',
  'behavior.restore': 'بازگردانی نسخه رفتار',
  'system.update': 'تنظیمات سامانه',
  'backup.download': 'دریافت پشتیبان کامل',
  'backup.restore': 'بازیابی از پشتیبان',
};

export const ROLE_LABEL: Record<string, string> = { owner: 'مالک', admin: 'مدیر', member: 'عضو' };

/** A label/value row inside cards. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 border-b border-line-2 last:border-0">
      <span className="text-[12.5px] text-ink-3 shrink-0">{label}</span>
      <span className="text-[13px] font-semibold text-ink-2 text-left min-w-0 break-words">{children}</span>
    </div>
  );
}

/** The value, settled for `ms` (search boxes) — the app-wide hook. */
export { useDebounced } from '../../lib/useAsync';

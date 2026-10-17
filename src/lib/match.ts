import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleHelp,
  CircleSlash2,
  Clock3,
  ThumbsDown,
  ThumbsUp,
  type LucideIcon,
} from 'lucide-react';
import type {
  Confidence,
  DecisionStatus,
  EmploymentType,
  JobStatus,
  MatchFilter,
  ResumeCategory,
} from '../types/screening';

/**
 * The AI describes the MATCH LEVEL — it never says "hire" or "reject".
 * Colors are always paired with an icon and a label (green alone ≠ suitable).
 */
export type MatchLevel = 'high' | 'review' | 'low' | 'insufficient';

export interface MatchMeta {
  level: MatchLevel;
  label: string;
  short: string;
  hint: string;
  icon: LucideIcon;
  /** bar / dot color */
  color: string;
  pill: string;
  text: string;
  soft: string;
}

export const MATCH_META: Record<MatchLevel, MatchMeta> = {
  high: {
    level: 'high',
    label: 'تطابق بالا',
    short: 'بالا',
    hint: 'شواهد رزومه با بیشتر معیارهای این فرصت شغلی هم‌خوان است.',
    icon: CheckCircle2,
    color: 'bg-high',
    pill: 'bg-high-soft text-high-ink border-high/25',
    text: 'text-high-ink',
    soft: 'bg-high-soft',
  },
  review: {
    level: 'review',
    label: 'نیازمند بررسی',
    short: 'بررسی',
    hint: 'تطابق نسبی دیده می‌شود؛ چند نکته به قضاوت شما نیاز دارد.',
    icon: AlertTriangle,
    color: 'bg-review',
    pill: 'bg-review-soft text-review-ink border-review/25',
    text: 'text-review-ink',
    soft: 'bg-review-soft',
  },
  low: {
    level: 'low',
    label: 'تطابق پایین',
    short: 'پایین',
    hint: 'شواهد کافی برای معیارهای اصلی این فرصت شغلی پیدا نشد.',
    icon: CircleSlash2,
    color: 'bg-low',
    pill: 'bg-low-soft text-low-ink border-low/25',
    text: 'text-low-ink',
    soft: 'bg-low-soft',
  },
  insufficient: {
    level: 'insufficient',
    label: 'اطلاعات ناکافی',
    short: 'ناکافی',
    hint: 'محتوای رزومه برای قضاوت کافی نبود یا تحلیل ممکن نشد.',
    icon: CircleHelp,
    color: 'bg-na',
    pill: 'bg-na-soft text-na-ink border-na/30',
    text: 'text-na-ink',
    soft: 'bg-na-soft',
  },
};

export function matchLevelOf(category: ResumeCategory): MatchLevel {
  switch (category) {
    case 'INTERVIEW':
      return 'high';
    case 'REVIEW':
      return 'review';
    case 'REJECT':
      return 'low';
    default:
      return 'insufficient';
  }
}

export function matchMeta(category: ResumeCategory): MatchMeta {
  return MATCH_META[matchLevelOf(category)];
}

export const MATCH_FILTERS: { id: MatchFilter; label: string }[] = [
  { id: 'all', label: 'همه' },
  { id: 'high', label: 'تطابق بالا' },
  { id: 'review', label: 'نیازمند بررسی' },
  { id: 'low', label: 'تطابق پایین' },
  { id: 'insufficient', label: 'اطلاعات ناکافی' },
];

export interface DecisionMeta {
  label: string;
  verb: string;
  icon: LucideIcon;
  pill: string;
  text: string;
}

export const DECISION_META: Record<DecisionStatus, DecisionMeta> = {
  approved: { label: 'تأیید شده', verb: 'تأیید', icon: ThumbsUp, pill: 'bg-brand-soft text-brand-stronger border-brand/30', text: 'text-brand-ink' },
  rejected: { label: 'رد شده', verb: 'رد', icon: ThumbsDown, pill: 'bg-low-soft text-low-ink border-low/25', text: 'text-low-ink' },
  review: { label: 'نیاز به بررسی', verb: 'نیاز به بررسی', icon: Clock3, pill: 'bg-review-soft text-review-ink border-review/25', text: 'text-review-ink' },
  none: { label: 'بدون تصمیم', verb: 'بدون تصمیم', icon: CircleDashed, pill: 'bg-surface text-ink-3 border-line', text: 'text-ink-3' },
};

export const REJECT_REASONS = [
  'سابقه کاری مرتبط کافی نیست',
  'مهارت‌های کلیدی موردنیاز را ندارد',
  'حقوق درخواستی خارج از بودجه است',
  'محل سکونت یا شرایط همکاری مناسب نیست',
  'سطح نقش با این موقعیت هم‌خوان نیست',
  'کاندید مناسب‌تری انتخاب شد',
];

export const JOB_STATUS_META: Record<JobStatus, { label: string; pill: string; dot: string }> = {
  open: { label: 'باز', pill: 'bg-brand-soft text-brand-stronger border-brand/30', dot: 'bg-brand' },
  paused: { label: 'متوقف', pill: 'bg-review-soft text-review-ink border-review/25', dot: 'bg-review' },
  closed: { label: 'بسته‌شده', pill: 'bg-na-soft text-na-ink border-na/30', dot: 'bg-na' },
};

export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  'full-time': 'تمام‌وقت',
  'part-time': 'پاره‌وقت',
  contract: 'قراردادی / پروژه‌ای',
  remote: 'دورکاری',
  hybrid: 'ترکیبی',
  internship: 'کارآموزی',
};

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'اطمینان بالا',
  medium: 'اطمینان متوسط',
  low: 'اطمینان پایین',
};

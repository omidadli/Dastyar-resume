/**
 * «تحویل پس از استخدام» — the handover that happens after the offer is signed.
 *
 * Why an ATS needs it: the hire is not the end of the funnel. Someone has to
 * order the laptop, open the accounts, book the first-day session and tell the
 * team. Today that lives in a WhatsApp group and a notebook. Here it lives next
 * to the candidate, with a start date in the Jalali calendar and a checklist
 * that shows what is still missing — and it can go to the payroll/HR system
 * through the same API the rest of HOVIDA exposes.
 */

export type OnboardingStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled';

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  planned: 'برنامه‌ریزی‌شده',
  in_progress: 'در جریان',
  completed: 'کامل شد',
  cancelled: 'لغو شد',
};

export interface OnboardingTask {
  id: string;
  label: string;
  done: boolean;
  doneAtISO: string | null;
  doneByName: string | null;
}

export interface OnboardingPlan {
  id: string;
  resumeId: string;
  jobId: string | null;
  jobTitle: string | null;
  departmentName: string | null;
  candidateName: string;
  candidateEmail: string | null;
  /** Start of the first working day. */
  startDateISO: string;
  startDateJalali: string;
  ownerName: string | null;
  status: OnboardingStatus;
  tasks: OnboardingTask[];
  note: string | null;
  welcomeSentAtISO: string | null;
  createdAtISO: string;
  createdByName: string | null;
  /** Convenience for the list: how many boxes are ticked. */
  doneCount: number;
  total: number;
  /** Negative when the start date has passed. */
  daysUntil: number;
}

export interface OnboardingOverview {
  items: OnboardingPlan[];
  counts: { planned: number; inProgress: number; completed: number; startingThisWeek: number };
  /** Whether the workspace has a mailbox — the welcome e-mail depends on it. */
  mailbox: boolean;
}

/** The checklist a new hire actually needs, in the order it usually goes wrong. */
export const DEFAULT_ONBOARDING_TASKS: string[] = [
  'قرارداد و الحاقیه‌ها امضا شد',
  'مدارک هویتی و بیمه تحویل گرفته شد',
  'حساب ایمیل سازمانی ساخته شد',
  'دسترسی به سامانه‌های کاری داده شد',
  'لپ‌تاپ و تجهیزات تحویل داده شد',
  'میز و فضای کار آماده شد',
  'به تیم معرفی شد (جلسهٔ روز اول)',
  'برنامهٔ هفتهٔ اول و آموزش‌ها مشخص شد',
  'سرپرست مستقیم و جانشین او مشخص شد',
];

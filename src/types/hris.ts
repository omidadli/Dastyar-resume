/**
 * «انتقال به حقوق و دستمزد» — the payroll handoff.
 *
 * An ATS hires; payroll pays. The messy seam between them is a spreadsheet that
 * someone retypes every month: name, start date, salary, department. This module
 * owns the canonical shape of that handoff and the honest list of what it does
 * *not* know (national ID, insurance number, bank account — payroll's own data,
 * never collected here).
 */

/** Every column HOVIDA can hand over. Adding one here is the whole change. */
export type HrisField =
  | 'employeeCode'
  | 'fullName'
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'jobTitle'
  | 'departmentName'
  | 'startDateJalali'
  | 'startDateISO'
  | 'employmentType'
  | 'location'
  | 'baseSalary'
  | 'salaryPeriod'
  | 'planStatus'
  | 'ownerName';

export interface HrisFieldMeta {
  key: HrisField;
  label: string;
  /** Why the field is there / what to expect when it is empty. */
  hint: string;
  group: 'identity' | 'job' | 'pay' | 'meta';
}

export const HRIS_FIELDS: HrisFieldMeta[] = [
  { key: 'employeeCode', label: 'کد پرسنلی', hint: 'پیشنهاد هویدا؛ در سیستم حقوق می‌توانید عوضش کنید.', group: 'identity' },
  { key: 'fullName', label: 'نام و نام خانوادگی', hint: 'همان نامی که در پروندهٔ کارجو ثبت شده است.', group: 'identity' },
  { key: 'firstName', label: 'نام', hint: 'برای سیستم‌هایی که دو ستون جدا می‌خواهند.', group: 'identity' },
  { key: 'lastName', label: 'نام خانوادگی', hint: 'برای سیستم‌هایی که دو ستون جدا می‌خواهند.', group: 'identity' },
  { key: 'email', label: 'ایمیل', hint: 'اگر کارجو ایمیل داده باشد؛ وگرنه خالی.', group: 'identity' },
  { key: 'jobTitle', label: 'عنوان شغلی', hint: 'از خودِ آگهی، نه از متن پیام.', group: 'job' },
  { key: 'departmentName', label: 'دپارتمان', hint: 'دپارتمانی که آگهی در آن باز شده است.', group: 'job' },
  { key: 'startDateJalali', label: 'تاریخ شروع (شمسی)', hint: 'همان روزی که در برنامهٔ تحویل ثبت شده است.', group: 'job' },
  { key: 'startDateISO', label: 'تاریخ شروع (میلادی)', hint: 'برای سیستم‌هایی که ISO می‌خواهند.', group: 'job' },
  { key: 'employmentType', label: 'نوع همکاری', hint: 'مثل «تمام‌وقت» یا «قراردادی»؛ از پیشنهاد یا آگهی.', group: 'job' },
  { key: 'location', label: 'محل کار', hint: 'از شرایط پیشنهاد؛ اگر نبود از آگهی.', group: 'job' },
  { key: 'baseSalary', label: 'حقوق پایه', hint: 'فقط اگر در پیشنهادِ پذیرفته‌شده عدد نوشته شده باشد؛ وگرنه خالی.', group: 'pay' },
  { key: 'salaryPeriod', label: 'دورهٔ حقوق', hint: 'ماهانه یا سالانه، همان‌طور که در پیشنهاد آمده است.', group: 'pay' },
  { key: 'planStatus', label: 'وضعیت تحویل', hint: 'در جریان یا کامل‌شده.', group: 'meta' },
  { key: 'ownerName', label: 'مسئول تحویل', hint: 'کسی که چک‌لیست روز اول را می‌بندد.', group: 'meta' },
];

/**
 * The default file a payroll clerk expects: ten columns, Persian headers, the
 * employee code first. Anything else is one toggle away, not one migration away.
 */
export const DEFAULT_HRIS_MAPPING: Record<HrisField, string> = {
  employeeCode: 'کد پرسنلی',
  fullName: 'نام و نام خانوادگی',
  firstName: '',
  lastName: '',
  email: 'ایمیل',
  jobTitle: 'عنوان شغلی',
  departmentName: 'دپارتمان',
  startDateJalali: 'تاریخ شروع (شمسی)',
  startDateISO: '',
  employmentType: 'نوع همکاری',
  location: 'محل کار',
  baseSalary: 'حقوق پایه (تومان)',
  salaryPeriod: 'دورهٔ حقوق',
  planStatus: '',
  ownerName: '',
};

export const HRIS_FIELD_KEYS: HrisField[] = HRIS_FIELDS.map((f) => f.key);

/** One person, as the payroll system receives them. */
export interface HrisRow {
  planId: string;
  resumeId: string;
  employeeCode: string;
  fullName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  jobTitle: string;
  departmentName: string;
  startDateJalali: string;
  startDateISO: string;
  employmentType: string;
  location: string;
  /** `null` is honest: this offer never stated a number. */
  baseSalary: number | null;
  salaryPeriod: 'monthly' | 'annual' | null;
  planStatus: 'inProgress' | 'completed';
  ownerName: string | null;
}

export interface HrisEndpointView {
  configured: boolean;
  host: string | null;
  masked: string | null;
  secretHint: string | null;
  updatedAtISO: string | null;
}

export interface HrisPushResult {
  id: string;
  atISO: string;
  atJalali: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  rows: number;
  byName: string | null;
}

export interface HrisRoster {
  items: HrisRow[];
  fields: HrisFieldMeta[];
  /** Every field key → its column header (empty string = not in the file). */
  mapping: Record<string, string>;
  endpoint: HrisEndpointView;
  lastPush: HrisPushResult | null;
  counts: { total: number; started: number; upcoming: number; missingSalary: number; missingEmail: number };
}

export interface HrisMappingInput {
  mapping: Record<string, string>;
}

export interface HrisEndpointInput {
  url?: string;
  /** Only used to sign the request; generated when omitted. */
  secret?: string;
}

/** Fields payroll owns and HOVIDA deliberately never collects. */
export const PAYROLL_OWN_FIELDS: string[] = [
  'کد ملی',
  'شمارهٔ بیمه',
  'شمارهٔ حساب بانکی',
  'وضعیت تأهل و تعداد فرزند',
  'گروه شغلی و پایهٔ سنوات',
];

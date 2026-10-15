import type { Department } from '../types/app';

/**
 * Starter departments for a new workspace. Every organization can rename,
 * add or remove them in «تنظیمات › دپارتمان‌ها». The ids intentionally match
 * the ones used by earlier versions, so migrated data keeps its grouping.
 */
export const DEFAULT_DEPARTMENTS: Department[] = [
  { id: 'sales', name: 'فروش و توسعه بازار', hint: 'فروش حضوری و میدانی، مذاکره با مشتری، تارگت و پورسانت، توزیع و پخش، مدیریت حساب مشتریان' },
  { id: 'marketing', name: 'بازاریابی و برند', hint: 'دیجیتال مارکتینگ، تبلیغات، برندینگ، تولید محتوا، شبکه‌های اجتماعی، تحقیقات بازار' },
  { id: 'finance', name: 'مالی و حسابداری', hint: 'حسابداری، بهای تمام‌شده، مالیات و بیمه، نرم‌افزارهای مالی، گزارش‌گیری و بودجه' },
  { id: 'hr', name: 'منابع انسانی و اداری', hint: 'جذب و استخدام، کارگزینی، قانون کار، آموزش و توسعه، جبران خدمات و امور اداری' },
  { id: 'it', name: 'فناوری اطلاعات', hint: 'برنامه‌نویسی، زیرساخت و شبکه، پشتیبانی فنی، پایگاه داده، امنیت اطلاعات' },
  { id: 'manufacturing', name: 'تولید و عملیات', hint: 'خط تولید، سرپرستی شیفت، کار با ماشین‌آلات، برنامه‌ریزی تولید، بهره‌وری' },
  { id: 'engineering', name: 'فنی و مهندسی', hint: 'نگهداری و تعمیرات، مکانیک، برق، اتوماسیون، طراحی و پروژه‌های فنی' },
  { id: 'logistics', name: 'لجستیک و زنجیره تأمین', hint: 'انبارداری، کنترل موجودی، خرید، حمل‌ونقل و توزیع، برنامه‌ریزی تأمین' },
  { id: 'qc', name: 'کنترل کیفیت', hint: 'کنترل کیفیت مواد و محصول، آزمایشگاه، استانداردها، مستندسازی و ممیزی' },
  { id: 'support', name: 'خدمات مشتریان', hint: 'پاسخ‌گویی و پشتیبانی مشتری، مرکز تماس، رسیدگی به شکایات، CRM' },
  { id: 'other', name: 'سایر', hint: 'سایر نقش‌های ستادی، اداری و پشتیبانی' },
];

export function cloneDefaultDepartments(): Department[] {
  return DEFAULT_DEPARTMENTS.map((d) => ({ ...d }));
}

export function findDepartment(list: Department[], id: string): Department | null {
  return list.find((d) => d.id === id) || null;
}

/** Department id from a free-form name: stable, url-safe, unique within the list. */
export function makeDepartmentId(name: string, existing: Department[]): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'dept';
  let id = base === 'dept' ? `dept-${Math.random().toString(36).slice(2, 7)}` : base;
  while (existing.some((d) => d.id === id)) id = `${base}-${Math.random().toString(36).slice(2, 5)}`;
  return id;
}

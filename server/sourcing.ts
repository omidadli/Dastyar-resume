/**
 * «جست‌وجوی استعداد» — from a free-text request to a provider query, and from
 * a found profile back into the workspace as a normal candidate.
 *
 * The brief is built by the AI when a key is available (and always editable by
 * the recruiter); otherwise a deterministic local parser produces a simpler
 * query and the UI labels it as such. Results only ever come from the provider.
 */
import { cleanAndParseJson, friendlyAiError } from './ai/screening';
import { generate } from './ai/provider';
import type { Department } from '../src/types/app';
import type { Job } from '../src/types/screening';
import type { SourcingBrief } from '../src/types/integrations';
import { buildLocalBrief, sanitizeBrief } from './linkedin';

const BRIEF_EXAMPLE = `{
  "roleTitle": "کارشناس ارشد حسابداری صنعتی",
  "seniority": "کارشناس ارشد",
  "locations": ["تهران", "کرج"],
  "skills": ["حسابداری صنعتی", "بهای تمام‌شده", "SAP", "اکسل پیشرفته"],
  "mustHave": ["حداقل ۵ سال سابقه در تولید"],
  "keywords": ["بهای تمام‌شده", "انبار", "حسابرسی داخلی"],
  "booleanQuery": "(\"حسابداری صنعتی\" OR \"بهای تمام‌شده\") AND (SAP OR \"Oracle EBS\") AND (تهران OR کرج)",
  "openToWorkOnly": true,
  "notes": "ترجیحاً سابقه در شرکت‌های تولیدی و آشنا با گزارش‌های مدیریتی."
}`;

export interface BriefInput {
  prompt: string;
  department: Department;
  /** Taken from the opening when the search targets one, otherwise free text. */
  roleTitle: string;
  openToWorkOnly: boolean;
  job?: Job | null;
}

/**
 * Turns «دنبال چه متخصصی می‌گردم، با چه شرایطی» into fields a provider can
 * search. The AI call is optional: any failure falls back to the local parser.
 */
export async function buildSearchBrief(input: BriefInput): Promise<SourcingBrief> {
  const prompt = (input.prompt || '').trim().slice(0, 3000);
  const fallback = buildLocalBrief(prompt, input.roleTitle.trim(), input.openToWorkOnly);
  if (!prompt && !input.roleTitle.trim()) return fallback;

  const criteria = input.job?.understanding?.criteria?.map((c) => c.title).slice(0, 8) || [];
  const aiPrompt = `تو کارشناس جذب و استخدام در سازمان «${input.department.name}» هستی و می‌خواهی در LinkedIn افرادی را پیدا کنی که شرایط یک موقعیت را دارند.
درخواست کاربر: «${prompt || 'بدون توضیح' }»
${input.job ? `فرصت شغلی: ${input.job.roleTitle}\nمعیارهای ارزیابی این فرصت: ${criteria.join('، ') || '—'}\n` : ''}دپارتمان: ${input.department.name}${input.department.hint ? ` (${input.department.hint})` : ''}
عنوان شغلی انتخابی: ${input.roleTitle || '—'}
فقط افراد Open to work: ${input.openToWorkOnly ? 'بله' : 'خیر'}

این فیلدها را بساز:
- roleTitle: عنوان روشن و کوتاه نقش (فارسی یا همان اصطلاح رایج بازار).
- seniority: سطح (کارآموز، کارشناسی، کارشناس ارشد، سرپرست، مدیریت) یا null.
- locations: شهر/منطقه‌های ذکرشده یا منطقی (حداکثر ۵). اگر ذکر نشده، خالی بگذار.
- skills: مهارت‌ها و فناوری‌های کلیدی قابل جست‌وجو (حداکثر ۱۰).
- mustHave: الزام‌های غیرقابل‌گذشت (حداکثر ۴).
- keywords: واژه‌های کمکی برای جست‌وجو (حداکثر ۱۰).
- booleanQuery: یک کوئری بولی LinkedIn با AND/OR و گیومه برای عبارت‌های چندکلمه‌ای؛ فقط از واژه‌هایی استفاده کن که در درخواست یا معیارها آمده‌اند. حداقل سابقه را در کوئری نگذار.
- openToWorkOnly: همان مقدار ورودی.
- notes: یک جمله کوتاه دربارهٔ آنچه در جست‌وجو مهم است.

هیچ نام، شرکت، عدد یا مهارتی از خودت نساز. فقط JSON معتبر با همین ساختار:
${BRIEF_EXAMPLE}`;

  try {
    const raw = await generate(aiPrompt, {
      system:
        'تو یک دستیار جست‌وجوی استعداد هستی. فقط JSON معتبر برمی‌گردانی، هیچ توضیح اضافه‌ای نمی‌نویسی و هیچ داده‌ای از خودت نمی‌سازی.',
      temperature: 0.2,
      timeoutMs: 25_000,
      deadlineMs: 40_000,
      purpose: 'understand',
    });
    const parsed = cleanAndParseJson<any>(raw || '', null);
    if (!parsed) return fallback;
    const brief = sanitizeBrief(parsed, fallback);
    brief.openToWorkOnly = input.openToWorkOnly;
    return brief;
  } catch (err: any) {
    console.warn('[sourcing] AI brief unavailable, using the local parser:', friendlyAiError(err));
    return fallback;
  }
}

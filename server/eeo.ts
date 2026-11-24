/**
 * «برابری فرصت‌ها» — the honest diversity report.
 *
 * Three rules make this different from a chart that flatters the company:
 *   1. **Voluntary.** The candidate may decline every question, and «ترجیح می‌دهم
 *      نگویم» is a real answer, not a gap to be filled by guessing.
 *   2. **Invisible to decisions.** The answer is stripped from every payload a
 *      member can open; nobody shortlists a person and reads their category.
 *   3. **Small cells are hidden.** A category with fewer than `threshold` people
 *      is shown as «کمتر از ۵ نفر» — a percentage over three people is gossip,
 *      not a finding.
 *
 * The report's own wording follows from that: with too little data it says so
 * plainly instead of drawing a conclusion out of twelve applications.
 */
import * as db from './db';
import type { ReportRange } from '../src/types/app';
import type { EeoAnswer, EeoCell, EeoConfig, EeoDimension, EeoReport } from '../src/types/eeo';
import type { ResumeRecord } from '../src/types/screening';

export const EEO_DEFAULT: EeoConfig = { enabled: false, threshold: 5 };
export const MAX_THRESHOLD = 50;

const GENDERS: { key: EeoAnswer['gender']; label: string }[] = [
  { key: 'woman', label: 'زن' },
  { key: 'man', label: 'مرد' },
  { key: 'other', label: 'دیگر / ترجیح می‌دهم توضیح ندهم' },
  { key: 'undisclosed', label: 'ترجیح می‌دهم نگویم' },
];

const AGES: { key: EeoAnswer['ageBand']; label: string }[] = [
  { key: 'under25', label: 'زیر ۲۵ سال' },
  { key: '25-34', label: '۲۵ تا ۳۴ سال' },
  { key: '35-44', label: '۳۵ تا ۴۴ سال' },
  { key: '45-54', label: '۴۵ تا ۵۴ سال' },
  { key: '55plus', label: '۵۵ سال و بیشتر' },
  { key: 'undisclosed', label: 'ترجیح می‌دهم نگویم' },
];

const DISABILITY: { key: EeoAnswer['disability']; label: string }[] = [
  { key: 'yes', label: 'دارای معلولیت یا بیماری مزمن' },
  { key: 'no', label: 'بدون معلولیت' },
  { key: 'undisclosed', label: 'ترجیح می‌دهم نگویم' },
];

export function eeoConfigOf(org: { eeo?: EeoConfig } | null | undefined): EeoConfig {
  const raw = org?.eeo;
  const threshold = Number.isFinite(raw?.threshold) ? Math.min(MAX_THRESHOLD, Math.max(2, Math.round(raw!.threshold))) : EEO_DEFAULT.threshold;
  return { enabled: Boolean(raw?.enabled), threshold };
}

/**
 * Reads what a candidate sent. Unknown values become «undisclosed» — never an
 * error: refusing to answer must always be possible.
 */
export function readEeoInput(raw: unknown): EeoAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, keys: { key: T }[], fallback: T): T =>
    keys.some((k) => k.key === v) ? (v as T) : fallback;
  // An empty object is «the candidate did not fill the form», not a disclosure.
  if (!b.gender && !b.ageBand && !b.disability) return null;
  return {
    gender: pick(b.gender, GENDERS, 'undisclosed'),
    ageBand: pick(b.ageBand, AGES, 'undisclosed'),
    disability: pick(b.disability, DISABILITY, 'undisclosed'),
  };
}

/** Strips the answer from anything a person could open next to a name. */
export function withoutEeo<T extends { eeo?: unknown }>(row: T): Omit<T, 'eeo'> {
  const { eeo: _e, ...rest } = row;
  return rest;
}

function cell(
  dimension: EeoDimension,
  value: string,
  label: string,
  rows: ResumeRecord[],
  threshold: number,
  hiredOf: (r: ResumeRecord) => boolean
): EeoCell {
  const mine = rows.filter((r) => r.eeo?.[dimension] === value);
  const applied = mine.length;
  const hired = mine.filter(hiredOf).length;
  const hidden = applied > 0 && applied < threshold;
  return {
    key: value,
    label,
    applied,
    hired: hidden ? 0 : hired,
    hidden,
    hireRate: hidden || applied === 0 ? null : Math.round((hired / applied) * 100),
  };
}

/** Hired = the candidate actually sits in the board's «استخدام‌شده» column. */
function isHired(rec: ResumeRecord): boolean {
  if (!rec.stageId || !rec.orgId) return false;
  const job = db.getJob(rec.orgId, rec.jobId);
  if (!job) return false;
  return db.stagesOf(job).find((s) => s.id === rec.stageId)?.kind === 'hired';
}

export function eeoReport(orgId: string, config: EeoConfig, range: ReportRange = 'all'): EeoReport {
  const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000;
  const rows = db.listOrgResumes(orgId).filter((r) => new Date(r.createdAtISO).getTime() >= cutoff);
  const disclosed = rows.filter((r) => Boolean(r.eeo));

  const dimension = (id: EeoDimension, title: string, note: string, values: { key: string; label: string }[]): EeoReport['dimensions'][number] => ({
    dimension: id,
    title,
    note,
    cells: values.map((v) => cell(id, v.key, v.label, disclosed, config.threshold, isHired)),
  });

  const jobs = new Map<string, { jobId: string; jobTitle: string; applied: number; hired: number }>();
  for (const r of rows) {
    const entry = jobs.get(r.jobId) || { jobId: r.jobId, jobTitle: r.roleTitle || r.departmentName, applied: 0, hired: 0 };
    entry.applied += 1;
    if (isHired(r)) entry.hired += 1;
    entry.jobTitle = r.roleTitle || entry.jobTitle;
    jobs.set(r.jobId, entry);
  }

  const enough = disclosed.length >= config.threshold * 2;
  const note = !config.enabled
    ? 'این گزارش خاموش است؛ تا وقتی روشنش نکنید هیچ داده‌ای از کارجوها ذخیره نمی‌شود.'
    : disclosed.length === 0
      ? 'هنوز هیچ کارجویی این پرسش‌های داوطلبانه را پاسخ نداده است. عدد صفر یعنی «داده‌ای نداریم»، نه «هیچ تفاوتی نیست».'
      : !enough
        ? `فقط ${disclosed.length.toLocaleString('fa-IR')} نفر پاسخ داده‌اند؛ برای نتیجه‌گیری معنادار به دادهٔ بیشتری نیاز است و خانه‌های کوچک‌تر از ${config.threshold.toLocaleString('fa-IR')} نفر پنهان می‌شوند.`
        : `این گزارش فقط توصیف است، نه داوری: نسبت‌ها با ${disclosed.length.toLocaleString('fa-IR')} پاسخ داوطلبانه ساخته شده‌اند و خانه‌های کوچک‌تر از ${config.threshold.toLocaleString('fa-IR')} نفر نمایش داده نمی‌شوند.`;

  return {
    enabled: config.enabled,
    threshold: config.threshold,
    total: rows.length,
    disclosed: disclosed.length,
    disclosedRate: rows.length ? Math.round((disclosed.length / rows.length) * 100) : 0,
    dimensions: [
      dimension('gender', 'جنسیت', 'داوطلبانه و بی‌نام؛ در هیچ‌کجای پروندهٔ کارجو دیده نمی‌شود.', GENDERS),
      dimension('ageBand', 'گروه سنی', 'گروه‌های سنی، نه تاریخ تولد.', AGES),
      dimension('disability', 'معلولیت یا بیماری مزمن', 'برای بررسی دسترس‌پذیری فرایند استخدام.', DISABILITY),
    ],
    byJob: Array.from(jobs.values())
      .sort((a, b) => b.applied - a.applied)
      .slice(0, 12)
      .map((j) => ({ ...j, hidden: j.applied > 0 && j.applied < config.threshold })),
    note,
  };
}


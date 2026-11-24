/**
 * «هزینهٔ هر استخدام» — the money side, kept honest.
 *
 * Two kinds of cost exist and they are never mixed silently:
 *  • **direct** — a real invoice the workspace typed in (ad, agency, referral
 *    bonus, tool, test, interview day). Amount, date, optional opening.
 *  • **time** — internal hours reconstructed from recorded work (scorecards,
 *    notes, decisions, interviews), multiplied by an hourly rate *the workspace
 *    enters itself*. Without that rate the time cost is zero and the page says
 *    why — we never invent a salary to make a number look complete.
 */
import type { CostAssumption, CostEntry, CostKind } from '../src/types/reports';

export const COST_KINDS: { id: CostKind; label: string; hint: string }[] = [
  { id: 'advertising', label: 'آگهی و تبلیغ', hint: 'جاب‌برد، شبکه‌های اجتماعی، بنر' },
  { id: 'agency', label: 'شرکت مشاور / ریکروتر', hint: 'دستمزد بیرونی برای جذب' },
  { id: 'referral', label: 'پاداش معرفی', hint: 'مبلغی که به معرف پرداخت شد' },
  { id: 'tools', label: 'ابزار و اشتراک', hint: 'ATS، سنجش، بررسی پیشینه' },
  { id: 'assessment', label: 'آزمون و ارزیابی', hint: 'هزینهٔ هر آزمون یا ارزیاب' },
  { id: 'interview', label: 'روز مصاحبه', hint: 'سفر، اتاق، پذیرایی، جایگزین شیفت' },
  { id: 'other', label: 'سایر', hint: 'هر چیز دیگری که برای این استخدام خرج شد' },
];

export const COST_KIND_LABEL: Record<CostKind, string> = {
  advertising: 'آگهی و تبلیغ',
  agency: 'شرکت مشاور / ریکروتر',
  referral: 'پاداش معرفی',
  tools: 'ابزار و اشتراک',
  assessment: 'آزمون و ارزیابی',
  interview: 'روز مصاحبه',
  other: 'سایر',
};

/** Default minutes per recorded action. Deliberately conservative and editable. */
export const DEFAULT_ASSUMPTION: CostAssumption = {
  hourlyRate: 0,
  minutesPerScorecard: 20,
  minutesPerComment: 5,
  minutesPerDecision: 10,
};

export const MAX_AMOUNT = 1_000_000_000_000; // یک هزار میلیارد تومان
export const MAX_HOURLY_RATE = 100_000_000;

/** «۲٬۵۰۰٬۰۰۰» typed on a Persian keyboard is still a number. */
function toLatinNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const text = String(v ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[^\d.-]/g, '');
  // Empty is NaN, not 0: a missing field must fall back to its default, while a
  // typed zero must stay zero.
  return text === '' ? Number.NaN : Number(text);
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.round(toLatinNumber(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Reads whatever is stored (or sent) into a usable assumption. */
export function normalizeAssumption(raw: unknown): CostAssumption {
  const r = (raw || {}) as Partial<Record<keyof CostAssumption, unknown>>;
  return {
    hourlyRate: clampInt(r.hourlyRate, 0, MAX_HOURLY_RATE, DEFAULT_ASSUMPTION.hourlyRate),
    minutesPerScorecard: clampInt(r.minutesPerScorecard, 0, 600, DEFAULT_ASSUMPTION.minutesPerScorecard),
    minutesPerComment: clampInt(r.minutesPerComment, 0, 600, DEFAULT_ASSUMPTION.minutesPerComment),
    minutesPerDecision: clampInt(r.minutesPerDecision, 0, 600, DEFAULT_ASSUMPTION.minutesPerDecision),
  };
}

/**
 * Validates a cost row from the browser.
 * Returns the error text in Persian, or the cleaned values.
 */
export function readCostInput(body: unknown): { error: string } | { kind: CostKind; amount: number; atISO: string | null; jobId: string | null; note: string } {
  const b = (body || {}) as Record<string, unknown>;
  const kind = typeof b.kind === 'string' && (COST_KINDS.some((k) => k.id === b.kind) ? (b.kind as CostKind) : null);
  if (!kind) return { error: 'نوع هزینه را انتخاب کنید.' };

  const amount = Math.round(toLatinNumber(b.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'مبلغ باید عددی بزرگ‌تر از صفر باشد.' };
  if (amount > MAX_AMOUNT) return { error: 'مبلغ بیش از حد بزرگ است؛ آن را به تومان وارد کنید.' };

  let atISO: string | null = null;
  if (b.atISO !== undefined && b.atISO !== null && b.atISO !== '') {
    const t = new Date(String(b.atISO));
    if (Number.isNaN(t.getTime())) return { error: 'تاریخ هزینه خوانده نشد.' };
    // A cost dated in the future is almost always a typo, and it would land in
    // this period's numbers without ever having been paid.
    if (t.getTime() > Date.now() + 86_400_000) return { error: 'تاریخ هزینه نمی‌تواند در آینده باشد.' };
    atISO = t.toISOString();
  }

  const jobIdRaw = typeof b.jobId === 'string' && b.jobId.trim() ? b.jobId.trim().slice(0, 80) : null;
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 200) : '';
  return { kind, amount, atISO, jobId: jobIdRaw, note };
}

/** Reads the assumption form; any field left out keeps its previous value. */
export function readAssumptionInput(body: unknown, current: CostAssumption): { error: string } | { value: CostAssumption } {
  const b = (body || {}) as Record<string, unknown>;
  const next = normalizeAssumption({
    ...current,
    ...b,
    ...(b.hourlyRate !== undefined ? { hourlyRate: toLatinNumber(b.hourlyRate) } : {}),
    ...(b.minutesPerScorecard !== undefined ? { minutesPerScorecard: toLatinNumber(b.minutesPerScorecard) } : {}),
    ...(b.minutesPerComment !== undefined ? { minutesPerComment: toLatinNumber(b.minutesPerComment) } : {}),
    ...(b.minutesPerDecision !== undefined ? { minutesPerDecision: toLatinNumber(b.minutesPerDecision) } : {}),
  });
  if (toLatinNumber(b.hourlyRate) > MAX_HOURLY_RATE) return { error: 'نرخ ساعتی بیش از حد بزرگ است؛ آن را به تومان وارد کنید.' };
  return { value: next };
}

export function sumDirect(entries: Pick<CostEntry, 'amount'>[]): number {
  return entries.reduce((sum, e) => sum + e.amount, 0);
}

export function byKind(entries: CostEntry[]): { kind: CostKind; label: string; amount: number; count: number }[] {
  return COST_KINDS.map((k) => {
    const rows = entries.filter((e) => e.kind === k.id);
    return { kind: k.id, label: k.label, amount: sumDirect(rows), count: rows.length };
  })
    .filter((x) => x.count > 0)
    .sort((a, b) => b.amount - a.amount);
}

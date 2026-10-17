import React from 'react';
import { Check, Minus, Plus, Trash2 } from 'lucide-react';
import type {
  BooleanQuestion,
  Criterion,
  JobUnderstanding,
  MultiChoiceQuestion,
  ScreeningAnswers,
  ScreeningQuestion,
  SingleChoiceQuestion,
} from '../../types/screening';
import { toPersianDigits } from '../../lib/format';
import { IconButton } from '../ui';

// ------------------------------------------------------------ questionnaire ----

function boolValue(q: BooleanQuestion, answers: ScreeningAnswers): boolean {
  const v = answers[q.id];
  return typeof v === 'boolean' ? v : Boolean(q.defaultChecked);
}

function singleValue(q: SingleChoiceQuestion, answers: ScreeningAnswers): string {
  const v = answers[q.id];
  return typeof v === 'string' ? v : q.defaultValue ?? q.options[0]?.value ?? '';
}

function multiValue(q: MultiChoiceQuestion, answers: ScreeningAnswers): string[] {
  const v = answers[q.id];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return [v];
  return Array.isArray(q.defaultValues) ? q.defaultValues.map(String) : [];
}

/** Checkbox questionnaire — explicit answers always override defaults. */
export function QuestionsEditor({
  questions,
  answers,
  onChange,
  readOnly,
}: {
  questions: ScreeningQuestion[];
  answers: ScreeningAnswers;
  onChange?: (a: ScreeningAnswers) => void;
  readOnly?: boolean;
}) {
  const set = (id: string, v: boolean | string | string[]) => onChange?.({ ...answers, [id]: v });
  return (
    <div className="flex flex-col gap-2.5">
      {questions.map((q) => {
        if (q.type === 'boolean') {
          const on = boolValue(q, answers);
          return (
            <button
              key={q.id}
              type="button"
              disabled={readOnly}
              onClick={() => set(q.id, !on)}
              aria-pressed={on}
              className={`w-full flex items-center gap-3 p-3.5 rounded-[12px] border text-right transition-colors disabled:cursor-default ${
                on ? 'border-brand/40 bg-brand-tint' : 'border-line bg-surface hover:border-line-strong'
              }`}
            >
              <span
                className={`w-[20px] h-[20px] rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                  on ? 'bg-brand-strong border-brand-strong text-white' : 'bg-surface border-line-strong'
                }`}
              >
                {on && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
              </span>
              <span className="flex-1 text-[13.5px] font-semibold text-ink leading-relaxed">{q.label}</span>
              <span
                className={`text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                  q.kind === 'knockout' ? 'bg-low-soft text-low-ink' : 'bg-line-2 text-ink-3'
                }`}
              >
                {q.kind === 'knockout' ? 'شرط اصلی' : 'امتیاز مثبت'}
              </span>
            </button>
          );
        }
        const values = q.type === 'single' ? [singleValue(q, answers)] : multiValue(q, answers);
        return (
          <div key={q.id} className="p-3.5 rounded-[12px] border border-line bg-surface">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <span className="text-[13.5px] font-semibold text-ink">{q.label}</span>
              <span className="text-[11px] text-ink-4">{q.type === 'single' ? 'یک گزینه' : 'چند گزینه'}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((o) => {
                const active = values.includes(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    disabled={readOnly}
                    onClick={() => {
                      if (q.type === 'single') set(q.id, o.value);
                      else set(q.id, active ? values.filter((v) => v !== o.value) : [...values, o.value]);
                    }}
                    aria-pressed={active}
                    className={`h-9 px-3.5 rounded-full border text-[13px] font-semibold transition-colors disabled:cursor-default ${
                      active ? 'bg-brand-strong border-brand-strong text-white' : 'bg-surface border-line text-ink-2 hover:border-line-strong'
                    }`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------- criteria ----

/** Shares of 100 that always add up to exactly 100 (largest-remainder rounding). */
export function weightShares(weights: number[]): number[] {
  const total = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (!total) return weights.map(() => 0);
  const exact = weights.map((w) => (Math.max(0, w) / total) * 100);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((s, v) => s + v, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i]++;
    left--;
  }
  return shares;
}

/** A criterion title the server accepts. */
export const criterionTitleOk = (c: Criterion) => c.title.trim().length >= 2;

/** Editable weighted criteria; weights are shown as shares of 100. */
export function CriteriaEditor({
  understanding,
  onChange,
  readOnly,
}: {
  understanding: JobUnderstanding;
  onChange?: (u: JobUnderstanding) => void;
  readOnly?: boolean;
}) {
  const criteria = understanding.criteria;
  const shares = weightShares(criteria.map((c) => c.weight));
  const [justAdded, setJustAdded] = React.useState<string | null>(null);
  const update = (next: Criterion[]) => onChange?.({ ...understanding, criteria: next });
  const patch = (id: string, p: Partial<Criterion>) => update(criteria.map((c) => (c.id === id ? { ...c, ...p } : c)));
  return (
    <div className="flex flex-col gap-2.5">
      {criteria.map((c, i) => {
        const share = shares[i];
        const titleMissing = !readOnly && !criterionTitleOk(c);
        return (
          <div key={c.id} className="rounded-[12px] border border-line bg-surface p-3.5">
            <div className="flex items-start gap-3">
              {readOnly ? (
                <p className="flex-1 text-[13.5px] font-semibold text-ink leading-relaxed">{c.title}</p>
              ) : (
                <input
                  value={c.title}
                  onChange={(e) => patch(c.id, { title: e.target.value })}
                  aria-label="عنوان معیار"
                  aria-invalid={titleMissing}
                  placeholder="عنوان معیار را بنویسید، مثلاً «تجربه فروش B2B»"
                  maxLength={140}
                  autoFocus={justAdded === c.id}
                  className={`flex-1 min-w-0 bg-transparent text-[13.5px] font-semibold text-ink leading-relaxed border-b hover:border-line focus:border-brand focus:outline-none py-0.5 placeholder:font-normal placeholder:text-ink-4 ${
                    titleMissing ? 'border-low/50' : 'border-transparent'
                  }`}
                />
              )}
              <span className="text-[13px] font-extrabold text-ink hv-num shrink-0 w-10 text-left">{toPersianDigits(share)}٪</span>
              {!readOnly && criteria.length > 2 && (
                <IconButton icon={Trash2} label="حذف معیار" size="sm" tone="danger" onClick={() => update(criteria.filter((x) => x.id !== c.id))} />
              )}
            </div>
            <div className="flex items-center gap-3 mt-2.5">
              <div className="flex-1 h-1.5 rounded-full bg-line-2 overflow-hidden">
                <div className="h-full rounded-full bg-brand" style={{ width: `${share}%` }} />
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <IconButton icon={Minus} label="کاهش وزن" size="sm" disabled={c.weight <= 1} onClick={() => patch(c.id, { weight: Math.max(1, c.weight - 5) })} />
                  <IconButton icon={Plus} label="افزایش وزن" size="sm" disabled={c.weight >= 100} onClick={() => patch(c.id, { weight: Math.min(100, c.weight + 5) })} />
                </div>
              )}
              <label className={`relative inline-flex items-center gap-1.5 text-[12px] font-semibold ${readOnly ? '' : 'cursor-pointer'} ${c.mustHave ? 'text-low-ink' : 'text-ink-3'}`}>
                <input type="checkbox" className="sr-only peer" checked={c.mustHave} disabled={readOnly} onChange={(e) => patch(c.id, { mustHave: e.target.checked })} />
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-brand/50 peer-focus-visible:ring-offset-1 ${
                    c.mustHave ? 'bg-low-ink border-low-ink text-white' : 'border-line-strong'
                  }`}
                >
                  {c.mustHave && <Check className="w-3 h-3" strokeWidth={3} />}
                </span>
                الزامی
              </label>
            </div>
          </div>
        );
      })}
      {!readOnly && criteria.length < 8 && (
        <button
          type="button"
          onClick={() => {
            const id = `c${Date.now().toString(36)}`;
            setJustAdded(id);
            update([...criteria, { id, title: '', weight: 10, mustHave: false }]);
          }}
          className="h-11 rounded-[12px] border border-dashed border-line-strong text-[13px] font-semibold text-ink-3 hover:text-brand-ink hover:border-brand/40 inline-flex items-center justify-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          افزودن معیار
        </button>
      )}
    </div>
  );
}

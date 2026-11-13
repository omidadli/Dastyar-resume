import React, { useEffect, useState } from 'react';
import { ClipboardCheck, Loader2, Star, UserRound } from 'lucide-react';
import { Button, Chip, Field, Modal, TextArea, toast } from '../ui';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { faRelative, toPersianDigits } from '../../lib/format';
import type { ScorecardSummary } from '../../types/pipeline';
import { FEEDBACK_LABEL } from '../../types/pipeline';
import type { Criterion } from '../../types/screening';

/**
 * «کارت ارزیابی» — what the interviewers thought, kept apart from the AI score.
 *
 * One record per reviewer (saving again replaces your own opinion), so the panel
 * can show «۳ نفر ارزیابی کرده‌اند، میانگین ۴ از ۵» without inventing an average
 * across different people's scales.
 */
export function ScorecardSection({
  resumeId,
  criteria,
  interviewId,
  compact,
}: {
  resumeId: string;
  criteria: Criterion[];
  interviewId?: string | null;
  compact?: boolean;
}) {
  const [summary, setSummary] = useState<ScorecardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    api.resumes
      .feedback(resumeId)
      .then((res) => setSummary(res.summary))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
  }, [resumeId]);

  useEffect(load, [load]);

  const tone = !summary?.count
    ? 'neutral'
    : summary.byRecommendation.strong_yes + summary.byRecommendation.yes > summary.byRecommendation.no + summary.byRecommendation.strong_no
    ? 'brand'
    : 'warning';

  return (
    <section>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[13px] font-semibold text-ink-2 flex items-center gap-1.5">
          <ClipboardCheck className="w-[15px] h-[15px] text-ink-3" strokeWidth={1.9} />
          ارزیابی مصاحبه‌گران
          {summary?.count ? (
            <Chip tone={tone as 'brand' | 'warning' | 'neutral'} className="ms-1">
              {toPersianDigits(summary.count)} ارزیابی
            </Chip>
          ) : null}
        </span>
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {summary?.count ? 'ثبت/ویرایش نظر من' : 'ثبت ارزیابی'}
        </Button>
      </div>

      {loading ? (
        <p className="text-[12px] text-ink-4 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> در حال خواندن ارزیابی‌ها…
        </p>
      ) : !summary?.count ? (
        <p className="text-[12.5px] text-ink-3 leading-relaxed">
          هنوز کسی ارزیابی ساختاریافته ثبت نکرده است. امتیاز هوش مصنوعی جای نظر مصاحبه‌گر را نمی‌گیرد؛ بعد از جلسه، نظر خود را ثبت کنید.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="outline">میانگین معیارها: {toPersianDigits(summary.averageScore)} از ۵</Chip>
            {(['strong_yes', 'yes', 'no', 'strong_no'] as const)
              .filter((k) => summary.byRecommendation[k] > 0)
              .map((k) => (
                <Chip key={k} tone={k === 'strong_yes' || k === 'yes' ? 'brand' : 'danger'}>
                  {FEEDBACK_LABEL[k]}: {toPersianDigits(summary.byRecommendation[k])}
                </Chip>
              ))}
          </div>
          <ul className={`space-y-2 ${compact ? '' : ''}`}>
            {summary.feedback.map((f) => (
              <li key={f.id} className="rounded-[12px] border border-line p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <UserRound className="w-3.5 h-3.5 text-ink-4" strokeWidth={2} />
                  <span className="text-[12.5px] font-semibold text-ink">{f.reviewerName}</span>
                  <Chip tone={f.recommendation === 'strong_yes' || f.recommendation === 'yes' ? 'brand' : 'danger'}>
                    {FEEDBACK_LABEL[f.recommendation]}
                  </Chip>
                  <span className="text-[11px] text-ink-4">{faRelative(f.atISO)}</span>
                </div>
                {f.criteria.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {f.criteria.map((c) => (
                      <span key={c.criterionId} className="inline-flex items-center gap-1 text-[11.5px] text-ink-2 bg-canvas border border-line rounded-md px-1.5 py-0.5">
                        <Star className="w-3 h-3 text-review" strokeWidth={2} fill="currentColor" />
                        {c.title}: {toPersianDigits(c.score)}/۵
                      </span>
                    ))}
                  </div>
                )}
                {f.notes && <p className="text-[12.5px] text-ink-3 mt-2 leading-relaxed whitespace-pre-line">{f.notes}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {open && (
        <FeedbackModal
          resumeId={resumeId}
          criteria={criteria}
          interviewId={interviewId}
          onClose={() => setOpen(false)}
          onSaved={(res) => {
            setSummary(res);
            setError(null);
            setOpen(false);
            emitChange('activity');
            toast('ارزیابی شما ثبت شد.');
          }}
          error={error}
          setError={setError}
        />
      )}
    </section>
  );
}

function FeedbackModal({
  resumeId,
  criteria,
  interviewId,
  onClose,
  onSaved,
  error,
  setError,
}: {
  resumeId: string;
  criteria: Criterion[];
  interviewId?: string | null;
  onClose: () => void;
  onSaved: (s: ScorecardSummary) => void;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');
  const [recommendation, setRecommendation] = useState<'strong_yes' | 'yes' | 'no' | 'strong_no' | ''>('');
  const [busy, setBusy] = useState(false);

  // A panel of more than eight criteria is not a scorecard, it is a form.
  const shown = criteria.slice(0, 8);

  async function save() {
    if (!recommendation) return setError('نظر نهایی خود را انتخاب کنید.');
    setError(null);
    setBusy(true);
    try {
      const res = await api.resumes.saveFeedback(resumeId, {
        interviewId: interviewId || null,
        recommendation,
        criteria: shown
          .filter((c) => scores[c.id])
          .map((c) => ({ criterionId: c.id, score: scores[c.id], note: '' })),
        notes,
      });
      onSaved(res.summary);
    } catch (err: any) {
      setError(err?.message || 'ثبت ارزیابی ممکن نشد.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="کارت ارزیابی مصاحبه"
      description="نظر خود را جدا از امتیاز هوش مصنوعی ثبت کنید؛ همهٔ اعضای تیم آن را می‌بینند."
      size="md"
      footer={
        <div className="flex items-center justify-between gap-2 w-full">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button onClick={() => void save()} loading={busy}>
            ثبت ارزیابی
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error && (
          <p role="alert" className="text-[12.5px] text-low-ink font-medium">
            {error}
          </p>
        )}

        <Field label="نظر نهایی">
          <div className="grid grid-cols-2 gap-2">
            {(['strong_yes', 'yes', 'no', 'strong_no'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setRecommendation(k)}
                aria-pressed={recommendation === k}
                className={`h-10 rounded-control border text-[13px] font-semibold transition-colors ${
                  recommendation === k
                    ? k === 'strong_yes' || k === 'yes'
                      ? 'bg-brand-soft border-brand/40 text-brand-stronger'
                      : 'bg-low-soft border-low/40 text-low-ink'
                    : 'bg-surface border-line text-ink-2 hover:border-line-strong'
                }`}
              >
                {FEEDBACK_LABEL[k]}
              </button>
            ))}
          </div>
        </Field>

        {shown.length > 0 && (
          <div>
            <p className="text-[13px] font-semibold text-ink-2 mb-2">امتیاز معیارها (اختیاری، ۱ تا ۵)</p>
            <div className="space-y-2">
              {shown.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-3 rounded-[10px] border border-line px-3 py-2">
                  <span className="text-[12.5px] text-ink-2 truncate">{c.title}</span>
                  <div className="flex items-center gap-1 shrink-0" role="group" aria-label={`امتیاز ${c.title}`}>
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-label={`${n} از ۵`}
                        aria-pressed={scores[c.id] === n}
                        onClick={() => setScores((s) => ({ ...s, [c.id]: n }))}
                        className={`w-7 h-7 rounded-md text-[12px] font-bold border transition-colors ${
                          scores[c.id] === n ? 'bg-brand-strong border-brand-strong text-white' : 'bg-surface border-line text-ink-3 hover:border-line-strong'
                        }`}
                      >
                        {toPersianDigits(n)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <Field label="یادداشت مصاحبه" hint="شاهد مشخص بنویسید؛ «خوب بود» به تصمیم کمک نمی‌کند.">
          <TextArea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
      </div>
    </Modal>
  );
}

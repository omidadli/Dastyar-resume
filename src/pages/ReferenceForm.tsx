/**
 * The referee's page — the one screen in this product used by someone who has
 * never heard of HOVIDA and did not ask for an account.
 *
 * So it is deliberately small: who is asking, about whom, six questions, three
 * minutes, and a visible way to say no. No sign-in, no marketing, no cookie
 * banner, nothing to install.
 *
 * Two promises shown on the page, because they are true:
 *   • the answers go to the hiring team only — never to the candidate;
 *   • «عذر خواهی» is a complete answer: it stops every further reminder.
 */
import React, { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, MessageSquareQuote, ShieldCheck, Star } from 'lucide-react';
import { Button, Callout, Field, Spinner, TextArea, toast } from '../components/ui';
import { HovidaMark } from '../components/brand/Logo';
import { api, ApiError } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import { toPersianDigits } from '../lib/format';
import { REHIRE_LABELS, RELATION_LABEL, type PublicReference, type RefereeRelation } from '../types/references';

function ScoreRow({
  label,
  hint,
  value,
  onChange,
  lowLabel,
  highLabel,
}: {
  label: string;
  hint?: string;
  value: number | null;
  onChange: (v: number) => void;
  lowLabel: string;
  highLabel: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13.5px] font-bold text-ink">{label}</p>
      {hint && <p className="text-[12px] text-ink-3 leading-relaxed">{hint}</p>}
      <div className="flex items-center gap-1.5 mt-1" role="group" aria-label={label}>
        {[1, 2, 3, 4, 5].map((n) => {
          const on = value !== null && n <= value;
          return (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              aria-pressed={value === n}
              aria-label={`${label}: ${toPersianDigits(n)} از ۵`}
              className={`w-10 h-10 rounded-control border flex items-center justify-center transition-colors ${
                on ? 'border-brand bg-brand-soft text-brand-stronger' : 'border-line text-ink-4 hover:border-line-strong'
              }`}
            >
              <Star className={`w-[18px] h-[18px] ${on ? 'fill-current' : ''}`} strokeWidth={1.8} />
            </button>
          );
        })}
        <span className="text-[11.5px] text-ink-4 mr-1">{value ? `${toPersianDigits(value)} از ۵` : 'بی‌پاسخ'}</span>
      </div>
      <div className="flex justify-between text-[10.5px] text-ink-4">
        <span>{lowLabel}</span>
        <span>{highLabel}</span>
      </div>
    </div>
  );
}

export default function ReferenceForm({ token }: { token: string }) {
  useTitle('درخواست معرفی');
  const [ref, setRef] = useState<PublicReference | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [busy, setBusy] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [scores, setScores] = useState<Record<string, number | null>>({ performance: null, collaboration: null, reliability: null, wouldRehire: null });
  const [duration, setDuration] = useState('');
  const [strengths, setStrengths] = useState('');
  const [concerns, setConcerns] = useState('');

  useEffect(() => {
    api.references.public
      .get(token)
      .then((r) => {
        setRef(r.reference);
        setState('ready');
        // One open is a real signal to the hiring team («باز شد، پاسخ نداده»).
        if (r.reference.status === 'sent') {
          api.references.public.open(token).then((o) => setRef(o.reference)).catch(() => undefined);
        }
      })
      .catch(() => setState('missing'));
  }, [token]);

  const submit = async () => {
    if (scores.wouldRehire === null) {
      toast('لطفاً به پرسش «دوباره همکاری می‌کردید؟» پاسخ دهید.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.references.public.answer(token, {
        duration: duration.trim() || undefined,
        performance: scores.performance ?? undefined,
        collaboration: scores.collaboration ?? undefined,
        reliability: scores.reliability ?? undefined,
        wouldRehire: scores.wouldRehire ?? undefined,
        strengths: strengths.trim() || undefined,
        concerns: concerns.trim() || undefined,
      });
      setRef(r.reference);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const declineNow = async () => {
    setBusy(true);
    try {
      const r = await api.references.public.decline(token, { reason: declineReason.trim() || undefined });
      setRef(r.reference);
      setDeclining(false);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas">
        <Spinner />
      </div>
    );
  }

  if (state === 'missing' || !ref) {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas px-4">
        <div className="hv-card p-8 max-w-md text-center">
          <MessageSquareQuote className="w-8 h-8 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <h1 className="text-[17px] font-bold text-ink">این لینک معتبر نیست</h1>
          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
            ممکن است لینک کامل کپی نشده باشد یا درخواست پس گرفته شده باشد. از کسی که برایتان نوشته بخواهید لینک تازه بفرستد.
          </p>
        </div>
      </div>
    );
  }

  const done = ref.status === 'completed';
  const declined = ref.status === 'declined';
  const expired = ref.status === 'expired';

  return (
    <div className="min-h-screen bg-canvas py-8 px-4" dir="rtl">
      <div className="max-w-[560px] mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <HovidaMark size={28} />
          <div className="min-w-0">
            <p className="text-[12px] text-ink-3">درخواست معرفی از طرف</p>
            <p className="text-[14px] font-extrabold text-ink truncate">{ref.org.name}</p>
          </div>
        </div>

        <div className="hv-card p-5 sm:p-6">
          <p className="text-[12px] font-semibold text-brand-strong mb-1.5">معرفی شغلی</p>
          <h1 className="text-[20px] sm:text-[22px] font-extrabold text-ink leading-snug">
            {ref.refereeName} عزیز، دربارهٔ {ref.candidateName} نظر شما را می‌خواهیم
          </h1>
          <p className="text-[13.5px] text-ink-2 mt-2 leading-[1.95]">
            {ref.candidateName} شما را به‌عنوان {RELATION_LABEL[ref.relation]?.toLowerCase()} معرفی کرده
            {ref.jobTitle ? ` در فرایند استخدام «${ref.jobTitle}»` : ''}. چند سؤال کوتاه دربارهٔ تجربهٔ همکاری با ایشان — کمتر از سه دقیقه.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> پاسخ شما فقط به تیم جذب این سازمان می‌رسد
            </span>
            <span>به کارجو نشان داده نمی‌شود</span>
          </div>
        </div>

        {done ? (
          <div className="hv-card p-6 text-center">
            <CheckCircle2 className="w-9 h-9 text-brand-strong mx-auto mb-3" />
            <h2 className="text-[17px] font-bold text-ink">پاسخ شما ثبت شد</h2>
            <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
              سپاسگزاریم{ref.completedAtJalali ? ` — ${ref.completedAtJalali}` : ''}. پاسخ شما در اختیار تیم جذب {ref.org.name} است و کارجو آن را نمی‌بیند.
            </p>
          </div>
        ) : declined ? (
          <div className="hv-card p-6 text-center">
            <h2 className="text-[17px] font-bold text-ink">عذر شما پذیرفته شد</h2>
            <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">دیگر پیگیری نمی‌کنیم. ممنون که اطلاع دادید.</p>
          </div>
        ) : expired ? (
          <Callout tone="warning" title="این لینک منقضی شده است">
            برای پاسخ دادن، از تیم جذب {ref.org.name} بخواهید لینک تازه بفرستد.
          </Callout>
        ) : (
          <>
            <div className="hv-card p-5 sm:p-6 flex flex-col gap-6">
              <Field label="چند وقت با ایشان همکاری کردید؟" optional hint="مثلاً «دو سال، ۱۳۹۹ تا ۱۴۰۱» — تقریبی هم کافی است.">
                <input
                  value={duration}
                  onChange={(e) => setDuration(e.target.value)}
                  maxLength={120}
                  placeholder="از … تا …"
                  className="w-full h-11 bg-surface border border-line rounded-control text-sm px-3.5 text-ink hover:border-line-strong focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
              </Field>

              {ref.dimensions.map((d) => (
                <ScoreRow
                  key={d.id}
                  label={d.label}
                  hint={d.hint}
                  value={scores[d.id] ?? null}
                  onChange={(v) => setScores((s) => ({ ...s, [d.id]: v }))}
                  lowLabel="ضعیف"
                  highLabel="عالی"
                />
              ))}

              <div className="rounded-control border border-line-2 bg-canvas p-3">
                <p className="text-[13.5px] font-bold text-ink mb-2">اگر امروز امکانش بود، دوباره با ایشان همکاری می‌کردید؟</p>
                <div className="flex flex-col gap-1.5">
                  {[5, 4, 3, 2, 1].map((n) => (
                    <label
                      key={n}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-[9px] border cursor-pointer transition-colors ${
                        scores.wouldRehire === n ? 'border-brand bg-brand-tint' : 'border-transparent hover:bg-surface'
                      }`}
                    >
                      <input
                        type="radio"
                        name="rehire"
                        checked={scores.wouldRehire === n}
                        onChange={() => setScores((s) => ({ ...s, wouldRehire: n }))}
                        className="accent-[var(--color-brand)]"
                      />
                      <span className="text-[13px] text-ink-2">{REHIRE_LABELS[n]}</span>
                    </label>
                  ))}
                </div>
              </div>

              <Field label="چه چیزی خوب بود؟" optional hint="یک یا دو جمله؛ همان چیزی که به یک همکار دیگر می‌گویید.">
                <TextArea value={strengths} onChange={(e) => setStrengths(e.target.value)} rows={3} maxLength={1200} />
              </Field>
              <Field label="چه چیزی را باید بدانند؟" optional hint="نقطهٔ قابل بهبود یا نکته‌ای که بهتر است پیش از استخدام روشن شود.">
                <TextArea value={concerns} onChange={(e) => setConcerns(e.target.value)} rows={3} maxLength={1200} />
              </Field>

              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void submit()} loading={busy}>
                  ثبت پاسخ
                </Button>
                <Button variant="ghost" onClick={() => setDeclining((v) => !v)} disabled={busy}>
                  ترجیح می‌دهم پاسخ ندهم
                </Button>
              </div>
              {declining && (
                <div className="rounded-control border border-line p-3 flex flex-col gap-2">
                  <p className="text-[12.5px] text-ink-2">
                    اشکالی ندارد. اگر بخواهید می‌توانید دلیلش را بنویسید (اختیاری)؛ بعد از ثبت، دیگر پیگیری نمی‌کنیم.
                  </p>
                  <TextArea value={declineReason} onChange={(e) => setDeclineReason(e.target.value)} rows={2} maxLength={300} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void declineNow()} loading={busy}>
                      ثبت عذر خواهی
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeclining(false)}>
                      بازگشت
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <p className="text-[11.5px] text-ink-4 text-center leading-relaxed inline-flex items-center justify-center gap-1.5">
              <ArrowRight className="w-3.5 h-3.5" />
              این صفحه بدون حساب کاربری باز می‌شود؛ پاسخ‌ها رمزنگاری‌شده در سرور {ref.org.name} نگه‌داری می‌شود.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

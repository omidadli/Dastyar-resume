import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Heart, Send } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Spinner, TextArea, toast } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import type { PublicSurvey } from '../types/survey';
import { toPersianDigits } from '../lib/format';

/**
 * The candidate's survey page. No account, one link, three questions:
 * a 0–10 recommendation score and three 1–5 dimensions, all optional except
 * the score. After the answer the same link shows a thank-you note.
 */
export default function Survey({ token }: { token: string }) {
  useTitle('نظر شما');
  const [survey, setSurvey] = useState<PublicSurvey | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [score, setScore] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.surveys.public
      .get(token)
      .then((r) => {
        setSurvey(r.survey);
        setState('ready');
        // Counting the open, once, only while the survey can still be answered.
        if (r.survey.status !== 'answered') {
          api.surveys.public.open(token).then((o) => setSurvey(o.survey)).catch(() => undefined);
        }
      })
      .catch(() => setState('missing'));
  }, [token]);

  const submit = async () => {
    if (score === null) {
      toast('لطفاً یک عدد بین ۰ تا ۱۰ انتخاب کنید.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.surveys.public.answer(token, {
        score,
        comment: comment.trim() || undefined,
        answers: answers as any,
      });
      setSurvey(r.survey);
      toast(r.thanks);
    } catch (err: any) {
      toast(err?.message || 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const answered = survey?.status === 'answered';
  const expired = survey?.status === 'expired';

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">تجربهٔ استخدام</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[680px] mx-auto">
          {state === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {state === 'missing' && (
            <Callout tone="warning" title="این لینک معتبر نیست">
              ممکن است نشانی ناقص کپی شده باشد. اگر لینک را از منابع انسانی گرفته‌اید، از آن‌ها بخواهید دوباره بفرستند.
            </Callout>
          )}

          {state === 'ready' && survey && (
            <div className="bg-surface border border-line-2 rounded-[16px] p-5 sm:p-8">
              <div className="flex items-start gap-3 mb-5">
                <span className="w-11 h-11 rounded-[12px] bg-brand-soft flex items-center justify-center shrink-0">
                  <Heart className="w-5 h-5 text-brand-ink" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-[17px] font-extrabold text-ink leading-snug">
                    {survey.candidateName} عزیز، نظر شما برای ما مهم است
                  </h1>
                  <p className="text-[12.5px] text-ink-3 mt-1">
                    {survey.org.name}
                    {survey.jobTitle ? ` — ${survey.jobTitle}` : ''}
                  </p>
                </div>
              </div>

              {answered && (
                <div className="text-center py-8">
                  <CheckCircle2 className="w-14 h-14 text-brand mx-auto" strokeWidth={1.6} />
                  <p className="text-[16px] font-bold text-ink mt-3">پاسخ شما ثبت شد؛ سپاسگزاریم.</p>
                  <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
                    پاسخ شما فقط برای بهترشدن فرایند جذب استفاده می‌شود.
                    {survey.answeredAtJalali ? ` (${survey.answeredAtJalali})` : ''}
                  </p>
                </div>
              )}

              {expired && !answered && (
                <Callout tone="info" icon={Clock3}>
                  مهلت پاسخ به این نظرسنجی به پایان رسیده است. اگر مایل به ثبت نظر هستید، با منابع انسانی تماس بگیرید.
                </Callout>
              )}

              {!answered && !expired && (
                <>
                  <p className="text-[14px] font-semibold text-ink leading-relaxed mb-3">{survey.prompt}</p>

                  <div className="grid grid-cols-11 gap-1 sm:gap-1.5 mb-1" role="radiogroup" aria-label="امتیاز ۰ تا ۱۰">
                    {Array.from({ length: 11 }, (_, n) => n).map((n) => {
                      const selected = score === n;
                      return (
                        <button
                          key={n}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setScore(n)}
                          className={`h-10 rounded-[9px] border text-[13px] font-bold transition hv-num ${
                            selected
                              ? 'bg-brand text-white border-brand'
                              : n <= 6
                                ? 'border-line-2 text-ink-3 hover:border-low/50'
                                : n <= 8
                                  ? 'border-line-2 text-ink-2 hover:border-review/60'
                                  : 'border-line-2 text-ink-2 hover:border-brand/60'
                          }`}
                        >
                          {toPersianDigits(n)}
                        </button>
                      );
                    })}
                  </div>
                  <div className="flex justify-between text-[11px] text-ink-4 mb-5">
                    <span>اصلاً معرفی نمی‌کنم</span>
                    <span>قطعاً معرفی می‌کنم</span>
                  </div>

                  <div className="space-y-3 mb-5">
                    {survey.dimensions.map((dim) => (
                      <div key={dim.id} className="rounded-[12px] border border-line-2 p-3">
                        <p className="text-[13px] font-semibold text-ink">{dim.label}</p>
                        <p className="text-[11.5px] text-ink-4 mt-0.5 mb-2">{dim.hint}</p>
                        <div className="flex gap-1.5">
                          {[1, 2, 3, 4, 5].map((n) => {
                            const selected = answers[dim.id] === n;
                            return (
                              <button
                                key={n}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => setAnswers((prev) => ({ ...prev, [dim.id]: selected ? (undefined as any) : n }))}
                                className={`w-9 h-9 rounded-[8px] border text-[12.5px] font-bold transition hv-num ${
                                  selected ? 'bg-brand text-white border-brand' : 'border-line-2 text-ink-3'
                                }`}
                              >
                                {toPersianDigits(n)}
                              </button>
                            );
                          })}
                          <span className="text-[11px] text-ink-4 self-center mr-2">۱ = خیلی ضعیف، ۵ = عالی</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <TextArea
                    label="اگر نکته‌ای دارید بنویسید (اختیاری)"
                    value={comment}
                    onChange={(e) => setComment(e.target.value.slice(0, 1200))}
                    rows={4}
                    hint={`${toPersianDigits(comment.length)} از ۱۲۰۰ کاراکتر`}
                    placeholder="چه چیزی خوب بود؟ چه چیزی را می‌شد بهتر کرد؟"
                  />

                  <div className="flex flex-wrap items-center gap-3 mt-5">
                    <Button icon={Send} onClick={() => void submit()} loading={busy} disabled={busy || score === null}>
                      ثبت نظر
                    </Button>
                    <span className="text-[11.5px] text-ink-4">بی‌نام ارسال می‌شود؛ فقط تیم منابع انسانی آن را می‌بیند.</span>
                  </div>
                </>
              )}
            </div>
          )}

          <p className="text-center text-[11px] text-ink-4 mt-6">
            این صفحه با هویدا ساخته شده است — سامانهٔ غربالگری و جذب
          </p>
        </div>
      </main>
    </div>
  );
}

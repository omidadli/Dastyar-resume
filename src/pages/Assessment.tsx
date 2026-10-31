import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, ClipboardList, Clock3, Send, ShieldCheck } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, Spinner, toast } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import { toPersianDigits } from '../lib/format';
import type { PublicAssessment } from '../types/assessment';

const PER_PAGE = 4;

/**
 * The candidate's test page. No account, one link, and the questions are
 * paged four at a time so a fifteen-item behavioural test does not feel like a
 * wall of radio buttons. The page never receives the scoring key.
 */
export default function Assessment({ token }: { token: string }) {
  useTitle('ارزیابی شغلی');
  const [data, setData] = useState<PublicAssessment | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.assessments.public
      .get(token)
      .then((r) => {
        setData(r.assessment);
        setState('ready');
        if (r.canAnswer) api.assessments.public.start(token).then((s) => setData(s.assessment)).catch(() => undefined);
      })
      .catch(() => setState('missing'));
  }, [token]);

  const questions = data?.questions || [];
  const pages = useMemo(() => {
    const out: PublicAssessment['questions'][] = [];
    for (let i = 0; i < questions.length; i += PER_PAGE) out.push(questions.slice(i, i + PER_PAGE));
    return out.length ? out : [[]];
  }, [questions]);

  const answeredCount = questions.filter((q) => answers[q.id] !== undefined && answers[q.id] !== '').length;
  const total = questions.length;
  const complete = total > 0 && answeredCount === total;
  const current = pages[Math.min(page, pages.length - 1)] || [];
  const pageComplete = current.every((q) => answers[q.id] !== undefined && answers[q.id] !== '');

  const submit = async () => {
    if (!complete) {
      toast('همهٔ سؤال‌ها را پاسخ بدهید؛ پاسخ ناقص ثبت نمی‌شود.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.assessments.public.submit(token, answers);
      setData(r.assessment);
      toast(r.thanks);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      toast(err?.message || 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const done = data?.status === 'completed';
  const closed = data?.status === 'expired' || data?.status === 'cancelled';

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">ارزیابی شغلی</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[720px] mx-auto">
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

          {state === 'ready' && data && (
            <div className="bg-surface border border-line-2 rounded-[16px] p-5 sm:p-8">
              <div className="flex items-start gap-3 mb-5">
                <span className="w-11 h-11 rounded-[12px] bg-brand-soft flex items-center justify-center shrink-0">
                  <ClipboardList className="w-5 h-5 text-brand-ink" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-[17px] font-extrabold text-ink leading-snug">
                    {data.candidateName ? `${data.candidateName} عزیز، ` : ''}
                    {data.template.name}
                  </h1>
                  <p className="mt-1 text-[12.5px] text-ink-3 leading-relaxed">
                    {data.orgName}
                    {data.jobTitle ? ` — نقش «${data.jobTitle}»` : ''}
                  </p>
                </div>
              </div>

              {done && (
                <div className="mt-2">
                  <Callout tone="brand" icon={CheckCircle2} title="پاسخ شما ثبت شد">
                    از وقتی که گذاشتید سپاسگزاریم. نتیجه در کنار رزومه و گفت‌وگوی ما خوانده می‌شود؛ خودِ آزمون جای مصاحبه را نمی‌گیرد.
                  </Callout>
                </div>
              )}

              {closed && !done && (
                <Callout tone="warning" title={data.status === 'cancelled' ? 'این آزمون لغو شده است' : 'مهلت این آزمون گذشته است'}>
                  {data.status === 'cancelled'
                    ? 'اگر فکر می‌کنید اشتباهی رخ داده، با منابع انسانی تماس بگیرید.'
                    : `مهلت پاسخ‌دهی تا ${data.expiresAtJalali} بود. اگر هنوز مایل به ادامه هستید، با منابع انسانی تماس بگیرید تا لینک تازه بفرستند.`}
                </Callout>
              )}

              {!done && !closed && (
                <>
                  {page === 0 && (
                    <>
                      <p className="text-[13px] text-ink-2 leading-relaxed bg-canvas border border-line-2 rounded-[12px] px-3.5 py-3 mb-5">
                        {data.intro}
                      </p>
                      <div className="flex flex-wrap items-center gap-2 mb-5 text-[11.5px] text-ink-3">
                        <Chip tone="neutral">
                          <Clock3 className="w-3.5 h-3.5" /> حدود {toPersianDigits(data.durationMinutes)} دقیقه
                        </Chip>
                        <Chip tone="neutral">{toPersianDigits(total)} سؤال</Chip>
                        <Chip tone="outline">یک‌بار قابل پاسخ</Chip>
                      </div>
                      <Callout tone="info" icon={ShieldCheck} className="mb-5">
                        پاسخ‌ها فقط برای همین ارزیابی استفاده می‌شود. هیچ پاسخ درست یا غلطی وجود ندارد؛ رفتار واقعی خودتان را انتخاب کنید.
                      </Callout>
                    </>
                  )}

                  <div className="flex items-center justify-between mb-3 text-[12px] text-ink-3">
                    <span>
                      صفحهٔ {toPersianDigits(page + 1)} از {toPersianDigits(pages.length)}
                    </span>
                    <span className="hv-num">
                      {toPersianDigits(answeredCount)} از {toPersianDigits(total)} پاسخ داده شده
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-line-2 overflow-hidden mb-6">
                    <div
                      className="h-full bg-brand-strong transition-[width] duration-300"
                      style={{ width: `${total ? Math.round((answeredCount / total) * 100) : 0}%` }}
                    />
                  </div>

                  <div className="flex flex-col gap-6">
                    {current.map((q, i) => {
                      const number = page * PER_PAGE + i + 1;
                      const value = answers[q.id];
                      return (
                        <div key={q.id}>
                          <p className="text-[13.5px] font-semibold text-ink leading-relaxed mb-2">
                            <span className="text-ink-4 hv-num ml-1">{toPersianDigits(number)}.</span>
                            {q.text}
                          </p>
                          {q.hint && <p className="text-[11.5px] text-ink-3 mb-2">{q.hint}</p>}
                          {q.type === 'single' ? (
                            <div className="flex flex-col gap-2" role="radiogroup" aria-label={q.text}>
                              {(q.options || []).map((o) => {
                                const on = value === o.id;
                                return (
                                  <button
                                    key={o.id}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.id }))}
                                    className={`text-right px-3.5 py-2.5 rounded-[10px] border text-[13px] leading-relaxed transition-colors ${
                                      on ? 'border-brand-strong bg-brand-soft text-ink font-semibold' : 'border-line-2 bg-surface text-ink-2 hover:bg-canvas'
                                    }`}
                                  >
                                    {o.label}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-2" role="radiogroup" aria-label={q.text}>
                              {data.scale.map((s) => {
                                const on = Number(value) === s.value;
                                return (
                                  <button
                                    key={s.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={on}
                                    onClick={() => setAnswers((a) => ({ ...a, [q.id]: s.value }))}
                                    className={`text-right px-3.5 py-2 rounded-[10px] border text-[13px] transition-colors ${
                                      on ? 'border-brand-strong bg-brand-soft text-ink font-semibold' : 'border-line-2 bg-surface text-ink-2 hover:bg-canvas'
                                    }`}
                                  >
                                    {s.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  <div className="flex items-center justify-between gap-3 mt-7 pt-5 border-t border-line-2">
                    <Button
                      variant="ghost"
                      icon={ArrowRight}
                      disabled={page === 0}
                      onClick={() => {
                        setPage((p) => Math.max(0, p - 1));
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                    >
                      قبلی
                    </Button>
                    {page < pages.length - 1 ? (
                      <Button
                        icon={ArrowLeft}
                        onClick={() => {
                          if (!pageComplete) {
                            toast('این صفحه چند پاسخ ناتمام دارد؛ همه را مشخص کنید.', 'error');
                            return;
                          }
                          setPage((p) => Math.min(pages.length - 1, p + 1));
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        بعدی
                      </Button>
                    ) : (
                      <Button icon={Send} loading={busy} onClick={submit} disabled={!complete}>
                        ثبت پاسخ‌ها
                      </Button>
                    )}
                  </div>
                </>
              )}

              <p className="mt-6 text-[11px] text-ink-4 leading-relaxed">
                مهلت پاسخ‌دهی: {data.expiresAtJalali}. این صفحه نتیجه را نشان نمی‌دهد؛ نتیجه در فرایند بررسی منابع انسانی خوانده می‌شود.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

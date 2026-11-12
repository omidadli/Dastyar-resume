/**
 * The candidate's page for «سنجش نرم‌شده».
 *
 * Deliberate choices on this screen:
 *   • the honest instruction («درست و غلط ندارند، رفتار سه ماه گذشته») comes
 *     before the first item, not in small print;
 *   • items are shown five at a time, so the page is usable on a phone and no one
 *     scrolls past a statement without seeing it;
 *   • every answer is saved to the server as it is given — a closed tab is not a
 *     lost test;
 *   • the way out is visible: «این مرحله را انجام نمی‌دهم» closes the invitation
 *     and says plainly that it has no effect on the review;
 *   • no timer is shown. The clock exists only to spot impossible speed.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, Clock3, Info, Lock, ShieldCheck } from 'lucide-react';
import { Button, Callout, Card, Skeleton, toast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toPersianDigits } from '../lib/format';
import { useTitle } from '../lib/useTitle';
import { PSYCH_SCALE_POINTS, type PublicPsychTest } from '../types/psychometrics';

const PAGE_SIZE = 5;

export default function PsychTest({ token }: { token: string }) {
  const [data, setData] = useState<PublicPsychTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState<'save' | 'submit' | 'decline' | null>(null);
  const [done, setDone] = useState(false);
  const savedRef = useRef<Record<string, number>>({});

  useTitle('پرسش‌نامهٔ کوتاه');

  useEffect(() => {
    let alive = true;
    api.psych.public
      .get(token)
      .then((r) => {
        if (!alive) return;
        setData(r.test);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.message : 'باز کردن این صفحه ممکن نشد.');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  // Answers that reached the server, so a double save is free.
  const persist = (next: Record<string, number>) => {
    if (Object.keys(savedRef.current).length === Object.keys(next).length) return;
    savedRef.current = next;
    api.psych.public.save(token, next).catch(() => {
      savedRef.current = {};
    });
  };

  const items = data?.items || [];
  const total = items.length;
  const answeredCount = Object.keys(answers).length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageItems = useMemo(() => items.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE), [items, page]);
  const complete = total > 0 && answeredCount === total;

  const choose = (itemId: string, value: number) => {
    const next = { ...answers, [itemId]: value };
    setAnswers(next);
    persist(next);
  };

  const submit = async () => {
    setBusy('submit');
    try {
      await api.psych.public.submit(token, answers);
      setDone(true);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ارسال پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    if (!window.confirm('این مرحله را انجام نمی‌دهید؟ این انتخاب هیچ اثری در بررسی شما ندارد و می‌توانید بعداً از تیم جذب بخواهید دوباره بفرستد.')) return;
    setBusy('decline');
    try {
      const r = await api.psych.public.decline(token);
      setData(r.test);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'انجام این کار ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-canvas" dir="rtl">
      <div className="max-w-[680px] mx-auto px-4 py-8 sm:py-12">{children}</div>
    </div>
  );

  if (error) {
    return shell(
      <Card>
        <p className="text-[14px] font-bold text-ink">این صفحه باز نشد</p>
        <p className="text-[13px] text-ink-3 mt-1.5 leading-relaxed">{error}</p>
      </Card>
    );
  }

  if (!data) {
    return shell(
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const closed = data.status === 'expired' || data.status === 'cancelled' || data.status === 'declined';
  const submitted = done || data.status === 'submitted';

  if (submitted) {
    return shell(
      <Card>
        <div className="flex flex-col items-center text-center gap-3 py-6">
          <CheckCircle2 className="w-10 h-10 text-brand-strong" />
          <p className="text-[16px] font-extrabold text-ink">پاسخ شما ثبت شد</p>
          <p className="text-[13px] text-ink-3 leading-relaxed max-w-[420px]">
            سپاسگزاریم. نتیجه به‌تنهایی مبنای هیچ تصمیمی نیست؛ فقط به تیم {data.org.name} کمک می‌کند گفت‌وگو را از نقطهٔ درست شروع کند. می‌توانید این صفحه را ببندید.
          </p>
        </div>
      </Card>
    );
  }

  if (closed) {
    return shell(
      <Callout
        tone="warning"
        title={data.status === 'declined' ? 'این مرحله را نپذیرفتید' : data.status === 'expired' ? 'مهلت این پرسش‌نامه تمام شده' : 'این دعوت لغو شده است'}
      >
        {data.status === 'declined'
          ? 'همان‌طور که گفتیم، این انتخاب در بررسی شما اثری ندارد. اگر نظرتان عوض شد، از تیم جذب بخواهید لینک تازه بفرستد.'
          : 'اگر فکر می‌کنید اشتباهی رخ داده، با تیم جذب تماس بگیرید.'}
      </Callout>
    );
  }

  return shell(
    <>
      <header className="mb-5">
        <p className="text-[11.5px] text-ink-4">{data.org.name}</p>
        <h1 className="text-[20px] font-extrabold text-ink mt-1">پرسش‌نامهٔ کوتاه شیوهٔ کار</h1>
        {data.candidateName && (
          <p className="text-[12.5px] text-ink-3 mt-1">
            {data.candidateName}
            {data.jobTitle ? ` · ${data.jobTitle}` : ''}
          </p>
        )}
      </header>

      <Card className="mb-4">
        <p className="text-[13px] text-ink-2 leading-relaxed">{data.intro}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-1 mt-3 text-[11.5px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <Clock3 className="w-3.5 h-3.5" /> حدود {toPersianDigits(data.aboutMinutes)} دقیقه
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" /> پاسخ‌ها فقط برای تیم جذب
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" /> بدون درست و غلط
          </span>
        </div>
      </Card>

      {total === 0 ? (
        <Card>
          <p className="text-[13px] text-ink-3">این پرسش‌نامه در حال آماده‌سازی است؛ لطفاً بعداً دوباره باز کنید.</p>
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between mb-3">
            <p className="text-[12px] text-ink-3">
              بخش {toPersianDigits(page + 1)} از {toPersianDigits(pages)}
            </p>
            <p className="text-[12px] text-ink-3 hv-num">
              {toPersianDigits(answeredCount)} از {toPersianDigits(total)} پاسخ داده شده
            </p>
          </div>
          <div className="h-1.5 rounded-full bg-line-2 overflow-hidden mb-4">
            <div className="h-full bg-brand transition-all" style={{ width: `${total ? (answeredCount / total) * 100 : 0}%` }} />
          </div>

          <div className="flex flex-col gap-3">
            {pageItems.map((item, idx) => {
              const value = answers[item.id];
              return (
                <Card key={item.id}>
                  <p className="text-[13.5px] text-ink leading-relaxed">
                    <span className="hv-num text-ink-4 mr-1.5">{toPersianDigits(page * PAGE_SIZE + idx + 1)}.</span>
                    {item.text}
                  </p>
                  {item.instruction && (
                    <p className="text-[11.5px] text-review-ink mt-1.5 inline-flex items-center gap-1">
                      <Info className="w-3.5 h-3.5" /> {item.instruction}
                    </p>
                  )}
                  <div className="mt-3 grid grid-cols-5 gap-1.5" role="radiogroup" aria-label={item.text}>
                    {PSYCH_SCALE_POINTS.map((p) => {
                      const active = value === p.value;
                      return (
                        <button
                          key={p.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          onClick={() => choose(item.id, p.value)}
                          className={`rounded-control border px-1 py-2 text-[11px] leading-tight transition-colors ${
                            active ? 'border-brand bg-brand-tint text-brand-stronger font-bold' : 'border-line-2 bg-canvas text-ink-2 hover:border-line-strong'
                          }`}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                  </div>
                </Card>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-2 mt-5">
            <Button variant="secondary" icon={ArrowRight} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              بخش قبل
            </Button>
            {page < pages - 1 ? (
              <Button icon={ArrowLeft} onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}>
                بخش بعد
              </Button>
            ) : (
              <Button loading={busy === 'submit'} disabled={!complete} onClick={() => void submit()}>
                ارسال پاسخ
              </Button>
            )}
          </div>

          {page === pages - 1 && !complete && (
            <p className="text-[11.5px] text-ink-3 mt-3 text-center">
              برای ارسال، به {toPersianDigits(total - answeredCount)} گزارهٔ باقی‌مانده پاسخ دهید.
            </p>
          )}

          <div className="mt-6 text-center">
            <button type="button" onClick={() => void decline()} disabled={busy === 'decline'} className="text-[11.5px] text-ink-4 underline underline-offset-4 hover:text-ink-2">
              این مرحله را انجام نمی‌دهم
            </button>
            <p className="text-[10.5px] text-ink-4 mt-1.5">این انتخاب هیچ اثری در بررسی شما ندارد.</p>
          </div>
        </>
      )}
    </>
  );
}

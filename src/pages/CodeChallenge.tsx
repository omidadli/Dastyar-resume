/**
 * The candidate's challenge page.
 *
 * Design rules, because this is a stressful moment for the person using it:
 *   • the task, the examples and the hidden-test count are on one screen — no
 *     scrolling back and forth to understand what is wanted;
 *   • «اجرا» is free and unlimited (up to a generous cap) and only runs the
 *     visible examples, so experimentation is safe;
 *   • «ارسال پاسخ» is separated, explained, and confirmed — after it the result
 *     is final;
 *   • the failure text says what differed for visible cases and simply «پنهان»
 *     for the rest;
 *   • «این تمرین مناسب من نیست» is a visible door, not a hidden one.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronLeft, Clock3, Code2, Play, Send, XCircle } from 'lucide-react';
import { Button, Callout, Spinner, toast } from '../components/ui';
import { HovidaMark } from '../components/brand/Logo';
import { api, ApiError } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import { toPersianDigits } from '../lib/format';
import type { CodeCaseResult, PublicCodeChallenge } from '../types/coding';
import { CODE_DIFFICULTY_LABEL } from '../types/coding';

const STORAGE_PREFIX = 'hovida.code.draft.';

export default function CodeChallenge({ token }: { token: string }) {
  useTitle('تمرین کدنویسی');
  const [data, setData] = useState<PublicCodeChallenge | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'run' | 'submit' | null>(null);
  const [runsLeft, setRunsLeft] = useState<number | null>(null);
  const [runCases, setRunCases] = useState<CodeCaseResult[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.coding.public
      .get(token)
      .then((r) => {
        setData(r.challenge);
        // A draft survives a refresh: losing typed code to F5 is unforgivable.
        let draft = '';
        try {
          draft = localStorage.getItem(STORAGE_PREFIX + token) || '';
        } catch {
          draft = '';
        }
        setCode(draft || r.challenge.challenge.starterCode);
        setState('ready');
      })
      .catch(() => setState('missing'));
  }, [token]);

  useEffect(() => {
    if (!data || data.status === 'submitted') return;
    try {
      localStorage.setItem(STORAGE_PREFIX + token, code);
    } catch {
      /* storage blocked: the page still works */
    }
  }, [code, token, data]);

  const submitted = data?.status === 'submitted';
  const closed = data ? data.status === 'expired' || data.status === 'cancelled' || data.status === 'declined' : false;

  const examples = useMemo(() => data?.challenge.examples || [], [data]);

  const run = async () => {
    setBusy('run');
    setRunCases(null);
    try {
      const r = await api.coding.public.run(token, code);
      setRunCases(r.run.outcomes);
      setRunsLeft(r.runsLeft);
      if (r.run.error) toast(r.run.error, 'error');
      else if (r.run.passed === r.run.total) toast('همهٔ نمونه‌های قابل‌مشاهده درست بودند. می‌توانید پاسخ را بفرستید.');
      else toast(`${toPersianDigits(r.run.passed)} از ${toPersianDigits(r.run.total)} نمونه درست بود.`, 'error');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'اجرای کد ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const doSubmit = async () => {
    setBusy('submit');
    try {
      const r = await api.coding.public.submit(token, code);
      setData(r.challenge);
      setConfirming(false);
      try {
        localStorage.removeItem(STORAGE_PREFIX + token);
      } catch {
        /* ignore */
      }
      toast('پاسخ شما ثبت شد.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ارسال پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (state === 'loading') {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas">
        <Spinner />
      </div>
    );
  }
  if (state === 'missing' || !data) {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas px-4">
        <div className="hv-card p-8 max-w-md text-center">
          <Code2 className="w-8 h-8 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <h1 className="text-[17px] font-bold text-ink">این لینک معتبر نیست</h1>
          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">ممکن است کامل کپی نشده باشد یا دعوت پس گرفته شده باشد.</p>
        </div>
      </div>
    );
  }

  const result = data.result;

  return (
    <div className="min-h-screen bg-canvas" dir="rtl">
      <header className="bg-surface border-b border-line">
        <div className="max-w-[1100px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <HovidaMark size={24} />
            <div className="min-w-0">
              <p className="text-[11.5px] text-ink-3 truncate">تمرین کدنویسی — {data.org.name}</p>
              <p className="text-[13px] font-bold text-ink truncate">{data.challenge.title}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1">
              <Clock3 className="w-3.5 h-3.5" /> حدود {toPersianDigits(data.challenge.minutes)} دقیقه
            </span>
            <span className="hidden sm:inline px-2 py-0.5 rounded-full bg-brand-tint text-brand-stronger font-semibold">
              {CODE_DIFFICULTY_LABEL[data.challenge.difficulty]}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-4 sm:px-6 py-6 grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-5 items-start">
        {/* ------------------------------------------------------------- task */}
        <section className="hv-card p-5">
          <h1 className="text-[18px] font-extrabold text-ink leading-snug">{data.challenge.title}</h1>
          <p className="text-[13px] text-ink-2 mt-2 leading-[1.95] whitespace-pre-line">{data.challenge.prompt}</p>
          <p className="mt-3 text-[12px] text-ink-3">
            امضای تابع: <code className="hv-latin bg-canvas border border-line rounded px-1.5 py-0.5 text-[11.5px]">{data.challenge.signature}</code>
          </p>

          <div className="mt-4">
            <p className="text-[12.5px] font-bold text-ink-2 mb-2">نمونه‌ها</p>
            <ul className="flex flex-col gap-2">
              {examples.map((ex) => (
                <li key={ex.name} className="rounded-control border border-line-2 bg-canvas px-3 py-2">
                  <p className="text-[11.5px] font-semibold text-ink-3">{ex.name}</p>
                  <p className="hv-latin text-[11px] text-ink-2 mt-1 break-all" dir="ltr">
                    solution({ex.args.map((a) => JSON.stringify(a)).join(', ')}) → {JSON.stringify(ex.expected)}
                  </p>
                </li>
              ))}
            </ul>
            {data.challenge.hiddenCount > 0 && (
              <p className="text-[11.5px] text-ink-4 mt-2">
                {toPersianDigits(data.challenge.hiddenCount)} تست پنهان هم وجود دارد که فقط برای اطمینان از حل واقعی مسئله است — ورودی‌شان نمایش داده نمی‌شود.
              </p>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------------- code */}
        <section className="flex flex-col gap-4">
          {submitted && result ? (
            <ResultPanel data={data} result={result} />
          ) : closed ? (
            <Callout
              tone="warning"
              title={data.status === 'expired' ? 'مهلت این تمرین تمام شده' : data.status === 'declined' ? 'این تمرین را نپذیرفتید' : 'این دعوت لغو شده است'}
            >
              اگر فکر می‌کنید اشتباهی رخ داده، با تیم جذب {data.org.name} تماس بگیرید.
            </Callout>
          ) : (
            <>
              <div className="hv-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-line-2 bg-canvas">
                  <p className="text-[12.5px] font-bold text-ink-2">کد شما (JavaScript)</p>
                  <p className="text-[11px] text-ink-4">
                    {runsLeft === null ? 'اجرا رایگان است' : `${toPersianDigits(runsLeft)} اجرا باقی مانده`}
                  </p>
                </div>
                <textarea
                  ref={areaRef}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  spellCheck={false}
                  dir="ltr"
                  aria-label="کد پاسخ"
                  onKeyDown={(e) => {
                    // Tab indents instead of leaving the editor — the small thing
                    // every programmer expects and every plain textarea gets wrong.
                    if (e.key === 'Tab') {
                      e.preventDefault();
                      const el = e.currentTarget;
                      const start = el.selectionStart;
                      const end = el.selectionEnd;
                      const next = `${code.slice(0, start)}  ${code.slice(end)}`;
                      setCode(next);
                      requestAnimationFrame(() => {
                        el.selectionStart = el.selectionEnd = start + 2;
                      });
                    }
                  }}
                  className="w-full h-[340px] p-4 resize-y bg-[#0f1412] text-[#e8eee9] font-mono text-[12.5px] leading-[1.75] focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button icon={Play} variant="secondary" onClick={() => void run()} loading={busy === 'run'} disabled={busy !== null}>
                  اجرا روی نمونه‌ها
                </Button>
                <Button icon={Send} onClick={() => setConfirming(true)} disabled={busy !== null}>
                  ارسال پاسخ نهایی
                </Button>
                <button
                  type="button"
                  className="text-[11.5px] text-ink-4 hover:text-ink-2 underline underline-offset-4 mr-auto"
                  onClick={async () => {
                    if (!window.confirm('با این کار دعوت بسته می‌شود و تیم جذب مطلع می‌شود. مطمئنید؟')) return;
                    try {
                      const r = await api.coding.public.decline(token);
                      setData(r.challenge);
                    } catch (err) {
                      toast(err instanceof ApiError ? err.message : 'ثبت این درخواست ممکن نشد.', 'error');
                    }
                  }}
                >
                  این تمرین مناسب من نیست
                </button>
              </div>

              {runCases && (
                <div className="hv-card p-4">
                  <p className="text-[12.5px] font-bold text-ink-2 mb-2">نتیجهٔ اجرای آزمایشی</p>
                  <ul className="flex flex-col gap-1.5">
                    {runCases.map((c) => (
                      <li key={c.name} className="flex items-start gap-2 text-[12px]">
                        {c.passed ? (
                          <CheckCircle2 className="w-4 h-4 text-brand-strong shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="w-4 h-4 text-low-ink shrink-0 mt-0.5" />
                        )}
                        <div className="min-w-0">
                          <span className="font-semibold text-ink-2">{c.name}</span>
                          {!c.passed && c.error && <span className="text-low-ink"> — {c.error}</span>}
                          {!c.passed && !c.error && (
                            <p className="hv-latin text-[11px] text-ink-3 mt-0.5 break-all" dir="ltr">
                              expected {c.expected} · got {c.actual}
                            </p>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[11px] text-ink-4 mt-2">این اجرا فقط نمونه‌های قابل‌مشاهده را سنجید و چیزی ثبت نشد.</p>
                </div>
              )}

              {confirming && (
                <div className="rounded-card border border-brand/30 bg-brand-tint p-4">
                  <p className="text-[13px] font-bold text-brand-stronger flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> پاسخ نهایی می‌شود؛ بعد از ارسال قابل تغییر نیست.
                  </p>
                  <p className="text-[12px] text-ink-2 mt-1.5 leading-relaxed">
                    کد شما روی نمونه‌ها و تست‌های پنهان اجرا می‌شود و نتیجه برای تیم جذب {data.org.name} ثبت می‌شود.
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Button size="sm" icon={Send} loading={busy === 'submit'} onClick={() => void doSubmit()}>
                      بله، پاسخ را بفرست
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                      بازگشت به ویرایش
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}

function ResultPanel({ data, result }: { data: PublicCodeChallenge; result: NonNullable<PublicCodeChallenge['result']> }) {
  const tone = result.score !== null && result.score >= 80 ? 'high' : result.score !== null && result.score >= 50 ? 'review' : 'low';
  const label = tone === 'high' ? 'نتیجهٔ خوب' : tone === 'review' ? 'قابل قبول با نکته' : 'نیازمند بررسی';
  return (
    <div className="hv-card p-5">
      <div className="flex items-center gap-2.5">
        <CheckCircle2 className="w-5 h-5 text-brand-strong" />
        <h2 className="text-[16px] font-extrabold text-ink">پاسخ شما ثبت شد</h2>
      </div>
      <p className="text-[12px] text-ink-3 mt-1">{result.submittedAtJalali} — بعد از این لحظه قابل تغییر نیست.</p>

      <div className={`mt-4 rounded-card border p-3 ${tone === 'high' ? 'border-brand/25 bg-brand-tint' : tone === 'review' ? 'border-review/25 bg-review-soft' : 'border-line bg-canvas'}`}>
        <p className="text-[12px] text-ink-3">{label}</p>
        <p className="text-[22px] font-extrabold text-ink hv-num mt-0.5">
          {result.passed} از {result.total} تست
          {result.score !== null && <span className="text-[13px] font-bold text-ink-3 mr-2">({toPersianDigits(result.score)}٪)</span>}
        </p>
        {result.timedOut && <p className="text-[12px] text-low-ink mt-1">اجرای کد بیش از حد طول کشید و متوقف شد.</p>}
        {result.error && <p className="text-[12px] text-low-ink mt-1 leading-relaxed">{result.error}</p>}
      </div>

      <ul className="mt-3 flex flex-col gap-1.5">
        {result.cases.map((c) => (
          <li key={c.name} className="flex items-start gap-2 text-[12px]">
            {c.passed ? <CheckCircle2 className="w-4 h-4 text-brand-strong shrink-0 mt-0.5" /> : <XCircle className="w-4 h-4 text-low-ink shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <span className="font-semibold text-ink-2">{c.hidden ? 'تست پنهان' : c.name}</span>
              {!c.passed && c.error && <span className="text-low-ink"> — {c.error}</span>}
              {!c.passed && !c.error && !c.hidden && (
                <p className="hv-latin text-[11px] text-ink-3 mt-0.5 break-all" dir="ltr">
                  expected {c.expected} · got {c.actual}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      <p className="text-[11.5px] text-ink-4 mt-4 leading-relaxed flex items-start gap-1.5">
        <ChevronLeft className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        نتیجه به‌صورت خودکار تصمیمی نمی‌گیرد؛ تیم {data.org.name} آن را در کنار گفت‌وگو و سابقهٔ شما می‌خواند.
      </p>
    </div>
  );
}

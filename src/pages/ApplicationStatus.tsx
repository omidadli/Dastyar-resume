import { useEffect, useState } from 'react';
import { CalendarDays, Check, Clock3, Mail, Sparkles } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Callout, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import type { PublicStatus } from '../types/status';
import { PUBLIC_STATE_LABEL } from '../types/status';

/**
 * «پیگیری درخواست» — the page the candidate opens from the e-mail.
 *
 * It says four things and nothing else: which application this is, where it
 * stands today, when it last changed, and whom to write to. No score, no note,
 * no reason — and the promise at the bottom is on us: «اگر تغییری رخ دهد، همین
 * صفحه به‌روز می‌شود» is only printed because the page reads the live record.
 */
export default function ApplicationStatus({ token }: { token: string }) {
  useTitle('پیگیری درخواست');
  const [data, setData] = useState<PublicStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [reason, setReason] = useState<string>('');

  useEffect(() => {
    api.status
      .public(token)
      .then((r) => {
        setData(r.status);
        setState('ready');
      })
      .catch((err: any) => {
        setReason(err?.message || '');
        setState('missing');
      });
  }, [token]);

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">پیگیری درخواست</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[640px] mx-auto flex flex-col gap-4">
          {state === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {state === 'missing' && (
            <Callout tone="warning" icon={Clock3} title="این لینک باز نمی‌شود">
              {reason || 'ممکن است لینک منقضی شده یا غیرفعال شده باشد. از منابع انسانی لینک تازه بخواهید.'}
            </Callout>
          )}

          {data && (
            <>
              <div className="hv-card p-5 sm:p-6">
                <p className="text-[12px] text-ink-3">{data.orgName}</p>
                <h1 className="text-[19px] font-semibold text-ink mt-1">{data.jobTitle}</h1>
                <p className="text-[13px] text-ink-2 mt-1.5">{data.candidateName} عزیز، وضعیت درخواست شما این است:</p>

                <div className="mt-4 rounded-[12px] border border-brand/25 bg-brand-tint px-4 py-3">
                  <p className="text-[13px] font-semibold text-brand-stronger inline-flex items-center gap-2">
                    <Sparkles className="w-4 h-4" strokeWidth={1.9} />
                    {PUBLIC_STATE_LABEL[data.state]}
                  </p>
                  <p className="text-[12.5px] text-ink-2 mt-1 leading-6">{data.message}</p>
                </div>

                {data.nextInterviewJalali && (
                  <p className="mt-3 text-[12.5px] text-ink-2 inline-flex items-center gap-2">
                    <CalendarDays className="w-4 h-4 text-ink-3" strokeWidth={1.9} />
                    مصاحبهٔ بعدی: {data.nextInterviewJalali}
                  </p>
                )}

                <p className="mt-3 text-[11.5px] text-ink-4">آخرین به‌روزرسانی: {data.updatedAtJalali}</p>
              </div>

              <div className="hv-card p-5 sm:p-6">
                <p className="text-[13px] font-semibold text-ink mb-3">مسیر درخواست</p>
                <ol className="flex flex-col gap-0">
                  {data.steps.map((step, i) => {
                    const done = step.state === 'done';
                    const current = step.state === 'current';
                    const last = i === data.steps.length - 1;
                    return (
                      <li key={step.key} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span
                            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[11px] font-semibold ${
                              done
                                ? 'bg-brand text-white'
                                : current
                                  ? 'bg-brand-soft text-brand-stronger ring-2 ring-brand/30'
                                  : 'bg-line-2 text-ink-4'
                            }`}
                          >
                            {done ? <Check className="w-3.5 h-3.5" strokeWidth={2.4} /> : current ? '•' : i + 1}
                          </span>
                          {!last && <span className={`w-px flex-1 my-1 ${done ? 'bg-brand/40' : 'bg-line-2'}`} />}
                        </div>
                        <div className={`pb-4 ${last ? '' : ''}`}>
                          <p className={`text-[12.5px] ${current ? 'font-semibold text-ink' : done ? 'text-ink-2' : 'text-ink-4'}`}>
                            {step.label}
                          </p>
                          {current && <p className="text-[11.5px] text-ink-3 mt-0.5">اکنون اینجاست</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <div className="hv-card p-5 sm:p-6">
                <p className="text-[12.5px] text-ink-2 leading-6">
                  این صفحه فقط وضعیت را نشان می‌دهد؛ امتیاز، یادداشت داخلی یا دلیل تصمیم را نه. اگر سؤالی دارید یا اطلاعاتی
                  تغییر کرده است، به منابع انسانی پیام بدهید.
                </p>
                {data.contactEmail ? (
                  <a
                    href={`mailto:${data.contactEmail}`}
                    className="mt-3 inline-flex items-center gap-2 text-[12.5px] text-brand-strong underline"
                  >
                    <Mail className="w-4 h-4" strokeWidth={1.9} />
                    {data.contactEmail}
                  </a>
                ) : (
                  <p className="mt-3 text-[11.5px] text-ink-4">ایمیل تماس روی این صفحه تنظیم نشده است؛ از همان حسابی که پاسخ داده‌اید بپرسید.</p>
                )}
                <p className="mt-3 text-[11px] text-ink-4">این لینک تا {data.expiresAtJalali} معتبر است.</p>
              </div>
            </>
          )}
        </div>
      </main>

      <footer className="px-5 py-5 text-[11px] text-ink-4 text-center border-t border-line-2 bg-surface">
        ساخته‌شده با هویدا — برای تیم‌های جذب فارسی‌زبان
      </footer>
    </div>
  );
}

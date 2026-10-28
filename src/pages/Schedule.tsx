import React, { useEffect, useState } from 'react';
import { CalendarCheck2, CheckCircle2, Clock3, Users } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, Spinner, toast } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import type { PublicSchedulingLink } from '../types/scheduling';
import { toPersianDigits } from '../lib/format';

/**
 * The candidate's page for choosing an interview time. No account: the token in
 * the e-mail is the key, and the page shows only the times HR offered.
 */
export default function Schedule({ token }: { token: string }) {
  useTitle('انتخاب زمان مصاحبه');
  const [link, setLink] = useState<PublicSchedulingLink | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.scheduling.public
      .get(token)
      .then((r) => {
        setLink(r.link);
        setState('ready');
      })
      .catch(() => setState('missing'));
  }, [token]);

  const book = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const r = await api.scheduling.public.book(token, picked);
      setLink(r.link);
      toast('زمان شما ثبت شد و دعوت‌نامه فرستاده شد.');
    } catch (err: any) {
      toast(err?.message || 'ثبت زمان ممکن نشد.', 'error');
      // A slot may have been taken while this page was open: refresh the list.
      api.scheduling.public.get(token).then((r) => setLink(r.link)).catch(() => undefined);
      setPicked(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">انتخاب زمان مصاحبه</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[640px] mx-auto">
          {state === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {state === 'missing' && (
            <div className="bg-surface border border-line rounded-[16px] p-8 text-center">
              <p className="font-bold text-ink mb-2">این لینک پیدا نشد.</p>
              <p className="text-[13px] text-ink-3 leading-relaxed">نشانی را کامل از ایمیل باز کنید یا از واحد منابع انسانی زمان تازه بخواهید.</p>
            </div>
          )}

          {state === 'ready' && link && (
            <div className="bg-surface border border-line rounded-[16px] p-6 sm:p-8">
              <p className="text-[12.5px] text-ink-3">{link.org.name}</p>
              <h1 className="text-[21px] sm:text-[24px] font-black text-ink mt-1">{link.title}</h1>
              <p className="text-[13px] text-ink-3 mt-1">
                {link.candidateName} — برای «{link.jobTitle}»
              </p>

              <div className="flex flex-wrap items-center gap-3 mt-4 text-[12.5px] text-ink-2">
                <span className="inline-flex items-center gap-1.5">
                  <Clock3 className="w-4 h-4 text-ink-3" strokeWidth={1.8} />
                  {toPersianDigits(link.durationMin)} دقیقه
                </span>
                {link.interviewerNames.length > 0 && (
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="w-4 h-4 text-ink-3" strokeWidth={1.8} />
                    {link.interviewerNames.join('، ')}
                  </span>
                )}
                <span className="text-ink-4">{link.orgTimeNote}</span>
              </div>

              {link.status === 'booked' && (
                <Callout tone="brand" icon={CheckCircle2} className="mt-5">
                  زمان شما ثبت شد و دعوت‌نامه برایتان فرستاده شد. اگر نیاز به تغییر دارید، به همان ایمیل پاسخ دهید.
                </Callout>
              )}

              {link.status === 'cancelled' && <Callout tone="warning" className="mt-5">این لینک توسط سازمان لغو شده است.</Callout>}

              {link.status === 'open' && (
                <>
                  <p className="text-[13px] text-ink-2 mt-5 mb-2 font-semibold">یکی از زمان‌های زیر را انتخاب کنید:</p>
                  <div className="flex flex-col gap-2">
                    {link.slots.map((s) => {
                      const disabled = s.taken || new Date(s.startsAtISO).getTime() < Date.now();
                      const active = picked === s.startsAtISO;
                      return (
                        <button
                          key={s.startsAtISO}
                          type="button"
                          disabled={disabled}
                          onClick={() => setPicked(s.startsAtISO)}
                          className={`flex items-center justify-between gap-3 rounded-[12px] border px-4 py-3 text-right transition ${
                            active ? 'border-brand bg-brand-soft' : 'border-line bg-canvas hover:border-line-strong'
                          } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <span className="text-[13.5px] font-semibold text-ink">
                            {s.date} — ساعت {s.time}
                          </span>
                          {s.taken ? <Chip tone="neutral">انتخاب شده</Chip> : active ? <CheckCircle2 className="w-4.5 h-4.5 text-brand-strong" /> : null}
                        </button>
                      );
                    })}
                  </div>
                  <Button icon={CalendarCheck2} className="mt-5" onClick={() => void book()} loading={busy} disabled={!picked || busy}>
                    ثبت این زمان
                  </Button>
                  {link.notes && <p className="text-[12.5px] text-ink-3 mt-4 leading-relaxed">{link.notes}</p>}
                </>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-[11.5px] text-ink-4">این صفحه با هویدا ساخته شده است.</footer>
    </div>
  );
}

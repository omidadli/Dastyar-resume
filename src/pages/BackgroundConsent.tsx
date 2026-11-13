/**
 * The candidate's consent page for a criminal-record check.
 *
 * This is the most sensitive page in the product, so it does one thing and says
 * three true things:
 *
 *   • **What is checked** — one certificate from one named office, nothing else.
 *   • **Who sees it** — the workspace's admins, not colleagues.
 *   • **That «no» is allowed** — refusing is a complete answer, is recorded as
 *     such, and is not itself a negative signal.
 *
 * No account, no password, no tracking script. Agreeing needs the candidate's
 * typed name and an explicit checkbox; the receipt shows exactly what was
 * agreed, with the version of the notice.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileLock2, ShieldCheck, XCircle } from 'lucide-react';
import { Button, Callout, Spinner, TextInput, toast } from '../components/ui';
import { HovidaMark } from '../components/brand/Logo';
import { api, ApiError } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import type { PublicBackgroundConsent } from '../types/background-check';

export default function BackgroundConsent({ token }: { token: string }) {
  useTitle('رضایت استعلام سوءپیشینه');
  const [data, setData] = useState<PublicBackgroundConsent | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'consent' | 'decline' | null>(null);

  useEffect(() => {
    api.background.public
      .get(token)
      .then((r) => {
        setData(r.background);
        setState('ready');
        if (r.background.canConsent) api.background.public.open(token).then((o) => setData(o.background)).catch(() => undefined);
      })
      .catch(() => setState('missing'));
  }, [token]);

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
          <AlertTriangle className="w-8 h-8 text-warning-ink mx-auto mb-3" />
          <h1 className="text-[16px] font-bold text-ink">این لینک معتبر نیست</h1>
          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
            ممکن است نشانی ناقص کپی شده باشد. اگر لینک را از منابع انسانی گرفته‌اید، از آن‌ها بخواهید دوباره بفرستند.
          </p>
        </div>
      </div>
    );
  }

  const consented = Boolean(data.consentAtJalali);
  const declined = data.status === 'declined';

  const submitConsent = async () => {
    if (name.trim().length < 3) {
      toast('نام و نام خانوادگی خود را بنویسید.', 'error');
      return;
    }
    if (!agreed) {
      toast('برای ادامه، کادر تأیید را علامت بزنید.', 'error');
      return;
    }
    setBusy('consent');
    try {
      const r = await api.background.public.consent(token, { name: name.trim(), agreed: true });
      setData(r.background);
      toast('رضایت شما ثبت شد.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت رضایت ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const submitDecline = async () => {
    setBusy('decline');
    try {
      const r = await api.background.public.decline(token, { reason: reason.trim() });
      setData(r.background);
      setDeclining(false);
      toast('پاسخ شما ثبت شد.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen bg-canvas py-8 px-4" dir="rtl">
      <div className="max-w-[620px] mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <HovidaMark size={28} />
          <div className="min-w-0">
            <p className="text-[12px] text-ink-3">درخواست رضایت از طرف</p>
            <p className="text-[14px] font-extrabold text-ink truncate">{data.orgName}</p>
          </div>
        </div>

        <div className="hv-card p-5 sm:p-6">
          <p className="text-[12px] font-semibold text-brand-strong mb-1.5">استعلام سوءپیشینه</p>
          <h1 className="text-[20px] sm:text-[22px] font-extrabold text-ink leading-snug">
            {data.candidateName ? `${data.candidateName} عزیز، ` : ''}پیش از استعلام، رضایت شما را می‌خواهیم
          </h1>
          <p className="text-[13.5px] text-ink-2 mt-2 leading-[1.95]">
            سازمان «{data.orgName}»
            {data.jobTitle ? ` برای نقش «${data.jobTitle}»` : ''} می‌خواهد گواهی عدم سوءپیشینه را از «{data.authority}» درخواست کند. متن کامل
            اطلاعیه پایین آمده است؛ لطفاً پیش از تصمیم بخوانید.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-3 text-[11.5px] text-ink-3">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" /> نتیجه فقط به مدیران همین سازمان می‌رسد
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FileLock2 className="w-3.5 h-3.5" /> نپذیرفتن، به‌خودی‌خود نشانهٔ منفی نیست
            </span>
          </div>
        </div>

        {consented ? (
          <div className="hv-card p-6 text-center">
            <CheckCircle2 className="w-9 h-9 text-brand-strong mx-auto mb-3" />
            <h2 className="text-[17px] font-bold text-ink">رضایت شما ثبت شد</h2>
            <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
              {data.consentAtJalali ? `${data.consentAtJalali} — ` : ''}سازمان «{data.orgName}» از «{data.authority}» درخواست گواهی می‌کند. اگر نظرتان
              تغییر کرد، با {data.contact} تماس بگیرید.
            </p>
            <p className="text-[11.5px] text-ink-4 mt-3">نسخهٔ اطلاعیه: {data.noticeVersion}</p>
          </div>
        ) : declined ? (
          <div className="hv-card p-6 text-center">
            <XCircle className="w-9 h-9 text-ink-3 mx-auto mb-3" />
            <h2 className="text-[17px] font-bold text-ink">پاسخ شما ثبت شد</h2>
            <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
              رضایت نداده‌اید و همین‌جا می‌مانَد. {data.declinedAtJalali ? `${data.declinedAtJalali} — ` : ''}این پاسخ به‌خودی‌خود نشانهٔ منفی نیست؛
              تصمیم دربارهٔ ادامهٔ فرایند با انسان است. برای هر پرسشی با {data.contact} تماس بگیرید.
            </p>
          </div>
        ) : (
          <>
            <div className="hv-card p-5 sm:p-6">
              <h2 className="text-[14px] font-bold text-ink mb-2">اطلاعیه</h2>
              <pre className="whitespace-pre-wrap text-[12px] leading-[1.95] text-ink-2 bg-canvas border border-line-2 rounded-control p-3.5 max-h-[340px] overflow-auto">
                {data.notice}
              </pre>
            </div>

            {!declining ? (
              <div className="hv-card p-5 sm:p-6 space-y-3">
                <TextInput
                  label="نام و نام خانوادگی (همان‌طور که در گواهی می‌آید)"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="نام کامل شما"
                  hint="رضایت بی‌نام ثبت نمی‌شود؛ همین نام روی رضایت‌نامه می‌ماند."
                />
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-1 w-4 h-4 accent-[var(--hv-brand,#4F46E5)]"
                  />
                  <span className="text-[12.5px] text-ink-2 leading-relaxed">
                    اطلاعیه را خواندم و با استعلام گواهی عدم سوءپیشینه از «{data.authority}» برای این فرایند استخدام موافقم.
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" loading={busy === 'consent'} onClick={submitConsent} disabled={!agreed || name.trim().length < 3}>
                    رضایت می‌دهم
                  </Button>
                  <Button variant="ghost" onClick={() => setDeclining(true)}>
                    رضایت نمی‌دهم
                  </Button>
                </div>
              </div>
            ) : (
              <div className="hv-card p-5 sm:p-6 space-y-3">
                <h2 className="text-[14px] font-bold text-ink">رضایت نمی‌دهم</h2>
                <p className="text-[12.5px] text-ink-3 leading-relaxed">
                  این پاسخ ثبت می‌شود و استعلام انجام نمی‌شود. اگر خواستید دلیلش را بنویسید — اختیاری است و فقط به مدیران همین سازمان نشان
                  داده می‌شود.
                </p>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={400}
                  placeholder="دلیل (اختیاری)"
                  className="w-full bg-surface border border-line rounded-control text-sm px-3.5 py-2.5 text-ink hover:border-line-strong focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" loading={busy === 'decline'} onClick={submitDecline}>
                    ثبت پاسخ
                  </Button>
                  <Button variant="ghost" onClick={() => setDeclining(false)}>
                    بازگشت
                  </Button>
                </div>
              </div>
            )}

            <Callout tone="info">پرسش یا پس‌گرفتن رضایت: {data.contact}</Callout>
          </>
        )}

        <p className="text-center text-[11px] text-ink-4 leading-relaxed">
          این صفحه فقط برای همین درخواست است؛ هیچ حسابی ساخته نمی‌شود و هیچ داده‌ای برای تبلیغات استفاده نمی‌شود.
        </p>
      </div>
    </div>
  );
}

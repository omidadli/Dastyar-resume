import React, { useEffect, useState } from 'react';
import { CheckCircle2, FileSignature, MapPin, ShieldCheck, XCircle } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, Spinner, TextArea, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import type { PublicOffer } from '../types/offers';
import { OFFER_STATUS_LABEL, SALARY_PERIOD_LABEL } from '../types/offers';
import { toPersianDigits } from '../lib/format';

/**
 * The candidate's page for an offer: the terms, the message, and one button that
 * signs it. No account, no login — the unguessable link in the e-mail is the key,
 * and the typed full name is the signature.
 */
export default function OfferPage({ token }: { token: string }) {
  useTitle('پیشنهاد شغلی');
  const [offer, setOffer] = useState<PublicOffer | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  /** No toast in the markup (a hidden build shows no feedback), so the answer is a line of text. */
  const [answer, setAnswer] = useState('');
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    api.offers.public
      .get(token)
      .then((r) => {
        setOffer(r.offer);
        setName(r.offer.candidateName);
        setState('ready');
      })
      .catch(() => setState('missing'));
  }, [token]);

  const accept = async () => {
    setBusy('accept');
    try {
      const r = await api.offers.public.accept(token, { name, note });
      setOffer(r.offer);
      setAnswer('پیشنهاد پذیرفته شد. خوشحالیم که به تیم می‌پیوندید.');
      toast('پیشنهاد پذیرفته شد. خوشحالیم که به تیم می‌پیوندید.');
    } catch (err: any) {
      setAnswer(err?.message || 'ثبت پاسخ ممکن نشد.');
      toast(err?.message || 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const decline = async () => {
    setBusy('decline');
    try {
      const r = await api.offers.public.decline(token, { name, note });
      setOffer(r.offer);
      setAnswer('پاسخ شما ثبت شد؛ برایتان آرزوی موفقیت داریم.');
      toast('پاسخ شما ثبت شد؛ برایتان آرزوی موفقیت داریم.', 'info');
    } catch (err: any) {
      setAnswer(err?.message || 'ثبت پاسخ ممکن نشد.');
      toast(err?.message || 'ثبت پاسخ ممکن نشد.', 'error');
    } finally {
      setBusy(null);
      setDeclining(false);
    }
  };

  const salary =
    offer?.terms.salaryAmount === null || offer?.terms.salaryAmount === undefined
      ? 'توافقی'
      : `${toPersianDigits(offer.terms.salaryAmount.toLocaleString('en-US'))} تومان ${SALARY_PERIOD_LABEL[offer.terms.salaryPeriod]}`;

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">صفحهٔ پیشنهاد شغلی</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[720px] mx-auto">
          {state === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {state === 'missing' && (
            <div className="bg-surface border border-line rounded-[16px] p-8 text-center">
              <p className="font-bold text-ink mb-2">این پیشنهاد پیدا نشد.</p>
              <p className="text-[13px] text-ink-3 leading-relaxed">
                نشانی را کامل از ایمیل باز کنید. اگر مشکل ادامه داشت، با واحد منابع انسانی سازمان تماس بگیرید.
              </p>
            </div>
          )}

          {state === 'ready' && offer && (
            <div className="flex flex-col gap-5">
              <div className="bg-surface border border-line rounded-[16px] p-6 sm:p-8">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <p className="text-[12.5px] text-ink-3">{offer.org.name}</p>
                    <h1 className="text-[22px] sm:text-[26px] font-black text-ink mt-1">{offer.jobTitle}</h1>
                    <p className="text-[13px] text-ink-3 mt-1">برای {offer.candidateName}</p>
                  </div>
                  <Chip tone={offer.status === 'accepted' ? 'brand' : offer.status === 'declined' ? 'danger' : 'outline'}>
                    {OFFER_STATUS_LABEL[offer.status]}
                  </Chip>
                </div>

                {offer.message && (
                  <div className="mt-5 whitespace-pre-line text-[13.5px] leading-[2] text-ink-2">{offer.message}</div>
                )}

                <dl className="mt-6 grid sm:grid-cols-2 gap-3">
                  <Term label="عنوان شغلی" value={offer.terms.title || offer.jobTitle} />
                  <Term label="حقوق" value={salary} />
                  <Term label="تاریخ شروع" value={offer.terms.startDate || '—'} />
                  <Term label="محل کار" value={offer.terms.location || '—'} icon />
                  <Term label="نوع همکاری" value={offer.terms.employmentType || '—'} />
                  <Term
                    label="دورهٔ آزمایشی"
                    value={offer.terms.probationMonths ? `${toPersianDigits(offer.terms.probationMonths)} ماه` : 'ندارد'}
                  />
                  {offer.terms.benefitsNote && <Term label="مزایا" value={offer.terms.benefitsNote} wide />}
                  {offer.terms.notes && <Term label="توضیحات" value={offer.terms.notes} wide />}
                </dl>
              </div>

              {offer.status === 'sent' && !declining && (
                <div className="bg-surface border border-line rounded-[16px] p-6 sm:p-8">
                  <h2 className="text-[15px] font-bold text-ink flex items-center gap-2">
                    <FileSignature className="w-4.5 h-4.5 text-brand" strokeWidth={1.8} />
                    پاسخ و امضای الکترونیکی
                  </h2>
                  <p className="text-[12.5px] text-ink-3 mt-1.5 leading-relaxed">
                    با نوشتن نام کامل و زدن «می‌پذیرم»، این پیشنهاد را می‌پذیرید. همین نام، امضای شما روی این پیشنهاد است و
                    تاریخ پاسخ هم ثبت می‌شود.
                  </p>
                  <div className="mt-4 space-y-3">
                    <TextInput label="نام و نام خانوادگی شما" value={name} onChange={(e) => setName(e.target.value)} />
                    <TextArea
                      label="یادداشت برای واحد منابع انسانی (اختیاری)"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder="مثلاً «تاریخ شروع را ترجیح می‌دهم یک هفته دیرتر باشد»"
                    />
                    {answer && <p className="text-[12.5px] text-ink-2">{answer}</p>}
                    <div className="flex flex-wrap gap-2">
                      <Button icon={CheckCircle2} onClick={() => void accept()} loading={busy === 'accept'} disabled={Boolean(busy) || name.trim().length < 3}>
                        می‌پذیرم
                      </Button>
                      <Button variant="ghost" icon={XCircle} onClick={() => setDeclining(true)} disabled={Boolean(busy)}>
                        نمی‌پذیرم
                      </Button>
                    </div>
                    <p className="text-[11.5px] text-ink-4 flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.8} />
                      اطلاعات این صفحه فقط با لینک همین پیام باز می‌شود و در فهرست‌های عمومی نماد.
                    </p>
                  </div>
                </div>
              )}

              {offer.status === 'sent' && declining && (
                <div className="bg-surface border border-line rounded-[16px] p-6 sm:p-8">
                  <h2 className="text-[15px] font-bold text-ink">ثبت پاسخ منفی</h2>
                  <p className="text-[12.5px] text-ink-3 mt-1.5 leading-relaxed">
                    اگر ممکن است دلیل کوتاهی بنویسید؛ به بهتر شدن پیشنهادهای بعدی کمک می‌کند.
                  </p>
                  <div className="mt-4 space-y-3">
                    <TextArea label="دلیل (اختیاری)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                    <div className="flex gap-2">
                      <Button variant="secondary" onClick={() => void decline()} loading={busy === 'decline'}>
                        ثبت پاسخ
                      </Button>
                      <Button variant="ghost" onClick={() => setDeclining(false)} disabled={Boolean(busy)}>
                        بازگشت
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {offer.status === 'accepted' && (
                <Callout tone="brand" icon={CheckCircle2}>
                  این پیشنهاد در {offer.respondedAtJalali} با نام «{offer.signatureName}» پذیرفته شد. واحد منابع انسانی سازمان
                  در جریان است.
                </Callout>
              )}

              {offer.status === 'declined' && (
                <Callout tone="warning" icon={XCircle}>
                  پاسخ شما ثبت شد. اگر نظرتان تغییر کرد، با واحد منابع انسانی تماس بگیرید.
                </Callout>
              )}

              {offer.status === 'cancelled' && <Callout tone="warning">این پیشنهاد توسط سازمان لغو شده است.</Callout>}
            </div>
          )}
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-[11.5px] text-ink-4">این صفحه با هویدا ساخته شده است.</footer>
    </div>
  );
}

function Term({ label, value, wide, icon }: { label: string; value: React.ReactNode; wide?: boolean; icon?: boolean }) {
  return (
    <div className={`rounded-[12px] bg-canvas border border-line-2 px-3.5 py-2.5 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-[11.5px] text-ink-4">{label}</dt>
      <dd className="text-[13.5px] text-ink mt-0.5 flex items-center gap-1.5">
        {icon && <MapPin className="w-3.5 h-3.5 text-ink-3" strokeWidth={1.8} />}
        {value}
      </dd>
    </div>
  );
}

import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FileSignature, Send, Trash2 } from 'lucide-react';
import type { JobOffer, OfferTerms, SalaryPeriod } from '../../types/offers';
import { OFFER_STATUS_LABEL, SALARY_PERIOD_LABEL } from '../../types/offers';
import type { ResumeListItem } from '../../types/screening';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { candidateName, faNumber, toPersianDigits } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { Button, Callout, Chip, Modal, Select, Spinner, TextArea, TextInput, toast } from '../ui';

/**
 * «پیشنهاد شغلی» — one dialog for writing the offer, sending the link from the
 * workspace mailbox, and following what the candidate did with it.
 *
 * The offer is a draft until someone presses «ارسال»: nothing is e-mailed, and
 * the link does not open for the candidate before that.
 */
export function OfferModal({
  record,
  jobTitle,
  onClose,
}: {
  record: ResumeListItem | null;
  jobTitle?: string;
  onClose: () => void;
}) {
  const [offer, setOffer] = useState<JobOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'send' | 'cancel' | null>(null);
  const [terms, setTerms] = useState<OfferTerms>({
    title: jobTitle || '',
    salaryAmount: null,
    salaryPeriod: 'monthly',
    benefitsNote: '',
    startDate: '',
    location: '',
    employmentType: '',
    probationMonths: 3,
    notes: '',
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!record) return;
    setLoading(true);
    api.offers
      .list({ resumeId: record.id })
      .then((r) => {
        const open = r.items.find((o) => o.status === 'draft' || o.status === 'sent') || r.items[0] || null;
        setOffer(open);
        if (open) {
          setTerms(open.terms);
          setMessage(open.message);
        }
      })
      .catch(() => setOffer(null))
      .finally(() => setLoading(false));
  }, [record?.id]);

  const applySaved = (o: JobOffer) => {
    setOffer(o);
    setTerms(o.terms);
    setMessage(o.message);
  };

  const create = async () => {
    if (!record) return;
    setBusy('save');
    try {
      const r = await api.offers.create({ resumeId: record.id, terms, message: message || undefined });
      applySaved(r.offer);
      toast('پیش‌نویس پیشنهاد ساخته شد؛ هنوز چیزی برای کارجو نرفته است.');
    } catch (err: any) {
      toast(err?.message || 'ساخت پیش‌نویس ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!offer) return;
    setBusy('save');
    try {
      const r = await api.offers.update(offer.id, { terms, message });
      applySaved(r.offer);
      toast('پیش‌نویس به‌روزرسانی شد.');
    } catch (err: any) {
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!offer) return;
    setBusy('send');
    try {
      const r = await api.offers.send(offer.id);
      applySaved(r.offer);
      emitChange('resumes');
      emitChange('activity');
      toast('پیشنهاد از صندوق ایمیل سازمان برای کارجو فرستاده شد.');
    } catch (err: any) {
      toast(err?.message || 'ارسال نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!offer) return;
    setBusy('cancel');
    try {
      const r = await api.offers.cancel(offer.id);
      applySaved(r.offer);
      emitChange('resumes');
      toast('پیشنهاد لغو شد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'لغو نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    if (!offer?.url) return;
    const ok = await copyText(offer.url);
    toast(ok ? 'نشانی پیشنهاد کپی شد.' : 'کپی نشد.', ok ? 'success' : 'error');
  };

  const readOnly = Boolean(offer && offer.status !== 'draft');
  const salaryField = terms.salaryAmount === null ? '' : String(terms.salaryAmount);

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      title="پیشنهاد شغلی"
      description={record ? `${candidateName(record)} — ${jobTitle || offer?.jobTitle || ''}` : undefined}
      icon={<FileSignature className="w-5 h-5 text-brand" strokeWidth={1.8} />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            بستن
          </Button>
          {offer?.status === 'draft' && (
            <Button variant="secondary" icon={FileSignature} onClick={() => void save()} loading={busy === 'save'} disabled={Boolean(busy)}>
              ذخیرهٔ پیش‌نویس
            </Button>
          )}
          {!offer && (
            <Button icon={FileSignature} onClick={() => void create()} loading={busy === 'save'} disabled={Boolean(busy)}>
              ساخت پیش‌نویس
            </Button>
          )}
          {offer?.status === 'draft' && (
            <Button icon={Send} onClick={() => void send()} loading={busy === 'send'} disabled={Boolean(busy)}>
              ارسال با ایمیل سازمان
            </Button>
          )}
        </>
      }
    >
      {loading ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          {offer && (
            <div className="flex flex-wrap items-center gap-2">
              <Chip tone={offer.status === 'accepted' ? 'brand' : offer.status === 'declined' ? 'danger' : offer.status === 'sent' ? 'outline' : 'neutral'}>
                {OFFER_STATUS_LABEL[offer.status]}
              </Chip>
              {offer.sentAtJalali && <span className="text-[12px] text-ink-3">ارسال: {offer.sentAtJalali}</span>}
              {offer.respondedAtJalali && <span className="text-[12px] text-ink-3">پاسخ: {offer.respondedAtJalali}</span>}
              {offer.url && (offer.status === 'sent' || offer.status === 'accepted' || offer.status === 'declined') && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void copyLink()}>
                    کپی نشانی
                  </Button>
                  <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => window.open(offer.url!, '_blank', 'noopener')}>
                    دیدن صفحهٔ کارجو
                  </Button>
                </>
              )}
              {(offer.status === 'draft' || offer.status === 'sent') && (
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void cancel()} loading={busy === 'cancel'}>
                  لغو پیشنهاد
                </Button>
              )}
            </div>
          )}

          {offer?.status === 'accepted' && (
            <Callout tone="brand" icon={CheckCircle2}>
              «{offer.signatureName}» این پیشنهاد را در {offer.respondedAtJalali} پذیرفت و امضای الکترونیکی ثبت شد.
              {offer.signatureNote ? ` یادداشت کارجو: «${offer.signatureNote}»` : ''}
            </Callout>
          )}
          {offer?.status === 'declined' && offer.signatureNote && (
            <Callout tone="warning">کارجو پیشنهاد را نپذیرفت. یادداشت: «{offer.signatureNote}»</Callout>
          )}
          {!offer && (
            <Callout tone="info">
              پیشنهاد در سه قدم آماده می‌شود: نوشتن شرط‌ها، ارسال لینک با ایمیل سازمان، و امضای کارجو در همان لینک.
              تا وقتی «ارسال» را نزنید، هیچ ایمیلی بیرون نمی‌رود.
            </Callout>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <TextInput
              label="عنوان شغلی در پیشنهاد"
              value={terms.title}
              onChange={(e) => setTerms({ ...terms, title: e.target.value })}
              disabled={readOnly}
              placeholder={jobTitle || ''}
            />
            <TextInput
              label="تاریخ شروع (شمسی)"
              value={terms.startDate}
              onChange={(e) => setTerms({ ...terms, startDate: e.target.value })}
              latin
              placeholder="۱۴۰۵/۰۹/۰۱"
              disabled={readOnly}
            />
            <TextInput
              label="حقوق (تومان)"
              value={salaryField}
              onChange={(e) => {
                const digits = e.target.value.replace(/[^\d]/g, '');
                setTerms({ ...terms, salaryAmount: digits ? Number(digits) : null });
              }}
              latin
              placeholder="خالی بگذارید تا «توافقی» بنویسیم"
              hint={terms.salaryAmount === null ? 'بدون عدد؛ در پیشنهاد «توافقی» نمایش داده می‌شود.' : `${toPersianDigits(terms.salaryAmount.toLocaleString('en-US'))} تومان`}
              disabled={readOnly}
            />
            <Select
              label="دورهٔ حقوق"
              value={terms.salaryPeriod}
              onChange={(e) => setTerms({ ...terms, salaryPeriod: e.target.value as SalaryPeriod })}
              options={(Object.keys(SALARY_PERIOD_LABEL) as SalaryPeriod[]).map((k) => ({ value: k, label: SALARY_PERIOD_LABEL[k] }))}
              disabled={readOnly}
            />
            <TextInput
              label="محل کار"
              value={terms.location}
              onChange={(e) => setTerms({ ...terms, location: e.target.value })}
              disabled={readOnly}
              placeholder="تهران — ترکیبی"
            />
            <TextInput
              label="نوع همکاری"
              value={terms.employmentType}
              onChange={(e) => setTerms({ ...terms, employmentType: e.target.value })}
              disabled={readOnly}
              placeholder="تمام‌وقت"
            />
            <TextInput
              label="دورهٔ آزمایشی (ماه)"
              value={String(terms.probationMonths)}
              onChange={(e) => setTerms({ ...terms, probationMonths: Number(e.target.value.replace(/[^\d]/g, '') || 0) })}
              latin
              disabled={readOnly}
            />
            <TextInput
              label="مزایا"
              value={terms.benefitsNote}
              onChange={(e) => setTerms({ ...terms, benefitsNote: e.target.value })}
              disabled={readOnly}
              placeholder="بیمهٔ تکمیلی، پاداش عملکرد…"
            />
          </div>

          <TextArea
            label="توضیحات تکمیلی"
            value={terms.notes}
            onChange={(e) => setTerms({ ...terms, notes: e.target.value })}
            disabled={readOnly}
            rows={2}
            placeholder="مثلاً ۲ روز دورکاری در هفته"
          />

          <TextArea
            label="متن پیام همراه پیشنهاد"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            disabled={readOnly}
            rows={4}
            hint={offer ? undefined : 'اگر خالی بگذارید، متن پیش‌فرض با نام سازمان نوشته می‌شود.'}
          />

          {offer && (
            <p className="text-[11.5px] text-ink-4 leading-relaxed">
              مبلغ پیشنهاد فقط در همان صفحه و برای همان کارجو دیده می‌شود؛ لینک با توکن تصادفی ساخته می‌شود و در فهرست‌های عمومی ظاهر نمی‌شود.
              {terms.salaryAmount !== null ? ` حقوق ثبت‌شده: ${faNumber(terms.salaryAmount)} تومان.` : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, FileSignature, Send, Trash2 } from 'lucide-react';
import type { JobOffer, OfferTerms, SalaryPeriod } from '../../types/offers';
import { OFFER_STATUS_LABEL, SALARY_PERIOD_LABEL } from '../../types/offers';
import type { ResumeListItem } from '../../types/screening';
import { api } from '../../lib/api';
import { useAuth, useCan } from '../../lib/auth';
import { OFFER_APPROVAL_LABEL } from '../../types/offers';
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
  const [busy, setBusy] = useState<'save' | 'send' | 'cancel' | 'approve' | 'reject' | null>(null);
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
  const [approvalNote, setApprovalNote] = useState('');
  const { user } = useAuth();
  const canAdmin = useCan('admin');

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

  const decide = async (decision: 'approved' | 'rejected') => {
    if (!offer) return;
    setBusy(decision === 'approved' ? 'approve' : 'reject');
    try {
      const r = await api.offers.approve(offer.id, decision, approvalNote.trim() || undefined);
      applySaved(r.offer);
      setApprovalNote('');
      emitChange('activity');
      toast(
        decision === 'approved'
          ? r.pending
            ? `تأیید ثبت شد؛ مرحلهٔ بعد: ${r.pending}.`
            : 'همهٔ تأییدها کامل شد؛ حالا می‌توانید پیشنهاد را بفرستید.'
          : 'پیشنهاد رد شد و به کارجو نمی‌رود.',
        decision === 'approved' ? 'success' : 'info'
      );
    } catch (err: any) {
      toast(err?.message || 'ثبت تصمیم ممکن نشد.', 'error');
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
  const approvals = offer?.approvals || [];
  const pendingStep = approvals.find((a) => a.status === 'pending') || null;
  const canDecide = Boolean(pendingStep && offer?.status === 'draft' && (canAdmin || user?.id === pendingStep.approverId));
  const blockedByApproval = Boolean(offer?.status === 'draft' && pendingStep);
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
            <Button icon={Send} onClick={() => void send()} loading={busy === 'send'} disabled={Boolean(busy) || blockedByApproval}>
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

          {offer && approvals.length > 0 && (
            <div className="rounded-[12px] border border-line-2 bg-canvas px-3.5 py-3">
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <p className="text-[12.5px] font-bold text-ink">گردش تأیید پیشنهاد</p>
                <Chip tone={pendingStep ? 'warning' : 'brand'}>{pendingStep ? 'در انتظار تأیید' : 'تأیید‌شده'}</Chip>
                <span className="text-[11.5px] text-ink-3">
                  {toPersianDigits(approvals.filter((a) => a.status === 'approved').length)} از {toPersianDigits(approvals.length)} مرحله
                </span>
              </div>
              <ol className="flex flex-col gap-1.5">
                {approvals.map((step, i) => (
                  <li key={step.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                    <span className="w-5 h-5 rounded-full bg-line-2 text-ink-3 flex items-center justify-center text-[10.5px] hv-num shrink-0">
                      {toPersianDigits(i + 1)}
                    </span>
                    <span className="font-semibold text-ink">{step.label}</span>
                    <span className="text-ink-3">{step.approverName}</span>
                    <Chip tone={step.status === 'approved' ? 'brand' : step.status === 'rejected' ? 'danger' : 'neutral'}>
                      {OFFER_APPROVAL_LABEL[step.status]}
                    </Chip>
                    {step.decidedAtJalali && <span className="text-ink-4 text-[11px]">{step.decidedAtJalali}</span>}
                    {step.note && <span className="text-ink-4 text-[11px]">«{step.note}»</span>}
                  </li>
                ))}
              </ol>

              {blockedByApproval && canDecide && (
                <div className="mt-3 pt-3 border-t border-line-2">
                  <TextArea
                    label={`یادداشت تأیید (اختیاری) — مرحلهٔ «${pendingStep!.label}»`}
                    value={approvalNote}
                    onChange={(e) => setApprovalNote(e.target.value)}
                    rows={2}
                  />
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Button size="sm" icon={CheckCircle2} loading={busy === 'approve'} onClick={() => void decide('approved')}>
                      تأیید این مرحله
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash2} loading={busy === 'reject'} onClick={() => void decide('rejected')}>
                      رد پیشنهاد
                    </Button>
                  </div>
                </div>
              )}

              {blockedByApproval && !canDecide && (
                <p className="mt-2 text-[11.5px] text-ink-3">
                  این پیشنهاد تا تأیید «{pendingStep!.approverName}» ({pendingStep!.label}) به کارجو نمی‌رود.
                </p>
              )}
              {!blockedByApproval && offer.status === 'draft' && (
                <p className="mt-2 text-[11.5px] text-ink-3">همهٔ مراحل تأیید شده است؛ ارسال با ایمیل سازمان آزاد است.</p>
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

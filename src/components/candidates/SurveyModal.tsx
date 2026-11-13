import React, { useEffect, useState } from 'react';
import { Copy, Heart, Mail, MessageSquareHeart, Send, Trash2 } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import type { SurveyInvite, SurveyStage } from '../../types/survey';
import { SURVEY_STAGE_LABEL } from '../../types/survey';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { copyText } from '../../lib/clipboard';
import { faDate, toPersianDigits } from '../../lib/format';
import { Button, Callout, Chip, Modal, Select, Spinner, toast } from '../ui';

/**
 * «تجربهٔ کارجو» — one dialog: pick the moment, create the link, copy it or
 * send it from the workspace mailbox, and read the answer when it arrives.
 *
 * Nothing leaves the app on its own: the link is created first, then the
 * buttons that send it are explicit, and a missing mailbox is stated plainly
 * instead of pretending the e-mail went out.
 */
export function SurveyModal({
  record,
  jobTitle,
  onClose,
}: {
  record: ResumeListItem | null;
  jobTitle?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<SurveyInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<SurveyStage>('after_interview');
  const [busy, setBusy] = useState<'create' | 'send' | 'cancel' | null>(null);
  const [emailProblem, setEmailProblem] = useState<string | null>(null);

  const load = () => {
    if (!record) return;
    setLoading(true);
    api.surveys
      .list({ resumeId: record.id })
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, [record?.id]);
  useEffect(() => {
    if (!record) return;
    // The default moment follows where the candidate actually stands.
    setStage(record.decisionStatus === 'rejected' ? 'after_rejection' : record.decisionStatus === 'approved' ? 'after_hire' : 'after_interview');
  }, [record?.id, record?.decisionStatus]);

  const latest = items[0] || null;
  const open = items.find((s) => s.status === 'sent' || s.status === 'opened') || null;
  const answered = items.find((s) => s.status === 'answered') || null;

  const create = async () => {
    if (!record) return;
    setBusy('create');
    try {
      const r = await api.surveys.create({ resumeId: record.id, stage });
      setItems((prev) => [r.survey, ...prev]);
      setEmailProblem(null);
      toast('لینک نظرسنجی ساخته شد؛ هنوز چیزی فرستاده نشده است.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'ساخت نظرسنجی ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const send = async (id: string) => {
    setBusy('send');
    try {
      const r = await api.surveys.send(id);
      setItems((prev) => prev.map((s) => (s.id === id ? r.survey : s)));
      setEmailProblem(null);
      toast('نامهٔ نظرسنجی از صندوق سازمان فرستاده شد.', 'success');
    } catch (err: any) {
      const message = err?.message || 'ارسال ممکن نشد.';
      const code = String(message);
      setEmailProblem(message);
      if (/وصل نیست|EMAIL_NOT_CONFIGURED|صندوق/.test(code)) {
        toast('ایمیل سازمان وصل نیست؛ لینک را کپی کنید.', 'error');
      } else {
        toast(message, 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    setBusy('cancel');
    try {
      const r = await api.surveys.cancel(id);
      setItems((prev) => prev.map((s) => (s.id === id ? r.survey : s)));
      toast('این نظرسنجی لغو شد؛ لینک دیگر باز نمی‌شود.', 'info');
    } catch (err: any) {
      toast(err?.message || 'لغو ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = async (url?: string) => {
    if (!url) return;
    const ok = await copyText(url);
    toast(ok ? 'لینک کپی شد؛ می‌توانید خودتان بفرستید.' : 'کپی ممکن نشد؛ خط را انتخاب کنید.', ok ? 'success' : 'error');
  };

  const rowTone = (s: SurveyInvite) =>
    s.status === 'answered' ? 'brand' : s.status === 'expired' ? 'neutral' : s.status === 'opened' ? 'warning' : 'neutral';
  const rowLabel = (s: SurveyInvite) =>
    s.status === 'answered' ? 'پاسخ داده' : s.status === 'expired' ? 'بسته' : s.status === 'opened' ? 'باز شده، بی‌پاسخ' : 'فرستاده‌شده';

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      title="تجربهٔ کارجو"
      description="یک نظرسنجی کوتاه: امتیاز ۰ تا ۱۰ و سه سؤال تجربه. نتیجه در «گزارش‌ها» به شکل NPS می‌آید."
      icon={<Heart className="w-5 h-5 text-brand-ink" strokeWidth={1.9} />}
      size="md"
    >
      {loading ? (
        <div className="py-10 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <Select
              label="کدام لحظه از مسیر؟"
              value={stage}
              onChange={(e) => setStage(e.target.value as SurveyStage)}
              options={(Object.keys(SURVEY_STAGE_LABEL) as SurveyStage[]).map((id) => ({ value: id, label: SURVEY_STAGE_LABEL[id] }))}
              disabled={Boolean(open) || busy !== null}
            />
            <div className="flex items-end">
              <Button
                icon={MessageSquareHeart}
                onClick={() => void create()}
                loading={busy === 'create'}
                disabled={busy !== null || Boolean(open)}
                className="w-full"
              >
                ساخت لینک نظرسنجی
              </Button>
            </div>
          </div>
          {open && <p className="text-[11.5px] text-ink-4">برای این کارجو یک نظرسنجی باز وجود دارد؛ همان را بفرستید یا لغو کنید.</p>}

          {emailProblem && (
            <Callout tone="warning">
              {emailProblem}
              {open?.url && (
                <Button variant="ghost" icon={Copy} className="ms-2" onClick={() => void copy(open.url)}>
                  کپی لینک
                </Button>
              )}
            </Callout>
          )}

          {!record?.contact?.email && (
            <Callout tone="info">
              برای این کارجو ایمیل ثبت نشده است؛ لینک را بسازید و خودتان از هر راهی که مناسب است بفرستید.
            </Callout>
          )}

          {items.length === 0 && <p className="text-[13px] text-ink-3">هنوز نظرسنجی‌ای برای این کارجو ساخته نشده است.</p>}

          <div className="space-y-2.5">
            {items.map((s) => (
              <div key={s.id} className="rounded-[12px] border border-line-2 p-3 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone={rowTone(s) as any}>{rowLabel(s)}</Chip>
                  <span className="text-[12px] text-ink-3">{SURVEY_STAGE_LABEL[s.stage]}</span>
                  {s.sentAtJalali && <span className="text-[11.5px] text-ink-4">فرستاده‌شده {s.sentAtJalali}</span>}
                  {typeof s.score === 'number' && (
                    <span className="text-[12px] font-bold text-brand-ink mr-auto">
                      امتیاز {toPersianDigits(s.score)} از ۱۰
                    </span>
                  )}
                </div>

                {s.status === 'answered' ? (
                  <div className="space-y-1">
                    {s.comment && <p className="text-[12.5px] text-ink-2 leading-relaxed">«{s.comment}»</p>}
                    <p className="text-[11.5px] text-ink-4">
                      {[s.answers.clarity, s.answers.speed, s.answers.respect].filter((v) => typeof v === 'number').length
                        ? `مراحل ${s.answers.clarity ? toPersianDigits(s.answers.clarity) : '—'}، سرعت ${s.answers.speed ? toPersianDigits(s.answers.speed) : '—'}، رفتار ${s.answers.respect ? toPersianDigits(s.answers.respect) : '—'} (از ۵)`
                        : 'سه سؤال تجربه را بی‌پاسخ گذاشته است.'}
                      {s.answeredAtJalali ? ` · ${s.answeredAtJalali}` : ''}
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    <code dir="ltr" className="text-[11px] font-mono text-ink-4 truncate max-w-[240px]">
                      {s.url}
                    </code>
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copy(s.url)}>
                      کپی
                    </Button>
                    {s.status !== 'expired' && (
                      <>
                        <Button size="sm" variant="secondary" icon={Mail} onClick={() => void send(s.id)} loading={busy === 'send'} disabled={busy !== null}>
                          {s.sentAtISO ? 'ارسال دوباره' : 'ارسال با ایمیل سازمان'}
                        </Button>
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void cancel(s.id)} disabled={busy !== null}>
                          لغو
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="text-[11.5px] text-ink-4 leading-relaxed">
            لینک تا {toPersianDigits(30)} روز باز است و فقط یک بار پاسخ می‌گیرد. پاسخ‌ها به نتیجهٔ درخواست کارجو گره نمی‌خورند و در پروندهٔ او
            فقط برای تیم منابع انسانی دیده می‌شوند.
          </p>
        </div>
      )}
    </Modal>
  );
}

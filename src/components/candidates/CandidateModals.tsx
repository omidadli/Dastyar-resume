import React, { useEffect, useState } from 'react';
import { Archive, Check, Copy, Mail, MessageCircle, MessageSquareText, Send, ThumbsDown } from 'lucide-react';
import type { DraftMessage, MessageKind, ResumeListItem } from '../../types/screening';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { mailLink, smsLink, whatsappLink } from '../../lib/phone';
import { REJECT_REASONS } from '../../lib/match';
import { candidateName } from '../../lib/format';
import { emitChange } from '../../lib/events';
import { copyText } from '../../lib/clipboard';
import { Button, Callout, Chip, Modal, Segmented, Select, Skeleton, TextArea, TextInput, toast } from '../ui';

const KINDS: { id: MessageKind; label: string }[] = [
  { id: 'INTERVIEW_INVITE', label: 'دعوت به مصاحبه' },
  { id: 'INFO_REQUEST', label: 'تکمیل اطلاعات' },
  { id: 'BANK_NOTICE', label: 'بانک استعداد' },
  { id: 'REJECTION', label: 'اعلام نتیجه' },
];

function defaultKind(r: ResumeListItem): MessageKind {
  if (r.decisionStatus === 'rejected') return r.inBank ? 'BANK_NOTICE' : 'REJECTION';
  if (r.decisionStatus === 'approved' || r.category === 'INTERVIEW') return 'INTERVIEW_INVITE';
  if (r.category === 'UNJUDGEABLE') return 'INFO_REQUEST';
  return r.inBank ? 'BANK_NOTICE' : 'INFO_REQUEST';
}

export function MessageModal({
  record,
  onClose,
  onSent,
}: {
  record: ResumeListItem | null;
  onClose: () => void;
  onSent?: (r: ResumeListItem) => void;
}) {
  // The right message type from the start: seeding it in an effect would
  // first request (and pay for) an AI draft of the wrong type.
  const [kind, setKind] = useState<MessageKind>(() => (record ? defaultKind(record) : 'INTERVIEW_INVITE'));
  const [draft, setDraft] = useState<DraftMessage | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!record) return;
    const controller = new AbortController(); // switching type cancels the previous draft
    setLoading(true);
    setDraft(null);
    api.messages
      .draft(record.id, kind, { signal: controller.signal })
      .then((d) => {
        if (controller.signal.aborted) return;
        setDraft(d);
        setSubject(d.subject);
        setBody(d.body);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        toast(e?.message || 'تهیه پیش‌نویس ممکن نشد.', 'error');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, kind]);

  if (!record) return null;
  const phone = record.contact?.phone;
  const email = record.contact?.email;
  // No links to the previous type's text while the new draft is loading.
  const wa = loading ? null : whatsappLink(phone, body);
  const sms = loading ? null : smsLink(phone, body);
  const mail = loading ? null : mailLink(email, subject, body);

  const copy = async () => {
    if (await copyText(`${subject}\n\n${body}`)) {
      setCopied(true);
      toast('متن پیام کپی شد.');
      setTimeout(() => setCopied(false), 1800);
    } else {
      toast('کپی خودکار ممکن نشد؛ متن را دستی انتخاب کنید.', 'error');
    }
  };

  const markSent = async () => {
    setSaving(true);
    try {
      const { record: updated } = await api.resumes.markMessageSent(record.id, kind);
      onSent?.(updated);
      emitChange('activity');
      toast('پیام به‌عنوان «ارسال‌شده» ثبت شد.');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'ثبت وضعیت ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const channel = (href: string | null, label: string, Icon: typeof Mail) => (
    <a
      href={href || undefined}
      target={href?.startsWith('http') ? '_blank' : undefined}
      rel="noreferrer"
      aria-disabled={!href}
      onClick={(e) => !href && e.preventDefault()}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-[9px] border text-[13px] font-semibold transition-colors ${
        href ? 'border-line text-ink-2 hover:border-line-strong hover:bg-canvas' : 'border-line text-ink-4 cursor-not-allowed opacity-60'
      }`}
    >
      <Icon className="w-4 h-4" strokeWidth={1.8} />
      {label}
    </a>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<MessageSquareText className="w-5 h-5 text-brand-strong" />}
      title={`پیام به ${candidateName(record)}`}
      description="پیش‌نویس را ویرایش کنید و با کانال دلخواه بفرستید. هویدا پیامی را خودکار ارسال نمی‌کند."
      footer={
        <>
          <Button variant="secondary" icon={copied ? Check : Copy} onClick={copy} disabled={loading}>
            کپی متن
          </Button>
          <Button icon={Send} onClick={markSent} loading={saving} disabled={loading}>
            ثبت به‌عنوان ارسال‌شده
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented items={KINDS} value={kind} onChange={setKind} className="w-full sm:w-auto" />
        {loading ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-11" />
            <Skeleton className="h-48" />
          </div>
        ) : (
          <>
            <TextInput label="موضوع" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <TextArea label="متن پیام" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="min-h-[220px]" />
            {draft?.engine === 'local' && (
              <p className="text-xs text-ink-3">این پیش‌نویس از قالب آماده ساخته شده است (هوش مصنوعی در دسترس نبود).</p>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {channel(wa, 'واتساپ', MessageCircle)}
          {channel(sms, 'پیامک', MessageSquareText)}
          {channel(mail, 'ایمیل', Mail)}
        </div>
        {!phone && !email && (
          <Callout tone="warning">شماره تماس یا ایمیلی در رزومه پیدا نشد؛ می‌توانید متن را کپی کنید و از مسیر دیگری بفرستید.</Callout>
        )}
      </div>
    </Modal>
  );
}

export function TalentModal({
  record,
  onClose,
  onSaved,
}: {
  record: ResumeListItem | null;
  onClose: () => void;
  onSaved?: (r: ResumeListItem) => void;
}) {
  const { org } = useAuth();
  const [dept, setDept] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!record) return;
    // The job's department may have been renamed away/deleted since: never
    // preselect an id the <select> can't show (saving it would fail).
    const known = (id: string | null | undefined) => Boolean(id && org?.departments.some((d) => d.id === id));
    setDept([record.bankDepartmentId, record.departmentId].find(known) || org?.departments[0]?.id || '');
    setNote(record.bankNote || '');
    setTags(Array.from(new Set([...(record.bankTags || []), ...record.tags])).slice(0, 8));
    // Seed once per candidate: later refreshes of `record`/`org` must not wipe the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id]);

  if (!record || !org) return null;
  const TAG_LIMIT = 12; // the server keeps at most 12
  const atLimit = tags.length >= TAG_LIMIT;
  const addTag = () => {
    const t = tagInput.trim().slice(0, 40);
    if (!t || atLimit) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagInput('');
  };
  const save = async () => {
    setSaving(true);
    try {
      const { record: updated } = await api.resumes.addTalent(record.id, { departmentId: dept, note, tags });
      onSaved?.(updated);
      emitChange('talent');
      emitChange('activity');
      toast(record.inBank ? 'اطلاعات بانک استعداد به‌روز شد.' : `«${candidateName(record)}» به بانک استعداد اضافه شد.`);
      onClose();
    } catch (e: any) {
      toast(e?.message || 'افزودن به بانک استعداد ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      icon={<Archive className="w-5 h-5 text-brand-strong" />}
      title={record.inBank ? 'ویرایش در بانک استعداد' : 'افزودن به بانک استعداد'}
      description="کاندیداهای ارزشمند را برای فرصت‌های آینده نگه دارید؛ هر وقت لازم شد با جست‌وجو و برچسب پیدایشان کنید."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={save} loading={saving} disabled={!dept}>
            {record.inBank ? 'به‌روزرسانی' : 'افزودن به بانک'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="دپارتمان مقصد"
          value={dept}
          onChange={(e) => setDept(e.target.value)}
          options={org.departments.map((d) => ({ value: d.id, label: d.name }))}
        />
        <TextArea label="یادداشت" optional value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="مثلاً: برای نقش سرپرستی در شش ماه آینده مناسب است." />
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-ink-2">برچسب‌ها</span>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button key={t} onClick={() => setTags(tags.filter((x) => x !== t))} title="حذف برچسب" aria-label={`حذف برچسب «${t}»`} className="group">
                <Chip tone="brand" className="group-hover:bg-low-soft group-hover:text-low-ink">
                  {t} ×
                </Chip>
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder={atLimit ? 'حداکثر ۱۲ برچسب' : 'برچسب تازه و Enter'}
              aria-label="برچسب تازه"
              maxLength={40}
              disabled={atLimit}
              className="flex-1 h-10 px-3 rounded-control border border-line bg-surface text-sm focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:bg-canvas disabled:cursor-not-allowed"
            />
            <Button variant="secondary" onClick={addTag} disabled={atLimit || !tagInput.trim()}>
              افزودن
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function RejectModal({
  open,
  name,
  onClose,
  onConfirm,
  loading,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
  onConfirm: (note: string) => void;
  loading?: boolean;
}) {
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setReason('');
      setNote('');
    }
  }, [open]);
  const final = [reason, note.trim()].filter(Boolean).join(' — ');
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="md"
      icon={<ThumbsDown className="w-5 h-5 text-low-ink" />}
      title={`رد کردن ${name}`}
      description="دلیل رد فقط برای تیم شما ثبت می‌شود و در گزارش‌ها و تصمیم‌های بعدی کمک می‌کند."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button variant="danger" onClick={() => onConfirm(final)} loading={loading}>
            ثبت رد
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {REJECT_REASONS.map((r) => (
            <button
              key={r}
              onClick={() => setReason(reason === r ? '' : r)}
              className={`h-9 px-3 rounded-full border text-[13px] font-medium transition-colors ${
                reason === r ? 'bg-low-soft border-low/40 text-low-ink' : 'border-line text-ink-2 hover:border-line-strong'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        <TextArea label="توضیح بیشتر" optional value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </div>
    </Modal>
  );
}

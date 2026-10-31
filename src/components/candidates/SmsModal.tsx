import React, { useEffect, useState } from 'react';
import { Send, Smartphone } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import type { SentSms } from '../../types/integrations';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { candidateName, faRelative, toPersianDigits } from '../../lib/format';
import { Button, Callout, Modal, TextArea, toast } from '../ui';

/**
 * «ارسال پیامک» — the candidate's own phone, the workspace's own line.
 * Nothing is sent until the HR person presses the button, and the sent text is
 * stored on the candidate's timeline exactly as written.
 */
const MAX = 900;

const TEMPLATES: { id: string; label: string; text: (name: string) => string }[] = [
  { id: 'invite', label: 'دعوت به مصاحبه', text: (n) => `${n} عزیز، از طرف تیم جذب. برای آشنایی بیشتر دعوت به مصاحبه شده‌اید؛ جزئیات زمان و نشانی در ایمیل شماست.` },
  { id: 'remind', label: 'یادآوری جلسه', text: (n) => `${n} عزیز، یادآوری جلسهٔ فردا. اگر زمان دیگری مناسب‌تر است، همین پیام را پاسخ دهید.` },
  { id: 'status', label: 'اطلاع‌رسانی وضعیت', text: (n) => `${n} عزیز، وضعیت درخواست شما در سامانه به‌روزرسانی شد. برای دیدن جزئیات وارد صفحهٔ کارجویان شوید.` },
];

/** Rough Persian SMS page count — 70 characters per page is the operator standard. */
function pageCount(text: string) {
  return Math.max(1, Math.ceil(text.length / 70));
}

export function SmsModal({
  record,
  onClose,
  onSent,
}: {
  record: ResumeListItem | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [last, setLast] = useState<SentSms | null>(null);
  const phone = record?.contact?.phone || '';

  useEffect(() => {
    if (!record) return;
    setText('');
    setLast(null);
    api.integrations
      .status()
      .then((s) => setConfigured(Boolean(s.sms?.configured)))
      .catch(() => setConfigured(null));
  }, [record?.id]);

  const send = async () => {
    if (!record || !text.trim()) return;
    setSending(true);
    try {
      const res = await api.integrations.sendSms({ resumeId: record.id, text: text.trim() });
      setLast(res.sms);
      toast(`پیامک برای ${toPersianDigits(phone)} فرستاده شد.`);
      emitChange('resumes');
      emitChange('activity');
      onSent?.();
      onClose();
    } catch (err: any) {
      toast(err?.message || 'ارسال پیامک ممکن نشد.', 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      title="ارسال پیامک"
      description={record ? `${candidateName(record)} — ${toPersianDigits(phone) || 'بدون شمارهٔ تماس'}` : undefined}
      icon={<Smartphone className="w-5 h-5 text-brand" strokeWidth={1.8} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            بستن
          </Button>
          <Button icon={Send} onClick={() => void send()} loading={sending} disabled={!phone || !text.trim() || !configured}>
            ارسال پیامک
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {configured === false && (
          <Callout tone="warning">
            هنوز سرویس پیامک وصل نشده است. از «تنظیمات ← اتصال‌ها» خط و کلید API کاوه‌نگار یا sms.ir را وارد کنید؛ پس از آن
            پیامک از همین‌جا فرستاده می‌شود.
          </Callout>
        )}
        {!phone && <Callout tone="warning">برای این کاندیدا شمارهٔ همراه ثبت نشده است؛ ابتدا شماره را در پروفایل تکمیل کنید.</Callout>}
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <Button
              key={t.id}
              size="sm"
              variant="secondary"
              onClick={() => setText(t.text(candidateName(record!).split(' ')[0] || 'دوست گرامی'))}
              disabled={!record}
            >
              {t.label}
            </Button>
          ))}
        </div>
        <TextArea
          label="متن پیامک"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX))}
          placeholder="متن کوتاه، بدون لینک‌های طولانی…"
          hint={`${toPersianDigits(text.length)} از ${toPersianDigits(MAX)} نویسه — حدود ${toPersianDigits(pageCount(text))} پیامک`}
        />
        {last && (
          <p className="text-[12px] text-ink-3">
            آخرین ارسال: {faRelative(last.sentAtISO)} — {last.status === 'sent' ? 'موفق' : last.error || 'ناموفق'}
          </p>
        )}
        <p className="text-[11.5px] text-ink-4 leading-relaxed">
          متن دقیقاً همان‌طور که می‌نویسید فرستاده و در تاریخچهٔ کاندیدا ثبت می‌شود. اعتبار پیامک از حساب خودتان کم می‌شود.
        </p>
      </div>
    </Modal>
  );
}

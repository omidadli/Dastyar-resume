import React, { useEffect, useState } from 'react';
import { CalendarClock, Copy, ExternalLink, Plus, Send, Trash2 } from 'lucide-react';
import type { SchedulingLink } from '../../types/scheduling';
import type { ResumeListItem } from '../../types/screening';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { candidateName, toPersianDigits } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { Button, Callout, Chip, IconButton, Modal, Select, Spinner, TextInput, toast } from '../ui';

/** A reasonable starting set: three mornings in the coming week, 10:00 and 11:30. */
function defaultSlots(): { date: string; time: string }[] {
  const out: { date: string; time: string }[] = [];
  for (const days of [2, 3, 4]) out.push({ date: jalaliOfDaysAhead(days), time: '10:00' });
  return out;
}

/** Tehran Jalali date N days from now — the server validates the pair again. */
function jalaliOfDaysAhead(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).replace(/\//g, '/');
  } catch {
    return '';
  }
}

/**
 * «لینک زمان‌بندی» — offer a handful of times and let the candidate choose one.
 * Nothing is booked until they do, and the booking creates the same interview as
 * the manual modal (calendar event + invitation).
 */
export function SchedulingModal({ record, jobTitle, onClose }: { record: ResumeListItem | null; jobTitle?: string; onClose: () => void }) {
  const [link, setLink] = useState<SchedulingLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'send' | 'cancel' | null>(null);
  const [slots, setSlots] = useState(defaultSlots);
  const [durationMin, setDurationMin] = useState(45);
  const [expiresInDays, setExpiresInDays] = useState(7);

  useEffect(() => {
    if (!record) return;
    setLoading(true);
    api.scheduling
      .list({ resumeId: record.id })
      .then((r) => setLink(r.items.find((l) => l.status === 'open') || r.items[0] || null))
      .catch(() => setLink(null))
      .finally(() => setLoading(false));
  }, [record?.id]);

  const create = async () => {
    if (!record) return;
    const clean = slots.filter((s) => s.date && s.time);
    if (!clean.length) return toast('دست‌کم یک زمان را پر کنید.', 'error');
    setBusy('create');
    try {
      const r = await api.scheduling.create({ resumeId: record.id, slots: clean, durationMin, expiresInDays });
      setLink(r.link);
      emitChange('activity');
      toast('لینک زمان‌بندی ساخته شد؛ نشانی را برای کارجو بفرستید.');
    } catch (err: any) {
      toast(err?.message || 'ساخت لینک ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!link) return;
    setBusy('send');
    try {
      const r = await api.scheduling.send(link.id);
      setLink(r.link);
      toast('لینک با ایمیل سازمان برای کارجو فرستاده شد.');
    } catch (err: any) {
      toast(err?.message || 'ارسال نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!link) return;
    setBusy('cancel');
    try {
      const r = await api.scheduling.cancel(link.id);
      setLink(r.link);
      toast('لینک لغو شد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'لغو نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!link?.url) return;
    const ok = await copyText(link.url);
    toast(ok ? 'نشانی کپی شد.' : 'کپی نشد.', ok ? 'success' : 'error');
  };

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      title="انتخاب زمان مصاحبه"
      description={record ? `${candidateName(record)} — ${jobTitle || ''}` : undefined}
      icon={<CalendarClock className="w-5 h-5 text-brand" strokeWidth={1.8} />}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            بستن
          </Button>
          {link?.status === 'open' && (
            <Button icon={Send} onClick={() => void send()} loading={busy === 'send'} disabled={Boolean(busy)}>
              ارسال با ایمیل سازمان
            </Button>
          )}
          {!link && (
            <Button icon={Plus} onClick={() => void create()} loading={busy === 'create'} disabled={Boolean(busy)}>
              ساخت لینک
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
          {!link && (
            <>
              <Callout tone="info">
                چند زمان مشخص پیشنهاد می‌دهید و کارجو یکی را انتخاب می‌کند. با انتخاب او، جلسه در تقویم ساخته و
                دعوت‌نامه فرستاده می‌شود — بدون رفت‌وبرگشت ایمیلی.
              </Callout>
              <div className="space-y-2">
                {slots.map((s, i) => (
                  <div key={i} className="flex items-end gap-2">
                    <TextInput
                      label="تاریخ (شمسی)"
                      value={s.date}
                      onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                      latin
                      placeholder="۱۴۰۵/۰۹/۰۳"
                    />
                    <TextInput
                      label="ساعت (تهران)"
                      value={s.time}
                      onChange={(e) => setSlots(slots.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                      latin
                      placeholder="10:00"
                    />
                    <IconButton
                      icon={Trash2}
                      label="حذف زمان"
                      onClick={() => setSlots(slots.filter((_, j) => j !== i))}
                      disabled={slots.length <= 1}
                    />
                  </div>
                ))}
                {slots.length < 8 && (
                  <Button size="sm" variant="ghost" icon={Plus} onClick={() => setSlots([...slots, { date: jalaliOfDaysAhead(5 + slots.length), time: '10:00' }])}>
                    افزودن زمان دیگر
                  </Button>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <Select
                  label="مدت جلسه"
                  value={String(durationMin)}
                  onChange={(e) => setDurationMin(Number(e.target.value))}
                  options={[30, 45, 60, 90].map((m) => ({ value: String(m), label: `${toPersianDigits(m)} دقیقه` }))}
                />
                <Select
                  label="مهلت انتخاب"
                  value={String(expiresInDays)}
                  onChange={(e) => setExpiresInDays(Number(e.target.value))}
                  options={[3, 7, 14].map((d) => ({ value: String(d), label: `${toPersianDigits(d)} روز` }))}
                />
              </div>
            </>
          )}

          {link && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={link.status === 'booked' ? 'brand' : link.status === 'cancelled' ? 'neutral' : 'outline'}>
                  {link.status === 'booked' ? 'زمان انتخاب شد' : link.status === 'cancelled' ? 'لغو‌شده' : 'در انتظار انتخاب کارجو'}
                </Chip>
                <span className="text-[12px] text-ink-3">مهلت انتخاب: {link.expiresAtISO.slice(0, 10)}</span>
                {link.url && (
                  <>
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => void copy()}>
                      کپی نشانی
                    </Button>
                    <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => window.open(link.url!, '_blank', 'noopener')}>
                      دیدن صفحه
                    </Button>
                  </>
                )}
                {link.status === 'open' && (
                  <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void cancel()} loading={busy === 'cancel'}>
                    لغو لینک
                  </Button>
                )}
              </div>

              <div className="rounded-[12px] border border-line divide-y divide-line-2">
                {link.slots.map((s) => (
                  <div key={s.startsAtISO} className="flex items-center justify-between gap-2 px-3.5 py-2.5">
                    <span className="text-[13px] text-ink">
                      {s.date} — ساعت {s.time}
                    </span>
                    {s.takenBy ? (
                      <Chip tone="brand">انتخاب شد</Chip>
                    ) : (
                      <Chip tone="outline">آزاد</Chip>
                    )}
                  </div>
                ))}
              </div>

              {link.interviewId && (
                <Callout tone="brand">
                  جلسه ساخته شد و دعوت‌نامه برای کارجو رفت. جلسه را در صفحهٔ همان فرصت شغلی می‌بینید.
                </Callout>
              )}
              <p className="text-[11.5px] text-ink-4 leading-relaxed">
                هر زمان فقط یک‌بار قابل انتخاب است و زمان‌های گذشته به کارجو نشان داده نمی‌شوند.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

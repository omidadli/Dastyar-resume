import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck2,
  CalendarClock,
  CheckCircle2,
  Download,
  ExternalLink,
  Mail,
  Video,
} from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import type { CalendarStatusPublic, EmailSettingsPublic, InterviewRecord } from '../../types/integrations';
import { api } from '../../lib/api';
import { candidateName, faDate, toPersianDigits } from '../../lib/format';
import { getTodayJalali, toJalaliDateString } from '../../utils/jalali';
import { emitChange } from '../../lib/events';
import { Button, ButtonLink, Callout, Modal, Select, Switch, TextArea, TextInput, toast } from '../ui';

const DURATIONS = [30, 45, 60, 90, 120];

/** Tomorrow in Jalali — a sane default that is never in the past. */
function tomorrowJalali(): string {
  const today = getTodayJalali();
  const d = new Date(today.year, today.month - 1, today.day);
  d.setDate(d.getDate() + 1);
  return toJalaliDateString(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * «تعیین جلسهٔ مصاحبه» — one form for HOVIDA + Google Calendar + the e-mail
 * invitation. The card at the top says exactly what will happen given the
 * workspace's current connections, so nothing arrives at the candidate by
 * surprise.
 */
export function InterviewModal({
  record,
  jobId,
  jobTitle,
  onClose,
  onScheduled,
}: {
  record: ResumeListItem | null;
  jobId: string;
  jobTitle: string;
  onClose: () => void;
  onScheduled?: (interview: InterviewRecord, updated: ResumeListItem | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(tomorrowJalali());
  const [time, setTime] = useState('10:00');
  const [duration, setDuration] = useState(45);
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [withMeet, setWithMeet] = useState(true);
  const [sendInvite, setSendInvite] = useState(true);
  const [email, setEmail] = useState('');
  const [interviewerIds, setInterviewerIds] = useState<string[]>([]);
  const [members, setMembers] = useState<Array<{ id: string; name: string; title: string }>>([]);
  const [calendar, setCalendar] = useState<CalendarStatusPublic | null>(null);
  const [mail, setMail] = useState<EmailSettingsPublic | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ interview: InterviewRecord; calendarError: string | null; emailError: string | null } | null>(null);

  useEffect(() => {
    if (!record) return;
    setTitle(`مصاحبهٔ ${candidateName(record)} — ${jobTitle}`);
    setEmail(record.contact?.email || '');
    setNotes('');
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id, jobTitle]);

  useEffect(() => {
    api.org
      .get()
      .then((r) => setMembers(r.members.map((m) => ({ id: m.id, name: m.name, title: m.title }))))
      .catch(() => setMembers([]));
    api.integrations
      .status()
      .then((s) => {
        setCalendar(s.calendar);
        setMail(s.email);
      })
      .catch(() => undefined);
  }, []);

  if (!record) return null;

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const schedule = async () => {
    setSaving(true);
    try {
      const res = await api.interviews.create({
        jobId,
        resumeId: record.id,
        candidateName: candidateName(record),
        candidateEmail: email.trim() || null,
        title,
        date,
        time,
        durationMin: duration,
        interviewerIds,
        location,
        notes,
        withMeet: Boolean(calendar?.connected) && withMeet,
        sendInvite,
      });
      setResult({ interview: res.interview, calendarError: res.calendarError, emailError: res.emailError });
      emitChange('interviews');
      emitChange('activity');
      onScheduled?.(res.interview, res.record);
      if (!res.calendarError && !res.emailError) toast('جلسه ثبت شد و دعوت‌نامه ارسال شد.', 'success');
      else toast('جلسه در هویدا ثبت شد؛ جزئیات ارسال را ببینید.', 'info');
    } catch (e: any) {
      toast(e?.message || 'ثبت جلسه ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleInterviewer = (id: string) =>
    setInterviewerIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].slice(0, 12)));

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      icon={<CalendarClock className="w-5 h-5 text-brand-strong" />}
      title={result ? 'جلسهٔ مصاحبه ثبت شد' : 'تعیین جلسهٔ مصاحبه'}
      description={
        result
          ? 'این جلسه در سابقهٔ کاندید و در فهرست جلسه‌های فرصت شغلی می‌ماند.'
          : `زمان جلسه را انتخاب کنید؛ تاریخ و ساعت به وقت تهران ثبت می‌شود.`
      }
      footer={
        result ? (
          <>
            <Button variant="secondary" icon={Download} onClick={() => window.open(api.interviews.icsUrl(result.interview.id), '_blank')}>
              دانلود فایل ICS
            </Button>
            <Button onClick={onClose}>بستن</Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              انصراف
            </Button>
            <Button icon={CalendarCheck2} onClick={schedule} loading={saving} disabled={!title.trim() || !date || !time}>
              ثبت جلسه
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-[12px] border border-line-2 bg-canvas p-4">
            <p className="text-[14px] font-bold text-ink">{result.interview.title}</p>
            <p className="text-[13px] text-ink-2 mt-1">
              {faDate(result.interview.startsAtISO)}، ساعت {toPersianDigits(new Date(result.interview.startsAtISO).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' }))}، {toPersianDigits(result.interview.durationMin)} دقیقه
            </p>
            {result.interview.interviewerNames.length > 0 && (
              <p className="text-[12.5px] text-ink-3 mt-1">مصاحبه‌گر: {result.interview.interviewerNames.join('، ')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              {result.interview.calendarHtmlLink && (
                <ButtonLink to={result.interview.calendarHtmlLink} target="_blank" rel="noreferrer" variant="secondary" size="sm" icon={CalendarCheck2}>
                  رویداد در Google Calendar
                </ButtonLink>
              )}
              {result.interview.meetLink && (
                <ButtonLink to={result.interview.meetLink} target="_blank" rel="noreferrer" variant="secondary" size="sm" icon={Video}>
                  لینک Google Meet
                </ButtonLink>
              )}
            </div>
          </div>
          {result.interview.calendarEventId && (
            <Callout tone="brand" icon={CheckCircle2}>
              رویداد در تقویم شما ثبت شد و دعوت‌نامه از سوی Google برای کارجو{result.interview.inviteSentTo ? ` (${result.interview.inviteSentTo})` : ''} ارسال شد.
            </Callout>
          )}
          {result.calendarError && (
            <Callout tone="warning" icon={AlertTriangle} title="ثبت در Google Calendar انجام نشد">
              {result.calendarError} — جلسه در هویدا ذخیره شد و می‌توانید فایل ICS را دانلود و برای کارجو بفرستید.
            </Callout>
          )}
          {result.emailError && (
            <Callout tone="warning" icon={Mail} title="دعوت‌نامه ایمیلی ارسال نشد">
              {result.emailError}
            </Callout>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Callout
            tone={calendar?.connected ? 'brand' : 'info'}
            icon={calendar?.connected ? CalendarCheck2 : AlertTriangle}
            title={calendar?.connected ? `تقویم متصل: ${calendar.accountEmail}` : 'تقویم گوگل وصل نیست'}
          >
            {calendar?.connected
              ? 'رویداد در تقویم شما ساخته می‌شود، لینک Google Meet اضافه می‌شود و دعوت‌نامه را خود گوگل برای کارجو می‌فرستد.'
              : 'جلسه فقط در هویدا ثبت می‌شود. برای ارسال دعوت‌نامه، اتصال تقویم یا ایمیل سازمان لازم است؛ الان می‌توانید فایل ICS را دانلود کنید.'}
            {!calendar?.connected && (
              <span className="block mt-1">
                <ButtonLink to="/app/settings/integrations" variant="secondary" size="sm" icon={ExternalLink}>
                  تنظیم اتصال‌ها
                </ButtonLink>
              </span>
            )}
          </Callout>

          <TextInput label="عنوان جلسه" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
          <div className="grid sm:grid-cols-3 gap-3">
            <TextInput
              label="تاریخ (شمسی)"
              placeholder="۱۴۰۴/۰۷/۱۲"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              hint="مثال: ۱۴۰۴/۰۷/۱۲"
            />
            <TextInput label="ساعت (تهران)" placeholder="۱۰:۳۰" value={time} onChange={(e) => setTime(e.target.value)} hint="۲۴ ساعتی" />
            <Select
              label="مدت جلسه"
              value={String(duration)}
              onChange={(e) => setDuration(Number(e.target.value))}
              options={DURATIONS.map((d) => ({ value: String(d), label: `${d.toLocaleString('fa-IR')} دقیقه` }))}
            />
          </div>

          <div>
            <p className="text-sm font-semibold text-ink mb-1.5">مصاحبه‌گران</p>
            <div className="flex flex-wrap gap-1.5">
              {members.length === 0 && <p className="text-[12.5px] text-ink-3">عضو تیم دیگری ثبت نشده است.</p>}
              {members.map((m) => {
                const active = interviewerIds.includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggleInterviewer(m.id)}
                    aria-pressed={active}
                    className={`h-8 px-3 rounded-full border text-[12.5px] font-semibold transition-colors ${
                      active ? 'bg-brand-soft border-brand/30 text-brand-stronger' : 'bg-surface border-line text-ink-2 hover:border-line-strong'
                    }`}
                  >
                    {m.name}
                    {m.title ? <span className="text-ink-4 font-normal"> · {m.title}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <TextInput
              label="ایمیل کارجو"
              dir="ltr"
              placeholder="candidate@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              hint="دعوت‌نامه و لینک جلسه به این نشانی می‌رود."
            />
            <TextInput
              label="مکان (اختیاری)"
              placeholder="دفتر مرکزی، اتاق ۳ — یا خالی بگذارید تا آنلاین باشد"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <TextArea
            label="توضیح برای کارجو (اختیاری)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            hint="این متن در رویداد تقویم و دعوت‌نامه می‌آید."
          />

          {calendar?.connected && (
            <Switch checked={withMeet} onChange={setWithMeet} label="ساخت لینک Google Meet" description="برای مصاحبهٔ آنلاین لینک ویدیویی به رویداد اضافه می‌شود." />
          )}
          {!calendar?.connected && mail?.configured && (
            <Switch
              checked={sendInvite}
              onChange={setSendInvite}
              label="ارسال دعوت‌نامه با ایمیل سازمان"
              description={`از ${mail.fromAddress} برای کارجو فرستاده می‌شود، همراه فایل تقویم (ICS).`}
            />
          )}
          {!validEmail && email.trim().length > 0 && (
            <p className="text-[12px] text-low-ink">ایمیل کارجو معتبر نیست؛ دعوت‌نامه‌ای ارسال نخواهد شد.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Compact list of an opening's interviews (used on the job page). */
export function InterviewList({ items, onCancel }: { items: InterviewRecord[]; onCancel: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col divide-y divide-line-2">
      {items.map((it) => (
        <div key={it.id} className="flex items-start gap-3 py-2.5">
          <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${it.status === 'cancelled' ? 'bg-line-strong' : 'bg-brand'}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-ink truncate">{it.candidateName}</p>
            <p className="text-[12px] text-ink-3">
              {faDate(it.startsAtISO)}، {toPersianDigits(it.durationMin)} دقیقه
              {it.status === 'cancelled' ? ' · لغو شده' : ''}
            </p>
            {it.status !== 'cancelled' && it.reminderSentAtISO && (
              <p className="text-[11.5px] text-brand-strong mt-0.5">یادآوری برای کارجو فرستاده شد</p>
            )}
          </div>
          {it.meetLink && it.status !== 'cancelled' && (
            <ButtonLink to={it.meetLink} target="_blank" rel="noreferrer" variant="secondary" size="sm">
              Meet
            </ButtonLink>
          )}
          {it.status !== 'cancelled' && (
            <Button variant="secondary" size="sm" onClick={() => onCancel(it.id)}>
              لغو
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

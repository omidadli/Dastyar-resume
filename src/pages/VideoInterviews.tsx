import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  FileText,
  Copy,
  Link2,
  Lock,
  Mail,
  Plus,
  Search,
  Send,
  Star,
  Trash2,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Modal,
  Select,
  Skeleton,
  Stat,
  Switch,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { copyText } from '../lib/clipboard';
import { emitChange } from '../lib/events';
import { faDate, toPersianDigits } from '../lib/format';
import { useTitle } from '../lib/useTitle';
import { VIDEO_STATUS_LABEL, type VideoInvite, type VideoOverview, type VideoQuestion, type VideoSettings } from '../types/video';
import type { ResumeListItem } from '../types/screening';

const STATUS_TONE: Record<VideoInvite['status'], 'neutral' | 'brand' | 'warning' | 'outline'> = {
  invited: 'neutral',
  recording: 'warning',
  submitted: 'brand',
  reviewed: 'brand',
  cancelled: 'outline',
  expired: 'outline',
};

function takesLabel(retakes: number) {
  return retakes > 0 ? `تا ${toPersianDigits(retakes + 1)} بار ضبط` : 'یک بار ضبط';
}

/**
 * «مصاحبهٔ ویدئویی» — the HireVue-shaped feature, built for a country where the
 * hiring manager and the candidate are often in two cities.
 *
 * What it deliberately is not: an auto-grader. Nothing here scores a face, a
 * voice or an accent. HR watches, rates 1–5 and writes a line; that note is
 * what travels with the candidate. Candidates see the questions, the seconds
 * and the number of takes before they click «شروع ضبط», and every recording
 * stays private to this workspace.
 */
export default function VideoInterviews() {
  useTitle('مصاحبهٔ ویدئویی');
  const canEdit = useCan('admin');
  const [data, setData] = useState<VideoOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [jobId, setJobId] = useState<string>('');
  const [settings, setSettings] = useState<VideoSettings | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [review, setReview] = useState<VideoInvite | null>(null);
  const [removing, setRemoving] = useState<VideoInvite | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.video
      .overview()
      .then((r) => {
        setData(r);
        setError(null);
        setJobId((prev) => prev || r.jobs[0]?.id || '');
      })
      .catch((e) => setError(e?.message || 'بارگذاری ممکن نشد.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!jobId) {
      setSettings(null);
      return;
    }
    api.video
      .settings(jobId)
      .then((r) => setSettings(r.settings))
      .catch(() => setSettings(null));
  }, [jobId]);

  const invites = useMemo(() => (data?.invites || []).filter((i) => !jobId || i.jobId === jobId), [data, jobId]);
  const job = data?.jobs.find((j) => j.id === jobId) || null;

  const patchSettings = (patch: Partial<VideoSettings>) => setSettings((s) => (s ? { ...s, ...patch } : s));

  const patchQuestion = (id: string, patch: Partial<VideoQuestion>) =>
    setSettings((s) => (s ? { ...s, questions: s.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) } : s));

  const addQuestion = () =>
    setSettings((s) =>
      s
        ? {
            ...s,
            questions: [...s.questions, { id: `q${Date.now().toString(36).slice(-4)}`, text: '', seconds: 90 }],
          }
        : s
    );

  const saveSettings = async () => {
    if (!settings || !jobId) return;
    setSavingSettings(true);
    try {
      const body = {
        jobId,
        enabled: settings.enabled,
        retakes: settings.retakes,
        ttlDays: settings.ttlDays,
        intro: settings.intro,
        questions: settings.questions.filter((q) => q.text.trim()),
      };
      if (!body.questions.length) {
        toast('دست‌کم یک پرسش بنویسید.', 'error');
        return;
      }
      const r = await api.video.saveSettings(body);
      setSettings(r.settings);
      toast(settings.enabled ? 'پرسش‌ها ذخیره و روشن شد.' : 'پرسش‌ها ذخیره شد (خاموش است).', 'success');
      emitChange('jobs');
      load();
    } catch (err: any) {
      toast(err?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const sendLink = async (invite: VideoInvite) => {
    setBusyId(invite.id);
    try {
      const r = await api.video.send(invite.id);
      setData((d) => (d ? { ...d, invites: d.invites.map((i) => (i.id === invite.id ? r.invite : i)) } : d));
      toast('لینک مصاحبه از صندوق سازمان فرستاده شد.', 'success');
    } catch (err: any) {
      const msg = String(err?.message || 'ارسال ممکن نشد.');
      if (err?.code === 'EMAIL_NOT_CONFIGURED' || err?.code === 'NO_EMAIL') {
        const ok = await copyText(invite.url);
        toast(`${msg}${ok ? ' — لینک کپی شد.' : ''}`, 'error', undefined, 10_000);
      } else toast(msg, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (invite: VideoInvite) => {
    const ok = await copyText(invite.url);
    toast(ok ? 'لینک کپی شد؛ می‌توانید خودتان بفرستید.' : 'کپی ممکن نشد.', ok ? 'success' : 'error');
  };

  const cancelInvite = async (invite: VideoInvite) => {
    setBusyId(invite.id);
    try {
      const r = await api.video.cancel(invite.id);
      setData((d) => (d ? { ...d, invites: d.invites.map((i) => (i.id === invite.id ? r.invite : i)) } : d));
      toast('دعوت لغو شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'لغو ممکن نشد.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const removeInvite = async () => {
    if (!removing) return;
    try {
      await api.video.remove(removing.id);
      setData((d) => (d ? { ...d, invites: d.invites.filter((i) => i.id !== removing.id) } : d));
      toast('مصاحبه و فایل‌هایش پاک شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک‌کردن ممکن نشد.', 'error');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="مصاحبهٔ ویدئویی"
        subtitle="چند پرسش کوتاه، پاسخ ویدئویی از گوشی کارجو — بدون هماهنگی جلسه"
        actions={
          <Button icon={Plus} onClick={() => setInviteOpen(true)} disabled={!data?.jobs.length}>
            دعوت کارجوی تازه
          </Button>
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {loading && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[220px] rounded-card" />
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-5">
          <Callout tone="info" icon={VideoIcon} title="این ویدئو، ارزیابی خودکار نیست">
            هویدا چهره یا صدا را نمره نمی‌دهد. کارجو پرسش‌ها و ثانیه‌ها را از قبل می‌بیند، هر پاسخ را یک‌بار (و در صورت
            اجازه، دوباره) ضبط می‌کند و شما بعد از تماشا ۱ تا ۵ امتیاز می‌دهید. ویدئو فقط برای اعضای همین فضای کاری است.
          </Callout>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <Stat icon={Clock3} label="در انتظار پاسخ" value={toPersianDigits(data.stats.waiting)} note="دعوت فرستاده یا در حال ضبط" />
            <Stat icon={CheckCircle2} label="ارسال‌شده" value={toPersianDigits(data.stats.submitted)} note="آمادهٔ تماشا" tone="brand" />
            <Stat icon={Star} label="بررسی‌شده" value={toPersianDigits(data.stats.reviewed)} note="امتیاز و یادداشت ثبت شده" />
            <Stat
              icon={Mail}
              label="صندوق ایمیل"
              value={data.mailbox ? 'وصل است' : 'وصل نیست'}
              note={data.mailbox ? 'لینک از صندوق خودتان می‌رود' : 'لینک را کپی و دستی بفرستید'}
              tone={data.mailbox ? 'neutral' : 'review'}
            />
          </div>

          {/* ------------------------------------------------ settings ---- */}
          <Card>
            <CardHeader
              icon={VideoIcon}
              title="پرسش‌های این فرصت شغلی"
              subtitle="هر فرصت، پرسش‌های خودش را دارد؛ کارجویان دیگر آن‌ها را نمی‌بینند."
              action={
                <Select
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  options={data.jobs.map((j) => ({ value: j.id, label: j.roleTitle }))}
                  wrapperClassName="w-[280px]"
                  aria-label="فرصت شغلی"
                />
              }
            />

            {!settings && <Skeleton className="h-[120px] rounded-[12px]" />}

            {settings && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-line-2 bg-canvas px-3.5 py-3">
                  <div className="flex items-center gap-3">
                    <Switch checked={settings.enabled} onChange={(v) => patchSettings({ enabled: v })} disabled={!canEdit} />
                    <div>
                      <p className="text-[13px] font-semibold text-ink">مصاحبهٔ ویدئویی برای «{job?.roleTitle || 'این فرصت'}» روشن باشد</p>
                      <p className="text-[11.5px] text-ink-3 mt-0.5">تا خاموش است، دعوت‌نامه ساخته نمی‌شود و پرسش‌ها به کارجو نمی‌رسد.</p>
                    </div>
                  </div>
                  {!canEdit && (
                    <span className="text-[11.5px] text-ink-3 inline-flex items-center gap-1">
                      <Lock className="w-3.5 h-3.5" /> فقط مدیر می‌تواند تغییر دهد
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Select
                    label="تعداد ضبط مجاز برای هر پرسش"
                    value={String(settings.retakes)}
                    onChange={(e) => patchSettings({ retakes: Number(e.target.value) })}
                    options={[
                      { value: '0', label: 'یک بار — بدون تکرار' },
                      { value: '1', label: 'دو بار (یک تکرار)' },
                      { value: '2', label: 'سه بار (دو تکرار)' },
                    ]}
                    hint={takesLabel(settings.retakes)}
                    disabled={!canEdit}
                  />
                  <Select
                    label="مهلت پاسخ"
                    value={String(settings.ttlDays)}
                    onChange={(e) => patchSettings({ ttlDays: Number(e.target.value) })}
                    options={[
                      { value: '3', label: '۳ روز' },
                      { value: '7', label: 'یک هفته' },
                      { value: '14', label: 'دو هفته' },
                      { value: '30', label: 'یک ماه' },
                    ]}
                    disabled={!canEdit}
                  />
                </div>

                <TextArea
                  label="یک جمله برای کارجو (اختیاری)"
                  value={settings.intro}
                  onChange={(e) => patchSettings({ intro: e.target.value })}
                  rows={2}
                  placeholder="مثلاً: این چند پرسش جای تماس تلفنی اولیه است؛ خودتان باشید."
                  disabled={!canEdit}
                />

                <div className="flex flex-col gap-2">
                  {settings.questions.map((q, i) => (
                    <div key={q.id} className="rounded-[12px] border border-line-2 bg-surface p-3">
                      <div className="flex items-start gap-2">
                        <span className="mt-2.5 text-[11px] text-ink-4 w-5 shrink-0">{toPersianDigits(i + 1)}</span>
                        <TextInput
                          value={q.text}
                          onChange={(e) => patchQuestion(q.id, { text: e.target.value })}
                          placeholder="پرسش را بنویسید…"
                          wrapperClassName="flex-1"
                          disabled={!canEdit}
                        />
                        <Select
                          value={String(q.seconds)}
                          onChange={(e) => patchQuestion(q.id, { seconds: Number(e.target.value) })}
                          options={[
                            { value: '45', label: '۴۵ ثانیه' },
                            { value: '60', label: '۱ دقیقه' },
                            { value: '90', label: '۹۰ ثانیه' },
                            { value: '120', label: '۲ دقیقه' },
                            { value: '180', label: '۳ دقیقه' },
                          ]}
                          wrapperClassName="w-[130px]"
                          disabled={!canEdit}
                        />
                        {canEdit && settings.questions.length > 1 && (
                          <IconButton
                            icon={Trash2}
                            label="حذف پرسش"
                            onClick={() => patchSettings({ questions: settings.questions.filter((x) => x.id !== q.id) })}
                          />
                        )}
                      </div>
                    </div>
                  ))}
                  {canEdit && settings.questions.length < 5 && (
                    <Button size="sm" variant="ghost" icon={Plus} onClick={addQuestion} className="self-start">
                      افزودن پرسش
                    </Button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 border-t border-line-2 pt-3">
                  <p className="text-[11.5px] text-ink-3">
                    مجموع زمان: {toPersianDigits(Math.round(settings.questions.reduce((s, q) => s + q.seconds, 0) / 60))} دقیقه — بیشتر از
                    پنج پرسش نه، کارجو خسته می‌شود.
                  </p>
                  <Button onClick={saveSettings} loading={savingSettings} disabled={!canEdit} icon={CheckCircle2}>
                    ذخیره
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* ------------------------------------------------ invites ---- */}
          <Card>
            <CardHeader
              icon={VideoIcon}
              title="دعوت‌ها"
              subtitle={jobId ? `فقط «${job?.roleTitle || ''}»` : 'همهٔ فرصت‌ها'}
              action={
                <span className="text-[12px] text-ink-3">
                  {toPersianDigits(invites.length)} دعوت
                </span>
              }
            />

            {!invites.length ? (
              <EmptyState
                icon={VideoIcon}
                title="هنوز کسی دعوت نشده"
                description="پرسش‌ها را برای یک فرصت شغلی روشن کنید، بعد از پروفایل کارجو یا دکمهٔ بالا لینک مصاحبه بسازید."
              />
            ) : (
              <div className="flex flex-col divide-y divide-line-2">
                {invites.map((invite) => {
                  const rec = invite.answers.length;
                  return (
                    <div key={invite.id} className="py-3 flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[13.5px] font-semibold text-ink truncate">{invite.candidateName || 'کارجو'}</p>
                          <Chip tone={STATUS_TONE[invite.status]}>{VIDEO_STATUS_LABEL[invite.status]}</Chip>
                          {invite.rating && (
                            <span className="text-[11.5px] text-ink-3 inline-flex items-center gap-1">
                              <Star className="w-3.5 h-3.5 text-review-ink fill-current" /> {toPersianDigits(invite.rating)} از ۵
                            </span>
                          )}
                        </div>
                        <p className="text-[11.5px] text-ink-3 mt-0.5">
                          {invite.jobTitle || 'بدون فرصت'} · {toPersianDigits(rec)} از {toPersianDigits(invite.questions.length)} پاسخ ·{' '}
                          {faDate(invite.createdAtISO)}
                          {invite.views > 0 ? ` · ${toPersianDigits(invite.views)} بار تماشا` : ''}
                          {invite.sentAtISO ? ' · ایمیل فرستاده شد' : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => setReview(invite)} disabled={!rec}>
                          {invite.status === 'reviewed' ? 'بازبینی' : 'تماشا و امتیاز'}
                        </Button>
                        <IconButton icon={Send} label="ارسال با ایمیل سازمان" onClick={() => void sendLink(invite)} disabled={busyId === invite.id || invite.status === 'cancelled'} />
                        <IconButton icon={Copy} label="کپی لینک" onClick={() => void copyLink(invite)} />
                        {invite.status !== 'submitted' && invite.status !== 'reviewed' && (
                          <IconButton icon={X} label="لغو دعوت" onClick={() => void cancelInvite(invite)} disabled={busyId === invite.id} />
                        )}
                        {canEdit && <IconButton icon={Trash2} label="پاک‌کردن" onClick={() => setRemoving(invite)} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      <InviteModal
        open={inviteOpen}
        jobs={data?.jobs || []}
        defaultJobId={jobId}
        onClose={() => setInviteOpen(false)}
        onCreated={(invite) => {
          setData((d) => (d ? { ...d, invites: [invite, ...d.invites] } : d));
          setInviteOpen(false);
          void copyLink(invite);
        }}
      />

      <ReviewModal
        invite={review}
        onClose={() => setReview(null)}
        onSaved={(next) => {
          setData((d) => (d ? { ...d, invites: d.invites.map((i) => (i.id === next.id ? next : i)) } : d));
          setReview(next);
        }}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={removeInvite}
        title="این مصاحبه پاک شود؟"
        description="ویدئوها و یادداشت‌های این دعوت برای همیشه حذف می‌شوند. اگر فقط می‌خواهید لینک بسته شود، «لغو دعوت» کافی است."
        confirmLabel="پاک‌کردن"
        tone="danger"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ invite -- */

function InviteModal({
  open,
  jobs,
  defaultJobId,
  onClose,
  onCreated,
}: {
  open: boolean;
  jobs: VideoOverview['jobs'];
  defaultJobId: string;
  onClose: () => void;
  onCreated: (invite: VideoInvite) => void;
}) {
  const [jobId, setJobId] = useState(defaultJobId);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ResumeListItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (open) setJobId(defaultJobId);
  }, [open, defaultJobId]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setSearching(true);
    const t = window.setTimeout(() => {
      api.resumes
        .list({ q: q.trim() || undefined, jobId: jobId || undefined, pageSize: 12 })
        .then((r) => !cancelled && setItems(r.items))
        .catch(() => !cancelled && setItems([]))
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [open, q, jobId]);

  const invite = async (rec: ResumeListItem) => {
    setBusyId(rec.id);
    try {
      const r = await api.video.create({ resumeId: rec.id, jobId: jobId || rec.jobId });
      toast('لینک مصاحبه ساخته شد؛ هنوز چیزی فرستاده نشده است.', 'success');
      onCreated(r.invite);
    } catch (err: any) {
      toast(err?.message || 'ساخت دعوت ممکن نشد.', 'error', undefined, 8000);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={<VideoIcon className="w-5 h-5 text-brand-strong" />}
      title="دعوت به مصاحبهٔ ویدئویی"
      description="یک کارجو را انتخاب کنید؛ لینک ساخته می‌شود، ولی تا «ارسال» را نزنید چیزی به کارجو نمی‌رسد."
      size="lg"
    >
      <div className="flex flex-col gap-3">
        <Select
          label="فرصت شغلی"
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          options={jobs.map((j) => ({ value: j.id, label: `${j.roleTitle}${j.enabled ? '' : ' — پرسش‌ها خاموش'}` }))}
          hint={jobs.find((j) => j.id === jobId)?.enabled ? undefined : 'برای این فرصت، پرسش‌ها روشن نیست؛ اول در کارت بالا روشن و ذخیره کنید.'}
        />
        <TextInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="جست‌وجوی نام یا ایمیل کارجو…"
          icon={Search}
        />
        <div className="max-h-[300px] overflow-y-auto rounded-[12px] border border-line-2 divide-y divide-line-2">
          {searching && !items && (
            <div className="p-4">
              <Skeleton className="h-[52px] rounded-[10px]" />
            </div>
          )}
          {items && !items.length && (
            <p className="p-4 text-[12.5px] text-ink-3">کارجویی پیدا نشد. جست‌وجو را ساده‌تر کنید یا کارجو را از پروفایلش دعوت کنید.</p>
          )}
          {items?.map((rec) => (
            <div key={rec.id} className="flex items-center gap-3 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-ink truncate">{rec.candidateName || 'بدون نام'}</p>
                <p className="text-[11.5px] text-ink-3 truncate">
                  {rec.roleTitle || 'بدون فرصت'}
                  {rec.contact?.email ? ` · ${rec.contact.email}` : ''}
                </p>
              </div>
              <Button size="sm" variant="secondary" loading={busyId === rec.id} onClick={() => void invite(rec)}>
                ساخت لینک
              </Button>
            </div>
          ))}
        </div>
        <p className="text-[11.5px] text-ink-4 flex items-center gap-1.5">
          <Link2 className="w-3.5 h-3.5" /> پرسش‌ها از همان فرصت شغلی خوانده می‌شوند؛ بعد از ساخت لینک، تغییر پرسش‌ها روی دعوت‌های قبلی اثر ندارد.
        </p>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ review -- */

function ReviewModal({
  invite,
  onClose,
  onSaved,
}: {
  invite: VideoInvite | null;
  onClose: () => void;
  onSaved: (invite: VideoInvite) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [transcripts, setTranscripts] = useState<Record<string, { text: string; note: string | null }>>({});
  const [trBusy, setTrBusy] = useState<string | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setUrls({});
    setTranscripts({});
    setRating(invite?.rating ?? null);
    setNote(invite?.note || '');
    if (!invite) return;
    let cancelled = false;
    invite.answers.forEach((a) => {
      api.video
        .answerUrl(invite.id, a.questionId)
        .then((r) => !cancelled && setUrls((u) => ({ ...u, [a.questionId]: r.url })))
        .catch(() => undefined);
    });
    if (invite.status === 'submitted') api.video.viewed(invite.id).then((r) => onSaved(r.invite)).catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invite?.id]);

  const transcribe = async (questionId: string) => {
    if (!invite) return;
    setTrBusy(questionId);
    try {
      const r = await api.transcripts.video(invite.id, questionId);
      setTranscripts((t) => ({
        ...t,
        [questionId]: {
          text: r.transcript.status === 'ready' ? r.transcript.text : '',
          note: r.note || (r.transcript.status === 'ready' ? null : 'متن این پاسخ ثبت نشده است.'),
        },
      }));
    } catch (err: any) {
      toast(err?.message || 'رونویسی ممکن نشد.', 'error', undefined, 8000);
    } finally {
      setTrBusy(null);
    }
  };

  const save = async () => {
    if (!invite) return;
    setSaving(true);
    try {
      const r = await api.video.review(invite.id, { rating, note });
      toast('امتیاز و یادداشت ذخیره شد.', 'success');
      onSaved(r.invite);
    } catch (err: any) {
      toast(err?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(invite)}
      onClose={onClose}
      icon={<VideoIcon className="w-5 h-5 text-brand-strong" />}
      title={invite ? `مصاحبهٔ ${invite.candidateName || 'کارجو'}` : ''}
      description={invite?.jobTitle ? `نقش «${invite.jobTitle}»` : undefined}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            بستن
          </Button>
          <Button onClick={save} loading={saving} icon={CheckCircle2} disabled={!invite || !invite.answers.length}>
            ذخیرهٔ بررسی
          </Button>
        </>
      }
    >
      {invite && (
        <div className="flex flex-col gap-4">
          {invite.answers.map((a, i) => (
            <div key={a.questionId}>
              <p className="text-[12.5px] font-semibold text-ink mb-1.5">
                {toPersianDigits(i + 1)}. {a.questionText}
              </p>
              <div className="rounded-[12px] overflow-hidden bg-black aspect-video">
                {urls[a.questionId] ? (
                  <video key={urls[a.questionId]} src={urls[a.questionId]} controls playsInline className="w-full h-full" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white/60 text-[12.5px]">در حال آماده‌سازی ویدئو…</div>
                )}
              </div>
              <div className="mt-2">
                {transcripts[a.questionId] ? (
                  <div className="rounded-[10px] border border-line-2 bg-canvas px-3 py-2.5">
                    {transcripts[a.questionId].text ? (
                      <p className="text-[12.5px] text-ink-2 leading-relaxed whitespace-pre-wrap max-h-[160px] overflow-y-auto">{transcripts[a.questionId].text}</p>
                    ) : (
                      <p className="text-[12px] text-ink-3 leading-relaxed">{transcripts[a.questionId].note}</p>
                    )}
                  </div>
                ) : (
                  <Button size="sm" variant="ghost" icon={FileText} loading={trBusy === a.questionId} onClick={() => void transcribe(a.questionId)}>
                    رونویسی این پاسخ
                  </Button>
                )}
              </div>
            </div>
          ))}

          <div className="rounded-[12px] border border-line-2 bg-canvas p-3.5">
            <p className="text-[12.5px] font-semibold text-ink mb-2">ارزیابی شما (۱ تا ۵)</p>
            <div className="flex items-center gap-1.5 mb-3">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRating(n)}
                  aria-label={`${n} از ۵`}
                  className={`w-9 h-9 rounded-[10px] border flex items-center justify-center transition-colors ${
                    (rating || 0) >= n ? 'border-review/40 bg-review-soft text-review-ink' : 'border-line-2 bg-surface text-ink-4 hover:bg-canvas'
                  }`}
                >
                  <Star className={`w-4 h-4 ${(rating || 0) >= n ? 'fill-current' : ''}`} />
                </button>
              ))}
              {rating && (
                <button type="button" className="text-[11.5px] text-ink-3 underline mr-2" onClick={() => setRating(null)}>
                  پاک‌کردن
                </button>
              )}
            </div>
            <TextArea
              label="یادداشت برای پرونده"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              placeholder="مثلاً: پاسخ دوم روشن و با مثال بود؛ برای مرحلهٔ بعد مناسب است."
            />
            <p className="text-[11.5px] text-ink-3 mt-2">
              این یادداشت در فعالیت‌های تیم و پروندهٔ کارجو دیده می‌شود. هیچ امتیازی خودکار رد یا قبول نمی‌شود.
            </p>
          </div>
        </div>
      )}
    </Modal>
  );
}

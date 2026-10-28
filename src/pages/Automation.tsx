import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Info,
  ListChecks,
  Loader2,
  Mail,
  MailWarning,
  MessageSquare,
  Play,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  ErrorState,
  Field,
  Select,
  Skeleton,
  Switch,
  Tabs,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { emitChange } from '../lib/events';
import { faDate, faRelative, toPersianDigits } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import { TEMPLATE_VARS } from '../types/automation';
import type {
  AutomationActionKind,
  AutomationOverview,
  AutomationPreviewItem,
  AutomationProposal,
  AutomationSettings,
} from '../types/automation';

const KIND_LABEL: Record<AutomationActionKind, string> = {
  invite: 'دعوت به مصاحبه',
  reject: 'نامهٔ نتیجه',
  request_info: 'درخواست اطلاعات',
  schedule: 'ثبت جلسهٔ مصاحبه',
};

const KIND_ICON = {
  invite: Send,
  reject: MailWarning,
  request_info: MessageSquare,
  schedule: CalendarClock,
} as const;

const STATUS_LABEL: Record<AutomationProposal['status'], string> = {
  pending: 'در انتظار تأیید',
  sent: 'انجام شد',
  skipped: 'کنار گذاشته شد',
  failed: 'ناموفق',
};

type TabId = 'queue' | 'history' | 'settings';

/**
 * «اتوماسیون جذب» — the funnel works the queue, the recruiter approves.
 *
 * The page is built around the one promise the product must keep: nothing is
 * sent to a candidate until a person looks at it (unless the admin explicitly
 * turned on a rule, and then the row says «ارسال خودکار»). Every row therefore
 * shows why it exists, the exact text that will be sent, and where it will go.
 */
export default function Automation() {
  useTitle('اتوماسیون جذب');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'owner';

  const [jobId, setJobId] = useState('');
  const [tab, setTab] = useState<TabId>('queue');
  const jobsQ = useAsync(() => api.jobs.list(), []);
  const overviewQ = useAsync(() => api.automation.overview(jobId || undefined), [jobId]);
  const data = overviewQ.data;

  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState<AutomationPreviewItem[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const counts = data?.counts;

  async function run(create: boolean) {
    if (create) setRunning(true);
    else setPreviewing(true);
    try {
      if (create) {
        const res = await api.automation.run({ jobId: jobId || undefined });
        overviewQ.setData(res);
        emitChange('automation');
        const { created, autoSent, examined } = res.result;
        toast(
          created
            ? `${toPersianDigits(created)} پیشنهاد آمادهٔ تأیید ساخته شد (${toPersianDigits(examined)} کارجو بررسی شد)${
                autoSent ? `؛ ${toPersianDigits(autoSent)} مورد طبق قاعدهٔ شما خودکار فرستاده شد` : ''
              }.`
            : `پیشنهاد تازه‌ای لازم نبود؛ ${toPersianDigits(examined)} کارجو بررسی شد.`,
          created ? 'success' : 'info'
        );
        setPreview(null);
      } else {
        const res = await api.automation.preview({ jobId: jobId || undefined });
        setPreview(res.items);
        toast(
          res.items.length ? `${toPersianDigits(res.items.length)} اقدام پیشنهادی آماده می‌شود.` : 'برای این انتخاب، اقدام تازه‌ای پیشنهاد نمی‌شود.',
          'info'
        );
      }
    } catch (err: any) {
      toast(err?.message || 'اجرای اتوماسیون ممکن نشد.', 'error');
    } finally {
      setRunning(false);
      setPreviewing(false);
    }
  }

  async function approve(item: AutomationProposal, edits: { subject?: string; body?: string; date?: string; time?: string }) {
    setBusy(item.id);
    try {
      const res = await api.automation.approve(item.id, edits);
      overviewQ.setData(res);
      emitChange('automation');
      emitChange('resumes');
      toast(item.kind === 'schedule' ? `جلسه با «${item.candidateName}» ثبت شد.` : `پیام برای «${item.candidateName}» فرستاده شد.`, 'success');
    } catch (err: any) {
      toast(err?.message || 'انجام این اقدام ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  }

  async function skip(item: AutomationProposal) {
    setBusy(item.id);
    try {
      const res = await api.automation.skip(item.id, 'توسط منابع انسانی کنار گذاشته شد');
      overviewQ.setData(res);
      toast('این مورد کنار گذاشته شد؛ چیزی برای کارجو فرستاده نشد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'این مورد کنار گذاشته نشد.', 'error');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageHeader
        title="اتوماسیون جذب"
        subtitle="غربالگری را به کارهای تکراری تبدیل می‌کند: پیشنهاد دعوت، نامهٔ نتیجه یا ثبت جلسه — با متن آماده و دلیل هر تصمیم. تا شما تأیید نکنید، چیزی برای کارجو فرستاده نمی‌شود."
        actions={
          <div className="flex items-center gap-2">
            <Select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              aria-label="فرصت شغلی"
              className="min-w-[180px]"
              options={[
                { value: '', label: 'همهٔ فرصت‌ها' },
                ...(jobsQ.data?.items || []).map((j) => ({ value: j.id, label: j.roleTitle })),
              ]}
            />
            <Button onClick={() => run(false)} loading={previewing} variant="secondary">
              <ClipboardCheck className="w-4 h-4" /> پیش‌نمایش
            </Button>
            <Button onClick={() => run(true)} loading={running}>
              <Play className="w-4 h-4" /> اجرای اتوماسیون
            </Button>
          </div>
        }
      />

      {overviewQ.error ? (
        <ErrorState message={overviewQ.error} onRetry={overviewQ.reload} />
      ) : !data ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      ) : (
        <div className="space-y-4">
          <Readiness data={data} />

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MiniStat label="در انتظار تأیید" value={data.counts.pending} tone="brand" icon={ListChecks} />
            <MiniStat label="انجام‌شده" value={data.counts.sent} tone="high" icon={CheckCircle2} />
            <MiniStat label="کنار گذاشته‌شده" value={data.counts.skipped} icon={XCircle} />
            <MiniStat label="ناموفق" value={data.counts.failed} tone={data.counts.failed ? 'review' : undefined} icon={AlertTriangle} />
          </div>

          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            items={[
              { id: 'queue', label: 'صف تأیید', count: data.counts.pending, icon: ListChecks },
              { id: 'history', label: 'تاریخچه', count: data.counts.sent + data.counts.skipped + data.counts.failed, icon: BadgeCheck },
              { id: 'settings', label: 'قواعد و متن‌ها', icon: Settings2 },
            ]}
          />

          {tab === 'queue' && (
            <QueueTab
              data={data}
              preview={preview}
              busy={busy}
              onApprove={approve}
              onSkip={skip}
              onClearPreview={() => setPreview(null)}
            />
          )}
          {tab === 'history' && <HistoryTab data={data} />}
          {tab === 'settings' && (
            <SettingsTab
              settings={data.settings}
              isAdmin={isAdmin}
              onSaved={(next) => overviewQ.setData({ ...data, settings: next })}
            />
          )}
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ header ----

function Readiness({ data }: { data: AutomationOverview }) {
  const problems = [];
  if (!data.readiness.emailConfigured) {
    problems.push(
      <Callout
        key="mail"
        tone="warning"
        title="صندوق ایمیل سازمان وصل نیست"
        action={<ButtonLink to="/app/settings/integrations" size="sm" variant="secondary">اتصال ایمیل</ButtonLink>}
      >
        پیام برای کارجوها فقط با ایمیل سازمان خودتان فرستاده می‌شود. تا اتصال برقرار نشود، پیشنهادها ساخته می‌شوند اما ارسال ممکن نیست.
      </Callout>
    );
  }
  if (!data.readiness.calendarConnected) {
    problems.push(
      <Callout
        key="cal"
        tone="info"
        title="تقویم گوگل وصل نیست"
        action={<ButtonLink to="/app/settings/integrations" size="sm" variant="secondary">اتصال تقویم</ButtonLink>}
      >
        ثبت جلسه بدون تقویم هم انجام می‌شود و دعوت‌نامه با فایل تقویم (.ics) فرستاده می‌شود؛ برای هم‌زمانی با تقویم گوگل، اتصال را کامل کنید.
      </Callout>
    );
  }
  if (data.readiness.withoutEmail > 0) {
    problems.push(
      <Callout key="noemail" tone="warning" title={`${toPersianDigits(data.readiness.withoutEmail)} کارجو بدون ایمیل`}>
        برای این کارجوها راهی برای تماس در سامانه ثبت نشده است؛ با افزودن ایمیل در صفحهٔ رزومه، وارد چرخهٔ اتوماسیون می‌شوند.
      </Callout>
    );
  }
  if (!data.settings.enabled) {
    problems.push(
      <Callout key="off" tone="info" title="اتوماسیون خاموش است">
        در «قواعد و متن‌ها» می‌توانید آن را روشن کنید. تا آن موقع هیچ پیشنهادی ساخته نمی‌شود.
      </Callout>
    );
  }
  if (data.settings.autoInvite || data.settings.autoReject) {
    const what = [data.settings.autoInvite ? 'دعوت' : null, data.settings.autoReject ? 'نامهٔ نتیجه' : null].filter(Boolean).join(' و ');
    problems.push(
      <Callout key="auto" tone="danger" title="ارسال خودکار روشن است">
        پیام «{what}» بدون تأیید شما برای کارجوها فرستاده می‌شود. اگر می‌خواهید هر مورد را خودتان ببینید، این قاعده را خاموش کنید.
      </Callout>
    );
  }
  if (!problems.length) {
    return (
      <Callout tone="brand" title="همه‌چیز آماده است" icon={ShieldCheck}>
        ایمیل سازمان و تقویم وصل‌اند و هیچ قاعدهٔ ارسال خودکاری روشن نیست: هر پیشنهاد پس از تأیید شما اجرا می‌شود.
      </Callout>
    );
  }
  return <div className="space-y-2">{problems}</div>;
}

function MiniStat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  tone?: 'brand' | 'high' | 'review';
}) {
  const chip =
    tone === 'brand' ? 'bg-brand-soft text-brand-strong' : tone === 'high' ? 'bg-high-soft text-high-ink' : tone === 'review' ? 'bg-review-soft text-review-ink' : 'bg-line-2 text-ink-2';
  return (
    <Card className="flex items-center gap-3">
      <span className={`w-9 h-9 rounded-[10px] flex items-center justify-center ${chip}`}>
        <Icon className="w-[18px] h-[18px]" strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-bold text-ink leading-none hv-latin">{toPersianDigits(value)}</p>
        <p className="text-[12px] text-ink-3 mt-1 truncate">{label}</p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------- queue ----

function QueueTab({
  data,
  preview,
  busy,
  onApprove,
  onSkip,
  onClearPreview,
}: {
  data: AutomationOverview;
  preview: AutomationPreviewItem[] | null;
  busy: string | null;
  onApprove: (item: AutomationProposal, edits: { subject?: string; body?: string; date?: string; time?: string }) => void;
  onSkip: (item: AutomationProposal) => void;
  onClearPreview: () => void;
}) {
  return (
    <div className="space-y-4">
      {preview && (
        <Card>
          <CardHeader
            title="پیش‌نمایش بدون ثبت"
            subtitle="این‌ها پیشنهادهایی است که «اجرای اتوماسیون» می‌سازد؛ هنوز هیچ‌چیز ثبت یا فرستاده نشده است."
            icon={Info}
            action={
              <Button variant="ghost" size="sm" onClick={onClearPreview}>
                بستن
              </Button>
            }
          />
          {preview.length ? (
            <ul className="space-y-2">
              {preview.map((p) => (
                <li key={`${p.resumeId}-${p.kind}`} className="flex items-start gap-2 text-[13px] text-ink-2 border border-line rounded-[10px] px-3 py-2">
                  <Chip tone="outline">{KIND_LABEL[p.kind]}</Chip>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">
                      {p.candidateName} <span className="text-ink-3 font-normal">— {p.jobTitle}</span>
                    </p>
                    <p className="text-xs text-ink-3 mt-0.5">{p.reason}</p>
                  </div>
                  {p.alreadyQueued && <Chip tone="neutral">قبلاً ساخته شده</Chip>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-3">اقدام تازه‌ای پیشنهاد نمی‌شود.</p>
          )}
        </Card>
      )}

      {data.queue.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="صف تأیید خالی است"
          description="با «اجرای اتوماسیون»، رزومه‌هایی که بین آستانه‌ها نیستند بررسی و پیشنهاد مناسبشان ساخته می‌شود. کارجوهایی که امتیازشان بین دو آستانه است، عمداً پیشنهادی نمی‌گیرند."
        />
      ) : (
        <div className="space-y-3">
          {data.queue.map((item) => (
            <ProposalCard key={item.id} item={item} busy={busy === item.id} onApprove={onApprove} onSkip={onSkip} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({
  item,
  busy,
  onApprove,
  onSkip,
}: {
  item: AutomationProposal;
  busy: boolean;
  onApprove: (item: AutomationProposal, edits: { subject?: string; body?: string; date?: string; time?: string }) => void;
  onSkip: (item: AutomationProposal) => void;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');

  // Re-sync when the row is refreshed from the server.
  useEffect(() => {
    setSubject(item.subject);
    setBody(item.body);
  }, [item.subject, item.body]);

  const suggested = useMemo(() => {
    if (!item.suggestedAtISO) return null;
    const d = new Date(item.suggestedAtISO);
    if (isNaN(d.getTime())) return null;
    return { label: `${faDate(item.suggestedAtISO)} — ساعت ${new Date(item.suggestedAtISO).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit' })}` };
  }, [item.suggestedAtISO]);

  const Icon = KIND_ICON[item.kind];
  const edited = subject !== item.subject || body !== item.body || Boolean(date || time);

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <span className="w-10 h-10 rounded-[12px] bg-brand-tint text-brand-strong flex items-center justify-center shrink-0">
          <Icon className="w-[18px] h-[18px]" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-bold text-ink truncate">{item.candidateName}</p>
            <Chip tone="brand">{KIND_LABEL[item.kind]}</Chip>
            <Chip tone="outline">{toPersianDigits(Math.round(item.score))} از ۱۰۰</Chip>
            <span className="text-xs text-ink-4">{faRelative(item.createdAtISO)}</span>
          </div>
          <p className="text-[12.5px] text-ink-3 mt-1">
            {item.jobTitle} · {item.departmentName}
            {item.candidateEmail ? ` · ${item.candidateEmail}` : ' · بدون ایمیل'}
          </p>
          <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">{item.reason}</p>

          {item.kind === 'schedule' && suggested && (
            <p className="text-[13px] text-brand-strong mt-2 flex items-center gap-1.5">
              <CalendarClock className="w-4 h-4" strokeWidth={1.9} />
              زمان پیشنهادی: <span className="hv-latin">{suggested.label}</span>
            </p>
          )}

          <div className="mt-3">
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? 'بستن متن' : 'دیدن و ویرایش متن'}
            </Button>
          </div>

          {open && (
            <div className="mt-3 space-y-3 border-t border-line pt-3">
              {item.kind === 'schedule' ? (
                <div className="grid sm:grid-cols-2 gap-3">
                  <TextInput
                    label="تاریخ جلسه (شمسی)"
                    placeholder="۱۴۰۵/۰۸/۱۲"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    hint="خالی بگذارید تا زمان پیشنهادی ثبت شود."
                    latin
                  />
                  <TextInput
                    label="ساعت (به وقت تهران)"
                    placeholder="۱۰:۳۰"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    latin
                  />
                </div>
              ) : (
                <>
                  <Field label="موضوع ایمیل" htmlFor={`sub-${item.id}`}>
                    <TextInput id={`sub-${item.id}`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} />
                  </Field>
                  <Field
                    label="متن ایمیل"
                    htmlFor={`body-${item.id}`}
                    hint="هر تغییری بدهید، همان متن فرستاده می‌شود. متغیرها هنگام ساخت پیشنهاد جای‌گذاری شده‌اند."
                  >
                    <TextArea id={`body-${item.id}`} value={body} onChange={(e) => setBody(e.target.value)} rows={9} />
                  </Field>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex sm:flex-col items-center gap-2 shrink-0">
          <Button
            onClick={() => onApprove(item, { ...(open ? { subject, body } : {}), ...(date ? { date } : {}), ...(time ? { time } : {}) })}
            loading={busy}
            size="sm"
          >
            {item.kind === 'schedule' ? 'ثبت جلسه' : 'تأیید و ارسال'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onSkip(item)} disabled={busy}>
            کنار گذاشتن
          </Button>
          {edited && <span className="text-[11px] text-review-ink">متن ویرایش‌شده</span>}
        </div>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- history ----

function HistoryTab({ data }: { data: AutomationOverview }) {
  if (!data.history.length) {
    return <EmptyState icon={BadgeCheck} title="تاریخچه خالی است" description="هر اقدامی که تأیید، ارسال یا کنار گذاشته شود این‌جا با نام تصمیم‌گیرنده ثبت می‌شود." />;
  }
  return (
    <Card padded={false}>
      <ul className="divide-y divide-line">
        {data.history.map((item) => {
          const Icon = KIND_ICON[item.kind];
          return (
            <li key={item.id} className="flex items-start gap-3 p-3.5">
              <span className="w-8 h-8 rounded-[10px] bg-line-2 text-ink-2 flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="w-4 h-4" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[13.5px] font-semibold text-ink truncate">{item.candidateName}</p>
                  <Chip tone="outline">{KIND_LABEL[item.kind]}</Chip>
                  <Chip tone={item.status === 'sent' ? 'brand' : item.status === 'failed' ? 'danger' : 'neutral'}>
                    {STATUS_LABEL[item.status]}
                  </Chip>
                  {item.auto && <Chip tone="warning">ارسال خودکار</Chip>}
                </div>
                <p className="text-xs text-ink-3 mt-1 truncate">
                  {item.jobTitle}، {item.departmentName}
                  {item.decidedByName ? `، ${item.decidedByName}` : ''}
                  {item.decidedAtISO ? `، ${faDate(item.decidedAtISO)}` : ''}
                </p>
                {item.error && <p className="text-xs text-low-ink mt-1 leading-relaxed">{item.error}</p>}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- settings ----

function SettingsTab({
  settings,
  isAdmin,
  onSaved,
}: {
  settings: AutomationSettings;
  isAdmin: boolean;
  onSaved: (next: AutomationSettings) => void;
}) {
  const [draft, setDraft] = useState<AutomationSettings>(settings);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(settings), [settings]);

  const set = <K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const setTpl = (which: keyof AutomationSettings['templates'], field: 'subject' | 'body', value: string) =>
    setDraft((d) => ({ ...d, templates: { ...d.templates, [which]: { ...d.templates[which], [field]: value } } }));

  async function save() {
    setSaving(true);
    try {
      const res = await api.automation.saveSettings(draft);
      onSaved(res.settings);
      toast(res.warning || 'قواعد و متن‌ها ذخیره شد.', res.warning ? 'error' : 'success', undefined, res.warning ? 8000 : undefined);
    } catch (err: any) {
      toast(err?.message || 'ذخیرهٔ تنظیمات ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!isAdmin) {
    return (
      <Callout tone="info" title="فقط مدیر فضای کاری" icon={Loader2}>
        تغییر آستانه‌ها و متن پیام‌ها کار مدیر فضای کاری است. می‌توانید صف تأیید و تاریخچه را ببینید و هر پیشنهاد را تأیید یا کنار بگذارید.
      </Callout>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="قواعد تصمیم"
          subtitle="امتیاز هر کارجو با این دو خط سنجیده می‌شود. بین دو خط، هیچ پیشنهادی ساخته نمی‌شود و تصمیم با شماست."
          icon={ListChecks}
        />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <TextInput
            label="آستانهٔ دعوت (امتیاز و بالاتر)"
            type="number"
            min={0}
            max={100}
            value={String(draft.inviteThreshold)}
            onChange={(e) => set('inviteThreshold', Number(e.target.value))}
            latin
          />
          <TextInput
            label="آستانهٔ رد (کمتر از)"
            type="number"
            min={0}
            max={100}
            value={String(draft.rejectThreshold)}
            onChange={(e) => set('rejectThreshold', Number(e.target.value))}
            latin
          />
          <TextInput
            label="سقف ارسال پیام در ساعت"
            type="number"
            min={1}
            max={120}
            value={String(draft.hourlyLimit)}
            onChange={(e) => set('hourlyLimit', Number(e.target.value))}
            hint="محافظ در برابر حلقهٔ تکراری؛ سقف سراسری هم ۱۲۰ پیام در ساعت است."
            latin
          />
          <TextInput
            label="فاصلهٔ پیشنهادی جلسه (روز بعد)"
            type="number"
            min={0}
            max={30}
            value={String(draft.scheduleDaysAhead)}
            onChange={(e) => set('scheduleDaysAhead', Number(e.target.value))}
            latin
          />
          <TextInput
            label="ساعت پیشنهادی جلسه (تهران)"
            value={draft.scheduleHour}
            onChange={(e) => set('scheduleHour', e.target.value)}
            placeholder="۱۰:۳۰"
            latin
          />
          <TextInput
            label="مدت جلسه (دقیقه)"
            type="number"
            min={15}
            max={240}
            value={String(draft.scheduleDurationMin)}
            onChange={(e) => set('scheduleDurationMin', Number(e.target.value))}
            latin
          />
        </div>
        <p className="text-xs text-ink-3 mt-3">
          {draft.inviteThreshold <= draft.rejectThreshold
            ? 'آستانهٔ دعوت باید از آستانهٔ رد بزرگ‌تر باشد؛ هنگام ذخیره اصلاح می‌شود.'
            : `کارجوی با امتیاز ${toPersianDigits(draft.inviteThreshold)} و بالاتر دعوت، کمتر از ${toPersianDigits(
                draft.rejectThreshold
              )} نامهٔ نتیجه، و بین این دو «تصمیم با شما» می‌گیرد.`}
        </p>
      </Card>

      <Card>
        <CardHeader title="اجرا و مجوز ارسال" subtitle="هستهٔ اعتماد: تا این کلیدها روشن نشوند، هر پیام منتظر تأیید یک انسان می‌ماند." icon={ShieldCheck} />
        <div className="space-y-4">
          <Switch checked={draft.enabled} onChange={(v) => set('enabled', v)} label="اتوماسیون جذب روشن باشد" description="با خاموش کردن آن، هیچ پیشنهاد تازه‌ای ساخته نمی‌شود." />
          <Switch
            checked={draft.autoScheduleOnInvite}
            onChange={(v) => set('autoScheduleOnInvite', v)}
            label="به‌جای دعوت‌نامه، زمان جلسه پیشنهاد شود"
            description="برای کارجوهای تأییدشده و بالای آستانه، یک جلسه با زمان پیشنهادی آماده می‌شود (تأیید شما هنوز لازم است)."
          />
          <Switch
            checked={draft.autoInvite}
            onChange={(v) => set('autoInvite', v)}
            label="ارسال خودکار دعوت‌نامه"
            description="بدون تأیید شما فرستاده می‌شود و در تاریخچه با برچسب «ارسال خودکار» ثبت می‌گردد."
          />
          <Switch
            checked={draft.autoReject}
            onChange={(v) => set('autoReject', v)}
            label="ارسال خودکار نامهٔ نتیجه"
            description="برای کارجوهای پایین‌تر از آستانهٔ رد، بدون تأیید شما فرستاده می‌شود. پیشنهاد می‌کنیم خاموش بماند."
          />
          <Switch checked={draft.useSignature} onChange={(v) => set('useSignature', v)} label="امضای سازمان به پیام‌ها اضافه شود" description="امضا از «تنظیمات ← سازمان» خوانده می‌شود." />
          {(draft.autoInvite || draft.autoReject) && (
            <Callout tone="danger" title="با روشن بودن این گزینه‌ها، پیام بدون بازبینی شما می‌رود" icon={AlertTriangle}>
              فقط وقتی این را روشن کنید که متن‌ها و آستانه‌ها را چند بار آزموده‌اید. هر ارسال در تاریخچه ثبت می‌شود.
            </Callout>
          )}
        </div>
      </Card>

      {(
        [
          ['invite', 'دعوت به مصاحبه', 'برای کارجوی مناسب و تأییدشده'],
          ['reject', 'نامهٔ نتیجه', 'برای کارجوی پایین‌تر از آستانهٔ رد'],
          ['requestInfo', 'درخواست اطلاعات تکمیلی', 'وقتی یک نکته مانده (مثلاً بازهٔ حقوقی)'],
        ] as Array<[keyof AutomationSettings['templates'], string, string]>
      ).map(([key, title, subtitle]) => (
        <Card key={key}>
          <CardHeader title={title} subtitle={subtitle} icon={Mail} />
          <div className="space-y-3">
            <Field label="موضوع" htmlFor={`tpl-sub-${key}`}>
              <TextInput id={`tpl-sub-${key}`} value={draft.templates[key].subject} onChange={(e) => setTpl(key, 'subject', e.target.value)} maxLength={200} />
            </Field>
            <Field label="متن" htmlFor={`tpl-body-${key}`} hint="می‌توانید از متغیرها استفاده کنید؛ هنگام ساخت پیشنهاد با مقدار واقعی جای‌گذاری می‌شوند.">
              <TextArea id={`tpl-body-${key}`} value={draft.templates[key].body} onChange={(e) => setTpl(key, 'body', e.target.value)} rows={10} />
            </Field>
          </div>
        </Card>
      ))}

      <Card>
        <CardHeader title="متغیرهای متن" subtitle="این عبارت‌ها هنگام ساخت پیشنهاد با مقدار واقعی جای‌گذاری می‌شوند؛ متغیر ناشناخته حذف می‌شود." icon={Sparkles} />
        <div className="flex flex-wrap gap-2">
          {TEMPLATE_VARS.map((v) => (
            <Chip key={v} tone="neutral">
              <span className="hv-latin">{v}</span>
            </Chip>
          ))}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => setDraft(settings)} disabled={saving}>
          <RotateCcw className="w-4 h-4" /> بازگرداندن
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setDraft({ ...draft, templates: settings.templates })} disabled={saving}>
            فقط متن‌های پیش‌فرض
          </Button>
          <Button onClick={save} loading={saving}>
            ذخیرهٔ قواعد
          </Button>
        </div>
      </div>
    </div>
  );
}

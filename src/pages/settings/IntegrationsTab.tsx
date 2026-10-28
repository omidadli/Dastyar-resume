import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Briefcase,
  CalendarCheck2,
  ExternalLink,
  Link2,
  Mail,
  PlugZap,
  Save,
  Send,
  MessagesSquare,
  CheckCircle2,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, Select, Switch, TextArea, TextInput, toast } from '../../components/ui';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { faDate, faNumber } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { useAsync } from '../../lib/useAsync';
import type { ChatProvider, ChatStatusPublic, EmailSettingsPublic, SmsProvider, SmsSettingsPublic } from '../../types/integrations';
import { CHAT_EVENT_LABEL } from '../../types/integrations';

const HOST_PRESETS: { id: string; label: string; host: string; port: number; secure: boolean; hint: string }[] = [
  { id: 'gmail', label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465, secure: true, hint: 'در حساب گوگل «App Password» بسازید (نیازمند تأیید دومرحله‌ای).' },
  { id: 'outlook', label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false, hint: 'اگر SMTP AUTH برای حساب شما فعال است، با رمز خود حساب وارد شوید.' },
  { id: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true, hint: 'از «App Password» استفاده کنید.' },
  { id: 'custom', label: 'سرور ایمیل سازمان', host: '', port: 587, secure: false, hint: 'اطلاعات SMTP را از مدیر شبکه بگیرید.' },
];

/** «ایمیل سازمان» — the mailbox every drafted candidate message is sent from. */
function EmailCard() {
  const canEdit = useCan('admin');
  const status = useAsync(() => api.integrations.status(), []);
  const current = status.data?.email;
  const [form, setForm] = useState({
    preset: 'custom',
    host: '',
    port: 587,
    secure: false,
    username: '',
    password: '',
    fromName: '',
    fromAddress: '',
    replyTo: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  // Seed once from the server: a refresh must not wipe what the admin is typing.
  useEffect(() => {
    if (!current) return;
    setForm((f) => ({
      ...f,
      preset: 'custom',
      host: current.host || '',
      port: current.port || 587,
      secure: current.secure,
      username: current.username || '',
      fromName: current.fromName || '',
      fromAddress: current.fromAddress || '',
      replyTo: current.replyTo || '',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.host, current?.port, current?.username, current?.fromAddress]);

  const applyPreset = (id: string) => {
    const p = HOST_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setForm((f) => ({
      ...f,
      preset: id,
      host: p.host || f.host,
      port: p.port,
      secure: p.secure,
      fromName: f.fromName || 'واحد منابع انسانی',
    }));
  };

  const save = async () => {
    setSaving(true);
    setTest(null);
    try {
      const { email } = await api.integrations.saveEmail({
        host: form.host,
        port: Number(form.port),
        secure: form.secure,
        username: form.username,
        password: form.password || undefined,
        fromName: form.fromName,
        fromAddress: form.fromAddress,
        replyTo: form.replyTo || null,
      });
      status.setData((d) => (d ? { ...d, email } : d));
      setForm((f) => ({ ...f, password: '' }));
      toast('اتصال ایمیل سازمان برقرار شد.');
    } catch (e: any) {
      setTest({ ok: false, error: e?.message || 'ذخیره ممکن نشد.' });
      toast(e?.message || 'اتصال ایمیل برقرار نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.integrations.testEmail();
      setTest(r);
      toast(r.ok ? 'اتصال ایمیل سالم است.' : r.error || 'اتصال ایمیل برقرار نشد.', r.ok ? 'success' : 'error');
    } catch (e: any) {
      setTest({ ok: false, error: e?.message || 'آزمایش ممکن نشد.' });
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    try {
      const { email } = await api.integrations.disconnectEmail();
      status.setData((d) => (d ? { ...d, email } : d));
      setConfirmOff(false);
      toast('اتصال ایمیل سازمان قطع شد.');
    } catch (e: any) {
      toast(e?.message || 'قطع اتصال ممکن نشد.', 'error');
    }
  };

  const email: EmailSettingsPublic | undefined = status.data?.email;
  const preset = HOST_PRESETS.find((p) => p.id === form.preset);

  return (
    <Card>
      <CardHeader
        icon={Mail}
        title="ایمیل سازمان"
        subtitle="پیام‌های آمادهٔ کاندیداها با همین حساب، از داخل هویدا ارسال می‌شوند."
        action={
          email?.configured ? (
            <Chip tone="brand" icon={CheckCircle2}>
              {email.fromAddress}
            </Chip>
          ) : (
            <Chip tone="warning" icon={AlertTriangle}>
              متصل نیست
            </Chip>
          )
        }
      />
      {!canEdit && <Callout tone="info" className="mb-4">فقط مالک یا مدیر فضای کاری می‌تواند اتصال ایمیل را تغییر دهد.</Callout>}
      {status.loading && <p className="text-[13px] text-ink-3">در حال خواندن وضعیت اتصال…</p>}
      {!status.loading && (
        <div className="flex flex-col gap-4">
          <div className="grid sm:grid-cols-2 gap-3">
            <Select
              label="سرویس ایمیل"
              value={form.preset}
              onChange={(e) => applyPreset(e.target.value)}
              disabled={!canEdit}
              options={HOST_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
            />
            <TextInput
              label="سرور SMTP"
              placeholder="smtp.gmail.com"
              dir="ltr"
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              disabled={!canEdit}
            />
            <TextInput
              label="پورت"
              dir="ltr"
              inputMode="numeric"
              value={String(form.port)}
              onChange={(e) => setForm({ ...form, port: Number(e.target.value.replace(/\D/g, '')) || 0 })}
              disabled={!canEdit}
            />
            <div className="flex items-end pb-2.5">
              <Switch
                checked={form.secure}
                onChange={(v) => setForm({ ...form, secure: v, port: v && form.port === 587 ? 465 : !v && form.port === 465 ? 587 : form.port })}
                label="اتصال امن (SSL/TLS)"
                disabled={!canEdit}
              />
            </div>
            <TextInput
              label="نام کاربری"
              placeholder="hr@company.ir"
              dir="ltr"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              disabled={!canEdit}
            />
            <TextInput
              label={email?.hasPassword ? 'رمز عبور (برای تغییر پر کنید)' : 'رمز عبور / App Password'}
              type="password"
              placeholder={email?.hasPassword ? '••••••••' : ''}
              dir="ltr"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              disabled={!canEdit}
            />
            <TextInput
              label="نام فرستنده"
              placeholder="واحد منابع انسانی"
              value={form.fromName}
              onChange={(e) => setForm({ ...form, fromName: e.target.value })}
              disabled={!canEdit}
            />
            <TextInput
              label="نشانی فرستنده"
              placeholder="hr@company.ir"
              dir="ltr"
              value={form.fromAddress}
              onChange={(e) => setForm({ ...form, fromAddress: e.target.value })}
              disabled={!canEdit}
            />
            <TextInput
              label="پاسخ به (اختیاری)"
              placeholder="recruitment@company.ir"
              dir="ltr"
              value={form.replyTo}
              onChange={(e) => setForm({ ...form, replyTo: e.target.value })}
              disabled={!canEdit}
            />
          </div>
          {preset?.hint && form.preset !== 'custom' && <p className="text-[12.5px] text-ink-3">{preset.hint}</p>}

          {test && (
            <Callout tone={test.ok ? 'brand' : 'danger'} icon={test.ok ? CheckCircle2 : AlertTriangle}>
              {test.ok ? 'اتصال به سرور ایمیل برقرار شد.' : test.error}
            </Callout>
          )}
          {!test && email?.lastTestOk === false && email.lastError && (
            <Callout tone="warning" icon={AlertTriangle}>
              آخرین آزمایش ناموفق بود: {email.lastError}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {canEdit && (
              <>
                <Button icon={Save} onClick={save} loading={saving} disabled={!form.host || !form.username || !form.fromAddress || (!form.password && !email?.hasPassword)}>
                  ذخیره و آزمون اتصال
                </Button>
                <Button variant="secondary" icon={Send} onClick={runTest} loading={testing} disabled={!email?.configured}>
                  آزمایش دوباره
                </Button>
                {email?.configured && (
                  <Button variant="secondary" icon={Trash2} onClick={() => setConfirmOff(true)}>
                    قطع اتصال
                  </Button>
                )}
              </>
            )}
            {email?.lastTestAtISO && <span className="text-[12px] text-ink-3">آخرین آزمایش: {faDate(email.lastTestAtISO)}</span>}
          </div>
          <p className="text-[12px] text-ink-3 leading-relaxed">
            رمز عبور فقط به‌صورت رمزنگاری‌شده ذخیره می‌شود و هیچ‌گاه به مرورگر برنمی‌گردد. هویدا تنها وقتی از این حساب ایمیل می‌فرستد که شما
            دکمهٔ «ارسال با ایمیل سازمان» را بزنید.
          </p>
        </div>
      )}
      <ConfirmDialog
        open={confirmOff}
        title="قطع اتصال ایمیل سازمان"
        description="پس از این، ارسال ایمیل از داخل هویدا ممکن نیست تا دوباره وصل کنید. لاگ ایمیل‌های ارسال‌شده باقی می‌ماند."
        confirmLabel="قطع اتصال"
        onConfirm={disconnect}
        onClose={() => setConfirmOff(false)}
      />
    </Card>
  );
}

/** Google Calendar + LinkedIn: what this deployment offers and how to connect. */
function CalendarCard({ redirectUri, connected, accountEmail, configured }: { redirectUri: string | null; connected: boolean; accountEmail: string | null; configured: boolean }) {
  const canEdit = useCan('admin');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { url } = await api.integrations.calendarConnectUrl();
      // A full navigation, not a popup: Google's consent screen is its own site.
      window.location.href = url;
    } catch (e: any) {
      toast(e?.message || 'اتصال به گوگل ممکن نشد.', 'error');
      setBusy(false);
    }
  };

  const disconnect = async () => {
    try {
      await api.integrations.disconnectCalendar();
      setConfirmOff(false);
      toast('اتصال تقویم قطع شد؛ رویدادهای ساخته‌شده در گوگل باقی می‌مانند.');
      window.location.reload();
    } catch (e: any) {
      toast(e?.message || 'قطع اتصال ممکن نشد.', 'error');
    }
  };

  const copyRedirect = async () => {
    if (!redirectUri) return;
    try {
      await navigator.clipboard.writeText(redirectUri);
      setCopied(true);
      toast('نشانی بازگشت کپی شد؛ آن را در Google Cloud Console ثبت کنید.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('کپی خودکار ممکن نشد؛ نشانی را دستی انتخاب کنید.', 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={CalendarCheck2}
        title="Google Calendar"
        subtitle="جلسهٔ مصاحبه را داخل هویدا تعیین کنید؛ رویداد در تقویم شما ثبت و برای کارجو ارسال می‌شود."
        action={
          connected ? (
            <Chip tone="brand" icon={CheckCircle2}>
              {accountEmail}
            </Chip>
          ) : (
            <Chip tone="warning" icon={AlertTriangle}>
              متصل نیست
            </Chip>
          )
        }
      />
      <div className="flex flex-col gap-4">
        {!configured ? (
          <Callout tone="warning" icon={ShieldCheck} title="این نصب هنوز به گوگل وصل نشده است">
            مدیر سامانه باید یک «OAuth Client» از نوع Web application در Google Cloud Console بسازد و Client ID و Client Secret را در
            <span className="font-semibold"> پنل مدیریت › «اتصال‌ها»</span> ثبت کند (دیگر نیازی به تغییر فایل تنظیمات سرور نیست). راهنمای گام‌به‌گام:
            <span dir="ltr" className="font-mono text-[12px] mx-1">docs/CONNECT-GOOGLE-CALENDAR.md</span>
          </Callout>
        ) : (
          <>
            {redirectUri && (
              <div>
                <p className="text-[12.5px] text-ink-2 font-semibold mb-1.5">نشانی بازگشت (Authorized redirect URI)</p>
                <div className="flex items-center gap-2">
                  <code dir="ltr" className="flex-1 min-w-0 truncate rounded-[8px] bg-canvas border border-line-2 px-3 py-2 text-[12px]">
                    {redirectUri}
                  </code>
                  <Button size="sm" variant="secondary" onClick={copyRedirect} icon={copied ? CheckCircle2 : Link2}>
                    کپی
                  </Button>
                </div>
                <p className="text-[12px] text-ink-3 mt-1.5">دقیقاً همین نشانی را در بخش Authorized redirect URIs همان OAuth Client ثبت کنید.</p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canEdit &&
                (connected ? (
                  <Button variant="secondary" icon={Trash2} onClick={() => setConfirmOff(true)}>
                    قطع اتصال
                  </Button>
                ) : (
                  <Button icon={ExternalLink} onClick={connect} loading={busy}>
                    اتصال حساب گوگل
                  </Button>
                ))}
              {connected && (
                <span className="text-[12px] text-ink-3">با اتصال فعلی، دعوت‌نامه‌ها را خود گوگل برای کارجو می‌فرستد.</span>
              )}
            </div>
            {!canEdit && <Callout tone="info">فقط مالک یا مدیر فضای کاری می‌تواند تقویم را وصل کند.</Callout>}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmOff}
        title="قطع اتصال Google Calendar"
        description="از این پس جلسه‌های جدید در تقویم گوگل ثبت نمی‌شوند (اما در هویدا می‌مانند و فایل ICS قابل دریافت است)."
        confirmLabel="قطع اتصال"
        onConfirm={disconnect}
        onClose={() => setConfirmOff(false)}
      />
    </Card>
  );
}

/**
 * «پیامک سازمان» — in Iran e-mail alone loses candidates. The workspace brings
 * its own gateway (Kavenegar or sms.ir); HOVIDA never sends from a shared line.
 */
/**
 * «پورتال شغلی» — a public page on the workspace's own slug. Openings appear
 * there only when a job is explicitly published from its page.
 */
/**
 * «اطلاع‌رسانی در اسلک/تیمز» — the team watches its own channel, not a dashboard.
 * The webhook URL is a secret: it is stored encrypted and never sent back.
 */
function ChatCard() {
  const can = useCan('admin');
  const status = useAsync(() => api.integrations.status(), []);
  const [chat, setChat] = useState<ChatStatusPublic | undefined>(status.data?.chat);
  const [provider, setProvider] = useState<ChatProvider>('slack');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => setChat(status.data?.chat), [status.data?.chat]);
  useEffect(() => {
    if (!chat) return;
    if (chat.provider) setProvider(chat.provider);
    if (chat.events.length) setEvents(chat.events);
    else setEvents(Object.keys(CHAT_EVENT_LABEL));
  }, [chat?.provider, chat?.events?.join(',')]);

  const toggle = (key: string) => setEvents((prev) => (prev.includes(key) ? prev.filter((e) => e !== key) : [...prev, key]));

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.integrations.saveChat({ provider, url: url || undefined, events });
      setChat(res.chat);
      setUrl('');
      toast('اطلاع‌رسانی وصل و با یک پیام آزمایشی تأیید شد.');
    } catch (err: any) {
      toast(err?.message || 'اتصال وبهوک ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await api.integrations.testChat();
      toast(res.ok ? 'پیام آزمایشی در کانال شما نشست.' : `وبهوک پاسخ نداد: ${res.error}`, res.ok ? 'success' : 'error');
      status.reload();
    } catch (err: any) {
      toast(err?.message || 'آزمایش ممکن نشد.', 'error');
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    try {
      const res = await api.integrations.disconnectChat();
      setChat(res.chat);
      toast('اطلاع‌رسانی قطع شد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'قطع اتصال ممکن نشد.', 'error');
    } finally {
      setConfirmOff(false);
    }
  };

  const configured = Boolean(chat?.configured);
  return (
    <Card>
      <CardHeader
        icon={MessagesSquare}
        title="اطلاع‌رسانی در اسلک / تیمز"
        subtitle="خط اطلاع‌رسانی در کانال خود تیم"
        action={configured ? <Chip tone="brand" icon={CheckCircle2}>متصل</Chip> : <Chip tone="neutral">وصل نشده</Chip>}
      />
      <div className="space-y-3">
        <Select
          label="سرویس"
          value={provider}
          onChange={(e) => setProvider(e.target.value as ChatProvider)}
          options={[
            { value: 'slack', label: 'اسلک (Incoming Webhook)' },
            { value: 'teams', label: 'مایکروسافت تیمز' },
            { value: 'generic', label: 'وبهوک دلخواه (Mattermost / Rocket.Chat)' },
          ]}
          disabled={!can || saving}
        />
        <TextInput
          label={configured ? 'نشانی وبهوک (برای تغییر وارد کنید)' : 'نشانی وبهوک'}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          latin
          placeholder={provider === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://…webhook.office.com/…'}
          hint="رمزنگاری‌شده ذخیره می‌شود و هرگز به مرورگر برنمی‌گردد."
          disabled={!can || saving}
        />
        <div>
          <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">چه خبرهایی برود؟</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(CHAT_EVENT_LABEL).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                disabled={!can}
                className={`text-[12px] rounded-full border px-2.5 py-1 transition ${
                  events.includes(key) ? 'border-brand bg-brand-soft text-brand-ink font-semibold' : 'border-line text-ink-3'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {chat?.lastError && <p className="text-[12px] text-low-ink leading-relaxed">{chat.lastError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={Save} onClick={() => void save()} loading={saving} disabled={!can || saving || (!url && !configured)}>
            ذخیره و آزمایش
          </Button>
          {configured && (
            <>
              <Button variant="secondary" icon={Send} onClick={() => void test()} loading={testing} disabled={!can}>
                آزمایش
              </Button>
              <Button variant="ghost" icon={Trash2} onClick={() => setConfirmOff(true)} disabled={!can}>
                قطع اتصال
              </Button>
            </>
          )}
        </div>
        {!can && <p className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند وبهوک را تنظیم کند.</p>}
        {chat?.lastTestAtISO && (
          <p className="text-[11.5px] text-ink-4">
            آخرین آزمایش: {faDate(chat.lastTestAtISO)} — {chat.lastTestOk ? 'موفق' : 'ناموفق'}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => void disconnect()}
        title="قطع اطلاع‌رسانی؟"
        description="پس از قطع، هیچ پیامی به کانال شما نمی‌رود؛ تنظیمات دیگر فضای کاری دست نمی‌خورد."
        confirmLabel="قطع اتصال"
      />
    </Card>
  );
}

function CareersCard() {
  const can = useCan('admin');
  const settings = useAsync(() => api.careers.settings(), []);
  const [slug, setSlug] = useState('');
  const [about, setAbout] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const data = settings.data?.careers;
  useEffect(() => {
    if (!data) return;
    setSlug(data.slug);
    setAbout(data.about);
  }, [data?.slug, data?.about]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.careers.saveSettings({ slug, about });
      settings.setData({ careers: res.careers });
      toast('نشانی پورتال ذخیره شد.');
    } catch (err: any) {
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!data) return;
    const ok = await copyText(data.url);
    setCopied(ok);
    toast(ok ? 'نشانی پورتال کپی شد.' : 'کپی نشد؛ نشانی را دستی بردارید.', ok ? 'success' : 'error');
    window.setTimeout(() => setCopied(false), 2000);
  };

  const dirty = Boolean(data && (slug !== data.slug || about !== data.about));
  return (
    <Card>
      <CardHeader
        icon={Briefcase}
        title="پورتال شغلی"
        subtitle="صفحهٔ عمومی فرصت‌های شغلی، روی دامنهٔ هویدا"
        action={data ? <Chip tone="neutral">{`${faNumber(data.publishedJobs)} از ${faNumber(data.totalJobs)} منتشرشده`}</Chip> : undefined}
      />
      <div className="space-y-3">
        <TextInput
          label="نشانی پورتال (slug)"
          value={slug}
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          latin
          placeholder="hovida"
          hint="حروف کوچک انگلیسی، رقم و خط تیره؛ بین ۳ تا ۴۰ نویسه."
          disabled={!can || saving}
        />
        <TextArea
          label="دربارهٔ سازمان (در پورتال دیده می‌شود)"
          value={about}
          onChange={(e) => setAbout(e.target.value.slice(0, 600))}
          rows={3}
          placeholder="چند خط دربارهٔ تیم، محصول و فرهنگ کاری…"
          disabled={!can || saving}
        />
        {data && (
          <div className="rounded-[12px] border border-line bg-canvas px-3 py-2.5 flex items-center gap-2">
            <span className="text-[12.5px] text-ink-2 truncate flex-1" dir="ltr">
              {data.url}
            </span>
            <Button size="sm" variant="ghost" icon={copied ? CheckCircle2 : Link2} onClick={() => void copy()}>
              {copied ? 'کپی شد' : 'کپی نشانی'}
            </Button>
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => window.open(data.url, '_blank', 'noopener')}>
              دیدن
            </Button>
          </div>
        )}
        {!can && <p className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند نشانی پورتال را تغییر دهد.</p>}
        <div className="flex items-center gap-2">
          <Button icon={Save} onClick={() => void save()} loading={saving} disabled={!can || saving || !dirty || !slug}>
            ذخیرهٔ پورتال
          </Button>
          {data?.publishedJobs === 0 && (
            <span className="text-[11.5px] text-ink-4">هنوز فرصتی منتشر نشده؛ از صفحهٔ هر فرصت، «انتشار در پورتال» را بزنید.</span>
          )}
        </div>
      </div>
    </Card>
  );
}

function SmsCard() {
  const status = useAsync(() => api.integrations.status(), []);
  const can = useCan('admin');
  const [sms, setSms] = useState<SmsSettingsPublic | undefined>(status.data?.sms);
  const [provider, setProvider] = useState<SmsProvider>('kavenegar');
  const [sender, setSender] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  useEffect(() => setSms(status.data?.sms), [status.data?.sms]);
  useEffect(() => {
    if (sms?.provider) setProvider(sms.provider);
    if (sms?.sender && !sender) setSender(sms.sender);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sms?.provider, sms?.sender]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.integrations.saveSms({ provider, sender, apiKey: apiKey || undefined });
      setSms(res.sms);
      setApiKey('');
      toast('پیامک سازمان متصل و تأیید شد.');
    } catch (err: any) {
      toast(err?.message || 'اتصال پیامک ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const res = await api.integrations.testSms();
      toast(res.ok ? 'سرویس پیامک پاسخ داد؛ اتصال سالم است.' : `سرویس پیامک پاسخ نداد: ${res.error}`, res.ok ? 'success' : 'error');
      status.reload();
    } catch (err: any) {
      toast(err?.message || 'آزمایش اتصال ممکن نشد.', 'error');
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    try {
      const res = await api.integrations.disconnectSms();
      setSms(res.sms);
      toast('اتصال پیامک برداشته شد؛ دیگر پیامکی فرستاده نمی‌شود.', 'info');
    } catch (err: any) {
      toast(err?.message || 'قطع اتصال ممکن نشد.', 'error');
    } finally {
      setConfirmOff(false);
    }
  };

  const configured = Boolean(sms?.configured);
  return (
    <Card>
      <CardHeader
        icon={Send}
        title="پیامک سازمان"
        subtitle="کاوه‌نگار یا sms.ir — با حساب و خط خودتان"
        action={configured ? <Chip tone="brand" icon={CheckCircle2}>متصل</Chip> : <Chip tone="neutral">وصل نشده</Chip>}
      />
      {!configured && (
        <Callout tone="info" className="mb-4">
          در ایران بخش زیادی از کارجوها ایمیل را نمی‌بینند. با اتصال پیامک، دعوت مصاحبه و یادآوری جلسه را هم می‌توانید
          پیامک کنید. کلید API را از پنل کاوه‌نگار یا sms.ir بردارید؛ اعتبار و خط، مالِ خودتان می‌ماند.
        </Callout>
      )}
      <div className="space-y-3">
        <Select
          label="سرویس پیامک"
          value={provider}
          onChange={(e) => setProvider(e.target.value as SmsProvider)}
          options={[
            { value: 'kavenegar', label: 'کاوه‌نگار (Kavenegar)' },
            { value: 'smsir', label: 'sms.ir' },
          ]}
          disabled={!can || saving}
          hint={sms?.provider ? `اتصال فعلی: ${sms.provider === 'smsir' ? 'sms.ir' : 'کاوه‌نگار'}` : undefined}
        />
        <TextInput
          label="شمارهٔ خط فرستنده"
          value={sender}
          onChange={(e) => setSender(e.target.value)}
          latin
          placeholder="10004346"
          hint="همان خطی که در پنل سرویس پیامک برای شما ثبت شده است."
          disabled={!can || saving}
        />
        <TextInput
          label={sms?.hasApiKey ? 'کلید API (برای تغییر وارد کنید)' : 'کلید API'}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          latin
          placeholder={sms?.hasApiKey ? 'کلید ذخیره شده است' : 'کلید API'}
          disabled={!can || saving}
          hint="رمزنگاری‌شده ذخیره می‌شود و هرگز به مرورگر برنمی‌گردد."
        />
        {!can && <p className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند پیامک را وصل کند.</p>}
        {sms?.lastError && <p className="text-[12px] text-low-ink leading-relaxed">{sms.lastError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={Save} onClick={() => void save()} loading={saving} disabled={!can || saving || !sender || (!apiKey && !sms?.hasApiKey)}>
            ذخیره و آزمایش
          </Button>
          {configured && (
            <>
              <Button variant="secondary" icon={Send} onClick={() => void test()} loading={testing} disabled={!can}>
                آزمایش اتصال
              </Button>
              <Button variant="ghost" icon={Trash2} onClick={() => setConfirmOff(true)} disabled={!can}>
                قطع اتصال
              </Button>
            </>
          )}
        </div>
        {sms?.lastTestAtISO && (
          <p className="text-[11.5px] text-ink-4">
            آخرین آزمایش: {faDate(sms.lastTestAtISO)} — {sms.lastTestOk ? 'موفق' : 'ناموفق'}
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => void disconnect()}
        title="قطع اتصال پیامک؟"
        description="پس از قطع، هیچ پیامکی از این فضای کاری فرستاده نمی‌شود؛ تاریخچهٔ ارسال‌ها می‌ماند."
        confirmLabel="قطع اتصال"
      />
    </Card>
  );
}

function SourcingCard({ configured, providerLabel, endpointHost, setupHint, docPath }: { configured: boolean; providerLabel: string; endpointHost: string | null; setupHint: string; docPath: string }) {
  return (
    <Card>
      <CardHeader
        icon={Users}
        title="جست‌وجوی استعداد (LinkedIn)"
        subtitle="پیدا کردن افراد واجد شرایط و Open to work، و افزودنشان به فرصت شغلی."
        action={
          configured ? (
            <Chip tone="brand" icon={CheckCircle2}>
              {providerLabel}
            </Chip>
          ) : (
            <Chip tone="warning" icon={AlertTriangle}>
              تنظیم نشده
            </Chip>
          )
        }
      />
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-ink-2 leading-relaxed">{setupHint}</p>
        {endpointHost && (
          <p className="text-[12px] text-ink-3">
            سرویس متصل: <span dir="ltr" className="font-mono">{endpointHost}</span>
          </p>
        )}
        <Callout tone="info" icon={ShieldCheck}>
          جست‌وجو فقط از طریق دسترسی رسمی سازمان شما انجام می‌شود؛ هویدا هیچ پروفایلی از خودش نمی‌سازد و داده‌ای را اسکرپ نمی‌کند.
          مستند اتصال: <span dir="ltr" className="font-mono text-[12px]">{docPath}</span>
        </Callout>
      </div>
    </Card>
  );
}

export function IntegrationsTab() {
  const status = useAsync(() => api.integrations.status(), []);
  const data = status.data;
  return (
    <div className="grid xl:grid-cols-2 gap-5 max-w-[1200px] items-start">
      <div className="flex flex-col gap-5">
        <EmailCard />
        <SmsCard />
        <ChatCard />
        <CareersCard />
        <SourcingCard
          configured={data?.sourcing.configured ?? false}
          providerLabel={data?.sourcing.providerLabel ?? 'LinkedIn'}
          endpointHost={data?.sourcing.endpointHost ?? null}
          setupHint={data?.sourcing.setupHint ?? 'وضعیت اتصال در حال بررسی است…'}
          docPath={data?.sourcing.docPath ?? 'docs/CONNECT-LINKEDIN.md'}
        />
      </div>
      <div className="flex flex-col gap-5">
        <CalendarCard
          configured={data?.calendar.configured ?? false}
          connected={data?.calendar.connected ?? false}
          accountEmail={data?.calendar.accountEmail ?? null}
          redirectUri={data?.calendar.redirectUri ?? null}
        />
        <Card>
          <CardHeader icon={PlugZap} title="چطور کار می‌کند؟" subtitle="سه اتصال، سه کار روشن" />
          <ul className="text-[13px] text-ink-2 leading-[2] list-disc pr-5">
            <li>
              <b>جست‌وجوی استعداد:</b> دپارتمان و شرح «دنبال چه کسی هستم» را می‌دهید؛ هویدا شرایط را به کوئری جست‌وجو تبدیل می‌کند و پروفایل‌های واجد شرایط را می‌آورد. هر پروفایل را می‌توانید به‌عنوان کاندید به یک فرصت شغلی اضافه کنید تا با همان موتور غربالگری سنجیده شود.
            </li>
            <li>
              <b>ایمیل سازمان:</b> پیش‌نویس پیام کاندیدا را ویرایش می‌کنید و با همین حساب می‌فرستید؛ نسخهٔ ارسال‌شده در تاریخچهٔ کاندیدا می‌ماند.
            </li>
            <li>
              <b>پیامک سازمان:</b> برای کارجویانی که ایمیل را نمی‌بینند؛ پیام‌های کوتاه (دعوت، یادآوری جلسه، تغییر وضعیت) از خط خودتان و با اعتبار پنل خودتان فرستاده می‌شود.
            </li>
            <li>
              <b>Google Calendar:</b> تاریخ و ساعت جلسه را انتخاب می‌کنید؛ رویداد با لینک Google Meet در تقویم شما ساخته می‌شود و دعوت‌نامه برای کارجو و مصاحبه‌گران می‌رود. اگر تقویم وصل نباشد، همین جلسه در هویدا ثبت می‌شود و می‌توانید فایل ICS را دانلود یا با ایمیل سازمان بفرستید.
            </li>
          </ul>
        </Card>
      </div>
    </div>
  );
}

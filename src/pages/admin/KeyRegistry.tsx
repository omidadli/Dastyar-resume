import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BrainCircuit,
  CalendarCheck2,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Mail,
  MessagesSquare,
  Save,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, Select, Switch, TextInput, toast } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { faDate } from '../../lib/format';
import { Link } from '../../lib/router';
import type { ConnectionsPayload, SharedEmailPublic, SharedSmsPublic } from '../../types/admin';

/** Same list as the workspace card, so the admin sees the familiar choices. */
const HOST_PRESETS: { id: string; label: string; host: string; port: number; secure: boolean }[] = [
  { id: 'gmail', label: 'Gmail / Google Workspace', host: 'smtp.gmail.com', port: 465, secure: true },
  { id: 'outlook', label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false },
  { id: 'zoho', label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, secure: true },
  { id: 'custom', label: 'سرور ایمیل سازمان', host: '', port: 587, secure: false },
];

function StatusChip({ value }: { value: 'active' | 'shared' | 'none' }) {
  if (value === 'active')
    return (
      <Chip tone="brand">
        <CheckCircle2 className="w-3.5 h-3.5" /> ثبت شده
      </Chip>
    );
  if (value === 'shared')
    return (
      <Chip tone="outline">
        <ShieldCheck className="w-3.5 h-3.5" /> از تنظیمات فضای کاری
      </Chip>
    );
  return (
    <Chip tone="warning">
      <AlertTriangle className="w-3.5 h-3.5" /> تنظیم نشده
    </Chip>
  );
}

function slugOf(text: string) {
  return text.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

/** «صندوق ایمیل مشترک سامانه» — one mailbox for workspaces that have none. */
export function SharedEmailCard({ data, setData }: { data: ConnectionsPayload; setData: (d: ConnectionsPayload) => void }) {
  const e: SharedEmailPublic = data.email;
  const [preset, setPreset] = useState('custom');
  const [host, setHost] = useState(e.fromEnv ? '' : e.host || '');
  const [port, setPort] = useState(String(e.port || 587));
  const [secure, setSecure] = useState(e.secure);
  const [username, setUsername] = useState(e.fromEnv ? '' : e.username || '');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState(e.fromName || '');
  const [fromAddress, setFromAddress] = useState(e.fromEnv ? '' : e.fromAddress || '');
  const [replyTo, setReplyTo] = useState(e.replyTo || '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    setHost(e.fromEnv ? '' : e.host || '');
    setPort(String(e.port || 587));
    setSecure(e.secure);
    setUsername(e.fromEnv ? '' : e.username || '');
    setFromName(e.fromName || '');
    setFromAddress(e.fromEnv ? '' : e.fromAddress || '');
    setReplyTo(e.replyTo || '');
  }, [e.host, e.port, e.secure, e.username, e.fromName, e.fromAddress, e.replyTo, e.fromEnv]);

  const applyPreset = (id: string) => {
    setPreset(id);
    const p = HOST_PRESETS.find((x) => x.id === id);
    if (!p) return;
    if (p.host) setHost(p.host);
    setPort(String(p.port));
    setSecure(p.secure);
    if (!fromName) setFromName('واحد منابع انسانی');
  };

  const save = async () => {
    setSaving(true);
    try {
      const next = await adminApi.saveSharedEmail({
        host: host.trim(),
        port: Number(port) || 0,
        secure,
        username: username.trim(),
        password: password.trim() || undefined,
        fromName: fromName.trim(),
        fromAddress: fromAddress.trim(),
        replyTo: replyTo.trim() || null,
      });
      setData(next);
      setPassword('');
      toast('صندوق ایمیل مشترک آزمایش و ذخیره شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'صندوق ایمیل مشترک ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const { result, connections } = await adminApi.testSharedEmail();
      setData(connections);
      toast(result.ok ? 'صندوق مشترک پاسخ داد.' : result.error || 'آزمایش ناموفق بود.', result.ok ? 'success' : 'error');
    } catch (err: any) {
      toast(err?.message || 'آزمایش ممکن نشد.', 'error');
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      setData(await adminApi.removeSharedEmail());
      setConfirmOff(false);
      toast('صندوق مشترک پاک شد؛ فضاهای کاری بدون صندوق اختصاصی دیگر ایمیل نمی‌فرستند.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک نشد.', 'error');
    }
  };

  return (
    <div id="card-shared-email" className="scroll-mt-4">
    <Card>
      <CardHeader
        icon={Mail}
        title="صندوق ایمیل مشترک سامانه"
        subtitle="اختیاری ولی پرکاربرد: فضای کاری‌ای که صندوق خودش را وصل نکرده، با همین حساب ایمیل می‌فرستد. صندوق اختصاصی هر فضای کاری همیشه اولویت دارد."
        action={<StatusChip value={e.configured ? 'active' : 'none'} />}
      />
      <div className="space-y-4">
        {!e.configured && (
          <Callout tone="info" icon={ShieldCheck}>
            اگر اینجا خالی بماند، تا وقتی مالک هر فضای کاری صندوق خودش را در «تنظیمات ← اتصال‌ها» وصل نکند، دکمهٔ ارسال ایمیل
            با پیام روشن غیرفعال می‌ماند. پر کردن این بخش یعنی هویدا از روز اول می‌تواند ایمیل بفرستد.
          </Callout>
        )}
        {e.fromEnv && (
          <Callout tone="warning" icon={AlertTriangle}>
            مقدار فعلی از متغیرهای محیطی سرور می‌آید. ذخیره در این صفحه جای آن را می‌گیرد؛ برای حذف کامل باید متغیرها را هم بردارید.
          </Callout>
        )}
        <div className="grid sm:grid-cols-2 gap-3">
          <Select label="سرویس ایمیل" value={preset} onChange={(ev) => applyPreset(ev.target.value)} options={HOST_PRESETS.map((p) => ({ value: p.id, label: p.label }))} />
          <TextInput label="سرور SMTP" dir="ltr" placeholder="smtp.gmail.com" value={host} onChange={(ev) => setHost(ev.target.value)} />
          <TextInput
            label="پورت"
            dir="ltr"
            inputMode="numeric"
            value={port}
            onChange={(ev) => setPort(ev.target.value.replace(/\D/g, ''))}
            hint="۹۹۳/۴۶۵ برای SSL و ۵۸۷ برای STARTTLS."
          />
          <div className="flex items-end pb-2.5">
            <Switch
              checked={secure}
              onChange={(v) => setSecure(v)}
              label="اتصال امن (SSL/TLS)"
            />
          </div>
          <TextInput label="نام کاربری" dir="ltr" placeholder="hr@company.ir" value={username} onChange={(ev) => setUsername(ev.target.value)} />
          <TextInput
            label="رمز عبور / App Password"
            dir="ltr"
            type="password"
            autoComplete="off"
            placeholder={e.hasPassword && !e.fromEnv ? 'ذخیره شده — برای تغییر مقدار تازه بگذارید' : 'رمز یا App Password'}
            value={password}
            onChange={(ev) => setPassword(ev.target.value)}
            hint="رمزنگاری‌شده ذخیره می‌شود و دیگر نمایش داده نمی‌شود."
          />
          <TextInput label="نام فرستنده" placeholder="واحد منابع انسانی" value={fromName} onChange={(ev) => setFromName(ev.target.value)} />
          <TextInput label="نشانی فرستنده" dir="ltr" placeholder="hr@company.ir" value={fromAddress} onChange={(ev) => setFromAddress(ev.target.value)} />
          <TextInput label="پاسخ به (اختیاری)" dir="ltr" placeholder="jobs@company.ir" value={replyTo} onChange={(ev) => setReplyTo(ev.target.value)} />
        </div>
        {e.lastTestAtISO && (
          <div className="text-[12.5px] text-ink-3 flex items-center gap-2">
            {e.lastTestOk ? <CheckCircle2 className="w-4 h-4 text-brand" /> : <AlertTriangle className="w-4 h-4 text-review" />}
            آخرین آزمایش: {faDate(e.lastTestAtISO)} — {e.lastTestOk ? 'صندوق پاسخ داد' : e.lastError || 'ناموفق'}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={save} loading={saving} disabled={!host.trim() || !username.trim() || !fromAddress.trim() || (!password.trim() && !e.hasPassword)} icon={Save}>
            آزمایش و ذخیره
          </Button>
          <Button variant="secondary" onClick={test} loading={testing} disabled={!e.configured} icon={ShieldCheck}>
            آزمایش اتصال
          </Button>
          {e.source === 'admin' && (
            <Button variant="ghost" onClick={() => setConfirmOff(true)} icon={Trash2}>
              حذف صندوق مشترک
            </Button>
          )}
        </div>
        <p className="text-[11.5px] text-ink-4">
          صندوق مشترک فقط جایگزین است: هر فضای کاری که صندوق خودش را وصل کند، همیشه از حساب خودش می‌فرستد و در تنظیماتش همین
          را می‌بیند.
        </p>
      </div>
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={remove}
        title="حذف صندوق ایمیل مشترک"
        description="فضاهای کاری بدون صندوق اختصاصی دیگر نمی‌توانند ایمیل بفرستند تا صندوق خودشان را وصل کنند. ایمیل‌های ارسال‌شده پاک نمی‌شوند."
        confirmLabel="حذف کن"
        tone="danger"
      />
    </Card>
    </div>
  );
}

/** «خط پیامک مشترک سامانه» — same fallback for the Iranian SMS gateway. */
export function SharedSmsCard({ data, setData }: { data: ConnectionsPayload; setData: (d: ConnectionsPayload) => void }) {
  const s: SharedSmsPublic = data.sms;
  const [provider, setProvider] = useState<'kavenegar' | 'smsir'>(s.provider || 'kavenegar');
  const [apiKey, setApiKey] = useState('');
  const [sender, setSender] = useState(s.fromEnv ? '' : s.sender || '');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    setProvider(s.provider || 'kavenegar');
    setSender(s.fromEnv ? '' : s.sender || '');
  }, [s.provider, s.sender, s.fromEnv]);

  const save = async () => {
    setSaving(true);
    try {
      const next = await adminApi.saveSharedSms({ provider, apiKey: apiKey.trim() || undefined, sender: sender.trim() });
      setData(next);
      setApiKey('');
      toast('خط پیامک مشترک آزمایش و ذخیره شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'خط پیامک ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const { result, connections } = await adminApi.testSharedSms();
      setData(connections);
      toast(result.ok ? 'سرویس پیامک پاسخ داد.' : result.error || 'آزمایش ناموفق بود.', result.ok ? 'success' : 'error');
    } catch (err: any) {
      toast(err?.message || 'آزمایش ممکن نشد.', 'error');
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      setData(await adminApi.removeSharedSms());
      setConfirmOff(false);
      toast('خط پیامک مشترک پاک شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک نشد.', 'error');
    }
  };

  return (
    <div id="card-shared-sms" className="scroll-mt-4">
    <Card>
      <CardHeader
        icon={Smartphone}
        title="خط پیامک مشترک سامانه"
        subtitle="کاوه‌نگار یا sms.ir. فضای کاری بدون خط اختصاصی با همین خط پیامک می‌فرستد؛ خط اختصاصی همیشه اولویت دارد."
        action={<StatusChip value={s.configured ? 'active' : 'none'} />}
      />
      <div className="space-y-4">
        <Callout tone="info" icon={ShieldCheck}>
          کلید API پیش از ذخیره با سرویس سنجیده می‌شود (کاوه‌نگار: اعتبار حساب، sms.ir: اعتبار بسته)؛ کلید نامعتبر ذخیره نمی‌شود.
        </Callout>
        {s.fromEnv && (
          <Callout tone="warning" icon={AlertTriangle}>
            مقدار فعلی از متغیرهای محیطی سرور می‌آید. ذخیره در این صفحه جای آن را می‌گیرد.
          </Callout>
        )}
        <div className="grid sm:grid-cols-2 gap-3">
          <Select
            label="سرویس پیامک"
            value={provider}
            onChange={(ev) => setProvider(ev.target.value as 'kavenegar' | 'smsir')}
            options={[
              { value: 'kavenegar', label: 'کاوه‌نگار (Kavenegar)' },
              { value: 'smsir', label: 'sms.ir' },
            ]}
          />
          <TextInput label="خط فرستنده" dir="ltr" placeholder="10004346" value={sender} onChange={(ev) => setSender(ev.target.value)} />
          <TextInput
            label="کلید API"
            dir="ltr"
            type="password"
            autoComplete="off"
            placeholder={s.hasApiKey && !s.fromEnv ? 'ذخیره شده — برای تغییر مقدار تازه بگذارید' : 'API key'}
            value={apiKey}
            onChange={(ev) => setApiKey(ev.target.value)}
            hint="رمزنگاری‌شده ذخیره می‌شود و دوباره نمایش داده نمی‌شود."
          />
        </div>
        {s.lastTestAtISO && (
          <div className="text-[12.5px] text-ink-3 flex items-center gap-2">
            {s.lastTestOk ? <CheckCircle2 className="w-4 h-4 text-brand" /> : <AlertTriangle className="w-4 h-4 text-review" />}
            آخرین آزمایش: {faDate(s.lastTestAtISO)} — {s.lastTestOk ? 'سرویس پاسخ داد' : s.lastError || 'ناموفق'}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button onClick={save} loading={saving} disabled={!sender.trim() || (!apiKey.trim() && !s.hasApiKey)} icon={Save}>
            آزمایش و ذخیره
          </Button>
          <Button variant="secondary" onClick={test} loading={testing} disabled={!s.configured} icon={ShieldCheck}>
            آزمایش اتصال
          </Button>
          {s.source === 'admin' && (
            <Button variant="ghost" onClick={() => setConfirmOff(true)} icon={Trash2}>
              حذف خط مشترک
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={remove}
        title="حذف خط پیامک مشترک"
        description="فضاهای کاری بدون خط اختصاصی دیگر پیامک نمی‌فرستند. پیامک‌های ارسال‌شده در گزارش می‌مانند."
        confirmLabel="حذف کن"
        tone="danger"
      />
    </Card>
    </div>
  );
}

interface RegistryRow {
  id: string;
  title: string;
  icon: LucideIcon;
  powers: string;
  /** Where the value is entered. */
  where: string;
  status: 'active' | 'shared' | 'none';
  /** `jump` scrolls to a card on this page, `to` navigates inside the app. */
  jump?: string;
  to?: string;
  detail?: string | null;
}

/**
 * «نقشهٔ کلیدها» — every credential the product can need, what it turns on, and
 * where it is entered. A new operator should not have to read the source to
 * discover that «پیامک» needs a Kavenegar key.
 */
export function KeyRegistry({
  data,
  aiKeys,
  aiEnabled,
}: {
  data: ConnectionsPayload;
  aiKeys: number;
  aiEnabled: boolean;
}) {
  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Workspace-owned credentials are entered by the workspace's own admin; a
  // platform admin can still walk in through a support session and open exactly
  // that page — no hunting through /admin › فضاهای کاری.
  const orgs = useAsync(() => adminApi.orgs(), []);
  const [orgId, setOrgId] = useState('');
  const [target, setTarget] = useState('/app/settings/integrations');
  const [opening, setOpening] = useState(false);
  const openWorkspace = async () => {
    if (!orgId) return;
    const tab = window.open('about:blank', '_blank');
    setOpening(true);
    try {
      const { token } = await adminApi.support(orgId);
      const url = `/app#support=${token}&to=${encodeURIComponent(target)}`;
      if (tab) tab.location.href = url;
      else toast('مرورگر زبانه تازه را مسدود کرد؛ از «فضاهای کاری ← ورود پشتیبانی» استفاده کنید.', 'error');
      toast('نشست پشتیبانی باز شد؛ همان صفحه‌ای که انتخاب کردید باز می‌شود.');
    } catch (err: any) {
      tab?.close();
      toast(err?.message || 'ورود به فضای کاری ممکن نشد.', 'error');
    } finally {
      setOpening(false);
    }
  };

  const rows: RegistryRow[] = [
    {
      id: 'ai',
      title: 'کلید هوش مصنوعی (OpenAI / Gemini)',
      icon: BrainCircuit,
      powers: 'غربال رزومه، خلاصهٔ تحلیلی، آزمون استخدامی، پیش‌نویس پیام و گزارش‌ها.',
      where: 'پنل مدیریت ← کلیدهای هوش مصنوعی',
      status: aiKeys > 0 ? (aiEnabled ? 'active' : 'shared') : 'none',
      to: '/admin/ai',
      detail: aiKeys > 0 ? `${aiKeys} کلید` : null,
    },
    {
      id: 'sourcing',
      title: 'سرویس جست‌وجوی LinkedIn / Apify',
      icon: Users,
      powers: '«جذب و منبع‌یابی» و جست‌وجوی متخصص با فیلتر «آمادهٔ همکاری».',
      where: 'همین صفحه ← جست‌وجوی متخصص',
      status: data.sourcing.configured ? 'active' : 'none',
      jump: 'card-sourcing',
      detail: data.sourcing.providerLabel || null,
    },
    {
      id: 'google-oauth',
      title: 'کلید OAuth گوگل',
      icon: CalendarCheck2,
      powers: 'دکمهٔ «اتصال حساب گوگل» در تنظیمات هر فضای کاری و ثبت مصاحبه در Google Calendar.',
      where: 'همین صفحه ← Google Calendar',
      status: data.google.configured ? 'active' : 'none',
      jump: 'card-google',
      detail: data.google.calendarId || null,
    },
    {
      id: 'shared-email',
      title: 'صندوق ایمیل (SMTP)',
      icon: Mail,
      powers: 'ارسال ایمیل به کارجو از داخل هویدا — «ارسال» در پنل کارجو، دعوت مصاحبه، پیشنهاد شغلی و نظرسنجی.',
      where: 'همین صفحه (مشترک) یا تنظیمات هر فضای کاری (اختصاصی)',
      status: data.email.configured ? 'active' : 'none',
      jump: 'card-shared-email',
      detail: data.email.fromAddress,
    },
    {
      id: 'sms',
      title: 'خط پیامک (کاوه‌نگار / sms.ir)',
      icon: Smartphone,
      powers: 'پیامک به کارجو: دعوت به مصاحبه، یادآوری و پیگیری‌هایی که کارجو ایمیل را نمی‌بیند.',
      where: 'همین صفحه (مشترک) یا تنظیمات هر فضای کاری (اختصاصی)',
      status: data.sms.configured ? 'active' : 'none',
      jump: 'card-shared-sms',
      detail: data.sms.sender,
    },
    {
      id: 'calendar-workspace',
      title: 'حساب Google Calendar هر فضای کاری',
      icon: CalendarCheck2,
      powers: 'ثبت رویداد مصاحبه در تقویم سازمان و لغو خودکار آن.',
      where: 'تنظیمات فضای کاری ← اتصال‌ها',
      status: 'shared',
    },
    {
      id: 'chat',
      title: 'وب‌هوک چت (Slack / Teams)',
      icon: Webhook,
      powers: 'اعلان رویدادهای استخدام در کانال تیم منابع انسانی.',
      where: 'تنظیمات فضای کاری ← اتصال‌ها',
      status: 'shared',
    },
    {
      id: 'sso',
      title: 'ورود سازمانی (SSO / OIDC)',
      icon: Fingerprint,
      powers: 'ورود کارکنان با حساب سازمانی و عضویت خودکار دامنه‌های مجاز.',
      where: 'تنظیمات فضای کاری ← اتصال‌ها',
      status: 'shared',
    },
  ];

  const missing = rows.filter((r) => r.status === 'none').length;

  return (
    <Card>
      <CardHeader
        icon={KeyRound}
        title="نقشهٔ کلیدها — چه کلیدی، برای چه بخشی، کجا وارد می‌شود"
        subtitle="هر چیزی که هویدا برای کار کردن لازم دارد، با جای ورودش. سبز یعنی ثبت شده و در همان بخش کار می‌کند."
        action={
          <Chip tone={missing ? 'warning' : 'brand'}>
            {missing ? `${missing} مورد تنظیم نشده` : 'همه ثبت شده‌اند'}
          </Chip>
        }
      />
      <div className="divide-y divide-line-2 -mx-1">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <div key={r.id} id={slugOf(`key-${r.id}`)} className="flex flex-col sm:flex-row sm:items-center gap-3 py-3 px-1">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <span className="mt-0.5 w-8 h-8 shrink-0 rounded-[10px] bg-[#F1F4F1] text-ink-2 inline-flex items-center justify-center">
                  <Icon className="w-4 h-4" />
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-semibold text-ink">{r.title}</span>
                    <StatusChip value={r.status} />
                    {r.detail && <span dir="auto" className="text-[11.5px] text-ink-4 truncate max-w-[220px]">{r.detail}</span>}
                  </div>
                  <p className="text-[12.5px] text-ink-2 mt-1 leading-relaxed">{r.powers}</p>
                  <p className="text-[11.5px] text-ink-4 mt-0.5">محل ورود: {r.where}</p>
                </div>
              </div>
              {r.to ? (
                <Link to={r.to} className="shrink-0 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-brand hover:underline">
                  رفتن به بخش
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Link>
              ) : r.jump ? (
                <Button size="sm" variant="secondary" onClick={() => jumpTo(r.jump!)}>
                  رفتن به کارت
                  <ArrowLeft className="w-3.5 h-3.5" />
                </Button>
              ) : (
                <span className="shrink-0 text-[11.5px] text-ink-4">از بخش «ورود به تنظیمات فضای کاری» پایین</span>
              )}
            </div>
          );
        })}
      </div>
      <Callout tone="info" icon={MessagesSquare} className="mt-3">
        تنها کلیدهایی که «برای کل سامانه» ثبت می‌شوند در این صفحه‌اند. کلید هر سازمان (صندوق ایمیل اختصاصی، خط پیامک، وب‌هوک چت و
        SSO) مال خودش است و مدیر همان فضای کاری در «تنظیمات ← اتصال‌ها» واردش می‌کند؛ این جدایی عمدی است تا یک فضای کاری به
        حساب فضای کاری دیگر دسترسی نداشته باشد. اگر باید برای یک سازمان خودتان وارد کنید، از همین‌جا وارد تنظیماتش شوید:
      </Callout>
      <div className="mt-3 rounded-xl border border-line bg-[#F8FAF8] p-3.5">
        <div className="text-[12px] font-bold text-ink-3 mb-2">ورود به تنظیمات یک فضای کاری (نشست پشتیبانی، ۲ ساعت)</div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Select
            label="فضای کاری"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            options={[
              { value: '', label: orgs.loading ? 'در حال خواندن فهرست…' : 'انتخاب کنید' },
              ...(orgs.data?.items || []).map((o) => ({ value: o.id, label: o.name })),
            ]}
          />
          <Select
            label="بخشی که باید پر شود"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            options={[
              { value: '/app/settings/integrations', label: 'ایمیل، پیامک، چت، SSO و حساب گوگل' },
              { value: '/app/settings/developer', label: 'کلید API و وب‌هوک توسعه‌دهنده' },
            ]}
          />
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Button size="sm" onClick={() => void openWorkspace()} loading={opening} disabled={!orgId}>
            ورود و باز کردن همان صفحه
          </Button>
          {orgs.error && <span className="text-[11.5px] text-low-ink">{orgs.error}</span>}
        </div>
      </div>
    </Card>
  );
}

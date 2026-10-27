import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe2,
  Hourglass,
  KeyRound,
  Stethoscope,
  PlugZap,
  Save,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, ErrorState, Skeleton, TextInput, toast } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { faDate } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { ConnectionsHealth, ConnectionsPayload } from '../../types/admin';
import { AdminHeader } from './shared';

function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`${what} کپی شد.`, 'success'),
    () => toast('کپی نشد؛ دستی انتخاب کنید.', 'error')
  );
}

function StateChip({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Chip tone={ok ? 'brand' : 'neutral'}>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
      {label}
    </Chip>
  );
}

/** «جست‌وجوی متخصص در LinkedIn» — the provider endpoint every workspace searches with. */
function SourcingCard({ data, setData }: { data: ConnectionsPayload; setData: (d: ConnectionsPayload) => void }) {
  const c = data.sourcing;
  const [kind, setKind] = useState<'contract' | 'apify'>(c.kind);
  const [endpointUrl, setEndpointUrl] = useState(c.source === 'admin' ? c.endpointUrl : '');
  const [actorId, setActorId] = useState(c.actorId);
  const [token, setToken] = useState('');
  const [providerLabel, setProviderLabel] = useState(c.providerLabel === 'LinkedIn' ? '' : c.providerLabel);
  const [dailyLimit, setDailyLimit] = useState(String(c.dailyLimit ?? 20));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    setKind(c.kind);
    setEndpointUrl(c.source === 'admin' ? c.endpointUrl : '');
    setActorId(c.actorId);
    setProviderLabel(c.providerLabel === 'LinkedIn' ? '' : c.providerLabel);
    setDailyLimit(String(c.dailyLimit ?? 20));
  }, [c.source, c.endpointUrl, c.kind, c.actorId, c.providerLabel, c.dailyLimit]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await adminApi.saveSourcingConnection({
        kind,
        endpointUrl: endpointUrl.trim() || undefined,
        actorId: actorId.trim() || undefined,
        token: token.trim() || undefined,
        providerLabel,
        dailyLimit: Number(dailyLimit) || 0,
      });
      setData(next);
      setToken('');
      toast(kind === 'apify' ? 'توکن اپافی ذخیره شد؛ جست‌وجوها از همین Actor انجام می‌شود.' : 'سرویس جست‌وجو ذخیره شد و پاسخ داد.', 'success');
    } catch (err: any) {
      setError({ message: err?.message || 'ذخیره نشد.', field: err?.field });
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const { result, connections } = await adminApi.testSourcingConnection();
      setData(connections);
      toast(
        result.ok
          ? result.detail || `سرویس پاسخ داد (${result.count ?? 0} نتیجه در آزمایش).`
          : result.error || 'آزمایش ناموفق بود.',
        result.ok ? 'success' : 'error'
      );
    } catch (err: any) {
      toast(err?.message || 'آزمایش انجام نشد.', 'error');
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    try {
      setData(await adminApi.removeSourcingConnection());
      setConfirmOff(false);
      toast('تنظیمات سرویس جست‌وجو پاک شد؛ تا ثبت دوباره، جست‌وجو انجام نمی‌شود.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک نشد.', 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Users}
        title="جست‌وجوی متخصص در LinkedIn"
        subtitle="یک‌بار برای کل سامانه: سرویس دارای مجوز (Talent Solutions یا سرویس دادهٔ همکار) یا یک Actor آمادهٔ Apify."
        action={<StateChip ok={c.configured} label={c.configured ? (c.fromEnv ? 'از متغیرهای محیطی' : 'فعال') : 'تنظیم نشده'} />}
      />

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="نوع سرویس جست‌وجو">
          {(
            [
              { id: 'contract', label: 'سرویس دارای مجوز / درگاه خودمان' },
              { id: 'apify', label: 'Apify (HarvestAPI)' },
            ] as const
          ).map((k) => (
            <Button key={k.id} size="sm" variant={kind === k.id ? 'primary' : 'secondary'} onClick={() => setKind(k.id)} aria-pressed={kind === k.id}>
              {k.label}
            </Button>
          ))}
        </div>

        {kind === 'contract' ? (
          <Callout tone="info" icon={ShieldCheck}>
            هویدا خودش داده‌ای از لینکدین نمی‌خواند. این آدرس باید سرویسی باشد که مجوز جست‌وجوی افراد و وضعیت
            «آمادهٔ همکاری» را به سازمان شما داده است. راهنمای قرارداد داده و نمونهٔ سرویس ساختگی:{' '}
            <span dir="ltr" className="font-mono text-[12px]">
              {data.docs.sourcing}
            </span>
          </Callout>
        ) : (
          <Callout tone="warning" icon={AlertTriangle} title="دربارهٔ Actor آمادهٔ Apify">
            این مسیر از یک Actor آمادهٔ شخص ثالث (مثلاً <span dir="ltr" className="font-mono text-[12px]">harvestapi/linkedin-profile-search</span>)
            استفاده می‌کند که داده را از صفحات عمومی لینکدین جمع می‌کند؛ هزینه‌اش با حساب Apify شماست و مسئولیت
            حقوقی/انطباق (از جمله GDPR برای کارجویان اروپا) با سازمان شماست. فیلتر «آمادهٔ همکاری» در ورودی این
            Actor وجود ندارد؛ هویدا پروفایل‌های کامل را می‌گیرد و فقط کسانی را نگه می‌دارد که خود سرویس
            <span className="font-semibold"> openToWork = true </span>
            گزارش کرده باشد.
          </Callout>
        )}

        {c.source === 'env' && (
          <Callout tone="warning" icon={AlertTriangle}>
            مقدار فعلی از متغیرهای محیطی سرور می‌آید ({c.endpointHost}). اگر همین‌جا ذخیره کنید، مقدار پنل جای آن را می‌گیرد؛
            برای پاک کردن کامل باید متغیرها را هم از سرور بردارید.
          </Callout>
        )}

        {kind === 'contract' ? (
          <TextInput
            label="آدرس سرویس (POST)"
            dir="ltr"
            placeholder="https://api.provider.example/v1/people/search"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            error={error?.field === 'endpointUrl' ? error.message : undefined}
            hint="همان آدرسی که درخواست جست‌وجو به آن فرستاده می‌شود. با http:// یا https:// شروع شود."
          />
        ) : (
          <TextInput
            label="شناسهٔ Actor"
            dir="ltr"
            placeholder="harvestapi/linkedin-profile-search"
            value={actorId}
            onChange={(e) => setActorId(e.target.value)}
            error={error?.field === 'actorId' ? error.message : undefined}
            hint="به شکل user/actor یا user~actor. پیش‌فرض همین Actor جست‌وجوی پروفایل HarvestAPI است."
          />
        )}
        <TextInput
          label={kind === 'apify' ? 'توکن Apify' : 'توکن دسترسی (Bearer)'}
          dir="ltr"
          type="password"
          autoComplete="off"
          placeholder={c.tokenHint ? `ذخیره‌شده: ${c.tokenHint} — برای تغییر، مقدار تازه بگذارید` : kind === 'apify' ? 'apify_api_…' : 'توکن سرویس'}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          error={error?.field === 'token' ? error.message : undefined}
          hint={
            kind === 'apify'
              ? 'از Apify Console › Settings › API & Integrations. ذخیره‌شده رمزنگاری می‌شود و دوباره نمایش داده نمی‌شود. آزمایش، فقط توکن را می‌سنجد و هزینه‌ای ندارد.'
              : 'رمزنگاری‌شده ذخیره می‌شود و دیگر نمایش داده نمی‌شود؛ برای تعویض، توکن جدید را وارد کنید.'
          }
        />
        <TextInput
          label="نام نمایشی سرویس (اختیاری)"
          placeholder="LinkedIn Talent API"
          value={providerLabel}
          onChange={(e) => setProviderLabel(e.target.value)}
          hint="در صفحهٔ «جذب و منبع‌یابی» به کاربر نشان داده می‌شود."
        />
        <TextInput
          label="سقف جست‌وجوی روزانه"
          type="number"
          inputMode="numeric"
          min={0}
          max={500}
          value={dailyLimit}
          onChange={(e) => setDailyLimit(e.target.value)}
          error={error?.field === 'dailyLimit' ? error.message : undefined}
          hint="عدد یعنی حداکثر جست‌وجوی پرداختی در شبانه‌روز (همهٔ فضاهای کاری با هم). صفر = بی‌سقف. پیش‌فرض ۲۰ است تا هزینهٔ ناخواسته پیش نیاید."
        />

        {c.lastTestAtISO && (
          <div className="text-[12.5px] text-ink-3 flex items-center gap-2">
            {c.lastTestOk ? <CheckCircle2 className="w-4 h-4 text-brand" /> : <AlertTriangle className="w-4 h-4 text-review" />}
            آخرین آزمایش: {faDate(c.lastTestAtISO)} — {c.lastTestOk ? 'سرویس پاسخ داد' : c.lastError || 'ناموفق'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={save}
            loading={saving}
            disabled={(kind === 'contract' && !endpointUrl.trim()) || (!token.trim() && !(c.configured && c.kind === kind))}
            icon={Save}
          >
            آزمایش و ذخیره
          </Button>
          <Button variant="secondary" onClick={test} loading={testing} disabled={!c.configured} icon={PlugZap}>
            آزمایش اتصال
          </Button>
          {c.source === 'admin' && (
            <Button variant="ghost" onClick={() => setConfirmOff(true)} icon={Trash2}>
              حذف تنظیمات
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={remove}
        title="حذف تنظیمات سرویس جست‌وجو"
        description="تا زمانی که دوباره ثبت نشود، دکمهٔ جست‌وجو در «جذب و منبع‌یابی» غیرفعال می‌ماند. جست‌وجوها و کاندیداهای قبلی دست‌نخورده می‌مانند."
        confirmLabel="حذف کن"
        tone="danger"
      />
    </Card>
  );
}

/** «Google Calendar» — the OAuth client; each workspace then connects its own account. */
function GoogleCard({ data, setData }: { data: ConnectionsPayload; setData: (d: ConnectionsPayload) => void }) {
  const g = data.google;
  const [clientId, setClientId] = useState(g.source === 'admin' ? g.clientId : '');
  const [clientSecret, setClientSecret] = useState('');
  const [calendarId, setCalendarId] = useState(g.calendarId);
  const [redirectUri, setRedirectUri] = useState(g.redirectUri);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  useEffect(() => {
    setClientId(g.source === 'admin' ? g.clientId : '');
    setCalendarId(g.calendarId);
    setRedirectUri(g.redirectUri);
  }, [g.source, g.clientId, g.calendarId, g.redirectUri]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const { connections, check } = await adminApi.saveGoogleConnection({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        calendarId: calendarId.trim() || 'primary',
        redirectUri: redirectUri.trim(),
      });
      setData(connections);
      setClientSecret('');
      if (check.ok === true) toast('گوگل کلید را تأیید کرد؛ حالا هر فضای کاری می‌تواند حسابش را وصل کند.', 'success');
      else if (check.ok === false) toast(check.error || 'گوگل کلید را نپذیرفت.', 'error');
      else toast(check.error || 'ذخیره شد؛ بررسی آنلاین ممکن نشد.', 'info');
    } catch (err: any) {
      setError({ message: err?.message || 'ذخیره نشد.', field: err?.field });
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      setData(await adminApi.removeGoogleConnection());
      setConfirmOff(false);
      toast('کلید OAuth حذف شد؛ اتصال‌های موجود هر فضای کاری هم دیگر کار نمی‌کنند.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک نشد.', 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Globe2}
        title="Google Calendar"
        subtitle="کلید OAuth این نصب. سپس هر فضای کاری از «تنظیمات ← اتصال‌ها» حساب گوگل خودش را وصل می‌کند."
        action={<StateChip ok={g.configured} label={g.configured ? (g.fromEnv ? 'از متغیرهای محیطی' : 'فعال') : 'تنظیم نشده'} />}
      />

      <div className="space-y-4">
        <Callout tone="info" icon={ShieldCheck}>
          در Google Cloud یک «OAuth client ID» از نوع Web application بسازید، این آدرس بازگشت را در Authorized redirect URIs
          ثبت کنید و دسترسی Calendar API را فعال کنید. راهنمای گام‌به‌گام:{' '}
          <span dir="ltr" className="font-mono text-[12px]">
            {data.docs.google}
          </span>
        </Callout>

        {g.source === 'env' && (
          <Callout tone="warning" icon={AlertTriangle}>
            مقدار فعلی از متغیرهای محیطی سرور می‌آید. ذخیره در این صفحه جای آن را می‌گیرد.
          </Callout>
        )}

        <div className="rounded-xl border border-line bg-[#F8FAF8] p-3.5">
          <div className="text-[12px] font-bold text-ink-3 mb-1">آدرسی که باید در Google Cloud ثبت شود</div>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="text-[12.5px] text-ink flex-1 break-all">
              {g.effectiveRedirectUri}
            </code>
            <Button size="sm" variant="ghost" onClick={() => copy(g.effectiveRedirectUri, 'آدرس بازگشت')} icon={Copy}>
              کپی
            </Button>
          </div>
        </div>

        <TextInput
          label="Client ID"
          dir="ltr"
          placeholder="1234567890-abc123.apps.googleusercontent.com"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          error={error?.field === 'clientId' ? error.message : undefined}
        />
        <TextInput
          label="Client Secret"
          dir="ltr"
          type="password"
          autoComplete="off"
          placeholder={g.hasSecret ? `ذخیره‌شده: ${g.secretHint || '••••'} — برای تغییر، مقدار تازه بگذارید` : 'Client secret'}
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          error={error?.field === 'clientSecret' ? error.message : undefined}
          hint="رمزنگاری‌شده ذخیره می‌شود و دوباره نمایش داده نمی‌شود."
        />
        <TextInput
          label="شناسهٔ تقویم (اختیاری)"
          dir="ltr"
          placeholder="primary"
          value={calendarId}
          onChange={(e) => setCalendarId(e.target.value)}
          hint="پیش‌فرض primary یعنی تقویم اصلی همان حسابی که وصل می‌شود. برای تقویم مشترک سازمان، شناسهٔ آن را بگذارید."
        />
        <TextInput
          label="آدرس بازگشت دستی (اختیاری)"
          dir="ltr"
          placeholder={g.effectiveRedirectUri}
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          hint="فقط اگر دامنهٔ عمومی با آدرسی که مرورگر می‌بیند یکی نیست (مثلاً پروکسی). خالی بگذارید تا خودکار ساخته شود."
        />

        <div className="text-[12.5px] text-ink-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>دسترسی‌های درخواستی:</span>
          <span dir="ltr" className="font-mono text-[11.5px]">
            {g.scopes.join(' · ')}
          </span>
        </div>

        {g.lastTestAtISO && (
          <div className="text-[12.5px] text-ink-3 flex items-center gap-2">
            {g.lastTestOk === true ? (
              <CheckCircle2 className="w-4 h-4 text-brand" />
            ) : g.lastTestOk === false ? (
              <AlertTriangle className="w-4 h-4 text-review" />
            ) : (
              <Hourglass className="w-4 h-4 text-ink-3" />
            )}
            آخرین بررسی: {faDate(g.lastTestAtISO)} —{' '}
            {g.lastTestOk === true ? 'گوگل کلید را تأیید کرد' : g.lastTestOk === false ? g.lastError || 'کلید رد شد' : g.lastError || 'بدون بررسی آنلاین'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={save}
            loading={saving}
            disabled={!clientId.trim() || (!clientSecret.trim() && !g.configured)}
            icon={Save}
          >
            ذخیره و بررسی با گوگل
          </Button>
          {g.source === 'admin' && (
            <Button variant="ghost" onClick={() => setConfirmOff(true)} icon={Trash2}>
              حذف کلید
            </Button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={remove}
        title="حذف کلید OAuth گوگل"
        description="اتصال تقویم هر فضای کاری از کار می‌افتد و مصاحبه‌ها فقط به‌صورت فایل ICS ذخیره می‌شوند. رویدادهای ساخته‌شده در گوگل پاک نمی‌شوند."
        confirmLabel="حذف کن"
        tone="danger"
      />
    </Card>
  );
}

/**
 * «همه را بررسی کن» — four honest rows: green only when the provider really
 * answered; «بررسی نشد» when the check itself was impossible.
 */
function HealthPanel({ health, loading, onRun }: { health: ConnectionsHealth | null; loading: boolean; onRun: () => void }) {
  return (
    <Card>
      <CardHeader
        icon={Stethoscope}
        title="بررسی سلامت اتصال‌ها"
        subtitle="یک دکمه، همهٔ اتصال‌ها: هر بررسی فقط‌خواندنی است و اپافی برای بررسی توکن هزینه‌ای نمی‌گیرد."
        action={
          <Button size="sm" variant="secondary" onClick={onRun} loading={loading} icon={Stethoscope}>
            همه را بررسی کن
          </Button>
        }
      />
      {!health ? (
        <p className="text-[12.5px] text-ink-3">
          هنوز بررسی‌ای اجرا نشده است؛ دکمهٔ «همه را بررسی کن» وضعیت سرویس جست‌وجو، کلید گوگل، صندوق ایمیل و
          تقویم فضای کاری‌ها را یک‌جا نشان می‌دهد.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {health.checks.map((c) => (
            <div key={c.key} className="rounded-[10px] border border-line-2 bg-canvas p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-ink">{c.title}</span>
                {c.ok === true ? (
                  <Chip tone="brand">
                    <CheckCircle2 className="w-3.5 h-3.5" /> سالم
                  </Chip>
                ) : c.ok === false ? (
                  <Chip tone="danger">
                    <AlertTriangle className="w-3.5 h-3.5" /> خطا
                  </Chip>
                ) : (
                  <Chip tone="warning">
                    <Hourglass className="w-3.5 h-3.5" /> {c.configured ? 'بررسی نشد' : 'تنظیم نشده'}
                  </Chip>
                )}
                {c.detail && <span className="text-[11.5px] text-ink-4">{c.detail}</span>}
              </div>
              <p className="text-[12.5px] text-ink-2 mt-1 leading-relaxed">{c.message}</p>
            </div>
          ))}
          <p className="text-[11.5px] text-ink-4">زمان بررسی: {faDate(health.atISO)}</p>
        </div>
      )}
    </Card>
  );
}

export default function ConnectionsPage() {
  const { data, error, reload, setData } = useAsync(() => adminApi.connections(), []);
  const [health, setHealth] = useState<ConnectionsHealth | null>(null);
  const [healthBusy, setHealthBusy] = useState(false);

  const runHealth = async () => {
    setHealthBusy(true);
    try {
      const result = await adminApi.connectionsHealth();
      setHealth(result);
      const bad = result.checks.filter((c) => c.ok === false).length;
      toast(bad ? `${bad} اتصال مشکل دارد؛ جزئیات را در همان کارت ببینید.` : 'بررسی انجام شد؛ جزئیات در کارت «بررسی سلامت» است.', bad ? 'error' : 'success');
    } catch (err: any) {
      toast(err?.message || 'بررسی اتصال‌ها ممکن نشد.', 'error');
    } finally {
      setHealthBusy(false);
    }
  };

  if (error && !data) {
    return (
      <div>
        <AdminHeader title="اتصال‌ها" />
        <div className="hv-card">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </div>
    );
  }
  if (!data) return <Skeleton className="h-[520px] rounded-card" />;

  return (
    <div>
      <AdminHeader
        title="اتصال‌ها"
        subtitle="کلیدهایی که یک‌بار برای کل سامانه ثبت می‌شوند: سرویس جست‌وجوی LinkedIn و Google Calendar."
      />
      <div className="space-y-5">
        <HealthPanel health={health} loading={healthBusy} onRun={() => void runHealth()} />
        <Callout tone="info" icon={KeyRound}>
          دو اتصال دیگر — «ایمیل سازمان» و «حساب گوگل هر فضای کاری» — عمداً اینجا نیستند: هر فضای کاری از
          «تنظیمات ← اتصال‌ها» صندوق ایمیل و حساب تقویم خودش را وصل می‌کند. کلیدهای هوش مصنوعی هم در بخش
          «کلیدهای هوش مصنوعی» ثبت می‌شوند.
        </Callout>
        <SourcingCard data={data} setData={setData} />
        <GoogleCard data={data} setData={setData} />
        <div className="text-[12.5px] text-ink-3 flex items-center gap-1.5">
          <ExternalLink className="w-3.5 h-3.5" />
          این مقادیر رمزنگاری‌شده در پشتیبان کامل سامانه ذخیره می‌شوند و فقط با همان APP_SECRET قابل خواندن‌اند.
        </div>
      </div>
    </div>
  );
}

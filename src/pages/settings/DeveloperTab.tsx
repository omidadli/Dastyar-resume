import React, { useState } from 'react';
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Webhook,
  XCircle,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, TextInput, toast } from '../../components/ui';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { copyText } from '../../lib/clipboard';
import { faDate, faNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { ApiScope, CreatedApiKey, DeveloperOverview, WebhookEndpointPublic } from '../../types/developer';

/** «کلید API» + «وب‌هوک» — the two doors an outside system may use. */

function CopyButton({ value, label = 'کپی' }: { value: string; label?: string }) {
  return (
    <Button
      variant="ghost"
      icon={Copy}
      onClick={() => void copyText(value).then((ok) => toast(ok ? 'کپی شد.' : 'کپی ممکن نشد؛ دستی انتخاب کنید.', ok ? 'success' : 'error'))}
    >
      {label}
    </Button>
  );
}

function BaseAddressCard({ baseUrl, docsPath }: { baseUrl: string; docsPath: string }) {
  return (
    <Card>
      <CardHeader icon={Braces} title="API هویدا" subtitle="برای اتصال سامانه‌های دیگر به همین فضای کاری" action={<Chip tone="brand">نسخهٔ ۱</Chip>} />
      <div className="space-y-3">
        <div>
          <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">نشانی پایه</p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="flex-1 rounded-[10px] bg-canvas border border-line-2 px-3 py-2 text-[12.5px] font-mono truncate">
              {baseUrl}
            </code>
            <CopyButton value={baseUrl} />
          </div>
        </div>
        <div>
          <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">سرآیند احراز هویت</p>
          <code dir="ltr" className="block rounded-[10px] bg-canvas border border-line-2 px-3 py-2 text-[12.5px] font-mono">
            Authorization: Bearer hvd_sk_…
          </code>
        </div>
        <Callout tone="info">
          مسیرهای موجود: <span dir="ltr" className="font-mono text-[12px]">GET /v1/jobs</span>،{' '}
          <span dir="ltr" className="font-mono text-[12px]">GET /v1/candidates</span>،{' '}
          <span dir="ltr" className="font-mono text-[12px]">POST /v1/candidates/:id/decision</span> و{' '}
          <span dir="ltr" className="font-mono text-[12px]">GET /v1/health</span>. مستند کامل با نمونهٔ curl:{' '}
          <span dir="ltr" className="font-mono text-[12px]">{docsPath}</span>
        </Callout>
      </div>
    </Card>
  );
}

function KeysCard({ overview, onChanged }: { overview: DeveloperOverview; onChanged: () => void }) {
  const can = useCan('admin');
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>(['read']);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  const toggleScope = (id: ApiScope) =>
    setScopes((prev) => {
      if (id === 'read') return ['read'];
      return prev.includes(id) ? ['read'] : ['read', 'write'];
    });

  const create = async () => {
    setSaving(true);
    try {
      const res = await api.developer.createKey({ name: name.trim(), scopes });
      setCreated(res);
      setName('');
      setScopes(['read']);
      onChanged();
      toast('کلید ساخته شد؛ همین حالا کپی کنید.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ساخت کلید ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await api.developer.revokeKey(revoking);
      toast('کلید باطل شد؛ از این پس درخواست‌های آن رد می‌شود.', 'info');
      onChanged();
    } catch (err: any) {
      toast(err?.message || 'باطل کردن کلید ممکن نشد.', 'error');
    } finally {
      setRevoking(null);
    }
  };

  const live = overview.keys.filter((k) => !k.revokedAtISO);
  return (
    <Card>
      <CardHeader
        icon={KeyRound}
        title="کلیدهای API"
        subtitle="هر کلید فقط به همین فضای کاری دسترسی دارد"
        action={live.length ? <Chip tone="neutral">{faNumber(live.length)} کلید فعال</Chip> : <Chip tone="neutral">بدون کلید</Chip>}
      />

      {created && (
        <Callout
          tone="warning"
          icon={AlertTriangle}
          className="mb-3"
          action={<CopyButton value={created.key} label="کپی کلید" />}
        >
          این کلید فقط همین یک بار نمایش داده می‌شود (در سرور فقط هش آن ذخیره است). اگر گم شد، کلید تازه بسازید.
          <code dir="ltr" className="mt-2 block rounded-[8px] bg-surface border border-line-2 px-3 py-2 font-mono text-[12px] break-all">
            {created.key}
          </code>
        </Callout>
      )}

      <div className="space-y-3">
        {overview.keys.length === 0 && <p className="text-[13px] text-ink-3">هنوز کلیدی ساخته نشده است.</p>}
        {overview.keys.map((k) => (
          <div key={k.id} className="rounded-[12px] border border-line-2 p-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-bold text-ink truncate">
                {k.name}
                {k.revokedAtISO && (
                  <span className="ms-2">
                    <Chip tone="danger">باطل</Chip>
                  </span>
                )}
              </p>
              <p dir="ltr" className="text-[11.5px] font-mono text-ink-3 truncate">
                {k.prefix}••••••
              </p>
              <p className="text-[11.5px] text-ink-4 mt-0.5">
                {k.scopes.includes('write') ? 'خواندن و ثبت تصمیم' : 'فقط خواندن'} · ساخته‌شده {faDate(k.createdAtISO)}
                {k.lastUsedAtISO ? ` · آخرین استفاده ${faDate(k.lastUsedAtISO)}` : ' · هنوز استفاده نشده'}
                {k.calls > 0 ? `، ${faNumber(k.calls)} درخواست` : ''}
              </p>
            </div>
            {!k.revokedAtISO && (
              <Button variant="ghost" icon={Trash2} onClick={() => setRevoking(k.id)} disabled={!can}>
                باطل کردن
              </Button>
            )}
          </div>
        ))}

        <div className="rounded-[12px] bg-canvas border border-line-2 p-3 space-y-2.5">
          <TextInput
            label="کلید تازه"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً «سامانهٔ منابع انسانی»"
            disabled={!can || saving}
          />
          <div>
            <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">دسترسی</p>
            <div className="flex flex-wrap gap-1.5">
              {overview.scopes.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleScope(s.id)}
                  disabled={!can || saving}
                  title={s.hint}
                  className={`text-[12px] rounded-full border px-2.5 py-1 transition ${
                    scopes.includes(s.id) ? 'border-brand bg-brand-soft text-brand-ink font-semibold' : 'border-line text-ink-3'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-[11.5px] text-ink-4 mt-1.5">{overview.scopes.find((s) => s.id === (scopes.includes('write') ? 'write' : 'read'))?.hint}</p>
          </div>
          <Button icon={Plus} onClick={() => void create()} loading={saving} disabled={!can || saving || name.trim().length < 2}>
            ساخت کلید
          </Button>
        </div>
        {!can && <p className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند کلید بسازد یا باطل کند.</p>}
      </div>

      <ConfirmDialog
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        onConfirm={() => void revoke()}
        title="کلید باطل شود؟"
        description="هر سامانه‌ای که با این کلید کار می‌کند از این لحظه خطای احراز هویت می‌گیرد. این کار برگشت‌پذیر نیست."
        confirmLabel="باطل کردن"
      />
    </Card>
  );
}

function WebhookRow({ row, onChange }: { row: WebhookEndpointPublic; onChange: () => void }) {
  const can = useCan('admin');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);

  const test = async () => {
    setBusy(true);
    try {
      const res = await api.developer.testWebhook(row.id);
      toast(res.test.ok ? `پاسخ ${res.test.status} — دریافت شد.` : `دریافت نشد: ${res.test.error || 'بدون پاسخ'}`, res.test.ok ? 'success' : 'error');
      onChange();
    } catch (err: any) {
      toast(err?.message || 'آزمایش ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      await api.developer.updateWebhook(row.id, { active: !row.active });
      onChange();
    } catch (err: any) {
      toast(err?.message || 'تغییر وضعیت ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    try {
      await api.developer.removeWebhook(row.id);
      toast('وب‌هوک حذف شد.', 'info');
      onChange();
    } catch (err: any) {
      toast(err?.message || 'حذف ممکن نشد.', 'error');
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="rounded-[12px] border border-line-2 p-3 space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-bold text-ink truncate flex-1">{row.name}</p>
        {!row.active && <Chip tone="neutral">خاموش</Chip>}
        {row.active && row.lastOk === true && <Chip tone="brand" icon={CheckCircle2}>آخرین ارسال موفق</Chip>}
        {row.active && row.lastOk === false && <Chip tone="danger" icon={XCircle}>{faNumber(row.failures)} خطای پیاپی</Chip>}
      </div>
      <p dir="ltr" className="text-[11.5px] font-mono text-ink-3 truncate">
        {row.urlMasked}
      </p>
      <p className="text-[11.5px] text-ink-4">
        {faNumber(row.events.length)} رویداد · امضای <span dir="ltr" className="font-mono">…{row.secretHint}</span>
        {row.lastDeliveryAtISO ? ` · آخرین تلاش ${faDate(row.lastDeliveryAtISO)}` : ' · هنوز ارسالی نداشته'}
      </p>
      {row.lastError && <p className="text-[11.5px] text-low-ink leading-relaxed">{row.lastError}</p>}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="secondary" icon={Send} onClick={() => void test()} loading={busy} disabled={!can}>
          ارسال آزمایشی
        </Button>
        <Button variant="ghost" icon={RefreshCw} onClick={() => void toggle()} disabled={!can || busy}>
          {row.active ? 'خاموش کردن' : 'روشن کردن'}
        </Button>
        <Button variant="ghost" icon={Trash2} onClick={() => setRemoving(true)} disabled={!can}>
          حذف
        </Button>
      </div>
      <ConfirmDialog
        open={removing}
        onClose={() => setRemoving(false)}
        onConfirm={() => void remove()}
        title="وب‌هوک حذف شود؟"
        description="پس از حذف، هیچ رویدادی به این نشانی فرستاده نمی‌شود. تاریخچهٔ ارسال‌های آن هم پاک می‌شود."
        confirmLabel="حذف"
      />
    </div>
  );
}

function WebhooksCard({ overview, onChanged }: { overview: DeveloperOverview; onChanged: () => void }) {
  const can = useCan('admin');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(overview.events.map((e) => e.id));
  const [saving, setSaving] = useState(false);

  const toggle = (id: string) => setEvents((prev) => (prev.includes(id) ? prev.filter((e) => e !== id) : [...prev, id]));

  const add = async () => {
    if (!events.length) {
      toast('حداقل یک رویداد را انتخاب کنید.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await api.developer.addWebhook({ name: name.trim() || 'وب‌هوک', url: url.trim(), events });
      toast(
        res.test.ok ? 'وب‌هوک ثبت شد و یک رویداد آزمایشی با موفقیت دریافت شد.' : `ثبت شد، اما دریافت نشد: ${res.test.error || 'بدون پاسخ'}`,
        res.test.ok ? 'success' : 'error'
      );
      setName('');
      setUrl('');
      onChanged();
    } catch (err: any) {
      toast(err?.message || 'ثبت وب‌هوک ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Webhook}
        title="وب‌هوک خروجی"
        subtitle="هر رویداد، یک درخواست JSON امضاشده به سامانهٔ شما"
        action={<Chip tone="neutral">{faNumber(overview.webhooks.filter((w) => w.active).length)} فعال</Chip>}
      />
      <div className="space-y-3">
        {overview.webhooks.map((w) => (
          <WebhookRow key={w.id} row={w} onChange={onChanged} />
        ))}

        <div className="rounded-[12px] bg-canvas border border-line-2 p-3 space-y-2.5">
          <TextInput
            label="نام (برای خودتان)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً «سامانهٔ منابع انسانی»"
            disabled={!can || saving}
          />
          <TextInput
            label="نشانی دریافت‌کننده"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            latin
            placeholder="https://hris.example.com/hooks/hovida"
            hint="فقط https؛ برای سرور داخلی، میزبان باید در WEBHOOK_ALLOW_HOSTS باشد. نشانی رمزنگاری‌شده ذخیره می‌شود."
            disabled={!can || saving}
          />
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[12.5px] font-semibold text-ink-2">چه رویدادهایی فرستاده شود؟</p>
              <button
                type="button"
                className="text-[11.5px] text-brand-ink hover:underline"
                onClick={() => setEvents(events.length === overview.events.length ? [] : overview.events.map((e) => e.id))}
              >
                {events.length === overview.events.length ? 'هیچ‌کدام' : 'همه'}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {overview.events.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => toggle(e.id)}
                  disabled={!can || saving}
                  className={`text-[12px] rounded-full border px-2.5 py-1 transition ${
                    events.includes(e.id) ? 'border-brand bg-brand-soft text-brand-ink font-semibold' : 'border-line text-ink-3'
                  }`}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <Button icon={Plus} onClick={() => void add()} loading={saving} disabled={!can || saving || url.trim().length < 10 || events.length === 0}>
            ثبت و ارسال آزمایشی
          </Button>
        </div>

        <Callout tone="info">
          هر درخواست سرآیند <span dir="ltr" className="font-mono text-[12px]">X-Hovida-Signature: t=…,v1=…</span> دارد؛ امضا با HMAC-SHA256 روی{' '}
          <span dir="ltr" className="font-mono text-[12px]">timestamp.body</span> و کلید مخفی همین وب‌هوک ساخته می‌شود. نمونهٔ بررسی در مستند آمده است.
        </Callout>
      </div>
    </Card>
  );
}

function DeliveriesCard({ overview }: { overview: DeveloperOverview }) {
  if (!overview.deliveries.length) return null;
  return (
    <Card>
      <CardHeader icon={RefreshCw} title="آخرین ارسال‌ها" subtitle="آنچه واقعاً به سامانهٔ شما رفت" />
      <div className="space-y-1.5">
        {overview.deliveries.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[10px] border border-line-2 px-3 py-2 text-[12px]">
            <Chip tone={d.ok ? 'brand' : 'danger'}>{d.ok ? 'موفق' : 'ناموفق'}</Chip>
            <span className="font-mono text-[11.5px] text-ink-2" dir="ltr">
              {d.event}
            </span>
            <span className="text-ink-4">
              {faDate(d.atISO)}، {faNumber(d.durationMs)} م‌ث{typeof d.status === 'number' ? `، کد ${faNumber(d.status)}` : ''}
            </span>
            {d.error && <span className="text-low-ink basis-full leading-relaxed">{d.error}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function DeveloperTab() {
  const overview = useAsync(() => api.developer.overview(), []);
  const reload = () => overview.reload();
  const data = overview.data;

  if (overview.error) {
    return (
      <Callout tone="warning" icon={AlertTriangle}>
        {overview.error}
        <Button variant="ghost" icon={RefreshCw} className="ms-2" onClick={reload}>
          تلاش دوباره
        </Button>
      </Callout>
    );
  }
  if (!data) return null;

  return (
    <div className="grid xl:grid-cols-2 gap-5 max-w-[1200px] items-start">
      <div className="flex flex-col gap-5">
        <BaseAddressCard baseUrl={data.baseUrl} docsPath={data.docsPath} />
        <KeysCard overview={data} onChanged={reload} />
      </div>
      <div className="flex flex-col gap-5">
        <WebhooksCard overview={data} onChanged={reload} />
        <DeliveriesCard overview={data} />
      </div>
    </div>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Server,
  Shuffle,
  Trash2,
  Zap,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, ErrorState, Modal, Segmented, Select, Skeleton, Switch, TextInput, toast } from '../../components/ui';
import { adminApi, type KeyTestResult } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { faNumber } from '../../lib/format';
import type { AiKeyInput, AiKeyPublic, AiKeyRuntime, AiProviderKind, AiSettingsPublic, KeyStrategy } from '../../types/admin';
import { AdminHeader, HealthBadge, PURPOSE_LABEL, faAgo, faIn } from './shared';

const MODEL_HINTS: Record<AiProviderKind, string[]> = {
  gemini: ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'],
  openai: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-mini', 'gpt-4o', 'gemini-2.5-flash', 'deepseek-chat'],
};

const PROVIDER_LABEL: Record<AiProviderKind, string> = {
  gemini: 'Google Gemini',
  openai: 'سازگار با OpenAI',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface FormState {
  id: string | null;
  label: string;
  provider: AiProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  rpm: string;
  dailyLimit: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = { id: null, label: '', provider: 'gemini', apiKey: '', baseUrl: '', model: '', rpm: '', dailyLimit: '', enabled: true };

export default function AiKeys() {
  const { data, error, reload, setData } = useAsync(() => adminApi.ai(), []);
  const calls = useAsync(() => adminApi.calls(12), []);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  // Several keys can be under test at once (the one just added + a manual click).
  const [testing, setTesting] = useState<ReadonlySet<string>>(() => new Set());
  const [results, setResults] = useState<Record<string, KeyTestResult>>({});
  const [removing, setRemoving] = useState<AiKeyPublic | null>(null);
  const [, tick] = useState(0);
  const reordering = useRef(false);

  // Live health: cooldowns end and counters move while the page is open.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      adminApi.ai().then(setData).catch(() => {});
      calls.reload();
      tick((t) => t + 1);
    }, 10_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error && !data) {
    return (
      <div>
        <AdminHeader title="کلیدهای هوش مصنوعی" />
        <div className="hv-card">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </div>
    );
  }
  if (!data) return <Skeleton className="h-[420px] rounded-card" />;

  const adminKeys = data.keys.filter((k) => k.source === 'admin');
  const envKeys = data.keys.filter((k) => k.source === 'env');
  const runtimeOf = (id: string) => data.runtime.find((r) => r.id === id);
  const readyCount = data.runtime.filter((r) => r.health === 'ready').length;

  const apply = async (fn: () => Promise<AiSettingsPublic>, ok?: string) => {
    try {
      setData(await fn());
      if (ok) toast(ok);
    } catch (err: any) {
      toast(err?.message || 'ذخیره نشد.', 'error');
    }
  };

  const test = async (id: string) => {
    setTesting((s) => new Set(s).add(id));
    try {
      const { result, ai } = await adminApi.testKey(id);
      setResults((r) => ({ ...r, [id]: result }));
      setData(ai);
      calls.reload();
      toast(result.ok ? `«${result.label}» پاسخ داد (${faNumber(result.latencyMs)} میلی‌ثانیه).` : result.error || 'آزمایش ناموفق بود.', result.ok ? 'success' : 'error');
    } catch (err: any) {
      toast(err?.message || 'آزمایش انجام نشد.', 'error');
    } finally {
      setTesting((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  };

  const openForm = (k?: AiKeyPublic) => {
    setFormError(null);
    setForm(
      k
        ? { id: k.id, label: k.label, provider: k.provider, apiKey: '', baseUrl: k.baseUrl, model: k.model, rpm: k.rpm ? String(k.rpm) : '', dailyLimit: k.dailyLimit ? String(k.dailyLimit) : '', enabled: k.enabled }
        : { ...EMPTY_FORM, label: `کلید ${faNumber(adminKeys.length + 1)}` }
    );
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setFormError(null);
    const body: AiKeyInput = {
      label: form.label,
      provider: form.provider,
      baseUrl: form.baseUrl,
      model: form.model,
      enabled: form.enabled,
      rpm: Number(form.rpm) || 0,
      dailyLimit: Number(form.dailyLimit) || 0,
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    };
    try {
      const before = new Set(data.keys.map((k) => k.id));
      const next = form.id ? await adminApi.updateKey(form.id, body) : await adminApi.addKey(body);
      setData(next);
      const savedId = form.id || next.keys.find((k) => k.source === 'admin' && !before.has(k.id))?.id;
      setForm(null);
      toast(form.id ? 'کلید به‌روز شد.' : 'کلید اضافه شد؛ در حال آزمایش اتصال…');
      if (savedId && (!form.id || form.apiKey.trim())) void test(savedId);
    } catch (err: any) {
      setFormError({ message: err?.message || 'ذخیره نشد.', field: err?.field });
    } finally {
      setSaving(false);
    }
  };

  const move = (index: number, dir: -1 | 1) => {
    if (reordering.current) return; // the list on screen is about to change
    const ids = adminKeys.map((k) => k.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    reordering.current = true;
    void apply(() => adminApi.reorderKeys(ids), 'ترتیب کلیدها ذخیره شد.').finally(() => {
      reordering.current = false;
    });
  };

  return (
    <div>
      <AdminHeader
        title="کلیدهای هوش مصنوعی"
        subtitle="تا پنج کلید از Gemini یا هر سرویس سازگار با OpenAI (از جمله درگاه‌های داخلی). اگر کلیدی به محدودیت بخورد، همان درخواست بی‌درنگ با کلید بعدی ادامه پیدا می‌کند و کاربران چیزی متوجه نمی‌شوند."
        actions={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={reload}>
            به‌روزرسانی
          </Button>
        }
      />

      {data.envForcedOff && (
        <Callout tone="danger" className="mb-4" title="هوش مصنوعی روی سرور خاموش است">
          متغیر محیطی <code className="hv-latin">AI_PROVIDER=off</code> تنظیم شده است؛ تا برداشته نشود، هیچ کلیدی استفاده نمی‌شود.
        </Callout>
      )}

      <Card>
        <CardHeader title="موتور هوش مصنوعی" subtitle={data.enabled ? `${faNumber(readyCount)} کلید آماده از ${faNumber(data.runtime.length)}` : 'خاموش — همه تحلیل‌ها با موتور محلی انجام می‌شود'} icon={Zap} />
        <div className="grid lg:grid-cols-2 gap-x-8 gap-y-5 mt-4">
          <Switch
            checked={data.enabled}
            onChange={(v) => void apply(() => adminApi.updateAi({ enabled: v }), v ? 'هوش مصنوعی روشن شد.' : 'هوش مصنوعی خاموش شد.')}
            label="هوش مصنوعی روشن باشد"
            description="خاموش کردن، همه تحلیل‌ها را به «تحلیل محلی» (کلیدواژه‌ای و برچسب‌دار) می‌سپارد."
          />
          <div>
            <p className="text-sm font-semibold text-ink mb-1.5">راهبرد استفاده از کلیدها</p>
            <Segmented<KeyStrategy>
              value={data.strategy}
              onChange={(v) => void apply(() => adminApi.updateAi({ strategy: v }), 'راهبرد ذخیره شد.')}
              items={[
                { id: 'failover', label: 'اولویت‌دار (پشتیبان)' },
                { id: 'round-robin', label: 'چرخشی (پخش بار)' },
              ]}
            />
            <p className="text-xs text-ink-3 mt-1.5 leading-relaxed">
              {data.strategy === 'failover'
                ? 'همیشه کلید اول؛ کلیدهای بعدی فقط وقتی کلید جلویی محدود یا خراب است. مناسب وقتی یک کلید اصلی و چند پشتیبان دارید.'
                : 'درخواست‌ها به نوبت بین کلیدهای آماده پخش می‌شوند تا سهمیه همه با هم مصرف شود؛ جابه‌جایی خودکار هنگام خطا همچنان فعال است.'}
            </p>
          </div>
          <Select
            label="دقت در برابر خلاقیت (دما)"
            value={String(data.temperature)}
            onChange={(e) => void apply(() => adminApi.updateAi({ temperature: Number(e.target.value) }), 'ذخیره شد.')}
            options={[
              { value: '0', label: '۰ — کاملاً ثابت و تکرارپذیر' },
              { value: '0.1', label: '۰٫۱ — توصیه‌شده برای ارزیابی' },
              { value: '0.2', label: '۰٫۲' },
              { value: '0.3', label: '۰٫۳' },
              { value: '0.5', label: '۰٫۵ — آزادتر' },
            ].concat(['0', '0.1', '0.2', '0.3', '0.5'].includes(String(data.temperature)) ? [] : [{ value: String(data.temperature), label: String(data.temperature) }])}
            hint="برای غربالگری، دمای پایین نتیجه یک رزومه را در دفعات مختلف یکسان نگه می‌دارد."
          />
          <div className="grid grid-cols-2 gap-3">
            <TimeoutInput label="سقف زمان تحلیل عادی (ثانیه)" value={data.fastTimeoutSec} min={8} max={120} onSave={(v) => void apply(() => adminApi.updateAi({ fastTimeoutSec: v }), 'ذخیره شد.')} />
            <TimeoutInput label="سقف زمان بازبینی دقیق (ثانیه)" value={data.deepTimeoutSec} min={20} max={240} onSave={(v) => void apply(() => adminApi.updateAi({ deepTimeoutSec: v }), 'ذخیره شد.')} />
          </div>
        </div>
      </Card>

      <Callout tone="brand" className="mt-4" icon={Shuffle} title="جابه‌جایی خودکار چطور کار می‌کند؟">
        محدودیت نرخ (۴۲۹) ← کلید تا زمانی که خود سرویس اعلام می‌کند کنار می‌رود (پیش‌فرض ۳۰ ثانیه، رو به افزایش). اتمام سهمیه یا اعتبار ← ۱ ساعت. کلید نامعتبر ← تا اصلاح شما. خطای ۵xx، کندی یا قطعی شبکه ← همان درخواست فوراً با کلید بعدی. با «سقف درخواست در دقیقه/روز» می‌توانید پیش از رسیدن به محدودیت، جابه‌جایی را انجام دهید.
      </Callout>

      <div className="flex items-center justify-between mt-7 mb-3">
        <h2 className="text-[16px] font-extrabold text-ink">
          کلیدها <span className="text-ink-3 font-semibold text-[13px]">({faNumber(adminKeys.length)} از {faNumber(data.maxKeys)})</span>
        </h2>
        {adminKeys.length < data.maxKeys && (
          <Button size="sm" icon={Plus} onClick={() => openForm()}>
            افزودن کلید
          </Button>
        )}
      </div>

      <div className="grid gap-3">
        {adminKeys.map((k, i) => (
          <KeyCard
            key={k.id}
            k={k}
            index={i}
            total={adminKeys.length}
            runtime={runtimeOf(k.id)}
            result={results[k.id]}
            testing={testing.has(k.id)}
            onTest={() => void test(k.id)}
            onEdit={() => openForm(k)}
            onToggle={(v) => void apply(() => adminApi.updateKey(k.id, { enabled: v }), v ? 'کلید فعال شد.' : 'کلید غیرفعال شد.')}
            onReset={() => void apply(() => adminApi.resetKey(k.id), 'وضعیت کلید بازنشانی شد.')}
            onMove={(d) => move(i, d)}
            onDelete={() => setRemoving(k)}
          />
        ))}
        {Array.from({ length: Math.max(0, data.maxKeys - adminKeys.length) }).map((_, i) => (
          <button
            key={`slot-${i}`}
            onClick={() => openForm()}
            className="h-[64px] rounded-card border-2 border-dashed border-line-strong text-ink-3 hover:border-brand/50 hover:text-brand-ink hover:bg-brand-tint/40 flex items-center justify-center gap-2 text-[13.5px] font-semibold transition-colors"
          >
            <Plus className="w-4 h-4" />
            جایگاه کلید {faNumber(adminKeys.length + i + 1)} — افزودن
          </button>
        ))}
      </div>

      {envKeys.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="کلیدهای تعریف‌شده روی سرور" subtitle="از متغیرهای محیطی GEMINI_API_KEY / OPENAI_API_KEY؛ فقط‌خواندنی و بعد از کلیدهای بالا استفاده می‌شوند." icon={Server} />
          <div className="mt-3">
            <Switch checked={data.useEnvKeys} onChange={(v) => void apply(() => adminApi.updateAi({ useEnvKeys: v }), 'ذخیره شد.')} label="استفاده از کلیدهای سرور به‌عنوان پشتیبان" />
          </div>
          <ul className="mt-3 divide-y divide-line-2">
            {envKeys.map((k) => {
              const rt = runtimeOf(k.id);
              return (
                <li key={k.id} className="py-3 flex flex-wrap items-center gap-3">
                  <span className="font-bold text-ink-2 text-[13px]">{k.label}</span>
                  <Chip tone="outline">{PROVIDER_LABEL[k.provider]}</Chip>
                  <span className="hv-latin text-[12px] text-ink-3" dir="ltr">
                    {k.keyHint}
                  </span>
                  {rt && <HealthBadge health={data.useEnvKeys ? rt.health : 'disabled'} />}
                  <div className="flex-1" />
                  <Button size="sm" variant="secondary" icon={Zap} loading={testing.has(k.id)} onClick={() => void test(k.id)}>
                    آزمایش
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader title="آخرین درخواست‌ها به هوش مصنوعی" subtitle="جابه‌جایی‌های خودکار با «←» نشان داده می‌شوند؛ گزارش کامل در «گزارش رویدادها»." icon={KeyRound} />
        {calls.data?.items.length ? (
          <ul className="mt-3 divide-y divide-line-2 text-[12.5px]">
            {calls.data.items.map((c) => (
              <li key={c.id} className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`w-2 h-2 rounded-full ${c.ok ? 'bg-high' : 'bg-low'}`} />
                <span className="text-ink-3 w-[88px] shrink-0">{faAgo(c.at)}</span>
                <span className="font-semibold text-ink-2">{PURPOSE_LABEL[c.purpose]}</span>
                <span className="text-ink-3">
                  {c.switchedFrom ? `${c.switchedFrom} ← ` : ''}
                  <b className="text-ink-2">{c.keyLabel}</b>
                </span>
                <span className="text-ink-4 hv-num">{faNumber(c.latencyMs)} میلی‌ثانیه</span>
                {!c.ok && <span className="text-low-ink basis-full sm:basis-auto truncate">{c.error}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-3 mt-3">هنوز درخواستی ثبت نشده است.</p>
        )}
      </Card>

      <Modal
        open={Boolean(form)}
        onClose={() => setForm(null)}
        title={form?.id ? 'ویرایش کلید' : 'افزودن کلید هوش مصنوعی'}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setForm(null)}>
              انصراف
            </Button>
            <Button onClick={() => void save()} loading={saving} icon={CheckCircle2}>
              {form?.id ? 'ذخیره' : 'افزودن و آزمایش'}
            </Button>
          </>
        }
      >
        {form && (
          <div className="flex flex-col gap-4">
            {formError && !formError.field && <Callout tone="danger">{formError.message}</Callout>}
            <div className="grid sm:grid-cols-2 gap-4">
              <Select
                label="سرویس"
                value={form.provider}
                onChange={(e) => setForm({ ...form, provider: e.target.value as AiProviderKind })}
                options={[
                  { value: 'gemini', label: 'Google Gemini' },
                  { value: 'openai', label: 'سازگار با OpenAI (درگاه‌ها، OpenRouter…)' },
                ]}
              />
              <TextInput label="نام نمایشی" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="مثلاً: کلید اصلی" />
            </div>
            {/* type="password" brings TextInput's own show/hide toggle (a second one used to sit on top of it). */}
            <TextInput
              label="کلید API"
              latin
              type="password"
              // "off" is ignored for password fields: the browser would offer the admin's saved login password here.
              autoComplete="new-password"
              spellCheck={false}
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={form.id ? 'برای تغییر، کلید تازه را وارد کنید' : form.provider === 'gemini' ? 'AIza…' : 'sk-…'}
              error={formError?.field === 'apiKey' ? formError.message : null}
              hint="کلید رمزنگاری‌شده ذخیره می‌شود و دیگر به‌طور کامل نمایش داده نمی‌شود."
            />
            <TextInput
              label={form.provider === 'gemini' ? 'آدرس پراکسی/درگاه Gemini' : 'آدرس سرویس (Base URL)'}
              optional={form.provider === 'gemini'}
              latin
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={form.provider === 'gemini' ? 'خالی = generativelanguage.googleapis.com' : 'https://api.example.com/v1'}
              error={formError?.field === 'baseUrl' ? formError.message : null}
              hint={
                form.provider === 'gemini'
                  ? 'اگر سرور شما به Google دسترسی ندارد (یا خطای «منطقه پشتیبانی نمی‌شود» می‌گیرید)، آدرس یک پراکسی سازگار با Gemini را وارد کنید.'
                  : 'آدرس پایه سرویس؛ خالی = api.openai.com/v1. اگر آدرس کامل …/chat/completions را بچسبانید، خودکار اصلاح می‌شود.'
              }
            />
            <div>
              <TextInput
                label="مدل"
                optional
                latin
                list={`models-${form.provider}`}
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder={MODEL_HINTS[form.provider][0]}
                hint={form.provider === 'gemini' ? 'خالی = مدل پیش‌فرض همراه با مدل‌های جایگزین خودکار.' : 'نام دقیق مدل در همان سرویس.'}
              />
              <datalist id={`models-${form.provider}`}>
                {MODEL_HINTS[form.provider].map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <TextInput label="سقف درخواست در دقیقه" optional type="number" min={0} value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} placeholder="بدون سقف" hint="مثلاً ۱۵ برای کلید رایگان Gemini" />
              <TextInput label="سقف درخواست در روز" optional type="number" min={0} value={form.dailyLimit} onChange={(e) => setForm({ ...form, dailyLimit: e.target.value })} placeholder="بدون سقف" />
            </div>
            <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="کلید فعال باشد" />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title={removing ? `حذف «${removing.label}»` : ''}
        description="کلید از سامانه پاک می‌شود. درخواست‌های بعدی با کلیدهای دیگر انجام می‌شوند."
        confirmLabel="حذف کلید"
        onConfirm={() => {
          if (!removing) return;
          const id = removing.id;
          setRemoving(null);
          void apply(() => adminApi.deleteKey(id), 'کلید حذف شد.');
        }}
      />
    </div>
  );
}

/** The provider's own message, without the Persian reason already shown above it. */
function technicalDetail(lastError: string): string {
  const i = lastError.indexOf(' — ');
  return (i >= 0 ? lastError.slice(i + 3) : lastError).slice(0, 160);
}

function TimeoutInput({ label, value, min, max, onSave }: { label: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(v));
    // An emptied field reverts — Number('') is 0, which would silently save the minimum.
    if (!v.trim() || !Number.isFinite(n)) return setV(String(value));
    const clamped = Math.max(min, Math.min(max, n));
    setV(String(clamped));
    if (clamped !== value) onSave(clamped);
  };
  return <TextInput label={label} type="number" min={min} max={max} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}

function KeyCard({
  k,
  index,
  total,
  runtime,
  result,
  testing,
  onTest,
  onEdit,
  onToggle,
  onReset,
  onMove,
  onDelete,
}: {
  k: AiKeyPublic & { unreadable?: boolean };
  index: number;
  total: number;
  runtime?: AiKeyRuntime;
  result?: KeyTestResult;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: (v: boolean) => void;
  onReset: () => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: () => void;
}) {
  const health = k.enabled ? runtime?.health || 'ready' : 'disabled';
  const successRate = runtime && runtime.calls ? Math.round((runtime.successes / runtime.calls) * 100) : null;
  return (
    <div className={`hv-card p-4 ${health === 'invalid' ? 'ring-1 ring-low/40' : health === 'cooling' || health === 'limited' ? 'ring-1 ring-review/40' : ''}`}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <button onClick={() => onMove(-1)} disabled={index === 0} aria-label="بالاتر" className="w-6 h-6 rounded-md flex items-center justify-center text-ink-4 hover:text-ink hover:bg-line-2 disabled:opacity-30">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <span className="w-8 h-8 rounded-[10px] bg-[#252C28] text-white text-[13px] font-extrabold flex items-center justify-center hv-num" title="اولویت">
            {faNumber(index + 1)}
          </span>
          <button onClick={() => onMove(1)} disabled={index === total - 1} aria-label="پایین‌تر" className="w-6 h-6 rounded-md flex items-center justify-center text-ink-4 hover:text-ink hover:bg-line-2 disabled:opacity-30">
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 min-w-[220px]">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[15px] font-extrabold text-ink">{k.label}</p>
            <HealthBadge health={health} />
            <Chip tone="outline">{PROVIDER_LABEL[k.provider]}</Chip>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[12px] text-ink-3">
            <span className="hv-latin" dir="ltr">
              {k.keyHint}
            </span>
            <span>
              مدل: <span className="hv-latin text-ink-2">{k.model || 'پیش‌فرض'}</span>
            </span>
            {k.baseUrl && (
              <span>
                سرویس: <span className="hv-latin text-ink-2">{hostOf(k.baseUrl)}</span>
              </span>
            )}
            {(k.rpm > 0 || k.dailyLimit > 0) && (
              <span>
                سقف: {k.rpm > 0 ? `${faNumber(k.rpm)}/دقیقه` : ''}
                {k.rpm > 0 && k.dailyLimit > 0 ? '، ' : ''}
                {k.dailyLimit > 0 ? `${faNumber(k.dailyLimit)}/روز` : ''}
              </span>
            )}
          </div>
          {k.unreadable && (
            <Callout tone="danger" className="mt-3">
              این کلید با کلید رمزنگاری فعلی سرور (APP_SECRET) خوانده نمی‌شود؛ آن را ویرایش و دوباره وارد کنید.
            </Callout>
          )}
          {runtime && (health === 'cooling' || health === 'limited') && (
            <p className="mt-2 text-[12.5px] text-review-ink flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5" />
              {runtime.cooldownReason || 'موقتاً کنار گذاشته شده'}
              {runtime.cooldownUntil ? ` — بازگشت خودکار ${faIn(runtime.cooldownUntil)}` : ''}
            </p>
          )}
          {runtime?.lastError && health !== 'ready' && (
            <p className="mt-1.5 text-[11.5px] text-ink-3 leading-relaxed">
              جزئیات فنی:{' '}
              <span dir="ltr" className="hv-latin inline-block max-w-full truncate align-bottom">
                {technicalDetail(runtime.lastError)}
              </span>
            </p>
          )}
          {result && (
            <p className={`mt-2 text-[12.5px] font-semibold ${result.ok ? 'text-high-ink' : 'text-low-ink'}`}>
              آزمایش: {result.ok ? `موفق — ${faNumber(result.latencyMs)} میلی‌ثانیه (${result.model})` : result.error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={k.enabled} onChange={onToggle} ariaLabel={`فعال بودن کلید «${k.label}»`} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-3 pt-3 border-t border-line-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
          <span>
            امروز: <b className="text-ink-2 hv-num">{faNumber(runtime?.todayCalls ?? 0)}</b>
          </span>
          <span>
            کل: <b className="text-ink-2 hv-num">{faNumber(runtime?.calls ?? 0)}</b>
          </span>
          <span>
            موفقیت: <b className="text-ink-2 hv-num">{successRate === null ? '—' : `${faNumber(successRate)}٪`}</b>
          </span>
          <span>
            محدودیت‌ها: <b className="text-ink-2 hv-num">{faNumber(runtime?.rateLimits ?? 0)}</b>
          </span>
          <span>
            آخرین استفاده: <b className="text-ink-2">{runtime?.lastUsedAt ? faAgo(runtime.lastUsedAt) : '—'}</b>
          </span>
          {runtime?.lastLatencyMs ? (
            <span>
              سرعت: <b className="text-ink-2 hv-num">{faNumber(runtime.lastLatencyMs)} میلی‌ثانیه</b>
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" icon={Zap} loading={testing} onClick={onTest}>
            آزمایش
          </Button>
          {(health === 'cooling' || health === 'invalid' || health === 'limited') && (
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onReset}>
              بازنشانی
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={Pencil} onClick={onEdit}>
            ویرایش
          </Button>
          <Button size="sm" variant="danger-soft" icon={Trash2} onClick={onDelete}>
            حذف
          </Button>
        </div>
      </div>
    </div>
  );
}

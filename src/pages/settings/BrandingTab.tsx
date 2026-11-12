/**
 * «هویت سازمانی» — the editor.
 *
 * Left: every knob, grouped the way an HR person thinks about them (identity,
 * colours, layout, words, login, public page). Right: a live miniature of the
 * panel that repaints as you type — the same tokens the real panel uses, so
 * what you see here is what the team will see.
 *
 * Two promises to the person using it:
 *   • nothing is saved until «ذخیره» — you can experiment on a preset and leave;
 *   • the warnings are *ours*, in plain Persian: when a chosen colour would make
 *     a button unreadable we adjust the shade and say so, we never ship a panel
 *     someone cannot read.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Image as ImageIcon, LayoutTemplate, Mail, Palette, RotateCcw, Save, Sparkles, TriangleAlert, Type } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Field, Segmented, Select, Switch, TextArea, TextInput, toast } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { api, ApiError } from '../../lib/api';
import { brandTokens, contrast, isHex } from '../../lib/brand';
import { useBranding } from '../../components/brand/BrandingProvider';
import {
  BRAND_PRESETS,
  FONT_LABEL,
  LANDING_KEYS,
  LOGIN_BG_LABEL,
  NAV_KEYS,
  RADIUS_LABEL,
  SIDEBAR_LABEL,
  THEME_LABEL,
  type OrgBranding,
} from '../../types/branding';

const NAV_LABEL: Record<string, string> = {
  dashboard: 'داشبورد',
  approvals: 'کارتابل تأیید',
  jobs: 'فرصت‌های شغلی',
  candidates: 'رزومه‌ها',
  sourcing: 'جست‌وجوی استعداد',
  automation: 'اتوماسیون جذب',
  video: 'مصاحبهٔ ویدئویی',
  onboarding: 'تحویل پس از استخدام',
  payroll: 'حقوق و دستمزد',
  talent: 'بانک استعداد',
  reports: 'گزارش‌ها',
  settings: 'تنظیمات',
};

const LANDING_LABEL: Record<string, string> = {
  dashboard: 'داشبورد',
  approvals: 'کارتابل تأیید',
  jobs: 'فرصت‌های شغلی',
  candidates: 'رزومه‌ها',
  reports: 'گزارش‌ها',
  talent: 'بانک استعداد',
  sourcing: 'جست‌وجوی استعداد',
};

const MAX_LOGO = 380 * 1024;

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_LOGO) return reject(new Error('حجم فایل بیش از ۳۸۰ کیلوبایت است؛ نسخهٔ کوچک‌تر را بگذارید.'));
    if (!/^image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(file.type)) {
      return reject(new Error('فقط PNG، JPG، WebP، SVG یا ICO مجاز است.'));
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('خواندن فایل ممکن نشد.'));
    reader.readAsDataURL(file);
  });
}

function ColorField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = isHex(draft);
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`انتخاب رنگ ${label}`}
          value={isHex(value) ? value : '#2DBA4E'}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="w-11 h-11 rounded-control border border-line cursor-pointer bg-surface p-1"
        />
        <TextInput
          latin
          value={draft}
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            if (isHex(v)) onChange(v.toUpperCase());
          }}
          error={!valid ? 'کد رنگ باید مثل #2DBA4E باشد.' : undefined}
          aria-label={`کد رنگ ${label}`}
          placeholder="#2DBA4E"
        />
      </div>
    </Field>
  );
}

function ImageField({
  label,
  value,
  onChange,
  hint,
  height,
  dark,
}: {
  label: string;
  value: string | null;
  onChange: (v: string | null) => void;
  hint: string;
  height?: number;
  dark?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label={label} hint={hint} error={error}>
      <div className="flex items-center gap-3 flex-wrap">
        <div
          className={`w-[120px] h-[64px] rounded-control border border-line flex items-center justify-center overflow-hidden ${dark ? 'bg-ink' : 'bg-canvas'}`}
        >
          {value ? (
            <img src={value} alt="" style={{ maxHeight: height || 44 }} className="max-w-full object-contain" />
          ) : (
            <ImageIcon className="w-5 h-5 text-ink-4" />
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => ref.current?.click()}>
            {value ? 'تغییر فایل' : 'انتخاب فایل'}
          </Button>
          {value && (
            <Button variant="ghost" size="sm" onClick={() => onChange(null)}>
              حذف
            </Button>
          )}
        </div>
        <input
          ref={ref}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
          className="sr-only"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              setError(null);
              onChange(await readImage(file));
            } catch (err: any) {
              setError(err?.message || 'بارگذاری تصویر ممکن نشد.');
            }
          }}
        />
      </div>
    </Field>
  );
}

/** The miniature panel: sidebar, header, a KPI card, a table row and buttons. */
function Preview({ branding }: { branding: OrgBranding }) {
  const { vars, warnings } = useMemo(() => brandTokens(branding), [branding]);
  const dark = branding.theme === 'dark';
  const sidebarDark = branding.sidebar === 'dark';
  const name = branding.nickname || 'فضای کاری شما';
  const shown = NAV_KEYS.filter((k) => k !== 'settings' && !branding.nav.hidden.includes(k)).slice(0, 6);
  return (
    <div className={`hv-preview-scope rounded-card border border-line overflow-hidden ${dark ? 'hv-dark' : ''}`} style={vars as React.CSSProperties}>
      <div className="flex" style={{ background: 'var(--color-canvas)', minHeight: 300 }}>
        <div className="w-[136px] shrink-0 border-l p-2.5 flex flex-col gap-1.5" style={{ background: 'var(--hv-sidebar-bg)', borderColor: 'var(--hv-sidebar-border)' }}>
          <div className="flex items-center gap-1.5 mb-2 px-1">
            {branding.markDataUrl || branding.logoDataUrl ? (
              <img src={(branding.markDataUrl || branding.logoDataUrl) as string} alt="" className="w-6 h-6 rounded-md object-contain" />
            ) : (
              <span className="w-6 h-6 rounded-md inline-flex items-center justify-center text-[11px] font-black text-white" style={{ background: 'var(--color-brand-strong)' }}>
                {name.charAt(0)}
              </span>
            )}
            <span className="text-[9.5px] font-extrabold truncate" style={{ color: 'var(--hv-sidebar-ink)' }}>
              {name}
            </span>
          </div>
          {shown.map((k, i) => (
            <span
              key={k}
              className="h-6 rounded-[6px] px-2 flex items-center text-[9px] font-semibold truncate"
              style={
                i === 0
                  ? { background: 'var(--hv-sidebar-active)', color: 'var(--hv-sidebar-ink)' }
                  : { color: 'var(--hv-sidebar-ink-2)' }
              }
            >
              {branding.nav.labels[k] || NAV_LABEL[k]}
            </span>
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <div className="h-9 px-3 flex items-center justify-between" style={{ background: 'var(--color-surface)', borderBottom: '1px solid var(--color-line)' }}>
            <span className="text-[10px] font-bold" style={{ color: 'var(--color-ink)' }}>
              {LANDING_LABEL[branding.landing] || 'داشبورد'}
            </span>
            <span className="h-5 rounded-full px-2.5 inline-flex items-center text-[8.5px] font-bold text-white" style={{ background: 'var(--color-brand-strong)' }}>
              ایجاد {branding.terms.job}
            </span>
          </div>
          <div className="p-2.5 flex flex-col gap-2">
            <div className="rounded-[var(--radius-card)] p-2.5" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)' }}>
              <p className="text-[8.5px] font-semibold" style={{ color: 'var(--color-ink-3)' }}>
                {branding.terms.candidate}های فعال
              </p>
              <p className="text-[17px] font-extrabold leading-tight" style={{ color: 'var(--color-ink)' }}>
                ۱۲۴
              </p>
              <div className="h-1.5 rounded-full mt-1.5 overflow-hidden" style={{ background: 'var(--color-brand-soft)' }}>
                <div className="h-full w-2/3 rounded-full" style={{ background: 'var(--color-brand)' }} />
              </div>
            </div>
            <div className="rounded-[var(--radius-card)] px-2.5 py-2 flex items-center justify-between" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)' }}>
              <span className="text-[8.5px] font-semibold" style={{ color: 'var(--color-ink-2)' }}>
                {branding.terms.interview} فردا · ۱۰:۳۰
              </span>
              <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: 'var(--color-brand-soft)', color: 'var(--color-brand-ink)' }}>
                تأیید شد
              </span>
            </div>
            <div className="flex gap-1.5">
              <span className="h-6 rounded-[var(--radius-control)] px-3 inline-flex items-center text-[8.5px] font-bold text-white" style={{ background: 'var(--color-brand-strong)' }}>
                ذخیره
              </span>
              <span className="h-6 rounded-[var(--radius-control)] px-3 inline-flex items-center text-[8.5px] font-bold" style={{ border: '1px solid var(--color-line-strong)', color: 'var(--color-ink-2)' }}>
                انصراف
              </span>
              <span className="h-6 rounded-[var(--radius-control)] px-2.5 inline-flex items-center text-[8.5px] font-bold" style={{ background: 'var(--color-brand-tint)', color: 'var(--color-brand-ink)' }}>
                {branding.terms.offer}
              </span>
            </div>
          </div>
        </div>
      </div>
      {warnings.length > 0 && (
        <div className="px-3 py-2 text-[10.5px] leading-relaxed" style={{ background: 'var(--color-review-soft)', color: 'var(--color-review-ink)' }}>
          {warnings[0]}
        </div>
      )}
    </div>
  );
}

/**
 * «نامهٔ سازمان» — a miniature of the e-mail, drawn with the same rules the
 * server uses (accent rule on top, logo or wordmark, body, signature, footer).
 * It is deliberately plain: an inbox is not a browser, and showing a fancier
 * preview here would promise something the mail clients cannot deliver.
 */
function MailPreview({ branding }: { branding: OrgBranding }) {
  const { vars } = useMemo(() => brandTokens(branding), [branding]);
  const name = branding.nickname || 'سازمان شما';
  const logo = branding.email.includeLogo ? branding.logoDataUrl || branding.markDataUrl : null;
  const raster = logo && /^data:image\/(png|jpeg|gif)/i.test(logo);
  return (
    <div className="rounded-card border border-line overflow-hidden bg-[#f4f5f5] p-3" dir="rtl">
      <div className="mx-auto max-w-[420px] rounded-[10px] overflow-hidden bg-white border border-[#e4e7e5]">
        <div className="h-1" style={{ background: vars['--color-brand-strong'] }} />
        <div className="px-4 pt-3 pb-1">
          {raster ? (
            <img src={logo as string} alt="" style={{ height: 24 }} className="object-contain" />
          ) : (
            <span className="text-[13px] font-extrabold" style={{ color: vars['--color-brand-ink'] }}>
              {name}
            </span>
          )}
          {logo && !raster && (
            <p className="text-[9px] text-[#8a4b08] mt-1">
              این تصویر SVG/WebP است؛ در خیلی از صندوق‌ها نمایش داده نمی‌شود و به‌جایش نام سازمان می‌آید.
            </p>
          )}
        </div>
        <div className="px-4 pb-3 text-[10.5px] leading-[1.9] text-[#1d2329]">
          کارجو عزیز،
          <br />
          برای «{branding.terms.job}» درخواست شما ثبت شد و در حال بررسی است.
          {branding.email.signoff && (
            <>
              <br />
              <br />
              <span className="whitespace-pre-wrap">{branding.email.signoff}</span>
            </>
          )}
        </div>
        <div className="px-4 py-2.5 border-t border-[#eceeed] text-[9px] leading-[1.9] text-[#6b7570]">
          <span className="font-bold text-[#3d4742]">{name}</span>
          {branding.email.footerNote && (
            <>
              <br />
              <span className="whitespace-pre-wrap">{branding.email.footerNote}</span>
            </>
          )}
          {branding.showHovidaCredit && (
            <>
              <br />
              ساخته‌شده با هویدا
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BrandingTab() {
  const { org } = useAuth();
  const { branding: live, reload } = useBranding();
  const [draft, setDraft] = useState<OrgBranding>(live);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [mailSending, setMailSending] = useState(false);
  const [mailResult, setMailResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Load the saved identity once (the provider may not have it yet), then keep
  // the draft local: every keystroke is the customer's, not the server's.
  useEffect(() => {
    setDraft(live);
  }, [live]);

  const set = <K extends keyof OrgBranding>(key: K, value: OrgBranding[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const patch = (part: Partial<OrgBranding>) => setDraft((d) => ({ ...d, ...part }));

  const { warnings } = useMemo(() => brandTokens(draft), [draft]);
  const dirty = useMemo(() => JSON.stringify({ ...draft, updatedAtISO: null, updatedByName: null }) !== JSON.stringify({ ...live, updatedAtISO: null, updatedByName: null }), [draft, live]);
  const buttonContrast = contrast(brandTokens(draft).vars['--color-brand-strong'], '#FFFFFF');

  const save = async (opts: { silent?: boolean } = {}) => {
    setSaving(true);
    setError(null);
    try {
      await api.branding.save(draft);
      await reload();
      if (!opts.silent) toast('هویت سازمانی ذخیره شد؛ پنل همهٔ اعضا همین حالا تغییر کرد.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ذخیرهٔ هویت سازمانی ممکن نشد.');
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const res = await api.branding.reset();
      setDraft(res.branding);
      await reload();
      setConfirmReset(false);
      toast('به هویت پیش‌فرض هویدا بازگشتیم.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'بازگرداندن پیش‌فرض ممکن نشد.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="info" title="این تغییر برای همهٔ اعضای فضای کاری شما اعمال می‌شود">
        لوگو، رنگ‌ها، گوشه‌ها، فونت، نوار کناری، واژه‌ها و صفحهٔ ورود — همه از همین‌جا. هویدا رنگ‌های مشتق‌شده را طوری می‌سازد که نوشته‌ها و دکمه‌ها خوانا بمانند؛
        اگر مجبور شویم سایه‌ای را اصلاح کنیم، پایین همین صفحه به شما می‌گوییم.
      </Callout>

      <div className="grid lg:grid-cols-[1.15fr_1fr] gap-4 items-start">
        <div className="flex flex-col gap-4">
          {/* ---------------------------------------------------------- identity */}
          <Card>
            <CardHeader title="هویت" subtitle="لوگو، نشان و نامی که تیم شما در پنل می‌بیند" icon={ImageIcon} />
            <div className="grid sm:grid-cols-2 gap-4">
              <ImageField
                label="لوگوی کامل"
                value={draft.logoDataUrl}
                onChange={(v) => patch({ logoDataUrl: v })}
                hint="PNG/SVG با پس‌زمینهٔ شفاف؛ حداکثر ۳۸۰ کیلوبایت."
                height={draft.logoHeight}
              />
              <ImageField
                label="نشان مربعی (فاوآیکن)"
                value={draft.markDataUrl}
                onChange={(v) => patch({ markDataUrl: v })}
                hint="در تب مرورگر و سربرگ موبایل استفاده می‌شود."
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-4 mt-4">
              <TextInput
                label="نام در پنل"
                value={draft.nickname}
                onChange={(e) => set('nickname', e.target.value)}
                placeholder={org?.name || 'هویدا'}
                hint="اگر خالی بماند، نام سازمان نمایش داده می‌شود."
                maxLength={40}
              />
              <Field label={`ارتفاع لوگو: ${draft.logoHeight} پیکسل`} hint="بین ۱۸ تا ۶۴ پیکسل؛ برای لوگوهای پهن ۳۰ تا ۳۶ مناسب است.">
                <input
                  type="range"
                  min={18}
                  max={64}
                  value={draft.logoHeight}
                  onChange={(e) => set('logoHeight', Number(e.target.value))}
                  className="w-full accent-[var(--color-brand)]"
                  aria-label="ارتفاع لوگو"
                />
              </Field>
            </div>
            <div className="mt-4">
              <Switch
                checked={draft.showHovidaCredit}
                onChange={(v) => set('showHovidaCredit', v)}
                label="نمایش «ساخته‌شده با هویدا»"
                description="خاموش کردن آن، پنل را کاملاً سفیدبرچسب می‌کند."
              />
            </div>
          </Card>

          {/* ------------------------------------------------------------ colour */}
          <Card>
            <CardHeader title="رنگ‌ها" subtitle="از یک رنگ، همهٔ سایه‌های لازم ساخته می‌شود" icon={Palette} />
            <div className="flex flex-wrap gap-2 mb-4">
              {BRAND_PRESETS.map((p) => {
                const active = draft.colors.brand === p.colors.brand && draft.colors.accent === p.colors.accent && draft.sidebar === p.sidebar && draft.radius === p.radius;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => patch({ colors: p.colors, sidebar: p.sidebar, radius: p.radius, theme: p.theme, presetId: p.id })}
                    className={`flex items-center gap-2 h-9 pl-3 pr-2 rounded-full border text-[12px] font-semibold transition-colors ${
                      active ? 'border-brand bg-brand-tint text-brand-stronger' : 'border-line text-ink-2 hover:border-line-strong'
                    }`}
                    title={p.hint}
                  >
                    <span className="flex -space-x-1" aria-hidden>
                      <span className="w-3.5 h-3.5 rounded-full border border-white" style={{ background: p.colors.brand }} />
                      <span className="w-3.5 h-3.5 rounded-full border border-white" style={{ background: p.colors.accent }} />
                    </span>
                    {p.label}
                    {active && <Check className="w-3.5 h-3.5" />}
                  </button>
                );
              })}
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <ColorField label="رنگ برند" value={draft.colors.brand} onChange={(v) => patch({ colors: { ...draft.colors, brand: v } })} hint="دکمه‌ها، لینک‌ها، نمودارها." />
              <ColorField label="رنگ دوم" value={draft.colors.accent} onChange={(v) => patch({ colors: { ...draft.colors, accent: v } })} hint="پس‌زمینهٔ صفحهٔ ورود و درگاه استخدام." />
            </div>
            <div className="mt-3 rounded-control border border-line-2 bg-canvas px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-[5px]" style={{ background: brandTokens(draft).vars['--color-brand'] }} aria-hidden />
                رنگ خام
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-[5px]" style={{ background: brandTokens(draft).vars['--color-brand-strong'] }} aria-hidden />
                روی دکمه (کنتراست {buttonContrast.toFixed(2)}:۱)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-4 rounded-[5px]" style={{ background: brandTokens(draft).vars['--color-brand-ink'] }} aria-hidden />
                متن روی سفید
              </span>
            </div>
            {warnings.map((w) => (
              <Callout key={w} tone="warning" className="mt-3">
                {w}
              </Callout>
            ))}
          </Card>

          {/* ------------------------------------------------------------ layout */}
          <Card>
            <CardHeader title="چیدمان" subtitle="نوار کناری، گوشه‌ها، فونت و حالت روشن/تیره" icon={LayoutTemplate} />
            <div className="flex flex-col gap-4">
              <Field label="نوار کناری">
                <Segmented
                  value={draft.sidebar}
                  onChange={(v) => set('sidebar', v)}
                  items={(['light', 'tinted', 'dark'] as const).map((v) => ({ id: v, label: SIDEBAR_LABEL[v] }))}
                />
              </Field>
              <Field label={`پهنای نوار کناری: ${draft.sidebarWidth} پیکسل`} hint="بین ۲۲۴ تا ۲۹۶؛ برای نام‌های بلندتر، پهن‌تر.">
                <input
                  type="range"
                  min={224}
                  max={296}
                  step={8}
                  value={draft.sidebarWidth}
                  onChange={(e) => set('sidebarWidth', Number(e.target.value))}
                  className="w-full accent-[var(--color-brand)]"
                  aria-label="پهنای نوار کناری"
                />
              </Field>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label="گوشه‌ها">
                  <Segmented value={draft.radius} onChange={(v) => set('radius', v)} items={(['sharp', 'soft', 'round'] as const).map((v) => ({ id: v, label: RADIUS_LABEL[v] }))} />
                </Field>
                <Field label="حالت تیره">
                  <Segmented value={draft.theme} onChange={(v) => set('theme', v)} items={(['light', 'dark'] as const).map((v) => ({ id: v, label: THEME_LABEL[v] }))} />
                </Field>
              </div>
              <Field label="فونت" hint="وزیرمتن برای خوانایی فارسی؛ فونت سیستم اگر سازمان شما فونت نصب‌شده روی دستگاه را ترجیح می‌دهد.">
                <Select
                  value={draft.font}
                  options={(['vazirmatn', 'system'] as const).map((f) => ({ value: f, label: FONT_LABEL[f] }))}
                  onChange={(e) => set('font', e.target.value as OrgBranding['font'])}
                />
              </Field>
            </div>
          </Card>

          {/* -------------------------------------------------------------- words */}
          <Card>
            <CardHeader title="واژه‌ها و ناوبری" subtitle="هر سازمان اسم خودش را برای این چیزها دارد" icon={Type} />
            <div className="grid sm:grid-cols-2 gap-4">
              {(
                [
                  ['candidate', 'به‌جای «کارجو»'],
                  ['job', 'به‌جای «فرصت شغلی»'],
                  ['interview', 'به‌جای «مصاحبه»'],
                  ['offer', 'به‌جای «پیشنهاد شغلی»'],
                ] as const
              ).map(([key, label]) => (
                <TextInput
                  key={key}
                  label={label}
                  value={draft.terms[key]}
                  maxLength={30}
                  onChange={(e) => set('terms', { ...draft.terms, [key]: e.target.value })}
                />
              ))}
            </div>
            <div className="mt-4">
              <Field label="تغییر نام آیتم‌های منو" hint="خالی بگذارید تا نام پیش‌فرض هویدا بماند.">
                <div className="grid sm:grid-cols-2 gap-2">
                  {NAV_KEYS.filter((k) => k !== 'settings').map((k) => (
                    <div key={k} className="flex items-center gap-2">
                      <span className="text-[11.5px] text-ink-4 w-[104px] shrink-0">{NAV_LABEL[k]}</span>
                      <TextInput
                        value={draft.nav.labels[k] || ''}
                        maxLength={34}
                        placeholder={NAV_LABEL[k]}
                        onChange={(e) => set('nav', { ...draft.nav, labels: { ...draft.nav.labels, [k]: e.target.value } })}
                        aria-label={`نام جدید برای ${NAV_LABEL[k]}`}
                      />
                    </div>
                  ))}
                </div>
              </Field>
            </div>
            <div className="mt-4">
              <Field label="پنهان‌کردن بخش‌هایی که تیم شما استفاده نمی‌کند" hint="«تنظیمات» همیشه می‌ماند تا راه بازگشت وجود داشته باشد.">
                <div className="grid sm:grid-cols-2 gap-x-4">
                  {NAV_KEYS.filter((k) => k !== 'settings').map((k) => (
                    <Switch
                      key={k}
                      checked={draft.nav.hidden.includes(k)}
                      onChange={(v) =>
                        set('nav', {
                          ...draft.nav,
                          hidden: v ? [...draft.nav.hidden, k] : draft.nav.hidden.filter((x) => x !== k),
                        })
                      }
                      label={NAV_LABEL[k]}
                    />
                  ))}
                </div>
              </Field>
            </div>
            <div className="mt-4">
              <Field label="صفحهٔ اول پس از ورود">
                <Select
                  value={draft.landing}
                  options={LANDING_KEYS.map((k) => ({ value: k, label: LANDING_LABEL[k] }))}
                  onChange={(e) => set('landing', e.target.value as OrgBranding['landing'])}
                />
              </Field>
            </div>
          </Card>

          {/* ------------------------------------------------------ login + portal */}
          <Card>
            <CardHeader title="صفحهٔ ورود و درگاه استخدام" subtitle="اولین چیزی که کارجو و همکار جدید می‌بینند" icon={Sparkles} />
            <div className="flex flex-col gap-4">
              <TextInput label="تیتر صفحهٔ ورود" value={draft.login.title} maxLength={90} onChange={(e) => set('login', { ...draft.login, title: e.target.value })} />
              <TextArea
                label="زیرتیتر صفحهٔ ورود"
                value={draft.login.subtitle}
                maxLength={160}
                rows={2}
                onChange={(e) => set('login', { ...draft.login, subtitle: e.target.value })}
              />
              <Field label="پس‌زمینهٔ صفحهٔ ورود">
                <Segmented
                  value={draft.login.background}
                  onChange={(v) => set('login', { ...draft.login, background: v })}
                  items={(['gradient', 'plain', 'mesh'] as const).map((v) => ({ id: v, label: LOGIN_BG_LABEL[v] }))}
                />
              </Field>
              <TextInput
                label="تیتر درگاه استخدام عمومی"
                value={draft.portal.heading}
                maxLength={90}
                placeholder="مثلاً: به تیم ما بپیوندید"
                onChange={(e) => set('portal', { ...draft.portal, heading: e.target.value })}
              />
              <ImageField
                label="تصویر کاور درگاه"
                value={draft.portal.coverDataUrl}
                onChange={(v) => set('portal', { ...draft.portal, coverDataUrl: v })}
                hint="در بالای صفحهٔ /careers و کنار فرم ورود استفاده می‌شود؛ حداکثر ۳۸۰ کیلوبایت."
              />
              <p className="text-[11.5px] text-ink-3 leading-relaxed">
                آدرس صفحهٔ ورود با هویت شما: <code className="hv-latin bg-canvas border border-line rounded px-1.5 py-0.5">/login?ws={org?.careerSlug || 'slug'}</code> — این
                آدرس را با تیم و کارجوها به اشتراک بگذارید.
              </p>
            </div>
          </Card>

          {/* ------------------------------------------------------------ e-mail */}
          <Card>
            <CardHeader title="نامهٔ سازمان" subtitle="هر ایمیلی که از طرف شما می‌رود، با هویت خودتان" icon={Mail} />
            <div className="flex flex-col gap-4">
              <Switch
                checked={draft.email.includeLogo}
                onChange={(v) => set('email', { ...draft.email, includeLogo: v })}
                label="نمایش لوگو در سربرگ نامه"
                description="لوگو به نامه پیوست می‌شود (نه لینک) — صندوق‌های Gmail، Outlook و Yandex آن را نشان می‌دهند."
              />
              <TextArea
                label="امضای پایانی نامه"
                optional
                rows={2}
                maxLength={200}
                value={draft.email.signoff}
                placeholder={'با احترام،\nواحد منابع انسانی'}
                onChange={(e) => set('email', { ...draft.email, signoff: e.target.value })}
                hint="زیر متن هر نامه اضافه می‌شود؛ خالی بگذارید تا چیزی اضافه نشود."
              />
              <TextArea
                label="زیرنویس نامه"
                optional
                rows={2}
                maxLength={300}
                value={draft.email.footerNote}
                placeholder="نشانی، تلفن یا جملهٔ حقوقی خودتان"
                onChange={(e) => set('email', { ...draft.email, footerNote: e.target.value })}
                hint="در پانویس کوچک نامه می‌آید؛ مناسب نشانی و شمارهٔ تماس."
              />
              <MailPreview branding={draft} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={mailSending}
                  onClick={async () => {
                    setMailSending(true);
                    setMailResult(null);
                    try {
                      await save({ silent: true });
                      const r = await api.branding.emailTest();
                      setMailResult({ ok: true, text: `نامهٔ آزمایشی به ${r.to} فرستاده شد؛ صندوق خود را ببینید.` });
                    } catch (err) {
                      setMailResult({ ok: false, text: err instanceof ApiError ? err.message : 'فرستادن نامهٔ آزمایشی ممکن نشد.' });
                    } finally {
                      setMailSending(false);
                    }
                  }}
                >
                  فرستادن یک نامهٔ آزمایشی به خودم
                </Button>
                {mailResult && (
                  <span className={`text-[11.5px] font-semibold ${mailResult.ok ? 'text-brand-ink' : 'text-low-ink'}`}>{mailResult.text}</span>
                )}
              </div>
              <p className="text-[11.5px] text-ink-3 leading-relaxed">
                نامهٔ آزمایشی اول این صفحه را ذخیره می‌کند و بعد به نشانی حساب خودتان می‌رود؛ به هیچ کارجویی فرستاده نمی‌شود. اگر صندوق ایمیل سازمان در
                «تنظیمات ← اتصال‌ها» وصل نباشد، همین‌جا صادقانه می‌گوییم.
              </p>
            </div>
          </Card>
        </div>

        {/* ---------------------------------------------------------- preview */}
        <div className="lg:sticky lg:top-[88px] flex flex-col gap-3">
          <Card padded={false} className="overflow-hidden">
            <div className="px-4 pt-3.5 pb-2 flex items-center justify-between">
              <div>
                <p className="text-[13px] font-bold text-ink">پیش‌نمایش زنده</p>
                <p className="text-[11.5px] text-ink-3">همان پوسته‌ای که تیم شما می‌بیند</p>
              </div>
              <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${dirty ? 'bg-review-soft text-review-ink' : 'bg-brand-soft text-brand-stronger'}`}>
                {dirty ? 'ذخیره‌نشده' : 'ذخیره شد'}
              </span>
            </div>
            <div className="px-4 pb-4">
              <Preview branding={draft} />
            </div>
          </Card>

          {error && (
            <Callout tone="danger" title="ذخیره نشد">
              {error}
            </Callout>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button icon={Save} onClick={() => void save().catch(() => undefined)} loading={saving} disabled={!dirty}>
              ذخیرهٔ هویت سازمانی
            </Button>
            <Button variant="secondary" icon={RotateCcw} onClick={() => setConfirmReset(true)} disabled={saving}>
              بازگشت به پیش‌فرض
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(live)}>
                لغو تغییرها
              </Button>
            )}
          </div>
          {live.updatedAtISO && (
            <p className="text-[11.5px] text-ink-4">
              آخرین تغییر: {new Date(live.updatedAtISO).toLocaleDateString('fa-IR')}
              {live.updatedByName ? ` — ${live.updatedByName}` : ''}
            </p>
          )}
          {confirmReset && (
            <div className="rounded-card border border-low/30 bg-low-soft p-3 flex flex-col gap-2">
              <p className="text-[12.5px] text-low-ink font-semibold flex items-center gap-1.5">
                <TriangleAlert className="w-4 h-4" /> لوگو، رنگ‌ها و واژه‌های سفارشی حذف می‌شوند.
              </p>
              <div className="flex gap-2">
                <Button variant="danger" size="sm" onClick={() => void reset()} loading={saving}>
                  بله، پیش‌فرض هویدا
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                  انصراف
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

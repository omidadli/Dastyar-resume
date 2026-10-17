import React, { useEffect, useMemo, useState } from 'react';
import { Gauge, LifeBuoy, Megaphone, Save, UserPlus, Wrench } from 'lucide-react';
import { Button, Callout, Card, CardHeader, ErrorState, Segmented, Skeleton, Switch, TextArea, TextInput, toast } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { refreshPublicConfig } from '../../lib/config';
import { useLeaveGuard } from '../../lib/router';
import { useAsync } from '../../lib/useAsync';
import type { BannerTone, SystemSettings } from '../../types/admin';
import { AdminHeader } from './shared';

const TONE_PREVIEW: Record<BannerTone, string> = {
  info: 'bg-[#EAF2F7] text-[#24485E] border-[#D5E3EC]',
  warning: 'bg-review-soft text-[#7A4A0B] border-review/25',
  success: 'bg-brand-tint text-brand-stronger border-brand/20',
};

/**
 * Number input that can be cleared and retyped: the text is local while
 * typing and is clamped/committed on blur or Enter (deriving it from the
 * number would snap an emptied field straight back to the old value).
 */
function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onCommit: (v: number) => void;
  hint?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(text));
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(value));
    const clamped = Math.max(min, Math.min(max, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <TextInput
      label={label}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      hint={hint}
      disabled={disabled}
    />
  );
}

export default function SystemPage() {
  const { data, error, reload, setData } = useAsync(() => adminApi.system(), []);
  const [form, setForm] = useState<SystemSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);
  const dirty = useMemo(() => Boolean(data && form && JSON.stringify(data) !== JSON.stringify(form)), [data, form]);
  // Unsaved settings: leaving the page (or the tab) asks first.
  useLeaveGuard(dirty);

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!form || !data) return <Skeleton className="h-[420px] rounded-card" />;

  const set = <K extends keyof SystemSettings>(k: K, v: SystemSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    setSaving(true);
    try {
      const next = await adminApi.updateSystem(form);
      setData(next);
      setForm(next);
      void refreshPublicConfig();
      toast('تنظیمات سامانه ذخیره شد.');
    } catch (err: any) {
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={dirty ? 'pb-24' : ''}>
      <AdminHeader title="تنظیمات سامانه" subtitle="کلیدهای اصلی رفتار هویدا برای همه سازمان‌ها: ثبت‌نام، نسخه نمایشی، محدودیت بارگذاری، اطلاعیه و حالت نگهداری." />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader title="ثبت‌نام و نسخه نمایشی" icon={UserPlus} />
          <div className="grid gap-5 mt-4">
            <Switch checked={form.signupEnabled} onChange={(v) => set('signupEnabled', v)} label="ثبت‌نام سازمان‌های تازه باز باشد" description="اگر بسته باشد، صفحه ثبت‌نام پیام «ثبت‌نام فعلاً بسته است» و راه تماس را نشان می‌دهد." />
            <Switch checked={form.demoEnabled} onChange={(v) => set('demoEnabled', v)} label="دکمه «ورود به نسخه نمایشی» فعال باشد" description="هر بازدیدکننده یک فضای کاری نمونه با داده‌های ساختگی می‌گیرد." />
            <NumberField
              label="عمر نسخه نمایشی (ساعت)"
              min={1}
              max={336}
              value={form.demoHours}
              onCommit={(v) => set('demoHours', v)}
              hint="بین ۱ تا ۳۳۶ ساعت. پس از این مدت، فضای کاری نمایشی و داده‌هایش خودکار پاک می‌شود."
              disabled={!form.demoEnabled}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="محدودیت‌ها" icon={Gauge} />
          <div className="grid gap-4 mt-4">
            <NumberField
              label="حداکثر حجم هر رزومه (مگابایت)"
              min={1}
              max={25}
              value={form.maxFileMb}
              onCommit={(v) => set('maxFileMb', v)}
              hint="بین ۱ تا ۲۵ مگابایت. فایل‌های بزرگ‌تر در مرورگر کنار گذاشته می‌شوند."
            />
            <NumberField
              label="حداکثر تعداد فایل در هر نوبت بارگذاری"
              min={1}
              max={2000}
              value={form.maxFilesPerBatch}
              onCommit={(v) => set('maxFilesPerBatch', v)}
              hint="بین ۱ تا ۲۰۰۰ فایل."
            />
            <NumberField
              label="ماندگاری نشست ورود (روز)"
              min={1}
              max={365}
              value={form.sessionDays}
              onCommit={(v) => set('sessionDays', v)}
              hint="بین ۱ تا ۳۶۵ روز. پس از این مدت بی‌استفاده، کاربر باید دوباره وارد شود."
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="اطلاعیه سراسری" subtitle="نوار بالای برنامه برای همه کاربران؛ کاربر می‌تواند آن را ببندد." icon={Megaphone} />
          <div className="grid gap-4 mt-4">
            <Switch checked={form.announcement.enabled} onChange={(v) => set('announcement', { ...form.announcement, enabled: v })} label="نمایش اطلاعیه" />
            <TextArea
              label="متن اطلاعیه"
              rows={3}
              value={form.announcement.text}
              onChange={(e) => set('announcement', { ...form.announcement, text: e.target.value })}
              placeholder="مثلاً: نسخه تازه هویدا با پشتیبانی از همه قالب‌های رزومه منتشر شد."
            />
            <Segmented<BannerTone>
              value={form.announcement.tone}
              onChange={(v) => set('announcement', { ...form.announcement, tone: v })}
              size="sm"
              items={[
                { id: 'info', label: 'اطلاع‌رسانی' },
                { id: 'success', label: 'خبر خوب' },
                { id: 'warning', label: 'هشدار' },
              ]}
            />
            {form.announcement.text.trim() && (
              <div className={`rounded-[10px] border px-3 py-2 text-[12.5px] text-center ${TONE_PREVIEW[form.announcement.tone]}`}>{form.announcement.text}</div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="حالت نگهداری" subtitle="برای به‌روزرسانی یا انتقال داده‌ها؛ مدیران سامانه همچنان دسترسی دارند." icon={Wrench} />
          <div className="grid gap-4 mt-4">
            <Switch checked={form.maintenance.enabled} onChange={(v) => set('maintenance', { ...form.maintenance, enabled: v })} label="فعال‌سازی حالت نگهداری" />
            {form.maintenance.enabled && (
              <Callout tone="warning">در این حالت کاربران فقط پیام زیر را می‌بینند و نمی‌توانند رزومه تحلیل کنند یا تغییری ثبت کنند.</Callout>
            )}
            <TextArea label="پیام نگهداری" rows={3} value={form.maintenance.message} onChange={(e) => set('maintenance', { ...form.maintenance, message: e.target.value })} />
          </div>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader title="پشتیبانی" icon={LifeBuoy} />
          <div className="mt-4 max-w-[420px]">
            <TextInput
              label="ایمیل پشتیبانی"
              type="email"
              latin
              optional
              value={form.supportEmail}
              onChange={(e) => set('supportEmail', e.target.value)}
              placeholder="support@company.com"
              hint="وقتی ثبت‌نام بسته است در صفحه ثبت‌نام نشان داده می‌شود."
            />
          </div>
        </Card>
      </div>

      {dirty && (
        <div className="fixed bottom-0 inset-x-0 lg:pr-[252px] z-20">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 pb-4">
            <div className="hv-card shadow-pop px-4 py-3 flex flex-wrap items-center gap-3">
              <span className="text-[13px] font-bold text-ink flex items-center gap-1.5 flex-1">
                <span className="w-2 h-2 rounded-full bg-review animate-pulse" />
                تغییرات ذخیره‌نشده
              </span>
              <Button variant="ghost" size="sm" onClick={() => setForm(data)}>
                لغو
              </Button>
              <Button size="sm" icon={Save} loading={saving} onClick={() => void save()}>
                ذخیره تنظیمات
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

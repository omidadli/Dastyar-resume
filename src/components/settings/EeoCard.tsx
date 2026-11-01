import React, { useEffect, useState } from 'react';
import { Scale, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth, useCan } from '../../lib/auth';
import { Button, Callout, Card, CardHeader, Chip, Switch, TextInput, toast } from '../ui';

/**
 * «برابری فرصت‌ها» — collecting diversity data is a decision, not a default.
 *
 * The card is deliberately blunt about the deal: the candidate may decline, the
 * answer never appears beside their name, and small groups are suppressed in the
 * report. Turning it off stops collecting immediately for new applications.
 */
export function EeoCard() {
  const can = useCan('admin');
  const { org, refresh } = useAuth();
  const [enabled, setEnabled] = useState(false);
  const [threshold, setThreshold] = useState('5');
  const [saving, setSaving] = useState(false);
  const current = org?.eeo;

  useEffect(() => {
    setEnabled(Boolean(current?.enabled));
    setThreshold(String(current?.threshold ?? 5));
  }, [current?.enabled, current?.threshold]);

  const save = async () => {
    setSaving(true);
    try {
      const n = Math.round(Number(threshold.replace(/[^\d]/g, '')) || 5);
      await api.org.update({ eeo: { enabled, threshold: n } });
      await refresh();
      toast(enabled ? 'گزارش برابری فرصت‌ها روشن شد.' : 'جمع‌آوری اطلاعات برابری فرصت‌ها خاموش شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const dirty = enabled !== Boolean(current?.enabled) || Number(threshold) !== (current?.threshold ?? 5);

  return (
    <Card>
      <CardHeader
        icon={Scale}
        title="برابری فرصت‌ها"
        subtitle="اطلاعات داوطلبانهٔ کارجو، فقط به‌صورت تجمیعی و بی‌نام"
        action={current?.enabled ? <Chip tone="brand">روشن</Chip> : <Chip tone="neutral">خاموش</Chip>}
      />
      <div className="space-y-3">
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label="جمع‌آوری اطلاعات داوطلبانهٔ برابری فرصت‌ها"
          description="در فرم درخواست پورتال شغلی، سه پرسش اختیاری (جنسیت، گروه سنی، معلولیت) اضافه می‌شود."
          disabled={!can || saving}
        />
        <TextInput
          label="حداقل اندازهٔ گروه در گزارش"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value.replace(/[^\d]/g, ''))}
          latin
          hint="گروه‌های کوچک‌تر از این عدد در گزارش پنهان می‌شوند تا کسی قابل شناسایی نباشد. حداقل ۲ و حداکثر ۵۰."
          disabled={!can || saving}
        />
        <Callout tone="info" icon={ShieldCheck}>
          پاسخ کارجو هرگز کنار نامش به هیچ عضوی نشان داده نمی‌شود — نه در فهرست، نه در پنل کارجو، نه در پیشنهاد شغلی. تنها جایی که دیده می‌شود
          گزارش تجمیعی مدیر است و آن هم با پنهان‌سازی گروه‌های کوچک. تصمیم استخدام هم هیچ‌جا از این پاسخ‌ها استفاده نمی‌کند.
        </Callout>
        {!can && <p className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند این تنظیم را تغییر دهد.</p>}
        <div>
          <Button onClick={() => void save()} loading={saving} disabled={!can || saving || !dirty}>
            ذخیرهٔ تنظیم
          </Button>
        </div>
      </div>
    </Card>
  );
}

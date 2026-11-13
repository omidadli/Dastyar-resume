import { useEffect, useState } from 'react';
import { FileSignature, Lock, Plus, Save, Trash2 } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, Select, Switch, TextInput, toast } from '../ui';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { toPersianDigits } from '../../lib/format';
import type { OfferApprovalConfigStep } from '../../types/offers';

interface Row extends OfferApprovalConfigStep {
  /** A key for rows that are not saved yet. */
  key: string;
}

let seq = 0;
const rowOf = (step?: Partial<OfferApprovalConfigStep>): Row => ({
  key: `row-${++seq}`,
  id: step?.id || `apv-${seq}`,
  label: step?.label || '',
  approverId: step?.approverId || '',
});

/**
 * «گردش تأیید پیشنهاد» — an optional chain of approvers in a fixed order.
 *
 * The chain is copied onto every offer when it is written, so turning this off
 * never rewrites an offer that is already waiting for someone. A rejection ends
 * that offer; the history says who and why.
 */
export function OfferApprovalCard() {
  const canEdit = useCan('admin');
  const [enabled, setEnabled] = useState(false);
  const [rows, setRows] = useState<Row[]>([rowOf()]);
  const [members, setMembers] = useState<{ id: string; name: string; role: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.org
      .get()
      .then((r) => {
        const cfg = r.org.offerApproval;
        setEnabled(Boolean(cfg?.enabled));
        setRows((cfg?.steps?.length ? cfg.steps : [rowOf()]).map((s) => rowOf(s)));
        setMembers(r.members.map((m) => ({ id: m.id, name: m.name, role: m.role })));
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const patch = (key: string, next: Partial<Row>) => setRows((list) => list.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const save = async () => {
    const steps = rows
      .filter((r) => r.approverId)
      .map((r) => ({ id: r.id, label: r.label.trim(), approverId: r.approverId }));
    if (enabled && !steps.length) {
      toast('دست‌کم یک تأییدکننده انتخاب کنید.', 'error');
      return;
    }
    setBusy(true);
    try {
      await api.org.update({ offerApproval: { enabled, steps } });
      toast(enabled ? 'گردش تأیید ذخیره شد؛ پیشنهادهای تازه با همین زنجیره ساخته می‌شوند.' : 'گردش تأیید خاموش شد.', 'success');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const memberOptions = members.map((m) => ({ value: m.id, label: `${m.name}${m.role === 'owner' ? ' (مالک)' : m.role === 'admin' ? ' (مدیر)' : ''}` }));

  return (
    <Card className="mt-5 max-w-[720px]">
      <CardHeader
        icon={FileSignature}
        title="گردش تأیید پیشنهاد"
        subtitle="پیش از رسیدن پیشنهاد شغلی به کارجو، یک یا چند نفر به ترتیب آن را تأیید کنند."
        action={enabled ? <Chip tone="brand">روشن</Chip> : <Chip tone="neutral">خاموش</Chip>}
      />

      {!canEdit && (
        <Callout tone="info" icon={Lock} className="mb-4">
          فقط مدیر یا مالک فضای کاری می‌تواند این زنجیره را تغییر دهد.
        </Callout>
      )}

      <Switch
        checked={enabled}
        disabled={!canEdit || loading}
        onChange={setEnabled}
        label={enabled ? 'پیشنهاد بدون تأیید فرستاده نمی‌شود' : 'گردش تأیید خاموش است'}
        description={
          enabled
            ? 'هر پیشنهاد تازه، زنجیرهٔ زیر را با وضعیت «در انتظار» می‌گیرد؛ دکمهٔ ارسال تا تأیید مرحلهٔ فعلی کار نمی‌کند.'
            : 'امروز هر عضو تیم می‌تواند پیشنهاد را مستقیم بفرستد. با روشن‌کردنش، یک قدم تأیید اضافه می‌شود.'
        }
      />

      {enabled && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-[11.5px] text-ink-3">
            ترتیب از بالا به پایین است. هر مرحله در اختیار همان فرد است؛ مدیر یا مالک می‌تواند به‌جای او تصمیم بگیرد و همین در تاریخچه ثبت می‌شود.
          </p>
          {rows.map((row, i) => (
            <div key={row.key} className="flex flex-col sm:flex-row sm:items-end gap-2">
              <span className="w-6 h-6 rounded-full bg-line-2 text-ink-3 flex items-center justify-center text-[11px] font-bold shrink-0 sm:mb-2.5 hv-num">
                {toPersianDigits(i + 1)}
              </span>
              <TextInput
                label={`برچسب مرحله (${toPersianDigits(i + 1)})`}
                value={row.label}
                onChange={(e) => patch(row.key, { label: e.target.value })}
                placeholder={i === 0 ? 'مدیر فنی' : i === 1 ? 'مالی' : 'مدیرعامل'}
                disabled={!canEdit}
                wrapperClassName="flex-1"
              />
              <Select
                label="تأییدکننده"
                value={row.approverId}
                onChange={(e) => patch(row.key, { approverId: e.target.value })}
                options={[{ value: '', label: 'انتخاب کنید…' }, ...memberOptions]}
                disabled={!canEdit}
                wrapperClassName="flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                icon={Trash2}
                onClick={() => setRows((list) => (list.length === 1 ? list : list.filter((r) => r.key !== row.key)))}
                disabled={!canEdit || rows.length === 1}
                aria-label="حذف مرحله"
              >
                حذف
              </Button>
            </div>
          ))}
          {rows.length < 3 && (
            <div>
              <Button size="sm" variant="secondary" icon={Plus} onClick={() => setRows((list) => [...list, rowOf()])} disabled={!canEdit}>
                افزودن مرحله
              </Button>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="flex justify-end mt-4 pt-4 border-t border-line-2">
          <Button icon={Save} onClick={() => void save()} loading={busy} disabled={loading}>
            ذخیره
          </Button>
        </div>
      )}
    </Card>
  );
}

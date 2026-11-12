/**
 * «تنظیمات ← سنجش نرم‌شده» — where a workspace states its comparison group.
 *
 * Why this screen exists at all: a percentile is only meaningful against *some*
 * group, and the group has to be named. Either HR enters their own table (mean
 * and SD per scale, with n), or the workspace waits until it has enough completed
 * results for an internal norm. There is no third option, and no default table
 * invented by us.
 */
import React, { useEffect, useState } from 'react';
import { BarChart3, Eraser, Info, Save, ShieldCheck } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Field, Skeleton, TextInput, toast } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { PsychNormConfig, PsychScaleSummary } from '../../types/psychometrics';

type Draft = Record<string, { mean: string; sd: string }>;

export default function PsychNormsTab() {
  type NormsPayload = { norms: PsychNormConfig | null; minNormN: number; scales: { id: string; label: string }[] };
  const normsQ = useAsync<NormsPayload>(() => api.psych.norms.get(), []);
  const scalesQ = useAsync<{ scales: (PsychScaleSummary & { itemCount: number })[]; minNormN: number }>(() => api.psych.scales(), []);
  const [source, setSource] = useState('');
  const [n, setN] = useState('');
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<PsychNormConfig | null>(null);

  useEffect(() => {
    if (!normsQ.data) return;
    setCurrent(normsQ.data.norms);
    setSource(normsQ.data.norms?.source || '');
    setN(normsQ.data.norms ? String(normsQ.data.norms.n) : '');
    const next: Draft = {};
    for (const s of normsQ.data.scales) {
      const row = normsQ.data.norms?.scales?.[s.id];
      next[s.id] = { mean: row ? String(row.mean) : '', sd: row ? String(row.sd) : '' };
    }
    setDraft(next);
  }, [normsQ.data]);

  const scales = normsQ.data?.scales || [];

  const save = async () => {
    setSaving(true);
    try {
      const payload: { source: string; n: number; scales: Record<string, { mean: number; sd: number }> } = {
        source: source.trim(),
        n: Number(n),
        scales: {},
      };
      for (const s of scales) {
        const row = draft[s.id];
        if (!row || row.mean === '' || row.sd === '') continue;
        payload.scales[s.id] = { mean: Number(row.mean), sd: Number(row.sd) };
      }
      const r = await api.psych.norms.save(payload);
      setCurrent(r.norms);
      toast('هنجار مقایسه‌ای ثبت شد؛ نتیجه‌های بعدی با همین گروه خوانده می‌شوند.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت هنجار ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const clear = async () => {
    if (!window.confirm('هنجار واردشده حذف شود؟ از این پس نتیجه‌ها «بدون هنجار» یا با هنجار داخلی نمایش داده می‌شوند.')) return;
    try {
      await api.psych.norms.clear();
      setCurrent(null);
      setSource('');
      setN('');
      toast('هنجار حذف شد.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'حذف ممکن نشد.', 'error');
    }
  };

  return (
    <div className="max-w-[820px] flex flex-col gap-4">
      <Callout tone="info" title="هنجار، گروه مقایسه است — نه استاندارد کشوری">
        اگر جدول هنجار سازمانی خود را دارید (میانگین و انحراف معیار خام هر مقیاس)، این‌جا وارد کنید. تا وقتی وارد نشود، عددها فقط به‌صورت «درصد دامنه» نمایش داده
        می‌شوند و هیچ صدکی ساخته نمی‌شود. هنجار داخلی هم فقط بعد از {toPersianDigits(scalesQ.data?.minNormN ?? 20)} نتیجهٔ تکمیل‌شدهٔ همین فضای کاری شکل می‌گیرد.
      </Callout>

      <Card>
        <CardHeader
          title="هنجار مقایسه‌ای"
          subtitle={current ? `ثبت‌شده: ${current.source} (n=${current.n}) — آخرین ویرایش ${new Date(current.updatedAtISO).toLocaleDateString('fa-IR')} توسط ${current.updatedByName}` : 'هنوز هنجاری ثبت نشده است.'}
          icon={BarChart3}
          action={
            current ? (
              <Button size="sm" variant="ghost" icon={Eraser} className="text-low-ink" onClick={() => void clear()}>
                حذف
              </Button>
            ) : null
          }
        />
        {!normsQ.data ? (
          <Skeleton className="h-40" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="نام گروه مقایسه" hint="همان‌طور که می‌خواهید روی صفحه دیده شود، مثلاً «نمونهٔ کارکنان ۱۴۰۳»">
                <TextInput value={source} onChange={(e) => setSource(e.target.value)} placeholder="نمونهٔ کارکنان ۱۴۰۳" maxLength={120} />
              </Field>
              <Field label="تعداد نفرات گروه (n)" hint="لازم است؛ صدک بدون n یعنی بدون مقایسه">
                <TextInput value={n} onChange={(e) => setN(e.target.value.replace(/[^\d]/g, ''))} placeholder="120" dir="ltr" inputMode="numeric" />
              </Field>
            </div>

            <div className="rounded-control border border-line-2 overflow-hidden">
              <div className="grid grid-cols-[1fr_90px_90px] gap-2 px-3 py-2 bg-canvas text-[11.5px] font-semibold text-ink-3">
                <span>مقیاس</span>
                <span>میانگین خام</span>
                <span>انحراف معیار</span>
              </div>
              {scales.map((s) => (
                <div key={s.id} className="grid grid-cols-[1fr_90px_90px] gap-2 px-3 py-2 border-t border-line-2 items-center">
                  <span className="text-[12.5px] text-ink-2">{s.label}</span>
                  <TextInput
                    aria-label={`میانگین ${s.label}`}
                    value={draft[s.id]?.mean ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.id]: { mean: e.target.value.replace(/[^\d.]/g, ''), sd: draft[s.id]?.sd ?? '' } })}
                    dir="ltr"
                    inputMode="decimal"
                  />
                  <TextInput
                    aria-label={`انحراف معیار ${s.label}`}
                    value={draft[s.id]?.sd ?? ''}
                    onChange={(e) => setDraft({ ...draft, [s.id]: { mean: draft[s.id]?.mean ?? '', sd: e.target.value.replace(/[^\d.]/g, '') } })}
                    dir="ltr"
                    inputMode="decimal"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-ink-4 flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                مقیاس هر بُعد ۵ تا ۲۵ است (۵ گزاره، هر کدام ۱ تا ۵). دست‌کم یک مقیاس لازم است.
              </p>
              <Button icon={Save} loading={saving} onClick={() => void save()}>
                ثبت هنجار
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="مقیاس‌ها و معنای هر کدام" subtitle="همین متن کنار هر نتیجه هم نشان داده می‌شود" icon={ShieldCheck} />
        <div className="flex flex-col gap-2.5">
          {(scalesQ.data?.scales || []).map((s: PsychScaleSummary & { itemCount: number }) => (
            <div key={s.id} className="rounded-control border border-line-2 bg-canvas p-3">
              <p className="text-[12.5px] font-bold text-ink">
                {s.label} <span className="text-[11px] font-normal text-ink-4">({toPersianDigits(s.itemCount)} گزاره)</span>
              </p>
              <p className="text-[11.5px] text-ink-2 mt-1 leading-relaxed">
                <span className="font-semibold">بالا: </span>
                {s.high}
              </p>
              <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">
                <span className="font-semibold">پایین: </span>
                {s.low}
              </p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

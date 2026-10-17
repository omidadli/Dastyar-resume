import React from 'react';
import { BarChart3, CheckCircle2, Cpu, Download, FileCheck2, Gauge, Hourglass, Info, Scale, Sparkles } from 'lucide-react';
import { Bar, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Card, CardHeader, EmptyState, ErrorState, JobStatusPill, Segmented, Skeleton, Stat, toast } from '../components/ui';
import { api } from '../lib/api';
import { faNumber, faPercent, toPersianDigits } from '../lib/format';
import { MATCH_META, matchLevelOf } from '../lib/match';
import { Link, setQuery, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { ReportRange, ReportsData } from '../types/app';

const RANGES: { id: ReportRange; label: string }[] = [
  { id: '30', label: '۳۰ روز' },
  { id: '90', label: '۹۰ روز' },
  { id: '365', label: 'یک سال' },
  { id: 'all', label: 'همه' },
];

const LEVEL_COLORS = { high: '#22C55E', review: '#F59E0B', low: '#EF4444', insufficient: '#94A3B8' } as const;

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-line rounded-[10px] shadow-pop px-3 py-2 text-[12px]" dir="rtl">
      {label && <p className="font-bold text-ink mb-1">{label}</p>}
      {payload.map((p: any) => (
        <p key={p.dataKey || p.name} className="flex items-center gap-2 text-ink-2">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.color || p.payload?.fill }} />
          {p.name}: <b className="hv-num">{faNumber(p.value)}</b>
        </p>
      ))}
    </div>
  );
}

function HBar({ label, value, max, sub, color = 'bg-brand' }: { label: React.ReactNode; value: number; max: number; sub?: React.ReactNode; color?: string }) {
  const pct = max ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-[13px]">
        <span className="font-semibold text-ink-2 truncate">{label}</span>
        {/* Separate flex items: the bidi algorithm would otherwise merge «۲۳» and «۷۷٪» into one number. */}
        <span className="inline-flex items-center gap-1.5 shrink-0">
          <bdi className="hv-num font-bold text-ink">{faNumber(value)}</bdi>
          {sub && (
            <>
              <span className="text-ink-4" aria-hidden>
                ·
              </span>
              <bdi className="hv-num text-ink-3 font-medium text-[12px]">{sub}</bdi>
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 h-2 rounded-full bg-line-2 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

async function exportReport(d: ReportsData) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const t = d.totals;
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet([
      { شاخص: 'رزومه‌های تحلیل‌شده', مقدار: t.analyzed },
      { شاخص: 'فرصت‌های شغلی ایجادشده', مقدار: t.jobs },
      { شاخص: 'تطابق بالا', مقدار: t.highMatch },
      { شاخص: 'میانگین درصد تطابق', مقدار: t.avgScore },
      { شاخص: 'تصمیم‌های ثبت‌شده', مقدار: t.decided },
      { شاخص: 'تأییدشده', مقدار: t.approved },
      { شاخص: 'ردشده', مقدار: t.rejected },
      { شاخص: 'افزوده به بانک استعداد', مقدار: t.talentAdded },
      { شاخص: 'زمان صرفه‌جویی‌شده (برآورد، ساعت)', مقدار: d.timeSaved.hours },
    ]),
    'خلاصه'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(d.timeline.map((b) => ({ بازه: b.label, تحلیل‌شده: b.analyzed, 'تطابق بالا': b.high, تأییدشده: b.approved }))),
    'روند'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(d.byDepartment.map((x) => ({ دپارتمان: x.name, تحلیل‌شده: x.analyzed, 'تطابق بالا': x.high, تأییدشده: x.approved }))),
    'دپارتمان‌ها'
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(d.jobs.map((j) => ({ 'فرصت شغلی': j.roleTitle, دپارتمان: j.departmentName, رزومه: j.total, 'تطابق بالا': j.high, تأیید: j.approved, 'میانگین تطابق': j.avgScore }))),
    'فرصت‌ها'
  );
  wb.Workbook = { ...(wb.Workbook || {}), Views: [{ RTL: true }] }; // opens right-to-left in Excel
  XLSX.writeFile(wb, `گزارش-هویدا-${d.range === 'all' ? 'همه' : d.range + '-روز'}.xlsx`);
}

export default function Reports() {
  useTitle('گزارش‌ها');
  const { query } = useLocation();
  const rawRange = query.get('range');
  const range: ReportRange = RANGES.some((r) => r.id === rawRange) ? (rawRange as ReportRange) : '90';
  const { data, error, loading, reload } = useAsync(() => api.insights.reports(range), [range]);

  const dist = data
    ? (['high', 'review', 'low', 'insufficient'] as const).map((lvl) => ({
        lvl,
        name: MATCH_META[lvl].label,
        value: data.distribution.filter((d) => matchLevelOf(d.category) === lvl).reduce((s, d) => s + d.count, 0),
      }))
    : [];
  const distTotal = dist.reduce((s, d) => s + d.value, 0);

  return (
    <div>
      <PageHeader
        title="گزارش‌ها"
        subtitle="روند دریافت و تحلیل رزومه‌ها، کیفیت تطابق و تصمیم‌های تیم"
        actions={
          <>
            <Segmented<ReportRange> value={range} onChange={(r) => setQuery({ range: r === '90' ? null : r })} items={RANGES} />
            <Button
              variant="secondary"
              icon={Download}
              disabled={Boolean(error) || !data || !data.totals.analyzed}
              onClick={() => data && exportReport(data).then(() => toast('گزارش اکسل آماده شد.')).catch(() => toast('ساخت فایل ممکن نشد.', 'error'))}
            >
              خروجی اکسل
            </Button>
          </>
        }
      />
      {error && <ErrorState message={error} onRetry={reload} />}
      {!error && loading && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[340px] rounded-card" />
        </div>
      )}
      {!error && data && data.totals.analyzed === 0 && (
        <div className="hv-card">
          <EmptyState icon={BarChart3} title="در این بازه هنوز رزومه‌ای تحلیل نشده است" description="بازه زمانی بزرگ‌تری انتخاب کنید یا با بارگذاری رزومه‌ها شروع کنید." />
        </div>
      )}
      {/* After a failed range switch, never show the previous range's figures under the new label. */}
      {!error && data && data.totals.analyzed > 0 && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon={FileCheck2} label="رزومه‌های تحلیل‌شده" value={faNumber(data.totals.analyzed)} note={`در ${faNumber(data.jobs.length)} فرصت شغلی`} />
            <Stat
              icon={CheckCircle2}
              label="نرخ تطابق بالا"
              value={faPercent((data.totals.highMatch / Math.max(1, data.totals.analyzed)) * 100)}
              note={`${faNumber(data.totals.highMatch)} کاندید`}
              tone="high"
            />
            <Stat icon={Gauge} label="میانگین درصد تطابق" value={faPercent(data.totals.avgScore)} note="بدون رزومه‌های با اطلاعات ناکافی" tone="brand" />
            <Stat
              icon={Scale}
              label="تصمیم‌های ثبت‌شده"
              value={faNumber(data.totals.decided)}
              note={`${faNumber(data.totals.approved)} تأیید · ${faNumber(data.totals.rejected)} رد`}
              tone="review"
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5">
            <Card>
              <CardHeader title="روند رزومه‌ها" subtitle="تعداد رزومه‌های تحلیل‌شده، با تطابق بالا و تأییدشده در هر بازه" />
              <div className="h-[300px] -mx-2" dir="ltr" style={{ fontFamily: 'inherit' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={data.timeline} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke="#EFF1F0" vertical={false} />
                    <XAxis
                      dataKey="label"
                      reversed
                      tick={{ fontSize: 11, fill: '#5C6560', fontFamily: 'Vazirmatn' }}
                      tickLine={false}
                      axisLine={{ stroke: '#E5E7EB' }}
                      interval="preserveStartEnd"
                      minTickGap={18}
                    />
                    <YAxis
                      orientation="right"
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#5C6560', fontFamily: 'Vazirmatn' }}
                      tickFormatter={(v) => toPersianDigits(v)}
                      tickLine={false}
                      axisLine={false}
                      width={32}
                    />
                    <Tooltip content={<ChartTooltip />} cursor={{ fill: '#F3F8F4' }} />
                    <Bar dataKey="analyzed" name="تحلیل‌شده" fill="#CFE5D5" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Bar dataKey="high" name="تطابق بالا" fill="#2DBA4E" radius={[4, 4, 0, 0]} maxBarSize={28} />
                    <Line dataKey="approved" name="تأییدشده" stroke="#176F30" strokeWidth={2} dot={{ r: 2.5 }} type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-4 mt-3 text-[12px] text-ink-3">
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-[#CFE5D5]" /> تحلیل‌شده
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-brand" /> تطابق بالا
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3 h-[3px] rounded bg-brand-stronger" /> تأییدشده
                </span>
              </div>
            </Card>

            <Card>
              <CardHeader title="توزیع میزان تطابق" subtitle="سهم هر سطح از رزومه‌های دریافتی" />
              <div className="relative h-[200px]" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={dist} dataKey="value" nameKey="name" innerRadius={62} outerRadius={88} paddingAngle={2} stroke="none">
                      {dist.map((d) => (
                        <Cell key={d.lvl} fill={LEVEL_COLORS[d.lvl]} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                  <span className="text-[22px] font-extrabold text-ink hv-num">{faNumber(distTotal)}</span>
                  <span className="text-[11.5px] text-ink-3">رزومه</span>
                </div>
              </div>
              <ul className="mt-4 flex flex-col gap-2">
                {dist.map((d) => {
                  const Icon = MATCH_META[d.lvl].icon;
                  return (
                    <li key={d.lvl} className="flex items-center gap-2 text-[13px]">
                      <Icon className="w-4 h-4" style={{ color: LEVEL_COLORS[d.lvl] }} />
                      <span className="text-ink-2 flex-1">{d.name}</span>
                      <span className="hv-num font-bold text-ink">{faNumber(d.value)}</span>
                      <span className="hv-num text-ink-4 w-11 text-left">{faPercent((d.value / Math.max(1, distTotal)) * 100)}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </div>

          <div className="grid lg:grid-cols-3 gap-5">
            <Card>
              <CardHeader title="قیف تصمیم‌گیری" subtitle="از رزومه دریافتی تا کاندید تأییدشده" />
              <div className="flex flex-col gap-4">
                {[
                  { l: 'تحلیل‌شده', v: data.funnel.analyzed },
                  { l: 'تطابق بالا یا نیازمند بررسی', v: data.funnel.matched },
                  { l: 'دارای تصمیم', v: data.funnel.decided },
                  { l: 'تأییدشده', v: data.funnel.approved },
                ].map((x, i, arr) => (
                  <HBar
                    key={x.l}
                    label={x.l}
                    value={x.v}
                    max={data.funnel.analyzed}
                    color={i === arr.length - 1 ? 'bg-brand-stronger' : i === 0 ? 'bg-[#CFE5D5]' : 'bg-brand'}
                    sub={i > 0 ? faPercent((x.v / Math.max(1, arr[0].v)) * 100) : undefined}
                  />
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title="دپارتمان‌ها" subtitle="رزومه‌های تحلیل‌شده و تطابق بالا" />
              <div className="flex flex-col gap-4">
                {data.byDepartment.slice(0, 6).map((d) => (
                  <HBar key={d.departmentId} label={d.name} value={d.analyzed} max={data.byDepartment[0]?.analyzed || 1} sub={`${toPersianDigits(d.high)} بالا`} />
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title="مهارت‌های پرتکرار" subtitle="در میان کاندیداهای با تطابق بالا" />
              {data.topSkills.length ? (
                <div className="flex flex-col gap-3.5">
                  {data.topSkills.slice(0, 7).map((s) => (
                    <HBar key={s.skill} label={<span dir="auto">{s.skill}</span>} value={s.count} max={data.topSkills[0].count} color="bg-[#7FCB93]" />
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-ink-3">هنوز داده کافی نیست.</p>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-5">
            <Card padded={false}>
              <div className="px-5 pt-5">
                <CardHeader title="فرصت‌های شغلی" subtitle="وضعیت هر فرصت در این بازه" />
              </div>
              <div className="overflow-x-auto hv-scroll">
                <table className="w-full text-right text-[13px]">
                  <thead>
                    <tr className="text-[12px] text-ink-3 border-b border-line">
                      <th className="font-semibold py-2.5 pr-5">فرصت شغلی</th>
                      <th className="font-semibold py-2.5 px-2">وضعیت</th>
                      <th className="font-semibold py-2.5 px-2">رزومه</th>
                      <th className="font-semibold py-2.5 px-2">تطابق بالا</th>
                      <th className="font-semibold py-2.5 px-2">تأیید</th>
                      <th className="font-semibold py-2.5 pl-5">میانگین</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.jobs.map((j) => (
                      <tr key={j.id} className="border-b border-line-2 last:border-0 hover:bg-canvas">
                        <td className="py-3 pr-5">
                          <Link to={`/app/jobs/${j.id}`} className="font-bold text-ink hover:text-brand-ink">
                            {j.roleTitle}
                          </Link>
                          <p className="text-[11.5px] text-ink-3">{j.departmentName}</p>
                        </td>
                        <td className="px-2">
                          <JobStatusPill status={j.status} />
                        </td>
                        <td className="px-2 hv-num font-semibold">{faNumber(j.total)}</td>
                        <td className="px-2 hv-num font-semibold text-high-ink">{faNumber(j.high)}</td>
                        <td className="px-2 hv-num font-semibold">{faNumber(j.approved)}</td>
                        <td className="pl-5 hv-num font-semibold">{j.avgScore ? faPercent(j.avgScore) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <div className="flex flex-col gap-5">
              <Card>
                <div className="flex items-start gap-3">
                  <span className="w-10 h-10 rounded-[11px] bg-brand-soft text-brand-strong flex items-center justify-center shrink-0">
                    <Hourglass className="w-5 h-5" strokeWidth={1.7} />
                  </span>
                  <div>
                    <p className="text-[12.5px] text-ink-3">زمان صرفه‌جویی‌شده (برآورد)</p>
                    <p className="text-[22px] font-extrabold text-ink hv-num mt-0.5">حدود {faNumber(data.timeSaved.hours, 1)} ساعت</p>
                  </div>
                </div>
                <p className="text-[12px] text-ink-3 mt-3 leading-relaxed flex gap-1.5">
                  <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  فرض: {faNumber(data.timeSaved.minutesManual)} دقیقه خواندن دستی در برابر {faNumber(data.timeSaved.minutesWithHovida, 1)} دقیقه مرور تحلیل برای هر رزومه. عدد اندازه‌گیری‌شده نیست.
                </p>
              </Card>
              <Card>
                <CardHeader title="منبع تحلیل‌ها" subtitle="سهم هوش مصنوعی و موتور محلی" />
                <div className="flex flex-col gap-3.5">
                  <HBar label={<span className="inline-flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-brand-strong" /> هوش مصنوعی</span>} value={data.engines.ai} max={Math.max(1, data.engines.ai + data.engines.local)} />
                  <HBar
                    label={<span className="inline-flex items-center gap-1.5"><Cpu className="w-4 h-4 text-review-ink" /> موتور محلی</span>}
                    value={data.engines.local}
                    max={Math.max(1, data.engines.ai + data.engines.local)}
                    color="bg-review"
                  />
                </div>
                <p className="text-[12px] text-ink-3 mt-3">
                  {faNumber(data.totals.deepReviews)} بازبینی دقیق · {faNumber(data.totals.talentAdded)} افزوده به بانک استعداد
                </p>
              </Card>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

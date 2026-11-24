import { useMemo, useState } from 'react';
import { Activity, ClipboardCheck, Download, Timer, Users, Video } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, ErrorState, Segmented, Skeleton, Stat, toast } from '../components/ui';
import { ReportTabs } from '../components/reports/ReportTabs';
import { api } from '../lib/api';
import { exportSheets } from '../lib/exportSheets';
import { faNumber, faPercent, faRelative, toPersianDigits } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { ReportRange } from '../types/app';
import type { TeamMemberRow, TeamReport as TeamReportData } from '../types/reports';

const RANGES: { id: ReportRange; label: string }[] = [
  { id: '30', label: '۳۰ روز' },
  { id: '90', label: '۹۰ روز' },
  { id: '365', label: 'یک سال' },
  { id: 'all', label: 'همه' },
];

const ROLE_LABEL = { owner: 'مالک', admin: 'مدیر', member: 'عضو' } as const;

/** A duration that reads well at both ends: hours for a day, days beyond it. */
function faWait(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 24) return `${faNumber(hours, 1)} ساعت`;
  return `${faNumber(hours / 24, 1)} روز`;
}

function ExcelButton({ data, range }: { data: TeamReportData; range: ReportRange }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      icon={Download}
      disabled={busy || !data.members.length}
      onClick={async () => {
        setBusy(true);
        try {
          await exportSheets(`عملکرد-تیم-${range === 'all' ? 'همه' : range + '-روز'}.xlsx`, [
            {
              name: 'عملکرد تیم',
              rows: data.members.map((m) => ({
                عضو: m.name,
                نقش: ROLE_LABEL[m.role],
                'تصمیم ثبت‌شده': m.decisions,
                تأیید: m.approved,
                رد: m.rejected,
                'کارت ارزیابی': m.scorecards,
                'یادداشت تیمی': m.comments,
                'مصاحبهٔ برگزارشده': m.interviews,
                'پیشنهاد ارسالی': m.offersSent,
                'میانهٔ زمان تا تصمیم (ساعت)': m.medianDecideHours ?? '',
                'آخرین فعالیت': m.lastActiveISO || '',
              })),
            },
            {
              name: 'خلاصه',
              rows: [
                { شاخص: 'تصمیم‌های ثبت‌شده', مقدار: data.totals.decisions },
                { شاخص: 'کارت ارزیابی', مقدار: data.totals.scorecards },
                { شاخص: 'یادداشت تیمی', مقدار: data.totals.comments },
                { شاخص: 'مصاحبهٔ برگزارشده', مقدار: data.totals.interviews },
                { شاخص: 'پیشنهاد ارسالی', مقدار: data.totals.offersSent },
                { شاخص: 'اعضای فعال', مقدار: data.totals.activeMembers },
              ],
            },
          ]);
          toast('گزارش اکسل آماده شد.');
        } catch {
          toast('ساخت فایل ممکن نشد.', 'error');
        } finally {
          setBusy(false);
        }
      }}
    >
      خروجی اکسل
    </Button>
  );
}

function MemberRow({ row, max }: { row: TeamMemberRow; max: number }) {
  const share = max ? Math.max(2, Math.round((row.totalActions / max) * 100)) : 0;
  return (
    <tr className="border-b border-line-2 last:border-0 hover:bg-canvas">
      <td className="py-3 pr-5 min-w-[190px]">
        <p className="font-bold text-ink">{row.name}</p>
        <p className="text-[11.5px] text-ink-3">
          {row.title || ROLE_LABEL[row.role]} — {ROLE_LABEL[row.role]}
        </p>
      </td>
      <td className="px-2 min-w-[120px]">
        <p className="hv-num font-bold text-ink">{faNumber(row.decisions)}</p>
        <p className="hv-num text-[11px] text-ink-3">
          {faNumber(row.approved)} تأیید، {faNumber(row.rejected)} رد
        </p>
      </td>
      <td className="px-2 hv-num font-semibold">{row.scorecards ? faNumber(row.scorecards) : '—'}</td>
      <td className="px-2 hv-num font-semibold">{row.interviews ? faNumber(row.interviews) : '—'}</td>
      <td className="px-2 hv-num font-semibold">{row.comments ? faNumber(row.comments) : '—'}</td>
      <td className="px-2 hv-num font-semibold">{row.offersSent ? faNumber(row.offersSent) : '—'}</td>
      <td className="px-2 hv-num text-ink-2">{faWait(row.medianDecideHours)}</td>
      <td className="pl-5 min-w-[150px]">
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 rounded-full bg-line-2 overflow-hidden">
            <div className="h-full bg-brand rounded-full" style={{ width: `${share}%` }} />
          </div>
          <bdi className="hv-num text-[11.5px] text-ink-3 w-8 text-left">{row.totalActions ? faNumber(row.totalActions) : '—'}</bdi>
        </div>
        <p className="text-[11px] text-ink-4 mt-1">{faRelative(row.lastActiveISO)}</p>
      </td>
    </tr>
  );
}

export default function TeamReport() {
  useTitle('عملکرد تیم');
  const { query } = useLocation();
  const rawRange = query.get('range');
  const range: ReportRange = RANGES.some((r) => r.id === rawRange) ? (rawRange as ReportRange) : '90';
  const { data, error, loading, reload } = useAsync(() => api.insights.teamReport(range), [range]);

  const maxActions = useMemo(() => (data ? Math.max(1, ...data.members.map((m) => m.totalActions)) : 1), [data]);
  const quiet = data ? data.totals.decisions + data.totals.scorecards + data.totals.comments + data.totals.interviews === 0 : false;

  return (
    <div>
      <PageHeader
        title="عملکرد تیم"
        subtitle="چه کسی تصمیم می‌گیرد، چه کسی ارزیابی می‌نویسد و پاسخ کارجو چقدر طول می‌کشد"
        actions={
          <>
            <Segmented<ReportRange> value={range} onChange={(r) => setQuery({ range: r === '90' ? null : r })} items={RANGES} />
            {data && <ExcelButton data={data} range={range} />}
          </>
        }
      />
      <ReportTabs active="team" />

      {error && <ErrorState message={error} onRetry={reload} />}
      {!error && loading && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[320px] rounded-card" />
        </div>
      )}

      {!error && data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <Stat
              icon={Users}
              label="تصمیم‌های ثبت‌شده"
              value={faNumber(data.totals.decisions)}
              note={`${faNumber(data.totals.approved)} تأیید، ${faNumber(data.totals.rejected)} رد`}
              tone="brand"
            />
            <Stat
              icon={ClipboardCheck}
              label="کارت ارزیابی"
              value={faNumber(data.totals.scorecards)}
              note="نوشته‌شده توسط تیم در این بازه"
              tone="high"
            />
            <Stat
              icon={Video}
              label="مصاحبهٔ برگزارشده"
              value={faNumber(data.totals.interviews)}
              note={`${faNumber(data.totals.offersSent)} پیشنهاد ارسالی`}
              tone="review"
            />
            <Stat
              icon={Activity}
              label="اعضای فعال"
              value={`${toPersianDigits(data.totals.activeMembers)} از ${toPersianDigits(data.totals.members)}`}
              note={`${faNumber(data.totals.comments)} یادداشت تیمی`}
            />
          </div>

          {quiet ? (
            <Callout
              tone="info"
              icon={Users}
              title="در این بازه هیچ اقدامی از تیم ثبت نشده است"
              action={<span className="text-[12px] text-ink-3">این گزارش از تصمیم‌ها، کارت‌های ارزیابی، یادداشت‌ها و مصاحبه‌ها ساخته می‌شود؛ وقتی تیم کار کند، خودش پر می‌شود.</span>}
            >
              بازهٔ بزرگ‌تری را انتخاب کنید یا اولین تصمیم را از پروندهٔ یک کارجو ثبت کنید.
            </Callout>
          ) : null}

          <Card padded={false}>
            <div className="px-5 pt-5">
              <CardHeader
                title="هر عضو، چه کاری انجام داده"
                subtitle="شمارش اقدام‌های ثبت‌شده در همین فضای کاری — نه امتیاز عملکرد"
                action={<span className="text-[11.5px] text-ink-4">ستون آخر: سهم از کل اقدام‌ها</span>}
              />
            </div>
            <div className="overflow-x-auto hv-scroll">
              <table className="w-full text-right text-[13px]">
                <thead>
                  <tr className="text-[12px] text-ink-3 border-b border-line">
                    <th className="font-semibold py-2.5 pr-5">عضو</th>
                    <th className="font-semibold py-2.5 px-2">تصمیم</th>
                    <th className="font-semibold py-2.5 px-2">کارت ارزیابی</th>
                    <th className="font-semibold py-2.5 px-2">مصاحبه</th>
                    <th className="font-semibold py-2.5 px-2">یادداشت</th>
                    <th className="font-semibold py-2.5 px-2">پیشنهاد</th>
                    <th className="font-semibold py-2.5 px-2">میانهٔ پاسخ</th>
                    <th className="font-semibold py-2.5 pl-5">مجموع</th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <MemberRow key={m.userId} row={m} max={maxActions} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11.5px] text-ink-4 px-5 py-3 border-t border-line-2 leading-relaxed">
              «میانهٔ پاسخ» یعنی فاصلهٔ رسیدن کارجو تا تصمیمی که همین عضو ثبت کرده — میانگین نیست تا یک تصمیم دیرهنگام کل عدد را خراب نکند.
            </p>
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Card>
              <CardHeader title="سرعت پاسخ به کارجو" subtitle="سهم کارجوهایی که در ۷۲ ساعت تصمیم گرفتند" />
              <p className="text-[30px] font-extrabold text-ink hv-num leading-none">{data.fastShare === null ? '—' : faPercent(data.fastShare)}</p>
              <p className="text-[12px] text-ink-3 mt-2 leading-relaxed">
                {data.totals.decisions
                  ? `از ${faNumber(data.totals.decisions)} تصمیم ثبت‌شده در این بازه. کارجویی که هفته‌ها بی‌پاسخ می‌ماند، تجربه‌اش را به بازار می‌برد.`
                  : 'وقتی اولین تصمیم ثبت شود، این عدد محاسبه می‌شود.'}
              </p>
            </Card>

            <Card>
              <CardHeader title="توزیع بار تصمیم" subtitle="سهم پرکارترین عضو از تصمیم‌های این بازه" />
              <p className="text-[30px] font-extrabold text-ink hv-num leading-none">{data.concentration === null ? '—' : faPercent(data.concentration)}</p>
              <p className="text-[12px] text-ink-3 mt-2 leading-relaxed">
                {data.concentration === null
                  ? 'هنوز تصمیمی ثبت نشده است.'
                  : data.concentration >= 70
                    ? 'بیشتر تصمیم‌ها روی یک نفر است؛ اگر او مرخص شود، صف می‌ایستد. ارزش دیدن دارد، نه قضاوت.'
                    : 'تصمیم‌ها بین اعضا پخش است؛ خطر توقف صف با غیبت یک نفر کم است.'}
              </p>
            </Card>

            <Card>
              <CardHeader title="چرا این اعداد قابل اتکا هستند" subtitle="از چه چیزی ساخته شده‌اند" />
              <ul className="text-[12.5px] text-ink-2 leading-relaxed flex flex-col gap-2 list-disc pr-4">
                <li>تصمیم‌ها از پروندهٔ خود کارجو خوانده می‌شوند، نه از حدس.</li>
                <li>مصاحبه فقط وقتی شمرده می‌شود که زمانش گذشته و لغو نشده باشد.</li>
                <li>کارت ارزیابی و یادداشت با نام نویسنده‌شان ثبت می‌شوند.</li>
                <li>هیچ‌چیز از «تعداد کلیک» یا زمان آنلاین بودن ساخته نمی‌شود.</li>
              </ul>
            </Card>
          </div>

          <Callout tone="info" icon={Timer} title="این گزارش چه چیزی نیست">
            این جدول کیفیت تصمیم‌ها را داوری نمی‌کند و برای رتبه‌بندی سالانه ساخته نشده است. کسی که فقط در مصاحبه‌های فنی شرکت می‌کند ممکن است
            تصمیم کمتری ثبت کند و همین درست باشد. برای قضاوت کیفیت، <span className="font-semibold">کارت ارزیابی</span> و معیارهای همان فرصت شغلی هست.
          </Callout>
        </div>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { Building2, Info, Lock, Scale, ShieldCheck, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Callout, Card, CardHeader, ErrorState, Segmented, Skeleton, Stat, Chip, ButtonLink } from '../components/ui';
import { ReportTabs } from '../components/reports/ReportTabs';
import { api } from '../lib/api';
import { faNumber, toPersianDigits } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useCan } from '../lib/auth';
import { useTitle } from '../lib/useTitle';
import type { ReportRange } from '../types/app';
import type { EeoCell } from '../types/eeo';

const RANGES: { id: ReportRange; label: string }[] = [
  { id: '30', label: '۳۰ روز' },
  { id: '90', label: '۹۰ روز' },
  { id: '365', label: 'یک سال' },
  { id: 'all', label: 'همه' },
];

/**
 * «برابری فرصت‌ها» — the report that has to be boring to be useful.
 *
 * No score, no ranking, no «good/bad» colour on a category. Just: how many people
 * in each group applied, how many were hired, and — when the group is too small
 * to mean anything — no number at all. The page says in words when the data
 * cannot support a conclusion, because that is the honest reading.
 */
export default function EeoReport() {
  useTitle('گزارش برابری فرصت‌ها');
  const can = useCan('admin');
  const { query } = useLocation();
  const range = (query.get('range') as ReportRange) || '90';
  const [reloadKey, setReloadKey] = useState(0);
  const dataQ = useAsync(() => (can ? api.insights.eeoReport(range) : Promise.resolve(null)), [range, can, reloadKey]);
  const data = dataQ.data;

  const totalCell = useMemo(() => {
    if (!data) return '';
    return data.disclosed ? `${faNumber(data.disclosedRate)}٪ پاسخ داده‌اند` : 'هنوز پاسخی ثبت نشده';
  }, [data]);

  if (!can) {
    return (
      <div>
        <PageHeader title="برابری فرصت‌ها" subtitle="اطلاعات داوطلبانهٔ کارجو، فقط تجمیعی" />
        <Card>
          <div className="flex items-start gap-3">
            <Lock className="w-5 h-5 text-ink-3 mt-0.5" />
            <div>
              <p className="text-[14px] font-bold text-ink">این گزارش فقط برای مدیر فضای کاری است</p>
              <p className="text-[13px] text-ink-3 mt-1.5 leading-relaxed">
                اطلاعات برابری فرصت‌ها هرگز کنار نام کارجو به اعضا نشان داده نمی‌شود؛ حتی شمار تجمیعی آن هم به مدیر محدود است. اگر برای کار
                تیم جذب لازم است، از مدیر بخواهید گزارش را بگیرد.
              </p>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="برابری فرصت‌ها"
        subtitle="آیا در هر مرحله، گروهی را بیشتر کنار می‌گذاریم؟ — فقط توصیف، بدون داوری"
        actions={<Segmented<ReportRange> value={range} onChange={(r) => setQuery({ range: r === '90' ? null : r })} items={RANGES} />}
      />
      <ReportTabs active="eeo" />

      {dataQ.error && <ErrorState message={dataQ.error} onRetry={() => setReloadKey((k) => k + 1)} />}
      {!dataQ.error && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[280px] rounded-card" />
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-5">
          {!data.enabled && (
            <Callout tone="warning" icon={Info} title="این گزارش خاموش است">
              هیچ اطلاعاتی از کارجوها ذخیره نمی‌شود تا وقتی «برابری فرصت‌ها» را در تنظیمات › سازمان روشن کنید. عددهای صفر زیر یعنی «داده‌ای
              نداریم»، نه «تفاوتی وجود ندارد».{' '}
              <ButtonLink to="/app/settings/org" variant="ghost" size="sm">
                رفتن به تنظیمات
              </ButtonLink>
            </Callout>
          )}

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon={Users} label="درخواست در این بازه" value={faNumber(data.total)} note={`${faNumber(data.disclosed)} پاسخ داوطلبانه`} tone="brand" />
            <Stat icon={Scale} label="نرخ پاسخ داوطلبانه" value={`${toPersianDigits(data.disclosedRate)}٪`} note={totalCell} tone={data.disclosedRate >= 50 ? 'high' : 'review'} />
            <Stat icon={ShieldCheck} label="حداقل اندازهٔ گروه" value={`${faNumber(data.threshold)} نفر`} note="گروه‌های کوچک‌تر پنهان می‌شوند" />
            <Stat icon={Building2} label="فرصت‌های دارای درخواست" value={faNumber(data.byJob.length)} note="در همین بازه" />
          </div>

          <Callout tone="info" icon={Info}>
            {data.note}
          </Callout>

          <div className="grid lg:grid-cols-2 gap-5">
            {data.dimensions.map((dim) => (
              <Card key={dim.dimension}>
                <CardHeader title={dim.title} subtitle={dim.note} />
                <div className="space-y-2.5">
                  {dim.cells.map((c: EeoCell) => (
                    <div key={c.key} className="rounded-[12px] border border-line-2 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[13px] font-semibold text-ink">{c.label}</p>
                        {c.hidden ? (
                          <Chip tone="neutral" icon={Lock}>
                            کمتر از {faNumber(data.threshold)} نفر
                          </Chip>
                        ) : (
                          <span className="text-[12px] text-ink-3 hv-num">
                            {faNumber(c.applied)} درخواست، {faNumber(c.hired)} استخدام
                          </span>
                        )}
                      </div>
                      {!c.hidden && c.applied > 0 && (
                        <div className="mt-2 h-1.5 rounded-full bg-canvas overflow-hidden">
                          <div className="h-full bg-brand" style={{ width: `${Math.min(100, c.hireRate || 0)}%` }} />
                        </div>
                      )}
                      {!c.hidden && c.applied > 0 && (
                        <p className="text-[11.5px] text-ink-4 mt-1.5">نرخ استخدام در این گروه: {toPersianDigits(c.hireRate ?? 0)}٪</p>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader title="درخواست و استخدام به تفکیک فرصت شغلی" subtitle="برای دیدن اینکه آیا یک نقش خاص، گروه خاصی را جذب می‌کند" />
            {data.byJob.length === 0 ? (
              <p className="text-[13px] text-ink-3">در این بازه درخواستی ثبت نشده است.</p>
            ) : (
              <div className="overflow-x-auto hv-scroll">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-ink-3 text-right">
                      <th className="py-2 font-medium">فرصت شغلی</th>
                      <th className="py-2 font-medium">درخواست</th>
                      <th className="py-2 font-medium">استخدام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byJob.map((j) => (
                      <tr key={j.jobId} className="border-t border-line-2">
                        <td className="py-2 text-ink">{j.jobTitle}</td>
                        <td className="py-2 hv-num text-ink-2">{j.hidden ? '—' : faNumber(j.applied)}</td>
                        <td className="py-2 hv-num text-ink-2">{j.hidden ? '—' : faNumber(j.hired)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="این گزارش چه چیزی را نشان نمی‌دهد" subtitle="صادقانه، تا کسی از عدد بیشتر از واقعیت نتیجه نگیرد" />
            <ul className="text-[12.5px] text-ink-2 leading-relaxed list-disc pr-4 space-y-1.5">
              <li>پاسخ‌های «ترجیح می‌دهم نگویم» جدا شمرده می‌شوند و هرگز با حدس پر نمی‌شوند.</li>
              <li>گروه کوچک‌تر از حدِ پنهان‌سازی عدد ندارد؛ درصد روی سه نفر شایعه است، نه یافته.</li>
              <li>درصدها همبستگی را نشان می‌دهند، نه علت را. شاید نقش در شهر دیگری باشد یا شرایط شیفت متفاوت.</li>
              <li>هیچ تصمیمی در هویدا از این پاسخ‌ها استفاده نمی‌کند و هیچ غربالگری‌ای آن را نمی‌خواند.</li>
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}

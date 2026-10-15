import React from 'react';
import { Activity, AlertTriangle, BrainCircuit, Building2, FileStack, HardDrive, KeyRound, RefreshCw, Server, Users } from 'lucide-react';
import { Button, Card, CardHeader, Callout, ErrorState, Skeleton } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { navigate } from '../../lib/router';
import { faNumber, toPersianDigits } from '../../lib/format';
import { AdminHeader, MiniStat, Row, faBytes, faDateTime } from './shared';

export default function Overview() {
  const { data, error, loading, reload } = useAsync(() => adminApi.overview(), []);

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) {
    return (
      <div className="grid gap-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-card" />
          ))}
        </div>
      </div>
    );
  }

  const ai = data.ai;
  const maxDaily = Math.max(1, ...data.daily.map((d) => d.resumes));
  const formatTotal = data.formats.reduce((s, f) => s + f.count, 0) || 1;

  return (
    <div>
      <AdminHeader
        title="نمای کلی سامانه"
        subtitle="وضعیت همه فضاهای کاری، کاربران، تحلیل‌ها و موتور هوش مصنوعی در یک نگاه."
        actions={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={reload} loading={loading}>
            به‌روزرسانی
          </Button>
        }
      />

      {!ai.enabled && (
        <Callout
          tone="warning"
          title="هوش مصنوعی فعال نیست"
          className="mb-5"
          action={
            <Button size="sm" onClick={() => navigate('/admin/ai')}>
              افزودن کلید
            </Button>
          }
        >
          تا وقتی کلید معتبری ثبت نشود، رزومه‌ها با «تحلیل محلی» (کلیدواژه‌ای) سنجیده می‌شوند.
        </Callout>
      )}
      {ai.enabled && ai.invalid > 0 && (
        <Callout tone="danger" className="mb-5" title={`${faNumber(ai.invalid)} کلید پذیرفته نشده است`} action={<Button size="sm" variant="secondary" onClick={() => navigate('/admin/ai')}>بررسی کلیدها</Button>}>
          سرویس هوش مصنوعی این کلیدها را رد کرده است؛ تا اصلاح نشوند، سامانه از کلیدهای دیگر استفاده می‌کند.
        </Callout>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <MiniStat icon={Building2} label="فضاهای کاری" value={faNumber(data.orgs.total)} note={`${faNumber(data.orgs.newThisWeek)} تازه در هفته اخیر · ${faNumber(data.orgs.demo)} نمایشی`} tone="brand" />
        <MiniStat icon={Users} label="کاربران" value={faNumber(data.users.total)} note={`${faNumber(data.users.activeThisWeek)} ورود در هفته اخیر`} />
        <MiniStat icon={FileStack} label="رزومه‌های تحلیل‌شده" value={faNumber(data.resumes.total)} note={`${faNumber(data.resumes.thisWeek)} در هفته اخیر`} tone="brand" />
        <MiniStat icon={Activity} label="فرصت‌های شغلی" value={faNumber(data.jobs.total)} note={`${faNumber(data.jobs.open)} فرصت باز`} />
        <MiniStat
          icon={KeyRound}
          label="کلیدهای آماده"
          value={`${faNumber(ai.ready)} از ${faNumber(ai.keys)}`}
          note={ai.cooling ? `${faNumber(ai.cooling)} کلید موقتاً در استراحت` : 'همه کلیدها در دسترس'}
          tone={ai.ready ? 'brand' : 'review'}
        />
        <MiniStat icon={BrainCircuit} label="درخواست‌های هوش مصنوعی امروز" value={faNumber(ai.callsToday)} note={ai.failuresToday ? `${faNumber(ai.failuresToday)} خطا (با جابه‌جایی خودکار کلید)` : 'بدون خطا'} />
        <MiniStat icon={AlertTriangle} label="اطلاعات ناکافی / تحلیل محلی" value={`${faNumber(data.resumes.unjudgeable)} / ${faNumber(data.resumes.localEngine)}`} note={`${faNumber(data.resumes.aiEngine)} رزومه با هوش مصنوعی`} tone="review" />
        <MiniStat icon={HardDrive} label="فضای ذخیره‌سازی" value={faBytes(data.storageBytes)} note={`${faNumber(data.orgs.suspended)} فضای کاری معلق`} />
      </div>

      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-4 mt-4">
        <Card>
          <CardHeader title="فعالیت ۱۴ روز اخیر" subtitle="رزومه‌های تحلیل‌شده و فضاهای کاری تازه در هر روز" icon={Activity} />
          <div className="mt-4 flex items-end gap-1.5 h-[170px]" role="img" aria-label="نمودار رزومه‌های روزانه">
            {data.daily.map((d) => (
              <div key={d.day} className="flex-1 flex flex-col items-center gap-1 min-w-0 h-full justify-end" title={`${toPersianDigits(d.day)}: ${faNumber(d.resumes)} رزومه، ${faNumber(d.signups)} ثبت‌نام`}>
                <span className="text-[10px] text-ink-3 hv-num">{d.resumes ? faNumber(d.resumes) : ''}</span>
                <div className="w-full rounded-t-[5px] bg-brand/80" style={{ height: `${Math.max(2, (d.resumes / maxDaily) * 130)}px` }} />
                <span className={`w-1.5 h-1.5 rounded-full ${d.signups ? 'bg-review' : 'bg-transparent'}`} />
              </div>
            ))}
          </div>
          <div className="flex justify-between text-[10.5px] text-ink-4 mt-1.5 hv-num">
            <span>{toPersianDigits(data.daily[0]?.day || '')}</span>
            <span>{toPersianDigits(data.daily[data.daily.length - 1]?.day || '')}</span>
          </div>
          <p className="text-[11.5px] text-ink-3 mt-2 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-review" /> روزهایی که فضای کاری تازه ساخته شد
          </p>
        </Card>

        <Card>
          <CardHeader title="قالب فایل‌های دریافتی" subtitle="همه قالب‌ها پذیرفته و تحلیل می‌شوند" icon={FileStack} />
          {data.formats.length ? (
            <ul className="mt-3 flex flex-col gap-2.5">
              {data.formats.map((f) => (
                <li key={f.format}>
                  <div className="flex justify-between text-[12.5px] mb-1">
                    <span className="font-semibold text-ink-2">{f.format}</span>
                    <span className="text-ink-3 hv-num">{faNumber(f.count)}</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-line-2 overflow-hidden">
                    <div className="h-full bg-brand rounded-full" style={{ width: `${(f.count / formatTotal) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-3 mt-4">هنوز رزومه‌ای تحلیل نشده است.</p>
          )}
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="سرور" icon={Server} />
        <div className="grid sm:grid-cols-2 gap-x-8 mt-2">
          <Row label="نسخه هویدا">{data.server.version}</Row>
          <Row label="Node.js">
            <span className="hv-latin">{data.server.node}</span>
          </Row>
          <Row label="آغاز به کار">{faDateTime(data.server.startedAtISO)}</Row>
          <Row label="پوشه داده‌ها">
            <span className="hv-latin text-[12px]">{data.server.dataDir}</span>
          </Row>
          <Row label="مدیران سامانه">{faNumber(data.users.admins)}</Row>
          <Row label="کاربران غیرفعال">{faNumber(data.users.disabled)}</Row>
        </div>
      </Card>
    </div>
  );
}

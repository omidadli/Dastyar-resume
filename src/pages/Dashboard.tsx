import React from 'react';
import {
  ArrowLeft,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  Cpu,
  FileCheck2,
  Hourglass,
  Info,
  Plus,
  Sparkles,
  UploadCloud,
  UserPlus,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { ActivityRow } from '../components/layout/NotificationsPanel';
import { JobCard } from '../components/jobs/JobCard';
import { Button, ButtonLink, Callout, Card, CardHeader, EmptyState, ErrorState, MatchMeter, MatchPill, Monogram, Skeleton, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAnalysis } from '../lib/analysis';
import { useOnChange } from '../lib/events';
import { candidateName, faNumber, greeting, toPersianDigits } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';

export default function Dashboard() {
  useTitle('داشبورد');
  const { user, org, ai } = useAuth();
  const { runs } = useAnalysis();
  const { query } = useLocation();
  const { data, error, loading, reload } = useAsync(() => api.insights.dashboard(), []);
  useOnChange(['resumes', 'jobs', 'activity'], () => reload());

  const firstName = (user?.name || '').split(' ')[0];
  const isNew = data && data.kpis.totalJobs === 0;

  return (
    <div>
      <PageHeader
        title={`${greeting()}، ${firstName}`}
        subtitle={`نمای کلی جذب در ${org?.name || 'سازمان شما'}`}
        actions={
          <>
            <ButtonLink to="/app/reports" variant="secondary" className="max-sm:hidden">
              گزارش‌ها
            </ButtonLink>
            <ButtonLink to="/app/jobs/new" icon={Plus} className="sm:hidden">
              فرصت شغلی تازه
            </ButtonLink>
          </>
        }
      />

      {query.get('welcome') && isNew && (
        <Callout tone="brand" icon={Sparkles} className="mb-5" title={`به هویدا خوش آمدید${firstName ? `، ${firstName}` : ''}!`}>
          فضای کاری «{org?.name}» آماده است. با ساخت اولین فرصت شغلی شروع کنید؛ هویدا معیارها را پیشنهاد می‌دهد و شما ویرایش می‌کنید.
        </Callout>
      )}

      {error && <ErrorState message={error} onRetry={reload} />}

      {!error && (
        <>
          {/* KPIs */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            {loading && !data ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[92px] rounded-card" />)
            ) : (
              <>
                <Stat icon={BriefcaseBusiness} label="فرصت‌های شغلی باز" value={faNumber(data!.kpis.openJobs)} note={`از ${faNumber(data!.kpis.totalJobs)} فرصت ثبت‌شده`} tone="brand" />
                <Stat icon={FileCheck2} label="رزومه‌های تحلیل‌شده" value={faNumber(data!.kpis.analyzed30d)} note="در ۳۰ روز اخیر" />
                <Stat icon={Clock3} label="در انتظار تصمیم شما" value={faNumber(data!.kpis.pendingDecisions)} note="تطابق بالا یا نیازمند بررسی" tone="review" />
                <Stat icon={CheckCircle2} label="کاندیدای با تطابق بالا" value={faNumber(data!.kpis.highMatch)} note={`${faNumber(data!.kpis.decided30d)} تصمیم در ۳۰ روز اخیر`} tone="high" />
              </>
            )}
          </div>

          {isNew ? (
            <Card className="mt-5">
              <CardHeader title="سه قدم تا اولین فهرست کاندیداها" subtitle="کمتر از چند دقیقه طول می‌کشد." />
              <div className="grid md:grid-cols-3 gap-3">
                {[
                  { icon: BriefcaseBusiness, t: 'ساخت فرصت شغلی', d: 'عنوان و دپارتمان را وارد کنید تا معیارها پیشنهاد شود.', to: '/app/jobs/new', cta: 'ایجاد فرصت شغلی' },
                  { icon: UploadCloud, t: 'بارگذاری رزومه‌ها', d: 'PDF، Word، تصویر یا ZIP — تحلیل در پس‌زمینه انجام می‌شود.', to: '/app/jobs/new', cta: 'شروع' },
                  { icon: UserPlus, t: 'دعوت از همکاران', d: 'اعضای تیم را با نقش مدیر یا عضو اضافه کنید.', to: '/app/settings/team', cta: 'مدیریت تیم' },
                ].map((s, i) => (
                  <div key={s.t} className="rounded-[14px] border border-line p-4 flex flex-col">
                    <div className="flex items-center gap-2.5">
                      <span className="w-8 h-8 rounded-full bg-brand-soft text-brand-strong text-[13px] font-extrabold flex items-center justify-center hv-num">{toPersianDigits(i + 1)}</span>
                      <p className="text-[14px] font-bold text-ink">{s.t}</p>
                    </div>
                    <p className="text-[13px] text-ink-3 mt-2 leading-relaxed flex-1">{s.d}</p>
                    <Button variant={i === 0 ? 'primary' : 'secondary'} size="sm" className="mt-3 self-start" onClick={() => navigate(s.to)}>
                      {s.cta}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          ) : (
            <div className="grid xl:grid-cols-[1fr_360px] gap-5 mt-5">
              <div className="flex flex-col gap-5 min-w-0">
                {/* Pending decisions */}
                <Card padded={false}>
                  <div className="px-5 pt-5">
                    <CardHeader
                      title="در انتظار تصمیم شما"
                      subtitle="کاندیداهای با تطابق بالا یا نیازمند بررسی که هنوز تصمیمی برایشان ثبت نشده"
                      action={
                        <ButtonLink to="/app/candidates?tab=pending" variant="ghost" size="sm" iconEnd={ArrowLeft}>
                          همه
                        </ButtonLink>
                      }
                    />
                  </div>
                  {loading && !data ? (
                    <div className="px-5 pb-5 flex flex-col gap-3">
                      {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-12" />
                      ))}
                    </div>
                  ) : data!.pending.length === 0 ? (
                    <EmptyState icon={CheckCircle2} title="کاری در صف نیست" description="برای همه کاندیداهای مهم تصمیم گرفته‌اید." compact />
                  ) : (
                    <ul className="divide-y divide-line-2 pb-2">
                      {data!.pending.map((r) => (
                        <li key={r.id}>
                          <Link to={`/app/jobs/${r.jobId}?c=${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-canvas transition-colors">
                            <Monogram name={candidateName(r)} size={38} />
                            <div className="min-w-0 flex-1">
                              <p className="text-[13.5px] font-bold text-ink truncate" dir="auto">
                                {candidateName(r)}
                              </p>
                              <p className="text-[12px] text-ink-3 truncate">
                                {r.facts?.lastRole || '—'} · <span className="text-ink-2">{r.roleTitle || r.departmentName}</span>
                              </p>
                            </div>
                            <MatchPill category={r.category} size="sm" className="max-md:hidden" />
                            <MatchMeter score={r.score} category={r.category} className="w-[120px] max-sm:hidden" />
                            <ArrowLeft className="w-4 h-4 text-ink-4 shrink-0" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                {/* Active jobs */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="text-[15px] font-bold text-ink">فرصت‌های شغلی فعال</h2>
                    <ButtonLink to="/app/jobs" variant="ghost" size="sm" iconEnd={ArrowLeft}>
                      همه فرصت‌ها
                    </ButtonLink>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3 sm:gap-4">
                    {loading && !data
                      ? Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-[210px] rounded-card" />)
                      : data!.jobs.map((j) => <JobCard key={j.id} job={j} running={runs.some((r) => r.jobId === j.id && r.status === 'running')} />)}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-5">
                {data && (
                  <Card>
                    <div className="flex items-start gap-3">
                      <span className="w-10 h-10 rounded-[11px] bg-brand-soft text-brand-strong flex items-center justify-center shrink-0">
                        <Hourglass className="w-5 h-5" strokeWidth={1.7} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[12.5px] text-ink-3 font-medium">زمان صرفه‌جویی‌شده (برآورد)</p>
                        <p className="text-[24px] font-extrabold text-ink hv-num leading-tight mt-1">
                          حدود {faNumber(data.timeSaved.hours, 1)} <span className="text-[14px] font-bold text-ink-2">ساعت</span>
                        </p>
                      </div>
                    </div>
                    <p className="text-[12px] text-ink-3 mt-3 leading-relaxed flex items-start gap-1.5">
                      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        فرض محاسبه: خواندن دستی هر رزومه حدود {faNumber(data.timeSaved.minutesManual)} دقیقه و مرور تحلیل هویدا حدود{' '}
                        {faNumber(data.timeSaved.minutesWithHovida, 1)} دقیقه، برای {faNumber(data.timeSaved.resumes)} رزومه تحلیل‌شده. این عدد اندازه‌گیری نشده است.
                      </span>
                    </p>
                  </Card>
                )}

                {ai && (!ai.available || (data && data.aiShare.local > 0)) && (
                  <Callout
                    tone={ai.available ? 'info' : 'warning'}
                    icon={Cpu}
                    title={ai.available ? 'بخشی از تحلیل‌ها با موتور محلی انجام شده' : 'هوش مصنوعی روی سرور فعال نیست'}
                    action={
                      <ButtonLink to="/app/settings/ai" variant="ghost" size="sm">
                        جزئیات
                      </ButtonLink>
                    }
                  >
                    {ai.available
                      ? `${faNumber(data?.aiShare.local || 0)} رزومه با تطبیق کلیدواژه‌ای تحلیل شده‌اند؛ می‌توانید آن‌ها را دوباره با هوش مصنوعی تحلیل کنید.`
                      : 'رزومه‌های تازه با موتور محلی (کلیدواژه‌ای) و با برچسب جداگانه تحلیل می‌شوند.'}
                  </Callout>
                )}

                <Card padded={false}>
                  <div className="px-5 pt-5">
                    <CardHeader title="فعالیت تیم" subtitle="آخرین رویدادهای فضای کاری" />
                  </div>
                  <div className="px-2 pb-3">
                    {loading && !data ? (
                      <div className="px-3 flex flex-col gap-3 pb-3">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Skeleton key={i} className="h-10" />
                        ))}
                      </div>
                    ) : data!.activity.length === 0 ? (
                      <p className="px-3 pb-3 text-[13px] text-ink-3">هنوز فعالیتی ثبت نشده است.</p>
                    ) : (
                      data!.activity.map((a) => <ActivityRow key={a.id} item={a} />)
                    )}
                  </div>
                </Card>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

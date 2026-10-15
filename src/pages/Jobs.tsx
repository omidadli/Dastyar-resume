import React, { useState } from 'react';
import { BriefcaseBusiness, Plus } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { JobCard } from '../components/jobs/JobCard';
import { ButtonLink, EmptyState, ErrorState, SearchInput, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useAnalysis } from '../lib/analysis';
import { useOnChange } from '../lib/events';
import { faNumber } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useAsync, useDebounced } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';

type StatusFilter = 'all' | 'open' | 'paused' | 'closed';

export default function Jobs() {
  useTitle('فرصت‌های شغلی');
  const { query } = useLocation();
  const status = (query.get('status') as StatusFilter) || 'all';
  const [q, setQ] = useState(query.get('q') || '');
  const dq = useDebounced(q, 250);
  const { runs } = useAnalysis();
  const { data, error, loading, reload } = useAsync(() => api.jobs.list({ status, q: dq }), [status, dq]);
  useOnChange(['jobs', 'resumes'], () => reload());

  const counts = data?.counts;
  return (
    <div>
      <PageHeader
        title="فرصت‌های شغلی"
        subtitle={counts ? `${faNumber(counts.open)} فرصت باز از ${faNumber(counts.all)} فرصت ثبت‌شده` : 'هر فرصت شغلی معیارها و پرسش‌نامه اختصاصی خودش را دارد.'}
        actions={
          <ButtonLink to="/app/jobs/new" icon={Plus}>
            ایجاد فرصت شغلی
          </ButtonLink>
        }
      />
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-5">
        <Segmented<StatusFilter>
          value={status}
          onChange={(v) => setQuery({ status: v === 'all' ? null : v })}
          items={[
            { id: 'all', label: 'همه', count: counts?.all },
            { id: 'open', label: 'باز', count: counts?.open },
            { id: 'paused', label: 'متوقف', count: counts?.paused },
            { id: 'closed', label: 'بسته‌شده', count: counts?.closed },
          ]}
        />
        <SearchInput value={q} onChange={setQ} placeholder="جست‌وجوی عنوان، دپارتمان یا شهر…" className="sm:w-[300px] sm:mr-auto" />
      </div>

      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[214px] rounded-card" />
          ))}
        </div>
      ) : data!.items.length === 0 ? (
        <div className="hv-card">
          {counts?.all === 0 ? (
            <EmptyState
              icon={BriefcaseBusiness}
              title="هنوز فرصت شغلی‌ای ثبت نشده است"
              description="اولین فرصت شغلی را بسازید؛ هویدا معیارهای ارزیابی و پرسش‌نامه را پیشنهاد می‌دهد و شما رزومه‌ها را بارگذاری می‌کنید."
              action={
                <ButtonLink to="/app/jobs/new" icon={Plus}>
                  ایجاد اولین فرصت شغلی
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState icon={BriefcaseBusiness} title="موردی با این فیلتر پیدا نشد" description="فیلتر وضعیت یا عبارت جست‌وجو را تغییر دهید." compact />
          )}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data!.items.map((j) => (
            <JobCard key={j.id} job={j} running={runs.some((r) => r.jobId === j.id && r.status === 'running')} />
          ))}
        </div>
      )}
    </div>
  );
}

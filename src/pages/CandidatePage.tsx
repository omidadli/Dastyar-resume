import React from 'react';
import { PageHeader } from '../components/layout/AppShell';
import { CandidatePanel } from '../components/candidates/CandidatePanel';
import { ResumePreview } from '../components/candidates/ResumePreview';
import { ErrorState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { candidateName } from '../lib/format';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';

export default function CandidatePage({ id }: { id: string }) {
  const q = useAsync((signal) => api.resumes.get(id, { signal }), [id]);
  const rec = q.data?.record;
  const job = q.data?.job;
  useTitle(rec ? candidateName(rec) : 'کاندید');

  if (q.error) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!rec) {
    return (
      <div className="grid xl:grid-cols-[460px_1fr] gap-5">
        <Skeleton className="h-[640px] rounded-card" />
        <Skeleton className="h-[640px] rounded-card" />
      </div>
    );
  }
  const { extractedText: _t, ...item } = rec;
  return (
    <div>
      <PageHeader
        breadcrumb={[
          { label: 'فرصت‌های شغلی', to: '/app/jobs' },
          ...(job ? [{ label: job.roleTitle, to: `/app/jobs/${job.id}?c=${rec.id}` }] : []),
          { label: candidateName(rec) },
        ]}
        title={candidateName(rec)}
        subtitle={job ? `کاندید «${job.roleTitle}» · ${job.departmentName}` : rec.departmentName}
      />
      <div className="grid xl:grid-cols-[460px_minmax(0,1fr)] gap-5 items-start">
        <div className="hv-card overflow-hidden xl:sticky xl:top-[88px] xl:h-[calc(100vh-108px)]">
          <CandidatePanel
            record={item}
            jobTitle={job?.roleTitle}
            criteria={job?.understanding.criteria}
            variant="page"
            onChange={(r) => q.setData((d) => (d ? { ...d, record: { ...d.record, ...r } } : d))}
            onDeleted={() => navigate(job ? `/app/jobs/${job.id}` : '/app/candidates', { replace: true, force: true })}
          />
        </div>
        <ResumePreview record={rec} className="min-h-[70vh] xl:h-[calc(100vh-108px)]" />
      </div>
    </div>
  );
}

import React from 'react';
import { Clock3, Loader2, MapPin, Users } from 'lucide-react';
import type { JobSummary } from '../../types/screening';
import { Link } from '../../lib/router';
import { EMPLOYMENT_LABELS } from '../../lib/match';
import { faNumber, faRelative } from '../../lib/format';
import { DistributionBar, JobStatusPill } from '../ui';

export function JobCard({ job, running, titleAs: Heading = 'h2' }: { job: JobSummary; running?: boolean; titleAs?: 'h2' | 'h3' }) {
  const s = job.stats;
  return (
    <Link
      to={`/app/jobs/${job.id}`}
      className="hv-card p-4 sm:p-5 flex flex-col gap-4 hover:border-line-strong hover:shadow-raise transition-[box-shadow,border-color] group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Heading className="text-[15.5px] font-bold text-ink leading-snug group-hover:text-brand-stronger transition-colors truncate">{job.roleTitle}</Heading>
          <p className="text-[12.5px] text-ink-3 mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>{job.departmentName}</span>
            {job.location && (
              <span className="inline-flex items-center gap-0.5">
                <MapPin className="w-3 h-3" />
                {job.location}
              </span>
            )}
            {job.employmentType && <span>{EMPLOYMENT_LABELS[job.employmentType]}</span>}
          </p>
        </div>
        <JobStatusPill status={job.status} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-[10px] bg-canvas py-2">
          <p className="text-[17px] font-extrabold text-ink hv-num">{faNumber(s.total)}</p>
          <p className="text-[11px] text-ink-3">رزومه</p>
        </div>
        <div className="rounded-[10px] bg-high-soft/70 py-2">
          <p className="text-[17px] font-extrabold text-high-ink hv-num">{faNumber(s.interview)}</p>
          <p className="text-[11px] text-high-ink/80">تطابق بالا</p>
        </div>
        <div className="rounded-[10px] bg-canvas py-2">
          <p className="text-[17px] font-extrabold text-ink hv-num">{faNumber(s.undecided)}</p>
          <p className="text-[11px] text-ink-3">بدون تصمیم</p>
        </div>
      </div>

      <DistributionBar high={s.interview} review={s.review} low={s.reject} insufficient={s.unjudgeable + s.error} />

      <div className="flex items-center justify-between text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1">
          {running || job.analysisStatus === 'processing' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" /> در حال تحلیل…
            </>
          ) : (
            <>
              <Clock3 className="w-3.5 h-3.5" /> {faRelative(job.updatedAtISO)}
            </>
          )}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="w-3.5 h-3.5" />
          {faNumber(s.approved)} تأیید
        </span>
      </div>
    </Link>
  );
}

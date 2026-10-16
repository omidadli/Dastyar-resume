import React, { useEffect, useMemo, useState } from 'react';
import { Columns3, ExternalLink, Trophy, X } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { DecisionBar } from '../components/candidates/CandidatePanel';
import { ButtonLink, Callout, Chip, ConfidenceBadge, EmptyState, EngineBadge, ErrorState, IconButton, MatchPill, Monogram, ScoreBadge, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { removeFromCompare, useCompare } from '../lib/compare';
import { candidateName, toPersianDigits } from '../lib/format';
import { Link, navigate, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { Job, ResumeListItem } from '../types/screening';

interface CompareData {
  job: Job | null;
  items: ResumeListItem[];
  droppedOtherJobs: boolean;
  missingIds?: string[];
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <tr className="align-top">
      <th scope="row" className="sticky right-0 z-[1] bg-surface text-right font-semibold text-[12.5px] text-ink-3 py-3.5 pr-4 pl-3 border-b border-line-2 w-[150px] min-w-[150px]">
        {label}
        {hint && <span className="block text-[11px] font-normal text-ink-4 mt-0.5">{hint}</span>}
      </th>
      {children}
    </tr>
  );
}

function Cell({ children, best }: { children: React.ReactNode; best?: boolean }) {
  return <td className={`py-3.5 px-3 border-b border-line-2 min-w-[220px] text-[13px] text-ink-2 leading-relaxed ${best ? 'bg-high-soft/50' : ''}`}>{children}</td>;
}

export default function Compare() {
  useTitle('مقایسه کاندیداها');
  const { query } = useLocation();
  const tray = useCompare();
  const idsParam = query.get('ids');
  const ids = Array.from(new Set((idsParam ? idsParam.split(',') : tray.items.map((i) => i.id)).filter(Boolean))).slice(0, 4);
  const q = useAsync<CompareData | null>(
    () =>
      ids.length
        ? api.resumes.compare(ids).catch((err) => {
            // None of them exists any more (deleted): an empty comparison, not an error page.
            if (err?.status === 404) return { job: null, items: [], droppedOtherJobs: false, missingIds: ids };
            throw err;
          })
        : Promise.resolve(null),
    [ids.join(',')]
  );
  const data = q.data;
  const items = useMemo(() => data?.items || [], [data]);
  const job = data?.job;
  // Deleted candidates leave the tray as well, so it stops offering them. The
  // notice stays put although the trimmed tray triggers a fresh request.
  const [missing, setMissing] = useState(0);
  useEffect(() => {
    if (!data?.missingIds?.length) return;
    setMissing(data.missingIds.length);
    removeFromCompare(...data.missingIds);
  }, [data]);

  const updateItem = (u: ResumeListItem) =>
    q.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === u.id ? u : x)) } : d));

  const sharedSkills = useMemo(() => {
    const counts = new Map<string, number>();
    items.forEach((r) => new Set(r.facts?.skills || []).forEach((s) => counts.set(s, (counts.get(s) || 0) + 1)));
    return new Set(Array.from(counts.entries()).filter(([, n]) => n >= 2).map(([s]) => s));
  }, [items]);

  const remove = (id: string) => {
    removeFromCompare(id);
    const rest = ids.filter((x) => x !== id);
    navigate(rest.length ? `/app/compare?ids=${rest.join(',')}` : '/app/compare', { replace: true, keepScroll: true });
  };

  if (!ids.length || (data && !job)) {
    return (
      <div>
        <PageHeader title="مقایسه کاندیداها" subtitle="تا چهار کاندید از یک فرصت شغلی را معیار به معیار کنار هم ببینید." />
        {missing > 0 && (
          <Callout tone="info" className="mb-4">
            کاندیداهای انتخاب‌شده حذف شده‌اند و از مقایسه کنار رفتند.
          </Callout>
        )}
        <div className="hv-card">
          <EmptyState
            icon={Columns3}
            title="هنوز کاندیدی برای مقایسه انتخاب نکرده‌اید"
            description="در صفحه یک فرصت شغلی، چند کاندید را تیک بزنید و «مقایسه» را انتخاب کنید، یا در جزئیات کاندید «افزودن به مقایسه» را بزنید."
            action={<ButtonLink to="/app/jobs">رفتن به فرصت‌های شغلی</ButtonLink>}
          />
        </div>
      </div>
    );
  }

  if (q.error) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!job) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-[520px] rounded-card" />
      </div>
    );
  }

  const criteria = job.understanding.criteria;
  const bestOf = (vals: (number | null | undefined)[]) => {
    const nums = vals.filter((v): v is number => typeof v === 'number');
    if (nums.length < 2) return null;
    const max = Math.max(...nums);
    return nums.filter((n) => n === max).length === nums.length ? null : max;
  };
  const bestScore = bestOf(items.map((r) => (r.category === 'UNJUDGEABLE' || r.category === 'ERROR' ? null : r.score)));
  const bestYears = bestOf(items.map((r) => r.facts?.yearsExperience));

  return (
    <div>
      <PageHeader
        breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }, { label: job.roleTitle, to: `/app/jobs/${job.id}` }, { label: 'مقایسه' }]}
        title="مقایسه کاندیداها"
        subtitle={`${toPersianDigits(items.length)} کاندید «${job.roleTitle}» — خانه‌های سبز بهترین مقدار هر ردیف‌اند.`}
        actions={
          <ButtonLink to={`/app/jobs/${job.id}`} variant="secondary">
            افزودن کاندید دیگر
          </ButtonLink>
        }
      />
      {data?.droppedOtherJobs && (
        <Callout tone="info" className="mb-4">
          فقط کاندیداهای یک فرصت شغلی قابل مقایسه‌اند؛ موارد مربوط به فرصت‌های دیگر کنار گذاشته شدند.
        </Callout>
      )}
      {missing > 0 && (
        <Callout tone="info" className="mb-4">
          {toPersianDigits(missing)} کاندید انتخاب‌شده حذف شده بود و از مقایسه کنار رفت.
        </Callout>
      )}
      {items.length === 1 && (
        <Callout tone="info" className="mb-4">
          برای مقایسه دست‌کم یک کاندید دیگر از همین فرصت شغلی اضافه کنید.
        </Callout>
      )}
      <div className="hv-card overflow-x-auto hv-scroll">
        <table className="w-full border-separate border-spacing-0">
          <thead>
            <tr>
              <th className="sticky right-0 z-[2] bg-surface border-b border-line w-[150px]" />
              {items.map((r) => (
                <th key={r.id} className="p-4 border-b border-line text-right align-top min-w-[220px]">
                  <div className="flex items-start gap-3">
                    <Monogram name={candidateName(r)} size={42} />
                    <div className="min-w-0 flex-1">
                      <Link to={`/app/candidates/${r.id}`} className="text-[14px] font-bold text-ink hover:text-brand-ink truncate block" dir="auto">
                        {candidateName(r)}
                      </Link>
                      <p className="text-[12px] text-ink-3 font-normal truncate">{r.facts?.lastRole || '—'}</p>
                    </div>
                    <IconButton icon={X} label="حذف از مقایسه" size="sm" onClick={() => remove(r.id)} />
                  </div>
                  <div className="flex items-center gap-3 mt-3">
                    <ScoreBadge score={r.score} category={r.category} size={50} />
                    <div className="flex flex-col gap-1.5 items-start">
                      <MatchPill category={r.category} size="sm" />
                      {bestScore !== null && r.score === bestScore && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-high-ink">
                          <Trophy className="w-3.5 h-3.5" /> بیشترین تطابق
                        </span>
                      )}
                    </div>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <Row label="چرا این میزان تطابق؟">
              {items.map((r) => (
                <Cell key={r.id}>{r.whyCategory || r.unjudgeableReason || '—'}</Cell>
              ))}
            </Row>
            {criteria.map((c) => {
              const scores = items.map((r) => r.criterionScores.find((x) => x.criterionId === c.id)?.score ?? null);
              const best = bestOf(scores);
              return (
                <Row key={c.id} label={c.title} hint={`وزن ${toPersianDigits(c.weight)}٪${c.mustHave ? ' · الزامی' : ''}`}>
                  {items.map((r, i) => {
                    const cs = r.criterionScores.find((x) => x.criterionId === c.id);
                    const sc = scores[i];
                    return (
                      <Cell key={r.id} best={best !== null && sc === best}>
                        {cs ? (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="text-[13px] font-bold text-ink hv-num w-8">{toPersianDigits(cs.score)}</span>
                              <div className="flex-1 h-1.5 rounded-full bg-line-2 overflow-hidden">
                                <div className={`h-full rounded-full ${cs.score >= 70 ? 'bg-high' : cs.score >= 45 ? 'bg-review' : 'bg-low'}`} style={{ width: `${cs.score}%` }} />
                              </div>
                            </div>
                            <p className="text-[12px] text-ink-3 mt-1.5 line-clamp-2">{cs.rationale}</p>
                          </>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </Cell>
                    );
                  })}
                </Row>
              );
            })}
            <Row label="سابقه کار">
              {items.map((r) => (
                <Cell key={r.id} best={bestYears !== null && r.facts?.yearsExperience === bestYears}>
                  {r.facts?.yearsExperience != null ? `${toPersianDigits(r.facts.yearsExperience)} سال` : <span className="text-ink-4">ذکر نشده</span>}
                </Cell>
              ))}
            </Row>
            <Row label="تحصیلات">
              {items.map((r) => (
                <Cell key={r.id}>{r.facts?.education || <span className="text-ink-4">ذکر نشده</span>}</Cell>
              ))}
            </Row>
            <Row label="محل سکونت">
              {items.map((r) => (
                <Cell key={r.id}>{r.contact?.city || <span className="text-ink-4">ذکر نشده</span>}</Cell>
              ))}
            </Row>
            <Row label="حقوق درخواستی">
              {items.map((r) => (
                <Cell key={r.id}>{r.facts?.expectedSalary || <span className="text-ink-4">ذکر نشده</span>}</Cell>
              ))}
            </Row>
            <Row label="مهارت‌ها" hint="سبز: مشترک بین کاندیداها">
              {items.map((r) => (
                <Cell key={r.id}>
                  <div className="flex flex-wrap gap-1">
                    {(r.facts?.skills || []).map((s) => (
                      <Chip key={s} tone={sharedSkills.has(s) ? 'brand' : 'neutral'}>
                        {s}
                      </Chip>
                    ))}
                    {!r.facts?.skills?.length && <span className="text-ink-4">—</span>}
                  </div>
                </Cell>
              ))}
            </Row>
            <Row label="دلایل تطابق">
              {items.map((r) => (
                <Cell key={r.id}>
                  <ul className="flex flex-col gap-1">
                    {r.strengths.slice(0, 3).map((s, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className="text-high mt-0.5">●</span>
                        {s.point}
                      </li>
                    ))}
                    {!r.strengths.length && <li className="text-ink-4">—</li>}
                  </ul>
                </Cell>
              ))}
            </Row>
            <Row label="نکات قابل بررسی">
              {items.map((r) => (
                <Cell key={r.id}>
                  <ul className="flex flex-col gap-1">
                    {r.weaknesses.slice(0, 3).map((s, i) => (
                      <li key={i} className="flex gap-1.5">
                        <span className={`${s.severity === 'knockout' ? 'text-low' : 'text-review'} mt-0.5`}>●</span>
                        {s.point}
                      </li>
                    ))}
                    {!r.weaknesses.length && <li className="text-ink-4">—</li>}
                  </ul>
                </Cell>
              ))}
            </Row>
            <Row label="منبع تحلیل">
              {items.map((r) => (
                <Cell key={r.id}>
                  <div className="flex flex-col gap-1.5 items-start">
                    <EngineBadge engine={r.engine} />
                    <ConfidenceBadge confidence={r.confidence} />
                  </div>
                </Cell>
              ))}
            </Row>
            <Row label="تصمیم شما">
              {items.map((r) => (
                <Cell key={r.id}>
                  <DecisionBar record={r} compact short onChange={updateItem} />
                  <Link to={`/app/candidates/${r.id}`} className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-ink mt-2.5 hover:underline">
                    <ExternalLink className="w-3.5 h-3.5" />
                    رزومه کامل
                  </Link>
                </Cell>
              ))}
            </Row>
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-ink-4 mt-3">
        مقایسه بر اساس تحلیل هوش مصنوعی و متن رزومه‌هاست؛ پیش از تصمیم نهایی، رزومه کامل را هم ببینید.
      </p>
    </div>
  );
}

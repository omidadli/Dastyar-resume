import React, { useEffect, useState } from 'react';
import { CheckCircle2, Plus, UploadCloud, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { CandidatePanel } from '../components/candidates/CandidatePanel';
import { CandidateTable } from '../components/candidates/CandidateTable';
import { Button, Card, Drawer, EmptyState, ErrorState, Pagination, SearchInput, Segmented, Select, Tabs } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useOnChange } from '../lib/events';
import { jalaliDaysAgo } from '../lib/format';
import { MATCH_FILTERS } from '../lib/match';
import { navigate, setQuery, useLocation } from '../lib/router';
import { useAsync, useDebounced } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { Criterion, DecisionFilter, MatchFilter, ResumeListItem, ResumeSort } from '../types/screening';

type Tab = 'pending' | 'all' | 'approved' | 'review' | 'rejected';
const TAB_TO_DECISION: Record<Tab, DecisionFilter> = { pending: 'pending', all: 'all', approved: 'approved', review: 'review', rejected: 'rejected' };

export default function Candidates() {
  useTitle('رزومه‌ها');
  const { org } = useAuth();
  const { query } = useLocation();
  const tab = (query.get('tab') as Tab) || 'pending';
  const [jobId, setJobId] = useState(query.get('job') || '');
  const [dept, setDept] = useState('');
  const [range, setRange] = useState('all');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [sort, setSort] = useState<ResumeSort>('match');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput, 250);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [tab, jobId, dept, range, match, sort, q]);
  useEffect(() => {
    if (tab === 'approved' || tab === 'rejected' || tab === 'review') setSort('decided');
    else setSort('match');
  }, [tab]);

  const jobsQ = useAsync(() => api.jobs.list(), []);
  const listQ = useAsync(
    (signal) =>
      api.resumes.list(
        {
          decision: TAB_TO_DECISION[tab],
          jobId: jobId || undefined,
          departmentId: dept || undefined,
          match: tab === 'pending' ? 'all' : match,
          fromJalali: range === 'all' ? undefined : jalaliDaysAgo(Number(range)),
          sort,
          q,
          page,
          pageSize: 12,
        },
        { signal }
      ),
    [tab, jobId, dept, range, match, sort, q, page]
  );
  useOnChange(['resumes'], () => listQ.reload());

  const [selected, setSelected] = useState<ResumeListItem | null>(null);
  const [criteria, setCriteria] = useState<Criterion[] | undefined>(undefined);
  useEffect(() => {
    if (!selected) return;
    setCriteria(undefined);
    api.jobs
      .get(selected.jobId)
      .then(({ job }) => setCriteria(job.understanding.criteria))
      .catch(() => {});
  }, [selected?.jobId]);

  const counts = listQ.data?.counts;
  const items = listQ.data?.items || [];

  const update = (r: ResumeListItem) => {
    setSelected(r);
    listQ.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? r : x)) } : d));
  };

  return (
    <div>
      <PageHeader title="رزومه‌ها" subtitle="همه کاندیداهای فضای کاری، بر اساس میزان تطابق و تصمیم تیم" />
      <Tabs<Tab>
        className="mb-4"
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'pending' ? null : t })}
        items={[
          { id: 'pending', label: 'در انتظار تصمیم', count: counts?.pending },
          { id: 'approved', label: 'تأیید شده', count: counts?.approved },
          { id: 'review', label: 'نیاز به بررسی', count: counts?.reviewDecision },
          { id: 'rejected', label: 'رد شده', count: counts?.rejected },
          { id: 'all', label: 'همه', count: counts?.all },
        ]}
      />
      <Card padded={false}>
        <div className="p-4 sm:p-5 border-b border-line-2 flex flex-col gap-3">
          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <SearchInput value={qInput} onChange={setQInput} placeholder="نام، مهارت، شهر یا یادداشت…" className="lg:w-[280px]" size="sm" />
            <div className="flex flex-wrap items-center gap-2 lg:mr-auto">
              <Select
                compact
                aria-label="فرصت شغلی"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                options={[{ value: '', label: 'همه فرصت‌ها' }, ...(jobsQ.data?.items || []).map((j) => ({ value: j.id, label: j.roleTitle }))]}
              />
              <Select
                compact
                aria-label="دپارتمان"
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                options={[{ value: '', label: 'همه دپارتمان‌ها' }, ...(org?.departments || []).map((d) => ({ value: d.id, label: d.name }))]}
              />
              <Select
                compact
                aria-label="بازه زمانی"
                value={range}
                onChange={(e) => setRange(e.target.value)}
                options={[
                  { value: 'all', label: 'همه زمان‌ها' },
                  { value: '7', label: '۷ روز اخیر' },
                  { value: '30', label: '۳۰ روز اخیر' },
                  { value: '90', label: '۹۰ روز اخیر' },
                ]}
              />
              <Select
                compact
                aria-label="مرتب‌سازی"
                value={sort}
                onChange={(e) => setSort(e.target.value as ResumeSort)}
                options={[
                  { value: 'match', label: 'بیشترین تطابق' },
                  { value: 'decided', label: 'آخرین تصمیم' },
                  { value: 'newest', label: 'جدیدترین رزومه' },
                  { value: 'experience', label: 'بیشترین سابقه' },
                ]}
              />
            </div>
          </div>
          {tab !== 'pending' && (
            <Segmented<MatchFilter>
              size="sm"
              value={match}
              onChange={setMatch}
              items={MATCH_FILTERS.map((m) => ({ id: m.id, label: m.label }))}
            />
          )}
        </div>
        <div className="p-2 sm:p-0">
          {listQ.error ? (
            <ErrorState message={listQ.error} onRetry={listQ.reload} />
          ) : (
            <CandidateTable
              items={items}
              loading={listQ.loading}
              activeId={selected?.id}
              onOpen={setSelected}
              showJob
              emptyState={
                counts?.all === 0 && !q && !jobId && !dept && range === 'all' ? (
                  <EmptyState
                    icon={UploadCloud}
                    title="هنوز رزومه‌ای ثبت نشده است"
                    description="یک فرصت شغلی بسازید و رزومه‌ها را بارگذاری کنید؛ هویدا آن‌ها را با معیارهای همان فرصت می‌سنجد."
                    action={
                      <Button icon={Plus} onClick={() => navigate('/app/jobs/new')}>
                        ایجاد فرصت شغلی
                      </Button>
                    }
                    compact
                  />
                ) : tab === 'pending' && !q && !jobId && !dept ? (
                  <EmptyState icon={CheckCircle2} title="کاری در صف تصمیم نیست" description="برای همه کاندیداهای با تطابق بالا یا نیازمند بررسی تصمیم ثبت شده است." compact />
                ) : (
                  <EmptyState icon={Users} title="کاندیدایی پیدا نشد" description="فیلترها را تغییر دهید یا عبارت دیگری جست‌وجو کنید." compact />
                )
              }
            />
          )}
        </div>
        {listQ.data && listQ.data.total > 0 && (
          <div className="px-4 sm:px-5 py-3.5 border-t border-line-2">
            <Pagination page={listQ.data.page} totalPages={listQ.data.totalPages} total={listQ.data.total} pageSize={listQ.data.pageSize} onChange={setPage} />
          </div>
        )}
      </Card>

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} width={520} label="جزئیات کاندید">
        {selected && (
          <CandidatePanel
            record={selected}
            criteria={criteria}
            jobTitle={selected.roleTitle || undefined}
            onChange={update}
            onDeleted={() => {
              setSelected(null);
              listQ.reload();
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </div>
  );
}

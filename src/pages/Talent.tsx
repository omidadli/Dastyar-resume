import React, { useEffect, useState } from 'react';
import { Archive, Library } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { CandidatePanel } from '../components/candidates/CandidatePanel';
import { Chip, Drawer, EmptyState, ErrorState, Monogram, Pagination, ScoreBadge, SearchInput, Select, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { useOnChange } from '../lib/events';
import { candidateName, faDate, faNumber, toPersianDigits } from '../lib/format';
import { navigate } from '../lib/router';
import { departmentIcon } from '../lib/departmentIcons';
import { useAsync, useDebounced } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { ResumeListItem } from '../types/screening';

export default function Talent({ dept }: { dept?: string }) {
  useTitle('بانک استعداد');
  const active = dept || 'all';
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput, 250);
  const [tags, setTags] = useState<string[]>([]);
  const [minScore, setMinScore] = useState(0);
  const [minYears, setMinYears] = useState(0);
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [active, q, tags, minScore, minYears, sort]);

  const overview = useAsync(() => api.talent.overview(), []);
  const list = useAsync(
    () =>
      api.talent.list({
        departmentId: active === 'all' ? undefined : active,
        q,
        tags,
        minScore: minScore || undefined,
        minYears: minYears || undefined,
        sort,
        page,
      }),
    [active, q, tags.join(','), minScore, minYears, sort, page]
  );
  useOnChange(['talent', 'resumes'], () => {
    overview.refresh();
    list.refresh();
  });
  // The server clamps an out-of-range page (the last page emptied by a
  // delete): follow it, or a later refresh would jump to the stale number.
  useEffect(() => {
    if (list.data && list.data.page !== page) setPage(list.data.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.data]);

  // An address with a department this workspace does not have.
  useEffect(() => {
    if (dept && overview.data && !overview.data.departments.some((d) => d.id === dept)) navigate('/app/talent', { replace: true, force: true });
  }, [dept, overview.data]);

  const [selected, setSelected] = useState<ResumeListItem | null>(null);
  const departments = overview.data?.departments || [];
  // Chosen tags stay visible (and removable) even when they drop out of the top 16.
  const shownTags = Array.from(new Set([...tags, ...(overview.data?.tags || []).slice(0, 16)]));
  const update = (r: ResumeListItem) => {
    setSelected(r);
    list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? r : x)) } : d));
    if (!r.inBank) list.refresh();
  };

  return (
    <div>
      <PageHeader
        title="بانک استعداد"
        subtitle={
          overview.data
            ? `${faNumber(overview.data.total)} کاندید ارزشمند برای فرصت‌های آینده، دسته‌بندی‌شده بر اساس دپارتمان`
            : 'کاندیداهای ارزشمند برای فرصت‌های آینده'
        }
      />

      <div className="flex gap-2 overflow-x-auto hv-scroll pb-2 mb-4 -mx-1 px-1">
        {[{ id: 'all', name: 'همه دپارتمان‌ها', count: overview.data?.total ?? 0 }, ...departments].map((d) => {
          const isActive = d.id === active;
          const Icon = d.id === 'all' ? Library : departmentIcon(d.id);
          return (
            <button
              key={d.id}
              aria-pressed={isActive}
              onClick={() => navigate(d.id === 'all' ? '/app/talent' : `/app/talent/${d.id}`, { keepScroll: true })}
              className={`shrink-0 inline-flex items-center gap-2 h-10 pr-3 pl-3.5 rounded-full border text-[13px] font-semibold transition-colors ${
                isActive ? 'bg-brand-strong border-brand-strong text-white' : d.count ? 'bg-surface border-line text-ink-2 hover:border-line-strong' : 'bg-surface border-line text-ink-4'
              }`}
            >
              <Icon className="w-4 h-4" strokeWidth={1.8} />
              {d.name}
              <span className={`hv-num text-[11.5px] ${isActive ? 'text-white/80' : 'text-ink-4'}`}>{toPersianDigits(d.count)}</span>
            </button>
          );
        })}
      </div>

      <div className="hv-card p-4 mb-4 flex flex-col gap-3">
        <div className="flex flex-col xl:flex-row xl:items-center gap-3">
          <SearchInput value={qInput} onChange={setQInput} placeholder="نام، مهارت، برچسب یا یادداشت…" className="xl:w-[300px]" size="sm" />
          <div className="flex flex-wrap items-center gap-2 xl:mr-auto">
            <Select
              compact
              aria-label="حداقل تطابق"
              value={String(minScore)}
              onChange={(e) => setMinScore(Number(e.target.value))}
              options={[
                { value: '0', label: 'هر میزان تطابق' },
                { value: '50', label: 'تطابق ۵۰٪ به بالا' },
                { value: '70', label: 'تطابق ۷۰٪ به بالا' },
              ]}
            />
            <Select
              compact
              aria-label="حداقل سابقه"
              value={String(minYears)}
              onChange={(e) => setMinYears(Number(e.target.value))}
              options={[
                { value: '0', label: 'هر میزان سابقه' },
                { value: '2', label: 'دست‌کم ۲ سال' },
                { value: '5', label: 'دست‌کم ۵ سال' },
              ]}
            />
            <Select
              compact
              aria-label="مرتب‌سازی"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              options={[
                { value: 'newest', label: 'تازه‌ترین' },
                { value: 'score', label: 'بیشترین تطابق' },
                { value: 'experience', label: 'بیشترین سابقه' },
              ]}
            />
          </div>
        </div>
        {shownTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {shownTags.map((t) => {
              const on = tags.includes(t);
              return (
                <button key={t} onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])} aria-pressed={on}>
                  <Chip tone={on ? 'brand' : 'outline'} className="cursor-pointer hover:border-line-strong">
                    {t}
                  </Chip>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : list.loading && !list.data ? (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[190px] rounded-card" />
          ))}
        </div>
      ) : list.data!.items.length === 0 ? (
        <div className="hv-card">
          <EmptyState
            icon={Archive}
            title={overview.data?.total ? 'موردی با این فیلترها پیدا نشد' : 'بانک استعداد هنوز خالی است'}
            description={
              overview.data?.total
                ? 'فیلترها یا دپارتمان را تغییر دهید.'
                : 'در جزئیات هر کاندید، «افزودن به بانک استعداد» را بزنید تا برای فرصت‌های آینده نگه داشته شود.'
            }
          />
        </div>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {list.data!.items.map((r) => (
              <button key={r.id} onClick={() => setSelected(r)} className="hv-card p-4 text-right flex flex-col gap-3 hover:border-line-strong hover:shadow-raise transition-[box-shadow,border-color]">
                <div className="flex items-start gap-3">
                  <Monogram name={candidateName(r)} size={42} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-bold text-ink truncate" dir="auto">
                      {candidateName(r)}
                    </p>
                    <p className="text-[12px] text-ink-3 truncate">
                      <bdi>{r.facts?.lastRole || '—'}</bdi>
                      {r.facts?.yearsExperience != null && `، ${toPersianDigits(r.facts.yearsExperience)} سال`}
                    </p>
                  </div>
                  <ScoreBadge score={r.score} category={r.category} size={44} />
                </div>
                {r.bankNote && <p className="text-[12.5px] text-ink-2 leading-relaxed line-clamp-2">«{r.bankNote}»</p>}
                <div className="flex flex-wrap gap-1">
                  {(r.bankTags.length ? r.bankTags : r.tags).slice(0, 4).map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
                <div className="flex items-center justify-between text-[11.5px] text-ink-4 mt-auto pt-1 border-t border-line-2">
                  <span className="truncate">از «{r.roleTitle || r.departmentName}»</span>
                  <span>{r.addedToBankAtISO ? faDate(r.addedToBankAtISO, false) : ''}</span>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-5">
            <Pagination page={list.data!.page} totalPages={list.data!.totalPages} total={list.data!.total} pageSize={list.data!.pageSize} onChange={setPage} />
          </div>
        </>
      )}

      <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} width={520} label="جزئیات کاندید">
        {selected && (
          <CandidatePanel
            key={selected.id}
            record={selected}
            jobTitle={selected.roleTitle || undefined}
            onChange={update}
            onDeleted={() => {
              const goneId = selected.id;
              setSelected(null);
              list.setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== goneId) } : d));
              list.refresh();
              overview.refresh();
            }}
            onClose={() => setSelected(null)}
          />
        )}
      </Drawer>
    </div>
  );
}


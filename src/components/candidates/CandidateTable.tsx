import React from 'react';
import { Archive, ChevronLeft, Cpu, MailCheck } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import { candidateName, faRelative, toPersianDigits } from '../../lib/format';
import { matchMeta } from '../../lib/match';
import { Checkbox, Chip, DecisionPill, MatchMeter, MatchPill, Monogram, ScoreBadge, Skeleton } from '../ui';

export interface CandidateTableProps {
  items: ResumeListItem[];
  loading?: boolean;
  activeId?: string | null;
  onOpen: (r: ResumeListItem) => void;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  showJob?: boolean;
  /** Narrow mode while the side panel is open. */
  compact?: boolean;
  emptyState?: React.ReactNode;
}

function Signals({ r }: { r: ResumeListItem }) {
  return (
    <span className="inline-flex items-center gap-1 text-ink-4">
      {r.engine === 'local' && <Cpu className="w-3.5 h-3.5 text-review-ink" role="img" aria-label="تحلیل محلی" />}
      {r.inBank && <Archive className="w-3.5 h-3.5" role="img" aria-label="در بانک استعداد" />}
      {r.messageStatus === 'sent' && <MailCheck className="w-3.5 h-3.5" role="img" aria-label="پیام ارسال شده" />}
    </span>
  );
}

export function CandidateTable({ items, loading, activeId, onOpen, selected, onToggle, onToggleAll, showJob, compact, emptyState }: CandidateTableProps) {
  const selectable = Boolean(selected && onToggle);
  const allSelected = selectable && items.length > 0 && items.every((i) => selected!.has(i.id));
  const someSelected = selectable && items.some((i) => selected!.has(i.id));

  if (!loading && items.length === 0) return <>{emptyState}</>;

  return (
    <>
      {/* Desktop / tablet table */}
      <div className="hidden md:block overflow-x-auto hv-scroll">
        <table className="w-full text-right border-separate border-spacing-0">
          <thead>
            <tr className="text-[12px] text-ink-3">
              {selectable && (
                <th className="w-11 pr-4 pb-2.5 font-semibold border-b border-line">
                  <Checkbox
                    checked={Boolean(allSelected)}
                    indeterminate={!allSelected && someSelected}
                    onChange={() => onToggleAll?.()}
                    ariaLabel="انتخاب همه کاندیداهای این فهرست"
                  />
                </th>
              )}
              {/* The name column takes the room that is left and truncates, so the other columns never get pushed out of view. */}
              <th className="pb-2.5 pr-2 font-semibold border-b border-line w-full">کاندید</th>
              <th className="pb-2.5 px-2 font-semibold border-b border-line whitespace-nowrap">{compact ? 'تطابق' : 'وضعیت تطابق'}</th>
              {!compact && <th className="pb-2.5 px-2 font-semibold border-b border-line w-[150px]">درصد تطابق</th>}
              {!compact && <th className="pb-2.5 px-2 font-semibold border-b border-line hidden xl:table-cell">مهارت‌های کلیدی</th>}
              {/* From 1100px: at 1024 the job column pushed «تصمیم» out of view. */}
              {showJob && !compact && <th className="pb-2.5 px-2 font-semibold border-b border-line hidden min-[1100px]:table-cell">فرصت شغلی</th>}
              <th className="pb-2.5 px-2 font-semibold border-b border-line whitespace-nowrap">تصمیم</th>
              {!compact && <th className="pb-2.5 pl-4 w-8 border-b border-line" aria-hidden />}
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {selectable && <td className="pr-4 py-3.5 border-b border-line-2"><Skeleton className="w-[18px] h-[18px]" /></td>}
                    <td className="py-3.5 pr-2 border-b border-line-2">
                      <div className="flex items-center gap-3">
                        <Skeleton className="w-9 h-9 rounded-full" />
                        <div className="flex flex-col gap-1.5">
                          <Skeleton className="h-3.5 w-32" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </div>
                    </td>
                    <td className="px-2 border-b border-line-2"><Skeleton className="h-6 w-24 rounded-full" /></td>
                    {!compact && <td className="px-2 border-b border-line-2"><Skeleton className="h-2 w-28" /></td>}
                    {!compact && <td className="px-2 border-b border-line-2 hidden xl:table-cell"><Skeleton className="h-5 w-40" /></td>}
                    {showJob && !compact && <td className="px-2 border-b border-line-2 hidden min-[1100px]:table-cell"><Skeleton className="h-4 w-28" /></td>}
                    <td className="px-2 border-b border-line-2"><Skeleton className="h-6 w-20 rounded-full" /></td>
                    {!compact && <td className="border-b border-line-2" />}
                  </tr>
                ))
              : items.map((r) => {
                  const active = r.id === activeId;
                  const isSel = selected?.has(r.id);
                  const name = candidateName(r);
                  const skills = r.facts?.skills || [];
                  return (
                    <tr
                      key={r.id}
                      onClick={() => onOpen(r)}
                      // Rows open with the keyboard too (Tab to a row, then Enter or Space).
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onOpen(r);
                        }
                      }}
                      aria-current={active ? 'true' : undefined}
                      className={`group cursor-pointer transition-colors outline-none focus-visible:bg-brand-tint focus-visible:shadow-[inset_0_0_0_2px_var(--color-brand)] ${
                        active ? 'bg-brand-soft/70' : isSel ? 'bg-brand-tint' : 'hover:bg-canvas'
                      }`}
                    >
                      {selectable && (
                        <td className="pr-4 py-3 border-b border-line-2 relative" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          {active && <span className="absolute right-0 top-2 bottom-2 w-[3px] rounded-l-full bg-brand" />}
                          <Checkbox checked={Boolean(isSel)} onChange={() => onToggle?.(r.id)} ariaLabel={`انتخاب ${name}`} />
                        </td>
                      )}
                      <td className={`py-3 pr-2 border-b border-line-2 max-w-0 ${compact ? 'min-w-[150px]' : 'min-w-[200px]'}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <Monogram name={name} size={compact ? 34 : 38} />
                          <div className="min-w-0">
                            <p className="text-[13.5px] font-bold text-ink truncate max-w-[240px] flex items-center gap-1.5" dir="auto">
                              <span className="truncate">{name}</span>
                              <Signals r={r} />
                            </p>
                            <p className="text-[12px] text-ink-3 truncate max-w-[260px]">
                              {r.facts?.lastRole || '—'}
                              {r.facts?.yearsExperience != null && ` · ${toPersianDigits(r.facts.yearsExperience)} سال`}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-3 border-b border-line-2">
                        {compact ? (
                          // Beside the open panel: label and percentage share one column.
                          <span className="inline-flex items-center gap-2 whitespace-nowrap">
                            <MatchPill category={r.category} size="sm" />
                            {matchMeta(r.category).level !== 'insufficient' && (
                              <span className="text-[13px] font-bold text-ink hv-num">{toPersianDigits(Math.round(r.score))}٪</span>
                            )}
                          </span>
                        ) : (
                          <MatchPill category={r.category} size="sm" />
                        )}
                      </td>
                      {!compact && (
                        <td className="px-2 py-3 border-b border-line-2">
                          <MatchMeter score={r.score} category={r.category} className="w-[140px]" />
                        </td>
                      )}
                      {!compact && (
                        <td className="px-2 py-3 border-b border-line-2 hidden xl:table-cell">
                          <div className="flex items-center gap-1 max-w-[280px] overflow-hidden">
                            {skills.slice(0, 2).map((s) => (
                              <Chip key={s} className="max-w-[120px]">
                                {s}
                              </Chip>
                            ))}
                            {skills.length > 2 && <span className="text-[11.5px] text-ink-4 hv-num shrink-0">+{toPersianDigits(skills.length - 2)}</span>}
                            {skills.length === 0 && <span className="text-[12px] text-ink-4">—</span>}
                          </div>
                        </td>
                      )}
                      {showJob && !compact && (
                        <td className="px-2 py-3 border-b border-line-2 hidden min-[1100px]:table-cell">
                          <p className="text-[12.5px] text-ink-2 truncate max-w-[180px]">{r.roleTitle || r.departmentName}</p>
                          <p className="text-[11.5px] text-ink-4">{faRelative(r.createdAtISO)}</p>
                        </td>
                      )}
                      <td className={`px-2 py-3 border-b border-line-2 ${compact ? 'pl-4' : ''}`}>
                        <DecisionPill status={r.decisionStatus} size="sm" />
                      </td>
                      {!compact && (
                        <td className="pl-4 py-3 border-b border-line-2 text-ink-4">
                          <ChevronLeft className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </td>
                      )}
                    </tr>
                  );
                })}
          </tbody>
        </table>
      </div>

      {/* Mobile cards */}
      <ul className="md:hidden flex flex-col gap-2.5">
        {loading && items.length === 0
          ? Array.from({ length: 4 }).map((_, i) => (
              <li key={i} className="hv-card p-3.5 flex gap-3">
                <Skeleton className="w-12 h-12 rounded-full" />
                <div className="flex-1 flex flex-col gap-2">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </li>
            ))
          : items.map((r) => {
              const name = candidateName(r);
              const isSel = selected?.has(r.id);
              return (
                <li key={r.id} className={`hv-card flex items-stretch overflow-hidden ${isSel ? 'ring-2 ring-brand/40' : ''}`}>
                  {/* The checkbox is a sibling of the card button, never inside it (nested controls are unreachable for screen readers). */}
                  {selectable && (
                    <span className="flex items-center pr-3.5 pl-0.5">
                      <Checkbox checked={Boolean(isSel)} onChange={() => onToggle?.(r.id)} ariaLabel={`انتخاب ${name}`} />
                    </span>
                  )}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(r)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(r);
                      }
                    }}
                    className={`flex-1 min-w-0 p-3.5 flex items-center gap-3 active:bg-canvas outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-brand)] ${selectable ? 'pr-2' : ''}`}
                  >
                    <ScoreBadge score={r.score} category={r.category} size={48} />
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-bold text-ink truncate" dir="auto">
                        {name}
                      </p>
                      <p className="text-[12px] text-ink-3 truncate">
                        {r.facts?.lastRole || '—'}
                        {showJob && ` · ${r.roleTitle || r.departmentName}`}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        <MatchPill category={r.category} size="sm" />
                        {r.decisionStatus !== 'none' && <DecisionPill status={r.decisionStatus} size="sm" />}
                        <Signals r={r} />
                      </div>
                    </div>
                    <ChevronLeft className="w-4 h-4 text-ink-4 shrink-0" />
                  </div>
                </li>
              );
            })}
      </ul>
    </>
  );
}

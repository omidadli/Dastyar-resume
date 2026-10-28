import React, { useState } from 'react';
import { ArrowLeft, CheckCircle2, ChevronDown, Loader2, Mail, MoveRight, UserRound } from 'lucide-react';
import { EmptyState, Menu, ScoreBadge, Skeleton, toast } from '../ui';
import { api } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import { emitChange } from '../../lib/events';
import type { PipelineBoard as Board, PipelineCard } from '../../types/pipeline';
import type { ResumeCategory } from '../../types/screening';

/**
 * «تختهٔ جذب» — the same candidates as the table, arranged the way a recruiter
 * thinks: one column per stage, the next step one click away.
 *
 * Moving a candidate is deliberately explicit (no drag-and-drop on a laptop
 * trackpad in a hurry): a small menu says where they can go, and every move is
 * written to the activity feed.
 */
export function PipelineBoard({
  board,
  loading,
  onRefresh,
  onOpen,
  canMove = true,
}: {
  board: Board | null;
  loading?: boolean;
  onRefresh: () => void;
  onOpen: (card: PipelineCard) => void;
  canMove?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function move(card: PipelineCard, stageId: string) {
    if (stageId === card.stageId) return;
    setBusy(card.id);
    try {
      await api.resumes.stage(card.id, stageId);
      onRefresh();
      emitChange('resumes');
      emitChange('activity');
      toast(`«${card.name}» منتقل شد.`);
    } catch (err: any) {
      toast(err?.message || 'جابه‌جایی کارجو ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading || !board) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-56" />
        ))}
      </div>
    );
  }

  if (!board.total) {
    return (
      <EmptyState
        icon={UserRound}
        title="تخته خالی است"
        description="با افزودن رزومه یا انتشار آگهی در پورتال شغلی، کارجوها در ستون «درخواست تازه» ظاهر می‌شوند."
      />
    );
  }

  return (
    <div className="hv-scroll overflow-x-auto pb-2 -mx-1 px-1">
      <div className="flex gap-3 min-w-max">
        {board.columns.map((column, index) => (
          <section key={column.stage.id} className="w-[248px] shrink-0" aria-label={column.stage.name}>
            <header className="flex items-center justify-between gap-2 px-1 mb-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`w-2 h-2 rounded-full shrink-0 ${dot(column.stage.kind)}`} aria-hidden />
                <h3 className="text-[12.5px] font-bold text-ink-2 truncate">{column.stage.name}</h3>
              </div>
              <span className="text-[11px] text-ink-4 hv-latin">{toPersianDigits(column.cards.length)}</span>
            </header>
            <div className="rounded-[14px] bg-canvas border border-line p-2 space-y-2 min-h-[120px]">
              {column.cards.length === 0 && <p className="text-[11.5px] text-ink-4 text-center py-6">خالی</p>}
              {column.cards.map((card) => (
                <article key={card.id} className="hv-card p-2.5 hover:border-brand/40 transition-colors">
                  <button type="button" className="w-full text-right" onClick={() => onOpen(card)}>
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-ink truncate">{card.name}</p>
                        <p className="text-[11px] text-ink-4 mt-0.5">
                          {toPersianDigits(Math.round(card.score))}٪ تطابق
                          {card.novelty === 'duplicate' ? ' · تکراری' : ''}
                        </p>
                      </div>
                      <ScoreBadge score={card.score} category={card.category as ResumeCategory} size={34} />
                    </div>
                    <div className="flex items-center gap-1.5 mt-2">
                      {card.hasEmail && <Mail className="w-3.5 h-3.5 text-ink-4" strokeWidth={1.9} aria-label="ایمیل دارد" />}
                      {card.decisionStatus === 'approved' && <CheckCircle2 className="w-3.5 h-3.5 text-brand-strong" strokeWidth={2} />}
                    </div>
                  </button>
                  {canMove && (
                    <div className="mt-2 pt-2 border-t border-line flex items-center justify-between gap-1">
                      <Menu
                        align="end"
                        width={190}
                        items={[
                          ...board.stages
                            .filter((s) => s.id !== card.stageId)
                            .map((s) => ({
                              label: `انتقال به «${s.name}»`,
                              icon: MoveRight,
                              onClick: () => void move(card, s.id),
                            })),
                        ]}
                        trigger={({ toggle }) => (
                          <button
                            type="button"
                            onClick={toggle}
                            className="inline-flex items-center gap-1 text-[11.5px] font-medium text-ink-3 hover:text-ink px-1.5 py-1 rounded-md hover:bg-line-2"
                          >
                            {busy === card.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            جابه‌جایی
                          </button>
                        )}
                      />
                      {index < board.stages.length - 1 && (
                        <button
                          type="button"
                          onClick={() => void move(card, board.stages[index + 1].id)}
                          className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-strong hover:underline px-1.5 py-1"
                          title={`انتقال به «${board.stages[index + 1].name}»`}
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          بعدی
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function dot(kind: string): string {
  switch (kind) {
    case 'applied':
      return 'bg-ink-4';
    case 'screening':
      return 'bg-review';
    case 'interview':
      return 'bg-brand';
    case 'offer':
      return 'bg-[#7C5CD6]';
    case 'hired':
      return 'bg-high';
    default:
      return 'bg-low';
  }
}

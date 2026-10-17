import React from 'react';
import { Cpu, Sparkles, type LucideIcon } from 'lucide-react';
import type { AnalysisEngine, Confidence, DecisionStatus, JobStatus, ResumeCategory } from '../../types/screening';
import { CONFIDENCE_LABEL, DECISION_META, JOB_STATUS_META, matchMeta } from '../../lib/match';

const PILL = 'inline-flex items-center gap-1 rounded-full border font-semibold whitespace-nowrap leading-none';

export function MatchPill({ category, size = 'md', className = '' }: { category: ResumeCategory; size?: 'sm' | 'md'; className?: string }) {
  const m = matchMeta(category);
  const Icon = m.icon;
  return (
    <span className={`${PILL} ${m.pill} ${size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-xs'} ${className}`}>
      <Icon className="w-3.5 h-3.5" strokeWidth={2.1} />
      {m.label}
    </span>
  );
}

export function DecisionPill({ status, size = 'md', className = '' }: { status: DecisionStatus; size?: 'sm' | 'md'; className?: string }) {
  const m = DECISION_META[status];
  const Icon = m.icon;
  return (
    <span className={`${PILL} ${m.pill} ${size === 'sm' ? 'h-6 px-2 text-[11.5px]' : 'h-7 px-2.5 text-xs'} ${className}`}>
      <Icon className="w-3.5 h-3.5" strokeWidth={2} />
      {m.label}
    </span>
  );
}

export function JobStatusPill({ status, className = '' }: { status: JobStatus; className?: string }) {
  const m = JOB_STATUS_META[status];
  return (
    <span className={`${PILL} ${m.pill} h-6 px-2.5 text-[11.5px] ${className}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  icon: Icon,
  className = '',
  title,
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'outline' | 'warning' | 'danger';
  icon?: LucideIcon;
  className?: string;
  title?: string;
}) {
  const tones = {
    neutral: 'bg-line-2 text-ink-2 border-transparent',
    brand: 'bg-brand-soft text-brand-stronger border-transparent',
    outline: 'bg-surface text-ink-2 border-line',
    warning: 'bg-review-soft text-review-ink border-transparent',
    danger: 'bg-low-soft text-low-ink border-transparent',
  } as const;
  return (
    <span title={title} className={`inline-flex items-center gap-1 h-6 px-2 rounded-[7px] border text-xs font-medium max-w-full ${tones[tone]} ${className}`}>
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" strokeWidth={1.9} />}
      <span className="truncate" dir="auto">
        {children}
      </span>
    </span>
  );
}

/** Honest label of which engine produced an analysis. */
export function EngineBadge({ engine, className = '' }: { engine: AnalysisEngine | null; className?: string }) {
  if (!engine) return null;
  if (engine === 'local') {
    return (
      <span
        title="هوش مصنوعی در دسترس نبود؛ این نتیجه با تطبیق کلیدواژه‌ای محلی به دست آمده و دقت کمتری دارد."
        className={`${PILL} h-6 px-2 text-[11.5px] bg-review-soft text-review-ink border-review/25 ${className}`}
      >
        <Cpu className="w-3.5 h-3.5" strokeWidth={2} />
        تحلیل محلی
      </span>
    );
  }
  return (
    <span className={`${PILL} h-6 px-2 text-[11.5px] bg-brand-tint text-brand-ink border-brand/20 ${className}`}>
      <Sparkles className="w-3.5 h-3.5" strokeWidth={2} />
      پیشنهاد هویدا
    </span>
  );
}

export function ConfidenceBadge({ confidence, className = '' }: { confidence: Confidence | null; className?: string }) {
  if (!confidence) return null;
  const bars = confidence === 'high' ? 3 : confidence === 'medium' ? 2 : 1;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-3 ${className}`} title="میزان اطمینان هویدا به این تحلیل، بر اساس کامل‌بودن شواهد رزومه">
      <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span key={i} className={`w-[3px] rounded-full ${i <= bars ? 'bg-ink-2' : 'bg-line-strong'}`} style={{ height: `${4 + i * 2.5}px` }} />
        ))}
      </span>
      {CONFIDENCE_LABEL[confidence]}
    </span>
  );
}

export function CountBadge({ value, active }: { value: number; active?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center min-w-[22px] h-[20px] px-1.5 rounded-full text-[11px] font-bold hv-num ${
        active ? 'bg-brand-strong text-white' : 'bg-line-2 text-ink-3'
      }`}
    >
      {value.toLocaleString('fa-IR')}
    </span>
  );
}

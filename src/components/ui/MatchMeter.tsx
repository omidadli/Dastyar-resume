import React from 'react';
import type { ResumeCategory } from '../../types/screening';
import { matchMeta } from '../../lib/match';
import { toPersianDigits } from '../../lib/format';

/** Match % bar — color follows the match level, never the raw number. */
export function MatchMeter({
  score,
  category,
  className = '',
  showValue = true,
  thin,
}: {
  score: number;
  category: ResumeCategory;
  className?: string;
  showValue?: boolean;
  thin?: boolean;
}) {
  const m = matchMeta(category);
  const na = m.level === 'insufficient';
  const value = na ? 0 : Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div className={`flex items-center gap-2.5 min-w-0 ${className}`} title={na ? m.label : `${toPersianDigits(value)}٪ تطابق`}>
      {showValue && (
        <span className={`text-[13px] font-bold hv-num w-9 shrink-0 ${na ? 'text-ink-4' : 'text-ink'}`}>
          {na ? '—' : `${toPersianDigits(value)}٪`}
        </span>
      )}
      <div
        className={`relative flex-1 ${thin ? 'h-1.5' : 'h-2'} rounded-full bg-line-2 overflow-hidden`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-label="درصد تطابق"
      >
        <div className={`absolute inset-y-0 right-0 rounded-full ${m.color}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/** Round % badge used in panel headers and mobile cards. */
export function ScoreBadge({ score, category, size = 56 }: { score: number; category: ResumeCategory; size?: number }) {
  const m = matchMeta(category);
  const na = m.level === 'insufficient';
  const value = na ? 0 : Math.max(0, Math.min(100, Math.round(score)));
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const stroke = { high: '#22C55E', review: '#F59E0B', low: '#EF4444', insufficient: '#94A3B8' }[m.level];
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-label={na ? m.label : `${value}٪ تطابق`}>
      <svg viewBox="0 0 36 36" width={size} height={size} className="-rotate-90">
        <circle cx="18" cy="18" r={r} fill="none" stroke="#EFF1F0" strokeWidth="3" />
        {!na && (
          <circle
            cx="18"
            cy="18"
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${(value / 100) * c} ${c}`}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className={`font-extrabold hv-num ${size >= 56 ? 'text-[15px]' : 'text-[12px]'} ${na ? 'text-ink-4' : 'text-ink'}`}>
          {na ? '—' : `${toPersianDigits(value)}٪`}
        </span>
      </div>
    </div>
  );
}

/** Tiny stacked distribution bar: high / review / low / insufficient. */
export function DistributionBar({
  high,
  review,
  low,
  insufficient,
  className = '',
}: {
  high: number;
  review: number;
  low: number;
  insufficient: number;
  className?: string;
}) {
  const total = high + review + low + insufficient;
  if (!total) return <div className={`h-1.5 rounded-full bg-line-2 ${className}`} />;
  const seg = (n: number, cls: string, label: string) =>
    n > 0 ? <div className={cls} style={{ width: `${(n / total) * 100}%` }} title={`${label}: ${n.toLocaleString('fa-IR')}`} /> : null;
  return (
    <div className={`flex h-1.5 rounded-full overflow-hidden gap-[2px] bg-line-2 ${className}`}>
      {seg(high, 'bg-high', 'تطابق بالا')}
      {seg(review, 'bg-review', 'نیازمند بررسی')}
      {seg(low, 'bg-low', 'تطابق پایین')}
      {seg(insufficient, 'bg-na', 'اطلاعات ناکافی')}
    </div>
  );
}

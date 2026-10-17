import React from 'react';
import { ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import { toPersianDigits } from '../../lib/format';

export function Card({ children, className = '', as: Tag = 'div', padded = true }: { children: React.ReactNode; className?: string; as?: any; padded?: boolean }) {
  return <Tag className={`hv-card ${padded ? 'p-4 sm:p-5' : ''} ${className}`}>{children}</Tag>;
}

export function CardHeader({
  title,
  subtitle,
  action,
  icon: Icon,
  className = '',
  as: Heading = 'h2',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  icon?: LucideIcon;
  className?: string;
  /** Cards sit right under the page title (h1), so their titles are h2; h3 when nested under another heading. */
  as?: 'h2' | 'h3';
}) {
  return (
    <div className={`flex items-start justify-between gap-3 mb-4 ${className}`}>
      <div className="flex items-start gap-2.5 min-w-0">
        {Icon && <Icon className="w-[18px] h-[18px] text-ink-3 mt-0.5 shrink-0" strokeWidth={1.8} />}
        <div className="min-w-0">
          <Heading className="text-[15px] font-bold text-ink leading-snug">{title}</Heading>
          {subtitle && <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** KPI tile: icon chip, value, label and an optional note. */
export function Stat({
  icon: Icon,
  label,
  value,
  note,
  tone = 'neutral',
  className = '',
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: 'neutral' | 'brand' | 'review' | 'high';
  className?: string;
}) {
  const chip = {
    neutral: 'bg-line-2 text-ink-2',
    brand: 'bg-brand-soft text-brand-strong',
    review: 'bg-review-soft text-review-ink',
    high: 'bg-high-soft text-high-ink',
  }[tone];
  return (
    <div className={`hv-card p-4 flex items-start gap-3.5 ${className}`}>
      <div className={`w-11 h-11 rounded-[12px] flex items-center justify-center shrink-0 ${chip}`}>
        <Icon className="w-[21px] h-[21px]" strokeWidth={1.7} />
      </div>
      <div className="min-w-0">
        <p className="text-[12.5px] text-ink-3 font-medium leading-tight">{label}</p>
        <p className="text-[22px] font-extrabold text-ink leading-tight mt-1.5 hv-num">{value}</p>
        {note && <p className="text-[11.5px] text-ink-3 mt-1 leading-snug">{note}</p>}
      </div>
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onChange,
  className = '',
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onChange: (p: number) => void;
  className?: string;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const pages: (number | '…')[] = [];
  for (let p = 1; p <= totalPages; p++) {
    if (p === 1 || p === totalPages || Math.abs(p - page) <= 1) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 ${className}`}>
      <p className="text-[13px] text-ink-3">
        نمایش <span className="font-semibold text-ink-2 hv-num">{toPersianDigits(from)}</span> تا{' '}
        <span className="font-semibold text-ink-2 hv-num">{toPersianDigits(to)}</span> از{' '}
        <span className="font-semibold text-ink-2 hv-num">{total.toLocaleString('fa-IR')}</span> نتیجه
      </p>
      {totalPages > 1 && (
        <nav className="flex items-center gap-1" aria-label="صفحه‌بندی">
          <button
            onClick={() => onChange(page - 1)}
            disabled={page <= 1}
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-ink-3 hover:bg-line-2 disabled:opacity-30"
            aria-label="صفحه قبل"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {pages.map((p, i) =>
            p === '…' ? (
              <span key={`e${i}`} className="w-6 text-center text-ink-4">
                …
              </span>
            ) : (
              <button
                key={p}
                onClick={() => onChange(p)}
                aria-label={`صفحه ${toPersianDigits(p)}`}
                aria-current={p === page ? 'page' : undefined}
                className={`min-w-8 h-8 px-2 rounded-[9px] text-[13px] font-semibold hv-num ${
                  p === page ? 'bg-brand-soft text-brand-stronger' : 'text-ink-2 hover:bg-line-2'
                }`}
              >
                {toPersianDigits(p)}
              </button>
            )
          )}
          <button
            onClick={() => onChange(page + 1)}
            disabled={page >= totalPages}
            className="w-8 h-8 rounded-[9px] flex items-center justify-center text-ink-3 hover:bg-line-2 disabled:opacity-30"
            aria-label="صفحه بعد"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </nav>
      )}
    </div>
  );
}

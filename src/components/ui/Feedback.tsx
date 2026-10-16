import React from 'react';
import { AlertTriangle, Info, Loader2, RefreshCw, ShieldAlert, type LucideIcon } from 'lucide-react';
import { Button } from './Button';

export function Spinner({ className = 'w-5 h-5', label }: { className?: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-ink-3" role="status">
      <Loader2 className={`${className} animate-spin text-brand`} aria-hidden />
      {label ? <span className="text-[13px] font-medium">{label}</span> : <span className="sr-only">در حال بارگذاری…</span>}
    </span>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`hv-skeleton ${className}`} aria-hidden />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className = '',
  compact,
}: {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'py-8 px-4' : 'py-14 px-6'} ${className}`}>
      <div className={`${compact ? 'w-12 h-12' : 'w-14 h-14'} rounded-[16px] bg-brand-soft flex items-center justify-center mb-4`}>
        <Icon className={`${compact ? 'w-6 h-6' : 'w-7 h-7'} text-brand-strong`} strokeWidth={1.6} />
      </div>
      <h3 className="text-[15px] font-bold text-ink">{title}</h3>
      {description && <p className="text-[13px] text-ink-3 mt-1.5 max-w-[420px] leading-relaxed">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry, className = '' }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={`flex flex-col items-center text-center py-12 px-6 ${className}`} role="alert">
      <div className="w-12 h-12 rounded-[14px] bg-low-soft flex items-center justify-center mb-3">
        <AlertTriangle className="w-6 h-6 text-low-ink" strokeWidth={1.7} />
      </div>
      <p className="text-sm font-semibold text-ink max-w-[440px] leading-relaxed">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" icon={RefreshCw} className="mt-4" onClick={onRetry}>
          تلاش دوباره
        </Button>
      )}
    </div>
  );
}

const CALLOUT_TONES = {
  info: { box: 'bg-[#F2F6F9] border-[#DCE6EE] text-[#2F4858]', icon: Info, iconCls: 'text-[#3D6A86]' },
  warning: { box: 'bg-review-soft border-review/25 text-[#7A4A0B]', icon: AlertTriangle, iconCls: 'text-review-ink' },
  danger: { box: 'bg-low-soft border-low/25 text-[#7F1D1D]', icon: ShieldAlert, iconCls: 'text-low-ink' },
  brand: { box: 'bg-brand-tint border-brand/20 text-brand-stronger', icon: Info, iconCls: 'text-brand-strong' },
} as const;

export function Callout({
  tone = 'info',
  title,
  children,
  icon,
  action,
  className = '',
}: {
  tone?: keyof typeof CALLOUT_TONES;
  title?: React.ReactNode;
  children?: React.ReactNode;
  icon?: LucideIcon;
  action?: React.ReactNode;
  className?: string;
}) {
  const t = CALLOUT_TONES[tone];
  const Icon = icon || t.icon;
  return (
    <div className={`flex items-start gap-3 rounded-[12px] border px-3.5 py-3 ${t.box} ${className}`}>
      <Icon className={`w-[18px] h-[18px] shrink-0 mt-[1px] ${t.iconCls}`} strokeWidth={1.9} />
      <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
        {title && <p className="font-bold mb-0.5">{title}</p>}
        {children}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

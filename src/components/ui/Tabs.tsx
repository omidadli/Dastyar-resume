import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { CountBadge } from './Pills';

/**
 * Arrow-key navigation shared by tabs and segmented controls (ARIA tablist /
 * radiogroup patterns). RTL: ArrowLeft moves forward, ArrowRight back.
 */
function arrowNav<T extends string>(e: React.KeyboardEvent<HTMLElement>, ids: T[], current: T, onChange: (id: T) => void) {
  const i = ids.indexOf(current);
  let next: number | null = null;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
  else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = ids.length - 1;
  if (next === null || !ids.length) return;
  e.preventDefault();
  onChange(ids[next]);
  const group = e.currentTarget;
  window.requestAnimationFrame(() => group.querySelectorAll<HTMLButtonElement>('button')[next!]?.focus());
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: LucideIcon;
}

/** Underline tabs (page sections, panel tabs). */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = '',
  size = 'md',
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="tablist"
      onKeyDown={(e) => arrowNav(e, items.map((t) => t.id), value, onChange)}
      className={`flex items-center gap-1 border-b border-line overflow-x-auto hv-scroll ${className}`}
    >
      {items.map((t) => {
        const active = t.id === value;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active || !items.some((x) => x.id === value) ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={`relative inline-flex items-center gap-1.5 whitespace-nowrap font-semibold transition-colors ${
              size === 'sm' ? 'h-10 px-2.5 text-[13px]' : 'h-11 px-3 text-sm'
            } ${active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {Icon && <Icon className="w-4 h-4" strokeWidth={1.9} />}
            {t.label}
            {t.count !== undefined && <CountBadge value={t.count} active={active} />}
            {active && <span className="absolute inset-x-2 -bottom-px h-[2.5px] rounded-full bg-brand" />}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented control (filters, ranges). */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  className = '',
  size = 'md',
}: {
  items: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      role="radiogroup"
      onKeyDown={(e) => arrowNav(e, items.map((it) => it.id), value, onChange)}
      className={`inline-flex items-center p-1 gap-0.5 rounded-[11px] bg-line-2 max-w-full overflow-x-auto hv-scroll ${className}`}
    >
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || !items.some((x) => x.id === value) ? 0 : -1}
            onClick={() => onChange(it.id)}
            className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-[8px] font-semibold transition-all ${
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]'
            } ${active ? 'bg-surface text-ink shadow-[0_1px_2px_rgba(20,30,24,0.08)]' : 'text-ink-3 hover:text-ink-2'}`}
          >
            {it.label}
            {it.count !== undefined && <span className={`hv-num text-[11px] ${active ? 'text-ink-3' : 'text-ink-4'}`}>{it.count.toLocaleString('fa-IR')}</span>}
          </button>
        );
      })}
    </div>
  );
}

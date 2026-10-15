import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hint?: string;
}

/** Click-to-open dropdown menu, aligned to the trigger's inline-start (right in RTL). */
export function Menu({
  trigger,
  items,
  align = 'start',
  width = 220,
  header,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  items: Array<MenuItem | 'divider'>;
  align?: 'start' | 'end';
  width?: number;
  header?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          className={`absolute z-[60] top-full mt-1.5 ${align === 'start' ? 'right-0' : 'left-0'} bg-surface border border-line rounded-[12px] shadow-pop py-1.5 animate-pop-in`}
          style={{ width }}
        >
          {header && <div className="px-3 pt-1.5 pb-2 border-b border-line mb-1">{header}</div>}
          {items.map((it, i) =>
            it === 'divider' ? (
              <div key={`d${i}`} className="my-1.5 h-px bg-line" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
                className={`w-full flex items-center gap-2.5 px-3 h-9 text-[13.5px] text-right transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  it.tone === 'danger' ? 'text-low-ink hover:bg-low-soft' : 'text-ink-2 hover:bg-line-2 hover:text-ink'
                }`}
              >
                {it.icon && <it.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />}
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-[11px] text-ink-4">{it.hint}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

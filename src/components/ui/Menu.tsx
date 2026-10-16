import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hint?: string;
}

const GAP = 6;
const EDGE = 8;

interface Placement {
  top: number;
  left?: number;
  right?: number;
}

/**
 * Click-to-open dropdown menu, aligned to the trigger's inline-start (right in
 * RTL). `side="top"` prefers opening upwards (triggers at the bottom of the
 * screen); either way the menu flips when there is no room.
 *
 * Rendered in a portal with fixed positioning, so a scrolling table, a card
 * with `overflow-hidden` or a drawer can never clip it. Keyboard: ↑/↓ move
 * between items, Home/End jump, Escape closes and returns focus to the trigger.
 */
export function Menu({
  trigger,
  items,
  align = 'start',
  side = 'bottom',
  width = 220,
  header,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => React.ReactNode;
  items: Array<MenuItem | 'divider'>;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  width?: number;
  header?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = React.useId();

  const triggerButton = () => anchorRef.current?.querySelector<HTMLElement>('button, [role="button"], a[href]') || null;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => triggerButton()?.focus({ preventScroll: true }), 0);
  }, []);

  const measure = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = menuRef.current?.offsetHeight || 0;
    const w = Math.min(width, vw - EDGE * 2);
    const below = anchor.bottom + GAP;
    const above = anchor.top - GAP - h;
    const fitsBelow = below + h <= vh - EDGE;
    const fitsAbove = above >= EDGE;
    const top = side === 'top' ? (fitsAbove || !fitsBelow ? Math.max(EDGE, above) : below) : fitsBelow || !fitsAbove ? below : above;
    if (align === 'start') {
      // Right edges aligned (RTL inline-start), kept inside the viewport.
      const right = Math.min(Math.max(EDGE, vw - anchor.right), vw - EDGE - w);
      setPlace({ top: Math.max(EDGE, Math.min(top, vh - EDGE - h)), right });
    } else {
      const left = Math.min(Math.max(EDGE, anchor.left), vw - EDGE - w);
      setPlace({ top: Math.max(EDGE, Math.min(top, vh - EDGE - h)), left });
    }
  }, [align, side, width]);

  // Position before paint; measure again once the menu's real height is known.
  useLayoutEffect(() => {
    if (!open) {
      setPlace(null);
      return;
    }
    measure();
  }, [open, measure]);
  useLayoutEffect(() => {
    if (open && place && menuRef.current) {
      const r = menuRef.current.getBoundingClientRect();
      if (r.bottom > window.innerHeight - EDGE + 1 || r.top < EDGE - 1) measure();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place === null]);

  // Expose the menu state on the trigger button for assistive technology.
  useEffect(() => {
    const btn = triggerButton();
    if (!btn) return;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', String(open));
    if (open) btn.setAttribute('aria-controls', menuId);
    else btn.removeAttribute('aria-controls');
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Close just the menu — not the drawer or dialog it was opened from.
        e.preventDefault();
        close(true);
      } else if (e.key === 'Tab') {
        close(false);
      }
    };
    const onViewport = () => measure();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('touchstart', onDoc, { passive: true });
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewport);
    window.addEventListener('scroll', onViewport, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('touchstart', onDoc);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('scroll', onViewport, true);
    };
  }, [open, close, measure]);

  // Keyboard users land on the first item.
  useEffect(() => {
    if (!open || !place) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    first?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place === null]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || []);
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = list[(i + 1) % list.length];
    else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <div ref={anchorRef} className="relative inline-flex">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            dir="rtl"
            onKeyDown={onMenuKey}
            className="fixed z-[90] bg-surface border border-line rounded-[12px] shadow-pop py-1.5 animate-pop-in"
            style={{
              width: `min(${width}px, calc(100vw - ${EDGE * 2}px))`,
              top: place?.top ?? -9999,
              left: place?.left,
              right: place?.right,
              visibility: place ? 'visible' : 'hidden',
            }}
          >
            {header && <div className="px-3 pt-1.5 pb-2 border-b border-line mb-1">{header}</div>}
            {items.map((it, i) =>
              it === 'divider' ? (
                <div key={`d${i}`} role="separator" className="my-1.5 h-px bg-line" />
              ) : (
                <button
                  key={it.label}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    // Focus goes back to the trigger first: a dialog opened by
                    // this item then returns focus there when it closes.
                    triggerButton()?.focus({ preventScroll: true });
                    close(false);
                    it.onClick();
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 h-9 text-[13.5px] text-right transition-colors outline-none disabled:opacity-40 disabled:cursor-not-allowed ${
                    it.tone === 'danger' ? 'text-low-ink hover:bg-low-soft focus-visible:bg-low-soft' : 'text-ink-2 hover:bg-line-2 hover:text-ink focus-visible:bg-line-2 focus-visible:text-ink'
                  }`}
                >
                  {it.icon && <it.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />}
                  <span className="flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-ink-4">{it.hint}</span>}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

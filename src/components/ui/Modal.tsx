import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';

let openCount = 0;

/** Freezes the page behind an overlay; nested overlays share one counter. */
export function useLockScroll(open: boolean) {
  useEffect(() => {
    if (!open) return;
    openCount++;
    document.body.style.overflow = 'hidden';
    return () => {
      openCount--;
      if (openCount <= 0) document.body.style.overflow = '';
    };
  }, [open]);
}

/**
 * Escape closes only the TOPMOST overlay (a confirm dialog above a drawer,
 * the search palette above a modal…), never every open layer at once. A
 * handler that already used the key (an open dropdown menu) calls
 * preventDefault and the overlays leave it alone.
 */
const escapeLayers: Array<{ close: () => void }> = [];
function onEscapeKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const top = escapeLayers[escapeLayers.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

export function useEscapeLayer(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const layer = { close: () => ref.current() };
    escapeLayers.push(layer);
    if (escapeLayers.length === 1) window.addEventListener('keydown', onEscapeKey);
    return () => {
      const i = escapeLayers.indexOf(layer);
      if (i >= 0) escapeLayers.splice(i, 1);
      if (!escapeLayers.length) window.removeEventListener('keydown', onEscapeKey);
    };
  }, [open]);
}

/** Puts keyboard focus back where it was (the button that opened the overlay). */
export function useRestoreFocus(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before && before !== document.body && before.isConnected) {
        window.setTimeout(() => {
          // Only if nothing else claimed focus meanwhile (e.g. a page change).
          if (!document.activeElement || document.activeElement === document.body) before.focus({ preventScroll: true });
        }, 0);
      }
    };
  }, [open]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keeps Tab / Shift+Tab inside a dialog instead of wandering to the page behind it. */
export function trapTabKey(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key !== 'Tab' || e.defaultPrevented) return;
  const root = e.currentTarget;
  if (!root.contains(document.activeElement)) return; // a nested dialog handles its own
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
  if (!items.length) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

/** Dialog on desktop, bottom sheet on phones. */
export function Modal({ open, onClose, title, description, icon, children, footer, size = 'md' }: ModalProps) {
  useLockScroll(open);
  useEscapeLayer(open, onClose);
  useRestoreFocus(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      (panel.querySelector<HTMLElement>('[data-autofocus], input, textarea, select') || panel).focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!open) return null;
  const width = { sm: 'sm:max-w-[420px]', md: 'sm:max-w-[560px]', lg: 'sm:max-w-[760px]', xl: 'sm:max-w-[980px]' }[size];
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center sm:p-6" dir="rtl">
      <div className="absolute inset-0 bg-[#18211c]/40 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTabKey}
        className={`relative w-full ${width} max-h-[92vh] sm:max-h-[88vh] flex flex-col bg-surface shadow-pop rounded-t-[20px] sm:rounded-[18px] animate-sheet-up sm:animate-pop-in outline-none`}
      >
        <div className="sm:hidden mx-auto mt-2.5 mb-0.5 w-10 h-1 rounded-full bg-line-strong" />
        <div className="flex items-start gap-3 px-5 sm:px-6 pt-4 sm:pt-5 pb-3">
          {icon && <div className="w-10 h-10 rounded-[11px] bg-brand-soft flex items-center justify-center shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 id={titleId} className="text-base font-bold text-ink leading-snug">
              {title}
            </h2>
            {description && <p className="text-[13px] text-ink-3 mt-1 leading-relaxed">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="بستن" className="w-9 h-9 -mt-1 -ml-2 rounded-control flex items-center justify-center text-ink-3 hover:bg-line-2 hover:text-ink shrink-0">
            <X className="w-[18px] h-[18px]" />
          </button>
        </div>
        <div className="px-5 sm:px-6 pb-5 overflow-y-auto hv-scroll flex-1 min-h-0">{children}</div>
        {footer && (
          <div className="px-5 sm:px-6 py-3.5 border-t border-line flex flex-wrap items-center justify-end gap-2 hv-safe-bottom bg-surface rounded-b-[18px]">{footer}</div>
        )}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'تأیید',
  tone = 'danger',
  loading,
  confirmDisabled,
  children,
}: {
  open: boolean;
  onClose: () => void;
  /** May return a promise: the button shows progress and ignores repeat clicks until it settles. */
  onConfirm: () => unknown;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  /** E.g. until the user has typed the name of what is being deleted. */
  confirmDisabled?: boolean;
  children?: React.ReactNode;
}) {
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const busy = running || Boolean(loading);
  const confirm = async () => {
    if (runningRef.current || loading || confirmDisabled) return; // a double click must not send the request twice
    runningRef.current = true;
    setRunning(true);
    try {
      await onConfirm();
    } catch (err) {
      console.error(err);
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          {/* Destructive actions start on «انصراف»: Enter must never delete by accident. */}
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus={tone === 'danger' ? true : undefined}>
            انصراف
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void confirm()}
            loading={busy}
            disabled={confirmDisabled}
            data-autofocus={tone === 'danger' ? undefined : true}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

/** Side drawer (left edge in RTL) — mobile candidate panel, notifications. */
export function Drawer({
  open,
  onClose,
  children,
  width = 440,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  label: string;
}) {
  useLockScroll(open);
  useEscapeLayer(open, onClose);
  useRestoreFocus(open);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    }, 30);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70]" dir="rtl">
      <div className="absolute inset-0 bg-[#18211c]/35 animate-fade-in" onClick={onClose} />
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={trapTabKey}
        className="absolute inset-y-0 left-0 w-full bg-surface shadow-pop flex flex-col animate-slide-in outline-none"
        style={{ maxWidth: width }}
      >
        {children}
      </aside>
    </div>,
    document.body
  );
}

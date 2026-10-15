import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';

let openCount = 0;

function useLockScroll(open: boolean) {
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

function useEscape(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') ref.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
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
  useEscape(open, onClose);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => panelRef.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select')?.focus(), 30);
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
        className={`relative w-full ${width} max-h-[92vh] sm:max-h-[88vh] flex flex-col bg-surface shadow-pop rounded-t-[20px] sm:rounded-[18px] animate-sheet-up sm:animate-pop-in`}
      >
        <div className="sm:hidden mx-auto mt-2.5 mb-0.5 w-10 h-1 rounded-full bg-line-strong" />
        <div className="flex items-start gap-3 px-5 sm:px-6 pt-4 sm:pt-5 pb-3">
          {icon && <div className="w-10 h-10 rounded-[11px] bg-brand-soft flex items-center justify-center shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1 pt-0.5">
            <h2 className="text-base font-bold text-ink leading-snug">{title}</h2>
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
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} data-autofocus>
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
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[70]" dir="rtl">
      <div className="absolute inset-0 bg-[#18211c]/35 animate-fade-in" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="absolute inset-y-0 left-0 w-full bg-surface shadow-pop flex flex-col animate-slide-in"
        style={{ maxWidth: width }}
      >
        {children}
      </aside>
    </div>,
    document.body
  );
}

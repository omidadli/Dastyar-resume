import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

type Tone = 'success' | 'error' | 'info';
interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
  action?: { label: string; onClick: () => void };
}

let seq = 0;
const listeners = new Set<(items: ToastItem[]) => void>();
let items: ToastItem[] = [];

function publish() {
  listeners.forEach((l) => l(items));
}

export function toast(message: string, tone: Tone = 'success', action?: ToastItem['action'], durationMs = 4200) {
  const id = ++seq;
  items = [...items.slice(-3), { id, message, tone, action }];
  publish();
  window.setTimeout(() => dismiss(id), action ? durationMs + 3000 : durationMs);
}

function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  publish();
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info };
const TONES = { success: 'text-brand', error: 'text-low', info: 'text-ink-3' };

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return (
    <div className="fixed z-[100] bottom-[84px] lg:bottom-6 inset-x-0 flex flex-col items-center gap-2 pointer-events-none px-3" aria-live="polite" dir="rtl">
      {list.map((t) => {
        const Icon = ICONS[t.tone];
        return (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-center gap-3 max-w-[520px] w-full sm:w-auto pr-3.5 pl-2 py-2.5 rounded-[12px] bg-[#1f2622] text-white shadow-pop animate-pop-in"
          >
            <Icon className={`w-5 h-5 shrink-0 ${TONES[t.tone]}`} strokeWidth={2} />
            <span className="text-[13.5px] leading-relaxed flex-1">{t.message}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="text-[13px] font-bold text-[#7ee29a] hover:text-white px-2 py-1 rounded-md shrink-0"
              >
                {t.action.label}
              </button>
            )}
            <button onClick={() => dismiss(t.id)} aria-label="بستن" className="w-7 h-7 rounded-md flex items-center justify-center text-white/60 hover:text-white shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

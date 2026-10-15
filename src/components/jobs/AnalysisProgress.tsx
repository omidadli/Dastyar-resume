import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, CircleHelp, Loader2, Square, X } from 'lucide-react';
import type { AnalysisRun } from '../../lib/analysis';
import { faDuration, toPersianDigits } from '../../lib/format';
import { Button, IconButton } from '../ui';

/** Live progress of a background analysis for one job opening. */
export function AnalysisProgress({ run, onCancel, onDismiss }: { run: AnalysisRun; onCancel: () => void; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const p = run.progress;
  const pct = run.status === 'done' ? 100 : p?.overallPercent ?? 2;
  const running = run.status === 'running';
  const items = p?.items || [];
  const done = items.filter((i) => ['success', 'unjudgeable', 'error'].includes(i.status)).length;

  return (
    <div className={`hv-card overflow-hidden ${running ? 'border-brand/30' : ''}`}>
      <div className="p-4 flex items-start gap-3.5">
        <span className={`w-10 h-10 rounded-[11px] flex items-center justify-center shrink-0 ${running ? 'bg-brand-soft' : run.status === 'done' ? 'bg-high-soft' : 'bg-review-soft'}`}>
          {running ? (
            <Loader2 className="w-5 h-5 text-brand-strong animate-spin" />
          ) : run.status === 'done' ? (
            <CheckCircle2 className="w-5 h-5 text-high-ink" />
          ) : (
            <AlertCircle className="w-5 h-5 text-review-ink" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[14px] font-bold text-ink">
              {running
                ? `تحلیل ${toPersianDigits(run.fileCount)} رزومه`
                : run.status === 'done'
                ? 'تحلیل کامل شد'
                : run.status === 'cancelled'
                ? 'تحلیل متوقف شد'
                : 'تحلیل با خطا متوقف شد'}
            </p>
            <span className="text-[13px] font-extrabold text-ink hv-num">{toPersianDigits(pct)}٪</span>
          </div>
          <p className="text-[12.5px] text-ink-3 mt-0.5 truncate">
            {running
              ? p?.subStatusText || p?.statusText || 'در حال آماده‌سازی…'
              : run.status === 'done' && run.result
              ? [
                  run.result.aiCount ? `${toPersianDigits(run.result.aiCount)} با هوش مصنوعی` : '',
                  run.result.localCount ? `${toPersianDigits(run.result.localCount)} با موتور محلی` : '',
                  run.result.unjudgeable ? `${toPersianDigits(run.result.unjudgeable)} اطلاعات ناکافی` : '',
                  run.result.errors ? `${toPersianDigits(run.result.errors)} خطا` : '',
                ]
                  .filter(Boolean)
                  .join('، ')
              : run.error || 'رزومه‌های تحلیل‌شده تا این لحظه ذخیره شده‌اند.'}
          </p>
          <div className="mt-2.5 h-2 rounded-full bg-line-2 overflow-hidden">
            <div className={`h-full rounded-full transition-[width] duration-500 ${run.status === 'done' ? 'bg-high' : 'bg-brand'}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-2 text-[11.5px] text-ink-3">
            <span>
              {toPersianDigits(done)} از {toPersianDigits(run.fileCount)} فایل
              {running && p?.estimatedSecondsRemaining ? ` · حدود ${faDuration(p.estimatedSecondsRemaining)} باقی مانده` : ''}
            </span>
            {p?.warningText && running && <span className="text-review-ink font-semibold">{p.warningText}</span>}
          </div>
        </div>
        {running ? (
          <Button variant="secondary" size="sm" icon={Square} onClick={onCancel}>
            توقف
          </Button>
        ) : (
          <IconButton icon={X} label="بستن" size="sm" onClick={onDismiss} />
        )}
      </div>
      {items.length > 0 && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            className="w-full flex items-center justify-center gap-1 h-9 border-t border-line-2 text-[12px] font-semibold text-ink-3 hover:bg-canvas"
          >
            {open ? 'بستن جزئیات' : 'وضعیت فایل‌ها'}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <ul className="max-h-[240px] overflow-y-auto hv-scroll border-t border-line-2 divide-y divide-line-2">
              {items.map((it) => (
                <li key={it.id} className="flex items-center gap-2.5 px-4 py-2">
                  {it.status === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 text-high shrink-0" />
                  ) : it.status === 'error' ? (
                    <AlertCircle className="w-4 h-4 text-low shrink-0" />
                  ) : it.status === 'unjudgeable' ? (
                    <CircleHelp className="w-4 h-4 text-na shrink-0" />
                  ) : it.status === 'evaluating' || it.status === 'extracting' ? (
                    <Loader2 className="w-4 h-4 text-brand animate-spin shrink-0" />
                  ) : (
                    <span className="w-4 h-4 rounded-full border-2 border-line-strong shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 text-[12.5px] text-ink-2 truncate hv-latin text-right">{it.name}</span>
                  <span className="text-[11.5px] text-ink-4 shrink-0">
                    {it.status === 'success' && it.score !== undefined
                      ? `${toPersianDigits(it.score)}٪`
                      : it.status === 'error'
                      ? 'خطا'
                      : it.status === 'unjudgeable'
                      ? 'ناکافی'
                      : it.status === 'evaluating'
                      ? 'در حال تحلیل'
                      : it.status === 'extracting'
                      ? 'در حال خواندن'
                      : 'در صف'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

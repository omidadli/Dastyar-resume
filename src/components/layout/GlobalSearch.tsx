import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, BriefcaseBusiness, CornerDownLeft, Plus, Search, Users } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { useDebounced } from '../../lib/useAsync';
import type { SearchResults } from '../../types/app';
import { MatchPill, Monogram, Spinner, trapTabKey, useEscapeLayer, useLockScroll, useRestoreFocus } from '../ui';
import { faNumber, toPersianDigits } from '../../lib/format';

interface Row {
  key: string;
  to: string;
  render: (active: boolean) => React.ReactNode;
}

/** Ctrl/⌘+K command palette: candidates, job openings and quick actions. */
export function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ q: string; data: SearchResults } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(q.trim(), 220);
  useLockScroll(open);
  useEscapeLayer(open, onClose);
  useRestoreFocus(open);

  useEffect(() => {
    if (open) {
      setQ('');
      setResults(null);
      setFailed(false);
      setActive(0);
      const t = window.setTimeout(() => inputRef.current?.focus(), 20);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !debounced) {
      setResults(null);
      setLoading(false);
      setFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    api.insights
      .search(debounced, { signal: controller.signal })
      .then((r) => {
        setResults({ q: debounced, data: r });
        setActive(0);
      })
      .catch((err) => {
        if (controller.signal.aborted || err?.name === 'AbortError') return;
        setResults(null);
        setFailed(true);
      })
      .finally(() => {
        // A newer query owns the spinner now.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [debounced, open]);

  // Results belong to the query that produced them: while a newer one is on
  // its way, show nothing rather than the previous answer under the new words.
  const fresh = results && results.q === debounced ? results.data : null;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (!debounced) {
      out.push({
        key: 'new',
        to: '/app/jobs/new',
        render: (a) => (
          <QuickRow active={a} icon={<Plus className="w-4 h-4" />} title="ایجاد فرصت شغلی جدید" hint="معیارها و پرسش‌نامه با کمک هویدا" />
        ),
      });
      out.push({
        key: 'pending',
        to: '/app/candidates?tab=pending',
        render: (a) => <QuickRow active={a} icon={<Users className="w-4 h-4" />} title="کاندیداهای در انتظار تصمیم" hint="تطابق بالا و نیازمند بررسی" />,
      });
      out.push({
        key: 'jobs',
        to: '/app/jobs',
        render: (a) => <QuickRow active={a} icon={<BriefcaseBusiness className="w-4 h-4" />} title="همه فرصت‌های شغلی" />,
      });
      return out;
    }
    for (const c of fresh?.candidates || []) {
      out.push({
        key: `c-${c.id}`,
        to: `/app/jobs/${c.jobId}?c=${c.id}`,
        render: (a) => (
          <div className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] ${a ? 'bg-brand-tint' : ''}`}>
            <Monogram name={c.name} size={34} />
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold text-ink truncate" dir="auto">
                {c.name}
              </p>
              <p className="text-[12px] text-ink-3 truncate">
                {c.lastRole ? `${c.lastRole} · ` : ''}
                {c.roleTitle}
              </p>
            </div>
            <span className="hv-num text-[12.5px] font-bold text-ink-2">{c.category === 'UNJUDGEABLE' || c.category === 'ERROR' ? '—' : `${toPersianDigits(c.score)}٪`}</span>
            <MatchPill category={c.category} size="sm" className="max-sm:hidden" />
          </div>
        ),
      });
    }
    for (const j of fresh?.jobs || []) {
      out.push({
        key: `j-${j.id}`,
        to: `/app/jobs/${j.id}`,
        render: (a) => (
          <div className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] ${a ? 'bg-brand-tint' : ''}`}>
            <span className="w-[34px] h-[34px] rounded-[10px] bg-line-2 flex items-center justify-center text-ink-3 shrink-0">
              <BriefcaseBusiness className="w-4 h-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-bold text-ink truncate">{j.roleTitle}</p>
              <p className="text-[12px] text-ink-3 truncate">
                <bdi>{j.departmentName}</bdi>، {faNumber(j.total)} رزومه
              </p>
            </div>
            <ArrowLeft className="w-4 h-4 text-ink-4" />
          </div>
        ),
      });
    }
    return out;
  }, [debounced, fresh]);

  if (!open) return null;

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && rows[active]) {
      e.preventDefault();
      go(rows[active].to);
    }
  };

  const candidateCount = fresh?.candidates.length || 0;
  const waiting = Boolean(debounced) && !fresh && !failed;

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-start justify-center px-3 pt-[8vh] sm:pt-[12vh]" dir="rtl">
      <div className="absolute inset-0 bg-[#18211c]/40 backdrop-blur-[2px] animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="جست‌وجو"
        onKeyDown={trapTabKey}
        className="relative w-full max-w-[620px] bg-surface rounded-[18px] shadow-pop animate-pop-in overflow-hidden"
      >
        <div className="flex items-center gap-3 px-4 h-14 border-b border-line">
          <Search className="w-5 h-5 text-ink-4 shrink-0" strokeWidth={1.8} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="نام کاندید، مهارت، شهر یا عنوان شغل…"
            className="flex-1 bg-transparent outline-none text-[15px] text-ink placeholder:text-ink-4"
            aria-label="عبارت جست‌وجو"
          />
          {(loading || (q.trim() && q.trim() !== debounced)) && <Spinner className="w-4 h-4" />}
          <kbd className="hidden sm:inline hv-latin text-[11px] font-semibold text-ink-3 border border-line rounded-md px-1.5 py-0.5">Esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto hv-scroll p-2">
          {!debounced && <p className="px-3 pt-1 pb-2 text-[11.5px] font-bold text-ink-4">دسترسی سریع</p>}
          {debounced && failed && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-semibold text-ink-2">جست‌وجو انجام نشد.</p>
              <p className="text-xs text-ink-3 mt-1">اتصال اینترنت را بررسی کنید و دوباره بنویسید.</p>
            </div>
          )}
          {debounced && fresh && rows.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm font-semibold text-ink-2">نتیجه‌ای برای «{debounced}» پیدا نشد.</p>
              <p className="text-xs text-ink-3 mt-1">املای دیگری را امتحان کنید؛ جست‌وجو به نیم‌فاصله و «ی/ي» حساس نیست.</p>
            </div>
          )}
          {waiting && <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">در حال جست‌وجو…</p>}
          {debounced && candidateCount > 0 && <p className="px-3 pt-1 pb-1.5 text-[11.5px] font-bold text-ink-4">کاندیداها</p>}
          {rows.map((r, i) => (
            <React.Fragment key={r.key}>
              {debounced && i === candidateCount && (fresh?.jobs.length || 0) > 0 && (
                <p className="px-3 pt-3 pb-1.5 text-[11.5px] font-bold text-ink-4">فرصت‌های شغلی</p>
              )}
              <button className="w-full text-right block" onMouseEnter={() => setActive(i)} onClick={() => go(r.to)}>
                {r.render(i === active)}
              </button>
            </React.Fragment>
          ))}
        </div>
        <div className="hidden sm:flex items-center gap-4 px-4 h-10 border-t border-line text-[11.5px] text-ink-4">
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft className="w-3.5 h-3.5" /> باز کردن
          </span>
          <span>↑ ↓ جابه‌جایی</span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function QuickRow({ active, icon, title, hint }: { active: boolean; icon: React.ReactNode; title: string; hint?: string }) {
  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 rounded-[10px] ${active ? 'bg-brand-tint' : ''}`}>
      <span className="w-[34px] h-[34px] rounded-[10px] bg-brand-soft text-brand-strong flex items-center justify-center shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-bold text-ink">{title}</p>
        {hint && <p className="text-[12px] text-ink-3">{hint}</p>}
      </div>
      <ArrowLeft className="w-4 h-4 text-ink-4" />
    </div>
  );
}

import React from 'react';
import { Columns3, X } from 'lucide-react';
import { clearCompare, removeFromCompare, useCompare, COMPARE_MAX } from '../../lib/compare';
import { navigate, useLocation } from '../../lib/router';
import { Button, Monogram } from '../ui';
import { toPersianDigits } from '../../lib/format';

/** Only where candidates are browsed — never on top of reports, settings or the dashboard. */
const TRAY_PAGES = /^\/app\/(?:jobs\/(?!new(?:\/|$))[^/]+|candidates|talent)/;

export function useCompareTrayVisible(): boolean {
  const { items } = useCompare();
  const { pathname } = useLocation();
  return items.length > 0 && TRAY_PAGES.test(pathname);
}

/** Floating tray listing candidates picked for side-by-side comparison. */
export function CompareTray() {
  const { items, jobTitle } = useCompare();
  const visible = useCompareTrayVisible();
  if (!visible) return null;
  return (
    <div className="hidden lg:flex fixed bottom-5 left-1/2 -translate-x-1/2 lg:translate-x-[calc(-50%-128px)] z-40 items-center gap-3 pl-2 pr-4 py-2 rounded-[16px] bg-[#1f2622] text-white shadow-pop animate-pop-in">
      <div className="flex flex-col leading-tight ml-1">
        <span className="text-[13px] font-bold">مقایسه کاندیداها</span>
        <span className="text-[11.5px] text-white/60 max-w-[200px] truncate">{jobTitle}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {items.map((i) => (
          <span key={i.id} className="group relative" title={i.name}>
            <Monogram name={i.name} size={34} className="ring-2 ring-[#1f2622]" />
            <button
              onClick={() => removeFromCompare(i.id)}
              aria-label={`حذف ${i.name} از مقایسه`}
              className="absolute -top-1 -left-1 w-4 h-4 rounded-full bg-white text-ink flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        {Array.from({ length: COMPARE_MAX - items.length }).map((_, k) => (
          <span key={k} className="w-[34px] h-[34px] rounded-full border border-dashed border-white/25" />
        ))}
      </div>
      <Button
        size="sm"
        icon={Columns3}
        disabled={items.length < 2}
        onClick={() => navigate(`/app/compare?ids=${items.map((i) => i.id).join(',')}`)}
        title={items.length < 2 ? 'دست‌کم دو کاندید انتخاب کنید' : undefined}
      >
        مقایسه ({toPersianDigits(items.length)})
      </Button>
      <button onClick={clearCompare} className="text-[12px] text-white/60 hover:text-white px-1">
        پاک کردن
      </button>
    </div>
  );
}

import { Copy, ListChecks, MessageSquareQuote, Pencil, Sparkles, TriangleAlert, Trash2 } from 'lucide-react';
import type { MeetingSummary } from '../../types/summary';
import { SUMMARY_SOURCE_LABEL } from '../../types/summary';
import { copyText } from '../../lib/clipboard';
import { faDate } from '../../lib/format';
import { Button, Chip, IconButton, toast } from '../ui';

/** The whole summary as plain text — for a scorecard, an e-mail or a note. */
export function summaryToText(s: MeetingSummary): string {
  const block = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((i) => `• ${i}`).join('\n')}` : '';
  return [
    `خلاصهٔ «${s.title}»`,
    s.headline,
    '',
    block('نکته‌های مهم', s.highlights),
    block('سؤال‌های باز و نگرانی‌ها', s.concerns),
    block('قدم‌های بعدی', s.nextSteps),
    block('از زبان خودش', s.quotes),
    '',
    `منبع خلاصه: ${SUMMARY_SOURCE_LABEL[s.source]}`,
  ]
    .filter((line) => line !== '')
    .join('\n\n')
    .replace(/\n\n\n+/g, '\n\n');
}

/**
 * «خلاصهٔ جلسه» — a card that always says where it came from. The local engine
 * is quoted, not written; the AI line carries the model's name. Neither one
 * claims to judge the person, and the card says so.
 */
export function MeetingSummaryCard({
  summary,
  onDelete,
  onRegenerate,
  regenerating,
}: {
  summary: MeetingSummary;
  onDelete?: () => void;
  onRegenerate?: () => void;
  regenerating?: boolean;
}) {
  const sections: { icon: typeof ListChecks; title: string; items: string[]; tone?: string }[] = [
    { icon: ListChecks, title: 'نکته‌های مهم', items: summary.highlights },
    { icon: TriangleAlert, title: 'سؤال‌های باز و نگرانی‌ها', items: summary.concerns },
    { icon: ListChecks, title: 'قدم‌های بعدی', items: summary.nextSteps },
    { icon: MessageSquareQuote, title: 'از زبان خودش', items: summary.quotes },
  ];

  return (
    <div className="rounded-[12px] border border-line-2 bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Chip tone={summary.source === 'ai' ? 'brand' : 'neutral'} icon={Sparkles}>
          {SUMMARY_SOURCE_LABEL[summary.source]}
        </Chip>
        <span className="text-[11px] text-ink-4">{faDate(summary.createdAtISO)}</span>
        {summary.createdByName && <span className="text-[11px] text-ink-4">· {summary.createdByName}</span>}
        <span className="text-[11px] text-ink-4">— {summary.sentenceCount.toLocaleString('fa-IR')} جمله خوانده شد</span>
        <span className="ms-auto flex items-center gap-1">
          <IconButton
            icon={Copy}
            label="کپی خلاصه"
            onClick={async () => {
              const ok = await copyText(summaryToText(summary));
              toast(ok ? 'خلاصه کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error');
            }}
          />
          {onRegenerate && <IconButton icon={Pencil} label="ساخت دوباره" onClick={onRegenerate} disabled={regenerating} />}
          {onDelete && <IconButton icon={Trash2} label="پاک‌کردن خلاصه" onClick={onDelete} />}
        </span>
      </div>

      <p className="text-[13px] font-semibold text-ink leading-6">{summary.headline}</p>

      <div className="flex flex-col gap-2.5 mt-2.5">
        {sections
          .filter((s) => s.items.length)
          .map(({ icon: Icon, title, items }) => (
            <div key={title}>
              <p className="text-[11.5px] font-medium text-ink-3 inline-flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5" strokeWidth={1.9} />
                {title}
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {items.map((line, i) => (
                  <li key={i} className="text-[12.5px] text-ink-2 leading-6 ps-3 relative">
                    <span className="absolute start-0 top-2.5 w-1 h-1 rounded-full bg-line" />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>

      {summary.source === 'local' && (
        <p className="mt-2.5 text-[11px] text-ink-4 leading-relaxed">
          این خلاصه با «موتور محلی» ساخته شده: جمله‌های خودِ رونویسی رتبه‌بندی و نقل شده‌اند و هیچ جملهٔ تازه‌ای اضافه نشده
          است. برای خلاصهٔ نوشتاری، کلید هوش مصنوعی را در پنل مدیریت اضافه کنید.
        </p>
      )}
      <p className="mt-1.5 text-[11px] text-ink-4 leading-relaxed">
        این کارت قضاوت یا نمره نیست؛ تصمیم استخدام را آدم‌ها با نام و یادداشت می‌گیرند.
      </p>
    </div>
  );
}

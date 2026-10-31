import { useEffect, useState } from 'react';
import { Copy, Link2, RefreshCw, Trash2 } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import type { StatusLink } from '../../types/status';
import { api } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { faDate, toPersianDigits } from '../../lib/format';
import { Button, Callout, Chip, IconButton, Modal, Skeleton, toast } from '../ui';

/**
 * «لینک پیگیری درخواست» — one link per candidate, revocable, and honest about
 * what it shows. HR can see whether the candidate opened it; the page itself
 * carries no score, note or decision reason.
 */
export function StatusLinkModal({ record, onClose }: { record: ResumeListItem | null; onClose: () => void }) {
  const [items, setItems] = useState<StatusLink[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!record) return;
    setItems(null);
    api.status
      .links(record.id)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  };

  useEffect(load, [record?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!record) return;
    setBusy(true);
    try {
      const r = await api.status.create(record.id);
      setItems((prev) => [r.link, ...(prev || []).map((l) => (l.revokedAtISO ? l : { ...l, revokedAtISO: new Date().toISOString() }))]);
      const ok = await copyText(absolute(r.link.url));
      toast(ok ? 'لینک ساخته و کپی شد؛ خودتان برای کارجو بفرستید.' : 'لینک ساخته شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ساختن لینک ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: StatusLink) => {
    try {
      const r = await api.status.revoke(link.id);
      setItems((prev) => (prev || []).map((l) => (l.id === link.id ? r.link : l)));
      toast('لینک غیرفعال شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'غیرفعال‌کردن ممکن نشد.', 'error');
    }
  };

  const active = (items || []).find((l) => !l.revokedAtISO) || null;

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      icon={<Link2 className="w-5 h-5 text-brand-strong" />}
      title="پیگیری درخواست"
      description={record ? `لینکی که «${record.candidateName || 'کارجو'}» وضعیت درخواستش را می‌بیند` : undefined}
      size="md"
    >
      {record && (
        <div className="flex flex-col gap-4">
          <Callout tone="info" icon={Link2} title="این صفحه چه چیزی نشان می‌دهد؟">
            فقط مرحلهٔ فعلی، تاریخ آخرین به‌روزرسانی و ایمیل تماس. امتیاز، یادداشت، نام مصاحبه‌گر و دلیل تصمیم در آن نیست. با
            ساختن لینک تازه، لینک قبلی خودکار غیرفعال می‌شود.
          </Callout>

          {items === null && <Skeleton className="h-[72px] rounded-[12px]" />}

          {active && (
            <div className="rounded-[12px] border border-brand/25 bg-brand-tint/40 p-3.5">
              <p className="text-[11.5px] text-ink-3 mb-1.5">لینک فعال</p>
              <p dir="ltr" className="text-[11.5px] text-ink-2 break-all font-mono">
                {absolute(active.url)}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Copy}
                  onClick={async () => {
                    const ok = await copyText(absolute(active.url));
                    toast(ok ? 'لینک کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error');
                  }}
                >
                  کپی لینک
                </Button>
                <a href={active.url} target="_blank" rel="noreferrer" className="hv-btn hv-btn-ghost hv-btn-sm">
                  دیدن صفحه
                </a>
                <IconButton icon={Trash2} label="غیرفعال‌کردن لینک" onClick={() => void revoke(active)} />
              </div>
              <p className="mt-2 text-[11px] text-ink-4">
                {toPersianDigits(active.views)} بار باز شده
                {active.lastViewedAtISO ? ` · آخرین بار ${faDate(active.lastViewedAtISO)}` : ''} · تا {active.expiresAtJalali} معتبر است
              </p>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11.5px] text-ink-3">
              {active ? 'برای ساختن لینک تازه (و غیرفعال‌شدن این یکی):' : 'هنوز لینکی ساخته نشده است.'}
            </p>
            <Button size="sm" icon={active ? RefreshCw : Link2} onClick={create} loading={busy}>
              {active ? 'لینک تازه' : 'ساختن لینک'}
            </Button>
          </div>

          {(items || []).some((l) => l.revokedAtISO) && (
            <div>
              <p className="text-[12px] font-medium text-ink-2 mb-1.5">لینک‌های قبلی</p>
              <div className="flex flex-col gap-1.5">
                {(items || [])
                  .filter((l) => l.revokedAtISO)
                  .map((l) => (
                    <div key={l.id} className="flex items-center gap-2 text-[11.5px] text-ink-4">
                      <Chip tone="outline">غیرفعال</Chip>
                      <span>ساخته‌شده {faDate(l.createdAtISO)}</span>
                      <span>· {toPersianDigits(l.views)} بازدید</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** The server returns a path; the copied link must be absolute. */
function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${window.location.origin}${url}`;
}

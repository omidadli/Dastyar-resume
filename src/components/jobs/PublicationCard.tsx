import { useEffect, useState } from 'react';
import { CheckCircle2, ClipboardCopy, ExternalLink, Globe2, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, EmptyState, Modal, Select, Skeleton, TextArea, TextInput, toast } from '../ui';
import { api } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { PUBLICATION_STATUS_LABEL, type JobBoardId, type PublicationsView, type PublicationKit } from '../../types/jobboard';

/**
 * «انتشار در جاب‌بورد» — the last step is a human's, and it is recorded.
 *
 * The card never claims to have posted anything: it writes the ad, offers the
 * canonical link, and records where the HR person pasted it. The board rows say
 * what each board needs (account + paid contract) instead of a dead button.
 */
export function PublicationCard({ jobId, isPublic }: { jobId: string; isPublic: boolean }) {
  const [view, setView] = useState<PublicationsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [kit, setKit] = useState<PublicationKit | null>(null);
  const [kitBusy, setKitBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [board, setBoard] = useState<JobBoardId>('jobinja');
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.publications
      .list(jobId)
      .then(setView)
      .catch((err: any) => toast(err?.message || 'خواندن انتشارها ممکن نشد.', 'error'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [jobId]);

  const showKit = async (id: JobBoardId) => {
    setKitBusy(true);
    try {
      const { kit: next } = await api.publications.kit(jobId, id);
      setKit(next);
    } catch (err: any) {
      toast(err?.message || 'ساخت متن آگهی ممکن نشد.', 'error');
    } finally {
      setKitBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const { view: next } = await api.publications.record(jobId, { board, url: url || undefined, note: note || undefined });
      setView(next);
      setOpen(false);
      setUrl('');
      setNote('');
      toast('ثبت شد. هر وقت خواستید وضعیتش را عوض کنید.');
    } catch (err: any) {
      toast(err?.message || 'ثبت انتشار ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    try {
      const { view: next } = await api.publications.update(id, { status });
      if (next) setView(next);
      toast(status === 'removed' ? 'برداشته شد.' : 'وضعیت ثبت شد.', 'info');
    } catch (err: any) {
      toast(err?.message || 'تغییر وضعیت ممکن نشد.', 'error');
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Globe2}
        title="انتشار در جاب‌بورد"
        subtitle="متن آماده + ثبت این‌که کجا منتشر شد"
        action={
          <Button size="sm" icon={Plus} onClick={() => setOpen(true)}>
            ثبت انتشار
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        <Callout tone="info" icon={TriangleAlert} title="انتشار خودکار نداریم — و پنهانش نمی‌کنیم">
          جابینجا، جاب‌ویژن، ای‌استخدام، کوئرا و ایران‌تلنت رابط نوشتن عمومی ندارند؛ انتشار در آن‌ها با قرارداد و
          حساب کارفرمای خودتان است. هویدا متن آماده می‌دهد و ثبت می‌کند کجا منتشر شد؛ هیچ دکمه‌ای این‌جا پیامی
          برای جاب‌بورد نمی‌فرستد.
        </Callout>

        {!isPublic && (
          <p className="text-[12.5px] text-ink-3 leading-relaxed">
            این آگهی هنوز در صفحهٔ استخدام شما منتشر نشده است؛ متن بدون لینک درخواست آماده می‌شود. از بالای همین صفحه
            «انتشار در پورتال» را روشن کنید تا لینک در متن بیاید.
          </p>
        )}

        {loading && <Skeleton className="h-24" />}

        {view && (
          <>
            <div className="flex flex-wrap gap-2">
              {view.boards.slice(0, 6).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => void showKit(b.id)}
                  className="text-[12px] rounded-full border border-line px-2.5 py-1 inline-flex items-center gap-1 hover:border-brand hover:text-brand-ink transition"
                  title={b.requires}
                >
                  <ClipboardCopy className="w-3.5 h-3.5" />
                  متن {b.label}
                  {b.live && <CheckCircle2 className="w-3.5 h-3.5 text-success-ink" />}
                </button>
              ))}
            </div>

            {view.items.length === 0 ? (
              <EmptyState
                icon={Globe2}
                title="هنوز جایی ثبت نشده است"
                description="متن آگهی را از بالا بردارید، در جاب‌بورد بچسبانید، و یک خط این‌جا ثبت کنید: کجا، با چه لینکی، چه روزی."
              />
            ) : (
              <div className="divide-y divide-line-2">
                {view.items.map((item) => (
                  <div key={item.id} className="py-2.5 flex flex-wrap items-center gap-2">
                    <Chip tone={item.status === 'live' ? 'brand' : item.status === 'removed' ? 'neutral' : 'warning'}>
                      {PUBLICATION_STATUS_LABEL[item.status]}
                    </Chip>
                    <span className="text-[13px] font-semibold text-ink">
                      {view.boards.find((b) => b.id === item.board)?.label || 'جای دیگر'}
                    </span>
                    <span className="text-[11.5px] text-ink-4">
                      {item.postedAtJalali} — {item.postedByName}
                    </span>
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer" className="text-[12px] text-brand-ink inline-flex items-center gap-1">
                        لینک آگهی
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <div className="mr-auto flex items-center gap-1">
                      {item.status !== 'live' && item.status !== 'removed' && (
                        <Button size="sm" variant="ghost" onClick={() => void setStatus(item.id, 'live')}>
                          منتشر شد
                        </Button>
                      )}
                      {item.status === 'live' && (
                        <Button size="sm" variant="ghost" onClick={() => void setStatus(item.id, 'removed')}>
                          برداشته شد
                        </Button>
                      )}
                      <button
                        type="button"
                        onClick={() => setRemoving(item.id)}
                        title="حذف ثبت"
                        aria-label="حذف ثبت"
                        className="p-1.5 rounded-md text-ink-4 hover:text-low-ink hover:bg-canvas transition"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {view.portalUrl && (
              <p className="text-[12px] text-ink-3 leading-relaxed">
                لینک اصلی همیشه صفحهٔ خودتان است:{' '}
                <a href={view.portalUrl} target="_blank" rel="noreferrer" className="text-brand-ink">
                  {view.portalUrl}
                </a>{' '}
                — همان‌جا که `JobPosting` معتبر برای گوگل هم سرو می‌شود.
              </p>
            )}
          </>
        )}
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="کجا منتشر شد؟"
        description="این ثبت برای تیم شماست؛ چیزی برای جاب‌بورد فرستاده نمی‌شود."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              بستن
            </Button>
            <Button loading={saving} onClick={() => void save()}>
              ثبت
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Select
            label="جاب‌بورد"
            value={board}
            onChange={(e) => setBoard(e.target.value as JobBoardId)}
            options={(view?.boards || []).map((b) => ({ value: b.id, label: b.label }))}
          />
          <TextInput label="لینک آگهی (اختیاری)" value={url} onChange={(e) => setUrl(e.target.value)} latin placeholder="https://jobinja.ir/…" />
          <TextArea label="یادداشت (اختیاری)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="مثلاً: بستهٔ ۳۰ روزه، تا پایان ماه." />
        </div>
      </Modal>

      <Modal
        open={Boolean(kit)}
        onClose={() => setKit(null)}
        title={kit ? `متن آگهی برای ${kit.boardLabel}` : 'متن آگهی'}
        description={kit?.requires}
        footer={
          <>
            <Button variant="ghost" onClick={() => setKit(null)}>
              بستن
            </Button>
            <Button
              icon={ClipboardCopy}
              loading={kitBusy}
              onClick={() => {
                if (!kit) return;
                void copyText(kit.text).then((ok) => toast(ok ? 'متن کپی شد؛ در فرم جاب‌بورد بچسبانید.' : 'کپی ممکن نشد؛ متن را انتخاب و کپی کنید.', ok ? 'success' : 'error'));
              }}
            >
              کپی متن
            </Button>
          </>
        }
      >
        {kit && (
          <div className="flex flex-col gap-3">
            <pre dir="rtl" className="text-[12.5px] leading-[1.9] whitespace-pre-wrap bg-canvas border border-line-2 rounded-[10px] p-3 max-h-[320px] overflow-auto">
              {kit.text}
            </pre>
            {kit.missing.length > 0 && (
              <p className="text-[12px] text-warning-ink leading-relaxed">
                این‌ها را جاب‌بورد می‌پرسد و ما از خودمان نمی‌سازیم: {kit.missing.join('، ')}.
              </p>
            )}
            {kit.portalUrl && (
              <p className="text-[11.5px] text-ink-4">
                لینک درخواست در متن، همان صفحهٔ استخدام خودتان است — درخواست‌ها در جاب‌بورد گم نمی‌شوند.
              </p>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            const { view: next } = await api.publications.remove(removing);
            if (next) setView(next);
            toast('ثبت پاک شد.', 'info');
          } catch (err: any) {
            toast(err?.message || 'حذف ممکن نشد.', 'error');
          } finally {
            setRemoving(null);
          }
        }}
        title="این ثبت پاک شود؟"
        description="اگر فقط آگهی را برداشته‌اید، بهتر است وضعیتش را «برداشته شد» کنید تا تاریخچه بماند."
        confirmLabel="پاک کن"
      />
    </Card>
  );
}

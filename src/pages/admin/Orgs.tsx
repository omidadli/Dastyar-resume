import React, { useState } from 'react';
import { Ban, Building2, CalendarClock, CheckCircle2, LifeBuoy, MoreHorizontal, Pencil, Trash2, Users } from 'lucide-react';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorState, Menu, Modal, SearchInput, Segmented, Skeleton, TextInput, toast } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { navigate } from '../../lib/router';
import { faNumber, faRelative } from '../../lib/format';
import type { AdminOrgRow } from '../../types/admin';
import { AdminHeader, faDateTime, useDebounced } from './shared';

type Filter = 'all' | 'active' | 'demo' | 'suspended';
type Dialog =
  | { kind: 'rename'; org: AdminOrgRow }
  | { kind: 'suspend'; org: AdminOrgRow }
  | { kind: 'delete'; org: AdminOrgRow }
  | { kind: 'support-link'; url: string }
  | null;

export default function Orgs() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const query = useDebounced(q);
  const { data, error, loading, reload, setData } = useAsync(() => adminApi.orgs({ q: query, filter }), [query, filter]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');

  const replace = (org: AdminOrgRow) => setData((d) => (d ? { items: d.items.map((o) => (o.id === org.id ? org : o)) } : d));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setDialog(null);
    } catch (err: any) {
      toast(err?.message || 'انجام نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openSupport = async (org: AdminOrgRow) => {
    // Open the tab inside the click (popup blockers), then point it at the session.
    const tab = window.open('about:blank', '_blank');
    try {
      const { token } = await adminApi.support(org.id);
      const url = `/app#support=${token}`;
      if (tab) tab.location.href = url;
      else setDialog({ kind: 'support-link', url });
      toast(`نشست پشتیبانی «${org.name}» به مدت ۲ ساعت باز شد.`);
    } catch (err: any) {
      tab?.close();
      toast(err?.message || 'ورود پشتیبانی ممکن نشد.', 'error');
    }
  };

  const items = data?.items || [];

  return (
    <div>
      <AdminHeader title="فضاهای کاری" subtitle="همه سازمان‌هایی که در هویدا ثبت‌نام کرده‌اند؛ تعلیق، تمدید نسخه نمایشی، ورود پشتیبانی و حذف." />
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={q} onChange={setQ} placeholder="جست‌وجوی نام سازمان یا ایمیل مالک…" className="w-full sm:w-[320px]" />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          items={[
            { id: 'all', label: 'همه' },
            { id: 'active', label: 'فعال' },
            { id: 'demo', label: 'نمایشی' },
            { id: 'suspended', label: 'معلق' },
          ]}
          size="sm"
        />
      </div>

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data && loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-[12px]" />
          ))}
        </div>
      ) : !items.length ? (
        <EmptyState icon={Building2} title="فضای کاری‌ای پیدا نشد" description="فیلتر یا عبارت جست‌وجو را تغییر دهید." />
      ) : (
        <div className="hv-card overflow-hidden">
          <div className="overflow-x-auto hv-scroll">
            <table className="w-full text-[13px] min-w-[860px]">
              <thead className="bg-line-2/60 text-ink-3 text-[12px]">
                <tr>
                  <th className="text-right font-semibold px-4 py-2.5">سازمان</th>
                  <th className="text-right font-semibold px-3 py-2.5">مالک</th>
                  <th className="text-center font-semibold px-3 py-2.5">اعضا</th>
                  <th className="text-center font-semibold px-3 py-2.5">فرصت‌ها</th>
                  <th className="text-center font-semibold px-3 py-2.5">رزومه‌ها</th>
                  <th className="text-right font-semibold px-3 py-2.5">آخرین فعالیت</th>
                  <th className="text-right font-semibold px-3 py-2.5">وضعیت</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {items.map((o) => (
                  <tr key={o.id} className="hover:bg-line-2/30">
                    <td className="px-4 py-3">
                      <p className="font-bold text-ink">{o.name}</p>
                      <p className="text-[11.5px] text-ink-3 mt-0.5">ساخته‌شده {faRelative(o.createdAtISO)}</p>
                    </td>
                    <td className="px-3 py-3">
                      {o.owner ? (
                        <>
                          <p className="font-semibold text-ink-2">{o.owner.name}</p>
                          <p className="text-[11.5px] text-ink-3 hv-latin text-right">{o.owner.email}</p>
                        </>
                      ) : (
                        <span className="text-ink-4">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center hv-num">{faNumber(o.members)}</td>
                    <td className="px-3 py-3 text-center hv-num">{faNumber(o.jobs)}</td>
                    <td className="px-3 py-3 text-center hv-num">{faNumber(o.resumes)}</td>
                    <td className="px-3 py-3 text-ink-3">{o.lastActivityISO ? faRelative(o.lastActivityISO) : '—'}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap gap-1">
                        {o.suspended ? (
                          <Chip tone="danger" icon={Ban} title={o.suspendedReason || undefined}>
                            معلق
                          </Chip>
                        ) : (
                          <Chip tone="brand" icon={CheckCircle2}>
                            فعال
                          </Chip>
                        )}
                        {o.isDemo && (
                          <Chip tone="warning" icon={CalendarClock} title={o.demoExpiresAt ? `پایان: ${faDateTime(o.demoExpiresAt)}` : undefined}>
                            نمایشی
                          </Chip>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-left">
                      <Menu
                        align="end"
                        width={230}
                        items={[
                          { label: 'ورود پشتیبانی (۲ ساعت)', icon: LifeBuoy, onClick: () => void openSupport(o) },
                          { label: 'کاربران این فضای کاری', icon: Users, onClick: () => navigate(`/admin/users?orgId=${o.id}`) },
                          {
                            label: 'تغییر نام',
                            icon: Pencil,
                            onClick: () => {
                              setText(o.name);
                              setDialog({ kind: 'rename', org: o });
                            },
                          },
                          ...(o.isDemo
                            ? [
                                { label: 'تمدید ۷ روزه نسخه نمایشی', icon: CalendarClock, onClick: () => void run(async () => replace((await adminApi.extendDemo(o.id, 168)).org), 'نسخه نمایشی ۷ روز تمدید شد.') },
                                { label: 'تبدیل به فضای کاری دائمی', icon: CheckCircle2, onClick: () => void run(async () => replace((await adminApi.convertDemo(o.id)).org), 'فضای کاری دائمی شد.') },
                              ]
                            : []),
                          o.suspended
                            ? { label: 'رفع تعلیق', icon: CheckCircle2, onClick: () => void run(async () => replace((await adminApi.updateOrg(o.id, { suspended: false })).org), 'تعلیق برداشته شد.') }
                            : {
                                label: 'تعلیق دسترسی',
                                icon: Ban,
                                onClick: () => {
                                  setText('');
                                  setDialog({ kind: 'suspend', org: o });
                                },
                              },
                          'divider',
                          {
                            label: 'حذف کامل',
                            icon: Trash2,
                            tone: 'danger',
                            onClick: () => {
                              setText('');
                              setDialog({ kind: 'delete', org: o });
                            },
                          },
                        ]}
                        trigger={({ toggle }) => (
                          <button onClick={toggle} aria-label={`عملیات ${o.name}`} className="w-8 h-8 rounded-[9px] inline-flex items-center justify-center text-ink-3 hover:bg-line-2">
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        )}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={dialog?.kind === 'rename'}
        onClose={() => setDialog(null)}
        title="تغییر نام فضای کاری"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              انصراف
            </Button>
            <Button
              loading={busy}
              onClick={() => dialog?.kind === 'rename' && run(async () => replace((await adminApi.updateOrg(dialog.org.id, { name: text })).org), 'نام به‌روز شد.')}
            >
              ذخیره
            </Button>
          </>
        }
      >
        <TextInput label="نام تازه" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Modal>

      <ConfirmDialog
        open={dialog?.kind === 'suspend'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'suspend' ? `تعلیق «${dialog.org.name}»` : ''}
        description="اعضای این فضای کاری بلافاصله خارج می‌شوند و تا رفع تعلیق نمی‌توانند وارد شوند. داده‌ها حفظ می‌شوند."
        confirmLabel="تعلیق کن"
        loading={busy}
        onConfirm={() =>
          dialog?.kind === 'suspend' && run(async () => replace((await adminApi.updateOrg(dialog.org.id, { suspended: true, suspendedReason: text })).org), 'فضای کاری معلق شد.')
        }
      >
        <TextInput label="دلیل (به اعضا نشان داده می‌شود)" optional value={text} onChange={(e) => setText(e.target.value)} placeholder="مثلاً: پایان دوره قرارداد" />
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'delete' ? `حذف کامل «${dialog.org.name}»` : ''}
        description="همه اعضا، فرصت‌های شغلی، رزومه‌ها و فایل‌های این فضای کاری برای همیشه پاک می‌شوند. این کار برگشت‌پذیر نیست."
        confirmLabel="حذف برای همیشه"
        loading={busy}
        onConfirm={() =>
          dialog?.kind === 'delete' &&
          run(async () => {
            await adminApi.deleteOrg(dialog.org.id, text.trim());
            setData((d) => (d ? { items: d.items.filter((o) => o.id !== dialog.org.id) } : d));
          }, 'فضای کاری حذف شد.')
        }
      >
        <TextInput label={dialog?.kind === 'delete' ? `برای تأیید، «${dialog.org.name}» را بنویسید` : ''} value={text} onChange={(e) => setText(e.target.value)} />
      </ConfirmDialog>

      <Modal open={dialog?.kind === 'support-link'} onClose={() => setDialog(null)} title="نشست پشتیبانی آماده است" size="sm">
        <p className="text-[13px] text-ink-2 leading-relaxed">مرورگر باز شدن زبانه تازه را مسدود کرد. برای ورود روی پیوند زیر بزنید:</p>
        {dialog?.kind === 'support-link' && (
          <a href={dialog.url} target="_blank" rel="noopener" className="mt-3 inline-flex font-bold text-brand-ink hover:underline">
            باز کردن فضای کاری در زبانه تازه ←
          </a>
        )}
      </Modal>
    </div>
  );
}

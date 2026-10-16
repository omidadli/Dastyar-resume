import React, { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Copy, KeyRound, LogOut, MoreHorizontal, ShieldCheck, ShieldOff, Trash2, UserCog, Users as UsersIcon, X } from 'lucide-react';
import { Button, Callout, Chip, ConfirmDialog, EmptyState, ErrorState, Menu, Modal, SearchInput, Segmented, Select, Skeleton, toast } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { navigate, useLocation } from '../../lib/router';
import { faNumber, faRelative } from '../../lib/format';
import { copyText } from '../../lib/clipboard';
import { useAuth } from '../../lib/auth';
import type { AdminUserRow } from '../../types/admin';
import type { Role } from '../../types/app';
import { AdminHeader, ROLE_LABEL, useDebounced } from './shared';

type Filter = 'all' | 'admins' | 'owners' | 'disabled';
type Dialog =
  | { kind: 'role'; user: AdminUserRow }
  | { kind: 'delete'; user: AdminUserRow }
  | { kind: 'reset'; user: AdminUserRow }
  | { kind: 'password'; user: AdminUserRow; password: string }
  | null;

export default function UsersPage() {
  const { query } = useLocation();
  const orgId = query.get('orgId') || '';
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const search = useDebounced(q);
  const { data, error, loading, reload, setData } = useAsync(() => adminApi.users({ q: search, filter, orgId }), [search, filter, orgId]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);

  const replace = (u: AdminUserRow) => setData((d) => (d ? { items: d.items.map((x) => (x.id === u.id ? u : x)) } : d));
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok);
    } catch (err: any) {
      toast(err?.message || 'انجام نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const items = data?.items || [];
  // Remember the workspace name: a search with no hits must not turn it into «…».
  const [orgName, setOrgName] = useState<string | null>(null);
  const firstOrgName = orgId ? items.find((u) => u.orgId === orgId)?.orgName : undefined;
  useEffect(() => {
    if (!orgId) setOrgName(null);
    else if (firstOrgName) setOrgName(firstOrgName);
  }, [orgId, firstOrgName]);

  return (
    <div>
      <AdminHeader
        title="کاربران"
        subtitle="همه کاربران همه فضاهای کاری: نقش، دسترسی مدیر سامانه، غیرفعال‌سازی، بستن نشست‌ها و بازنشانی رمز عبور."
      />
      {orgId && (
        <Callout
          tone="brand"
          className="mb-4"
          action={
            <Button size="sm" variant="ghost" icon={X} onClick={() => navigate('/admin/users')}>
              همه کاربران
            </Button>
          }
        >
          فقط کاربران فضای کاری <b>{orgName || '…'}</b> نمایش داده می‌شوند.
        </Callout>
      )}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={q} onChange={setQ} placeholder="نام، ایمیل یا سازمان…" className="w-full sm:w-[320px]" />
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          size="sm"
          items={[
            { id: 'all', label: 'همه' },
            { id: 'admins', label: 'مدیران سامانه' },
            { id: 'owners', label: 'مالکان' },
            { id: 'disabled', label: 'غیرفعال' },
          ]}
        />
      </div>

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data && loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-[12px]" />
          ))}
        </div>
      ) : !items.length ? (
        <EmptyState icon={UsersIcon} title="کاربری پیدا نشد" description="فیلتر یا عبارت جست‌وجو را تغییر دهید." />
      ) : (
        <div className="hv-card overflow-hidden">
          <div className="overflow-x-auto hv-scroll">
            <table className="w-full text-[13px] min-w-[820px]">
              <thead className="bg-line-2/60 text-ink-3 text-[12px]">
                <tr>
                  <th className="text-right font-semibold px-4 py-2.5">کاربر</th>
                  <th className="text-right font-semibold px-3 py-2.5">فضای کاری</th>
                  <th className="text-right font-semibold px-3 py-2.5">نقش</th>
                  <th className="text-right font-semibold px-3 py-2.5">آخرین ورود</th>
                  <th className="text-center font-semibold px-3 py-2.5">نشست فعال</th>
                  <th className="text-right font-semibold px-3 py-2.5">وضعیت</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {items.map((u) => {
                  const isMe = u.id === me?.id;
                  return (
                    <tr key={u.id} className="hover:bg-line-2/30">
                      <td className="px-4 py-3">
                        <p className="font-bold text-ink">
                          {u.name} {isMe && <span className="text-[11px] text-brand-ink font-semibold">(شما)</span>}
                        </p>
                        <p className="text-[11.5px] text-ink-3 hv-latin text-right">{u.email}</p>
                      </td>
                      <td className="px-3 py-3">
                        <p className="text-ink-2 font-semibold">{u.orgName}</p>
                        {u.orgIsDemo && <p className="text-[11px] text-review-ink">نمایشی</p>}
                      </td>
                      <td className="px-3 py-3 text-ink-2">{ROLE_LABEL[u.role]}</td>
                      <td className="px-3 py-3 text-ink-3">{u.lastLoginISO ? faRelative(u.lastLoginISO) : 'هرگز'}</td>
                      <td className="px-3 py-3 text-center hv-num">{faNumber(u.sessions)}</td>
                      <td className="px-3 py-3">
                        <div className="flex flex-wrap gap-1">
                          {u.disabled ? (
                            <Chip tone="danger" icon={Ban}>
                              غیرفعال
                            </Chip>
                          ) : (
                            <Chip tone="neutral">فعال</Chip>
                          )}
                          {u.platformAdmin && (
                            <Chip tone="brand" icon={ShieldCheck} title={u.platformAdminViaEnv ? 'از طریق متغیر ADMIN_EMAILS' : undefined}>
                              مدیر سامانه
                            </Chip>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-left">
                        <Menu
                          align="end"
                          width={240}
                          items={[
                            {
                              label: 'تغییر نقش در فضای کاری',
                              icon: UserCog,
                              onClick: () => {
                                setRole(u.role);
                                setDialog({ kind: 'role', user: u });
                              },
                            },
                            { label: 'بازنشانی رمز عبور', icon: KeyRound, onClick: () => setDialog({ kind: 'reset', user: u }) },
                            { label: 'بستن همه نشست‌ها', icon: LogOut, onClick: () => void run(async () => replace((await adminApi.revokeSessions(u.id)).user), 'نشست‌ها بسته شد.') },
                            ...(!isMe && !u.platformAdminViaEnv
                              ? [
                                  u.platformAdmin
                                    ? { label: 'گرفتن نقش مدیر سامانه', icon: ShieldOff, onClick: () => void run(async () => replace((await adminApi.updateUser(u.id, { platformAdmin: false })).user), 'نقش مدیر سامانه گرفته شد.') }
                                    : { label: 'دادن نقش مدیر سامانه', icon: ShieldCheck, onClick: () => void run(async () => replace((await adminApi.updateUser(u.id, { platformAdmin: true })).user), 'این کاربر مدیر سامانه شد.') },
                                ]
                              : []),
                            ...(!isMe
                              ? [
                                  u.disabled
                                    ? { label: 'فعال‌سازی حساب', icon: CheckCircle2, onClick: () => void run(async () => replace((await adminApi.updateUser(u.id, { disabled: false })).user), 'حساب فعال شد.') }
                                    : { label: 'غیرفعال‌سازی حساب', icon: Ban, onClick: () => void run(async () => replace((await adminApi.updateUser(u.id, { disabled: true })).user), 'حساب غیرفعال شد و نشست‌هایش بسته شد.') },
                                  'divider' as const,
                                  { label: 'حذف کاربر', icon: Trash2, tone: 'danger' as const, onClick: () => setDialog({ kind: 'delete', user: u }) },
                                ]
                              : []),
                          ]}
                          trigger={({ toggle }) => (
                            <button onClick={toggle} aria-label={`عملیات ${u.name}`} className="w-8 h-8 rounded-[9px] inline-flex items-center justify-center text-ink-3 hover:bg-line-2">
                              <MoreHorizontal className="w-4 h-4" />
                            </button>
                          )}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={dialog?.kind === 'role'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'role' ? `نقش «${dialog.user.name}»` : ''}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              انصراف
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                dialog?.kind === 'role' &&
                run(async () => {
                  replace((await adminApi.updateUser(dialog.user.id, { role })).user);
                  setDialog(null);
                }, 'نقش به‌روز شد.')
              }
            >
              ذخیره
            </Button>
          </>
        }
      >
        <Select
          label="نقش در فضای کاری"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={[
            { value: 'owner', label: 'مالک — همه اختیارات' },
            { value: 'admin', label: 'مدیر — تنظیمات و اعضا' },
            { value: 'member', label: 'عضو — کار با رزومه‌ها' },
          ]}
        />
      </Modal>

      <Modal
        open={dialog?.kind === 'password'}
        onClose={() => setDialog(null)}
        title="رمز عبور موقت ساخته شد"
        size="sm"
        footer={<Button onClick={() => setDialog(null)}>بستن</Button>}
      >
        {dialog?.kind === 'password' && (
          <>
            <p className="text-[13px] text-ink-2 leading-relaxed">
              این رمز را از راهی امن به <b>{dialog.user.name}</b> بدهید؛ فقط همین یک بار نمایش داده می‌شود. همه نشست‌های قبلی او بسته شد و پس از ورود می‌تواند رمز را عوض کند.
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-[12px] border border-line bg-line-2/50 px-3 py-2.5">
              <code className="flex-1 hv-latin text-[15px] font-bold text-ink tracking-wide text-left" dir="ltr">
                {dialog.password}
              </code>
              <Button size="sm" variant="secondary" icon={Copy} onClick={() => void copyText(dialog.password).then((ok) => toast(ok ? 'کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error'))}>
                کپی
              </Button>
            </div>
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={dialog?.kind === 'reset'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'reset' ? `بازنشانی رمز «${dialog.user.name}»` : ''}
        description={
          dialog?.kind === 'reset' && dialog.user.id === me?.id
            ? 'رمز فعلی شما از کار می‌افتد و یک رمز موقت ساخته می‌شود؛ نشست‌های شما در دستگاه‌های دیگر بسته می‌شود.'
            : 'رمز فعلی این کاربر از کار می‌افتد، همه نشست‌هایش بسته می‌شود و یک رمز موقت ساخته می‌شود که باید از راهی امن به او بدهید.'
        }
        confirmLabel="ساخت رمز موقت"
        loading={busy}
        onConfirm={() =>
          dialog?.kind === 'reset' &&
          run(async () => {
            const target = dialog.user;
            const { tempPassword } = await adminApi.resetPassword(target.id);
            setDialog({ kind: 'password', user: target, password: tempPassword });
            reload();
          })
        }
      />

      <ConfirmDialog
        open={dialog?.kind === 'delete'}
        onClose={() => setDialog(null)}
        title={dialog?.kind === 'delete' ? `حذف «${dialog.user.name}»` : ''}
        description="حساب و نشست‌های این کاربر حذف می‌شود؛ رزومه‌ها و تصمیم‌های ثبت‌شده در فضای کاری باقی می‌مانند."
        confirmLabel="حذف کاربر"
        loading={busy}
        onConfirm={() =>
          dialog?.kind === 'delete' &&
          run(async () => {
            await adminApi.deleteUser(dialog.user.id);
            setData((d) => (d ? { items: d.items.filter((x) => x.id !== dialog.user.id) } : d));
            setDialog(null);
          }, 'کاربر حذف شد.')
        }
      />
    </div>
  );
}

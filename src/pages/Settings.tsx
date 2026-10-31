import React, { useEffect, useRef, useState } from 'react';
import {
  Braces,
  Building2,
  Copy,
  EyeOff,
  Cpu,
  KeyRound,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  PlugZap,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Wand2,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, ButtonLink, Callout, Card, CardHeader, Chip, ConfirmDialog, ErrorState, IconButton, Modal, Monogram, Select, Spinner, Switch, Tabs, TextArea, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useAuth, useCan } from '../lib/auth';
import { emitChange } from '../lib/events';
import { faDate, faRelative, toPersianDigits } from '../lib/format';
import { navigate, useLeaveGuard } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { Department, Role, TeamMember } from '../types/app';
import type { RetentionAction } from '../types/retention';
import { IntegrationsTab } from './settings/IntegrationsTab';
import { OfferApprovalCard } from '../components/settings/OfferApprovalCard';
import { DeveloperTab } from './settings/DeveloperTab';

type SettingsTab = 'org' | 'departments' | 'team' | 'messages' | 'ai' | 'integrations' | 'developer' | 'account';
const ROLE_LABEL: Record<Role, string> = { owner: 'مالک', admin: 'مدیر', member: 'عضو' };

function ReadOnlyNote() {
  return (
    <Callout tone="info" className="mb-4">
      فقط مالک یا مدیر فضای کاری می‌تواند این بخش را تغییر دهد.
    </Callout>
  );
}

function OrgTab() {
  const { org, setOrg } = useAuth();
  const canEdit = useCan('admin');
  const [name, setName] = useState(org?.name || '');
  const [saving, setSaving] = useState(false);
  useLeaveGuard(canEdit && Boolean(org) && name.trim() !== org?.name);
  if (!org) return null;
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.update({ name: name.trim() });
      setOrg(updated);
      setName(updated.name);
      toast('نام سازمان ذخیره شد.');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="max-w-[640px]">
      <CardHeader icon={Building2} title="اطلاعات سازمان" subtitle="نام سازمان در پیام‌های کاندیداها و در تحلیل‌های هوش مصنوعی استفاده می‌شود." />
      {!canEdit && <ReadOnlyNote />}
      <div className="flex flex-col gap-4">
        <TextInput label="نام سازمان" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
        <div className="grid sm:grid-cols-2 gap-3 text-[13px]">
          <div className="rounded-[12px] bg-canvas border border-line-2 p-3">
            <p className="text-ink-3 text-[12px]">تاریخ ایجاد فضای کاری</p>
            <p className="font-bold text-ink mt-0.5">{faDate(org.createdAtISO)}</p>
          </div>
          <div className="rounded-[12px] bg-canvas border border-line-2 p-3">
            <p className="text-ink-3 text-[12px]">نوع فضای کاری</p>
            <p className="font-bold text-ink mt-0.5">
              {org.isDemo
                ? `نسخه نمایشی — حذف خودکار تا ${toPersianDigits(Math.max(1, Math.ceil((new Date(org.demoExpiresAt || Date.now()).getTime() - Date.now()) / 3600_000)))} ساعت دیگر`
                : 'سازمانی'}
            </p>
          </div>
        </div>
      </div>
      {canEdit && (
        <div className="flex justify-end mt-5 pt-4 border-t border-line-2">
          <Button icon={Save} onClick={save} loading={saving} disabled={name.trim().length < 2 || name.trim() === org.name}>
            ذخیره تغییرات
          </Button>
        </div>
      )}
    </Card>
  );
}

/** A department row in the editor; `_k` keeps React keys stable for rows not saved yet. */
type DeptRow = Department & { _k: string };
let deptSeq = 0;
const toRows = (list: Department[]): DeptRow[] => list.map((d) => ({ ...d, _k: d.id || `new-${++deptSeq}` }));

function DepartmentsTab() {
  const { org, setOrg } = useAuth();
  const canEdit = useCan('admin');
  const [list, setList] = useState<DeptRow[]>(() => toRows(org?.departments || []));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const dirtyRef = useRef(false);
  const setDirty = (v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  };
  // Follow changes made elsewhere (another admin, another tab) — but never
  // overwrite edits that haven't been saved yet.
  const serverKey = JSON.stringify(org?.departments || []);
  useEffect(() => {
    if (dirtyRef.current) return;
    setList(toRows(org?.departments || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey]);
  const patch = (i: number, p: Partial<Department>) => {
    setList((prev) => prev.map((d, k) => (k === i ? { ...d, ...p } : d)));
    setDirty(true);
  };
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // Leaving with unsaved departments (another tab, page, or closing the tab) asks first.
  useLeaveGuard(dirty);
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.setDepartments(list.map((d) => ({ id: d.id || undefined, name: d.name.trim(), hint: d.hint.trim() })));
      setDirty(false);
      setList(toRows(updated.departments));
      setOrg(updated);
      emitChange('org');
      toast('دپارتمان‌ها ذخیره شد.');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="max-w-[820px]">
      <CardHeader
        icon={LayoutGrid}
        title="دپارتمان‌ها"
        subtitle="«حوزه کاری» هر دپارتمان به هوش مصنوعی کمک می‌کند معیارهای دقیق‌تری پیشنهاد دهد. فرصت‌های شغلی قبلی با نام دپارتمان خود باقی می‌مانند."
      />
      {!canEdit && <ReadOnlyNote />}
      <div className="flex flex-col gap-2.5">
        {list.map((d, i) => (
          <div key={d._k} className="grid sm:grid-cols-[220px_1fr_auto] gap-2 items-start rounded-[12px] border border-line p-3">
            <TextInput
              aria-label="نام دپارتمان"
              value={d.name}
              onChange={(e) => patch(i, { name: e.target.value })}
              disabled={!canEdit}
              placeholder="نام دپارتمان"
              autoFocus={d._k === justAdded}
            />
            <TextInput aria-label="حوزه کاری" value={d.hint} onChange={(e) => patch(i, { hint: e.target.value })} disabled={!canEdit} placeholder="حوزه کاری، مثلاً: فروش حضوری، مذاکره، پخش" />
            {canEdit && (
              <IconButton
                icon={Trash2}
                label={d.name.trim() ? `حذف دپارتمان «${d.name.trim()}»` : 'حذف دپارتمان'}
                tone="danger"
                className="mt-0.5"
                disabled={list.length <= 1}
                onClick={() => {
                  setList((prev) => prev.filter((_, k) => k !== i));
                  setDirty(true);
                }}
              />
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-3 mt-4 pt-4 border-t border-line-2">
          <Button
            variant="secondary"
            icon={Plus}
            onClick={() => {
              const key = `new-${++deptSeq}`;
              setList((prev) => [...prev, { id: '', name: '', hint: '', _k: key }]);
              setJustAdded(key); // the new row's name field takes focus
              setDirty(true);
            }}
            disabled={list.length >= 40}
          >
            افزودن دپارتمان
          </Button>
          <Button icon={Save} onClick={save} loading={saving} disabled={!dirty || list.some((d) => d.name.trim().length < 2)}>
            ذخیره دپارتمان‌ها
          </Button>
        </div>
      )}
    </Card>
  );
}

function randomPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  let p = '';
  const rnd = new Uint32Array(12);
  crypto.getRandomValues(rnd);
  for (let i = 0; i < 9; i++) p += chars[rnd[i] % chars.length];
  for (let i = 9; i < 12; i++) p += digits[rnd[i] % digits.length];
  return p;
}

function TeamTab() {
  const { user } = useAuth();
  const canEdit = useCan('admin');
  const isOwner = user?.role === 'owner';
  /** Admins manage members; only the owner appoints, demotes or removes admins. */
  const canManage = (m: TeamMember) => canEdit && m.role !== 'owner' && !m.isYou && (isOwner || m.role === 'member');
  const q = useAsync(() => api.org.get(), []);
  const members = q.data?.members || [];
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', role: 'member' as Role, password: randomPassword() });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [resetting, setResetting] = useState<TeamMember | null>(null);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.org.addMember({ ...form, email: form.email.trim() });
      q.setData((d) => (d ? { ...d, members: res.members } : d));
      setCreated({ email: res.member.email, password: form.password });
      setAddOpen(false);
      setForm({ name: '', email: '', title: '', role: 'member', password: randomPassword() });
      emitChange('activity');
    } catch (e: any) {
      setError({ message: e?.message || 'افزودن عضو ممکن نشد.', field: e?.field });
    } finally {
      setSaving(false);
    }
  };
  const changeRole = async (m: TeamMember, role: Role) => {
    try {
      const res = await api.org.updateMember(m.id, role);
      q.setData((d) => (d ? { ...d, members: res.members } : d));
      toast('نقش به‌روز شد.');
    } catch (e: any) {
      toast(e?.message || 'انجام نشد.', 'error');
    }
  };
  const resetTwoFactor = async () => {
    if (!resetting) return;
    try {
      const res = await api.org.resetMemberTwoFactor(resetting.id);
      q.setData((d) => (d ? { ...d, members: res.members } : d));
      toast(`ورود دومرحله‌ای «${resetting.name}» برداشته شد؛ با رمز عبور وارد می‌شود و می‌تواند دوباره روشنش کند.`, 'info');
      emitChange('activity');
      setResetting(null);
    } catch (e: any) {
      toast(e?.message || 'بازنشانی ممکن نشد.', 'error');
    }
  };
  const remove = async () => {
    if (!removing) return;
    try {
      const res = await api.org.removeMember(removing.id);
      q.setData((d) => (d ? { ...d, members: res.members } : d));
      toast(`«${removing.name}» از تیم حذف شد.`);
      setRemoving(null);
    } catch (e: any) {
      toast(e?.message || 'حذف ممکن نشد.', 'error');
    }
  };

  return (
    <Card className="max-w-[860px]" padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          icon={Users}
          title="اعضای تیم"
          subtitle="مدیران تنظیمات و اعضا را مدیریت می‌کنند و تعیین مدیران با مالک است؛ اعضا به فرصت‌ها و کاندیداها دسترسی کامل دارند."
          action={
            canEdit && (
              <Button
                icon={UserPlus}
                size="sm"
                onClick={() => {
                  setError(null);
                  setAddOpen(true);
                }}
              >
                افزودن عضو
              </Button>
            )
          }
        />
      </div>
      {created && (
        <div className="px-5 pb-4">
          <Callout tone="brand" title="عضو تازه ساخته شد" action={<IconButton icon={Copy} label="کپی اطلاعات ورود" size="sm" onClick={async () => {
                const ok = await copyText(`ایمیل: ${created.email}\nرمز عبور موقت: ${created.password}`);
                toast(ok ? 'اطلاعات ورود کپی شد.' : 'کپی ممکن نشد؛ متن را دستی انتخاب کنید.', ok ? 'success' : 'error');
              }} />}>
            اطلاعات ورود را امن به همکارتان بدهید و از او بخواهید پس از ورود، رمز را از «حساب کاربری» تغییر دهد:
            <span className="block mt-1 hv-latin text-right" dir="ltr">
              {created.email} · {created.password}
            </span>
          </Callout>
        </div>
      )}
      {q.error && !q.data ? (
        <div className="border-t border-line-2">
          <ErrorState message={q.error} onRetry={q.reload} />
        </div>
      ) : q.loading && !q.data ? (
        <div className="p-6 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <ul className="divide-y divide-line-2 border-t border-line-2">
          {members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <Monogram name={m.name} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-bold text-ink">
                  {m.name} {m.isYou && <span className="text-[12px] font-semibold text-ink-3">(شما)</span>}
                </p>
                <p className="text-[12px] text-ink-3 truncate">
                  {m.title ? `${m.title} · ` : ''}
                  <span className="hv-latin">{m.email}</span>
                </p>
              </div>
              <span className="text-[12px] text-ink-4 hidden md:block w-32">{m.lastLoginISO ? `آخرین ورود ${faRelative(m.lastLoginISO)}` : 'هنوز وارد نشده'}</span>
              {canManage(m) ? (
                <div className="flex items-center gap-1.5">
                  {isOwner ? (
                    <Select
                      compact
                      aria-label="نقش"
                      value={m.role}
                      onChange={(e) => changeRole(m, e.target.value as Role)}
                      options={[
                        { value: 'admin', label: 'مدیر' },
                        { value: 'member', label: 'عضو' },
                      ]}
                    />
                  ) : (
                    <span className="text-[12.5px] font-bold text-ink-2 bg-line-2 rounded-full px-3 py-1">{ROLE_LABEL[m.role]}</span>
                  )}
                  {m.twoFactorEnabled && (
                    <IconButton icon={ShieldCheck} label="بازنشانی ورود دومرحله‌ای" size="sm" onClick={() => setResetting(m)} />
                  )}
                  <IconButton icon={Trash2} label="حذف از تیم" size="sm" tone="danger" onClick={() => setRemoving(m)} />
                </div>
              ) : (
                <span className="text-[12.5px] font-bold text-ink-2 bg-line-2 rounded-full px-3 py-1">{ROLE_LABEL[m.role]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        icon={<UserPlus className="w-5 h-5 text-brand-strong" />}
        title="افزودن عضو تیم"
        description="هویدا ایمیل ارسال نمی‌کند؛ رمز موقت را خودتان به همکارتان اعلام کنید."
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              انصراف
            </Button>
            <Button onClick={add} loading={saving}>
              افزودن
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <TextInput label="نام و نام خانوادگی" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} error={error?.field === 'name' ? error.message : null} />
          <TextInput label="ایمیل کاری" type="email" latin value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} error={error?.field === 'email' ? error.message : null} />
          <div className="grid sm:grid-cols-2 gap-4">
            <TextInput label="سمت" optional value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Select
              label="نقش"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
              hint={isOwner ? undefined : 'تعیین مدیر فقط با مالک فضای کاری است.'}
              options={[
                { value: 'member', label: 'عضو — کار با فرصت‌ها و کاندیداها' },
                ...(isOwner ? [{ value: 'admin', label: 'مدیر — به‌علاوه تنظیمات و اعضا' }] : []),
              ]}
            />
          </div>
          <div className="flex items-end gap-2">
            <TextInput label="رمز عبور موقت" latin value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} wrapperClassName="flex-1" error={error?.field === 'password' ? error.message : null} />
            <IconButton icon={Wand2} label="ساخت رمز تازه" onClick={() => setForm({ ...form, password: randomPassword() })} className="border border-line mb-[2px]" />
          </div>
          {error && !error.field && <Callout tone="danger">{error.message}</Callout>}
        </div>
      </Modal>
      <ConfirmDialog
        open={Boolean(resetting)}
        title="بازنشانی ورود دومرحله‌ای"
        description={
          <>
            برای «{resetting?.name}» کلید دومرحله‌ای و همهٔ نشست‌هایش برداشته می‌شود. از این پس فقط با رمز عبور وارد می‌شود و می‌تواند از
            «تنظیمات › حساب کاربری» دوباره روشنش کند. این کار در فعالیت‌های تیم ثبت می‌شود.
          </>
        }
        confirmLabel="بازنشانی"
        tone="primary"
        onClose={() => setResetting(null)}
        onConfirm={resetTwoFactor}
      />
      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title={`حذف «${removing?.name}» از تیم؟`}
        description="دسترسی این عضو بلافاصله قطع می‌شود؛ تصمیم‌ها و فعالیت‌های قبلی او حفظ می‌شود."
        confirmLabel="حذف از تیم"
      />
      {user && !canEdit && (
        <div className="px-5 py-4 border-t border-line-2">
          <p className="text-[12.5px] text-ink-3">برای افزودن یا حذف اعضا با مدیر فضای کاری هماهنگ کنید.</p>
        </div>
      )}
    </Card>
  );
}

function MessagesTab() {
  const { org, setOrg } = useAuth();
  const canEdit = useCan('admin');
  const [sig, setSig] = useState(org?.messageSignature || '');
  const [saving, setSaving] = useState(false);
  useLeaveGuard(canEdit && sig.trim() !== (org?.messageSignature || '').trim());
  if (!org) return null;
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.update({ messageSignature: sig });
      setOrg(updated);
      setSig(updated.messageSignature || '');
      toast('امضای پیام‌ها ذخیره شد.');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid lg:grid-cols-2 gap-5 max-w-[1000px]">
      <Card>
        <CardHeader icon={MessageSquareText} title="امضای پیام‌ها" subtitle="به انتهای همه پیش‌نویس‌های پیام کاندیداها اضافه می‌شود." />
        {!canEdit && <ReadOnlyNote />}
        <TextArea value={sig} onChange={(e) => setSig(e.target.value)} rows={5} disabled={!canEdit} aria-label="امضای پیام‌ها" />
        {canEdit && (
          <div className="flex justify-end mt-4">
            <Button icon={Save} onClick={save} loading={saving} disabled={sig.trim() === (org.messageSignature || '').trim()}>
              ذخیره امضا
            </Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="پیش‌نمایش" subtitle="نمونه پیام دعوت به مصاحبه" />
        <div className="rounded-[12px] bg-canvas border border-line-2 p-4 text-[13.5px] text-ink-2 leading-[1.95] whitespace-pre-wrap">
          {`سلام [نام کاندید] عزیز،\n\nاز اینکه رزومه خود را برای موقعیت «[عنوان فرصت]» در ${org.name} ارسال کردید سپاسگزاریم. خوشحال می‌شویم برای یک گفت‌وگوی آشنایی هماهنگ کنیم.\n\nزمان پیشنهادی: [زمان]\n\n`}
          {/* Same default as the server's drafts when no signature is set. */}
          <span className="font-semibold text-ink">{sig.trim() || `با احترام\nواحد منابع انسانی ${org.name}`}</span>
        </div>
        <p className="text-[12px] text-ink-3 mt-3">پیام‌ها هرگز خودکار ارسال نمی‌شوند؛ شما متن را بررسی می‌کنید و از کانال دلخواه می‌فرستید.</p>
      </Card>
    </div>
  );
}

function AiTab() {
  const { ai, refresh, user } = useAuth();
  const canEdit = useCan('admin');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; error: string | null } | null>(null);
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.ai.test();
      setResult(r);
      void refresh();
    } catch (e: any) {
      setResult({ ok: false, latencyMs: 0, error: e?.message || 'آزمایش ممکن نشد.' });
    } finally {
      setTesting(false);
    }
  };
  if (!ai) return null;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 max-w-[1000px]">
      <Card>
        <CardHeader icon={ai.available ? Sparkles : Cpu} title="وضعیت هوش مصنوعی" subtitle="موتور تحلیل این سرور را مدیر سامانه (میزبان هویدا) تنظیم می‌کند." />
        <div className={`rounded-[14px] border p-4 ${ai.available ? 'border-brand/25 bg-brand-tint' : 'border-review/25 bg-review-soft'}`}>
          <p className={`text-[15px] font-bold ${ai.available ? 'text-brand-stronger' : 'text-review-ink'}`}>
            {ai.available ? (ai.coolingDown ? 'فعال — در حال استراحت کوتاه' : 'فعال') : 'غیرفعال — تحلیل با موتور محلی'}
          </p>
          <p className="text-[13px] text-ink-2 mt-1">{ai.available ? ai.label : ai.reason}</p>
          {ai.available && ai.reason && <p className="text-[12.5px] text-ink-3 mt-1">{ai.reason}</p>}
        </div>
        <div className="mt-4 text-[13px] text-ink-2 leading-[1.9]">
          {ai.available ? (
            <p>پیشنهاد معیارها، تحلیل رزومه‌ها، هم‌سنجی و پیش‌نویس پیام‌ها با این سرویس انجام می‌شود. اگر سرویس موقتاً در دسترس نباشد، تحلیل با موتور محلی و برچسب جداگانه ادامه پیدا می‌کند.</p>
          ) : (
            <p>
              بدون هوش مصنوعی هم می‌توانید کار کنید: فرصت شغلی را با «الگوی آماده دپارتمان» بسازید؛ رزومه‌ها با تطبیق کلیدواژه‌ای و برچسب «تحلیل محلی» بررسی می‌شوند و هر زمان سرویس فعال شد،
              «تحلیل دوباره» را بزنید.
            </p>
          )}
        </div>
        {canEdit && (
          <div className="mt-5 pt-4 border-t border-line-2 flex flex-wrap items-center gap-3">
            <Button variant="secondary" icon={RefreshCw} onClick={test} loading={testing} disabled={!ai.available}>
              آزمایش اتصال
            </Button>
            {result && (
              <span className={`text-[13px] font-semibold ${result.ok ? 'text-brand-ink' : 'text-low-ink'}`}>
                {result.ok ? `اتصال برقرار است (${toPersianDigits(result.latencyMs)} میلی‌ثانیه)` : result.error}
              </span>
            )}
          </div>
        )}
      </Card>
      <Card>
        {user?.platformAdmin ? (
          <>
            <CardHeader title="مدیریت هوش مصنوعی" subtitle="شما مدیر سامانه هستید؛ کلیدها و رفتار هوش مصنوعی را از پنل مدیریت تنظیم کنید." />
            <ul className="text-[13px] text-ink-2 leading-[2] list-disc pr-5">
              <li>تا ۵ کلید Gemini یا سازگار با OpenAI با جابه‌جایی خودکار هنگام محدودیت</li>
              <li>سقف درخواست در دقیقه/روز برای هر کلید و آزمایش اتصال</li>
              <li>دستورالعمل‌های تحلیل، سطح سخت‌گیری و راهنمای تخصصی هر صنعت</li>
            </ul>
            <div className="flex flex-wrap gap-2 mt-4">
              <ButtonLink to="/admin/ai" icon={KeyRound}>
                کلیدهای هوش مصنوعی
              </ButtonLink>
              <ButtonLink to="/admin/behavior" variant="secondary" icon={Sparkles}>
                رفتار هوش مصنوعی
              </ButtonLink>
            </div>
          </>
        ) : (
          <>
            <CardHeader title="چه کسی هوش مصنوعی را تنظیم می‌کند؟" subtitle="مدیر سامانه (میزبان هویدا) از پنل مدیریت" />
            <p className="text-[13px] text-ink-2 leading-[1.9]">
              کلیدهای سرویس، جابه‌جایی خودکار بین آن‌ها و دستورالعمل‌های تحلیل در پنل مدیریت سامانه تنظیم می‌شود. اطلاعات کلیدها هرگز به مرورگر ارسال نمی‌شود.
            </p>
          </>
        )}
        <div className="mt-5 pt-4 border-t border-line-2">
          <p className="text-[13px] font-bold text-ink mb-1.5">قالب‌های قابل تحلیل</p>
          <p className="text-[12.5px] text-ink-3 leading-[1.9]">
            PDF (متنی و اسکن‌شده)، Word (DOCX و DOC)، OpenDocument، RTF، عکس و اسکن (JPG، PNG، HEIC، TIFF، BMP، GIF، WebP، AVIF)، اکسل و CSV، پاورپوینت، صفحه وب، ایمیل (EML و MSG همراه پیوست‌ها)، EPUB، XPS، JSON و XML، فایل‌های فشرده ZIP و TAR و حتی رزومه صوتی یا ویدیویی.
          </p>
        </div>
      </Card>
    </div>
  );
}

function AccountTab() {
  const { user, org, setUser, signOut } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [title, setTitle] = useState(user?.title || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwError, setPwError] = useState<{ message: string; field?: string } | null>(null);
  const [savingPw, setSavingPw] = useState(false);
  // A typed new password counts; the current-password box alone may be the browser's autofill.
  useLeaveGuard(Boolean(user) && (name.trim() !== user?.name || title.trim() !== (user?.title || '') || pw.next !== ''));
  if (!user) return null;
  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const { user: u } = await api.auth.updateMe({ name: name.trim(), title: title.trim() });
      setUser({ ...user, ...u });
      setName(u.name);
      setTitle(u.title || '');
      toast('اطلاعات حساب ذخیره شد.');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSavingProfile(false);
    }
  };
  const savePw = async () => {
    setSavingPw(true);
    setPwError(null);
    try {
      await api.auth.updateMe({ currentPassword: pw.current, newPassword: pw.next });
      setPw({ current: '', next: '' });
      toast('رمز عبور تغییر کرد؛ نشست‌های دیگر شما بسته شد.');
    } catch (e: any) {
      setPwError({ message: e?.message || 'تغییر رمز ممکن نشد.', field: e?.field });
    } finally {
      setSavingPw(false);
    }
  };
  return (
    <div className="max-w-[1000px]">
      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader icon={UserRound} title="حساب کاربری" subtitle={<span className="hv-latin">{user.email}</span>} />
          <div className="flex flex-col gap-4">
            <TextInput label="نام و نام خانوادگی" value={name} onChange={(e) => setName(e.target.value)} />
            <TextInput label="سمت" optional value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً کارشناس جذب" />
          </div>
          <div className="flex flex-wrap justify-between gap-3 mt-5 pt-4 border-t border-line-2">
            <Button variant="danger-soft" icon={LogOut} onClick={() => void signOut()}>
              خروج از حساب
            </Button>
            <Button
              icon={Save}
              onClick={saveProfile}
              loading={savingProfile}
              disabled={name.trim().length < 2 || (name.trim() === user.name && title.trim() === (user.title || ''))}
            >
              ذخیره
            </Button>
          </div>
        </Card>
        <Card>
          <CardHeader icon={KeyRound} title="تغییر رمز عبور" subtitle="پس از تغییر رمز، نشست‌های شما در دستگاه‌های دیگر بسته می‌شود." />
          {org?.isDemo ? (
            <Callout tone="info">در نسخه نمایشی امکان تغییر رمز عبور وجود ندارد.</Callout>
          ) : (
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (pw.current && pw.next.length >= 8 && !savingPw) void savePw();
              }}
            >
              {/* Tells password managers which saved login to update. */}
              <input type="text" name="username" autoComplete="username" value={user.email} readOnly hidden />
              <div className="flex flex-col gap-4">
                <TextInput label="رمز فعلی" type="password" latin value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} error={pwError?.field === 'currentPassword' ? pwError.message : null} autoComplete="current-password" />
                <TextInput label="رمز تازه" type="password" latin value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} hint="دست‌کم ۸ کاراکتر، ترکیبی از حروف و عدد" error={pwError?.field === 'newPassword' ? pwError.message : null} autoComplete="new-password" />
                {pwError && !pwError.field && <Callout tone="danger">{pwError.message}</Callout>}
              </div>
              <div className="flex justify-end mt-5 pt-4 border-t border-line-2">
                <Button type="submit" icon={KeyRound} loading={savingPw} disabled={!pw.current || pw.next.length < 8}>
                  تغییر رمز
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
      <TwoFactorCard />
    </div>
  );
}

/**
 * «غربالگری بی‌طرف» — the workspace switch for blind screening.
 *
 * It is deliberately blunt about what it does: the server removes the identity
 * from every screening view, and the only way back is a reveal that is written
 * to the history with the name of whoever pressed it. Off by default: a small
 * team that knows its candidates does not need it, and it should never surprise
 * anyone mid-hiring.
 */
function BlindCard() {
  const { org, setOrg } = useAuth();
  const canEdit = useCan('admin');
  const [busy, setBusy] = useState(false);
  // Read it fresh: another admin may have flipped it since this tab signed in.
  const state = useAsync(() => api.org.get(), []);
  const current = state.data?.org ?? org;
  if (!current) return null;
  const on = Boolean(current.blindScreening);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const { org: updated } = await api.org.update({ blindScreening: next });
      setOrg(updated);
      state.reload();
      toast(next ? 'غربالگری بی‌طرف روشن شد؛ نام و راه تماس کارجوها پنهان می‌شود.' : 'غربالگری بی‌طرف خاموش شد؛ هویت‌ها دوباره دیده می‌شوند.', next ? 'success' : 'info');
      emitChange('activity');
    } catch (e: any) {
      toast(e?.message || 'تغییر ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-5 max-w-[640px]">
      <CardHeader
        icon={EyeOff}
        title="غربالگری بی‌طرف"
        subtitle="در نمای غربالگری، نام، ایمیل، تلفن و فایل کارجو پنهان می‌شود تا تصمیم بر پایهٔ کار و شاهدها گرفته شود."
        action={on ? <Chip tone="brand">روشن</Chip> : <Chip tone="neutral">خاموش</Chip>}
      />
      <div className="flex flex-col gap-4">
        <Switch
          checked={on}
          disabled={!canEdit || busy}
          onChange={(v) => void toggle(v)}
          label={on ? 'پنهان‌سازی فعال است' : 'پنهان‌سازی خاموش است'}
          description={
            on
              ? 'کارجوها با «کارجوی ۲۴۸۱» و مانند آن شناخته می‌شوند؛ امتیاز، معیارها و شاهدها کامل دیده می‌شوند.'
              : 'همه‌چیز مثل قبل است. با روشن‌کردنش، فیلترها، تختهٔ جذب و پنل کارجو، بی‌نام می‌شوند.'
          }
        />
        {on && (
          <Callout tone="info" title="چطور هویت را ببینیم؟">
            در پنل هر کارجو دکمهٔ «آشکارسازی هویت» هست: با یک دلیل کوتاه، نام و راه تماس برمی‌گردد و همان لحظه در
            «فعالیت‌های تیم» با نام شما ثبت می‌شود. تا وقتی آشکار نکنید، ارسال ایمیل، پیامک، دعوت مصاحبه، پیشنهاد و
            نظرسنجی برای آن کارجو بسته است — روی سرور، نه فقط در ظاهر صفحه.
          </Callout>
        )}
        {!canEdit && <p className="text-[12px] text-ink-4">فقط مدیر یا مالک فضای کاری می‌تواند این تنظیم را تغییر دهد.</p>}
        <p className="text-[12px] text-ink-3 leading-relaxed">
          معیارها و امتیازها از رزومه می‌آیند و بی‌نام نمی‌شوند؛ آنچه پنهان می‌شود هویت است. اگر معیار شما «دانشگاه» یا
          «نام شرکت قبلی» باشد، همان هم پنهان نمی‌شود — این ابزار برای کم‌کردن سوگیری هویتی است، نه ادعای بی‌طرفی کامل.
        </p>
      </div>
    </Card>
  );
}

/**
 * «ورود دومرحله‌ای» — a volunteer setting for every member, shown honestly:
 * the secret is displayed once, the recovery codes only once, and turning it off
 * needs the password plus a live code. The demo workspace cannot enable it.
 */
function TwoFactorCard() {
  const { org, user, setUser } = useAuth();
  const state = useAsync(() => api.auth.twoFactorStatus(), []);
  const [mode, setMode] = useState<'idle' | 'setup' | 'off'>('idle');
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauth: string; qr: string; recoveryCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<null | 'start' | 'enable' | 'disable' | 'recovery'>(null);
  const [fresh, setFresh] = useState<string[]>([]);

  if (state.error || !state.data) return null;
  const status = state.data;
  const reset = () => {
    setMode('idle');
    setPassword('');
    setCode('');
    setSetup(null);
    setSaved(false);
    setFresh([]);
  };

  const start = async () => {
    setBusy('start');
    try {
      setSetup(await api.auth.twoFactorSetup({ password }));
      setMode('setup');
      setCode('');
    } catch (e: any) {
      toast(e?.message || 'شروع راه‌اندازی ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const enable = async () => {
    setBusy('enable');
    try {
      const res = await api.auth.twoFactorEnable({ code: code.trim() });
      state.reload();
      if (user) setUser({ ...user, twoFactorEnabled: true });
      reset();
      toast(`ورود دومرحله‌ای روشن شد؛ ${toPersianDigits(res.recoveryLeft)} کد بازیابی باقی مانده است.`, 'success');
    } catch (e: any) {
      toast(e?.message || 'فعال‌سازی ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    setBusy('disable');
    try {
      await api.auth.twoFactorDisable({ password, code: code.trim() });
      state.reload();
      if (user) setUser({ ...user, twoFactorEnabled: false });
      reset();
      toast('ورود دومرحله‌ای خاموش شد.', 'info');
    } catch (e: any) {
      toast(e?.message || 'خاموش‌کردن ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const newCodes = async () => {
    setBusy('recovery');
    try {
      const res = await api.auth.twoFactorRecovery({ code: code.trim() });
      setFresh(res.recoveryCodes);
      setCode('');
      state.reload();
      toast('کدهای بازیابی تازه ساخته شد؛ کدهای قبلی دیگر کار نمی‌کنند.', 'success');
    } catch (e: any) {
      toast(e?.message || 'ساخت کد تازه ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="mt-5 max-w-[640px]">
      <CardHeader
        icon={ShieldCheck}
        title="ورود دومرحله‌ای"
        subtitle="با هر ورود، گذشته از رمز عبور، یک کد ۶ رقمی از برنامهٔ احراز هویت گوشی هم لازم است."
        action={
          status.enabled ? (
            <Chip tone="brand">روشن</Chip>
          ) : (
            <Chip tone="neutral">خاموش</Chip>
          )
        }
      />

      {status.enabled ? (
        <div className="flex flex-col gap-4">
          <Callout tone="info">
            از {status.enabledAtISO ? faDate(status.enabledAtISO) : 'تاریخ فعال‌سازی'} روشن است؛ {toPersianDigits(status.recoveryLeft)} کد بازیابی
            استفاده‌نشده دارید. اگر کدها را گم کرده‌اید، همین‌جا کد تازه بسازید.
          </Callout>
          {mode === 'off' ? (
            <div className="flex flex-col gap-4">
              <TextInput label="رمز عبور فعلی" type="password" latin value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              <TextInput label="کد فعلی برنامهٔ احراز هویت" latin inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} hint="برای تأیید اینکه گوشی همراهتان است." />
              <div className="flex flex-wrap gap-3 justify-end">
                <Button variant="secondary" onClick={reset}>
                  انصراف
                </Button>
                <Button variant="danger-soft" icon={ShieldCheck} onClick={turnOff} loading={busy === 'disable'} disabled={!password || !code.trim()}>
                  خاموش کردن
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <TextInput
                  className="flex-1"
                  label="کد فعلی (برای ساخت کدهای بازیابی تازه)"
                  latin
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button variant="secondary" icon={RefreshCw} onClick={newCodes} loading={busy === 'recovery'} disabled={!code.trim()}>
                  کد بازیابی تازه
                </Button>
              </div>
              {fresh.length > 0 && <RecoveryCodes codes={fresh} />}
              <div className="flex justify-end pt-4 border-t border-line-2">
                <Button variant="ghost" onClick={() => setMode('off')}>
                  خاموش کردن ورود دومرحله‌ای
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : mode === 'setup' && setup ? (
        <div className="flex flex-col gap-4">
          <ol className="text-[13px] text-ink-2 leading-relaxed list-decimal pr-5">
            <li>یک برنامهٔ احراز هویت نصب کنید (Google Authenticator، Microsoft Authenticator یا هر برنامهٔ TOTP).</li>
            <li>کد QR را اسکن کنید؛ یا کلید زیر را دستی وارد کنید.</li>
            <li>کد ۶ رقمی که برنامه نشان می‌دهد را اینجا وارد کنید.</li>
          </ol>
          <div className="flex flex-col sm:flex-row gap-4 items-start">
            <img src={setup.qr} alt="کد QR برای افزودن حساب به برنامهٔ احراز هویت" width={180} height={180} className="rounded-xl border border-line bg-white p-2" />
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-ink-3 mb-1.5">کلید دستی</p>
              <div className="flex items-center gap-2">
                <code className="hv-latin text-[13px] font-bold tracking-[0.12em] break-all bg-surface-2 rounded-lg px-3 py-2 flex-1">{setup.secret}</code>
                <IconButton icon={Copy} label="کپی کلید" onClick={() => void copyText(setup.secret).then((ok) => ok && toast('کلید کپی شد.'))} />
              </div>
              <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
                این کلید معادل رمز دوم شماست؛ جایی ذخیره یا ارسالش نکنید. هویدا آن را رمزنگاری‌شده نگه می‌دارد.
              </p>
            </div>
          </div>
          <Callout tone="warning" title="کدهای بازیابی را همین حالا بردارید">
            هر کد یک‌بار کار می‌کند و اگر گوشی را از دست دادید تنها راه ورود است. این کدها فقط همین یک‌بار نمایش داده می‌شوند.
          </Callout>
          <RecoveryCodes codes={setup.recoveryCodes} onCopied={() => setSaved(true)} saved={saved} />
          <div className="flex flex-col gap-3 pt-4 border-t border-line-2">
            <TextInput label="کد ۶ رقمی برنامه" latin inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="۱۲۳۴۵۶" />
            <div className="flex flex-wrap gap-3 justify-end">
              <Button variant="secondary" onClick={reset}>
                انصراف
              </Button>
              <Button icon={ShieldCheck} onClick={enable} loading={busy === 'enable'} disabled={!code.trim() || !saved}>
                روشن کردن
              </Button>
            </div>
            {!saved && <p className="text-[12px] text-ink-3 text-end">پیش از روشن‌کردن، کدهای بازیابی را بردارید.</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {org?.isDemo ? (
            <Callout tone="info">در نسخهٔ نمایشی، حساب‌ها مشترک و موقتی‌اند؛ ورود دومرحله‌ای روی حساب واقعی سازمان خودتان روشن می‌شود.</Callout>
          ) : (
            <>
              <TextInput
                label="رمز عبور فعلی"
                type="password"
                latin
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                hint="برای اطمینان از اینکه خودتان هستید."
              />
              <div className="flex justify-end">
                <Button icon={ShieldCheck} onClick={start} loading={busy === 'start'} disabled={!password}>
                  راه‌اندازی
                </Button>
              </div>
            </>
          )}
          <p className="text-[12px] text-ink-3 leading-relaxed">
            مناسب تیم‌هایی که به رزومه‌های واقعی دسترسی دارند. اگر برنامهٔ احراز هویت را گم کنید، با کدهای بازیابی وارد می‌شوید و بعد کد
            تازه می‌سازید؛ بدون هیچ‌کدام، مدیر سامانه باید دسترسی را بازنشانی کند.
          </p>
        </div>
      )}
    </Card>
  );
}

/** The eight codes, shown once, with one button that copies all of them. */
function RecoveryCodes({ codes, saved, onCopied }: { codes: string[]; saved?: boolean; onCopied?: () => void }) {
  return (
    <div className="rounded-xl border border-line-2 bg-surface-2 p-3.5">
      <div className="grid grid-cols-2 gap-2">
        {codes.map((c) => (
          <code key={c} className="hv-latin text-[13px] font-bold tracking-[0.1em] bg-white rounded-lg px-2.5 py-1.5 text-center border border-line">
            {c}
          </code>
        ))}
      </div>
      <div className="flex justify-end mt-3">
        <Button
          size="sm"
          variant="secondary"
          icon={Copy}
          onClick={() => {
            void copyText(codes.join('\n')).then((ok) => {
              if (ok) toast('کدهای بازیابی کپی شدند.');
              onCopied?.();
            });
          }}
        >
          {saved ? 'کپی شد' : 'کپی همهٔ کدها'}
        </Button>
      </div>
    </div>
  );
}

/**
 * «نگه‌داری داده»: after N days a candidate nobody hired either loses their name
 * (anonymise) or the whole record (delete). Hired people and the talent pool are
 * never touched. A dry run is always available, and it never pretends to have
 * deleted anything.
 */
function RetentionCard() {
  const canEdit = useCan('admin');
  const state = useAsync(() => api.org.retention(), []);
  const [days, setDays] = useState('');
  const [action, setAction] = useState<RetentionAction>('anonymize');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<null | 'dry' | 'run'>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [preview, setPreview] = useState<{ days: number; items: Array<{ id: string; name: string; roleTitle: string; updatedAtISO: string }> } | null>(null);

  useEffect(() => {
    if (!state.data) return;
    setDays(String(state.data.policy.days));
    setAction(state.data.policy.action);
  }, [state.data?.policy.days, state.data?.policy.action]);

  if (state.error) return <Callout tone="warning" className="mt-4 max-w-[640px]">{state.error}</Callout>;
  if (!state.data) return null;
  const policy = state.data.policy;
  const due = state.data.preview.items.length;

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.org.saveRetention({ days: Number(days) || 0, action });
      state.reload();
      setPreview(null);
      toast(res.policy.days === 0 ? 'سیاست نگه‌داری خاموش شد.' : `سیاست روی ${toPersianDigits(res.policy.days)} روز ذخیره شد.`, 'success');
    } catch (err: any) {
      toast(err?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const dry = async () => {
    setBusy('dry');
    try {
      const res = await api.org.runRetention({ dryRun: true });
      setPreview({ days: res.result.days, items: res.result.items });
      toast(
        res.result.items.length
          ? `${toPersianDigits(res.result.items.length)} رکورد از این سیاست عبور می‌کند (هیچ‌چیز تغییر نکرد).`
          : 'هیچ رکوردی از این سیاست عبور نمی‌کند.',
        'info'
      );
    } catch (err: any) {
      toast(err?.message || 'اجرای آزمایشی ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setBusy('run');
    try {
      const res = await api.org.runRetention({});
      const total = res.result.deleted + res.result.anonymized;
      toast(
        total
          ? `${toPersianDigits(total)} رکورد پردازش شد (${toPersianDigits(res.result.deleted)} حذف، ${toPersianDigits(res.result.anonymized)} ناشناس).`
          : 'رکوردی برای پردازش نبود.',
        'success'
      );
      setPreview(null);
      state.reload();
    } catch (err: any) {
      toast(err?.message || 'اجرا ممکن نشد.', 'error');
    } finally {
      setBusy(null);
      setConfirmRun(false);
    }
  };

  return (
    <Card className="max-w-[640px] mt-5">
      <CardHeader
        icon={ShieldCheck}
        title="نگه‌داری داده"
        subtitle="چه مدت اطلاعات کارجویانی بماند که استخدام نشده‌اند"
        action={policy.days > 0 ? <Chip tone="brand">روشن، {toPersianDigits(policy.days)} روز</Chip> : <Chip tone="neutral">خاموش</Chip>}
      />
      {!canEdit && <ReadOnlyNote />}
      <div className="flex flex-col gap-4">
        <TextInput
          label="مدت نگه‌داری (روز)"
          value={days}
          onChange={(e) => setDays(e.target.value.replace(/[^0-9۰-۹]/g, ''))}
          inputMode="numeric"
          latin
          hint="۰ = خاموش (هیچ‌چیز خودکار پاک نمی‌شود). حداکثر ۳۶۵۰ روز."
          disabled={!canEdit || saving}
        />
        <div className="flex flex-wrap gap-1.5">
          {[90, 180, 365, 730].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setDays(String(n))}
              disabled={!canEdit}
              className={`text-[12px] rounded-full border px-2.5 py-1 transition ${
                Number(days) === n ? 'border-brand bg-brand-soft text-brand-ink font-semibold' : 'border-line text-ink-3'
              }`}
            >
              {toPersianDigits(n)} روز
            </button>
          ))}
        </div>
        <div>
          <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">وقتی مدت تمام شد چه شود؟</p>
          <div className="flex flex-col gap-2">
            {(
              [
                { id: 'anonymize', title: 'ناشناس‌سازی (پیشنهاد ما)', hint: 'نام، ایمیل، تلفن، متن رزومه و فایل حذف می‌شود؛ امتیاز و آمار برای گزارش می‌ماند.' },
                { id: 'delete', title: 'حذف کامل رکورد', hint: 'همهٔ داده‌ها و فایل پاک می‌شود؛ آمار گذشتهٔ آن کارجو در گزارش‌ها نمی‌ماند.' },
              ] as Array<{ id: RetentionAction; title: string; hint: string }>
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setAction(opt.id)}
                disabled={!canEdit}
                className={`text-right rounded-[12px] border px-3 py-2 transition ${
                  action === opt.id ? 'border-brand bg-brand-soft' : 'border-line-2'
                }`}
              >
                <span className="block text-[13px] font-bold text-ink">{opt.title}</span>
                <span className="block text-[11.5px] text-ink-3 mt-0.5 leading-relaxed">{opt.hint}</span>
              </button>
            ))}
          </div>
        </div>
        <Callout tone="info">
          کارجویانی که استخدام شده‌اند یا در «بانک استعداد» نگه داشته شده‌اید هرگز مشمول این سیاست نمی‌شوند؛ برای آن‌ها فقط از «پاک‌سازی کامل»
          در پروندهٔ همان کارجو استفاده کنید.
        </Callout>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={Save} onClick={() => void save()} loading={saving} disabled={!canEdit || saving}>
            ذخیرهٔ سیاست
          </Button>
          <Button variant="secondary" icon={RefreshCw} onClick={() => void dry()} loading={busy === 'dry'} disabled={busy !== null}>
            اجرای آزمایشی
          </Button>
          {policy.days > 0 && (
            <Button variant="ghost" icon={Trash2} onClick={() => setConfirmRun(true)} disabled={!canEdit || busy !== null}>
              اجرای الآن
            </Button>
          )}
        </div>
        {due > 0 && (
          <p className="text-[12px] text-ink-3">
            در این لحظه {toPersianDigits(due)} رکورد از سیاست عبور می‌کند
            {policy.days > 0 ? ' — اجرای روزانه خودکار انجام می‌شود.' : ' (برای اجرا، سیاست را روشن کنید).'}
          </p>
        )}
        {preview && preview.items.length > 0 && (
          <div className="rounded-[12px] border border-line-2 p-3">
            <p className="text-[12px] font-semibold text-ink-2 mb-1.5">نتیجهٔ اجرای آزمایشی (هیچ‌چیز تغییر نکرد)</p>
            <ul className="text-[12px] text-ink-2 space-y-1">
              {preview.items.slice(0, 6).map((it) => (
                <li key={it.id} className="flex flex-wrap justify-between gap-2">
                  <span className="font-semibold">{it.name}</span>
                  <span className="text-ink-4">{it.roleTitle}</span>
                  <span className="text-ink-4">{faDate(it.updatedAtISO)}</span>
                </li>
              ))}
            </ul>
            {preview.items.length > 6 && <p className="text-[11.5px] text-ink-4 mt-1.5">و {toPersianDigits(preview.items.length - 6)} رکورد دیگر.</p>}
          </div>
        )}
        {policy.lastRunAtISO && (
          <p className="text-[11.5px] text-ink-4">
            آخرین اجرا: {faDate(policy.lastRunAtISO)} — {toPersianDigits(policy.lastRunCount)} رکورد
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmRun}
        onClose={() => setConfirmRun(false)}
        onConfirm={() => void run()}
        title={action === 'delete' ? 'رکوردهای قدیمی حذف شوند؟' : 'رکوردهای قدیمی ناشناس شوند؟'}
        description={
          action === 'delete'
            ? 'همهٔ رکوردهای خارج از سیاست — با فایل، یادداشت، مصاحبه و پیام — برای همیشه حذف می‌شوند. پیش از اجرا، «اجرای آزمایشی» را ببینید.'
            : 'نام، ایمیل، تلفن، متن رزومه و فایل این رکوردها حذف می‌شود؛ امتیاز و آمار می‌ماند. این کار برگشت‌پذیر نیست.'
        }
        confirmLabel="اجرا"
      />
    </Card>
  );
}

const TAB_LABELS: Record<SettingsTab, string> = {
  org: 'سازمان',
  departments: 'دپارتمان‌ها',
  team: 'تیم',
  messages: 'پیام‌ها',
  ai: 'هوش مصنوعی',
  integrations: 'اتصال‌ها',
  developer: 'توسعه‌دهندگان',
  account: 'حساب کاربری',
};

export default function Settings({ tab }: { tab: string }) {
  const known = Object.prototype.hasOwnProperty.call(TAB_LABELS, tab);
  const current = (known ? tab : 'org') as SettingsTab;
  useTitle(`تنظیمات · ${TAB_LABELS[current]}`);
  // An unknown tab in the address: show «سازمان» under its own address.
  useEffect(() => {
    if (tab && !known) navigate('/app/settings/org', { replace: true, force: true });
  }, [tab, known]);
  return (
    <div>
      <PageHeader title="تنظیمات" subtitle="سازمان، دپارتمان‌ها، تیم، پیام‌ها، هوش مصنوعی، اتصال‌ها و API" />
      <Tabs<SettingsTab>
        className="mb-5"
        value={current}
        onChange={(t) => navigate(`/app/settings/${t}`, { keepScroll: true })}
        items={[
          { id: 'org', label: TAB_LABELS.org, icon: Building2 },
          { id: 'departments', label: TAB_LABELS.departments, icon: LayoutGrid },
          { id: 'team', label: TAB_LABELS.team, icon: Users },
          { id: 'messages', label: TAB_LABELS.messages, icon: MessageSquareText },
          { id: 'ai', label: TAB_LABELS.ai, icon: Sparkles },
          { id: 'integrations', label: TAB_LABELS.integrations, icon: PlugZap },
          { id: 'developer', label: TAB_LABELS.developer, icon: Braces },
          { id: 'account', label: TAB_LABELS.account, icon: UserRound },
        ]}
      />
      {current === 'org' && (
        <>
          <OrgTab />
          <BlindCard />
          <OfferApprovalCard />
          <RetentionCard />
        </>
      )}
      {current === 'departments' && <DepartmentsTab />}
      {current === 'team' && <TeamTab />}
      {current === 'messages' && <MessagesTab />}
      {current === 'ai' && <AiTab />}
      {current === 'integrations' && <IntegrationsTab />}
      {current === 'developer' && <DeveloperTab />}
      {current === 'account' && <AccountTab />}
    </div>
  );
}

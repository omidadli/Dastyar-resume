import React, { useEffect, useState } from 'react';
import {
  Building2,
  Copy,
  Cpu,
  KeyRound,
  LayoutGrid,
  LogOut,
  MessageSquareText,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  Wand2,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, ConfirmDialog, IconButton, Modal, Monogram, Select, Spinner, Tabs, TextArea, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { emitChange } from '../lib/events';
import { faDate, faRelative, toPersianDigits } from '../lib/format';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { Department, Role, TeamMember } from '../types/app';

type SettingsTab = 'org' | 'departments' | 'team' | 'messages' | 'ai' | 'account';
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
  if (!org) return null;
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.update({ name });
      setOrg(updated);
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
          <Button icon={Save} onClick={save} loading={saving} disabled={name.trim().length < 2 || name === org.name}>
            ذخیره تغییرات
          </Button>
        </div>
      )}
    </Card>
  );
}

function DepartmentsTab() {
  const { org, setOrg } = useAuth();
  const canEdit = useCan('admin');
  const [list, setList] = useState<Department[]>(org?.departments || []);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setList(org?.departments || []);
    setDirty(false);
  }, [org?.departments]);
  const patch = (i: number, p: Partial<Department>) => {
    setList(list.map((d, k) => (k === i ? { ...d, ...p } : d)));
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.setDepartments(list.map((d) => ({ id: d.id || undefined, name: d.name, hint: d.hint })));
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
          <div key={d.id || `new-${i}`} className="grid sm:grid-cols-[220px_1fr_auto] gap-2 items-start rounded-[12px] border border-line p-3">
            <TextInput aria-label="نام دپارتمان" value={d.name} onChange={(e) => patch(i, { name: e.target.value })} disabled={!canEdit} placeholder="نام دپارتمان" />
            <TextInput aria-label="حوزه کاری" value={d.hint} onChange={(e) => patch(i, { hint: e.target.value })} disabled={!canEdit} placeholder="حوزه کاری، مثلاً: فروش حضوری، مذاکره، پخش" />
            {canEdit && (
              <IconButton
                icon={Trash2}
                label="حذف دپارتمان"
                tone="danger"
                className="mt-0.5"
                disabled={list.length <= 1}
                onClick={() => {
                  setList(list.filter((_, k) => k !== i));
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
              setList([...list, { id: '', name: '', hint: '' }]);
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
  const q = useAsync(() => api.org.get(), []);
  const members = q.data?.members || [];
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', title: '', role: 'member' as Role, password: randomPassword() });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.org.addMember(form);
      q.setData((d) => (d ? { ...d, members: res.members } : d));
      setCreated({ email: form.email, password: form.password });
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
          subtitle="مدیران می‌توانند تنظیمات و اعضا را مدیریت کنند؛ اعضا به فرصت‌ها و کاندیداها دسترسی کامل دارند."
          action={
            canEdit && (
              <Button icon={UserPlus} size="sm" onClick={() => setAddOpen(true)}>
                افزودن عضو
              </Button>
            )
          }
        />
      </div>
      {created && (
        <div className="px-5 pb-4">
          <Callout tone="brand" title="عضو تازه ساخته شد" action={<IconButton icon={Copy} label="کپی اطلاعات ورود" size="sm" onClick={() => navigator.clipboard?.writeText(`ایمیل: ${created.email}\nرمز عبور موقت: ${created.password}`).then(() => toast('کپی شد.'))} />}>
            اطلاعات ورود را امن به همکارتان بدهید و از او بخواهید پس از ورود، رمز را از «حساب کاربری» تغییر دهد:
            <span className="block mt-1 hv-latin text-right" dir="ltr">
              {created.email} · {created.password}
            </span>
          </Callout>
        </div>
      )}
      {q.loading && !q.data ? (
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
              {canEdit && m.role !== 'owner' && !m.isYou ? (
                <div className="flex items-center gap-1.5">
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
              options={[
                { value: 'member', label: 'عضو — کار با فرصت‌ها و کاندیداها' },
                { value: 'admin', label: 'مدیر — به‌علاوه تنظیمات و اعضا' },
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
  const { org, setOrg, user } = useAuth();
  const canEdit = useCan('admin');
  const [sig, setSig] = useState(org?.messageSignature || '');
  const [saving, setSaving] = useState(false);
  if (!org) return null;
  const save = async () => {
    setSaving(true);
    try {
      const { org: updated } = await api.org.update({ messageSignature: sig });
      setOrg(updated);
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
        <TextArea value={sig} onChange={(e) => setSig(e.target.value)} rows={5} disabled={!canEdit} />
        {canEdit && (
          <div className="flex justify-end mt-4">
            <Button icon={Save} onClick={save} loading={saving} disabled={sig === org.messageSignature}>
              ذخیره امضا
            </Button>
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="پیش‌نمایش" subtitle="نمونه پیام دعوت به مصاحبه" />
        <div className="rounded-[12px] bg-canvas border border-line-2 p-4 text-[13.5px] text-ink-2 leading-[1.95] whitespace-pre-wrap">
          {`سلام [نام کاندید] عزیز،\n\nاز اینکه رزومه خود را برای موقعیت «[عنوان فرصت]» در ${org.name} ارسال کردید سپاسگزاریم. خوشحال می‌شویم برای یک گفت‌وگوی آشنایی هماهنگ کنیم.\n\nزمان پیشنهادی: [زمان]\n\n`}
          <span className="font-semibold text-ink">{sig || `واحد منابع انسانی ${org.name}`}</span>
        </div>
        <p className="text-[12px] text-ink-3 mt-3">پیام‌ها هرگز خودکار ارسال نمی‌شوند؛ {user?.name || 'شما'} متن را بررسی و از کانال دلخواه می‌فرستید.</p>
      </Card>
    </div>
  );
}

function AiTab() {
  const { ai, refresh } = useAuth();
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
    <div className="grid lg:grid-cols-[1fr_1fr] gap-5 max-w-[1000px]">
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
        <CardHeader title="راهنمای مدیر سامانه" subtitle="تنظیم از طریق متغیرهای محیطی سرور" />
        <pre className="hv-latin text-left text-[12px] leading-[1.9] bg-[#1f2622] text-[#dff5e5] rounded-[12px] p-4 overflow-x-auto" dir="ltr">
{`# Google Gemini
AI_PROVIDER=gemini
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.5-flash-lite   # optional

# OpenAI-compatible gateway (e.g. an Iranian provider)
AI_PROVIDER=openai
OPENAI_BASE_URL=https://api.example.ir/v1
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini`}
        </pre>
        <p className="text-[12.5px] text-ink-3 mt-3 leading-relaxed">
          با <span className="hv-latin">AI_PROVIDER=auto</span> (پیش‌فرض) اگر کلید Gemini موجود باشد از آن و در غیر این صورت از سرویس سازگار با OpenAI استفاده می‌شود. کلیدها هرگز به مرورگر ارسال نمی‌شوند.
        </p>
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
  if (!user) return null;
  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const { user: u } = await api.auth.updateMe({ name, title });
      setUser(u);
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
    <div className="grid lg:grid-cols-2 gap-5 max-w-[1000px]">
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
          <Button icon={Save} onClick={saveProfile} loading={savingProfile} disabled={name.trim().length < 2 || (name === user.name && title === user.title)}>
            ذخیره
          </Button>
        </div>
      </Card>
      <Card>
        <CardHeader icon={KeyRound} title="تغییر رمز عبور" subtitle="پس از تغییر رمز، نشست‌های شما در دستگاه‌های دیگر بسته می‌شود." />
        {org?.isDemo ? (
          <Callout tone="info">در نسخه نمایشی امکان تغییر رمز عبور وجود ندارد.</Callout>
        ) : (
          <>
            <div className="flex flex-col gap-4">
              <TextInput label="رمز فعلی" type="password" latin value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} error={pwError?.field === 'currentPassword' ? pwError.message : null} autoComplete="current-password" />
              <TextInput label="رمز تازه" type="password" latin value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} hint="دست‌کم ۸ کاراکتر، ترکیبی از حروف و عدد" error={pwError?.field === 'newPassword' ? pwError.message : null} autoComplete="new-password" />
              {pwError && !pwError.field && <Callout tone="danger">{pwError.message}</Callout>}
            </div>
            <div className="flex justify-end mt-5 pt-4 border-t border-line-2">
              <Button icon={KeyRound} onClick={savePw} loading={savingPw} disabled={!pw.current || pw.next.length < 8}>
                تغییر رمز
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export default function Settings({ tab }: { tab: string }) {
  useTitle('تنظیمات');
  const current = (['org', 'departments', 'team', 'messages', 'ai', 'account'].includes(tab) ? tab : 'org') as SettingsTab;
  return (
    <div>
      <PageHeader title="تنظیمات" subtitle="سازمان، دپارتمان‌ها، تیم، پیام‌ها و هوش مصنوعی" />
      <Tabs<SettingsTab>
        className="mb-5"
        value={current}
        onChange={(t) => navigate(`/app/settings/${t}`, { keepScroll: true })}
        items={[
          { id: 'org', label: 'سازمان', icon: Building2 },
          { id: 'departments', label: 'دپارتمان‌ها', icon: LayoutGrid },
          { id: 'team', label: 'تیم', icon: Users },
          { id: 'messages', label: 'پیام‌ها', icon: MessageSquareText },
          { id: 'ai', label: 'هوش مصنوعی', icon: Sparkles },
          { id: 'account', label: 'حساب کاربری', icon: UserRound },
        ]}
      />
      {current === 'org' && <OrgTab />}
      {current === 'departments' && <DepartmentsTab />}
      {current === 'team' && <TeamTab />}
      {current === 'messages' && <MessagesTab />}
      {current === 'ai' && <AiTab />}
      {current === 'account' && <AccountTab />}
    </div>
  );
}

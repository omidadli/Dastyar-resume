import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Download,
  Mail,
  PartyPopper,
  Plus,
  RotateCcw,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  Chip,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  IconButton,
  Modal,
  Segmented,
  Skeleton,
  Stat,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { emitChange } from '../lib/events';
import { faDate, toPersianDigits } from '../lib/format';
import { Link } from '../lib/router';
import { useTitle } from '../lib/useTitle';
import { ONBOARDING_STATUS_LABEL, type OnboardingOverview, type OnboardingPlan, type OnboardingStatus } from '../types/onboarding';

const STATUS_TONE: Record<OnboardingStatus, 'neutral' | 'brand' | 'warning' | 'outline'> = {
  planned: 'neutral',
  in_progress: 'warning',
  completed: 'brand',
  cancelled: 'outline',
};

type Filter = 'active' | 'completed' | 'all';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'active', label: 'در جریان' },
  { id: 'completed', label: 'کامل‌شده' },
  { id: 'all', label: 'همه' },
];

function startHint(days: number): string {
  if (days === 0) return 'امروز روز اول است';
  if (days === 1) return 'فردا شروع می‌کند';
  if (days > 1) return `${toPersianDigits(days)} روز تا روز اول`;
  return `${toPersianDigits(Math.abs(days))} روز از شروع گذشته`;
}

/**
 * «تحویل پس از استخدام» — the page that answers «بعد از پذیرش پیشنهاد چه؟».
 *
 * The plan is born from the hire (the offer page creates it the moment the
 * candidate signs), the date is a Jalali day, and the checklist is the same
 * list HR already keeps on paper. Nothing is emailed until someone clicks;
 * when the workspace has no mailbox the page says so and offers the text to
 * copy, instead of pretending it was sent.
 */
export default function Onboarding() {
  useTitle('تحویل پس از استخدام');
  const canEdit = useCan('admin');
  const [data, setData] = useState<OnboardingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('active');
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<OnboardingPlan | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.onboarding
      .overview()
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e?.message || 'بارگذاری ممکن نشد.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const items = useMemo(() => {
    const all = data?.items || [];
    if (filter === 'all') return all;
    if (filter === 'completed') return all.filter((i) => i.status === 'completed');
    return all.filter((i) => i.status === 'planned' || i.status === 'in_progress');
  }, [data, filter]);

  const selected = useMemo(() => (data?.items || []).find((i) => i.id === selectedId) || null, [data, selectedId]);

  const replacePlan = (plan: OnboardingPlan) => {
    setData((d) => (d ? { ...d, items: d.items.map((i) => (i.id === plan.id ? plan : i)) } : d));
    emitChange('activity');
  };

  const removePlan = async () => {
    if (!removing) return;
    try {
      await api.onboarding.remove(removing.id);
      setData((d) => (d ? { ...d, items: d.items.filter((i) => i.id !== removing.id) } : d));
      if (selectedId === removing.id) setSelectedId(null);
      toast('برنامهٔ تحویل پاک شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک‌کردن ممکن نشد.', 'error');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="تحویل پس از استخدام"
        subtitle="از لحظهٔ پذیرش پیشنهاد تا روز اول: چک‌لیست، مسئول و پیام خوش‌آمد"
        actions={
          <div className="flex items-center gap-2">
            <a href={api.onboarding.exportUrl} className="hv-btn hv-btn-secondary hv-btn-md" download>
              <Download className="w-4 h-4" strokeWidth={1.9} />
              خروجی اکسل
            </a>
            <Button icon={Plus} onClick={() => setCreateOpen(true)} disabled={!canEdit}>
              برنامهٔ تازه
            </Button>
          </div>
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {loading && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[280px] rounded-card" />
        </div>
      )}

      {data && (
        <div className="flex flex-col gap-5">
          <Callout tone="info" icon={PartyPopper} title="استخدام پایان کار نیست">
            لپ‌تاپ، حساب ایمیل، قرارداد و معرفی به تیم باید کسی را داشته باشد. این صفحه همان کار را از لحظهٔ پذیرش پیشنهاد
            شروع می‌کند؛ پیشنهاد شغلی که پذیرفته شود، برنامه را خودکار می‌سازد.
          </Callout>

          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <Stat icon={ClipboardList} label="برنامه‌ریزی‌شده" value={toPersianDigits(data.counts.planned)} note="شروع نشده" />
            <Stat icon={CheckCircle2} label="در جریان" value={toPersianDigits(data.counts.inProgress)} note="دست‌کم یک مورد انجام شده" tone="brand" />
            <Stat icon={CalendarDays} label="شروع در این هفته" value={toPersianDigits(data.counts.startingThisWeek)} note="۷ روز آینده" tone="review" />
            <Stat
              icon={Users}
              label="کامل‌شده"
              value={toPersianDigits(data.counts.completed)}
              note={data.mailbox ? 'پیام خوش‌آمد از صندوق شما می‌رود' : 'صندوق ایمیل وصل نیست؛ متن را کپی کنید'}
            />
          </div>

          <Card>
            <CardHeader
              icon={ClipboardList}
              title="برنامه‌های تحویل"
              subtitle="هر استخدام یک برنامه دارد؛ روی هر ردیف بزنید تا چک‌لیست باز شود."
              action={
                <Segmented
                  value={filter}
                  onChange={(v) => setFilter(v as Filter)}
                  items={FILTERS.map((f) => ({ id: f.id, label: f.label }))}
                />
              }
            />

            {!items.length ? (
              <EmptyState
                icon={PartyPopper}
                title={data.items.length ? 'در این فیلتر چیزی نیست' : 'هنوز کسی استخدام نشده'}
                description={
                  data.items.length
                    ? 'فیلتر دیگری را انتخاب کنید.'
                    : 'وقتی پیشنهاد شغلی پذیرفته شود، برنامهٔ تحویل خودکار ساخته می‌شود. می‌توانید از دکمهٔ «برنامهٔ تازه» هم برای کارجویانی که در ستون «استخدام‌شده» هستند شروع کنید.'
                }
              />
            ) : (
              <div className="flex flex-col divide-y divide-line-2">
                {items.map((plan) => {
                  const percent = plan.total ? Math.round((plan.doneCount / plan.total) * 100) : 0;
                  return (
                    <button
                      key={plan.id}
                      type="button"
                      onClick={() => setSelectedId(plan.id)}
                      className="py-3.5 text-start flex flex-wrap items-center gap-3 rounded-[10px] hover:bg-canvas px-2 -mx-2 transition-colors"
                    >
                      <span className="w-9 h-9 rounded-full bg-brand-tint text-brand-stronger text-[12px] font-semibold flex items-center justify-center shrink-0">
                        {plan.candidateName.trim().charAt(0)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13.5px] font-semibold text-ink truncate">{plan.candidateName}</span>
                          <Chip tone={STATUS_TONE[plan.status]}>{ONBOARDING_STATUS_LABEL[plan.status]}</Chip>
                          <span className="text-[11.5px] text-ink-3">{startHint(plan.daysUntil)}</span>
                        </div>
                        <p className="text-[11.5px] text-ink-3 mt-0.5 truncate">
                          {plan.jobTitle || 'بدون فرصت شغلی'}
                          {plan.departmentName ? ` · ${plan.departmentName}` : ''} · شروع {plan.startDateJalali}
                          {plan.ownerName ? ` · مسئول: ${plan.ownerName}` : ' · بدون مسئول'}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="hidden sm:flex items-center gap-2">
                          <span className="h-1.5 w-24 rounded-full bg-line-2 overflow-hidden">
                            <span className="block h-full bg-brand" style={{ width: `${percent}%` }} />
                          </span>
                          <span className="text-[11.5px] text-ink-3 tabular-nums">
                            {toPersianDigits(plan.doneCount)}/{toPersianDigits(plan.total)}
                          </span>
                        </div>
                        <ArrowLeft className="w-4 h-4 text-ink-4" strokeWidth={1.9} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      )}

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(plan) => {
          setData((d) => (d ? { ...d, items: [...d.items, plan] } : d));
          setCreateOpen(false);
          setSelectedId(plan.id);
          emitChange('activity');
          toast('برنامهٔ تحویل ساخته شد.', 'success');
        }}
      />

      <PlanDrawer
        plan={selected}
        canEdit={canEdit}
        mailbox={Boolean(data?.mailbox)}
        onClose={() => setSelectedId(null)}
        onChange={replacePlan}
        onRemove={(plan) => setRemoving(plan)}
      />

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={removePlan}
        title="این برنامه پاک شود؟"
        description="چک‌لیست و سابقهٔ این تحویل حذف می‌شود. اگر استخدام منتفی شده، «لغو برنامه» را بزنید تا سابقه بماند."
        confirmLabel="پاک‌کردن"
        tone="danger"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ create -- */

interface HiredCandidate {
  id: string;
  candidateName: string;
  candidateEmail: string | null;
  jobTitle: string | null;
  departmentName: string | null;
}

function CreateModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (plan: OnboardingPlan) => void }) {
  const [items, setItems] = useState<HiredCandidate[] | null>(null);
  const [resumeId, setResumeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [owner, setOwner] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setResumeId('');
    setStartDate('');
    setOwner('');
    setNote('');
    api.onboarding
      .hired()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [open]);

  const chosen = items?.find((i) => i.id === resumeId) || null;

  const submit = async () => {
    if (!chosen) {
      toast('کارجو را انتخاب کنید.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.onboarding.create({
        resumeId: chosen.id,
        startDateJalali: startDate.trim() || undefined,
        ownerName: owner.trim() || undefined,
        note: note.trim() || undefined,
      });
      onCreated(r.plan);
    } catch (err: any) {
      toast(err?.message || 'ساختن برنامه ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="برنامهٔ تحویل تازه"
      description="فقط کارجویانی که در ستون «استخدام‌شده» هستند در این فهرست می‌آیند."
      icon={<PartyPopper className="w-4 h-4" />}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={submit} loading={busy} disabled={!chosen}>
            ساختن برنامه
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {items === null && <Skeleton className="h-[120px] rounded-[12px]" />}

        {items && !items.length && (
          <Callout tone="warning" icon={UserRound} title="کارجوی استخدام‌شده‌ای در انتظار نیست">
            اول پیشنهاد شغلی را بفرستید و پذیرش کارجو را ثبت کنید؛ آن لحظه برنامه خودکار ساخته می‌شود. کارجویان در{' '}
            <Link to="/app/jobs" className="text-brand-strong underline">
              فرصت‌های شغلی
            </Link>{' '}
            هستند.
          </Callout>
        )}

        {items && items.length > 0 && (
          <>
            {/* A native select: works on every phone, and the list is short. */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium text-ink-2" htmlFor="onb-candidate">
                کارجو
              </label>
              <select
                id="onb-candidate"
                className="hv-input h-10 text-[13px]"
                value={resumeId}
                onChange={(e) => setResumeId(e.target.value)}
              >
                <option value="">انتخاب کنید…</option>
                {items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.candidateName}
                    {c.jobTitle ? ` — ${c.jobTitle}` : ''}
                  </option>
                ))}
              </select>
            </div>

            <TextInput
              label="روز شروع (شمسی)"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              placeholder="۱۴۰۵/۰۱/۱۵"
              hint="اگر خالی بماند، دو هفته بعد از امروز گذاشته می‌شود."
              inputMode="numeric"
            />
            <TextInput
              label="مسئول تحویل (اختیاری)"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="مثلاً: سارا محمدی — منابع انسانی"
            />
            <TextArea
              label="یادداشت (اختیاری)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="مثلاً: دورکار دو روز در هفته؛ لپ‌تاپ از انبار شعبهٔ مرکزی."
            />
          </>
        )}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------- plan -- */

function PlanDrawer({
  plan,
  canEdit,
  mailbox,
  onClose,
  onChange,
  onRemove,
}: {
  plan: OnboardingPlan | null;
  canEdit: boolean;
  mailbox: boolean;
  onClose: () => void;
  onChange: (plan: OnboardingPlan) => void;
  onRemove: (plan: OnboardingPlan) => void;
}) {
  const [busyTask, setBusyTask] = useState<string | null>(null);
  const [newTask, setNewTask] = useState('');
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [welcomeText, setWelcomeText] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    setNewTask('');
    setWelcomeText(null);
  }, [plan?.id]);

  if (!plan) return null;
  const percent = plan.total ? Math.round((plan.doneCount / plan.total) * 100) : 0;

  const call = async (taskId: string) => {
    setBusyTask(taskId);
    try {
      const r = await api.onboarding.toggleTask(plan.id, taskId);
      onChange(r.plan);
    } catch (err: any) {
      toast(err?.message || 'تغییر وضعیت ممکن نشد.', 'error');
    } finally {
      setBusyTask(null);
    }
  };

  const addTask = async () => {
    const label = newTask.trim();
    if (label.length < 3) {
      toast('متن مورد را بنویسید.', 'error');
      return;
    }
    setAdding(true);
    try {
      const r = await api.onboarding.addTask(plan.id, label);
      onChange(r.plan);
      setNewTask('');
    } catch (err: any) {
      toast(err?.message || 'افزودن ممکن نشد.', 'error');
    } finally {
      setAdding(false);
    }
  };

  const welcome = async () => {
    setSending(true);
    try {
      const r = await api.onboarding.welcome(plan.id);
      onChange(r.plan);
      toast('پیام خوش‌آمد از صندوق سازمان فرستاده شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ارسال ممکن نشد.', 'error');
    } finally {
      setSending(false);
    }
  };

  const textForCopy = () =>
    [
      `${plan.candidateName} عزیز،`,
      '',
      `روز اول شما ${plan.startDateJalali} است${plan.jobTitle ? ` و نقش شما «${plan.jobTitle}»` : ''}.`,
      plan.ownerName ? `هماهنگی‌های روز اول با ${plan.ownerName} است.` : '',
      '',
      'تا آن روز این‌ها آماده می‌شود:',
      ...plan.tasks.filter((t) => !t.done).slice(0, 6).map((t) => `• ${t.label}`),
    ]
      .filter(Boolean)
      .join('\n');

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={plan.candidateName}
      description={`${plan.jobTitle || 'بدون فرصت شغلی'}${plan.departmentName ? ` · ${plan.departmentName}` : ''} · شروع ${plan.startDateJalali}`}
      icon={<ClipboardList className="w-4 h-4" />}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {canEdit && plan.status !== 'cancelled' && (
              <Button variant="ghost" size="sm" onClick={() => setConfirmCancel(true)}>
                لغو برنامه
              </Button>
            )}
            {canEdit && (
              <IconButton icon={Trash2} label="پاک‌کردن برنامه" onClick={() => onRemove(plan)} />
            )}
          </div>
          <div className="flex items-center gap-2">
            {plan.candidateEmail ? (
              <Button
                variant="secondary"
                icon={Mail}
                onClick={welcome}
                loading={sending}
                disabled={!mailbox || plan.status === 'cancelled' || Boolean(plan.welcomeSentAtISO)}
                title={mailbox ? undefined : 'صندوق ایمیل سازمان وصل نیست'}
              >
                {plan.welcomeSentAtISO ? 'پیام فرستاده شد' : 'ارسال پیام خوش‌آمد'}
              </Button>
            ) : (
              <span className="text-[11.5px] text-ink-3">برای این کارجو ایمیل ثبت نشده است</span>
            )}
            <Button onClick={onClose}>بستن</Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <Chip tone={STATUS_TONE[plan.status]}>{ONBOARDING_STATUS_LABEL[plan.status]}</Chip>
          <span className="text-[12px] text-ink-3">{startHint(plan.daysUntil)}</span>
          {plan.ownerName && <span className="text-[12px] text-ink-3">· مسئول: {plan.ownerName}</span>}
        </div>

        <div>
          <div className="flex items-center justify-between text-[12px] text-ink-3 mb-1.5">
            <span>پیشرفت چک‌لیست</span>
            <span className="tabular-nums">
              {toPersianDigits(plan.doneCount)} از {toPersianDigits(plan.total)} — {toPersianDigits(percent)}٪
            </span>
          </div>
          <div className="h-2 rounded-full bg-line-2 overflow-hidden">
            <div className="h-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>

        {!mailbox && plan.candidateEmail && !plan.welcomeSentAtISO && (
          <Callout tone="warning" icon={Mail} title="صندوق ایمیل سازمان وصل نیست">
            پیام از طرف شما فرستاده نمی‌شود و متن آماده در پایین است؛ آن را کپی کنید و از ایمیل خودتان بفرستید.
          </Callout>
        )}

        {plan.note && (
          <div className="rounded-[12px] border border-line-2 bg-canvas px-3.5 py-3 text-[12.5px] text-ink-2 whitespace-pre-wrap">
            {plan.note}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {plan.tasks.map((task) => (
            <label
              key={task.id}
              className={`flex items-start gap-3 rounded-[10px] border px-3 py-2.5 cursor-pointer transition-colors ${
                task.done ? 'border-brand/30 bg-brand-tint/40' : 'border-line-2 hover:bg-canvas'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 w-4 h-4 accent-[var(--brand)]"
                checked={task.done}
                disabled={busyTask === task.id || plan.status === 'cancelled'}
                onChange={() => void call(task.id)}
              />
              <span className="min-w-0 flex-1">
                <span className={`block text-[12.5px] ${task.done ? 'text-ink-2 line-through decoration-line' : 'text-ink'}`}>
                  {task.label}
                </span>
                {task.done && task.doneAtISO && (
                  <span className="block text-[11px] text-ink-4 mt-0.5">
                    {faDate(task.doneAtISO)}
                    {task.doneByName ? ` · ${task.doneByName}` : ''}
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        {canEdit && plan.status !== 'cancelled' && (
          <div className="flex items-start gap-2">
            <TextInput
              value={newTask}
              onChange={(e) => setNewTask(e.target.value)}
              placeholder="یک مورد دیگر برای همین استخدام…"
              wrapperClassName="flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addTask();
              }}
            />
            <Button variant="secondary" onClick={addTask} loading={adding} icon={Plus}>
              افزودن
            </Button>
          </div>
        )}

        {welcomeText !== null && (
          <div className="rounded-[12px] border border-line-2 bg-canvas p-3">
            <p className="text-[11.5px] text-ink-3 mb-2">متن آماده — کپی و از ایمیل خودتان بفرستید:</p>
            <pre className="text-[12px] text-ink-2 whitespace-pre-wrap font-[inherit] leading-6">{welcomeText}</pre>
            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(welcomeText)
                    .then(() => toast('متن کپی شد.', 'success'))
                    .catch(() => toast('کپی ممکن نشد.', 'error'));
                }}
              >
                کپی متن
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWelcomeText(null)}>
                بستن
              </Button>
            </div>
          </div>
        )}

        {!welcomeText && (!mailbox || !plan.candidateEmail) && plan.status !== 'cancelled' && (
          <Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setWelcomeText(textForCopy())} className="self-start">
            نمایش متن آمادهٔ پیام خوش‌آمد
          </Button>
        )}

        <p className="text-[11px] text-ink-4">
          این برنامه در گزارش هزینهٔ استخدام هزینه‌ای ثبت نمی‌کند؛ فقط برای آن یک ردیف در خروجی اکسل دارد.
        </p>
      </div>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          try {
            const r = await api.onboarding.cancel(plan.id);
            onChange(r.plan);
            toast('برنامه لغو شد.', 'success');
          } catch (err: any) {
            toast(err?.message || 'لغو ممکن نشد.', 'error');
          }
        }}
        title="برنامهٔ تحویل لغو شود؟"
        description="سابقه می‌ماند ولی چیزی دیگر روی آن انجام نمی‌شود — برای وقتی که استخدام منتفی شده است."
        confirmLabel="لغو برنامه"
      />
    </Modal>
  );
}

/**
 * One «نیازمندسنجی» — where the decision is taken.
 *
 * The layout is the argument: the **reason** and the **money** come before the
 * buttons, the **seats asked for** stay visible after approval, and the **history**
 * is on the page rather than in someone's memory. An approver may grant fewer
 * seats than requested — that is the control — and the field says so.
 */
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Wallet,
  FileCheck2,
  Link2,
  PauseCircle,
  PlayCircle,
  Plus,
  Send,
  Trash2,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, Chip, Modal, Select, Skeleton, TextArea, TextInput, toast } from '../components/ui';
import RequisitionForm from '../components/requisitions/RequisitionForm';
import { api, ApiError } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { toPersianDigits } from '../lib/format';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import {
  PRIORITY_LABEL,
  REQUISITION_STATUS_LABEL,
  SALARY_BASIS_LABEL,
  SENIORITY_LABEL,
  WORK_MODE_LABEL,
  type Requisition,
  type RequisitionInput,
} from '../types/requisition';

const money = (n: number | null | undefined) => (n == null ? '—' : `${toPersianDigits(n.toLocaleString('en-US'))} تومان`);

const ACTION_LABEL: Record<string, string> = {
  created: 'ساخته شد',
  edited: 'ویرایش شد',
  submitted: 'برای تأیید فرستاده شد',
  approved: 'تأیید شد',
  rejected: 'رد شد',
  held: 'متوقف شد',
  resumed: 'از سر گرفته شد',
  cancelled: 'لغو شد',
  job_attached: 'آگهی وصل شد',
  job_detached: 'آگهی جدا شد',
};

export default function RequisitionDetail({ id }: { id: string }) {
  const { org } = useAuth();
  const canAdmin = useCan('admin');
  const q = useAsync(() => api.requisitions.get(id), [id]);
  const settingsQ = useAsync(() => (canAdmin ? api.requisitions.settings.get() : Promise.resolve(null)), [canAdmin]);
  const [busy, setBusy] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'rejected' | null>(null);
  const [slotsGranted, setSlotsGranted] = useState('');
  const [note, setNote] = useState('');
  const [jobToAttach, setJobToAttach] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);

  const row: Requisition | null = q.data?.requisition || null;
  useTitle(row ? `نیازمندسنجی ${row.code}` : 'نیازمندسنجی');

  useEffect(() => {
    if (row && decision === 'approved' && !slotsGranted) setSlotsGranted(String(row.slots));
  }, [row, decision, slotsGranted]);

  const run = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      q.reload();
      toast(message);
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'انجام این کار ممکن نشد.', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (q.error) {
    return (
      <div className="max-w-[980px]">
        <Callout tone="warning" title="این درخواست باز نشد">
          {q.error}
        </Callout>
        <Button variant="secondary" className="mt-3" onClick={() => navigate('/app/requisitions')}>
          بازگشت به فهرست
        </Button>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="max-w-[980px] flex flex-col gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const granted = row.approvedSlots ?? row.slots;
  const editable = row.status === 'draft' || row.status === 'rejected';
  const members = (settingsQ.data?.approvers || []).map((u) => ({ id: u.id, name: u.name }));
  const departments = (org?.departments || []).map((d) => ({ id: d.id, name: d.name }));

  return (
    <div className="max-w-[980px]">
      <PageHeader
        breadcrumb={[
          { label: 'فرصت‌های شغلی', to: '/app/jobs' },
          { label: 'نیازمندسنجی', to: '/app/requisitions' },
          { label: row.code },
        ]}
        title={row.title}
        subtitle={`${row.code} · ${row.departmentName}${row.hiringManagerName ? ` · مسئول استخدام: ${row.hiringManagerName}` : ''}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {editable && (
              <>
                <Button variant="secondary" onClick={() => setEditOpen(true)}>
                  ویرایش
                </Button>
                <Button
                  icon={Send}
                  loading={busy === 'submit'}
                  onClick={() => void run('submit', () => api.requisitions.submit(row.id), 'درخواست برای تأیید فرستاده شد.')}
                >
                  فرستادن برای تأیید
                </Button>
              </>
            )}
            {row.status === 'approved' && (
              <Button variant="secondary" icon={PauseCircle} loading={busy === 'hold'} onClick={() => void run('hold', () => api.requisitions.hold(row.id), 'درخواست متوقف شد.')}>
                توقف استخدام
              </Button>
            )}
            {row.status === 'on_hold' && (
              <Button variant="secondary" icon={PlayCircle} loading={busy === 'resume'} onClick={() => void run('resume', () => api.requisitions.resume(row.id), 'استخدام از سر گرفته شد.')}>
                از سر گرفتن
              </Button>
            )}
            {row.status !== 'cancelled' && (
              <Button variant="ghost" className="text-low-ink" icon={Trash2} onClick={() => setCancelOpen(true)}>
                لغو درخواست
              </Button>
            )}
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <Chip tone={row.status === 'approved' ? 'brand' : row.status === 'pending' ? 'warning' : row.status === 'rejected' ? 'neutral' : 'outline'}>
          {REQUISITION_STATUS_LABEL[row.status]}
        </Chip>
        <Chip tone="outline">{PRIORITY_LABEL[row.priority]}</Chip>
        <Chip tone="outline">{SENIORITY_LABEL[row.seniority]}</Chip>
        <Chip tone="outline">{WORK_MODE_LABEL[row.workMode]}</Chip>
        <Chip tone="outline">{row.employmentType}</Chip>
        {row.location && <Chip tone="outline">{row.location}</Chip>}
      </div>

      {row.status === 'pending' && (
        <Card className="mb-4">
          <CardHeader title="این درخواست منتظر تأیید است" subtitle={q.data?.cannotApproveReason || 'تأییدکننده می‌تواند تعداد کمتری پست تأیید کند.'} icon={FileCheck2} />
          {q.data?.canApprove ? (
            <div className="flex flex-wrap gap-2">
              <Button icon={CheckCircle2} onClick={() => { setDecision('approved'); setSlotsGranted(String(row.slots)); setNote(''); }}>
                تأیید
              </Button>
              <Button variant="secondary" icon={XCircle} onClick={() => { setDecision('rejected'); setNote(''); }}>
                رد
              </Button>
            </div>
          ) : (
            <p className="text-[12px] text-ink-3 leading-relaxed">
              {row.requestedByName} این درخواست را فرستاده است؛ تأیید با شخص دیگری است
              {settingsQ.data?.settings.approverUserIds.length ? ' (تأییدکنندگان تعیین‌شده یا مدیر فضای کاری).' : ' (مدیر یا مالک فضای کاری).'}
            </p>
          )}
        </Card>
      )}

      {row.status === 'rejected' && row.decisionNote && (
        <Callout tone="warning" title={`رد شد — ${row.decidedByName || ''}`}>
          {row.decisionNote} — می‌توانید درخواست را اصلاح کنید و دوباره بفرستید.
        </Callout>
      )}

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <Card>
            <CardHeader title="دلیل این نیرو" subtitle="همان چیزی که تأییدکننده خوانده است" icon={FileCheck2} />
            <p className="text-[13px] text-ink-2 leading-relaxed whitespace-pre-wrap">{row.justification || '— (برای فرستادن به تأیید لازم است)'}</p>
          </Card>

          <Card>
            <CardHeader title="سرفصل" subtitle="پست‌ها از پذیرش پیشنهاد شغلی شمرده می‌شوند، نه از تایپ دستی" icon={CheckCircle2} />
            <div className="flex items-end gap-4">
              <div>
                <p className="text-[11.5px] text-ink-3">تأییدشده</p>
                <p className="text-[20px] font-extrabold text-ink hv-num">{toPersianDigits(granted)}</p>
                {row.approvedSlots !== null && row.approvedSlots !== row.slots && (
                  <p className="text-[11px] text-ink-4 hv-num">{toPersianDigits(row.slots)} خواسته شده بود</p>
                )}
              </div>
              <div>
                <p className="text-[11.5px] text-ink-3">پرشده</p>
                <p className="text-[20px] font-extrabold text-brand-stronger hv-num">{toPersianDigits(row.filled)}</p>
              </div>
              <div>
                <p className="text-[11.5px] text-ink-3">باقی‌مانده</p>
                <p className="text-[20px] font-extrabold text-ink hv-num">{toPersianDigits(row.remaining)}</p>
              </div>
            </div>
            <div className="h-2 rounded-full bg-line-2 mt-3 overflow-hidden">
              <div className="h-full bg-brand" style={{ width: `${Math.min(100, granted ? Math.round((row.filled / granted) * 100) : 0)}%` }} />
            </div>
            {row.complete && <p className="text-[11.5px] text-ink-3 mt-2">همهٔ پست‌ها پر شده‌اند؛ برای استخدام بیشتر، درخواست تازه بسازید.</p>}
          </Card>

          <Card>
            <CardHeader
              title="آگهی‌های این نیازمندسنجی"
              subtitle="آگهی فقط با درخواست تأییدشده و پست باقی‌مانده وصل می‌شود"
              icon={Link2}
            />
            {row.jobIds.length === 0 && <p className="text-[12px] text-ink-3">هنوز آگهی‌ای وصل نشده است.</p>}
            <div className="flex flex-col gap-2">
              {row.jobIds.map((jobId, i) => (
                <div key={jobId} className="flex items-center justify-between gap-2 rounded-control border border-line-2 bg-canvas px-3 py-2">
                  <button className="text-[12.5px] text-ink font-medium hover:underline" onClick={() => navigate(`/app/jobs/${jobId}`)}>
                    {row.jobTitles[i]}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-low-ink"
                    loading={busy === `detach-${jobId}`}
                    onClick={() => void run(`detach-${jobId}`, () => api.requisitions.detach(row.id, jobId), 'آگهی جدا شد.')}
                  >
                    جدا کردن
                  </Button>
                </div>
              ))}
            </div>
            {row.status === 'approved' && (q.data?.attachableJobs.length || 0) > 0 && (
              <div className="flex flex-wrap items-end gap-2 mt-3">
                <Select
                  className="min-w-[220px]"
                  value={jobToAttach}
                  onChange={(e) => setJobToAttach(e.target.value)}
                  placeholder="انتخاب آگهی"
                  options={(q.data?.attachableJobs || []).map((j) => ({ value: j.id, label: `${j.roleTitle}${j.isPublic ? ' (منتشرشده)' : ''}` }))}
                />
                <Button
                  icon={Plus}
                  disabled={!jobToAttach}
                  loading={busy === 'attach'}
                  onClick={() => void run('attach', () => api.requisitions.attach(row.id, jobToAttach), 'آگهی به نیازمندسنجی وصل شد.').then((ok) => ok && setJobToAttach(''))}
                >
                  وصل کردن
                </Button>
              </div>
            )}
            {row.status === 'approved' && (q.data?.attachableJobs.length || 0) === 0 && (
              <p className="text-[11.5px] text-ink-4 mt-2">آگهی بی‌نیازمندسنجیِ دیگری در این دپارتمان نیست؛ اول یک فرصت شغلی بسازید.</p>
            )}
          </Card>

          <Card>
            <CardHeader title="تاریخچه" subtitle="هر تغییر با نام و زمان" icon={FileCheck2} />
            <ol className="flex flex-col gap-2.5">
              {row.history.map((h, i) => (
                <li key={`${h.atISO}-${i}`} className="flex gap-3">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-line-strong shrink-0" />
                  <div>
                    <p className="text-[12px] text-ink">
                      <span className="font-semibold">{ACTION_LABEL[h.action] || h.action}</span> — {h.byName}
                      <span className="text-ink-4"> · {h.atJalali}</span>
                    </p>
                    {h.note && <p className="text-[11.5px] text-ink-3 mt-0.5 leading-relaxed">{h.note}</p>}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader title="پول" subtitle={SALARY_BASIS_LABEL[row.salaryBasis]} icon={Wallet} />
            <dl className="text-[12px] flex flex-col gap-1.5">
              <Row2 label="کف" value={money(row.salaryMin)} />
              <Row2 label="سقف" value={money(row.salaryMax)} />
              <Row2 label="هزینهٔ ماهانهٔ پست‌های تأییدشده" value={money(row.monthlyCost)} strong />
              <Row2 label="شروع هدف" value={row.targetStartJalali || '—'} />
            </dl>
            <p className="text-[11px] text-ink-4 mt-2 leading-relaxed">
              برآورد با نقطهٔ میانی بازه و تعداد پست تأییدشده؛ نه تعهد بودجه.
            </p>
          </Card>

          <Card>
            <CardHeader title="تصمیم" icon={CheckCircle2} />
            {row.decidedAtISO ? (
              <div className="text-[12px] text-ink-2 flex flex-col gap-1">
                <p>
                  <span className="font-semibold">{row.status === 'rejected' ? 'رد شد' : 'تأیید شد'}</span> — {row.decidedByName} · {row.decidedAtJalali}
                </p>
                {row.decisionNote && <p className="text-ink-3 leading-relaxed">{row.decisionNote}</p>}
              </div>
            ) : (
              <p className="text-[12px] text-ink-3 leading-relaxed">
                {row.status === 'draft' ? 'هنوز برای تأیید فرستاده نشده است.' : row.status === 'cancelled' ? 'این درخواست لغو شده است.' : 'در انتظار تصمیم.'}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="درخواست‌دهنده" icon={ArrowRight} />
            <p className="text-[12px] text-ink-2">{row.requestedByName}</p>
            <p className="text-[11px] text-ink-4">ساخته‌شده {row.createdAtJalali}</p>
          </Card>
        </div>
      </div>

      {editable && (
        <RequisitionForm
          open={editOpen}
          onClose={() => setEditOpen(false)}
          departments={departments}
          members={members}
          initial={row}
          onSubmit={async (input: RequisitionInput) => {
            await run('edit', () => api.requisitions.update(row.id, input), 'تغییرات ذخیره شد.');
          }}
        />
      )}

      <Modal
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={decision === 'approved' ? 'تأیید نیازمندسنجی' : 'رد نیازمندسنجی'}
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDecision(null)}>
              انصراف
            </Button>
            <Button
              variant={decision === 'approved' ? 'primary' : 'danger'}
              loading={busy === 'decide'}
              onClick={async () => {
                if (!decision) return;
                const ok = await run(
                  'decide',
                  () =>
                    api.requisitions.decide(row.id, {
                      decision,
                      note: note.trim(),
                      ...(decision === 'approved' ? { approvedSlots: Number(slotsGranted) || row.slots } : {}),
                    }),
                  decision === 'approved' ? 'درخواست تأیید شد.' : 'درخواست رد شد.'
                );
                if (ok) setDecision(null);
              }}
            >
              {decision === 'approved' ? 'تأیید می‌کنم' : 'رد می‌کنم'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          {decision === 'approved' ? (
            <>
              <p className="text-[12.5px] text-ink-2 leading-relaxed">
                می‌توانید همهٔ {toPersianDigits(row.slots)} پست را تأیید کنید یا کمتر — مثلاً وقتی بودجه فقط دو نفر را می‌کشد. عدد درخواستی روی صفحه می‌ماند و در تاریخچه ثبت می‌شود.
              </p>
              <label className="text-[12px] font-semibold text-ink-2" htmlFor="granted-slots">
                تعداد پست تأییدشده (۱ تا {toPersianDigits(row.slots)})
              </label>
              <TextInput
                id="granted-slots"
                value={slotsGranted}
                onChange={(e) => setSlotsGranted(e.target.value.replace(/[^\d]/g, ''))}
                dir="ltr"
                inputMode="numeric"
              />
            </>
          ) : (
            <p className="text-[12.5px] text-ink-2 leading-relaxed">
              دلیل رد را بنویسید؛ همان متن به درخواست‌دهنده نشان داده می‌شود تا بداند چه چیزی را اصلاح کند.
            </p>
          )}
          <label className="text-[12px] font-semibold text-ink-2" htmlFor="decision-note">
            یادداشت {decision === 'rejected' ? '(الزامی)' : '(اختیاری)'}
          </label>
          <TextArea id="decision-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={800} />
        </div>
      </Modal>

      <Modal
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="لغو نیازمندسنجی"
        size="md"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCancelOpen(false)}>
              انصراف
            </Button>
            <Button
              variant="danger"
              loading={busy === 'cancel'}
              onClick={async () => {
                const ok = await run('cancel', () => api.requisitions.cancel(row.id, note.trim()), 'درخواست لغو شد.').catch(() => false);
                if (ok) {
                  setCancelOpen(false);
                  setNote('');
                }
              }}
            >
              لغو می‌کنم
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2 text-[12.5px] text-ink-2 leading-relaxed">
            <AlertTriangle className="w-4 h-4 mt-0.5 text-review-ink shrink-0" />
            <p>
              لغو، سابقه را پاک نمی‌کند؛ درخواست با وضعیت «لغو‌شده» می‌ماند. اگر پستی پر شده باشد، لغو ممکن نیست — از «توقف» استفاده کنید.
            </p>
          </div>
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={500} placeholder="دلیل لغو (اختیاری)" />
        </div>
      </Modal>
    </div>
  );
}

function Row2({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-ink-3">{label}</dt>
      <dd className={`hv-num ${strong ? 'font-bold text-ink' : 'text-ink-2'}`}>{value}</dd>
    </div>
  );
}


/**
 * «نیازمندسنجی» — the list, the headcount rollup, and the workspace rule.
 *
 * The header answers the question a department head actually asks («how many
 * seats do we have left, and how many are waiting for a signature?»), and the
 * list shows every request with the seats it got, the seats it used, and what it
 * costs per month. Nothing here hires anyone; it decides whether hiring is allowed.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Clock3, FileCheck2, Plus, Save, Trash2, Users, Wallet, Workflow } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, Chip, EmptyState, Select, Skeleton, Stat, Switch, TextInput, toast } from '../components/ui';
import RequisitionForm from '../components/requisitions/RequisitionForm';
import { api, ApiError } from '../lib/api';
import { useAuth, useCan } from '../lib/auth';
import { toPersianDigits } from '../lib/format';
import { navigate } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import {
  CHAIN_MAX_STEPS,
  PRIORITY_LABEL,
  REQUISITION_STATUS_LABEL,
  type RequisitionChainStepConfig,
  type RequisitionInput,
  type RequisitionStatus,
  type RequisitionSummaryRow,
} from '../types/requisition';

const TONE: Record<RequisitionStatus, 'brand' | 'warning' | 'neutral' | 'outline'> = {
  draft: 'outline',
  pending: 'warning',
  approved: 'brand',
  rejected: 'neutral',
  on_hold: 'neutral',
  filled: 'brand',
  cancelled: 'neutral',
};

const money = (n: number | null | undefined) => (n == null ? '—' : `${toPersianDigits(n.toLocaleString('en-US'))} تومان`);

/** A chain row being edited; `key` exists only so React can keep the inputs apart. */
interface ChainRow extends RequisitionChainStepConfig {
  key: string;
}

let chainSeq = 0;
const chainRowOf = (step?: Partial<RequisitionChainStepConfig>): ChainRow => ({
  key: `chain-row-${++chainSeq}`,
  id: step?.id || '',
  label: step?.label || '',
  approverId: step?.approverId || '',
});

export default function Requisitions() {
  const { org } = useAuth();
  const canAdmin = useCan('admin');
  const listQ = useAsync(() => api.requisitions.list(), []);
  const summaryQ = useAsync(() => api.requisitions.summary(), []);
  const settingsQ = useAsync(() => (canAdmin ? api.requisitions.settings.get() : Promise.resolve(null)), [canAdmin]);
  const [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | RequisitionStatus>('all');
  const [savingRule, setSavingRule] = useState(false);
  const [chainRows, setChainRows] = useState<ChainRow[]>([]);
  const [chainLoaded, setChainLoaded] = useState(false);
  const [savingChain, setSavingChain] = useState(false);

  // The saved chain is the starting point of the editor — filled once, then the
  // rows on screen are what the admin is editing.
  useEffect(() => {
    if (chainLoaded || !settingsQ.data) return;
    setChainRows((settingsQ.data.settings.chain || []).map((step) => chainRowOf(step)));
    setChainLoaded(true);
  }, [settingsQ.data, chainLoaded]);

  useTitle('نیازمندسنجی');

  const items = listQ.data?.items || [];
  const rollup = summaryQ.data?.rollup;
  const filtered = useMemo(() => (filter === 'all' ? items : items.filter((i) => i.status === filter)), [items, filter]);

  const refresh = () => {
    listQ.reload();
    summaryQ.reload();
  };

  const create = async (input: RequisitionInput) => {
    try {
      const r = await api.requisitions.create(input);
      toast(`پیش‌نویس ${r.requisition.code} ساخته شد؛ حالا آن را برای تأیید بفرستید.`);
      refresh();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ساخت نیازمندسنجی ممکن نشد.', 'error');
      throw err;
    }
  };

  const toggleGate = async (value: boolean) => {
    setSavingRule(true);
    try {
      await api.requisitions.settings.save({ requireApprovedForPublish: value });
      settingsQ.reload();
      summaryQ.reload();
      toast(value ? 'از این پس انتشار آگهی بدون نیازمندسنجی تأییدشده ممکن نیست.' : 'قید انتشار خاموش شد.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ذخیرهٔ قاعده ممکن نشد.', 'error');
    } finally {
      setSavingRule(false);
    }
  };

  const patchChain = (key: string, next: Partial<ChainRow>) =>
    setChainRows((list) => list.map((r) => (r.key === key ? { ...r, ...next } : r)));

  const saveChain = async () => {
    setSavingChain(true);
    try {
      const chain = chainRows
        .filter((r) => r.approverId)
        .slice(0, CHAIN_MAX_STEPS)
        .map((r) => ({ id: r.id || '', label: r.label.trim(), approverId: r.approverId }));
      const res = await api.requisitions.settings.save({ chain });
      // The server drops duplicates and unknown members and fills empty labels:
      // show what it actually saved, not what was typed.
      setChainRows((res.settings.chain || []).map((step) => chainRowOf(step)));
      settingsQ.reload();
      summaryQ.reload();
      toast(
        chain.length
          ? `زنجیرهٔ تأیید ذخیره شد (${toPersianDigits(res.settings.chain.length)} مرحله)؛ از این پس درخواست‌های تازه همین مسیر را می‌روند.`
          : 'زنجیره خالی شد؛ تأیید همچنان یک‌مرحله‌ای است.'
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ذخیرهٔ زنجیره ممکن نشد.', 'error');
    } finally {
      setSavingChain(false);
    }
  };

  const gateOn = settingsQ.data?.settings.requireApprovedForPublish ?? summaryQ.data?.settings.requireApprovedForPublish ?? false;
  const departments = (org?.departments || []).map((d) => ({ id: d.id, name: d.name }));
  const members = (settingsQ.data?.approvers || []).map((u) => ({ id: u.id, name: u.name }));

  return (
    <div className="max-w-[1080px]">
      <PageHeader
        breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }, { label: 'نیازمندسنجی' }]}
        title="نیازمندسنجی و سرفصل نیرو"
        subtitle="هر استخدام از یک درخواست تأییدشده با تعداد پست و بازهٔ حقوق شروع می‌شود"
        actions={
          <Button icon={Plus} onClick={() => setFormOpen(true)}>
            نیازمندسنجی تازه
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <Stat icon={Users} label="پست تأییدشده" value={toPersianDigits(rollup?.approvedSeats ?? 0)} note={`${toPersianDigits(rollup?.filledSeats ?? 0)} پرشده`} tone="brand" />
        <Stat icon={CircleDashed} label="پست باقی‌مانده" value={toPersianDigits(rollup?.remainingSeats ?? 0)} note="قابل استفاده برای آگهی تازه" />
        <Stat icon={Clock3} label="در انتظار تأیید" value={toPersianDigits(rollup?.pendingApproval ?? 0)} note="تا تأیید نشود، آگهی به آن وصل نمی‌شود" tone={rollup?.pendingApproval ? 'review' : 'neutral'} />
        <Stat icon={Wallet} label="هزینهٔ ماهانهٔ پست‌های خالی" value={money(rollup?.monthlyOpenCost)} note="با نقطهٔ میانی بازهٔ حقوق" />
      </div>

      {canAdmin && (
        <Card className="mb-4">
          <CardHeader
            title="قاعدهٔ این فضای کاری"
            subtitle="پیش‌فرض خاموش است؛ روشن‌کردنش یعنی هیچ آگهی بی‌سرفصل روی پورتال نمی‌رود"
            icon={FileCheck2}
            action={
              <div className="flex items-center gap-2">
                <span className="text-[11.5px] text-ink-3">{gateOn ? 'روشن' : 'خاموش'}</span>
                <Switch checked={gateOn} onChange={(v) => void toggleGate(v)} disabled={savingRule} label="انتشار فقط با نیازمندسنجی تأییدشده" />
              </div>
            }
          />
          <p className="text-[12px] text-ink-3 leading-relaxed">
            {gateOn
              ? 'از این پس انتشار آگهی روی پورتال شغلی فقط وقتی ممکن است که آگهی به یک نیازمندسنجی «تأییدشده» با پست باقی‌مانده وصل باشد. آگهی‌های فعلی که از قبل منتشر شده‌اند دست‌نخورده می‌مانند؛ قاعده فقط جلوی انتشار تازه را می‌گیرد.'
              : 'در حالت خاموش، هر عضو می‌تواند آگهی را منتشر کند. نیازمندسنجی همچنان سرفصل و تأیید را نگه می‌دارد، فقط انتشار را قفل نمی‌کند.'}
          </p>
        </Card>
      )}

      {canAdmin && (
        <Card className="mb-4">
          <CardHeader
            title="زنجیرهٔ تأیید"
            subtitle="هر مرحله را به یک نفر بدهید تا درخواست به ترتیب امضا شود؛ بی‌زنجیره، یک تأیید کافی است"
            icon={Workflow}
            action={
              <Chip tone={chainRows.filter((r) => r.approverId).length ? 'brand' : 'neutral'}>
                {chainRows.filter((r) => r.approverId).length
                  ? `${toPersianDigits(chainRows.filter((r) => r.approverId).length)} مرحله`
                  : 'یک‌مرحله‌ای'}
              </Chip>
            }
          />

          {chainRows.filter((r) => r.approverId).length === 0 && (
            <p className="text-[12px] text-ink-3 leading-relaxed mb-3">
              امروز یک تأیید، درخواست را نهایی می‌کند. اگر بودجه و نیرو باید جدا تأیید شوند، مراحل را اضافه کنید: ترتیب از بالا به پایین است و درخواست تا امضای
              آخرین مرحله «تأییدشده» نمی‌شود.
            </p>
          )}

          {chainRows.map((row, i) => (
            <div key={row.key} className="flex flex-col sm:flex-row sm:items-end gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-line-2 text-ink-3 flex items-center justify-center text-[11px] font-bold shrink-0 sm:mb-2.5 hv-num">
                {toPersianDigits(i + 1)}
              </span>
              <TextInput
                label={`برچسب مرحله (${toPersianDigits(i + 1)})`}
                value={row.label}
                onChange={(e) => patchChain(row.key, { label: e.target.value })}
                placeholder={i === 0 ? 'مدیر فنی' : i === 1 ? 'مالی' : 'مدیرعامل'}
                wrapperClassName="flex-1"
              />
              <Select
                label="تأییدکننده"
                value={row.approverId}
                onChange={(e) => patchChain(row.key, { approverId: e.target.value })}
                options={[{ value: '', label: 'انتخاب کنید…' }, ...(settingsQ.data?.approvers || []).map((m) => ({
                  value: m.id,
                  label: `${m.name}${m.role === 'owner' ? ' (مالک)' : m.role === 'admin' ? ' (مدیر)' : ''}`,
                }))]}
                wrapperClassName="flex-1"
              />
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setChainRows((list) => list.filter((r) => r.key !== row.key))} aria-label="حذف مرحله">
                حذف
              </Button>
            </div>
          ))}

          <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
            <Button
              size="sm"
              variant="secondary"
              icon={Plus}
              onClick={() => setChainRows((list) => [...list, chainRowOf()])}
              disabled={chainRows.length >= CHAIN_MAX_STEPS}
            >
              افزودن مرحله
            </Button>
            <div className="flex items-center gap-2">
              {chainRows.length >= CHAIN_MAX_STEPS && (
                <span className="text-[11px] text-ink-4">بیشتر از {toPersianDigits(CHAIN_MAX_STEPS)} مرحله پشتیبانی نمی‌شود.</span>
              )}
              <Button size="sm" icon={Save} loading={savingChain} onClick={() => void saveChain()} disabled={!chainLoaded}>
                ذخیرهٔ زنجیره
              </Button>
            </div>
          </div>

          <p className="text-[11px] text-ink-4 mt-3 leading-relaxed">
            زنجیره روی درخواستی که همین حالا در گردش است اثر نمی‌گذارد؛ هر درخواست با زنجیرهٔ روزِ فرستادنش تأیید می‌شود. درخواست‌دهنده هیچ‌گاه تأییدکنندهٔ
            درخواست خودش نیست و اگر تأییدکنندهٔ یک مرحله در دسترس نباشد، مدیر می‌تواند به‌جای او امضا کند — و همین در تاریخچه ثبت می‌شود.
          </p>
        </Card>
      )}

      {rollup && rollup.byDepartment.length > 0 && (
        <Card className="mb-4" padded={false}>
          <div className="px-4 pt-4">
            <p className="text-[13px] font-bold text-ink mb-2">سرفصل به تفکیک دپارتمان</p>
          </div>
          <div className="overflow-x-auto px-4 pb-3">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-ink-3 text-right">
                  <th className="py-1.5 font-semibold">دپارتمان</th>
                  <th className="py-1.5 font-semibold">تأییدشده</th>
                  <th className="py-1.5 font-semibold">پرشده</th>
                  <th className="py-1.5 font-semibold">باقی‌مانده</th>
                  <th className="py-1.5 font-semibold">در انتظار تأیید</th>
                </tr>
              </thead>
              <tbody>
                {rollup.byDepartment.map((d) => (
                  <tr key={d.departmentId} className="border-t border-line-2">
                    <td className="py-1.5 text-ink font-medium">{d.departmentName}</td>
                    <td className="py-1.5 hv-num text-ink-2">{toPersianDigits(d.approved)}</td>
                    <td className="py-1.5 hv-num text-ink-2">{toPersianDigits(d.filled)}</td>
                    <td className="py-1.5 hv-num font-bold text-ink">{toPersianDigits(Math.max(0, d.approved - d.filled))}</td>
                    <td className="py-1.5 hv-num text-ink-3">{d.pending ? toPersianDigits(d.pending) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="flex flex-wrap gap-1.5 mb-3">
        {(['all', 'draft', 'pending', 'approved', 'on_hold', 'rejected', 'filled', 'cancelled'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-[11.5px] px-2.5 py-1 rounded-full border transition-colors ${
              filter === f ? 'border-brand bg-brand-tint text-brand-stronger font-bold' : 'border-line-2 text-ink-3 hover:border-line-strong'
            }`}
          >
            {f === 'all' ? 'همه' : REQUISITION_STATUS_LABEL[f]}
          </button>
        ))}
      </div>

      {listQ.error && <Callout tone="warning" title="بارگذاری ممکن نشد">{listQ.error}</Callout>}
      {!listQ.data && !listQ.error && <Skeleton className="h-48" />}

      {listQ.data && filtered.length === 0 && (
        <Card>
          <EmptyState
            icon={FileCheck2}
            title={items.length ? 'در این وضعیت چیزی نیست' : 'هنوز نیازمندسنجی‌ای نیست'}
            description={
              items.length
                ? 'فیلتر دیگری را امتحان کنید.'
                : 'با ساخت یک درخواست شروع کنید: عنوان، دپارتمان، تعداد پست و دلیل. بعد از تأیید، آگهی‌ها به آن وصل می‌شوند.'
            }
            action={!items.length ? <Button icon={Plus} onClick={() => setFormOpen(true)}>نیازمندسنجی تازه</Button> : undefined}
          />
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {filtered.map((row) => (
          <Row key={row.id} row={row} />
        ))}
      </div>

      <RequisitionForm open={formOpen} onClose={() => setFormOpen(false)} onSubmit={create} departments={departments} members={members} />
    </div>
  );
}

function Row({ row }: { row: RequisitionSummaryRow }) {
  const granted = row.approvedSlots ?? row.slots;
  const pct = granted ? Math.min(100, Math.round((row.filled / granted) * 100)) : 0;
  return (
    <Card padded={false} className="cursor-pointer hover:border-line-strong transition-colors">
      <div className="p-4" onClick={() => navigate(`/app/requisitions/${row.id}`)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/app/requisitions/${row.id}`)}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[14px] font-bold text-ink">{row.title}</p>
              <Chip tone={TONE[row.status]}>{REQUISITION_STATUS_LABEL[row.status]}</Chip>
              {row.priority === 'critical' || row.priority === 'high' ? <Chip tone="warning">{PRIORITY_LABEL[row.priority]}</Chip> : null}
            </div>
            <p className="text-[11.5px] text-ink-3 mt-0.5">
              <span className="hv-latin">{row.code}</span> · {row.departmentName} {row.hiringManagerName ? `· مسئول: ${row.hiringManagerName}` : ''} · درخواست: {row.requestedByName}
            </p>
          </div>
          <div className="text-left shrink-0">
            <p className="text-[12px] text-ink-2 hv-num">
              {toPersianDigits(row.filled)} از {toPersianDigits(granted)} پست
              {row.approvedSlots !== null && row.approvedSlots !== row.slots ? <span className="text-ink-4"> ({toPersianDigits(row.slots)} خواسته شده)</span> : null}
            </p>
            <p className="text-[11px] text-ink-4 hv-num">{row.monthlyCost == null ? 'بدون بازهٔ حقوق' : `${money(row.monthlyCost)} در ماه`}</p>
          </div>
        </div>

        <div className="h-1.5 rounded-full bg-line-2 mt-2.5 overflow-hidden">
          <div className={`h-full ${row.complete ? 'bg-brand' : 'bg-review'}`} style={{ width: `${Math.max(2, pct)}%` }} />
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-ink-4">
          <span className="inline-flex items-center gap-1">
            <FileCheck2 className="w-3.5 h-3.5" /> {toPersianDigits(row.jobIds.length)} آگهی وصل‌شده
          </span>
          {row.targetStartJalali && <span>شروع هدف: {row.targetStartJalali}</span>}
          {row.status === 'pending' &&
            (() => {
              const steps = row.approvals || [];
              const idx = steps.findIndex((st) => st.status === 'pending');
              if (idx >= 0) {
                return (
                  <span className="inline-flex items-center gap-1 text-review-ink">
                    <Workflow className="w-3.5 h-3.5" /> در انتظار «{steps[idx].label}» — مرحلهٔ {toPersianDigits(idx + 1)} از {toPersianDigits(steps.length)}
                  </span>
                );
              }
              return row.submittedAtISO ? (
                <span className="text-review-ink">در انتظار تأیید از {row.history.find((h) => h.action === 'submitted')?.atJalali || ''}</span>
              ) : null;
            })()}
          {row.status === 'rejected' && row.decisionNote && (
            <span className="inline-flex items-center gap-1 text-low-ink">
              <AlertTriangle className="w-3.5 h-3.5" /> {row.decisionNote.slice(0, 90)}
            </span>
          )}
          {row.status === 'approved' && <span className="inline-flex items-center gap-1 text-brand-stronger"><CheckCircle2 className="w-3.5 h-3.5" /> {toPersianDigits(row.remaining)} پست باقی‌مانده</span>}
        </div>
      </div>
    </Card>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Banknote, Calculator, Coins, Download, Info, Pencil, Plus, Receipt, Timer, Trash2, UserCheck } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  IconButton,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Stat,
  TextInput,
  toast,
} from '../components/ui';
import { ReportTabs } from '../components/reports/ReportTabs';
import { api } from '../lib/api';
import { exportSheets } from '../lib/exportSheets';
import { faDate, faNumber, faPercent, toPersianDigits } from '../lib/format';
import { setQuery, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useCan } from '../lib/auth';
import { useTitle } from '../lib/useTitle';
import { jalaliToGregorian, parseJalaliDateString } from '../utils/jalali';
import type { ReportRange } from '../types/app';
import type { CostAssumption, CostEntry, CostKind, CostReport as CostReportData } from '../types/reports';

const RANGES: { id: ReportRange; label: string }[] = [
  { id: '30', label: '۳۰ روز' },
  { id: '90', label: '۹۰ روز' },
  { id: '365', label: 'یک سال' },
  { id: 'all', label: 'همه' },
];

const KINDS: { id: CostKind; label: string }[] = [
  { id: 'advertising', label: 'آگهی و تبلیغ' },
  { id: 'agency', label: 'شرکت مشاور / ریکروتر' },
  { id: 'referral', label: 'پاداش معرفی' },
  { id: 'tools', label: 'ابزار و اشتراک' },
  { id: 'assessment', label: 'آزمون و ارزیابی' },
  { id: 'interview', label: 'روز مصاحبه' },
  { id: 'other', label: 'سایر' },
];

const KIND_LABEL: Record<CostKind, string> = Object.fromEntries(KINDS.map((k) => [k.id, k.label])) as Record<CostKind, string>;

/** «۱٫۲ میلیون تومان» reads better than a nine-digit number in a KPI card. */
function faMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n >= 1_000_000_000) return `${faNumber(n / 1_000_000_000, 1)} میلیارد`;
  if (n >= 10_000_000) return `${faNumber(n / 1_000_000, 1)} میلیون`;
  return faNumber(n);
}

/** Jalali text (۱۴۰۵/۰۸/۰۶) → ISO at 12:00 Tehran. Null when the date is unreadable. */
function isoFromJalaliInput(text: string): string | null {
  if (!text.trim()) return new Date().toISOString();
  const j = parseJalaliDateString(text);
  if (!j) return null;
  const g = jalaliToGregorian(j.year, j.month, j.day);
  return new Date(Date.UTC(g.year, g.month - 1, g.day, 8, 30)).toISOString();
}

function digitsOnly(text: string): number {
  const cleaned = text.replace(/[^\d۰-۹٠-٩]/g, '');
  const latin = cleaned.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return Number(latin || 0);
}

interface FormState {
  id: string | null;
  kind: CostKind;
  amount: string;
  date: string;
  jobId: string;
  note: string;
}

const emptyForm = (): FormState => ({ id: null, kind: 'advertising', amount: '', date: '', jobId: '', note: '' });

function CostForm({
  open,
  onClose,
  form,
  setForm,
  jobs,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  form: FormState;
  setForm: (f: FormState) => void;
  jobs: { id: string; roleTitle: string }[];
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A validation error belongs to the attempt that caused it, not to the next open.
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const save = async () => {
    setError(null);
    const amount = digitsOnly(form.amount);
    if (amount <= 0) return setError('مبلغ را به تومان وارد کنید.');
    const atISO = isoFromJalaliInput(form.date);
    if (atISO === null) return setError('تاریخ خوانده نشد؛ مثل ۱۴۰۵/۰۸/۰۶ بنویسید یا خالی بگذارید.');
    setBusy(true);
    try {
      const body = { kind: form.kind, amount, atISO, jobId: form.jobId || null, note: form.note };
      if (form.id) await api.insights.updateCost(form.id, body);
      else await api.insights.addCost(body);
      toast(form.id ? 'ردیف هزینه به‌روز شد.' : 'ردیف هزینه ثبت شد.');
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'ثبت هزینه ممکن نشد.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={form.id ? 'ویرایش ردیف هزینه' : 'ثبت هزینهٔ استخدام'}
      description="فقط هزینه‌ای را وارد کنید که واقعاً پرداخت شده است؛ این عدد به «هزینهٔ هر استخدام» می‌رود."
      icon={<Receipt className="w-5 h-5" />}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button onClick={save} loading={busy}>
            {form.id ? 'ذخیره' : 'ثبت'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="نوع هزینه"
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as CostKind })}
          options={KINDS.map((k) => ({ value: k.id, label: k.label }))}
        />
        <TextInput
          label="مبلغ (تومان)"
          inputMode="numeric"
          latin
          placeholder="۲٬۵۰۰٬۰۰۰"
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
          hint="عدد را به تومان بنویسید؛ جداکننده لازم نیست."
        />
        <TextInput
          label="تاریخ"
          optional
          placeholder="۱۴۰۵/۰۸/۰۶"
          value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })}
          hint="تاریخ شمسی پرداخت؛ خالی یعنی امروز."
        />
        <Select
          label="فرصت شغلی"
          hint="خالی بگذارید اگر هزینه به یک آگهی خاص مربوط نیست."
          value={form.jobId}
          onChange={(e) => setForm({ ...form, jobId: e.target.value })}
          placeholder="هزینهٔ عمومی"
          options={jobs.map((j) => ({ value: j.id, label: j.roleTitle }))}
        />
        <TextInput
          label="توضیح"
          optional
          wrapperClassName="sm:col-span-2"
          placeholder="مثلاً: آگهی جاب‌ویژن، ۳۰ روز"
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          maxLength={200}
        />
      </div>
      {error && (
        <p className="text-[12.5px] text-low-ink font-medium mt-3" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function AssumptionCard({ data, onSaved }: { data: CostReportData; onSaved: () => void }) {
  const [rate, setRate] = useState(String(data.assumption.hourlyRate || ''));
  const [minutes, setMinutes] = useState({
    scorecard: String(data.assumption.minutesPerScorecard),
    comment: String(data.assumption.minutesPerComment),
    decision: String(data.assumption.minutesPerDecision),
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.insights.setCostAssumption({
        hourlyRate: digitsOnly(rate),
        minutesPerScorecard: digitsOnly(minutes.scorecard),
        minutesPerComment: digitsOnly(minutes.comment),
        minutesPerDecision: digitsOnly(minutes.decision),
      });
      toast('نرخ زمان تیم ذخیره شد.');
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'ذخیره ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="هزینهٔ زمان تیم"
        subtitle={`${faNumber(data.hours.total, 1)} ساعت کار ثبت‌شده در این بازه`}
        action={<span className="text-[11.5px] text-ink-4">{data.assumption.hourlyRate > 0 ? `${faNumber(data.assumption.hourlyRate)} تومان در ساعت` : 'نرخ وارد نشده'}</span>}
      />
      <div className="grid grid-cols-2 gap-3">
        <TextInput label="نرخ ساعتی (تومان)" inputMode="numeric" latin placeholder="۰" value={rate} onChange={(e) => setRate(e.target.value)} />
        <div className="text-[11.5px] text-ink-3 leading-relaxed self-end pb-1.5">
          {data.assumption.hourlyRate > 0
            ? `هزینهٔ زمان: ${faNumber(data.totals.time)} تومان`
            : 'تا نرخ وارد نشود، هزینهٔ زمان در جمع نمی‌آید.'}
        </div>
        <TextInput
          label="دقیقه برای هر کارت ارزیابی"
          inputMode="numeric"
          latin
          value={minutes.scorecard}
          onChange={(e) => setMinutes({ ...minutes, scorecard: e.target.value })}
        />
        <TextInput
          label="دقیقه برای هر یادداشت"
          inputMode="numeric"
          latin
          value={minutes.comment}
          onChange={(e) => setMinutes({ ...minutes, comment: e.target.value })}
        />
        <TextInput
          label="دقیقه برای هر تصمیم"
          inputMode="numeric"
          latin
          value={minutes.decision}
          onChange={(e) => setMinutes({ ...minutes, decision: e.target.value })}
        />
        <div className="self-end pb-1.5 text-[11.5px] text-ink-3 leading-relaxed">
          زمان مصاحبه از مدت خودِ جلسه خوانده می‌شود، نه از این اعداد.
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button onClick={save} loading={busy} icon={Calculator}>
          ذخیرهٔ نرخ
        </Button>
        {data.assumption.hourlyRate > 0 && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api.insights.setCostAssumption({ hourlyRate: 0 });
                setRate('');
                toast('محاسبهٔ هزینهٔ زمان خاموش شد.');
                onSaved();
              } finally {
                setBusy(false);
              }
            }}
          >
            خاموش‌کردن هزینهٔ زمان
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-center">
        <div className="rounded-[10px] bg-canvas border border-line-2 px-2 py-2">
          <p className="text-[11px] text-ink-4">کارت ارزیابی</p>
          <p className="text-[14px] font-bold hv-num text-ink mt-0.5">{faNumber(data.hours.scorecards, 1)} ساعت</p>
        </div>
        <div className="rounded-[10px] bg-canvas border border-line-2 px-2 py-2">
          <p className="text-[11px] text-ink-4">یادداشت</p>
          <p className="text-[14px] font-bold hv-num text-ink mt-0.5">{faNumber(data.hours.comments, 1)} ساعت</p>
        </div>
        <div className="rounded-[10px] bg-canvas border border-line-2 px-2 py-2">
          <p className="text-[11px] text-ink-4">تصمیم</p>
          <p className="text-[14px] font-bold hv-num text-ink mt-0.5">{faNumber(data.hours.decisions, 1)} ساعت</p>
        </div>
        <div className="rounded-[10px] bg-canvas border border-line-2 px-2 py-2">
          <p className="text-[11px] text-ink-4">مصاحبه</p>
          <p className="text-[14px] font-bold hv-num text-ink mt-0.5">{faNumber(data.hours.interviews, 1)} ساعت</p>
        </div>
      </div>
    </Card>
  );
}

export default function CostReport() {
  useTitle('هزینهٔ هر استخدام');
  const isAdmin = useCan('admin');
  const { query } = useLocation();
  const rawRange = query.get('range');
  const range: ReportRange = RANGES.some((r) => r.id === rawRange) ? (rawRange as ReportRange) : '365';
  const { data, error, loading, reload } = useAsync(() => (isAdmin ? api.insights.costReport(range) : Promise.resolve(null)), [range, isAdmin]);
  const jobsList = useAsync(() => (isAdmin ? api.jobs.list() : Promise.resolve(null)), [isAdmin]);

  const [form, setForm] = useState<FormState>(emptyForm());
  const [formOpen, setFormOpen] = useState(false);
  const [toDelete, setToDelete] = useState<CostEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const jobs = useMemo(() => (jobsList.data?.items || []).map((j) => ({ id: j.id, roleTitle: j.roleTitle || j.departmentName })), [jobsList.data]);

  const openNew = () => {
    setForm(emptyForm());
    setFormOpen(true);
  };
  const openEdit = (entry: CostEntry) => {
    setForm({
      id: entry.id,
      kind: entry.kind,
      amount: String(entry.amount),
      date: entry.atJalali,
      jobId: entry.jobId || '',
      note: entry.note,
    });
    setFormOpen(true);
  };

  const remove = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      await api.insights.deleteCost(toDelete.id);
      toast('ردیف هزینه حذف شد.');
      setToDelete(null);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'حذف ممکن نشد.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const exportXlsx = async () => {
    if (!data) return;
    try {
      await exportSheets(`هزینه-استخدام-${range === 'all' ? 'همه' : range + '-روز'}.xlsx`, [
        {
          name: 'هزینه‌ها',
          rows: data.entries.map((e) => ({
            تاریخ: e.atJalali,
            نوع: KIND_LABEL[e.kind],
            'مبلغ (تومان)': e.amount,
            'فرصت شغلی': e.jobTitle || 'عمومی',
            توضیح: e.note,
            ثبت‌کننده: e.createdByName,
          })),
        },
        {
          name: 'خلاصه',
          rows: [
            { شاخص: 'هزینهٔ مستقیم (تومان)', مقدار: data.totals.direct },
            { شاخص: 'هزینهٔ زمان تیم (تومان)', مقدار: data.totals.time },
            { شاخص: 'جمع (تومان)', مقدار: data.totals.total },
            { شاخص: 'استخدام در بازه', مقدار: data.hires },
            { شاخص: 'هزینهٔ هر استخدام (تومان)', مقدار: data.perHire ?? '' },
            { شاخص: 'ساعت کار ثبت‌شده', مقدار: data.hours.total },
          ],
        },
      ]);
      toast('گزارش اکسل آماده شد.');
    } catch {
      toast('ساخت فایل ممکن نشد.', 'error');
    }
  };

  if (!isAdmin) {
    return (
      <div>
        <PageHeader title="هزینهٔ هر استخدام" subtitle="این گزارش مالی است" />
        <ReportTabs active="cost" />
        <Callout tone="info" icon={Banknote} title="هزینهٔ استخدام فقط برای مدیر یا مالک فضای کاری است">
          این صفحه شماره‌های مالی سازمان را نشان می‌دهد، پس فقط مدیر و مالک به آن دسترسی دارند. گزارش «عملکرد تیم» برای همه باز است.
        </Callout>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="هزینهٔ هر استخدام"
        subtitle="چه قدر خرج کردیم، چه چیزی استخدام شد و هر استخدام چقدر تمام شد"
        actions={
          <>
            <Segmented<ReportRange> value={range} onChange={(r) => setQuery({ range: r === '365' ? null : r })} items={RANGES} />
            <Button variant="primary" icon={Plus} onClick={openNew}>
              ثبت هزینه
            </Button>
            {data && (
              <Button variant="secondary" icon={Download} onClick={exportXlsx} disabled={!data.entries.length}>
                خروجی اکسل
              </Button>
            )}
          </>
        }
      />
      <ReportTabs active="cost" />

      {error && <ErrorState message={error} onRetry={reload} />}
      {!error && loading && !data && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-card" />
            ))}
          </div>
          <Skeleton className="h-[300px] rounded-card" />
        </div>
      )}

      {!error && data && (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
            <Stat icon={Coins} label="هزینهٔ کل" value={`${faMoney(data.totals.total)} تومان`} note="مستقیم + برآورد زمان تیم" tone="brand" />
            <Stat icon={UserCheck} label="هزینهٔ هر استخدام" value={data.perHire === null ? '—' : `${faMoney(data.perHire)} تومان`} note={data.hires ? `بر پایهٔ ${faNumber(data.hires)} استخدام` : 'در این بازه استخدامی ثبت نشده'} tone="high" />
            <Stat icon={Receipt} label="هزینهٔ مستقیم" value={`${faMoney(data.totals.direct)} تومان`} note={`${faNumber(data.entries.length)} ردیف ثبت‌شده`} tone="review" />
            <Stat icon={Timer} label="هزینهٔ زمان تیم" value={data.assumption.hourlyRate > 0 ? `${faMoney(data.totals.time)} تومان` : 'محاسبه نشده'} note={data.assumption.hourlyRate > 0 ? `${faNumber(data.hours.total, 1)} ساعت` : 'نرخ ساعتی وارد نشده'} />
          </div>

          {data.assumption.hourlyRate === 0 && (
            <Callout tone="warning" icon={Info} title="هزینهٔ زمان تیم در جمع نیامده است">
              کارت ارزیابی، یادداشت، تصمیم و مصاحبه همه ساعت کار تیم هستند. اگر نرخ ساعتی را در کارت پایین وارد کنید، همان ساعت‌ها به تومان
              تبدیل و به هزینهٔ هر استخدام اضافه می‌شوند. ما عددی از خودمان نمی‌سازیم.
            </Callout>
          )}

          {!data.entries.length && (
            <Callout tone="info" icon={Receipt} title="هنوز هیچ هزینه‌ای ثبت نشده است" action={<Button icon={Plus} onClick={openNew}>ثبت اولین هزینه</Button>}>
              آگهی، دستمزد ریکروتر، پاداش معرفی، ابزار و آزمون — هر چه واقعاً پرداخت کرده‌اید. تا آن موقع، این گزارش فقط هزینهٔ زمان تیم را می‌داند.
            </Callout>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <Card>
              <CardHeader title="هزینه به تفکیک نوع" subtitle="کدام بخش بیشترین پول را می‌برد" />
              {data.byKind.length ? (
                <div className="flex flex-col gap-3.5">
                  {data.byKind.map((k) => {
                    const max = data.byKind[0]?.amount || 1;
                    return (
                      <div key={k.kind}>
                        <div className="flex items-center justify-between gap-3 text-[13px]">
                          <span className="font-semibold text-ink-2">{k.label}</span>
                          <span className="inline-flex items-center gap-1.5 shrink-0">
                            <bdi className="hv-num font-bold text-ink">{faMoney(k.amount)}</bdi>
                            <bdi className="hv-num text-ink-3 text-[12px]">({toPersianDigits(k.count)} ردیف)</bdi>
                          </span>
                        </div>
                        <div className="mt-1.5 h-2 rounded-full bg-line-2 overflow-hidden">
                          <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(2, Math.round((k.amount / max) * 100))}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-[13px] text-ink-3">هنوز هزینه‌ای در این بازه ثبت نشده است.</p>
              )}
              {data.totals.unattributed > 0 && (
                <p className="text-[11.5px] text-ink-4 mt-3 leading-relaxed">
                  {faNumber(data.totals.unattributed)} تومان از این هزینه‌ها به فرصت شغلی خاصی نسبت داده نشده و در جدول پایین نمی‌آید.
                </p>
              )}
            </Card>

            <AssumptionCard data={data} onSaved={reload} />

            <Card>
              <CardHeader title="هزینهٔ هر استخدام چطور حساب می‌شود" subtitle="بدون فرمول پنهان" />
              <ul className="text-[12.5px] text-ink-2 leading-relaxed flex flex-col gap-2 list-disc pr-4">
                <li>هزینهٔ مستقیم: جمع همان ردیف‌هایی که ثبت کرده‌اید.</li>
                <li>هزینهٔ زمان: ساعت ثبت‌شده × نرخ ساعتی خودتان.</li>
                <li>
                  مخرج کسر: کارجوهایی که در همین بازه به ستون «استخدام‌شده» رسیده‌اند — {faNumber(data.hires)} نفر.
                </li>
                <li>هزینهٔ عمومی (بدون فرصت شغلی) در جمع کل می‌آید، نه در جدول هر فرصت.</li>
                <li>تا وقتی استخدامی ثبت نشود، «هزینهٔ هر استخدام» خالی می‌ماند؛ صفر نمی‌نویسیم چون عدد غلطی است.</li>
              </ul>
              {data.perHire !== null && data.totals.direct > 0 && (
                <p className="text-[12px] text-ink-3 mt-3">
                  سهم هزینهٔ مستقیم از کل: {faPercent((data.totals.direct / Math.max(1, data.totals.total)) * 100)}
                </p>
              )}
            </Card>
          </div>

          <Card padded={false}>
            <div className="px-5 pt-5">
              <CardHeader title="ردیف‌های هزینه" subtitle="هر عدد پشتش یک فاکتور دارد" action={<span className="text-[11.5px] text-ink-4">به تفکیک تاریخ پرداخت</span>} />
            </div>
            {data.entries.length ? (
              <div className="overflow-x-auto hv-scroll">
                <table className="w-full text-right text-[13px]">
                  <thead>
                    <tr className="text-[12px] text-ink-3 border-b border-line">
                      <th className="font-semibold py-2.5 pr-5">تاریخ</th>
                      <th className="font-semibold py-2.5 px-2">نوع</th>
                      <th className="font-semibold py-2.5 px-2">مبلغ (تومان)</th>
                      <th className="font-semibold py-2.5 px-2">فرصت شغلی</th>
                      <th className="font-semibold py-2.5 px-2">توضیح</th>
                      <th className="font-semibold py-2.5 px-2">ثبت‌کننده</th>
                      <th className="font-semibold py-2.5 pl-5 text-left">—</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((e) => (
                      <tr key={e.id} className="border-b border-line-2 last:border-0 hover:bg-canvas">
                        <td className="py-2.5 pr-5 hv-num text-ink-2 whitespace-nowrap">{e.atJalali}</td>
                        <td className="px-2 text-ink-2">{KIND_LABEL[e.kind]}</td>
                        <td className="px-2 hv-num font-bold text-ink">{faNumber(e.amount)}</td>
                        <td className="px-2 text-ink-2">{e.jobTitle || <span className="text-ink-4">عمومی</span>}</td>
                        <td className="px-2 text-ink-3 max-w-[260px] truncate" title={e.note}>
                          {e.note || '—'}
                        </td>
                        <td className="px-2 text-ink-3">{e.createdByName}</td>
                        <td className="pl-5">
                          <div className="flex items-center gap-1 justify-end">
                            <IconButton label="ویرایش" icon={Pencil} onClick={() => openEdit(e)} />
                            <IconButton label="حذف" icon={Trash2} tone="danger" onClick={() => setToDelete(e)} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="px-5 py-6 text-[13px] text-ink-3">هزینه‌ای در این بازه ثبت نشده است.</p>
            )}
          </Card>

          {data.byJob.length > 0 && (
            <Card padded={false}>
              <div className="px-5 pt-5">
                <CardHeader title="هزینه به تفکیک فرصت شغلی" subtitle="هزینهٔ نسبت‌داده‌شده و استخدام‌های همان آگهی" />
              </div>
              <div className="overflow-x-auto hv-scroll">
                <table className="w-full text-right text-[13px]">
                  <thead>
                    <tr className="text-[12px] text-ink-3 border-b border-line">
                      <th className="font-semibold py-2.5 pr-5">فرصت شغلی</th>
                      <th className="font-semibold py-2.5 px-2">هزینهٔ مستقیم</th>
                      <th className="font-semibold py-2.5 px-2">هزینهٔ زمان</th>
                      <th className="font-semibold py-2.5 px-2">استخدام</th>
                      <th className="font-semibold py-2.5 pl-5">هزینهٔ هر استخدام</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byJob.map((j) => (
                      <tr key={j.jobId} className="border-b border-line-2 last:border-0 hover:bg-canvas">
                        <td className="py-2.5 pr-5 font-semibold text-ink">{j.roleTitle}</td>
                        <td className="px-2 hv-num text-ink-2">{j.direct ? faNumber(j.direct) : '—'}</td>
                        <td className="px-2 hv-num text-ink-2">{j.time ? faNumber(j.time) : '—'}</td>
                        <td className="px-2 hv-num font-semibold">{j.hires ? faNumber(j.hires) : '—'}</td>
                        <td className="pl-5 hv-num font-bold text-ink">{j.perHire === null ? <span className="text-ink-4 font-normal">هنوز استخدامی ثبت نشده</span> : faNumber(j.perHire)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-[11.5px] text-ink-4 leading-relaxed flex gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            تاریخ‌ها به شمسی و بر مبنای روز پرداخت‌اند. هزینهٔ زمان تیم برآورد است، نه اندازه‌گیری؛ برای همین همیشه جدا از هزینهٔ مستقیم
            نشان داده می‌شود. آخرین به‌روزرسانی: {faDate(new Date().toISOString())}.
          </p>
        </div>
      )}

      <CostForm open={formOpen} onClose={() => setFormOpen(false)} form={form} setForm={setForm} jobs={jobs} onSaved={reload} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={remove}
        loading={deleting}
        title="حذف این ردیف هزینه؟"
        description={toDelete ? `${KIND_LABEL[toDelete.kind]} — ${faNumber(toDelete.amount)} تومان، ${toDelete.atJalali}. این کار در تاریخچهٔ تیم ثبت می‌شود.` : undefined}
        confirmLabel="حذف"
      />
    </div>
  );
}

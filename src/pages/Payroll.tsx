import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, Link2, Send, Settings2, ShieldCheck, Trash2, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, ErrorState, Modal, Skeleton, Stat, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { toPersianDigits } from '../lib/format';
import { useTitle } from '../lib/useTitle';
import { PAYROLL_OWN_FIELDS, type HrisRoster } from '../types/hris';

/**
 * «حقوق و دستمزد» — the seam between hiring and paying.
 *
 * The page is deliberately boring: a table of the people payroll must pay, the
 * exact file it receives, and where that file goes. Two promises are visible on
 * screen: an empty cell stays empty (no invented salary), and nothing is sent
 * anywhere until an admin presses «فرستادن به سیستم حقوق».
 */
export default function Payroll() {
  useTitle('حقوق و دستمزد');
  const canAdmin = useCan('admin');
  const [data, setData] = useState<HrisRoster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [pushing, setPushing] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    api.hris
      .roster()
      .then(setData)
      .catch((err: any) => setError(err?.message || 'خواندن فهرست حقوق ممکن نشد.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const push = async () => {
    setPushing(true);
    try {
      const r = await api.hris.push();
      setData(r.roster);
      toast(
        r.push.ok
          ? `فهرست ${toPersianDigits(r.push.rows)} نفر فرستاده شد.`
          : `فرستاده نشد — ${r.push.error || 'پاسخ ناموفق'}`,
        r.push.ok ? 'success' : 'error'
      );
    } catch (err: any) {
      toast(err?.message || 'ارسال به سیستم حقوق ممکن نشد.', 'error');
    } finally {
      setPushing(false);
    }
  };

  const activeColumns = useMemo(
    () => (data ? Object.entries(data.mapping).filter(([, header]) => Boolean(header)) : []),
    [data]
  );

  return (
    <div className="hv-page">
      <PageHeader
        title="حقوق و دستمزد"
        subtitle="فهرست کسانی که باید پرداخت شوند، فایل آمادهٔ سیستم حقوق، و ارسال امضاشده به همان سیستم."
        actions={
          <div className="flex flex-wrap gap-2">
            <a
              href={api.hris.exportUrl}
              download
              className={`hv-btn hv-btn-secondary hv-btn-md ${!data?.items.length ? 'pointer-events-none opacity-50' : ''}`}
            >
              <Download className="w-4 h-4" />
              دریافت CSV
            </a>
            <Button icon={Send} loading={pushing} disabled={!canAdmin || !data?.endpoint.configured || !data?.items.length} onClick={() => void push()}>
              فرستادن به سیستم حقوق
            </Button>
          </div>
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {loading && !data && <Skeleton className="h-[180px] rounded-[14px]" />}

      {data && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="در فهرست حقوق" value={toPersianDigits(data.counts.total)} icon={Users} />
            <Stat label="روز اول گذشته" value={toPersianDigits(data.counts.started)} icon={CheckCircle2} />
            <Stat label="شروع در آینده" value={toPersianDigits(data.counts.upcoming)} icon={AlertTriangle} />
            <Stat label="بدون حقوق در پیشنهاد" value={toPersianDigits(data.counts.missingSalary)} icon={AlertTriangle} />
          </div>

          <Callout tone="info" icon={ShieldCheck} title="چه چیزی اینجا هست و چه چیزی نیست">
            این فهرست از «برنامهٔ تحویل پس از استخدام» ساخته می‌شود و با هر تغییر همان‌جا به‌روز می‌شود. چیزی که در پیشنهاد
            نوشته نشده باشد خالی می‌ماند — ما حقوق حدس نمی‌زنیم. اطلاعاتی که مال سیستم حقوق است ({PAYROLL_OWN_FIELDS.slice(0, 3).join('، ')} و
            مانند آن) عمداً در هویدا جمع نمی‌شود.
          </Callout>

          {data.items.length === 0 ? (
            <Card>
              <div className="p-6 text-center">
                <p className="font-bold text-ink mb-1">هنوز کسی در فهرست نیست.</p>
                <p className="text-[12.5px] text-ink-3 leading-relaxed">
                  فهرست وقتی پر می‌شود که یک کارجو پیشنهاد را بپذیرد؛ همان لحظه برنامهٔ تحویل ساخته می‌شود و اینجا ظاهر می‌شود.
                </p>
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader
                title="فهرست حقوق"
                subtitle={`${toPersianDigits(data.items.length)} نفر — ${toPersianDigits(activeColumns.length)} ستون در فایل`}
                action={
                  <Button size="sm" variant="ghost" icon={Settings2} onClick={() => setColumnsOpen(true)} disabled={!canAdmin}>
                    ستون‌های فایل
                  </Button>
                }
              />
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr className="text-ink-3 border-b border-line">
                      <th className="text-right font-medium px-4 py-2">کد پرسنلی</th>
                      <th className="text-right font-medium px-4 py-2">نام</th>
                      <th className="text-right font-medium px-4 py-2">عنوان شغلی</th>
                      <th className="text-right font-medium px-4 py-2">دپارتمان</th>
                      <th className="text-right font-medium px-4 py-2">شروع</th>
                      <th className="text-right font-medium px-4 py-2">حقوق</th>
                      <th className="text-right font-medium px-4 py-2">وضعیت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => (
                      <tr key={row.planId} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-2.5 text-ink-3 font-mono" dir="ltr">{row.employeeCode || '—'}</td>
                        <td className="px-4 py-2.5 font-medium text-ink">{row.fullName}</td>
                        <td className="px-4 py-2.5 text-ink-2">{row.jobTitle || '—'}</td>
                        <td className="px-4 py-2.5 text-ink-2">{row.departmentName || '—'}</td>
                        <td className="px-4 py-2.5 text-ink-2 hv-num">{row.startDateJalali}</td>
                        <td className="px-4 py-2.5 hv-num">
                          {row.baseSalary == null ? (
                            <span className="text-ink-4">خالی</span>
                          ) : (
                            <span className="text-ink">
                              {toPersianDigits(row.baseSalary.toLocaleString('en-US'))}{' '}
                              <span className="text-ink-4">{row.salaryPeriod === 'annual' ? 'سالانه' : 'ماهانه'}</span>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <Chip tone={row.planStatus === 'completed' ? 'brand' : 'outline'}>
                            {row.planStatus === 'completed' ? 'کامل‌شده' : 'در جریان'}
                          </Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card>
            <CardHeader
              title="گیرندهٔ فایل"
              subtitle="جایی که با یک کلیک فهرست به آنجا می‌رود — امضاشده، با کلید خودتان."
              action={
                <div className="flex gap-2">
                  {data.endpoint.configured ? (
                    <>
                      <Button size="sm" variant="ghost" icon={Settings2} onClick={() => setEndpointOpen(true)} disabled={!canAdmin}>
                        تغییر
                      </Button>
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDisconnectOpen(true)} disabled={!canAdmin}>
                        حذف
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="secondary" icon={Link2} onClick={() => setEndpointOpen(true)} disabled={!canAdmin}>
                      تنظیم نشانی
                    </Button>
                  )}
                </div>
              }
            />
            <div className="px-4 pb-4">
              {data.endpoint.configured ? (
                <div className="text-[12.5px] text-ink-2 flex flex-col gap-1">
                  <p dir="ltr" className="font-mono text-ink-3 break-all">{data.endpoint.masked}</p>
                  <p className="text-ink-4">
                    کلید امضا با <span dir="ltr">{data.endpoint.secretHint}</span> تمام می‌شود؛ سرور شما باید هدر{' '}
                    <span dir="ltr">X-Hovida-Signature</span> را با همان کلید بررسی کند.
                  </p>
                </div>
              ) : (
                <p className="text-[12.5px] text-ink-3 leading-relaxed">
                  هنوز تنظیم نشده است. تا آن موقع «دریافت CSV» کار می‌کند و می‌توانید فایل را دستی به سیستم حقوق بدهید. با
                  تنظیم نشانی، همان فهرست با امضای HMAC به سیستم شما فرستاده می‌شود.
                </p>
              )}

              {data.lastPush && (
                <div className="mt-3 pt-3 border-t border-line flex flex-wrap items-center gap-2 text-[12px]">
                  <Chip tone={data.lastPush.ok ? 'brand' : 'danger'}>
                    {data.lastPush.ok ? 'آخرین ارسال موفق' : 'آخرین ارسال ناموفق'}
                  </Chip>
                  <span className="text-ink-3">
                    {data.lastPush.atJalali} — {toPersianDigits(data.lastPush.rows)} نفر
                    {data.lastPush.byName ? ` — ${data.lastPush.byName}` : ''}
                  </span>
                  {!data.lastPush.ok && data.lastPush.error && <span className="text-ink-4">{data.lastPush.error}</span>}
                </div>
              )}
            </div>
          </Card>

          <Callout tone="info" icon={CheckCircle2} title="چه چیزی در فایل می‌رود؟">
            سرستون‌ها را خودتان می‌گذارید و هر ستونی را نخواستید برمی‌دارید: {activeColumns.map(([, header]) => header).join('، ')}.
          </Callout>
        </div>
      )}

      {data && (
        <ColumnsModal open={columnsOpen} onClose={() => setColumnsOpen(false)} data={data} onSaved={setData} />
      )}
      {data && (
        <EndpointModal open={endpointOpen} onClose={() => setEndpointOpen(false)} onSaved={setData} />
      )}
      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => setDisconnectOpen(false)}
        title="اتصال به سیستم حقوق برداشته شود؟"
        description="نام ستون‌های فایل حفظ می‌شود؛ فقط نشانی و کلید امضا پاک می‌شوند. تا وقتی نشانی تازه نگذارید، ارسال ممکن نیست."
        confirmLabel="بردار"
        onConfirm={async () => {
          try {
            const r = await api.hris.disconnect();
            setData(r.roster);
            setDisconnectOpen(false);
            toast('اتصال برداشته شد.', 'info');
          } catch (err: any) {
            toast(err?.message || 'برداشتن اتصال ممکن نشد.', 'error');
          }
        }}
      />
    </div>
  );
}

function ColumnsModal({
  open,
  onClose,
  data,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  data: HrisRoster;
  onSaved: (r: HrisRoster) => void;
}) {
  const [mapping, setMapping] = useState<Record<string, string>>(data.mapping);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setMapping(data.mapping);
  }, [open, data.mapping]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.hris.mapping(mapping);
      onSaved(r.roster);
      toast('ستون‌های فایل ذخیره شد.', 'success');
      onClose();
    } catch (err: any) {
      toast(err?.message || 'ذخیرهٔ ستون‌ها ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="ستون‌های فایل حقوق"
      description="نام هر ستون همان چیزی است که سیستم حقوق شما می‌خواند. خالی بگذارید تا آن ستون در فایل نیاید."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            بستن
          </Button>
          <Button onClick={() => void save()} loading={saving}>
            ذخیره
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {data.fields.map((field) => (
          <TextInput
            key={field.key}
            label={field.label}
            hint={field.hint}
            value={mapping[field.key] || ''}
            onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value })}
            placeholder="خالی = در فایل نمی‌آید"
          />
        ))}
      </div>
    </Modal>
  );
}

function EndpointModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (r: HrisRoster) => void }) {
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setUrl('');
      setSecret('');
    }
  }, [open]);

  const save = async () => {
    setSaving(true);
    try {
      const r = await api.hris.endpoint({ url: url.trim(), secret: secret.trim() || undefined });
      onSaved(r.roster);
      toast('نشانی گیرنده ذخیره شد.', 'success');
      onClose();
    } catch (err: any) {
      toast(err?.message || 'ذخیرهٔ نشانی ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="گیرندهٔ فهرست حقوق"
      description="آدرسی که یک POST با بدنهٔ JSON می‌گیرد. اگر کلید امضا ندهید، ما یکی می‌سازیم و فقط آخرش را نشان می‌دهیم."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            بستن
          </Button>
          <Button onClick={() => void save()} loading={saving} disabled={!url.trim()}>
            ذخیره
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextInput
          label="نشانی دریافت‌کننده"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://payroll.example.ir/hooks/hovida"
          latin
          hint="باید https باشد. برای سرور داخلی، 127.0.0.1 هم پذیرفته می‌شود."
        />
        <TextInput
          label="کلید امضا (اختیاری)"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="خالی بگذارید تا ساخته شود"
          latin
          hint="دست‌کم ۱۶ نویسه. با همین کلید، هدر X-Hovida-Signature ساخته می‌شود."
        />
        <Callout tone="info" icon={ShieldCheck}>
          بدنهٔ ارسال این شکل است: <span dir="ltr">{'{ id, event: "hris.roster", columns, rows }'}</span> — هر ردیف فقط
          ستون‌هایی را دارد که در فایل انتخاب کرده‌اید.
        </Callout>
      </div>
    </Modal>
  );
}

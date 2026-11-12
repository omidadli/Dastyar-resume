/**
 * «سنجش نرم‌شده» inside the workspace.
 *
 * The page is built around one question: *is this number worth reading?* So the
 * norm banner comes before the bars, quality flags come before the scores, and
 * the reading text (what high and low look like at work) sits next to every bar.
 * Nothing here offers to reject, advance or rank — that is not what a percentile
 * is for.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, ClipboardList, Copy, Info, RefreshCw, Send, ShieldQuestion, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, EmptyState, Modal, Skeleton, toast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toPersianDigits } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import { PSYCH_STATUS_LABEL, type PsychGroupReport, type PsychInvite } from '../types/psychometrics';

const STATUS_TONE: Record<PsychInvite['status'], string> = {
  sent: 'bg-[#EAF2F7] text-[#24485E] border-[#D5E3EC]',
  started: 'bg-review-soft text-review-ink border-review/25',
  submitted: 'bg-brand-tint text-brand-stronger border-brand/20',
  expired: 'bg-low-soft text-low-ink border-low/20',
  cancelled: 'bg-na-soft text-na-ink border-line',
  declined: 'bg-low-soft text-low-ink border-low/20',
};

function ScaleBar({ label, percent, percentile }: { label: string; percent: number; percentile: number | null }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[12.5px] text-ink-2">{label}</p>
        <p className="text-[11.5px] text-ink-3 hv-num">
          {percentile !== null ? `صدک ${toPersianDigits(percentile)}` : `${toPersianDigits(percent)}٪ از دامنه`}
        </p>
      </div>
      <div className="h-2 rounded-full bg-line-2 mt-1.5 overflow-hidden" role="img" aria-label={`${label}: ${percent} درصد`}>
        <div className="h-full bg-brand" style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
      </div>
    </div>
  );
}

export default function PsychReview({ resumeId }: { resumeId: string }) {
  const invitesQ = useAsync(() => api.psych.invites({ resumeId }), [resumeId]);
  const scalesQ = useAsync(() => api.psych.scales(), []);
  const [items, setItems] = useState<PsychInvite[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ invite: PsychInvite; reading: { id: string; label: string; high: string; low: string }[] } | null>(null);
  const [report, setReport] = useState<PsychGroupReport | null>(null);
  const [reportBusy, setReportBusy] = useState(false);

  useTitle('سنجش نرم‌شده');

  useEffect(() => {
    if (invitesQ.data) setItems(invitesQ.data.items);
  }, [invitesQ.data]);

  const refresh = async () => {
    try {
      setItems((await api.psych.invites({ resumeId })).items);
    } catch {
      /* keep what is on screen */
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>, message: string) => {
    setBusyId(id);
    try {
      await fn();
      await refresh();
      toast(message);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'انجام این کار ممکن نشد.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const create = async () => {
    setBusyId('new');
    try {
      await api.psych.create({ resumeId });
      await refresh();
      toast('دعوت ساخته شد؛ حالا «فرستادن» را بزنید.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ساخت دعوت ممکن نشد.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const openReport = async (jobId: string) => {
    setReportBusy(true);
    try {
      setReport((await api.psych.report(jobId)).report);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'گزارش گروهی خوانده نشد.', 'error');
    } finally {
      setReportBusy(false);
    }
  };

  const jobId = items[0]?.jobId;

  return (
    <div className="max-w-[980px]">
      <PageHeader
        breadcrumb={[
          { label: 'رزومه‌ها', to: '/app/candidates' },
          { label: 'کارجو', to: `/app/candidates/${resumeId}` },
          { label: 'سنجش نرم‌شده' },
        ]}
        title="سنجش نرم‌شده"
        subtitle="پنج مقیاس کاری، با هنجاری که نامش روی همان صفحه نوشته می‌شود"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
              به‌روزرسانی
            </Button>
            <Button icon={ClipboardList} loading={busyId === 'new'} onClick={() => void create()}>
              دعوت تازه
            </Button>
          </div>
        }
      />

      <Callout tone="info" title="صدک بدون گروه مقایسه، عدد نیست">
        این صفحه هیچ صدکی را اختراع نمی‌کند: اگر برای مقیاسی هنجار نداشته باشیم، فقط درصد دامنه نشان داده می‌شود و نوشته می‌شود «بدون هنجار». هنجار را می‌توانید در
        «تنظیمات ← سنجش نرم‌شده» وارد کنید یا بگذارید از {toPersianDigits(scalesQ.data?.minNormN ?? 20)} نتیجهٔ تکمیل‌شدهٔ همین فضای کاری ساخته شود.
      </Callout>

      <div className="mt-4 flex flex-col gap-4">
        {invitesQ.error && (
          <Card>
            <p className="text-[13px] text-low-ink">{invitesQ.error}</p>
          </Card>
        )}
        {!invitesQ.data && !invitesQ.error && <Skeleton className="h-40" />}

        {invitesQ.data && items.length === 0 && (
          <Card>
            <EmptyState
              icon={ClipboardList}
              title="هنوز پرسش‌نامه‌ای فرستاده نشده"
              description="یک دعوت می‌سازید، لینکش را می‌بینید و با یک کلیک از صندوق خودتان می‌فرستید."
              action={
                <Button icon={ClipboardList} onClick={() => void create()} loading={busyId === 'new'}>
                  ساخت دعوت
                </Button>
              }
            />
          </Card>
        )}

        {items.map((inv) => (
          <Card key={inv.id} padded={false}>
            <div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-[14px] font-bold text-ink">{inv.candidateName}</p>
                  <p className="text-[11.5px] text-ink-3">
                    {inv.jobTitle || 'بدون آگهی'} · ساخته‌شده {inv.createdAtJalali}
                    {inv.submittedAtJalali ? ` · تکمیل ${inv.submittedAtJalali}` : ''}
                  </p>
                </div>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${STATUS_TONE[inv.status]}`}>{PSYCH_STATUS_LABEL[inv.status]}</span>
              </div>

              {inv.result && (
                <div className="mt-3 rounded-control border border-line-2 bg-canvas p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                        inv.result.quality.usable ? 'bg-brand-tint text-brand-stronger border-brand/20' : 'bg-review-soft text-review-ink border-review/25'
                      }`}
                    >
                      {inv.result.quality.usable ? 'قابل خواندن' : 'نیازمند بازبینی'}
                    </span>
                    <span className="text-[11.5px] text-ink-3">هنجار: {inv.result.norm.label}</span>
                    <span className="text-[11.5px] text-ink-4">
                      {toPersianDigits(Math.round(inv.result.quality.durationSeconds / 60))} دقیقه
                    </span>
                  </div>

                  {!inv.result.quality.usable && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {inv.result.quality.flags.map((f) => (
                        <li key={f.code} className="text-[11.5px] text-review-ink inline-flex items-start gap-1.5">
                          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {f.label}
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="grid gap-2.5 mt-3">
                    {inv.result.scales.map((s) => (
                      <ScaleBar key={s.id} label={s.label} percent={s.percent} percentile={s.percentile} />
                    ))}
                  </div>

                  <Button size="sm" variant="ghost" className="mt-2" onClick={async () => {
                    try {
                      setDetail(await api.psych.invite(inv.id));
                    } catch (err) {
                      toast(err instanceof ApiError ? err.message : 'خواندن جزئیات ممکن نشد.', 'error');
                    }
                  }}>
                    چه چیزی را نشان می‌دهد؟
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-3">
                {inv.status !== 'submitted' && inv.status !== 'cancelled' && inv.status !== 'declined' && (
                  <Button
                    size="sm"
                    icon={Send}
                    loading={busyId === inv.id}
                    onClick={() => void act(inv.id, () => api.psych.send(inv.id), 'لینک برای کارجو ایمیل شد.')}
                  >
                    فرستادن برای کارجو
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Copy}
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(inv.url || '');
                      toast('لینک کپی شد.');
                    } catch {
                      toast('کپی ممکن نشد؛ لینک را دستی بردارید.', 'error');
                    }
                  }}
                >
                  کپی لینک
                </Button>
                {inv.jobId && (
                  <Button size="sm" variant="ghost" icon={BarChart3} loading={reportBusy} onClick={() => void openReport(inv.jobId)}>
                    گزارش گروهی آگهی
                  </Button>
                )}
                {(inv.status === 'sent' || inv.status === 'started' || inv.status === 'expired') && (
                  <Button size="sm" variant="ghost" className="text-low-ink" onClick={() => void act(inv.id, () => api.psych.cancel(inv.id), 'دعوت لغو شد.')}>
                    لغو دعوت
                  </Button>
                )}
                <span className="hv-latin text-[10.5px] text-ink-4 truncate w-full mt-1" dir="ltr">
                  {inv.url}
                </span>
              </div>

              {inv.status === 'declined' && (
                <p className="text-[11.5px] text-low-ink mt-2">کارجو این مرحله را نپذیرفت. این انتخاب در بررسی او اثری ندارد.</p>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title="راهنمای خواندن نتیجه" size="md">
        {detail && (
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-ink-3">هنجار به‌کاررفته: {detail.invite.result?.norm.label}</p>
            {detail.reading.map((r) => {
              const score = detail.invite.result?.scales.find((s) => s.id === r.id);
              return (
                <div key={r.id} className="rounded-control border border-line-2 bg-canvas p-3">
                  <p className="text-[12.5px] font-bold text-ink">
                    {r.label}
                    {score && (
                      <span className="font-normal text-[11.5px] text-ink-3 mr-2">
                        {score.percentile !== null ? `صدک ${toPersianDigits(score.percentile)}` : `${toPersianDigits(score.percent)}٪ دامنه`}
                      </span>
                    )}
                  </p>
                  <p className="text-[11.5px] text-ink-2 mt-1 leading-relaxed">
                    <span className="font-semibold">بالا: </span>
                    {r.high}
                  </p>
                  <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">
                    <span className="font-semibold">پایین: </span>
                    {r.low}
                  </p>
                </div>
              );
            })}
            <p className="text-[11.5px] text-ink-4 flex items-start gap-1.5">
              <ShieldQuestion className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              این ابزار تشخیص بالینی نیست و هیچ مرحله‌ای را تغییر نمی‌دهد. مقیاسی که پایین می‌آید، موضوع سؤال در مصاحبه است؛ نه دلیل رد.
            </p>
          </div>
        )}
      </Modal>

      <Modal open={Boolean(report)} onClose={() => setReport(null)} title="گزارش گروهی" size="lg">
        {report && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-bold text-ink">{report.jobTitle}</p>
              <p className="text-[11.5px] text-ink-3">
                {toPersianDigits(report.n)} نتیجهٔ قابل خواندن · هنجار: {report.norm.label}
              </p>
            </div>
            {report.suppressed && (
              <Callout tone="warning" title="گروه کوچک است">
                میانگین کمتر از {toPersianDigits(5)} نفر گزارش نمی‌شود؛ «میانگین سه نفر» یک نفر با ممیز است. ردیف‌های فردی را می‌بینید، میانگین را نه.
              </Callout>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-[11.5px]">
                <thead>
                  <tr className="text-ink-3 text-right">
                    <th className="py-1.5 px-2 font-semibold">کارجو</th>
                    {report.scales.map((s) => (
                      <th key={s.id} className="py-1.5 px-2 font-semibold whitespace-nowrap">
                        {s.label}
                      </th>
                    ))}
                    <th className="py-1.5 px-2 font-semibold">اعتبار</th>
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, i) => (
                    <tr key={`${row.resumeId}-${i}`} className="border-t border-line-2">
                      <td className="py-1.5 px-2 text-ink">{row.candidateName}</td>
                      {report.scales.map((s) => (
                        <td key={s.id} className="py-1.5 px-2 hv-num text-ink-2">
                          {row.percentiles[s.id] === null || row.percentiles[s.id] === undefined ? '—' : toPersianDigits(row.percentiles[s.id] as number)}
                        </td>
                      ))}
                      <td className="py-1.5 px-2">
                        <span className={row.usable ? 'text-brand-stronger' : 'text-review-ink'}>{row.usable ? 'قابل خواندن' : 'بازبینی'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-line">
                    <td className="py-1.5 px-2 font-bold text-ink">میانگین</td>
                    {report.scales.map((s) => (
                      <td key={s.id} className="py-1.5 px-2 hv-num font-bold text-ink">
                        {s.suppressed ? 'پنهان' : s.meanPercentile === null ? '—' : toPersianDigits(s.meanPercentile)}
                      </td>
                    ))}
                    <td className="py-1.5 px-2 text-ink-3">
                      <Users className="w-3.5 h-3.5 inline" /> {toPersianDigits(report.n)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-ink-4 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              درصدها فقط وقتی معنا دارند که هنجار یکسان باشد. این جدول برای دیدن توزیع است، نه رتبه‌بندی استخدام.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

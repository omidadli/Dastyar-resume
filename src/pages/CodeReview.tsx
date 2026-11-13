/**
 * «چالش کد» — where HR sends a task and reads what came back.
 *
 * The reading rules are on the page, not implied:
 *   • the score is a number of passing tests, not a verdict — the rubric next to
 *     it says what a good solution shows;
 *   • how many times the candidate ran their code is shown as effort, not as a
 *     penalty;
 *   • the result never moves the stage; the decision stays human.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Code2, Copy, Mail, Play, RefreshCw, Send, ShieldQuestion, XCircle } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, EmptyState, Modal, Select, Skeleton, toast } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { toPersianDigits } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import { CODE_DIFFICULTY_LABEL, CODE_STATUS_LABEL, type CodeChallengeSummary, type CodeInvite } from '../types/coding';

const STATUS_TONE: Record<CodeInvite['status'], string> = {
  sent: 'bg-[#EAF2F7] text-[#24485E] border-[#D5E3EC]',
  started: 'bg-review-soft text-review-ink border-review/25',
  submitted: 'bg-brand-tint text-brand-stronger border-brand/20',
  expired: 'bg-low-soft text-low-ink border-low/20',
  cancelled: 'bg-na-soft text-na-ink border-line',
  declined: 'bg-low-soft text-low-ink border-low/20',
};

export default function CodeReview({ resumeId }: { resumeId: string }) {
  const invitesQ = useAsync(() => api.coding.invites(resumeId), [resumeId]);
  const bankQ = useAsync(() => api.coding.challenges(), []);
  const [items, setItems] = useState<CodeInvite[]>([]);
  const [open, setOpen] = useState(false);
  const [challengeId, setChallengeId] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ invite: CodeInvite; rubric: string; tests: { name: string; hidden: boolean }[] } | null>(null);

  useTitle('چالش کد');

  useEffect(() => {
    if (invitesQ.data) setItems(invitesQ.data.items);
  }, [invitesQ.data]);

  useEffect(() => {
    if (bankQ.data && !challengeId) setChallengeId(bankQ.data.challenges[0]?.id || '');
  }, [bankQ.data, challengeId]);

  const refresh = async () => {
    try {
      setItems((await api.coding.invites(resumeId)).items);
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
      const r = await api.coding.create({ resumeId, challengeId });
      await refresh();
      setOpen(false);
      // Sending is a separate, explicit click — creating an invitation never mails anyone.
      toast('دعوت ساخته شد؛ حالا «فرستادن» را بزنید.');
      void r;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ساخت دعوت ممکن نشد.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const bank: CodeChallengeSummary[] = bankQ.data?.challenges || [];

  return (
    <div className="max-w-[980px]">
      <PageHeader
        breadcrumb={[
          { label: 'رزومه‌ها', to: '/app/candidates' },
          { label: 'کارجو', to: `/app/candidates/${resumeId}` },
          { label: 'چالش کد' },
        ]}
        title="چالش کد"
        subtitle="یک تمرین کوتاه که در مرورگر کارجو اجرا و روی تست‌ها سنجیده می‌شود"
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
              به‌روزرسانی
            </Button>
            <Button icon={Code2} onClick={() => setOpen(true)}>
              چالش تازه
            </Button>
          </div>
        }
      />

      <Callout tone="info" title="نتیجه یک سیگنال است، نه حکم">
        کد کارجو در یک فرایند جدا از سرور، با سقف زمانی و حافظه و بدون دسترسی به فایل یا شبکه اجرا می‌شود. عدد تست‌ها را همراه شرح «چه چیزی را نشان می‌دهد» بخوانید؛
        هیچ مرحله‌ای خودکار تغییر نمی‌کند.
      </Callout>

      <div className="mt-4 flex flex-col gap-4">
        {invitesQ.error && <Card><p className="text-[13px] text-low-ink">{invitesQ.error}</p></Card>}
        {!invitesQ.data && !invitesQ.error && <Skeleton className="h-40" />}

        {invitesQ.data && items.length === 0 && (
          <Card>
            <EmptyState
              icon={Code2}
              title="هنوز چالشی فرستاده نشده"
              description="برای این کارجو یک تمرین انتخاب کنید؛ ابتدا لینک ساخته می‌شود و بعد با یک کلیک برای کارجو ایمیل می‌شود."
              action={
                <Button icon={Code2} onClick={() => setOpen(true)}>
                  انتخاب چالش
                </Button>
              }
            />
          </Card>
        )}

        {items.map((inv) => (
          <Card key={inv.id} padded={false}>
            <div className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-bold text-ink">{inv.challengeTitle}</p>
                  <p className="text-[11.5px] text-ink-3">
                    ساخته‌شده {inv.createdAtJalali}
                    {inv.sentAtISO ? ' · فرستاده شد' : ' · هنوز فرستاده نشده'}
                    {inv.runCount > 0 ? ` ، ${toPersianDigits(inv.runCount)} اجرای آزمایشی` : ''}
                  </p>
                </div>
                <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${STATUS_TONE[inv.status]}`}>{CODE_STATUS_LABEL[inv.status]}</span>
              </div>

              {inv.result && (
                <div className="mt-3 rounded-control border border-line-2 bg-canvas p-3">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <p className="text-[15px] font-extrabold text-ink hv-num">
                      {toPersianDigits(inv.result.passed)} از {toPersianDigits(inv.result.total)} تست
                      {inv.result.score !== null && <span className="text-[12px] font-bold text-ink-3 mr-2">({toPersianDigits(inv.result.score)}٪)</span>}
                    </p>
                    <span className="text-[11.5px] text-ink-3">{inv.submittedAtJalali}</span>
                    {inv.result.killed && <span className="text-[11.5px] text-review-ink font-semibold">اجرا متوقف شد (زمان/حافظه)</span>}
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {inv.result.cases.map((c, i) => (
                      <li key={`${c.name}-${i}`} className="inline-flex items-center gap-1 text-[11px] text-ink-3">
                        {c.passed ? <CheckCircle2 className="w-3.5 h-3.5 text-brand-strong" /> : <XCircle className="w-3.5 h-3.5 text-low-ink" />}
                        {c.hidden ? 'پنهان' : c.name}
                      </li>
                    ))}
                  </ul>
                  {inv.result.error && <p className="text-[11.5px] text-low-ink mt-1.5 leading-relaxed">{inv.result.error}</p>}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-3">
                {inv.status !== 'submitted' && inv.status !== 'cancelled' && inv.status !== 'declined' && (
                  <Button
                    size="sm"
                    icon={Send}
                    loading={busyId === inv.id}
                    onClick={() => void act(inv.id, () => api.coding.send(inv.id), 'دعوت برای کارجو ایمیل شد.')}
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
                      toast('کپی ممکن نشد؛ لینک زیر را دستی بردارید.', 'error');
                    }
                  }}
                >
                  کپی لینک
                </Button>
                {inv.status === 'declined' && (
                  <span className="text-[11.5px] text-low-ink">کارجو این تمرین را نپذیرفت — می‌توانید چالش دیگری بفرستید.</span>
                )}
                {inv.status === 'submitted' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        setDetail(await api.coding.invite(inv.id));
                      } catch (err) {
                        toast(err instanceof ApiError ? err.message : 'خواندن جزئیات ممکن نشد.', 'error');
                      }
                    }}
                  >
                    شرح و راهنمای خواندن
                  </Button>
                )}
                {(inv.status === 'sent' || inv.status === 'started' || inv.status === 'expired') && (
                  <Button size="sm" variant="ghost" className="text-low-ink" onClick={() => void act(inv.id, () => api.coding.cancel(inv.id), 'دعوت لغو شد.')}>
                    لغو دعوت
                  </Button>
                )}
                <span className="hv-latin text-[10.5px] text-ink-4 truncate w-full mt-1" dir="ltr">
                  {inv.url}
                </span>
              </div>

              {inv.status === 'sent' && (
                <p className="text-[11.5px] text-ink-4 mt-2 flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" /> لینک تا {new Date(inv.expiresAtISO).toLocaleDateString('fa-IR')} باز است.
                </p>
              )}
            </div>
          </Card>
        ))}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="انتخاب چالش" size="md">
        <div className="flex flex-col gap-3">
          {bankQ.data ? (
            <>
              <Select
                label="چالش"
                value={challengeId}
                onChange={(e) => setChallengeId(e.target.value)}
                options={bank.map((c) => ({ value: c.id, label: `${c.title} — ${CODE_DIFFICULTY_LABEL[c.difficulty]}` }))}
              />
              {bank
                .filter((c) => c.id === challengeId)
                .map((c) => (
                  <div key={c.id} className="rounded-control border border-line-2 bg-canvas p-3">
                    <p className="hv-latin text-[11.5px] text-ink-2" dir="ltr">
                      {c.signature}
                    </p>
                    <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
                      حدود {toPersianDigits(c.minutes)} دقیقه ، {toPersianDigits(c.testCount)} تست ({toPersianDigits(c.visibleCount)} نمونهٔ قابل‌مشاهده)
                    </p>
                    <p className="text-[11.5px] text-ink-3 mt-1.5 leading-relaxed">
                      <span className="font-semibold text-ink-2">چه چیزی را نشان می‌دهد: </span>
                      {c.rubric}
                    </p>
                  </div>
                ))}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  انصراف
                </Button>
                <Button loading={busyId === 'new'} disabled={!challengeId} onClick={() => void create()}>
                  ساخت دعوت
                </Button>
              </div>
            </>
          ) : (
            <Skeleton className="h-24" />
          )}
        </div>
      </Modal>

      <Modal open={Boolean(detail)} onClose={() => setDetail(null)} title="راهنمای خواندن نتیجه" size="md">
        {detail && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-2 leading-relaxed">
              <span className="font-bold">چه چیزی را نشان می‌دهد: </span>
              {detail.rubric}
            </p>
            <div>
              <p className="text-[12.5px] font-bold text-ink-2 mb-1.5">تست‌ها</p>
              <ul className="flex flex-wrap gap-1.5">
                {detail.tests.map((t, i) => (
                  <li
                    key={`${t.name}-${i}`}
                    className={`text-[11px] px-2 py-1 rounded-full border ${t.hidden ? 'border-line bg-na-soft text-na-ink' : 'border-line bg-canvas text-ink-2'}`}
                  >
                    {t.hidden ? 'پنهان' : t.name}
                  </li>
                ))}
              </ul>
            </div>
            <Callout tone="info">
              تعداد اجراهای آزمایشی ({toPersianDigits(detail.invite.runCount)}) نشانهٔ تلاش است، نه ضعف؛ آن را در تصمیم حساب نکنید.
            </Callout>
            <p className="text-[11.5px] text-ink-4 flex items-start gap-1.5">
              <ShieldQuestion className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              این نتیجه مرحلهٔ کارجو را تغییر نمی‌دهد. اگر تصمیمی گرفتید، همان‌جا در کارت تصمیم ثبتش کنید تا در تاریخچه بماند.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}

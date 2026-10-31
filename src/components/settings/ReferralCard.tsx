import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, Gift, Send, ShieldCheck, Users, Wallet } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, Select, Switch, TextArea, TextInput, toast } from '../ui';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { faDate, toPersianDigits } from '../../lib/format';
import type { ReferralProgramInput, ReferralRow, ReferralsPayload } from '../../types/referrals';

const TRIGGERS: { value: NonNullable<ReferralProgramInput['trigger']>; label: string; hint: string }[] = [
  { value: 'hire', label: 'وقتی استخدام شد', hint: 'کارجو پذیرفته و در ستون «استخدام‌شده» نشست.' },
  { value: 'offer', label: 'وقتی پیشنهاد شغلی فرستاده شد', hint: 'به‌محض رسیدن کارجو به مرحلهٔ پیشنهاد.' },
  { value: 'probation', label: 'پس از دورهٔ آزمایشی', hint: 'شما خودتان تأیید می‌کنید که فرد ماند.' },
];

function money(amount: number) {
  return `${toPersianDigits(amount.toLocaleString('en-US'))} تومان`;
}

const REWARD_LABEL: Record<ReferralRow['rewardStatus'], string> = {
  none: 'بدون پاداش',
  pending: 'در انتظار تأیید شما',
  approved: 'تأییدشده — آمادهٔ پرداخت',
  paid: 'پرداخت شد',
  void: 'لغو شد',
};

const OUTCOME_LABEL: Record<ReferralRow['outcome'], string> = {
  submitted: 'در حال بررسی',
  hired: 'استخدام شد',
  rejected: 'کنار گذاشته شد',
  closed: 'بسته شد',
};

/**
 * «معرفی همکار» — a colleague shares a link, the portal records who sent the
 * candidate, and the reward waits for a human: pending → approved → paid.
 * The machine never marks anything as paid.
 */
export function ReferralCard() {
  const canEdit = useCan('admin');
  const [data, setData] = useState<ReferralsPayload | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [amount, setAmount] = useState('0');
  const [trigger, setTrigger] = useState<NonNullable<ReferralProgramInput['trigger']>>('hire');
  const [terms, setTerms] = useState('');
  const [membersOnly, setMembersOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  useEffect(() => {
    api.referrals
      .get()
      .then((r) => {
        setData(r);
        setEnabled(r.program.enabled);
        setAmount(String(r.program.rewardAmount || 0));
        setTrigger(r.program.trigger);
        setTerms(r.program.terms || '');
        setMembersOnly(r.program.membersOnly);
      })
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const next = await api.referrals.saveProgram({
        enabled,
        rewardAmount: Number(amount.replace(/\D/g, '')) || 0,
        trigger,
        terms,
        membersOnly,
      });
      setData(next);
      toast('برنامهٔ معرفی همکار ذخیره شد.', 'success');
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, kind: 'approve' | 'pay' | 'confirm' | 'void') => {
    setRowBusy(id);
    try {
      const next =
        kind === 'approve'
          ? await api.referrals.approve(id)
          : kind === 'pay'
            ? await api.referrals.pay(id)
            : kind === 'confirm'
              ? await api.referrals.confirmProbation(id)
              : await api.referrals.voidReward(id, 'لغو توسط مدیر');
      setData(next);
      toast(
        kind === 'approve'
          ? 'پاداش تأیید شد؛ حالا می‌توانید پرداخت را ثبت کنید.'
          : kind === 'pay'
            ? 'پرداخت ثبت شد.'
            : kind === 'confirm'
              ? 'پاداش پس از دورهٔ آزمایشی در انتظار تأیید شماست.'
              : 'پاداش لغو شد.',
        'success'
      );
    } catch (e: any) {
      toast(e?.message || 'انجام نشد.', 'error');
    } finally {
      setRowBusy(null);
    }
  };

  const copy = (link: string) => {
    navigator.clipboard?.writeText(link).then(
      () => toast('لینک معرفی کپی شد.', 'success'),
      () => toast('کپی نشد؛ دستی انتخاب کنید.', 'error')
    );
  };

  const summary = data?.summary;

  return (
    <Card className="mt-5 max-w-[760px]">
      <CardHeader
        icon={Gift}
        title="معرفی همکار و پاداش"
        subtitle="هر همکار یک لینک اختصاصی دارد؛ کارجویی که با آن درخواست بدهد تا استخدام و پرداخت پاداش دنبال می‌شود."
        action={enabled ? <Chip tone="brand">روشن</Chip> : <Chip tone="neutral">خاموش</Chip>}
      />

      <div className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3">
          <Switch checked={enabled} onChange={setEnabled} label="برنامهٔ معرفی همکار فعال باشد" disabled={!canEdit || busy} />
          <Switch checked={membersOnly} onChange={setMembersOnly} label="فقط اعضای این فضای کاری" disabled={!canEdit || busy} />
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <TextInput
            label="مبلغ پاداش (تومان)"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))}
            disabled={!canEdit || busy}
            hint="صفر یعنی معرفی بدون پاداش نقدی — پیگیری و آمار همچنان کار می‌کند."
          />
          <Select
            label="پاداش چه زمانی بدهکار می‌شود؟"
            value={trigger}
            onChange={(e) => setTrigger(e.target.value as NonNullable<ReferralProgramInput['trigger']>)}
            disabled={!canEdit || busy}
            options={TRIGGERS.map((t) => ({ value: t.value, label: t.label }))}
            hint={TRIGGERS.find((t) => t.value === trigger)?.hint}
          />
        </div>

        <TextArea
          label="شرایط پاداش (اختیاری)"
          rows={3}
          value={terms}
          onChange={(e) => setTerms(e.target.value)}
          disabled={!canEdit || busy}
          hint="مثلاً: پاداش پس از گذراندن سه ماه و در فیش حقوقی همان ماه پرداخت می‌شود."
        />

        <Callout tone="info" icon={ShieldCheck}>
          هیچ پاداشی خودکار پرداخت نمی‌شود. زنجیره این است: کارجو استخدام می‌شود ← پاداش «در انتظار تأیید» ← شما تأیید می‌کنید ←
          با ثبت پرداخت (همان‌جا که پول واقعاً خارج شده) بسته می‌شود. کنار گذاشتن کارجو، پاداش در انتظار را خودکار لغو می‌کند.
          مبلغ پرداخت‌شده همان لحظه با نوع «پاداش معرفی» در گزارش هزینهٔ هر استخدام ثبت می‌شود.
        </Callout>

        {canEdit && (
          <div>
            <Button onClick={() => void save()} loading={busy} icon={CheckCircle2}>
              ذخیرهٔ برنامه
            </Button>
          </div>
        )}

        {summary && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'کل معرفی‌ها', value: toPersianDigits(summary.total) },
              { label: 'استخدام‌شده', value: toPersianDigits(summary.hired) },
              { label: 'در انتظار تأیید', value: money(summary.pendingAmount) },
              { label: 'پرداخت‌شده', value: money(summary.paidAmount) },
            ].map((s) => (
              <div key={s.label} className="rounded-[10px] border border-line-2 bg-canvas p-3">
                <p className="text-[11.5px] text-ink-3">{s.label}</p>
                <p className="text-[13px] font-bold text-ink mt-0.5 hv-num">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {data && data.items.length > 0 && (
          <div>
            <p className="text-[13px] font-bold text-ink mb-2">معرفی‌های ثبت‌شده</p>
            <div className="flex flex-col gap-2">
              {data.items.map((r) => (
                <div key={r.id} className="rounded-[10px] border border-line-2 bg-canvas p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-ink">{r.candidateName}</span>
                    <Chip tone="outline">{r.jobTitle}</Chip>
                    <Chip tone={r.outcome === 'hired' ? 'brand' : 'neutral'}>{OUTCOME_LABEL[r.outcome]}</Chip>
                    {r.rewardAmount > 0 && (
                      <Chip tone={r.rewardStatus === 'pending' ? 'warning' : 'neutral'}>
                        {REWARD_LABEL[r.rewardStatus]} · {money(r.rewardAmount)}
                      </Chip>
                    )}
                    <span className="text-[11.5px] text-ink-4">
                      معرف: {r.referrerName} — {faDate(r.submittedAtISO)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {r.rewardStatus === 'pending' && canEdit && (
                      <Button size="sm" variant="secondary" icon={CheckCircle2} loading={rowBusy === r.id} onClick={() => void act(r.id, 'approve')}>
                        تأیید پاداش
                      </Button>
                    )}
                    {r.rewardStatus === 'pending' && canEdit && (
                      <Button size="sm" variant="ghost" onClick={() => void act(r.id, 'void')} loading={rowBusy === r.id}>
                        لغو
                      </Button>
                    )}
                    {r.rewardStatus === 'approved' && canEdit && (
                      <Button size="sm" icon={Wallet} loading={rowBusy === r.id} onClick={() => void act(r.id, 'pay')}>
                        ثبت پرداخت
                      </Button>
                    )}
                    {r.rewardStatus === 'none' && r.outcome === 'hired' && data.program.trigger === 'probation' && canEdit && (
                      <Button size="sm" variant="secondary" loading={rowBusy === r.id} onClick={() => void act(r.id, 'confirm')}>
                        دورهٔ آزمایشی گذشت — پاداش بدهکار شد
                      </Button>
                    )}
                    {r.rewardStatus === 'paid' && r.paidAtISO && (
                      <span className="text-[11.5px] text-brand-strong inline-flex items-center gap-1">
                        <ShieldCheck className="w-3.5 h-3.5" /> پرداخت‌شده در {faDate(r.paidAtISO)} توسط {r.paidByName || '—'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {data && (
          <div>
            <p className="text-[13px] font-bold text-ink mb-1 flex items-center gap-1.5">
              <Users className="w-4 h-4 text-ink-3" /> لینک معرفی هر همکار
            </p>
            <p className="text-[12px] text-ink-3 mb-2">
              لینک را برای همکار بفرستید؛ هر درخواستی که با آن بیاید به نام همان فرد ثبت می‌شود.
            </p>
            <div className="flex flex-col gap-1.5">
              {data.members.map((m) => (
                <div key={m.userId} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line-2 bg-surface p-2.5">
                  <span className="text-[12.5px] font-semibold text-ink min-w-[120px]">{m.name}</span>
                  <code dir="ltr" className="text-[11.5px] text-ink-3 flex-1 break-all">
                    {m.link}
                  </code>
                  <span className="text-[11px] text-ink-4">
                    {toPersianDigits(m.total)} معرفی، {toPersianDigits(m.hired)} استخدام
                  </span>
                  <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(m.link)}>
                    کپی
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {!data && <p className="text-[12.5px] text-ink-3">در حال خواندن برنامهٔ معرفی…</p>}
      </div>
    </Card>
  );
}

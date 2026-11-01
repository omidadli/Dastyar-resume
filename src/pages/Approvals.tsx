import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Bot, CheckCircle2, Clock3, FileSignature, Gift, Inbox, ShieldCheck, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, Chip, ErrorState, Modal, Skeleton, Stat, TextArea, toast } from '../components/ui';
import { api } from '../lib/api';
import { emitChange } from '../lib/events';
import { Link } from '../lib/router';
import { toPersianDigits } from '../lib/format';
import { useTitle } from '../lib/useTitle';
import type { InboxItem, InboxKind, InboxView } from '../types/inbox';

const KIND_META: Record<InboxKind, { label: string; icon: typeof FileSignature; tone: 'brand' | 'warning' | 'neutral' }> = {
  offer: { label: 'پیشنهاد شغلی', icon: FileSignature, tone: 'brand' },
  automation: { label: 'اتوماسیون', icon: Bot, tone: 'warning' },
  referral: { label: 'پاداش معرفی', icon: Gift, tone: 'neutral' },
};

/**
 * «کارتابل تأیید» — the screen that makes «هیچ‌چیز بدون تأیید انسان نمی‌رود»
 * believable: every decision waiting on people, whose turn it is, and one button
 * where the decision sends nothing to the candidate.
 *
 * An automation proposal is deliberately *not* approved here: approving it sends
 * a letter, and a letter deserves the page that shows its wording.
 */
export default function Approvals() {
  useTitle('کارتابل تأیید');
  const [data, setData] = useState<InboxView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<{ item: InboxItem; kind: 'approved' | 'rejected' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    api.inbox
      .list()
      .then(setData)
      .catch((err: any) => setError(err?.message || 'خواندن کارتابل ممکن نشد.'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const decide = async () => {
    if (!decision) return;
    setBusy(true);
    try {
      if (decision.item.kind === 'offer') {
        const r = await api.inbox.decideOffer(decision.item.id.replace('offer:', ''), decision.kind, note.trim() || undefined);
        setData(r.inbox);
      } else if (decision.item.kind === 'referral') {
        const r = await api.inbox.approveReferral(decision.item.id.replace('referral:', ''), note.trim() || undefined);
        setData(r.inbox);
      }
      emitChange('activity');
      toast(
        decision.kind === 'approved'
          ? decision.item.kind === 'offer'
            ? 'تأیید ثبت شد.'
            : 'پاداش تأیید شد.'
          : 'رد شد؛ دلیلش در همان مرحله می‌ماند.',
        decision.kind === 'approved' ? 'success' : 'info'
      );
      setDecision(null);
      setNote('');
    } catch (err: any) {
      toast(err?.message || 'ثبت تصمیم ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const mine = data.items.filter((i) => i.mine);
    const others = data.items.filter((i) => !i.mine);
    return [
      { key: 'mine', title: 'منتظر شما', items: mine },
      { key: 'others', title: 'منتظر دیگران', items: others },
    ].filter((g) => g.items.length > 0);
  }, [data]);

  return (
    <div className="hv-page">
      <PageHeader
        title="کارتابل تأیید"
        subtitle="هر چیزی که پیش از رسیدن به کارجو، منتظر تصمیم یک انسان است."
        actions={
          <Button variant="secondary" icon={Clock3} onClick={load} loading={loading}>
            تازه‌سازی
          </Button>
        }
      />

      {error && <ErrorState message={error} onRetry={load} />}

      {loading && !data && <Skeleton className="h-[180px] rounded-[14px]" />}

      {data && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="منتظر شما" value={toPersianDigits(data.counts.mine)} icon={Users} />
            <Stat label="پیشنهاد شغلی" value={toPersianDigits(data.counts.offers)} icon={FileSignature} />
            <Stat label="اتوماسیون" value={toPersianDigits(data.counts.automation)} icon={Bot} />
            <Stat label="پاداش معرفی" value={toPersianDigits(data.counts.referrals)} icon={Gift} />
          </div>

          {data.items.length === 0 && (
            <Card>
              <div className="p-8 text-center flex flex-col items-center gap-2">
                <Inbox className="w-8 h-8 text-ink-4" />
                <p className="font-bold text-ink">هیچ تصمیمی منتظر شما نیست.</p>
                <p className="text-[12.5px] text-ink-3 leading-relaxed max-w-[520px]">
                  {data.enabled.offers || data.enabled.automation
                    ? 'وقتی پیشنهادی به تأیید برسد یا اتوماسیون پیشنهادی بسازد، همان‌جا این‌جا ظاهر می‌شود.'
                    : 'در این فضای کاری هنوز گردش تأیید پیشنهاد یا اتوماسیون روشن نشده است؛ از تنظیمات می‌توانید روشنش کنید.'}
                </p>
              </div>
            </Card>
          )}

          {groups.map((group) => (
            <Card key={group.key}>
              <CardHeader
                title={group.title}
                subtitle={`${toPersianDigits(group.items.length)} مورد`}
                action={
                  group.key === 'mine' ? (
                    <Chip tone="brand">نوبت شماست</Chip>
                  ) : (
                    <Chip tone="outline">بدون اقدام از سمت شما</Chip>
                  )
                }
              />
              <div className="divide-y divide-line-2">
                {group.items.map((item) => {
                  const meta = KIND_META[item.kind];
                  const Icon = meta.icon;
                  return (
                    <div key={item.id} className="px-4 py-3 flex flex-wrap items-start gap-3">
                      <span className="w-9 h-9 rounded-[10px] bg-canvas border border-line-2 flex items-center justify-center shrink-0">
                        <Icon className="w-[18px] h-[18px] text-ink-3" strokeWidth={1.8} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-[13px] font-bold text-ink">{item.title}</p>
                          <Chip tone={meta.tone}>{meta.label}</Chip>
                          {item.mine && <Chip tone="brand">نوبت شما</Chip>}
                        </div>
                        <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">{item.detail}</p>
                        <p className="text-[11.5px] text-ink-4 mt-1">
                          {item.candidateName}
                          {item.jobTitle ? ` — ${item.jobTitle}` : ''} · از {item.waitingSinceJalali} در انتظار «{item.waitingOn}»
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {item.href && (
                          <Link to={item.href} className="hv-btn hv-btn-ghost hv-btn-sm inline-flex items-center gap-1">
                            {item.kind === 'automation' ? 'دیدن پیش‌نویس' : 'پرونده'}
                            <ArrowLeft className="w-3.5 h-3.5" />
                          </Link>
                        )}
                        {item.canAct && item.kind !== 'automation' && (
                          <Button size="sm" icon={CheckCircle2} onClick={() => setDecision({ item, kind: 'approved' })}>
                            تأیید
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}

          <Callout tone="info" icon={ShieldCheck} title="چرا تأیید اتوماسیون این‌جا نیست؟">
            تأیید یک پیش‌نویس اتوماسیون یعنی <b>فرستادن نامه</b>. متن نامه باید پیش از تأیید روی صفحه باشد، پس آن تصمیم
            در «اتوماسیون جذب» گرفته می‌شود. تأیید پیشنهاد شغلی و پاداش این‌جا امن است، چون هیچ پیامی به کارجو نمی‌فرستد.
          </Callout>
        </div>
      )}

      <Modal
        open={Boolean(decision)}
        onClose={() => setDecision(null)}
        title={decision?.kind === 'approved' ? 'تأیید' : 'رد'}
        description={decision?.item.title}
        icon={<CheckCircle2 className="w-5 h-5 text-brand" />}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDecision(null)}>
              بستن
            </Button>
            <Button variant={decision?.kind === 'approved' ? 'primary' : 'danger'} loading={busy} onClick={() => void decide()}>
              {decision?.kind === 'approved' ? 'تأیید می‌کنم' : 'رد می‌کنم'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            {decision?.kind === 'approved'
              ? 'با این تصمیم، مرحلهٔ فعلی بسته می‌شود و به مرحلهٔ بعد می‌رود. هیچ پیامی به کارجو فرستاده نمی‌شود.'
              : 'رد کردن، پیشنهاد را می‌بندد و دلیلش در همان مرحله می‌ماند. کارجو چیزی دریافت نمی‌کند.'}
          </p>
          <TextArea
            label="یادداشت (اختیاری)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="مثلاً: در سقف بودجه است."
          />
        </div>
      </Modal>
    </div>
  );
}

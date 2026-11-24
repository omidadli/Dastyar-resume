/**
 * «نیازمندسنجی» tab on one opening.
 *
 * Three things are shown together, because they answer one question: *can this
 * opening be published, and who is paying for the seat?*
 *   • the requisition this opening spends (or an honest empty state);
 *   • the workspace's publishing rule, stated whether or not it blocks right now;
 *   • the refusal, worded by the server, when the rule does block.
 */
import React, { useState } from 'react';
import { AlertTriangle, ArrowUpRight, FileCheck2, Link2Off, ShieldCheck } from 'lucide-react';
import { Button, ButtonLink, Callout, Card, CardHeader, Chip, toast } from '../ui';
import { RequisitionPicker } from './RequisitionPicker';
import { api, ApiError } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import { navigate } from '../../lib/router';
import type { JobRequisitionPayload } from '../../types/requisition';
import { REQUISITION_STATUS_LABEL } from '../../types/requisition';

export function RequisitionPanel({
  jobId,
  departmentId,
  payload,
  onChange,
}: {
  jobId: string;
  departmentId: string;
  payload: JobRequisitionPayload | null | undefined;
  onChange: () => void;
}) {
  const current = payload?.requisition || null;
  const [picked, setPicked] = useState<string | null>(current?.id || null);
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const gate = payload?.gate;

  const save = async () => {
    setBusy('save');
    try {
      const r = await api.jobs.setRequisition(jobId, picked);
      const attached = r.requisition.requisition;
      toast(attached ? `آگهی به نیازمندسنجی «${attached.code}» وصل شد.` : 'نیازمندسنجی این آگهی برداشته شد.');
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'اتصال ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy('clear');
    try {
      await api.jobs.setRequisition(jobId, null);
      setPicked(null);
      toast('آگهی از نیازمندسنجی جدا شد.');
      onChange();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'جدا کردن ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {current ? (
        <Card>
          <CardHeader
            icon={FileCheck2}
            title="سرفصل نیروی این آگهی"
            subtitle={`از نیازمندسنجی «${current.title}» در دپارتمان ${current.departmentName}`}
            action={
              <Button
                variant="ghost"
                size="sm"
                icon={Link2Off}
                loading={busy === 'clear'}
                onClick={clear}
                title="این آگهی دیگر از این سرفصل استفاده نمی‌کند"
              >
                جدا کردن
              </Button>
            }
          />
          <div className="rounded-control border border-line-2 bg-canvas p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] font-bold text-ink hv-num">{current.code}</span>
              <Chip tone={current.remaining > 0 ? 'brand' : 'neutral'}>{REQUISITION_STATUS_LABEL[current.status]}</Chip>
              <span className="text-[12px] text-ink-3">
                {toPersianDigits(current.filled)} از {toPersianDigits(current.approvedSlots)} سرفصل پر‌شده، {toPersianDigits(current.remaining)} باز
              </span>
            </div>
            {current.decidedAtJalali && (
              <p className="text-[11.5px] text-ink-4 mt-1.5">
                تأیید: {current.decidedAtJalali} — {current.decidedByName}
              </p>
            )}
            <div className="mt-3">
              <ButtonLink to={`/app/requisitions/${current.id}`} variant="secondary" size="sm" icon={ArrowUpRight}>
                دیدن نیازمندسنجی
              </ButtonLink>
            </div>
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader
            icon={FileCheck2}
            title="این آگهی به هیچ سرفصلی وصل نیست"
            subtitle="آگهی مستقل است؛ پر‌شدنش از سرفصل هیچ نیازمندسنجی کم نمی‌شود و هیچ تأییدی هم پشتش نیست."
          />
          <p className="text-[12.5px] text-ink-3 leading-relaxed">
            اگر این نقش از سرفصل مصوب استفاده می‌کند، از کادر پایین به نیازمندسنجی وصلش کنید؛ از آن لحظه، پر‌شدن پست از همان سرفصل کم می‌شود.
          </p>
        </Card>
      )}

      <Card>
        <CardHeader
          icon={FileCheck2}
          title={current ? 'تغییر سرفصل' : 'وصل کردن به یک نیازمندسنجی'}
          subtitle="هر آگهی یک سرفصل مصرف می‌کند؛ یک سرفصل می‌تواند چند آگهی داشته باشد و با پر شدن پست‌هایش بسته می‌شود."
        />
        <RequisitionPicker departmentId={departmentId} currentJobId={jobId} value={picked} onChange={setPicked} />
        <div className="flex flex-wrap items-center gap-2 mt-4">
          <Button
            variant="primary"
            loading={busy === 'save'}
            onClick={save}
            disabled={picked === (current?.id || null)}
          >
            {current ? 'ثبت تغییر' : 'وصل کردن'}
          </Button>
          <Button variant="ghost" onClick={() => navigate('/app/requisitions')}>
            فهرست نیازمندسنجی‌ها
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader icon={ShieldCheck} title="قاعدهٔ انتشار در این فضای کاری" subtitle="از تنظیمات › نیازمندسنجی" />
        {gate?.required ? (
          <>
            <p className="text-[12.5px] text-ink-2 leading-relaxed">
              انتشار در پورتال شغلی <strong>فقط با یک نیازمندسنجی تأییدشده که سرفصل باز دارد</strong> ممکن است.
            </p>
            {gate.blocked ? (
              <Callout tone="warning" icon={AlertTriangle} className="mt-3">
                {gate.blocked.message}
              </Callout>
            ) : (
              <Callout tone="info" className="mt-3">
                این آگهی شرط را دارد؛ انتشار ممکن است.
              </Callout>
            )}
          </>
        ) : (
          <p className="text-[12.5px] text-ink-2 leading-relaxed">
            این فضا سخت‌گیری نمی‌کند: آگهی بدون نیازمندسنجی هم منتشر می‌شود. اگر می‌خواهید انتشار را به سرفصل تأییدشده گره بزنید، در تنظیمات
            نیازمندسنجی روشنش کنید.
          </p>
        )}
      </Card>
    </div>
  );
}

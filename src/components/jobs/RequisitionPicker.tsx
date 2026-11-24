/**
 * «نیازمندسنجی» on the job side.
 *
 * The rule this component exists to keep: an opening spends headcount, so the
 * picker never hides a requisition that cannot be used — it shows every one for
 * the department and prints, next to the unusable ones, the same sentence the
 * server would refuse with. Nothing is grey without a reason.
 */
import React, { useEffect, useState } from 'react';
import { FileCheck2, Info } from 'lucide-react';
import { ButtonLink, Callout, Chip, Skeleton } from '../ui';
import { api, ApiError } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import type { RequisitionOption, RequisitionSummaryRow } from '../../types/requisition';
import { REQUISITION_STATUS_LABEL } from '../../types/requisition';

function toOption(row: RequisitionSummaryRow, currentJobId: string | null): RequisitionOption {
  const granted = row.approvedSlots ?? row.slots;
  // Several openings may spend one requisition (a pool of seats); an existing
  // opening is shown as context, and only a closed/filled requisition refuses.
  const holder = row.jobTitles.length ? row.jobTitles[0] : null;
  const reason = !row.openForHiring
    ? row.status === 'filled'
      ? 'همهٔ پست‌های این نیازمندسنجی پر شده است.'
      : `وضعیت «${REQUISITION_STATUS_LABEL[row.status]}» سرفصل باز ندارد.`
    : null;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    status: row.status,
    approvedSlots: granted,
    filled: row.filled,
    remaining: row.remaining,
    selectable: !reason,
    reason,
    jobTitle: holder,
  };
}

export function RequisitionPicker({
  departmentId,
  value,
  onChange,
  disabled = false,
  currentJobId = null,
  onOptions,
}: {
  departmentId: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  currentJobId?: string | null;
  onOptions?: (options: RequisitionOption[]) => void;
}) {
  const [rows, setRows] = useState<RequisitionOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!departmentId) {
      setRows([]);
      return;
    }
    setRows(null);
    setError(null);
    api.requisitions
      .list({ departmentId })
      .then((r) => {
        if (!alive) return;
        const options = r.items.map((row) => toOption(row, currentJobId));
        setRows(options);
        onOptions?.(options);
      })
      .catch((e) => {
        if (!alive) return;
        setRows([]);
        setError(e instanceof ApiError ? e.message : 'نیازمندسنجی‌ها خوانده نشد.');
      });
    return () => {
      alive = false;
    };
    // onOptions is a render-time callback; the fetch depends only on the department.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentId, currentJobId]);

  if (!departmentId) {
    return <p className="text-[12.5px] text-ink-3">اول دپارتمان را انتخاب کنید؛ سرفصل نیرو به دپارتمان گره خورده است.</p>;
  }
  if (rows === null) return <Skeleton className="h-24 rounded-[12px]" />;

  const selectable = rows.filter((r) => r.selectable && r.id !== value);
  const rest = rows.filter((r) => !r.selectable);

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-[12px] text-low-ink">{error}</p>}
      {rows.length === 0 && !error && (
        <Callout tone="info" icon={Info}>
          برای این دپارتمان نیازمندسنجی‌ای ثبت نشده است. می‌توانید آگهی را بدون آن بسازید و بعداً وصل کنید، یا اول سرفصل نیرو را تعریف کنید.
          <div className="mt-2">
            <ButtonLink to="/app/requisitions" variant="secondary" size="sm" icon={FileCheck2}>
              رفتن به نیازمندسنجی
            </ButtonLink>
          </div>
        </Callout>
      )}

      {rows.length > 0 && (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="نیازمندسنجی">
          <label
            className={`flex items-start gap-2.5 p-3 rounded-[12px] border cursor-pointer ${
              !value ? 'border-brand/50 bg-brand-tint' : 'border-line bg-surface hover:border-line-strong'
            }`}
          >
            <input
              type="radio"
              className="mt-1 accent-[var(--hv-brand,#4F46E5)]"
              checked={!value}
              disabled={disabled}
              onChange={() => onChange(null)}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold text-ink">بدون نیازمندسنجی</span>
              <span className="block text-[11.5px] text-ink-3 mt-0.5">آگهی مستقل؛ سرفصلی از آن کم نمی‌شود.</span>
            </span>
          </label>

          {[...selectable, ...rest].map((o) => {
            const active = o.id === value;
            return (
              <label
                key={o.id}
                className={`flex items-start gap-2.5 p-3 rounded-[12px] border ${
                  active
                    ? 'border-brand/50 bg-brand-tint'
                    : o.selectable
                      ? 'border-line bg-surface hover:border-line-strong cursor-pointer'
                      : 'border-line-2 bg-canvas cursor-not-allowed opacity-80'
                }`}
              >
                <input
                  type="radio"
                  className="mt-1 accent-[var(--hv-brand,#4F46E5)]"
                  checked={active}
                  disabled={disabled || (!o.selectable && !active)}
                  onChange={() => o.selectable && onChange(o.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[12px] font-bold text-ink hv-num">{o.code}</span>
                    <span className="text-[13px] font-semibold text-ink">{o.title}</span>
                    <Chip tone={o.selectable ? 'brand' : 'neutral'}>{REQUISITION_STATUS_LABEL[o.status]}</Chip>
                  </span>
                  <span className="block text-[11.5px] text-ink-3 mt-0.5">
                    {toPersianDigits(o.remaining)} از {toPersianDigits(o.approvedSlots)} سرفصل باز
                    {o.filled > 0 ? ` (${toPersianDigits(o.filled)} پر‌شده)` : ''}
                  </span>
                  {o.jobTitle && !o.reason && (
                    <span className="block text-[11.5px] text-ink-4 mt-0.5">آگهی وصل‌شده: {o.jobTitle}</span>
                  )}
                  {o.reason && <span className="block text-[11.5px] text-warning-ink mt-1">{o.reason}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {rows.length > 0 && !selectable.length && !value && (
        <p className="text-[11.5px] text-ink-3">
          هیچ‌کدام از این نیازمندسنجی‌ها سرفصل باز ندارد؛ می‌توانید آگهی را بسازید و بعد از تأیید، به آن وصل کنید.
        </p>
      )}
    </div>
  );
}

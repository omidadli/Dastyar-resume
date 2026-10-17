import React, { useState } from 'react';
import { BrainCircuit, RefreshCw, ScrollText } from 'lucide-react';
import { Button, EmptyState, ErrorState, SearchInput, Segmented, Skeleton, Tabs } from '../../components/ui';
import { adminApi } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { faNumber } from '../../lib/format';
import { AdminHeader, AUDIT_LABEL, PURPOSE_LABEL, faAgo, faDateTime, useDebounced } from './shared';

type Tab = 'audit' | 'ai';

export default function Logs() {
  const [tab, setTab] = useState<Tab>('audit');
  return (
    <div>
      <AdminHeader title="گزارش رویدادها" subtitle="هر تغییری که مدیران سامانه انجام داده‌اند و هر درخواستی که به سرویس‌های هوش مصنوعی رفته است (با جابه‌جایی‌های خودکار کلید)." />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        className="mb-5"
        items={[
          { id: 'audit', label: 'رویدادهای مدیریتی', icon: ScrollText },
          { id: 'ai', label: 'درخواست‌های هوش مصنوعی', icon: BrainCircuit },
        ]}
      />
      {tab === 'audit' ? <AuditLog /> : <AiCalls />}
    </div>
  );
}

function AuditLog() {
  const [q, setQ] = useState('');
  const query = useDebounced(q);
  const { data, error, loading, reload } = useAsync(() => adminApi.audit({ q: query, limit: 500 }), [query]);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SearchInput value={q} onChange={setQ} placeholder="جست‌وجو در رویدادها…" className="w-full sm:w-[320px]" />
        <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reload} loading={loading}>
          به‌روزرسانی
        </Button>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton className="h-[300px] rounded-card" />
      ) : !data.items.length ? (
        <EmptyState icon={ScrollText} title="رویدادی ثبت نشده است" description="هر تغییری در پنل مدیریت اینجا با نام انجام‌دهنده ثبت می‌شود." />
      ) : (
        <div className="hv-card divide-y divide-line-2">
          {data.items.map((a) => (
            <div key={a.id} className="px-4 py-3 flex flex-wrap items-start gap-x-4 gap-y-1">
              <span className="text-[12px] text-ink-3 w-[150px] shrink-0" title={a.atISO}>
                {faDateTime(a.atISO)}
              </span>
              <div className="flex-1 min-w-[240px]">
                <p className="text-[13px] text-ink">
                  <b>{AUDIT_LABEL[a.action] || a.action}</b> · <span className="text-ink-2">{a.target}</span>
                </p>
                {a.detail && <p className="text-[12px] text-ink-3 mt-0.5 break-words">{a.detail}</p>}
              </div>
              <span className="text-[12px] text-ink-3">{a.actorName}</span>
              {a.ip && (
                <span className="text-[11px] text-ink-4 hv-latin" dir="ltr">
                  {a.ip}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AiCalls() {
  const [filter, setFilter] = useState<'all' | 'failed' | 'switched'>('all');
  const { data, error, loading, reload } = useAsync(() => adminApi.calls(400), []);
  const items = (data?.items || []).filter((c) => (filter === 'failed' ? !c.ok : filter === 'switched' ? Boolean(c.switchedFrom) : true));
  const total = data?.items.length || 0;
  const ok = (data?.items || []).filter((c) => c.ok).length;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Segmented
          value={filter}
          onChange={setFilter}
          size="sm"
          items={[
            { id: 'all', label: 'همه', count: total },
            { id: 'failed', label: 'خطاها', count: total - ok },
            { id: 'switched', label: 'جابه‌جایی کلید', count: (data?.items || []).filter((c) => c.switchedFrom).length },
          ]}
        />
        <Button size="sm" variant="secondary" icon={RefreshCw} onClick={reload} loading={loading}>
          به‌روزرسانی
        </Button>
        <span className="text-[12px] text-ink-3">آخرین ۴۰۰ درخواست از زمان آغاز به کار سرور (در حافظه).</span>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Skeleton className="h-[300px] rounded-card" />
      ) : !items.length ? (
        <EmptyState icon={BrainCircuit} title="درخواستی نیست" description="با تحلیل اولین رزومه، درخواست‌ها اینجا دیده می‌شوند." />
      ) : (
        <div className="hv-card overflow-hidden">
          <div className="overflow-x-auto hv-scroll">
            <table className="w-full text-[12.5px] min-w-[760px]">
              <thead className="bg-line-2/60 text-ink-3 text-[12px]">
                <tr>
                  <th className="text-right font-semibold px-4 py-2.5">زمان</th>
                  <th className="text-right font-semibold px-3 py-2.5">کار</th>
                  <th className="text-right font-semibold px-3 py-2.5">کلید</th>
                  <th className="text-right font-semibold px-3 py-2.5">مدل</th>
                  <th className="text-center font-semibold px-3 py-2.5">پیوست</th>
                  <th className="text-center font-semibold px-3 py-2.5">زمان پاسخ</th>
                  <th className="text-right font-semibold px-3 py-2.5">نتیجه</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-2">
                {items.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-4 py-2.5 text-ink-3 whitespace-nowrap">{faAgo(c.at)}</td>
                    <td className="px-3 py-2.5 font-semibold text-ink-2">{PURPOSE_LABEL[c.purpose]}</td>
                    <td className="px-3 py-2.5 text-ink-2">
                      {c.switchedFrom && <span className="text-ink-4">{c.switchedFrom} ← </span>}
                      {c.keyLabel}
                    </td>
                    <td className="px-3 py-2.5 hv-latin text-ink-3">{c.model}</td>
                    <td className="px-3 py-2.5 text-center hv-num">{c.attachments ? faNumber(c.attachments) : '—'}</td>
                    <td className="px-3 py-2.5 text-center hv-num whitespace-nowrap">{faNumber(c.latencyMs)} میلی‌ثانیه</td>
                    <td className="px-3 py-2.5">
                      {c.ok ? <span className="text-high-ink font-semibold">موفق</span> : <span className="text-low-ink">{c.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

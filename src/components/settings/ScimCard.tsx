import React, { useState } from 'react';
import { AlertTriangle, Copy, KeyRound, RefreshCw, Users2 } from 'lucide-react';
import type { ScimStatus } from '../../types/developer';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { copyText } from '../../lib/clipboard';
import { Callout, Card, CardHeader, Chip, ConfirmDialog, IconButton, Modal, toast } from '../ui';

/**
 * «SCIM 2.0» — the card that turns «هویدا» into something an IT department can
 * provision. It shows the exact endpoint to paste into Okta/Entra, issues one
 * token per workspace (shown once), and says plainly what the token can and
 * cannot do.
 */
export function ScimCard({ scim }: { scim: ScimStatus }) {
  const can = useCan('admin');
  const [status, setStatus] = useState<ScimStatus>(scim);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const copy = async (value: string) => {
    const ok = await copyText(value);
    toast(ok ? 'کپی شد.' : 'کپی ممکن نشد؛ متن را دستی انتخاب کنید.', ok ? 'success' : 'error');
  };

  const issue = async () => {
    setBusy(true);
    try {
      const res = await api.developer.issueScimToken();
      setStatus(res.scim);
      setToken(res.token);
    } catch (err: any) {
      toast(err?.message || 'صدور توکن ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      const res = await api.developer.revokeScimToken();
      setStatus(res.scim);
      setConfirmRevoke(false);
      toast('توکن SCIM باطل شد؛ همگام‌سازی اعضا متوقف می‌شود.', 'info');
    } catch (err: any) {
      toast(err?.message || 'باطل‌کردن ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Users2}
        title="همگام‌سازی اعضا با SCIM"
        subtitle="Okta، Microsoft Entra ID یا Google Workspace"
        action={status.configured ? <Chip tone="brand">توکن فعال</Chip> : <Chip tone="neutral">بدون توکن</Chip>}
      />
      <div className="space-y-3">
        <div>
          <p className="text-[12.5px] font-semibold text-ink-2 mb-1.5">نشانی SCIM (در سامانهٔ هویت وارد کنید)</p>
          <div className="flex items-center gap-2">
            <code dir="ltr" className="flex-1 rounded-[10px] bg-canvas border border-line-2 px-3 py-2 text-[12.5px] font-mono truncate">
              {status.baseUrl}
            </code>
            <IconButton icon={Copy} label="کپی نشانی" onClick={() => void copy(status.baseUrl)} className="border border-line" />
          </div>
        </div>

        {status.configured ? (
          <>
            <div className="rounded-[12px] border border-line-2 px-3.5 py-3 text-[12.5px] text-ink-2 space-y-1">
              <p>
                توکن صادرشده با شناسهٔ <span dir="ltr" className="font-mono">{status.tokenId}</span> در{' '}
                {status.createdAtISO ? new Date(status.createdAtISO).toLocaleDateString('fa-IR') : '—'} توسط {status.createdByName} ساخته شده است.
              </p>
              <p>آخرین فراخوانی سامانهٔ هویت: {status.lastUsedISO ? new Date(status.lastUsedISO).toLocaleString('fa-IR') : 'هنوز هیچ درخواستی نیامده'}</p>
              <p>
                {status.canManageAdmins
                  ? 'این توکن را مالک فضای کاری صادر کرده و می‌تواند نقش «مدیر» هم بدهد.'
                  : 'این توکن نمی‌تواند کسی را «مدیر» کند؛ فقط عضو می‌سازد و غیرفعال می‌کند.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <IconButton icon={RefreshCw} label="صدور توکن تازه" onClick={() => void issue()} className="border border-line" />
              <button type="button" onClick={() => void issue()} disabled={busy || !can} className="text-[12.5px] text-brand-strong hover:underline disabled:opacity-50">
                صدور توکن تازه (توکن قبلی باطل می‌شود)
              </button>
              <button type="button" onClick={() => setConfirmRevoke(true)} disabled={busy || !can} className="text-[12.5px] text-low-ink hover:underline disabled:opacity-50 ms-auto">
                باطل‌کردن توکن
              </button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void issue()}
              disabled={busy || !can}
              className="inline-flex items-center gap-1.5 rounded-[10px] bg-brand-strong text-white px-3 py-2 text-[12.5px] font-semibold disabled:opacity-50"
            >
              <KeyRound className="w-4 h-4" /> صدور توکن SCIM
            </button>
            {!can && <span className="text-[12px] text-ink-3">فقط مدیر فضای کاری می‌تواند توکن صادر کند.</span>}
          </div>
        )}

        <Callout tone="info" icon={AlertTriangle}>
          این توکن فقط دو کار می‌کند: ساخت عضو و فعال/غیرفعال‌کردن او (و تغییر نام، عنوان و نقش). حذف کاربر در SCIM در هویدا
          «غیرفعال‌سازی» است، نه پاک‌کردن؛ سابقهٔ استخدام و فعالیت‌ها می‌ماند. توکن نمی‌تواند مالک بسازد و رمز کسی را نمی‌بیند.
          کاربری که از SCIM می‌آید با رمز تصادفی ساخته می‌شود؛ ورودش یا از راه SSO است یا مدیر باید از «تیم» برایش رمز تعیین کند.
        </Callout>
      </div>

      <Modal
        open={Boolean(token)}
        onClose={() => setToken(null)}
        title="توکن SCIM ساخته شد"
        description="این مقدار فقط یک بار نمایش داده می‌شود. آن را در بخش Provisioning سامانهٔ هویت وارد کنید."
        icon={<KeyRound className="w-5 h-5 text-brand-strong" />}
        footer={
          <button type="button" onClick={() => setToken(null)} className="rounded-[10px] bg-brand-strong text-white px-4 py-2 text-[13px] font-semibold">
            متوجه شدم
          </button>
        }
      >
        <div className="space-y-3">
          <code dir="ltr" className="block rounded-[10px] bg-canvas border border-line-2 px-3 py-2.5 text-[12.5px] font-mono break-all">
            {token}
          </code>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => token && void copy(token)}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-line px-3 py-2 text-[12.5px]"
            >
              <Copy className="w-4 h-4" /> کپی توکن
            </button>
            <span className="text-[12px] text-ink-3">این توکن توسط هویدا ذخیره نمی‌شود (فقط هش آن).</span>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={() => void revoke()}
        title="باطل‌کردن توکن SCIM؟"
        description="از این پس سامانهٔ هویت نمی‌تواند اعضا را همگام کند و درخواست‌های SCIM پاسخ 401 می‌گیرند. عضویت‌های فعلی دست‌نخورده می‌مانند."
        confirmLabel="باطل کن"
      />
    </Card>
  );
}

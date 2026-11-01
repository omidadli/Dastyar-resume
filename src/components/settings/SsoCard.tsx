import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Lock, ShieldCheck, Trash2, Workflow } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, Select, Switch, TextInput, toast } from '../ui';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { copyText } from '../../lib/clipboard';
import { faRelative } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { SsoCheck } from '../../types/sso';

const PRESETS = [
  { id: 'google', label: 'Google Workspace', issuer: 'https://accounts.google.com', hint: 'در Google Cloud یک OAuth Client از نوع Web بسازید و Redirect URI را همان مقدار پایین بگذارید.' },
  { id: 'microsoft', label: 'Microsoft Entra ID (Azure AD)', issuer: 'https://login.microsoftonline.com/organizations/v2.0', hint: 'در Entra ID یک App registration بسازید؛ نوع حساب را «فقط این سازمان» بگذارید.' },
  { id: 'okta', label: 'Okta', issuer: '', hint: 'نشانی Issuer را از Applications › Sign On › OpenID Connect بردارید.' },
  { id: 'keycloak', label: 'Keycloak (خودمیزبان)', issuer: '', hint: 'نشانی: https://keycloak.example.ir/realms/<realm>' },
  { id: 'custom', label: 'سایر (استاندارد OIDC)', issuer: '', hint: 'هر ارائه‌دهنده‌ای که سند /.well-known/openid-configuration منتشر می‌کند.' },
];

/**
 * «ورود سازمانی (SSO)» — one provider per workspace, OIDC authorization code
 * with PKCE. The card states plainly that the client secret is stored encrypted
 * and that nothing is saved until the provider answers.
 */
export function SsoCard() {
  const canEdit = useCan('admin');
  const status = useAsync(() => api.sso.status(), []);
  const current = status.data?.sso;

  const [preset, setPreset] = useState('google');
  const [issuer, setIssuer] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [domains, setDomains] = useState('');
  const [autoJoin, setAutoJoin] = useState(true);
  const [defaultRole, setDefaultRole] = useState<'member' | 'admin'>('member');
  const [requireSso, setRequireSso] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<SsoCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  // Seed once: a refresh must not overwrite what the admin is typing.
  useEffect(() => {
    if (!current) return;
    setIssuer(current.issuer || '');
    setClientId(current.clientId || '');
    setDomains(current.domains.join('، '));
    setAutoJoin(current.autoJoin);
    setDefaultRole(current.defaultRole);
    setRequireSso(current.requireSso);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.issuer, current?.clientId, current?.updatedAtISO]);

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPreset(id);
    if (p.issuer) setIssuer(p.issuer);
  };

  const runCheck = async () => {
    setError(null);
    setCheck(null);
    if (!issuer.trim()) return setError('اول نشانی سرویس ورود سازمانی را وارد کنید.');
    setChecking(true);
    try {
      setCheck(await api.sso.check(issuer.trim()));
    } catch (e: any) {
      setCheck({ ok: false, issuer: null, message: e?.message || 'بررسی ناموفق بود.' });
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    setError(null);
    const list = domains.split(/[،,\s]+/).map((d) => d.trim()).filter(Boolean);
    if (!list.length) return setError('دست‌کم یک دامنهٔ ایمیل مجاز بنویسید (مثلاً company.ir).');
    setBusy(true);
    try {
      await api.sso.save({
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        domains: list,
        autoJoin,
        defaultRole,
        requireSso,
      });
      setClientSecret('');
      toast('ورود سازمانی ذخیره شد.');
      status.reload();
    } catch (e: any) {
      setError(e?.message || 'ذخیره ممکن نشد.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.sso.remove();
      setConfirmOff(false);
      setClientId('');
      setClientSecret('');
      setIssuer('');
      setDomains('');
      setRequireSso(false);
      toast('ورود سازمانی قطع شد.');
      status.reload();
    } catch (e: any) {
      toast(e?.message || 'قطع اتصال ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const hint = PRESETS.find((p) => p.id === preset)?.hint || '';

  return (
    <Card>
      <CardHeader
        icon={Workflow}
        title="ورود سازمانی (SSO)"
        subtitle="اعضای تیم با حساب Google Workspace یا Microsoft سازمان وارد شوند"
        action={
          current?.enabled ? (
            <Chip tone="brand">متصل</Chip>
          ) : (
            <Chip tone="neutral">تنظیم نشده</Chip>
          )
        }
      />

      {!canEdit && (
        <Callout tone="info" icon={Lock} className="mb-4">
          فقط مدیر یا مالک فضای کاری می‌تواند ورود سازمانی را تنظیم کند.
        </Callout>
      )}

      {current?.enabled && (
        <div className="rounded-[12px] bg-canvas border border-line-2 px-3.5 py-3 mb-4 text-[12.5px] text-ink-2 leading-relaxed">
          <p className="flex items-center gap-1.5 font-semibold text-ink">
            <CheckCircle2 className="w-4 h-4 text-brand-strong" />
            {current.issuer}
          </p>
          <p className="mt-1">
            دامنه‌های مجاز: <span dir="ltr" className="font-mono">{current.domains.join('، ')}</span>
            {current.requireSso ? ' — ورود با رمز برای این دامنه‌ها بسته است.' : ''}
          </p>
          <p className="mt-1 text-ink-3">
            {current.lastLoginAtISO ? `آخرین ورود سازمانی: ${faRelative(current.lastLoginAtISO)}` : 'هنوز کسی با این روش وارد نشده است.'}
          </p>
          {current.lastError && <p className="mt-1 text-low-ink">آخرین خطا: {current.lastError}</p>}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Select
          label="ارائه‌دهنده"
          value={preset}
          onChange={(e) => applyPreset(e.target.value)}
          options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          hint={hint}
          wrapperClassName="sm:col-span-2"
        />
        <TextInput
          label="نشانی سرویس ورود (Issuer)"
          latin
          placeholder="https://accounts.google.com"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
          wrapperClassName="sm:col-span-2"
          hint="همان نشانی‌ای که سند /.well-known/openid-configuration زیر آن منتشر شده است."
        />
        <TextInput label="Client ID" latin value={clientId} onChange={(e) => setClientId(e.target.value)} />
        <TextInput
          label="Client Secret"
          type="password"
          latin
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          hint={current?.clientSecretSet ? 'ذخیره شده است؛ برای تغییر مقدار تازه بگذارید.' : 'رمزنگاری‌شده ذخیره می‌شود و به مرورگر برنمی‌گردد.'}
        />
        <TextInput
          label="دامنه‌های ایمیل مجاز"
          latin
          placeholder="company.ir, company.com"
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
          wrapperClassName="sm:col-span-2"
          hint="فقط ایمیل‌های همین دامنه‌ها از این مسیر وارد می‌شوند. با «،» یا فاصله جدا کنید."
        />
        <Select
          label="نقش عضو تازه"
          value={defaultRole}
          onChange={(e) => setDefaultRole(e.target.value as 'member' | 'admin')}
          options={[
            { value: 'member', label: 'عضو تیم' },
            { value: 'admin', label: 'مدیر' },
          ]}
          hint="مالک همیشه دستی تعیین می‌شود."
        />
        <div className="flex flex-col gap-4 justify-center sm:col-span-2 sm:flex-row sm:items-start sm:gap-8">
          <Switch
            checked={autoJoin}
            onChange={setAutoJoin}
            label="ورود خودکار اعضای تازه"
            description="اگر خاموش باشد، فقط افراد دعوت‌شده وارد می‌شوند."
          />
          <Switch
            checked={requireSso}
            onChange={setRequireSso}
            label="فقط ورود سازمانی"
            description="برای دامنه‌های بالا، رمز عبور پذیرفته نمی‌شود."
          />
        </div>
      </div>

      {current && (
        <div className="mt-4 rounded-[10px] bg-canvas border border-line-2 px-3 py-2.5">
          <p className="text-[11.5px] text-ink-3">Redirect URI که باید در پنل ارائه‌دهنده ثبت شود</p>
          <div className="flex items-center gap-2 mt-1">
            <code dir="ltr" className="text-[11.5px] font-mono text-ink flex-1 truncate">{current.redirectUri}</code>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => copyText(current.redirectUri).then((ok) => toast(ok ? 'کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error'))}
            >
              کپی
            </Button>
          </div>
        </div>
      )}

      {check && (
        <Callout tone={check.ok ? 'brand' : 'danger'} icon={check.ok ? CheckCircle2 : ShieldCheck} className="mt-4" title={check.ok ? 'سرویس ورود پاسخ داد' : 'سرویس ورود پاسخ نداد'}>
          {check.message}
          {check.ok && check.tokenEndpoint && (
            <span dir="ltr" className="block font-mono text-[11.5px] mt-1 text-ink-3 truncate">
              {check.tokenEndpoint}
            </span>
          )}
        </Callout>
      )}

      {error && (
        <p className="text-[12.5px] text-low-ink font-medium mt-3" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button variant="secondary" onClick={runCheck} loading={checking} disabled={!canEdit} icon={ShieldCheck}>
          بررسی اتصال
        </Button>
        <Button onClick={save} loading={busy} disabled={!canEdit} icon={KeyRound}>
          ذخیره
        </Button>
        {current?.enabled && (
          <Button variant="ghost" icon={Trash2} disabled={!canEdit || busy} onClick={() => setConfirmOff(true)}>
            قطع اتصال
          </Button>
        )}
      </div>

      <Callout tone="info" icon={ShieldCheck} className="mt-4">
        ورود سازمانی با استاندارد OIDC کار می‌کند: امضای پاسخ ارائه‌دهنده با کلید عمومی خودش بررسی می‌شود، ایمیل باید تأییدشده
        باشد و دامنه در فهرست بالا، وگرنه ورود رد می‌شود. هر ورود در فعالیت‌های تیم ثبت می‌شود. اگر ارائه‌دهنده در دسترس نباشد،
        ورود با رمز عبور دست‌نخورده می‌ماند (مگر آن‌که «فقط ورود سازمانی» را روشن کنید).{' '}
        <a href="/docs/SSO.md" target="_blank" rel="noreferrer" className="font-semibold text-brand-ink hover:underline inline-flex items-center gap-1">
          راهنمای اتصال <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </Callout>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={remove}
        loading={busy}
        title="ورود سازمانی قطع شود؟"
        description="تنظیمات و رمز محرمانه پاک می‌شوند و اعضا فقط با رمز عبور وارد می‌شوند. حساب‌هایی که با SSO ساخته شده‌اند باقی می‌مانند، اما رمزی برای ورود ندارند؛ برای آن‌ها باید رمز تازه تعیین کنید."
        confirmLabel="قطع اتصال"
      />
    </Card>
  );
}

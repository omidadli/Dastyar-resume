import React, { useCallback, useEffect, useState } from 'react';
import {
  ArchiveRestore,
  ArrowRight,
  BrainCircuit,
  Building2,
  Gauge,
  KeyRound,
  LogOut,
  Menu as MenuIcon,
  ScrollText,
  Settings2,
  ShieldCheck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { HovidaLogo, HovidaMark } from '../../components/brand/Logo';
import { Button, ButtonLink, Callout, Spinner, TextInput, trapTabKey, useEscapeLayer, useLockScroll, useRestoreFocus } from '../../components/ui';
import { adminApi, api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Link, navigate } from '../../lib/router';
import { useMediaQuery } from '../../lib/useAsync';
import { useTitle } from '../../lib/useTitle';
import type { AdminMe } from '../../types/admin';
import Overview from './Overview';
import Orgs from './Orgs';
import UsersPage from './Users';
import AiKeys from './AiKeys';
import Behavior from './Behavior';
import SystemPage from './System';
import Logs from './Logs';
import BackupPage from './Backup';
import { SkipToMain } from '../../components/layout/SkipToMain';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

const NAV: NavItem[] = [
  { to: '/admin', label: 'نمای کلی', icon: Gauge, render: () => <Overview /> },
  { to: '/admin/orgs', label: 'فضاهای کاری', icon: Building2, render: () => <Orgs /> },
  { to: '/admin/users', label: 'کاربران', icon: Users, render: () => <UsersPage /> },
  { to: '/admin/ai', label: 'کلیدهای هوش مصنوعی', icon: KeyRound, render: () => <AiKeys /> },
  { to: '/admin/behavior', label: 'رفتار هوش مصنوعی', icon: BrainCircuit, render: () => <Behavior /> },
  { to: '/admin/system', label: 'تنظیمات سامانه', icon: Settings2, render: () => <SystemPage /> },
  { to: '/admin/backup', label: 'پشتیبان‌گیری و انتقال', icon: ArchiveRestore, render: () => <BackupPage /> },
  { to: '/admin/logs', label: 'گزارش رویدادها', icon: ScrollText, render: () => <Logs /> },
];

function sectionFor(pathname: string): NavItem {
  const clean = pathname.replace(/\/+$/, '') || '/admin';
  return NAV.find((n) => n.to === clean) || NAV.find((n) => n.to !== '/admin' && clean.startsWith(n.to)) || NAV[0];
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div dir="rtl" className="min-h-screen bg-[#F4F6F4] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-[420px]">
        <div className="flex items-center gap-2.5 mb-6 justify-center">
          <HovidaLogo height={30} />
          <span className="h-6 px-2.5 rounded-full bg-[#252C28] text-white text-[11.5px] font-bold inline-flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-[#7ee29a]" />
            پنل مدیریت
          </span>
        </div>
        <div className="hv-card p-6 sm:p-7">{children}</div>
        <Link to="/" className="mt-5 mx-auto w-fit flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-3 hover:text-ink">
          <ArrowRight className="w-4 h-4" />
          بازگشت به هویدا
        </Link>
      </div>
    </div>
  );
}

function AdminLogin() {
  useTitle('ورود به پنل مدیریت');
  const { signIn, notice, noticeTone, clearNotice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The fields themselves: an autofilled password may never fire an input event.
    const fd = new FormData(e.currentTarget);
    const field = (k: string, fallback: string) => {
      const v = fd.get(k);
      return typeof v === 'string' ? v : fallback;
    };
    const em = field('email', email).trim();
    const pw = field('password', password);
    if (!em || !pw) {
      setError('ایمیل و رمز عبور را وارد کنید.');
      return;
    }
    setError(null);
    clearNotice();
    setLoading(true);
    try {
      signIn(await api.auth.login({ email: em, password: pw }));
    } catch (err: any) {
      setError(err?.message || 'ورود ممکن نشد.');
    } finally {
      setLoading(false);
    }
  };
  return (
    <Centered>
      <h1 className="text-[20px] font-extrabold text-ink">ورود مدیر سامانه</h1>
      <p className="text-[13px] text-ink-3 mt-1.5 leading-relaxed">با همان حساب هویدا وارد شوید؛ دسترسی پنل فقط برای مدیران سامانه باز است.</p>
      {(error || notice) && (
        <Callout tone={error ? 'danger' : noticeTone === 'success' ? 'brand' : 'warning'} className="mt-4">
          {error || notice}
        </Callout>
      )}
      <form onSubmit={submit} className="mt-5 flex flex-col gap-4" noValidate>
        <TextInput label="ایمیل" name="email" type="email" latin autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <TextInput label="رمز عبور" name="password" type="password" latin autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <Button type="submit" size="lg" block loading={loading}>
          ورود به پنل
        </Button>
      </form>
    </Centered>
  );
}

function NotAdmin({ setupPending, onClaimed }: { setupPending: boolean; onClaimed: () => void }) {
  useTitle('پنل مدیریت');
  const { user, signOut } = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await adminApi.claim(code.trim());
      onClaimed();
    } catch (err: any) {
      setError(err?.message || 'کد پذیرفته نشد.');
    } finally {
      setLoading(false);
    }
  };
  return (
    <Centered>
      <h1 className="text-[20px] font-extrabold text-ink">{setupPending ? 'راه‌اندازی پنل مدیریت' : 'دسترسی مدیریت ندارید'}</h1>
      <p className="text-[13px] text-ink-3 mt-1.5 leading-relaxed">
        شما با حساب <b className="text-ink-2">{user?.email}</b> وارد شده‌اید.{' '}
        {setupPending
          ? 'هنوز هیچ مدیر سامانه‌ای تعریف نشده است. کد راه‌اندازی یک‌بارمصرف در گزارش (لاگ) سرور چاپ شده است؛ آن را وارد کنید تا این حساب مدیر سامانه شود.'
          : 'این بخش فقط برای مدیران سامانه است. اگر باید دسترسی داشته باشید، از یکی از مدیران بخواهید نقش «مدیر سامانه» را به حساب شما بدهد.'}
      </p>
      {setupPending && (
        <form onSubmit={claim} className="mt-5 flex flex-col gap-3">
          <TextInput
            label="کد راه‌اندازی"
            latin
            placeholder="HV-XXXX-XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            error={error}
            hint="در لاگ سرور با عنوان «[admin] … setup code» آمده است. راه دیگر: متغیر ADMIN_EMAILS."
            required
          />
          <Button type="submit" block loading={loading} icon={ShieldCheck}>
            فعال‌سازی نقش مدیر سامانه
          </Button>
        </form>
      )}
      <div className="flex gap-2 mt-5">
        <ButtonLink to="/app" variant="secondary" block>
          رفتن به فضای کاری
        </ButtonLink>
        <Button variant="ghost" icon={LogOut} onClick={() => void signOut({ silent: true })}>
          خروج
        </Button>
      </div>
    </Centered>
  );
}

function NavLinks({ current, onNavigate }: { current: string; onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5" aria-label="ناوبری پنل مدیریت">
      {NAV.map((item) => {
        const active = item.to === current;
        return (
          <button
            key={item.to}
            onClick={() => {
              navigate(item.to);
              onNavigate?.();
            }}
            className={`flex items-center gap-3 h-11 px-3 rounded-[11px] text-[14px] font-semibold transition-colors text-right ${
              active ? 'bg-white/[0.09] text-white' : 'text-white/65 hover:text-white hover:bg-white/[0.05]'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <item.icon className={`w-[18px] h-[18px] ${active ? 'text-[#7ee29a]' : ''}`} strokeWidth={1.8} />
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}

function SidebarFooter() {
  const { user, signOut } = useAuth();
  return (
    <div className="border-t border-white/10 pt-4 mt-4">
      <p className="text-[13px] font-bold text-white truncate">{user?.name}</p>
      <p className="text-[11.5px] text-white/50 truncate hv-latin text-right">{user?.email}</p>
      <div className="flex gap-1.5 mt-3">
        <Link to="/app" className="flex-1 h-9 rounded-[10px] bg-white/[0.07] hover:bg-white/[0.12] text-[12.5px] font-semibold text-white inline-flex items-center justify-center">
          فضای کاری من
        </Link>
        <button
          onClick={() => void signOut()}
          aria-label="خروج"
          className="w-9 h-9 rounded-[10px] bg-white/[0.07] hover:bg-low/80 flex items-center justify-center text-white"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function AdminShell({ pathname }: { pathname: string }) {
  const section = sectionFor(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  useTitle(`پنل مدیریت · ${section.label}`);
  useEffect(() => setMenuOpen(false), [pathname]);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  useEffect(() => {
    if (isDesktop) setMenuOpen(false); // the drawer exists only below lg
  }, [isDesktop]);
  useLockScroll(menuOpen);
  useEscapeLayer(menuOpen, () => setMenuOpen(false));
  useRestoreFocus(menuOpen);
  const brand = (
    <div className="flex items-center gap-2.5">
      <HovidaMark size={30} />
      <div className="leading-tight">
        <p className="text-[15px] font-extrabold text-white">هویدا</p>
        <p className="text-[11px] font-semibold text-[#7ee29a]">پنل مدیریت سامانه</p>
      </div>
    </div>
  );
  return (
    <div dir="rtl" className="min-h-screen bg-canvas">
      <SkipToMain />
      <aside aria-label="نوار کناری پنل مدیریت" className="hidden lg:flex fixed inset-y-0 right-0 w-[252px] flex-col bg-[#1E2521] px-4 py-5 z-30">
        <div className="px-1 mb-6">{brand}</div>
        <div className="flex-1 overflow-y-auto hv-scroll">
          <NavLinks current={section.to} />
        </div>
        <SidebarFooter />
      </aside>

      <header className="lg:hidden sticky top-0 z-30 bg-[#1E2521] h-14 px-4 flex items-center justify-between">
        {brand}
        <button
          onClick={() => setMenuOpen(true)}
          aria-label="منو"
          aria-expanded={menuOpen}
          className="w-10 h-10 rounded-[10px] flex items-center justify-center text-white hover:bg-white/10"
        >
          <MenuIcon className="w-5 h-5" />
        </button>
      </header>
      {menuOpen && (
        <div className="lg:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="منوی پنل مدیریت"
            onKeyDown={trapTabKey}
            className="absolute inset-y-0 right-0 w-[280px] max-w-[85vw] bg-[#1E2521] px-4 py-5 flex flex-col animate-fade-in"
          >
            <div className="flex items-center justify-between mb-6">
              {brand}
              <button
                onClick={() => setMenuOpen(false)}
                aria-label="بستن"
                autoFocus
                className="w-9 h-9 rounded-[10px] flex items-center justify-center text-white hover:bg-white/10"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <NavLinks current={section.to} onNavigate={() => setMenuOpen(false)} />
            </div>
            <SidebarFooter />
          </div>
        </div>
      )}

      <main id="main" tabIndex={-1} className="lg:pr-[252px] focus:outline-none">
        <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-8">{section.render()}</div>
      </main>
    </div>
  );
}

export default function AdminApp({ pathname }: { pathname: string }) {
  const { status, user } = useAuth();
  const [access, setAccess] = useState<AdminMe | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setCheckError(null);
    try {
      setAccess(await adminApi.me());
    } catch (err: any) {
      // 403 = this session may not use the panel (e.g. a support session).
      // Anything else (offline, server restarting) is not a «no access» answer.
      if (err?.status === 403) setAccess({ isAdmin: false, setupPending: false });
      else setCheckError(err?.message || 'بررسی دسترسی ممکن نشد.');
    }
  }, []);
  useEffect(() => {
    setAccess(null);
    if (status === 'authed') void check();
  }, [status, user?.id, check]);

  if (status !== 'authed') return <AdminLogin />;
  if (checkError) {
    return (
      <Centered>
        <h1 className="text-[18px] font-extrabold text-ink">بررسی دسترسی انجام نشد</h1>
        <Callout tone="danger" className="mt-4">
          {checkError}
        </Callout>
        <Button block className="mt-5" onClick={() => void check()}>
          تلاش دوباره
        </Button>
      </Centered>
    );
  }
  if (!access) {
    return (
      <div dir="rtl" className="min-h-screen flex items-center justify-center bg-canvas">
        <Spinner className="w-6 h-6" label="بررسی دسترسی…" />
      </div>
    );
  }
  if (!access.isAdmin) return <NotAdmin setupPending={access.setupPending} onClaimed={check} />;
  return <AdminShell pathname={pathname} />;
}

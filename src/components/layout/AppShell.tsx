import React, { useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  BriefcaseBusiness,
  ChevronDown,
  Columns3,
  Cpu,
  Home,
  LayoutDashboard,
  Library,
  LogOut,
  Megaphone,
  Menu as MenuIcon,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { HovidaLogo, HovidaMark } from '../brand/Logo';
import { Link, navigate, useLocation } from '../../lib/router';
import { useAuth } from '../../lib/auth';
import { usePublicConfig } from '../../lib/config';
import { useAnalysis } from '../../lib/analysis';
import { useCompare } from '../../lib/compare';
import { Button, IconButton, Menu, Monogram, trapTabKey, useEscapeLayer, useLockScroll, useRestoreFocus } from '../ui';
import { GlobalSearch } from './GlobalSearch';
import { NotificationsPanel } from './NotificationsPanel';
import { CompareTray, useCompareTrayVisible } from './CompareTray';
import { toPersianDigits } from '../../lib/format';
import { useMediaQuery } from '../../lib/useAsync';

const ROLE_LABEL = { owner: 'مالک فضای کاری', admin: 'مدیر', member: 'عضو تیم' } as const;

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  match: (p: string) => boolean;
}

const NAV: NavItem[] = [
  { to: '/app', label: 'داشبورد', icon: LayoutDashboard, match: (p) => p === '/app' || p === '/app/' },
  { to: '/app/jobs', label: 'فرصت‌های شغلی', icon: BriefcaseBusiness, match: (p) => p.startsWith('/app/jobs') },
  { to: '/app/candidates', label: 'رزومه‌ها', icon: Users, match: (p) => p.startsWith('/app/candidates') || p.startsWith('/app/compare') },
  { to: '/app/talent', label: 'بانک استعداد', icon: Library, match: (p) => p.startsWith('/app/talent') },
  { to: '/app/reports', label: 'گزارش‌ها', icon: BarChart3, match: (p) => p.startsWith('/app/reports') },
  { to: '/app/settings', label: 'تنظیمات', icon: Settings, match: (p) => p.startsWith('/app/settings') },
];

function AiStatusChip() {
  const { ai } = useAuth();
  if (!ai) return null;
  const on = ai.available && !ai.coolingDown;
  return (
    <Link
      to="/app/settings/ai"
      className={`flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12px] font-medium border transition-colors ${
        on ? 'border-brand/20 bg-brand-tint text-brand-stronger hover:bg-brand-soft' : 'border-review/25 bg-review-soft text-review-ink hover:brightness-[0.98]'
      }`}
      title={ai.reason || ai.label}
    >
      {on ? <Sparkles className="w-4 h-4 shrink-0" strokeWidth={1.9} /> : <Cpu className="w-4 h-4 shrink-0" strokeWidth={1.9} />}
      <span className="truncate">{on ? 'هوش مصنوعی فعال است' : ai.available ? 'هوش مصنوعی در حال استراحت' : 'تحلیل با موتور محلی'}</span>
    </Link>
  );
}

function UserCard() {
  const { user, org, signOut, support } = useAuth();
  if (!user || !org) return null;
  const isPlatformAdmin = Boolean(user.platformAdmin) && !support;
  return (
    <Menu
      align="start"
      side="top"
      width={240}
      header={
        <div className="min-w-0">
          <p className="text-[13px] font-bold text-ink truncate">{user.name}</p>
          <p className="text-[12px] text-ink-3 truncate hv-latin text-right">{user.email}</p>
        </div>
      }
      items={[
        { label: 'حساب کاربری', icon: UserRound, onClick: () => navigate('/app/settings/account') },
        { label: 'تنظیمات سازمان', icon: Settings, onClick: () => navigate('/app/settings/org') },
        ...(isPlatformAdmin ? [{ label: 'پنل مدیریت سامانه', icon: ShieldCheck, onClick: () => navigate('/admin') }] : []),
        'divider',
        { label: 'خروج از حساب', icon: LogOut, tone: 'danger', onClick: () => void signOut() },
      ]}
      trigger={({ toggle, open }) => (
        <button
          onClick={toggle}
          className={`w-full flex items-center gap-2.5 p-2 rounded-[12px] text-right transition-colors ${open ? 'bg-line-2' : 'hover:bg-line-2'}`}
        >
          <Monogram name={user.name} size={36} />
          <span className="flex-1 min-w-0">
            <span className="block text-[13px] font-bold text-ink truncate">{user.name}</span>
            <span className="block text-[11.5px] text-ink-3 truncate">
              {user.title || ROLE_LABEL[user.role]} · {org.name}
            </span>
          </span>
          <ChevronDown className={`w-4 h-4 text-ink-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      )}
    />
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  return (
    <aside className="hidden lg:flex fixed inset-y-0 right-0 z-30 w-[256px] flex-col bg-surface border-l border-line">
      <div className="h-[72px] flex items-center px-6 border-b border-line-2">
        <Link to="/app" aria-label="هویدا — داشبورد" className="inline-flex">
          <HovidaLogo height={34} />
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto hv-scroll px-3 py-4 flex flex-col gap-1" aria-label="ناوبری اصلی">
        {NAV.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-3 h-11 px-3.5 rounded-[11px] text-[14px] font-semibold transition-colors ${
                active ? 'bg-brand-soft text-brand-stronger' : 'text-ink-2 hover:bg-line-2 hover:text-ink'
              }`}
            >
              {active && <span className="absolute right-0 top-2.5 bottom-2.5 w-[3px] rounded-l-full bg-brand" />}
              <Icon className="w-[19px] h-[19px] shrink-0" strokeWidth={active ? 2 : 1.8} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="p-3 border-t border-line-2 flex flex-col gap-2">
        <AiStatusChip />
        <UserCard />
      </div>
    </aside>
  );
}

function AnalysisPill() {
  const { runs } = useAnalysis();
  const running = runs.filter((r) => r.status === 'running');
  if (!running.length) return null;
  const r = running[0];
  const pct = r.progress?.overallPercent ?? 2;
  return (
    <button
      onClick={() => navigate(`/app/jobs/${r.jobId}`)}
      className="hidden sm:flex items-center gap-2.5 h-10 pr-3 pl-3.5 rounded-full border border-brand/25 bg-brand-tint text-brand-stronger text-[13px] font-semibold hover:bg-brand-soft transition-colors"
      title={r.progress?.statusText || 'در حال تحلیل رزومه‌ها'}
    >
      <span className="relative w-5 h-5">
        <svg viewBox="0 0 20 20" className="w-5 h-5 -rotate-90">
          <circle cx="10" cy="10" r="8" fill="none" stroke="#cfe5d5" strokeWidth="2.5" />
          <circle cx="10" cy="10" r="8" fill="none" stroke="#2DBA4E" strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${(pct / 100) * 50.3} 50.3`} />
        </svg>
      </span>
      <span className="max-w-[180px] truncate">
        تحلیل {running.length > 1 ? `${toPersianDigits(running.length)} فرصت` : `«${r.jobTitle}»`}
      </span>
      <span className="hv-num text-[12px] text-brand-ink">{toPersianDigits(pct)}٪</span>
    </button>
  );
}

function Topbar({ onSearch, onBell }: { onSearch: () => void; onBell: () => void }) {
  const { unread, org } = useAuth();
  return (
    <header className="sticky top-0 z-20 bg-canvas/85 backdrop-blur-md border-b border-line lg:border-transparent">
      <div className="h-16 lg:h-[72px] flex items-center gap-3 px-4 sm:px-6 lg:px-8">
        <div className="lg:hidden flex items-center gap-2.5 min-w-0 flex-1">
          <Link to="/app" aria-label="داشبورد" className="shrink-0">
            <HovidaMark size={30} />
          </Link>
          <span className="text-[14px] font-bold text-ink truncate">{org?.name}</span>
        </div>
        <button
          onClick={onSearch}
          className="hidden lg:flex items-center gap-2.5 h-11 w-full max-w-[460px] px-3.5 rounded-control bg-surface border border-line text-ink-4 text-sm hover:border-line-strong transition-colors"
        >
          <Search className="w-[18px] h-[18px]" strokeWidth={1.8} />
          <span className="flex-1 text-right">جست‌وجوی کاندید، فرصت شغلی یا مهارت…</span>
          <kbd className="hv-latin text-[11px] font-semibold text-ink-3 border border-line rounded-md px-1.5 py-0.5 bg-canvas">Ctrl K</kbd>
        </button>
        <div className="flex items-center gap-1.5 sm:gap-2 mr-auto">
          <AnalysisPill />
          <IconButton icon={Search} label="جست‌وجو" className="lg:hidden" onClick={onSearch} />
          <IconButton icon={Bell} label={unread ? `اعلان‌ها (${toPersianDigits(unread)} خوانده‌نشده)` : 'اعلان‌ها'} badge={unread > 0} onClick={onBell} />
          <Button icon={Plus} className="max-sm:hidden" onClick={() => navigate('/app/jobs/new')}>
            ایجاد فرصت شغلی
          </Button>
        </div>
      </div>
    </header>
  );
}

function MobileNav({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  const compare = useCompare();
  const items: { to?: string; label: string; icon: LucideIcon; active: boolean; badge?: number; onClick?: () => void }[] = [
    { to: '/app', label: 'خانه', icon: Home, active: pathname === '/app' },
    { to: '/app/jobs', label: 'فرصت‌ها', icon: BriefcaseBusiness, active: pathname.startsWith('/app/jobs') },
    { to: '/app/candidates', label: 'رزومه‌ها', icon: Users, active: pathname.startsWith('/app/candidates') },
    {
      to: compare.items.length ? `/app/compare?ids=${compare.items.map((i) => i.id).join(',')}` : '/app/compare',
      label: 'مقایسه',
      icon: Columns3,
      active: pathname.startsWith('/app/compare'),
      badge: compare.items.length,
    },
    {
      label: 'بیشتر',
      icon: MenuIcon,
      active: ['/app/talent', '/app/reports', '/app/settings'].some((p) => pathname.startsWith(p)),
      onClick: onMore,
    },
  ];
  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-line hv-safe-bottom" aria-label="ناوبری">
      <div className="grid grid-cols-5 h-[64px]">
        {items.map((it) => {
          const Icon = it.icon;
          const inner = (
            <>
              <span className={`relative flex items-center justify-center w-12 h-7 rounded-full transition-colors ${it.active ? 'bg-brand-soft' : ''}`}>
                <Icon className={`w-[21px] h-[21px] ${it.active ? 'text-brand-stronger' : 'text-ink-3'}`} strokeWidth={it.active ? 2.1 : 1.8} />
                {!!it.badge && (
                  <span className="absolute -top-1 left-1 min-w-[17px] h-[17px] px-1 rounded-full bg-brand-strong text-white text-[10px] font-bold flex items-center justify-center hv-num">
                    {toPersianDigits(it.badge)}
                  </span>
                )}
              </span>
              <span className={`text-[11px] font-semibold ${it.active ? 'text-brand-stronger' : 'text-ink-3'}`}>{it.label}</span>
            </>
          );
          return it.to ? (
            <Link key={it.label} to={it.to} className="flex flex-col items-center justify-center gap-0.5" aria-current={it.active ? 'page' : undefined}>
              {inner}
            </Link>
          ) : (
            <button key={it.label} onClick={it.onClick} className="flex flex-col items-center justify-center gap-0.5">
              {inner}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { signOut, user, org, support } = useAuth();
  useLockScroll(open);
  useEscapeLayer(open, onClose);
  useRestoreFocus(open);
  if (!open) return null;
  const go = (to: string) => {
    onClose();
    navigate(to);
  };
  return (
    <div className="lg:hidden fixed inset-0 z-[75]" dir="rtl">
      <div className="absolute inset-0 bg-[#18211c]/35 animate-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="منوی بیشتر"
        onKeyDown={trapTabKey}
        className="absolute bottom-0 inset-x-0 bg-surface rounded-t-[22px] shadow-pop animate-sheet-up hv-safe-bottom"
      >
        <div className="mx-auto mt-2.5 w-10 h-1 rounded-full bg-line-strong" />
        <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-line">
          <Monogram name={user?.name} size={40} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-ink truncate">{user?.name}</p>
            <p className="text-xs text-ink-3 truncate">{org?.name}</p>
          </div>
          <IconButton icon={X} label="بستن" onClick={onClose} />
        </div>
        <div className="p-3 grid gap-1">
          {[
            { to: '/app/jobs/new', label: 'ایجاد فرصت شغلی', icon: Plus },
            { to: '/app/talent', label: 'بانک استعداد', icon: Library },
            { to: '/app/reports', label: 'گزارش‌ها', icon: BarChart3 },
            { to: '/app/settings', label: 'تنظیمات', icon: Settings },
            ...(user?.platformAdmin && !support ? [{ to: '/admin', label: 'پنل مدیریت سامانه', icon: ShieldCheck }] : []),
          ].map((it) => (
            <button key={it.to} onClick={() => go(it.to)} className="flex items-center gap-3 h-12 px-3 rounded-[12px] text-[15px] font-semibold text-ink-2 hover:bg-line-2">
              <it.icon className="w-5 h-5 text-ink-3" strokeWidth={1.8} />
              {it.label}
            </button>
          ))}
          <button
            onClick={() => {
              onClose();
              void signOut();
            }}
            className="flex items-center gap-3 h-12 px-3 rounded-[12px] text-[15px] font-semibold text-low-ink hover:bg-low-soft"
          >
            <LogOut className="w-5 h-5" strokeWidth={1.8} />
            خروج از حساب
          </button>
        </div>
      </div>
    </div>
  );
}

function demoTimeLeft(expiresAt: string | null): string {
  const ms = expiresAt ? new Date(expiresAt).getTime() - Date.now() : 0;
  if (!Number.isFinite(ms) || ms <= 0) return 'به‌زودی';
  const hours = Math.ceil(ms / 3600_000);
  return hours >= 48 ? `حدود ${Math.round(hours / 24).toLocaleString('fa-IR')} روز دیگر` : `حدود ${hours.toLocaleString('fa-IR')} ساعت دیگر`;
}

const BANNER_TONES = {
  info: 'bg-[#EAF2F7] text-[#24485E] border-[#D5E3EC]',
  warning: 'bg-review-soft text-[#7A4A0B] border-review/25',
  success: 'bg-brand-tint text-brand-stronger border-brand/20',
} as const;

/** Support session, maintenance notice and the operator's announcement. */
function PlatformBanners() {
  const cfg = usePublicConfig();
  const { support, user, signOut } = useAuth();
  const annKey = cfg.announcement?.text || '';
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem('hovida.announcement.dismissed');
    } catch {
      return null;
    }
  });
  return (
    <>
      {support && (
        <div className="bg-[#5B3A0A] text-white text-[12.5px]">
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#FCD34D]" />
              نشست پشتیبانی: شما با حساب <b className="font-bold">{user?.name}</b> کار می‌کنید (گشوده‌شده توسط {support.adminName}). همه کارها به نام این کاربر ثبت می‌شود.
            </span>
            <button
              onClick={async () => {
                await signOut({ silent: true });
                window.close();
                navigate('/admin', { replace: true });
              }}
              className="font-bold text-[#FCD34D] hover:text-white underline-offset-4 hover:underline"
            >
              پایان نشست پشتیبانی
            </button>
          </div>
        </div>
      )}
      {cfg.maintenance && (
        <div className={`border-b text-[12.5px] ${BANNER_TONES.warning}`}>
          <div className="flex items-center justify-center gap-2 px-4 py-2 text-center">
            <Wrench className="w-3.5 h-3.5 shrink-0" />
            <span>
              {cfg.maintenance}
              {user?.platformAdmin ? ' (شما به‌عنوان مدیر سامانه همچنان دسترسی کامل دارید.)' : ''}
            </span>
          </div>
        </div>
      )}
      {cfg.announcement && dismissed !== annKey && (
        <div className={`border-b text-[12.5px] ${BANNER_TONES[cfg.announcement.tone]}`}>
          <div className="flex items-center justify-center gap-2 px-4 py-2 text-center">
            <Megaphone className="w-3.5 h-3.5 shrink-0" />
            <span className="leading-relaxed">{cfg.announcement.text}</span>
            <button
              onClick={() => {
                setDismissed(annKey);
                try {
                  sessionStorage.setItem('hovida.announcement.dismissed', annKey);
                } catch {
                  /* storage blocked */
                }
              }}
              aria-label="بستن اطلاعیه"
              className="w-6 h-6 rounded-md flex items-center justify-center opacity-70 hover:opacity-100"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function DemoBanner() {
  const { org, signOut } = useAuth();
  if (!org?.isDemo) return null;
  return (
    <div className="bg-[#1f2a23] text-white text-[12.5px]">
      <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center">
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="w-3.5 h-3.5 text-[#7ee29a]" />
          شما در <b className="font-bold">نسخه نمایشی</b> هستید؛ همه داده‌ها ساختگی‌اند و این فضای کاری {demoTimeLeft(org.demoExpiresAt)} پاک می‌شود.
        </span>
        <button
          onClick={async () => {
            await signOut({ silent: true });
            navigate('/signup');
          }}
          className="font-bold text-[#7ee29a] hover:text-white underline-offset-4 hover:underline"
        >
          ساخت فضای کاری سازمان شما ←
        </button>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { pathname } = useLocation();
  const trayVisible = useCompareTrayVisible();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // e.code is the physical key: Ctrl+K / «/» also work on the Persian layout
      // (where e.key is «ن» and «.»).
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === '/' || (e.code === 'Slash' && !e.shiftKey))) {
        // Not on top of an open dialog — the search would cover it.
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // A route change (link, Back button) closes whatever overlay was open.
  useEffect(() => {
    setMoreOpen(false);
    setSearchOpen(false);
    setBellOpen(false);
  }, [pathname]);
  // The «بیشتر» sheet exists only below lg: never leave it open (and the page
  // scroll-locked) behind a window that was widened.
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  useEffect(() => {
    if (isDesktop) setMoreOpen(false);
  }, [isDesktop]);

  return (
    <div className="min-h-screen bg-canvas" dir="rtl">
      <Sidebar />
      <div className="lg:pr-[256px] min-h-screen flex flex-col">
        <PlatformBanners />
        <DemoBanner />
        <Topbar onSearch={() => setSearchOpen(true)} onBell={() => setBellOpen(true)} />
        <main className={`flex-1 w-full max-w-[1440px] mx-auto px-4 sm:px-6 lg:px-8 pt-4 lg:pt-1 pb-28 ${trayVisible ? 'lg:pb-28' : 'lg:pb-12'}`}>{children}</main>
      </div>
      <MobileNav onMore={() => setMoreOpen(true)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NotificationsPanel open={bellOpen} onClose={() => setBellOpen(false)} />
      <CompareTray />
    </div>
  );
}

/** Standard page header: title, subtitle, actions; optional breadcrumb. */
export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumb,
  className = '',
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: { label: string; to?: string }[];
  className?: string;
}) {
  return (
    <div className={`mb-5 lg:mb-6 ${className}`}>
      {breadcrumb && (
        <nav className="flex items-center gap-1.5 text-[12.5px] text-ink-3 mb-2" aria-label="مسیر">
          {breadcrumb.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="text-ink-4">/</span>}
              {b.to ? (
                <Link to={b.to} className="hover:text-ink-2 font-medium">
                  {b.label}
                </Link>
              ) : (
                <span className="text-ink-2 font-semibold truncate max-w-[240px]">{b.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] sm:text-[24px] font-extrabold text-ink leading-tight">{title}</h1>
          {subtitle && <p className="text-[13.5px] text-ink-3 mt-1.5 leading-relaxed">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

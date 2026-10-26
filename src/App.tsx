import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { ConfigProvider } from './lib/config';
import { AnalysisProvider } from './lib/analysis';
import { matchPath, navigate, useLocation } from './lib/router';
import { Toaster } from './components/ui';
import { AppShell } from './components/layout/AppShell';
import { HovidaMark } from './components/brand/Logo';
import Landing from './pages/Landing';
import { LoginPage, SignupPage } from './pages/Auth';
import NotFound from './pages/NotFound';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { LeaveGuardDialog } from './components/layout/LeaveGuardDialog';

const CHUNK_RELOAD_KEY = 'hovida.chunk-reload';

/**
 * Lazy page that survives a deploy: a tab opened on the previous version asks
 * for chunk files the new build no longer has. Reload once to get the new
 * build instead of showing an error (the flag prevents reload loops when the
 * network itself is down).
 */
function lazyPage<T extends React.ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const mod = await load();
      try {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      } catch {
        /* storage blocked */
      }
      return mod;
    } catch (err) {
      let alreadyReloaded = true;
      try {
        alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1';
        if (!alreadyReloaded) sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
      } catch {
        /* storage blocked: don't risk a loop */
      }
      if (!alreadyReloaded && navigator.onLine !== false) {
        window.location.reload();
        return new Promise<{ default: T }>(() => {}); // the page is reloading
      }
      throw err;
    }
  });
}

const Dashboard = lazyPage(() => import('./pages/Dashboard'));
const Jobs = lazyPage(() => import('./pages/Jobs'));
const JobNew = lazyPage(() => import('./pages/JobNew'));
const JobDetail = lazyPage(() => import('./pages/JobDetail'));
const Candidates = lazyPage(() => import('./pages/Candidates'));
const CandidatePage = lazyPage(() => import('./pages/CandidatePage'));
const Compare = lazyPage(() => import('./pages/Compare'));
const Talent = lazyPage(() => import('./pages/Talent'));
const Reports = lazyPage(() => import('./pages/Reports'));
const Sourcing = lazyPage(() => import('./pages/Sourcing'));
const Settings = lazyPage(() => import('./pages/Settings'));
const AdminApp = lazyPage(() => import('./pages/admin/AdminApp'));

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true, force: true }); // an address correction, not leaving a page
  }, [to]);
  return null;
}

export function FullScreenLoader({ label = 'در حال آماده‌سازی…' }: { label?: string }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-canvas" dir="rtl">
      <HovidaMark size={44} />
      <div className="w-32 h-1 rounded-full bg-line overflow-hidden">
        <div className="h-full w-1/2 bg-brand rounded-full animate-pulse" />
      </div>
      <p className="text-[13px] text-ink-3">{label}</p>
    </div>
  );
}

function PageFallback() {
  return (
    <div className="flex flex-col gap-4 pt-2" aria-busy="true">
      <div className="hv-skeleton h-8 w-56" />
      <div className="hv-skeleton h-4 w-80" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="hv-skeleton h-[84px] rounded-card" />
        ))}
      </div>
      <div className="hv-skeleton h-[360px] rounded-card" />
    </div>
  );
}

/**
 * Record ids are letters, digits, «_» and «-». Anything else (a «%» left by a
 * host that re-encodes malformed escapes, e.g. Cloudflare's static assets
 * turning «%E0» into «%25E0») is an address that cannot exist.
 */
const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/;

function appPage(pathname: string): React.ReactNode {
  if (pathname === '/app' || pathname === '/app/') return <Dashboard />;
  if (pathname === '/app/jobs') return <Jobs />;
  if (pathname === '/app/jobs/new') return <JobNew />;
  let m = matchPath('/app/jobs/:id', pathname);
  // Keyed: moving between two openings (notification, search) starts with fresh filters and panels.
  if (m) return RECORD_ID.test(m.id) ? <JobDetail key={m.id} id={m.id} /> : <NotFound inApp />;
  if (pathname === '/app/candidates') return <Candidates />;
  m = matchPath('/app/candidates/:id', pathname);
  if (m) return RECORD_ID.test(m.id) ? <CandidatePage key={m.id} id={m.id} /> : <NotFound inApp />;
  if (pathname === '/app/compare') return <Compare />;
  if (pathname === '/app/talent') return <Talent />;
  if (pathname === '/app/sourcing') return <Sourcing />;
  m = matchPath('/app/talent/:dept', pathname);
  if (m) return <Talent dept={m.dept} />;
  if (pathname === '/app/reports') return <Reports />;
  if (pathname === '/app/settings') return <Settings tab="org" />;
  m = matchPath('/app/settings/:tab', pathname);
  if (m) return <Settings tab={m.tab} />;
  return <NotFound inApp />;
}

function Routes() {
  const { pathname, search } = useLocation();
  const { status } = useAuth();

  if (pathname === '/') return <Landing />;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (status === 'loading') return <FullScreenLoader />;
    return (
      <Suspense fallback={<FullScreenLoader label="در حال بارگذاری پنل مدیریت…" />}>
        <AdminApp pathname={pathname} />
      </Suspense>
    );
  }
  if (pathname === '/login' || pathname === '/signup') {
    if (status === 'authed') {
      const next = new URLSearchParams(search).get('next');
      return <Redirect to={next && next.startsWith('/app') ? next : '/app'} />;
    }
    if (status === 'loading') return <FullScreenLoader />;
    return pathname === '/login' ? <LoginPage /> : <SignupPage />;
  }
  if (pathname.startsWith('/app')) {
    if (status === 'loading') return <FullScreenLoader />;
    if (status !== 'authed') return <Redirect to={`/login?next=${encodeURIComponent(pathname + search)}`} />;
    return (
      <AppShell>
        <Suspense fallback={<PageFallback />}>{appPage(pathname)}</Suspense>
      </AppShell>
    );
  }
  return <NotFound />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ConfigProvider>
        <AuthProvider>
          <AnalysisProvider>
            <Routes />
            <Toaster />
            <LeaveGuardDialog />
          </AnalysisProvider>
        </AuthProvider>
      </ConfigProvider>
    </ErrorBoundary>
  );
}

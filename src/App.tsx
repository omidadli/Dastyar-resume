import React, { Suspense, lazy, useEffect } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { AnalysisProvider } from './lib/analysis';
import { matchPath, navigate, useLocation } from './lib/router';
import { Toaster } from './components/ui';
import { AppShell } from './components/layout/AppShell';
import { HovidaMark } from './components/brand/Logo';
import Landing from './pages/Landing';
import { LoginPage, SignupPage } from './pages/Auth';
import NotFound from './pages/NotFound';
import { ErrorBoundary } from './components/layout/ErrorBoundary';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Jobs = lazy(() => import('./pages/Jobs'));
const JobNew = lazy(() => import('./pages/JobNew'));
const JobDetail = lazy(() => import('./pages/JobDetail'));
const Candidates = lazy(() => import('./pages/Candidates'));
const CandidatePage = lazy(() => import('./pages/CandidatePage'));
const Compare = lazy(() => import('./pages/Compare'));
const Talent = lazy(() => import('./pages/Talent'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));

function Redirect({ to }: { to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
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

function appPage(pathname: string): React.ReactNode {
  if (pathname === '/app' || pathname === '/app/') return <Dashboard />;
  if (pathname === '/app/jobs') return <Jobs />;
  if (pathname === '/app/jobs/new') return <JobNew />;
  let m = matchPath('/app/jobs/:id', pathname);
  if (m) return <JobDetail id={m.id} />;
  if (pathname === '/app/candidates') return <Candidates />;
  m = matchPath('/app/candidates/:id', pathname);
  if (m) return <CandidatePage id={m.id} />;
  if (pathname === '/app/compare') return <Compare />;
  if (pathname === '/app/talent') return <Talent />;
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
      <AuthProvider>
        <AnalysisProvider>
          <Routes />
          <Toaster />
        </AnalysisProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}

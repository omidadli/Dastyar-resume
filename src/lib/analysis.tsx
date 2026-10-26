import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ScreeningProgressUpdate } from '../types/screening';
import { runJobAnalysis, type RunResult } from './runner';
import { emitChange } from './events';
import { toast } from '../components/ui/Toast';
import { navigate } from './router';
import { playCompletionChime } from './sound';
import { onBeforeSignOut, useAuth } from './auth';
import { api } from './api';

/**
 * App-level background analysis. Runs survive page navigation (the user can
 * keep reviewing candidates elsewhere); the top bar shows a progress pill and
 * a toast announces completion.
 */
export interface AnalysisRun {
  jobId: string;
  jobTitle: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  progress: ScreeningProgressUpdate | null;
  result: RunResult | null;
  error: string | null;
  startedAt: number;
  fileCount: number;
}

interface AnalysisValue {
  runs: AnalysisRun[];
  runFor: (jobId: string) => AnalysisRun | undefined;
  start: (job: { id: string; roleTitle: string }, files: File[]) => boolean;
  cancel: (jobId: string) => void;
  dismiss: (jobId: string) => void;
}

const Ctx = createContext<AnalysisValue | null>(null);

export function AnalysisProvider({ children }: { children: React.ReactNode }) {
  const [runs, setRuns] = useState<Record<string, AnalysisRun>>({});
  const controllers = useRef<Record<string, AbortController>>({});
  const lastRefresh = useRef<Record<string, number>>({});

  const patch = useCallback((jobId: string, p: Partial<AnalysisRun>) => {
    setRuns((prev) => (prev[jobId] ? { ...prev, [jobId]: { ...prev[jobId], ...p } } : prev));
  }, []);

  const start = useCallback(
    (job: { id: string; roleTitle: string }, files: File[]) => {
      if (!files.length) return false;
      if (controllers.current[job.id]) {
        toast('تحلیل قبلی این فرصت شغلی هنوز در جریان است؛ کمی صبر کنید.', 'info');
        return false;
      }
      const controller = new AbortController();
      controllers.current[job.id] = controller;
      setRuns((prev) => ({
        ...prev,
        [job.id]: {
          jobId: job.id,
          jobTitle: job.roleTitle,
          status: 'running',
          progress: null,
          result: null,
          error: null,
          startedAt: Date.now(),
          fileCount: files.length,
        },
      }));
      runJobAnalysis(
        job.id,
        files,
        (u) => {
          patch(job.id, { progress: u });
          // Let open views pick up new candidates every few seconds, not on every tick.
          const now = Date.now();
          if (now - (lastRefresh.current[job.id] || 0) > 2500) {
            lastRefresh.current[job.id] = now;
            emitChange('resumes', job.id);
          }
        },
        controller.signal
      )
        .then((result) => {
          patch(job.id, { status: 'done', result });
          emitChange('resumes', job.id);
          emitChange('jobs', job.id);
          emitChange('activity');
          playCompletionChime();
          const analysed = result.aiCount + result.localCount;
          toast(
            `تحلیل ${result.total.toLocaleString('fa-IR')} رزومه برای «${job.roleTitle}» کامل شد${
              result.localCount ? ` (${result.localCount.toLocaleString('fa-IR')} مورد با موتور محلی)` : ''
            }${result.duplicates ? `؛ ${result.duplicates.toLocaleString('fa-IR')} رزومه پیش‌تر در این دپارتمان ثبت شده بود` : ''}.`,
            analysed || result.unjudgeable ? 'success' : 'info',
            window.location.pathname.startsWith(`/app/jobs/${job.id}`)
              ? undefined
              : { label: 'مشاهده', onClick: () => navigate(`/app/jobs/${job.id}`) }
          );
        })
        .catch((err) => {
          const cancelled = err?.name === 'AbortError';
          patch(job.id, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? null : err?.message || 'تحلیل متوقف شد.' });
          emitChange('resumes', job.id);
          emitChange('jobs', job.id);
          if (!cancelled) toast(err?.message || 'تحلیل رزومه‌ها متوقف شد.', 'error');
        })
        .finally(() => {
          delete controllers.current[job.id];
        });
      return true;
    },
    [patch]
  );

  const cancel = useCallback((jobId: string) => {
    controllers.current[jobId]?.abort();
  }, []);

  // Signing out stops every run first — while the token still works, so the
  // server marks those jobs as cancelled instead of "in progress".
  useEffect(
    () =>
      onBeforeSignOut(async () => {
        const ids = Object.keys(controllers.current);
        ids.forEach((id) => controllers.current[id]?.abort());
        await Promise.allSettled(ids.map((id) => api.jobs.analysis(id, 'cancel')));
      }),
    []
  );

  // Any other way the account goes away (expired session, sign-out in another
  // tab, switching accounts): stop the runs and forget their progress.
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const lastUser = useRef(userId);
  useEffect(() => {
    if (lastUser.current && lastUser.current !== userId) {
      Object.values(controllers.current).forEach((c) => c.abort());
      controllers.current = {};
      setRuns({});
    }
    lastUser.current = userId;
  }, [userId]);

  const dismiss = useCallback((jobId: string) => {
    setRuns((prev) => {
      if (prev[jobId]?.status === 'running') return prev;
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  }, []);

  // Warn before closing the tab while resumes are still being analysed.
  const anyRunning = Object.values(runs).some((r) => r.status === 'running');
  useEffect(() => {
    if (!anyRunning) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [anyRunning]);

  const value = useMemo<AnalysisValue>(
    () => ({
      runs: Object.values(runs).sort((a, b) => b.startedAt - a.startedAt),
      runFor: (jobId) => runs[jobId],
      start,
      cancel,
      dismiss,
    }),
    [runs, start, cancel, dismiss]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAnalysis(): AnalysisValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAnalysis outside AnalysisProvider');
  return v;
}

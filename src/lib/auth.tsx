import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { AiStatus, AuthPayload, MeResponse, OrgPublic, UserPublic } from '../types/app';
import { api, getToken, lastSessionWasDemo, setToken, TOKEN_KEY, UNAUTHORIZED_EVENT } from './api';
import { clearCompare, setCompareScope } from './compare';
import { navigate, requestLeave } from './router';

/**
 * Work that must finish while the session is still valid (e.g. telling the
 * server that a running analysis was cancelled). Awaited by signOut, max 3s.
 */
const beforeSignOutHooks = new Set<() => Promise<unknown> | unknown>();
export function onBeforeSignOut(fn: () => Promise<unknown> | unknown): () => void {
  beforeSignOutHooks.add(fn);
  return () => {
    beforeSignOutHooks.delete(fn);
  };
}

/**
 * «ورود پشتیبانی» in /admin opens /app#support=<token> in a new tab. That
 * session lives in this tab's memory only — the admin's own stored session
 * (other tabs, reloads) is never touched.
 */
if (typeof window !== 'undefined') {
  const m = window.location.hash.match(/^#support=([A-Za-z0-9_-]{20,256})$/);
  if (m) {
    setToken(m[1], { persist: false });
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }
}

const EXPIRED_NOTICE = 'نشست شما به پایان رسیده است؛ لطفاً دوباره وارد شوید.';
const DEMO_EXPIRED_NOTICE = 'مهلت نسخه نمایشی به پایان رسیده است. می‌توانید یک نسخه نمایشی تازه بسازید یا وارد حساب خود شوید.';
const SIGNED_OUT_ELSEWHERE = 'از حساب کاربری خود در زبانه‌ای دیگر خارج شدید.';

type Status = 'loading' | 'anon' | 'authed';

interface AuthValue {
  status: Status;
  user: UserPublic | null;
  org: OrgPublic | null;
  ai: AiStatus | null;
  unread: number;
  /** Persian notice shown on the login page (e.g. expired session). */
  notice: string | null;
  /** Set while a platform admin uses this tab as a support session. */
  support: MeResponse['support'];
  signIn: (payload: AuthPayload) => void;
  /** False when the person chose to stay with unsaved edits (nothing happened). */
  signOut: (opts?: { silent?: boolean }) => Promise<boolean>;
  refresh: () => Promise<void>;
  setOrg: (org: OrgPublic) => void;
  setUser: (user: UserPublic) => void;
  setUnread: (n: number) => void;
  clearNotice: () => void;
}

const AuthCtx = createContext<AuthValue | null>(null);

/**
 * The 60-second refresh returns fresh objects even when nothing changed; keep
 * the previous ones so effects keyed on them (forms seeded from the org…)
 * don't re-run and wipe what the user is typing.
 */
function keepIfSame<T>(prev: T, next: T): T {
  return prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>(getToken() ? 'loading' : 'anon');
  const [user, setUser] = useState<UserPublic | null>(null);
  const [org, setOrg] = useState<OrgPublic | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [unread, setUnread] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [support, setSupport] = useState<MeResponse['support']>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const isDemoRef = useRef(false);
  isDemoRef.current = org?.isDemo ?? isDemoRef.current;

  const reset = useCallback(() => {
    setToken(null);
    clearCompare(); // the tray holds candidate names — never show them to the next account
    setCompareScope(null);
    setUser(null);
    setOrg(null);
    setAi(null);
    setUnread(0);
    setSupport(null);
    setStatus('anon');
  }, []);

  const refresh = useCallback(async () => {
    const token = getToken();
    if (!token) {
      reset();
      return;
    }
    try {
      const me = await api.auth.me();
      if (getToken() !== token) return; // signed out / switched account meanwhile
      setCompareScope(me.org.id); // before the first signed-in render
      setUser((prev) => keepIfSame(prev, me.user));
      setOrg((prev) => keepIfSame(prev, me.org));
      setAi((prev) => keepIfSame(prev, me.ai));
      setUnread(me.unread);
      setSupport((prev) => keepIfSame(prev, me.support ?? null));
      setStatus('authed');
    } catch (err: any) {
      if (getToken() !== token) return;
      if (err?.status === 401) reset();
      else if (statusRef.current === 'loading') {
        // Server unreachable on first load: keep the token so a reload can resume the session.
        setStatus('anon');
        setNotice('ارتباط با سرور برقرار نشد؛ لطفاً اتصال را بررسی و صفحه را تازه کنید.');
      }
    }
  }, [reset]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onUnauthorized = (e: Event) => {
      const detail = ((e as CustomEvent).detail || {}) as { code?: string | null; message?: string | null };
      const wasDemo = isDemoRef.current || lastSessionWasDemo();
      reset();
      // Disabled account / suspended workspace: show the operator's explanation.
      if ((detail.code === 'ACCOUNT_DISABLED' || detail.code === 'ORG_SUSPENDED') && detail.message) setNotice(detail.message);
      else setNotice(wasDemo ? DEMO_EXPIRED_NOTICE : EXPIRED_NOTICE);
      // The session is gone: unsaved edits can't be saved anyway, so no question.
      if (window.location.pathname.startsWith('/app')) navigate('/login', { replace: true, force: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [reset]);

  // Other tabs: follow a sign-out of this same session, and pick up a sign-in
  // while this tab is signed out. A tab never silently switches accounts.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== TOKEN_KEY) return;
      const mine = getToken();
      const next = e.newValue;
      if (mine && !next && e.oldValue === mine) {
        reset();
        setNotice(SIGNED_OUT_ELSEWHERE);
        if (window.location.pathname.startsWith('/app')) navigate('/login', { replace: true, force: true });
      } else if (!mine && next) {
        setToken(next, { persist: false });
        setStatus('loading');
        void refresh();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [reset, refresh]);

  // The comparison tray belongs to the workspace this tab is signed in to.
  useEffect(() => {
    setCompareScope(status === 'authed' ? (org?.id ?? null) : null);
  }, [status, org?.id]);

  // Keep AI status and unread notifications fresh while the app is open.
  useEffect(() => {
    if (status !== 'authed') return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [status, refresh]);

  const signIn = useCallback((payload: AuthPayload) => {
    setToken(payload.token, { demo: payload.org.isDemo });
    setCompareScope(payload.org.id);
    clearCompare();
    isDemoRef.current = payload.org.isDemo;
    setUser(payload.user);
    setOrg(payload.org);
    setSupport(null);
    setNotice(null);
    setStatus('authed');
    const token = payload.token;
    api.auth
      .me()
      .then((me) => {
        if (getToken() !== token) return; // signed out / switched meanwhile
        setUser((prev) => keepIfSame(prev, me.user));
        setOrg((prev) => keepIfSame(prev, me.org));
        setAi(me.ai);
        setUnread(me.unread);
        setSupport(me.support ?? null);
      })
      .catch(() => {});
  }, []);

  const signOut = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      // Unsaved edits on screen: ask before signing out throws them away.
      if (!(await requestLeave())) return false;
      if (beforeSignOutHooks.size) {
        await Promise.race([
          Promise.allSettled(Array.from(beforeSignOutHooks, (fn) => Promise.resolve().then(fn))),
          new Promise((r) => setTimeout(r, 3000)),
        ]);
      }
      try {
        if (getToken()) await api.auth.logout();
      } catch {
        /* already invalid */
      }
      reset();
      if (!opts.silent) navigate('/', { replace: true, force: true });
      return true;
    },
    [reset]
  );

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      org,
      ai,
      unread,
      notice,
      support,
      signIn,
      signOut,
      refresh,
      setOrg,
      setUser,
      setUnread,
      clearNotice: () => setNotice(null),
    }),
    [status, user, org, ai, unread, notice, support, signIn, signOut, refresh]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthCtx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function useCan(min: 'admin' | 'owner'): boolean {
  const { user } = useAuth();
  if (!user) return false;
  if (min === 'owner') return user.role === 'owner';
  return user.role === 'owner' || user.role === 'admin';
}

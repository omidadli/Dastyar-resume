import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AiStatus, AuthPayload, OrgPublic, UserPublic } from '../types/app';
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from './api';
import { navigate } from './router';

type Status = 'loading' | 'anon' | 'authed';

interface AuthValue {
  status: Status;
  user: UserPublic | null;
  org: OrgPublic | null;
  ai: AiStatus | null;
  unread: number;
  /** Persian notice shown on the login page (e.g. expired session). */
  notice: string | null;
  signIn: (payload: AuthPayload) => void;
  signOut: (opts?: { silent?: boolean }) => Promise<void>;
  refresh: () => Promise<void>;
  setOrg: (org: OrgPublic) => void;
  setUser: (user: UserPublic) => void;
  setUnread: (n: number) => void;
  clearNotice: () => void;
}

const AuthCtx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>(getToken() ? 'loading' : 'anon');
  const [user, setUser] = useState<UserPublic | null>(null);
  const [org, setOrg] = useState<OrgPublic | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [unread, setUnread] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrg(null);
    setAi(null);
    setUnread(0);
    setStatus('anon');
  }, []);

  const refresh = useCallback(async () => {
    if (!getToken()) {
      reset();
      return;
    }
    try {
      const me = await api.auth.me();
      setUser(me.user);
      setOrg(me.org);
      setAi(me.ai);
      setUnread(me.unread);
      setStatus('authed');
    } catch (err: any) {
      if (err?.status === 401) reset();
      else if (status === 'loading') {
        // Network hiccup on first load: keep the token, show the app shell offline-ish.
        setStatus('anon');
        setNotice('ارتباط با سرور برقرار نشد؛ لطفاً اتصال را بررسی و صفحه را تازه کنید.');
      }
    }
  }, [reset, status]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      reset();
      setNotice('نشست شما به پایان رسیده است؛ لطفاً دوباره وارد شوید.');
      if (window.location.pathname.startsWith('/app')) navigate('/login', { replace: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [reset]);

  // Keep AI status and unread notifications fresh while the app is open.
  useEffect(() => {
    if (status !== 'authed') return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [status, refresh]);

  const signIn = useCallback((payload: AuthPayload) => {
    setToken(payload.token);
    setUser(payload.user);
    setOrg(payload.org);
    setNotice(null);
    setStatus('authed');
    api.auth
      .me()
      .then((me) => {
        setAi(me.ai);
        setUnread(me.unread);
      })
      .catch(() => {});
  }, []);

  const signOut = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      try {
        if (getToken()) await api.auth.logout();
      } catch {
        /* already invalid */
      }
      reset();
      if (!opts.silent) navigate('/', { replace: true });
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
      signIn,
      signOut,
      refresh,
      setOrg,
      setUser,
      setUnread,
      clearNotice: () => setNotice(null),
    }),
    [status, user, org, ai, unread, notice, signIn, signOut, refresh]
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

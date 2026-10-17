import React, { useEffect, useSyncExternalStore } from 'react';

/**
 * Minimal History-API router — real URLs (deep links, back button, sharing)
 * without a dependency. Pages read params with `matchPath` and the query with
 * `useLocation().query`.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const snapshot = () => window.location.pathname + window.location.search;
const pathOf = (url: string) => new URL(url, window.location.href).pathname;

// ------------------------------------------------------------ leave guard
/*
 * A page with unsaved edits calls `useLeaveGuard(dirty)`. Moving to another
 * page of the app (link, button, Back/Forward) then asks first through
 * <LeaveGuardDialog>, and closing or reloading the tab gets the browser's own
 * prompt. Query-only changes (filters, the open candidate) never ask; system
 * moves (session ended, sign-out done, redirects, after a save) pass `force`.
 */
const guards = new Set<symbol>();
let pendingLeave: ((ok: boolean) => void) | null = null;
const leaveListeners = new Set<Listener>();
const emitLeave = () => leaveListeners.forEach((l) => l());

/** Resolves true when nothing unsaved would be lost — or once the person agrees to leave. */
export function requestLeave(): Promise<boolean> {
  if (!guards.size) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    pendingLeave?.(false); // a newer question replaces one still on screen
    pendingLeave = resolve;
    emitLeave();
  });
}

function answerLeave(ok: boolean) {
  const resolve = pendingLeave;
  if (!resolve) return;
  pendingLeave = null;
  emitLeave();
  resolve(ok);
}

/** Marks the page as holding unsaved edits while `active` is true. */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const id = Symbol('unsaved');
    guards.add(id);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // some browsers only prompt with this set
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      guards.delete(id);
      window.removeEventListener('beforeunload', onBeforeUnload);
      // Nothing left to lose while the question was open: let the waiting move go
      // ahead. (A forced move — session ended — has already withdrawn the question.)
      if (!guards.size) answerLeave(true);
    };
  }, [active]);
}

const subscribeLeave = (l: Listener) => {
  leaveListeners.add(l);
  return () => leaveListeners.delete(l);
};

/** For <LeaveGuardDialog>: whether the question is open, and its two answers. */
export function useLeavePrompt() {
  const open = useSyncExternalStore(subscribeLeave, () => pendingLeave !== null, () => false);
  return { open, stay: () => answerLeave(false), leave: () => answerLeave(true) };
}

// --------------------------------------------------------------- history
// Entries made here carry their position, so a Back/Forward that has to wait
// for the question can be undone exactly (and redone once the answer is «leave»).
const idxOf = (state: unknown): number => {
  const v = (state as { hvIdx?: unknown } | null)?.hvIdx;
  return typeof v === 'number' ? v : 0;
};
let shownIdx = 0;
let shownUrl = '/';
// The popstate that follows our own history.go(): undoing, or carrying out, a held step.
let ownStep: 'undo' | 'redo' | null = null;

function onPopState(e: PopStateEvent) {
  const idx = idxOf(e.state);
  const url = snapshot();
  if (ownStep === 'undo') {
    ownStep = null; // back on the page that is still on screen
    return;
  }
  const redo = ownStep === 'redo';
  ownStep = null;
  if (typeof (e.state as { hvIdx?: unknown } | null)?.hvIdx !== 'number') {
    // An entry the router didn't make (a same-page «#section» link on the
    // landing page): number it, so later steps across it are measured right.
    shownIdx += 1;
    window.history.replaceState({ ...((e.state as object | null) ?? {}), hvIdx: shownIdx }, '');
    shownUrl = url;
    notify();
    return;
  }
  const delta = idx - shownIdx;
  if (!redo && guards.size && delta !== 0 && pathOf(url) !== pathOf(shownUrl)) {
    ownStep = 'undo';
    window.history.go(-delta);
    void requestLeave().then((ok) => {
      if (!ok) return;
      ownStep = 'redo';
      window.history.go(delta);
    });
    return;
  }
  shownIdx = idx;
  shownUrl = url;
  notify();
}

if (typeof window !== 'undefined') {
  const initial = window.history.state as { hvIdx?: unknown } | null;
  // Number the entry the app was opened on (a reload keeps its number); no URL argument keeps any #hash.
  if (typeof initial?.hvIdx !== 'number') window.history.replaceState({ ...(initial ?? {}), hvIdx: 0 }, '');
  shownIdx = idxOf(window.history.state);
  shownUrl = snapshot();
  window.addEventListener('popstate', onPopState);
}

export interface LocationState {
  pathname: string;
  search: string;
  query: URLSearchParams;
}

// The page on screen follows `shownUrl`, not the address bar: while a held
// Back/Forward is being undone the bar briefly shows the other page.
const getShownUrl = () => shownUrl;

export function useLocation(): LocationState {
  const key = useSyncExternalStore(subscribe, getShownUrl, () => '/');
  return React.useMemo(() => {
    const url = new URL(key, 'http://local');
    return { pathname: url.pathname, search: url.search, query: url.searchParams };
  }, [key]);
}

export interface NavigateOptions {
  replace?: boolean;
  keepScroll?: boolean;
  /** Skip the unsaved-changes question: session ended, sign-out done, redirects, after a save. */
  force?: boolean;
}

function go(to: string, opts: NavigateOptions) {
  const prevPath = window.location.pathname;
  const target = new URL(to, window.location.href);
  // The page already on screen (e.g. its own sidebar link): no duplicate history entry.
  if (opts.replace || target.pathname + target.search === snapshot()) window.history.replaceState({ hvIdx: shownIdx }, '', to);
  else window.history.pushState({ hvIdx: ++shownIdx }, '', to);
  shownUrl = snapshot();
  notify();
  if (!opts.keepScroll && window.location.pathname !== prevPath) {
    window.scrollTo({ top: 0 });
  }
}

export function navigate(to: string, opts: NavigateOptions = {}) {
  if (opts.force) answerLeave(false); // a question still open no longer applies
  else if (guards.size && pathOf(to) !== window.location.pathname) {
    void requestLeave().then((ok) => {
      if (ok) go(to, opts);
    });
    return;
  }
  go(to, opts);
}

/** Updates query params in place (null removes a key). */
export function setQuery(params: Record<string, string | number | null | undefined>, opts: { replace?: boolean } = { replace: true }) {
  const url = new URL(window.location.href);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') url.searchParams.delete(k);
    else url.searchParams.set(k, String(v));
  }
  navigate(url.pathname + url.search, { replace: opts.replace ?? true, keepScroll: true });
}

/** `/app/jobs/:id` vs `/app/jobs/abc` → { id: 'abc' } | null */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = pathname.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) {
      try {
        params[p[i].slice(1)] = decodeURIComponent(s[i]);
      } catch {
        return null; // malformed escape such as «%E0%A4%A» — a not-found page, not a crash
      }
    } else if (p[i] !== s[i]) return null;
  }
  return params;
}

type LinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(function Link({ to, replace, onClick, target, ...rest }, ref) {
  return (
    <a
      ref={ref}
      href={to}
      target={target}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || target === '_blank' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to, { replace });
      }}
      {...rest}
    />
  );
});

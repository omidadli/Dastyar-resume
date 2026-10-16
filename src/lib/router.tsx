import React, { useSyncExternalStore } from 'react';

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

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', notify);
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const snapshot = () => window.location.pathname + window.location.search;

export interface LocationState {
  pathname: string;
  search: string;
  query: URLSearchParams;
}

export function useLocation(): LocationState {
  const key = useSyncExternalStore(subscribe, snapshot, () => '/');
  return React.useMemo(() => {
    const url = new URL(key, 'http://local');
    return { pathname: url.pathname, search: url.search, query: url.searchParams };
  }, [key]);
}

export function navigate(to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}) {
  const prevPath = window.location.pathname;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
  if (!opts.keepScroll && new URL(to, window.location.origin).pathname !== prevPath) {
    window.scrollTo({ top: 0 });
  }
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

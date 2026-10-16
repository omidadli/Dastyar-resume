import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  /** HTTP status of the last failure (0 = network / timeout), null when none. */
  errorStatus: number | null;
  loading: boolean;
  /** Re-runs the loader; keeps showing the previous data while loading. */
  reload: () => void;
  /**
   * Background re-run (event-bus refreshes): a transient failure — network,
   * timeout, 5xx — keeps the current data on screen instead of replacing the
   * view with an error; the next refresh tries again. 4xx still surfaces.
   */
  refresh: () => void;
  setData: React.Dispatch<React.SetStateAction<T | null>>;
}

const isTransient = (status: unknown) => typeof status !== 'number' || status === 0 || status >= 500;
const sameDeps = (a: unknown[] | null, b: unknown[]) => Boolean(a && a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

/**
 * Loads data for a view and re-loads whenever `deps` change. Stale responses
 * (from an earlier deps value) are ignored, so fast filter changes never show
 * out-of-order results.
 */
export function useAsync<T>(loader: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const silentRef = useRef(false);
  /** The deps the data on screen was loaded for. */
  const dataDepsRef = useRef<unknown[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    const effectDeps = deps;
    const silent = silentRef.current;
    silentRef.current = false;
    setLoading(true);
    if (!silent) {
      setError(null);
      setErrorStatus(null);
    }
    loaderRef
      .current(controller.signal)
      .then((d) => {
        if (!alive) return;
        dataDepsRef.current = effectDeps;
        setData(d);
        setError(null);
        setErrorStatus(null);
      })
      .catch((err) => {
        if (!alive || err?.name === 'AbortError') return;
        // Only when what is on screen belongs to these very deps (not to the
        // previous filter of a change that landed in the same render).
        if (silent && sameDeps(dataDepsRef.current, effectDeps) && isTransient(err?.status)) return;
        setError(err?.message || 'دریافت اطلاعات ممکن نشد.');
        setErrorStatus(typeof err?.status === 'number' ? err.status : 0);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const refresh = useCallback(() => {
    silentRef.current = true;
    setTick((t) => t + 1);
  }, []);
  return { data, error, errorStatus, loading, reload, refresh, setData };
}

/** Debounced copy of a value (search inputs). */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return match;
}

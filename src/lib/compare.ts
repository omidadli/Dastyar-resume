import { useSyncExternalStore } from 'react';

/**
 * Comparison tray: up to 4 candidates of the SAME job opening, persisted per
 * browser so it survives navigation and reloads. Each workspace has its own
 * tray: a tab never shows candidates of another workspace (a support session,
 * or another account signed in in a second tab).
 */
export interface CompareItem {
  id: string;
  name: string;
  score: number;
  category: string;
}

interface CompareState {
  jobId: string | null;
  jobTitle: string;
  items: CompareItem[];
}

export const COMPARE_MAX = 4;
const KEY = 'hovida.compare.v2';
const LEGACY_KEY = 'hovida.compare.v1'; // one browser-wide tray, before trays were per workspace
const listeners = new Set<() => void>();
const EMPTY: CompareState = { jobId: null, jobTitle: '', items: [] };

/** The workspace (org id) of this tab's session; null while signed out. */
let scope: string | null = null;
const keyFor = (orgId: string) => `${KEY}:${orgId}`;

function load(): CompareState {
  if (!scope) return EMPTY;
  try {
    const raw = localStorage.getItem(keyFor(scope));
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.items)) return s;
    }
  } catch {
    /* ignore */
  }
  return EMPTY;
}

let state: CompareState = EMPTY;

try {
  localStorage.removeItem(LEGACY_KEY);
} catch {
  /* storage blocked */
}

/** Called by the auth provider whenever this tab's workspace changes. */
export function setCompareScope(orgId: string | null) {
  if (orgId === scope) return;
  scope = orgId;
  state = load();
  listeners.forEach((l) => l());
}

function save(next: CompareState) {
  state = next;
  if (scope) {
    try {
      localStorage.setItem(keyFor(scope), JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((l) => l());
}

export function useCompare(): CompareState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state
  );
}

export type CompareResult = 'added' | 'removed' | 'full' | 'replaced-job';

/** Toggles a candidate; switching to another job's candidate starts a new tray. */
export function toggleCompare(jobId: string, jobTitle: string, item: CompareItem): CompareResult {
  if (state.jobId === jobId && state.items.some((i) => i.id === item.id)) {
    const items = state.items.filter((i) => i.id !== item.id);
    save({ ...state, items, jobId: items.length ? jobId : null });
    return 'removed';
  }
  if (state.jobId && state.jobId !== jobId && state.items.length) {
    save({ jobId, jobTitle, items: [item] });
    return 'replaced-job';
  }
  if (state.items.length >= COMPARE_MAX) return 'full';
  save({ jobId, jobTitle, items: [...state.items, item] });
  return 'added';
}

export function removeFromCompare(...ids: string[]) {
  if (!state.items.some((i) => ids.includes(i.id))) return;
  const items = state.items.filter((i) => !ids.includes(i.id));
  save({ ...state, items, jobId: items.length ? state.jobId : null });
}

export function clearCompare() {
  save({ jobId: null, jobTitle: '', items: [] });
}

/** A deleted job opening takes its candidates out of the tray too. */
export function forgetCompareJob(jobId: string) {
  if (state.jobId === jobId) clearCompare();
}

// Keep the tabs of the same workspace in step.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!scope || e.key !== keyFor(scope)) return;
    state = load();
    listeners.forEach((l) => l());
  });
}

export function isInCompare(id: string): boolean {
  return state.items.some((i) => i.id === id);
}

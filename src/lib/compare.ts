import { useSyncExternalStore } from 'react';

/**
 * Comparison tray: up to 4 candidates of the SAME job opening, persisted per
 * browser so it survives navigation and reloads.
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
const KEY = 'hovida.compare.v1';
const listeners = new Set<() => void>();

function load(): CompareState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && Array.isArray(s.items)) return s;
    }
  } catch {
    /* ignore */
  }
  return { jobId: null, jobTitle: '', items: [] };
}

let state: CompareState = load();

function save(next: CompareState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
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

export function removeFromCompare(id: string) {
  const items = state.items.filter((i) => i.id !== id);
  save({ ...state, items, jobId: items.length ? state.jobId : null });
}

export function clearCompare() {
  save({ jobId: null, jobTitle: '', items: [] });
}

export function isInCompare(id: string): boolean {
  return state.items.some((i) => i.id === id);
}

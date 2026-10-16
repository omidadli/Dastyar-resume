import React, { createContext, useContext, useEffect, useState } from 'react';
import type { PublicConfig } from '../types/admin';
import { api, MAINTENANCE_EVENT } from './api';

/**
 * Public switches set by the platform admin (/admin › تنظیمات سامانه):
 * sign-up / demo availability, the announcement banner, maintenance mode and
 * upload limits. Fetched at start-up and refreshed every two minutes.
 */
export const DEFAULT_PUBLIC_CONFIG: PublicConfig = {
  demo: true,
  demoHours: 24,
  signup: true,
  announcement: null,
  maintenance: null,
  maxFileMb: 20,
  maxFilesPerBatch: 500,
  supportEmail: '',
};

let current: PublicConfig = DEFAULT_PUBLIC_CONFIG;
const listeners = new Set<(c: PublicConfig) => void>();

/** For non-React modules (upload runner, extractors). */
export function getPublicConfig(): PublicConfig {
  return current;
}

let inflight: Promise<void> | null = null;

export function refreshPublicConfig(): Promise<void> {
  if (inflight) return inflight;
  inflight = api.auth
    .config()
    .then((c) => {
      current = { ...DEFAULT_PUBLIC_CONFIG, ...c };
      listeners.forEach((fn) => fn(current));
    })
    .catch(() => {
      /* keep the last known values */
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const ConfigCtx = createContext<PublicConfig>(DEFAULT_PUBLIC_CONFIG);

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<PublicConfig>(current);
  useEffect(() => {
    listeners.add(setConfig);
    void refreshPublicConfig();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshPublicConfig();
    }, 120_000);
    const onFocus = () => void refreshPublicConfig();
    window.addEventListener('focus', onFocus);
    window.addEventListener(MAINTENANCE_EVENT, onFocus);
    return () => {
      listeners.delete(setConfig);
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener(MAINTENANCE_EVENT, onFocus);
    };
  }, []);
  return <ConfigCtx.Provider value={config}>{children}</ConfigCtx.Provider>;
}

export function usePublicConfig(): PublicConfig {
  return useContext(ConfigCtx);
}

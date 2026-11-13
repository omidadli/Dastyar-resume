/**
 * «نصب روی دستگاه» — the honest version of «اپلیکیشن».
 *
 * HOVIDA is a web app, and a web app can be installed: an icon on the home
 * screen, full screen without the browser bar, and a Persian offline page when
 * the connection drops. What it does *not* pretend to be: an App Store or Google
 * Play listing, background push, or offline access to candidates — none of that
 * exists, so none of it is promised in the UI.
 */
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

// The event fires once, often before React mounts — keep it at module level.
let deferred: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const listeners = new Set<(available: boolean) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    listeners.forEach((fn) => fn(true));
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedThisSession = true;
    listeners.forEach((fn) => fn(false));
  });
}

export function registerServiceWorker() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* an install failure must never break the app */
    });
  });
}

export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true;
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && (navigator as any).maxTouchPoints > 1);
}

export interface InstallState {
  /** The browser offered an install prompt and we kept it. */
  canInstall: boolean;
  /** Already running as the installed app. */
  installed: boolean;
  /** iOS has no prompt: the user must use «افزودن به صفحهٔ اصلی». */
  ios: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallApp(): InstallState {
  const [canInstall, setCanInstall] = useState(Boolean(deferred));
  const [installed, setInstalled] = useState(isStandalone() || installedThisSession);

  useEffect(() => {
    const onChange = (available: boolean) => setCanInstall(available);
    listeners.add(onChange);
    setCanInstall(Boolean(deferred));
    setInstalled(isStandalone() || installedThisSession);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const promptInstall = async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable';
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      deferred = null;
      listeners.forEach((fn) => fn(false));
      if (choice.outcome === 'accepted') setInstalled(true);
      return choice.outcome;
    } catch {
      return 'unavailable';
    }
  };

  return { canInstall, installed, ios: isIos(), promptInstall };
}

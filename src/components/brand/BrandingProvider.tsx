/**
 * «هویت سازمانی» on the client.
 *
 * `BrandingProvider` fetches the signed-in workspace's identity once, then writes
 * its CSS custom properties onto `<html data-hv-theme>`. Because the design system
 * is built on those variables, *every* screen inside the panel — buttons, tables,
 * charts, focus rings, the sidebar — picks up the company's colours without a
 * single component knowing this feature exists.
 *
 * Three details that matter in production:
 *   • the variables are removed on sign-out, so the login screen of the next
 *     person is never tinted with the previous company's colour;
 *   • the tab icon and title follow the workspace (a person with three HOVIDA
 *     tabs open can tell them apart);
 *   • a custom theme is *additive*: an empty workspace keeps HOVIDA exactly as
 *     designed, with no flash of green before the fetch resolves.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import { brandName, brandTerms, isBranded } from '../../lib/brand';
import { DEFAULT_BRANDING, type BrandTerms, type BrandingPayload, type OrgBranding } from '../../types/branding';

interface BrandingContextValue {
  branding: OrgBranding;
  tokens: Record<string, string>;
  warnings: string[];
  isCustom: boolean;
  loading: boolean;
  /** What the panel calls itself: nickname → workspace name → «هویدا». */
  appName: string;
  /** «کارجو / فرصت شغلی / مصاحبه / پیشنهاد شغلی», renamed if the company did. */
  terms: BrandTerms;
  reload: () => Promise<void>;
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

/** Variables we set, so we can remove exactly ours and nothing else. */
const APPLIED = new Set<string>();
let savedFavicon: string | null = null;
let savedTitle: string | null = null;

function applyTokens(vars: Record<string, string>) {
  const root = document.documentElement;
  for (const key of Object.keys(vars)) {
    root.style.setProperty(key, vars[key]);
    APPLIED.add(key);
  }
  root.setAttribute('data-hv-theme', 'branded');
}

function clearTokens() {
  const root = document.documentElement;
  for (const key of APPLIED) root.style.removeProperty(key);
  APPLIED.clear();
  root.removeAttribute('data-hv-theme');
  if (savedFavicon !== null) {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link) link.href = savedFavicon;
    savedFavicon = null;
  }
  if (savedTitle !== null) {
    document.title = savedTitle;
    savedTitle = null;
  }
}

function applyFavicon(branding: OrgBranding) {
  const icon = branding.markDataUrl || branding.logoDataUrl;
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (savedFavicon === null) savedFavicon = link.getAttribute('href') || '';
  if (icon) link.href = icon;
  else link.href = savedFavicon;
}

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const { org } = useAuth();
  const orgId = org?.id || null;
  const [state, setState] = useState<BrandingPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    if (!orgId) {
      setState(null);
      return;
    }
    const id = ++requestId.current;
    setLoading(true);
    try {
      const data = await api.branding.get();
      if (id === requestId.current) setState(data);
    } catch {
      /* offline: keep the identity we already have on screen */
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The identity the panel is painted with: the fetched one, or — between
  // sign-in and the response — the copy that came with `/api/auth/me`.
  const branding: OrgBranding = useMemo(() => {
    if (state?.branding) return state.branding;
    if (org?.branding) return org.branding;
    return DEFAULT_BRANDING;
  }, [state, org?.branding]);

  const tokens = useMemo(() => state?.tokens || {}, [state]);
  const custom = isBranded(branding);

  useEffect(() => {
    if (!orgId || !state) return;
    if (!custom) {
      clearTokens();
      return;
    }
    applyTokens(state.tokens);
    if (branding.theme === 'dark') document.documentElement.classList.add('hv-dark');
    else document.documentElement.classList.remove('hv-dark');
    applyFavicon(branding);
    if (savedTitle === null) savedTitle = document.title;
    const name = brandName(branding, org?.name);
    document.title = document.title.replace(/هویدا/g, name);
    return () => {
      if (branding.theme === 'dark') document.documentElement.classList.remove('hv-dark');
    };
  }, [orgId, state, custom, branding, org?.name]);

  useEffect(() => {
    if (!orgId) clearTokens();
  }, [orgId]);

  const value = useMemo<BrandingContextValue>(
    () => ({
      branding,
      tokens,
      warnings: state?.warnings || [],
      isCustom: custom,
      loading,
      appName: brandName(branding, org?.name),
      terms: brandTerms(branding),
      reload: load,
    }),
    [branding, tokens, state, custom, loading, org?.name, load]
  );

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

/** Inside the panel this always resolves; on public pages it falls back to HOVIDA. */
export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (ctx) return ctx;
  return {
    branding: DEFAULT_BRANDING,
    tokens: {},
    warnings: [],
    isCustom: false,
    loading: false,
    appName: 'هویدا',
    terms: brandTerms(DEFAULT_BRANDING),
    reload: async () => {},
  };
}

/** Apply another workspace's identity to one element (the editor's live preview). */
export function PreviewScope({ tokens, children }: { tokens: Record<string, string>; children: React.ReactNode }) {
  return (
    <div style={tokens as React.CSSProperties} className="hv-preview-scope">
      {children}
    </div>
  );
}

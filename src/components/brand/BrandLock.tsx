/**
 * What sits in the top corner of every screen: the company's own logo when it
 * uploaded one, otherwise the workspace name set in HOVIDA's typography, and
 * only when neither exists does HOVIDA's own logo appear.
 *
 * The image is a data-URI in the tenant's record, so there is no extra request
 * and nothing to break if object storage is unavailable.
 */
import React from 'react';
import { HovidaLogo, HovidaMark } from './Logo';
import { useBranding } from './BrandingProvider';
import { useAuth } from '../../lib/auth';

type LockSize = 'desktop' | 'mobile' | 'auth';

export function BrandLock({ size = 'desktop', className = '' }: { size?: LockSize; className?: string }) {
  const { branding, appName } = useBranding();
  const { org } = useAuth();
  const darkSidebar = branding.sidebar === 'dark' || branding.theme === 'dark';
  const height = size === 'mobile' ? Math.round(branding.logoHeight * 0.88) : branding.logoHeight;

  if (branding.logoDataUrl) {
    return (
      <img
        src={branding.logoDataUrl}
        alt={appName}
        style={{ height, maxWidth: size === 'mobile' ? 150 : 210 }}
        className={`w-auto object-contain ${className}`}
      />
    );
  }

  // No logo, but the workspace *did* give itself a name: set it as a wordmark
  // so the panel never claims to be HOVIDA when it is not.
  if (branding.nickname && org?.name) {
    return (
      <span
        className={`inline-flex items-center gap-2 min-w-0 ${className}`}
        title={branding.nickname}
      >
        <BrandMark size={size === 'mobile' ? 26 : 30} />
        <span
          className={`font-extrabold tracking-tight truncate ${darkSidebar ? 'text-white' : 'text-ink'}`}
          style={{ fontSize: size === 'mobile' ? 15 : 17 }}
        >
          {appName}
        </span>
      </span>
    );
  }

  return size === 'mobile' ? <HovidaMark size={30} /> : <HovidaLogo height={34} />;
}

/** The square mark: uploaded icon, a monogram of the nickname, or HOVIDA's. */
export function BrandMark({ size = 30, className = '' }: { size?: number; className?: string }) {
  const { branding, appName } = useBranding();
  const src = branding.markDataUrl || branding.logoDataUrl;
  if (src) {
    return <img src={src} alt={appName} width={size} height={size} style={{ width: size, height: size }} className={`rounded-[9px] object-contain ${className}`} />;
  }
  if (branding.nickname) {
    const letter = appName.trim().charAt(0) || 'ه';
    return (
      <span
        aria-hidden
        style={{ width: size, height: size, fontSize: Math.round(size * 0.48) }}
        className="inline-flex items-center justify-center rounded-[9px] bg-brand-strong text-white font-extrabold shrink-0"
      >
        {letter}
      </span>
    );
  }
  return <HovidaMark size={size} />;
}

/** The «ساخته‌شده با هویدا» line; disappears when the workspace went white-label. */
export function BrandCredit({ className = '' }: { className?: string }) {
  const { branding } = useBranding();
  if (!branding.showHovidaCredit) return null;
  return (
    <a
      href="/"
      className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium text-ink-4 hover:text-ink-2 transition-colors ${className}`}
    >
      ساخته‌شده با
      <span className="font-extrabold text-ink-3">هویدا</span>
    </a>
  );
}

/**
 * «هویت سازمانی» — the API that lets one workspace repaint its own panel.
 *
 *   GET  /api/org/branding   every member: what this workspace looks like + tokens
 *   PUT  /api/org/branding   admins: save the identity (validated, never crashes the UI)
 *   POST /api/org/branding/reset  admins: back to HOVIDA's own identity
 *
 * Only two things are validated strictly, because they end up in the DOM: the
 * image data-URIs (a strict mime allow-list + size cap) and the colours (real
 * hex). Everything else is a bounded string or an enum, so a malformed payload
 * can never make a workspace's panel unreadable.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import { BRAND_PRESETS, DEFAULT_BRANDING, LANDING_KEYS, NAV_KEYS, type OrgBranding } from '../../src/types/branding';
import { brandTokens, isBranded, isHex, normalizeHex } from '../../src/lib/brand';
import { str } from './util';

const LOGO_MAX = 512 * 1024; // characters of data-URI ≈ 384 KB of image
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'];
const DATA_URI = /^data:([a-z0-9.+/-]+);base64,[A-Za-z0-9+/=\s]+$/i;

class BrandError extends Error {
  constructor(
    message: string,
    readonly field: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function image(value: unknown, field: string, max = LOGO_MAX): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new BrandError('فایل تصویر قابل خواندن نیست.', field);
  if (value.length > max) {
    throw new BrandError(`حجم تصویر بیش از حد مجاز است (حداکثر ${Math.round(max / 1024)} کیلوبایت).`, field, 413);
  }
  const match = DATA_URI.exec(value);
  if (!match) throw new BrandError('تصویر باید به‌صورت data-URI وارد شود.', field);
  if (!IMAGE_MIMES.includes(match[1].toLowerCase())) {
    throw new BrandError('فقط PNG، JPEG، WebP، ICO یا SVG مجاز است.', field);
  }
  // Inline SVG can carry script. Base64 hides it from a plain regex, so decode
  // first and refuse anything with script, an event handler or a javascript: URL.
  if (/svg/i.test(match[1])) {
    const payload = value.slice(value.indexOf(',') + 1);
    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    if (/<script|<foreignObject|javascript:|\son[a-z]+\s*=/i.test(decoded)) {
      throw new BrandError('این SVG کد اجرایی دارد؛ نسخهٔ سادهٔ آن را بارگذاری کنید.', field);
    }
    if (!/<svg[\s>]/i.test(decoded)) throw new BrandError('فایل SVG سالم نیست.', field);
  }
  return value;
}

function color(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isHex(value)) throw new BrandError('کد رنگ باید در قالب #RRGGBB باشد.', field);
  return normalizeHex(value);
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function text(value: unknown, max: number, fallback = ''): string {
  const v = str(value, max);
  return v || fallback;
}

/** Turn a request body into a complete, safe identity. */
export function validateBranding(raw: any): OrgBranding {
  if (!raw || typeof raw !== 'object') throw new BrandError('دادهٔ هویت بصری خالی است.', 'branding');
  const base = DEFAULT_BRANDING;
  const sidebarWidth = Math.min(296, Math.max(224, Math.round(Number(raw.sidebarWidth) || base.sidebarWidth)));
  const logoHeight = Math.min(64, Math.max(18, Math.round(Number(raw.logoHeight) || base.logoHeight)));
  return {
    nickname: text(raw.nickname, 40),
    logoDataUrl: image(raw.logoDataUrl, 'logoDataUrl'),
    logoHeight,
    markDataUrl: image(raw.markDataUrl, 'markDataUrl', 128 * 1024),
    colors: {
      brand: color(raw.colors?.brand, 'colors.brand'),
      accent: color(raw.colors?.accent, 'colors.accent'),
    },
    sidebar: pick(raw.sidebar, ['light', 'tinted', 'dark'] as const, base.sidebar),
    sidebarWidth,
    theme: pick(raw.theme, ['light', 'dark'] as const, base.theme),
    radius: pick(raw.radius, ['sharp', 'soft', 'round'] as const, base.radius),
    font: pick(raw.font, ['vazirmatn', 'system'] as const, base.font),
    login: {
      title: text(raw.login?.title, 90, base.login.title),
      subtitle: text(raw.login?.subtitle, 160, base.login.subtitle),
      background: pick(raw.login?.background, ['gradient', 'plain', 'mesh'] as const, base.login.background),
    },
    portal: {
      heading: text(raw.portal?.heading, 90),
      coverDataUrl: image(raw.portal?.coverDataUrl, 'portal.coverDataUrl', 768 * 1024),
    },
    nav: {
      hidden: Array.isArray(raw.nav?.hidden)
        ? (NAV_KEYS as readonly string[]).filter((k) => raw.nav.hidden.includes(k))
        : [],
      // A label is only kept for a real key, and never as an empty string.
      labels: Object.fromEntries(
        Object.entries(raw.nav?.labels && typeof raw.nav.labels === 'object' ? raw.nav.labels : {})
          .filter(([k, v]) => (NAV_KEYS as readonly string[]).includes(k) && typeof v === 'string' && v.trim())
          .map(([k, v]) => [k, str(v, 34)])
      ),
    },
    landing: (LANDING_KEYS as readonly string[]).includes(raw.landing) ? raw.landing : base.landing,
    terms: {
      candidate: text(raw.terms?.candidate, 30, base.terms.candidate),
      job: text(raw.terms?.job, 30, base.terms.job),
      interview: text(raw.terms?.interview, 30, base.terms.interview),
      offer: text(raw.terms?.offer, 30, base.terms.offer),
    },
    showHovidaCredit: raw.showHovidaCredit === undefined ? base.showHovidaCredit : Boolean(raw.showHovidaCredit),
    updatedAtISO: null,
    updatedByName: null,
    presetId: typeof raw.presetId === 'string' ? raw.presetId.slice(0, 40) : null,
  };
}

export function brandingPayload(org: { branding?: OrgBranding | null }) {
  const branding = org.branding || DEFAULT_BRANDING;
  const { vars, warnings } = brandTokens(branding);
  const custom = isBranded(branding);
  return {
    branding,
    // An unbranded workspace gets no overrides at all — the panel is HOVIDA's
    // own, byte for byte, not a re-derivation that might drift from the design.
    tokens: custom ? vars : {},
    warnings,
    presets: BRAND_PRESETS,
    isCustom: custom,
  };
}

export function brandingRoutes(): express.Router {
  const r = express.Router();

  r.get('/org/branding', (req, res) => {
    const { org } = ctxOf(req);
    res.json(brandingPayload(org));
  });

  r.put(
    '/org/branding',
    requireRole('admin'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      let next: OrgBranding;
      try {
        next = validateBranding(req.body);
      } catch (err) {
        if (!(err instanceof BrandError)) throw err;
        return res.status(err.status).json({ error: err.message, field: err.field, code: 'BRANDING_INVALID' });
      }
      const before = JSON.stringify(org.branding ? brandTokens(org.branding).vars : null);
      const payload = { ...next, updatedAtISO: new Date().toISOString(), updatedByName: user.name || null };
      const updated = db.updateOrg(org.id, { branding: payload });
      // One line per real change — not per keystroke in the editor.
      if (before !== JSON.stringify(brandTokens(payload).vars)) {
        db.logActivity(org.id, actorOf(req), 'settings.changed', '«هویت سازمانی» را به‌روز کرد');
      }
      if (org.careerSlug && isBranded(payload)) {
        // Nothing leaves here: only a note so the activity feed tells the whole story.
        db.logActivity(org.id, actorOf(req), 'settings.changed', 'ظاهر صفحهٔ استخدام عمومی را با هویت سازمانی هم‌تراز کرد');
      }
      res.json({ ...brandingPayload(updated || { branding: payload }) });
    }
  );

  r.post('/org/branding/reset', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const updated = db.updateOrg(org.id, {
      branding: { ...DEFAULT_BRANDING, updatedAtISO: new Date().toISOString(), updatedByName: null },
    });
    db.logActivity(org.id, actorOf(req), 'settings.changed', '«هویت سازمانی» را به حالت پیش‌فرض هویدا بازگرداند');
    res.json(brandingPayload(updated || {}));
  });

  return r;
}

/** What the public career page and the login screen may show. */
export function publicBrandingOf(org: { branding?: OrgBranding | null }) {
  const b = org.branding || DEFAULT_BRANDING;
  if (!isBranded(b)) return null;
  return {
    logoDataUrl: b.logoDataUrl,
    markDataUrl: b.markDataUrl,
    logoHeight: b.logoHeight,
    colors: b.colors,
    theme: b.theme,
    radius: b.radius,
    font: b.font,
    nickname: b.nickname,
    login: b.login,
    portal: { heading: b.portal.heading, coverDataUrl: b.portal.coverDataUrl },
    tokens: brandTokens(b).vars,
  };
}

/**
 * «هویت سازمانی» — the colour maths behind a workspace's theme.
 *
 * A customer picks *one* brand colour. Everything else is derived here so the
 * product stays readable: a pale yellow brand cannot end up as white text on a
 * button, and a dark navy brand cannot end up as text on a dark panel. Each
 * shade is computed by walking lightness until WCAG AA contrast is met, and the
 * editor tells the customer when we had to change something.
 *
 * Pure functions only — the server validates with them, the browser paints with
 * them, and the settings preview uses the very same object as the real panel.
 */
import {
  DEFAULT_BRANDING,
  type BrandFont,
  type BrandRadius,
  type BrandTerms,
  type OrgBranding,
} from '../types/branding';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isHex(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value.trim());
}

export function normalizeHex(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toUpperCase();
  }
  return v.toUpperCase();
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = normalizeHex(isHex(hex) ? hex : '#000000').slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rr) h = ((gg - bb) / d) % 6;
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const ss = Math.max(0, Math.min(100, s)) / 100;
  const ll = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = ll - c / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

export function hexToHsl(hex: string): Hsl {
  return rgbToHsl(hexToRgb(hex));
}

export function hslToHex(hsl: Hsl): string {
  return rgbToHex(hslToRgb(hsl));
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** t = how much of `b` ends up in the mix (0 = only a, 1 = only b). */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  return rgbToHex({ r: ca.r + (cb.r - ca.r) * k, g: ca.g + (cb.g - ca.g) * k, b: ca.b + (cb.b - ca.b) * k });
}

/**
 * Walks lightness (away from `bg`) until `color` has at least `min` contrast
 * against it. Returns the original colour when it already passes.
 */
export function ensureContrast(color: string, bg: string, min: number): string {
  if (contrast(color, bg) >= min) return normalizeHex(color);
  const hsl = hexToHsl(color);
  const bgLum = luminance(bg);
  // Darken on a light background, lighten on a dark one.
  const step = bgLum > 0.35 ? -2 : 2;
  let l = hsl.l;
  for (let i = 0; i < 60; i++) {
    l += step;
    if (l <= 2 || l >= 98) break;
    const candidate = hslToHex({ ...hsl, l });
    if (contrast(candidate, bg) >= min) return candidate;
  }
  return bgLum > 0.35 ? '#111111' : '#FFFFFF';
}

export const RRADII: Record<BrandRadius, { control: string; card: string }> = {
  sharp: { control: '6px', card: '8px' },
  soft: { control: '10px', card: '14px' },
  round: { control: '14px', card: '20px' },
};

const FONT_STACKS: Record<BrandFont, string> = {
  vazirmatn: "'Inter Latin', 'Vazirmatn', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif",
  system: "'Inter Latin', Tahoma, 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
};

/** The dark panel is HOVIDA's own, not an inversion of the customer's colour. */
const DARK = {
  canvas: '#0F1412',
  surface: '#171D1A',
  ink: '#E8EEE9',
  ink2: '#B7C2BB',
  ink3: '#98A49C',
  ink4: '#8A968E',
  line: '#2A3430',
  line2: '#212A27',
  lineStrong: '#3B4742',
  highSoft: '#12301E',
  highInk: '#5FD37F',
  reviewSoft: '#302311',
  reviewInk: '#F2B44C',
  lowSoft: '#361717',
  lowInk: '#F2969A',
  naSoft: '#1E2523',
  naInk: '#A8B4BD',
};

export interface BrandTokens {
  vars: Record<string, string>;
  warnings: string[];
}

function sidebarVars(branding: OrgBranding, brandTint: string, brandSoft: string, brandStrong: string) {
  const { sidebar, colors } = branding;
  if (sidebar === 'dark') {
    const bg = mix(colors.accent, '#101614', 0.86);
    return {
      '--hv-sidebar-bg': bg,
      '--hv-sidebar-ink': '#E9EFEC',
      '--hv-sidebar-ink-2': mix('#E9EFEC', bg, 0.35),
      '--hv-sidebar-muted': mix('#E9EFEC', bg, 0.55),
      '--hv-sidebar-border': mix(colors.brand, bg, 0.82),
      '--hv-sidebar-hover': mix('#FFFFFF', bg, 0.92),
      '--hv-sidebar-active': mix(colors.brand, bg, 0.72),
      '--hv-sidebar-logo': '#FFFFFF',
    };
  }
  if (sidebar === 'tinted') {
    return {
      '--hv-sidebar-bg': brandTint,
      '--hv-sidebar-ink': 'var(--color-ink)',
      '--hv-sidebar-ink-2': 'var(--color-ink-2)',
      '--hv-sidebar-muted': 'var(--color-ink-4)',
      '--hv-sidebar-border': brandSoft,
      '--hv-sidebar-hover': brandSoft,
      '--hv-sidebar-active': brandSoft,
      '--hv-sidebar-logo': 'inherit',
    };
  }
  return {
    '--hv-sidebar-bg': 'var(--color-surface)',
    '--hv-sidebar-ink': 'var(--color-ink)',
    '--hv-sidebar-ink-2': 'var(--color-ink-2)',
    '--hv-sidebar-muted': 'var(--color-ink-4)',
    '--hv-sidebar-border': 'var(--color-line)',
    '--hv-sidebar-hover': 'var(--color-line-2)',
    '--hv-sidebar-active': 'var(--color-brand-soft)',
    '--hv-sidebar-logo': 'inherit',
  };
}

/**
 * Every CSS custom property the panel needs for one workspace's identity.
 * Keys are the *real* variables used by the design system (`--color-brand` …),
 * so applying this object really repaints the product.
 */
export function brandTokens(branding: OrgBranding = DEFAULT_BRANDING): BrandTokens {
  const warnings: string[] = [];
  const brand = normalizeHex(isHex(branding.colors.brand) ? branding.colors.brand : DEFAULT_BRANDING.colors.brand);
  const accent = normalizeHex(isHex(branding.colors.accent) ? branding.colors.accent : DEFAULT_BRANDING.colors.accent);
  const dark = branding.theme === 'dark';
  const surface = dark ? DARK.surface : '#FFFFFF';

  // Buttons carry white text, so the button colour must reach 4.5:1 against it.
  const brandStrong = ensureContrast(brand, '#FFFFFF', 4.5);
  if (brandStrong !== brand) {
    warnings.push(
      `رنگ انتخابی روی دکمه‌ها با متن سفید خوانا نبود؛ برای دکمه‌ها نسخهٔ تیره‌تر ${brandStrong} استفاده شد.`
    );
  }
  const brandStronger = ensureContrast(mix(brandStrong, '#000000', 0.14), '#FFFFFF', 6);
  const brandInk = ensureContrast(brand, surface, 4.5);
  const brandSoft = dark ? mix(brand, DARK.surface, 0.78) : mix(brand, '#FFFFFF', 0.88);
  const brandTint = dark ? mix(brand, DARK.surface, 0.9) : mix(brand, '#FFFFFF', 0.95);

  const radius = RRADII[branding.radius] || RRADII.soft;
  const vars: Record<string, string> = {
    '--color-brand': brand,
    '--color-brand-strong': brandStrong,
    '--color-brand-stronger': brandStronger,
    '--color-brand-ink': brandInk,
    '--color-brand-soft': brandSoft,
    '--color-brand-tint': brandTint,
    '--color-accent': accent,
    '--font-sans': FONT_STACKS[branding.font] || FONT_STACKS.vazirmatn,
    '--radius-card': radius.card,
    '--radius-control': radius.control,
    '--hv-sidebar-w': `${Math.max(224, Math.min(296, Math.round(branding.sidebarWidth) || 256))}px`,
    ...sidebarVars(branding, brandTint, brandSoft, brandStrong),
  };

  if (dark) {
    Object.assign(vars, {
      '--color-canvas': DARK.canvas,
      '--color-surface': DARK.surface,
      '--color-ink': DARK.ink,
      '--color-ink-2': DARK.ink2,
      '--color-ink-3': DARK.ink3,
      '--color-ink-4': DARK.ink4,
      '--color-line': DARK.line,
      '--color-line-2': DARK.line2,
      '--color-line-strong': DARK.lineStrong,
      '--color-high-soft': DARK.highSoft,
      '--color-high-ink': DARK.highInk,
      '--color-review-soft': DARK.reviewSoft,
      '--color-review-ink': DARK.reviewInk,
      '--color-low-soft': DARK.lowSoft,
      '--color-low-ink': DARK.lowInk,
      '--color-na-soft': DARK.naSoft,
      '--color-na-ink': DARK.naInk,
    });
    // The sidebar in a dark panel must not be a bright island.
    if (branding.sidebar === 'light') {
      vars['--hv-sidebar-bg'] = mix(DARK.surface, '#FFFFFF', 0.03);
      vars['--hv-sidebar-border'] = DARK.line;
    }
  }

  // A brand colour that is itself nearly the panel background is a warning, not a crash.
  if (contrast(brand, surface) < 1.25) {
    warnings.push('رنگ برند با پس‌زمینهٔ پنل تقریباً یکی است؛ دکمه‌ها را دیدیم و متن‌ها را اصلاح کردیم، ولی رنگ روشن‌تر/تیره‌تری بهتر دیده می‌شود.');
  }

  return { vars, warnings };
}

/** React `style` object for scoping the tokens to one element (the live preview). */
export function brandStyle(branding: OrgBranding): Record<string, string> {
  return brandTokens(branding).vars;
}

/** The name this workspace calls the product inside the panel. */
export function brandName(branding: OrgBranding | null | undefined, orgName?: string | null): string {
  const nick = (branding?.nickname || '').trim();
  if (nick) return nick;
  return orgName?.trim() || 'هویدا';
}

/** The four nouns, falling back to HOVIDA's own words. */
export function brandTerms(branding: OrgBranding | null | undefined): BrandTerms {
  const t = branding?.terms || DEFAULT_BRANDING.terms;
  const safe = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);
  return {
    candidate: safe(t.candidate, 'کارجو'),
    job: safe(t.job, 'فرصت شغلی'),
    interview: safe(t.interview, 'مصاحبه'),
    offer: safe(t.offer, 'پیشنهاد شغلی'),
  };
}

/** Where a person lands after signing in, as a real route. */
export const LANDING_PATH: Record<string, string> = {
  dashboard: '/app',
  approvals: '/app/approvals',
  jobs: '/app/jobs',
  candidates: '/app/candidates',
  reports: '/app/reports',
  talent: '/app/talent',
  sourcing: '/app/sourcing',
};

export function landingPath(branding: OrgBranding | null | undefined): string {
  const key = branding?.landing || 'dashboard';
  return LANDING_PATH[key] || '/app';
}

/** True when the workspace changed anything from HOVIDA's own identity. */
export function isBranded(branding: OrgBranding | null | undefined): boolean {
  if (!branding) return false;
  const a = JSON.stringify({ ...branding, updatedAtISO: null, updatedByName: null });
  const b = JSON.stringify({ ...DEFAULT_BRANDING, updatedAtISO: null, updatedByName: null });
  return a !== b;
}

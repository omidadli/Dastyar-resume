/**
 * «هویت سازمانی» — how a workspace wants its own panel to look.
 *
 * HOVIDA ships one design system (tokens, not screenshots). A company that signs
 * up can re-point that system at its own identity: logo, mark (favicon), two
 * colours, corner radius, font stack, sidebar style and width, light/dark, the
 * words used for «کارجو/فرصت شغلی/…», the product name inside the panel, the
 * login screen copy and the public portal's cover.
 *
 * Two rules keep this honest rather than a colour picker on a marketing page:
 *   • every knob here is *wired* — the panel really changes, not just a preview;
 *   • the colours are a contract, not a free-for-all: the darker/lighter shades
 *     used for text and buttons are derived so a chosen brand colour can never
 *     make a button unreadable (see `src/lib/brand.ts`).
 */

export type BrandSidebar = 'light' | 'tinted' | 'dark';
export type BrandTheme = 'light' | 'dark';
export type BrandRadius = 'sharp' | 'soft' | 'round';
export type BrandFont = 'vazirmatn' | 'system';
export type BrandLoginBg = 'gradient' | 'plain' | 'mesh';

export interface BrandColors {
  /** The primary brand colour; every derived shade comes from it. */
  brand: string;
  /** Secondary colour: login/portal gradient, decorative accents. */
  accent: string;
}

export interface BrandLogin {
  title: string;
  subtitle: string;
  background: BrandLoginBg;
}

export interface BrandPortal {
  heading: string;
  /** Wide cover image on the public career page (`/careers/<slug>`). */
  coverDataUrl: string | null;
}

/** The four nouns a Persian HR team most often wants to rename. */
export interface BrandTerms {
  candidate: string;
  job: string;
  interview: string;
  offer: string;
}

/**
 * What every letter we send on the company's behalf looks like.
 *
 * E-mail is not a web page: clients strip styles, block data-URI images and
 * ignore modern layout. So this block is deliberately small — the things that
 * survive an inbox — and the renderer (server/mail-brand.ts) draws them with
 * table-based HTML and an *attached* logo, which Gmail and Outlook both show.
 */
export interface BrandEmail {
  /** Closing line, e.g. «با احترام، واحد منابع انسانی». Empty = nothing added. */
  signoff: string;
  /** Small print in the footer: address, phone, the company's own notice. */
  footerNote: string;
  /** The logo in the letter header (attached inline, never a data-URI). */
  includeLogo: boolean;
}

/** What a workspace wants on its dashboard — and what it would rather not see. */
export const DASHBOARD_CARDS = [
  { id: 'kpis', label: 'چهار عدد اصلی', hint: 'فرصت‌های باز، رزومه‌های تحلیل‌شده، در انتظار تصمیم، تطابق بالا' },
  { id: 'pending', label: 'در انتظار تصمیم شما', hint: 'فهرست کاندیداهایی که تصمیمشان مانده' },
  { id: 'timeSaved', label: 'زمان صرفه‌جویی‌شده', hint: 'برآورد ساعتی که با تحلیل خودکار برگشته' },
  { id: 'activity', label: 'فعالیت تیم', hint: 'آخرین رویدادهای فضای کاری' },
  { id: 'aiNote', label: 'یادداشت وضعیت هوش مصنوعی', hint: 'وقتی موتور محلی کار می‌کند یا AI خاموش است' },
  { id: 'onboarding', label: 'راهنمای سه‌قدمی شروع', hint: 'فقط در فضای کاری تازه دیده می‌شود' },
] as const;

export type DashboardCard = (typeof DASHBOARD_CARDS)[number]['id'];

/** The panel's own navigation: renamed items, and the ones this team never uses. */
export interface BrandNav {
  /** Keys from `NAV_KEYS` the workspace chose to hide. */
  hidden: string[];
  /** Key → the words this workspace uses, e.g. `jobs` → «آگهی‌های استخدام». */
  labels: Record<string, string>;
}

/** Every navigation item that may be renamed or hidden — stable keys, not paths. */
export const NAV_KEYS = [
  'dashboard',
  'approvals',
  'jobs',
  'candidates',
  'sourcing',
  'automation',
  'video',
  'onboarding',
  'payroll',
  'talent',
  'reports',
  'settings',
] as const;

export type NavKey = (typeof NAV_KEYS)[number];

/** Where a person lands after signing in. */
export const LANDING_KEYS = ['dashboard', 'approvals', 'jobs', 'candidates', 'reports', 'talent', 'sourcing'] as const;
export type LandingKey = (typeof LANDING_KEYS)[number];

export interface OrgBranding {
  /** What the panel calls itself, e.g. «سامانهٔ استخدام آوا». */
  nickname: string;
  logoDataUrl: string | null;
  logoHeight: number;
  /** Square mark: browser tab icon and the compact header. */
  markDataUrl: string | null;
  colors: BrandColors;
  sidebar: BrandSidebar;
  sidebarWidth: number;
  theme: BrandTheme;
  radius: BrandRadius;
  font: BrandFont;
  login: BrandLogin;
  portal: BrandPortal;
  terms: BrandTerms;
  nav: BrandNav;
  /** Dashboard cards this workspace hid; «چهار عدد اصلی» is never hidden. */
  hiddenCards: DashboardCard[];
  email: BrandEmail;
  /** Key from `LANDING_KEYS`; the dashboard unless the company chose otherwise. */
  landing: LandingKey;
  /** «ساخته‌شده با هویدا» in the sidebar footer; false = fully white-label. */
  showHovidaCredit: boolean;
  updatedAtISO: string | null;
  updatedByName: string | null;
  /** The starting point last used in the editor (null = hand-made). */
  presetId?: string | null;
}

export interface BrandPreset {
  id: string;
  label: string;
  hint: string;
  colors: BrandColors;
  sidebar: BrandSidebar;
  theme: BrandTheme;
  radius: BrandRadius;
}

/** HOVIDA's own identity — what a brand-new workspace starts with. */
export const DEFAULT_BRANDING: OrgBranding = {
  nickname: '',
  logoDataUrl: null,
  logoHeight: 32,
  markDataUrl: null,
  colors: { brand: '#2DBA4E', accent: '#1B8539' },
  sidebar: 'light',
  sidebarWidth: 256,
  theme: 'light',
  radius: 'soft',
  font: 'vazirmatn',
  login: {
    title: 'به فضای کاری خود وارد شوید',
    subtitle: 'رزومه‌ها، تصمیم‌ها و پیام‌ها در یک جای امن.',
    background: 'gradient',
  },
  portal: { heading: '', coverDataUrl: null },
  terms: { candidate: 'کارجو', job: 'فرصت شغلی', interview: 'مصاحبه', offer: 'پیشنهاد شغلی' },
  nav: { hidden: [], labels: {} },
  hiddenCards: [],
  email: { signoff: '', footerNote: '', includeLogo: true },
  landing: 'dashboard',
  showHovidaCredit: true,
  updatedAtISO: null,
  updatedByName: null,
  presetId: null,
};

/**
 * Six starting points. They are *starting points*: the editor then lets every
 * value be changed by hand, and the preset id stops matching.
 */
export const BRAND_PRESETS: BrandPreset[] = [
  {
    id: 'hovida',
    label: 'هویدا (سبز)',
    hint: 'هویت پیش‌فرض محصول',
    colors: { brand: '#2DBA4E', accent: '#1B8539' },
    sidebar: 'light',
    theme: 'light',
    radius: 'soft',
  },
  {
    id: 'corporate-blue',
    label: 'آبی سازمانی',
    hint: 'بانک، بیمه، شرکت‌های بزرگ',
    colors: { brand: '#2563EB', accent: '#1E3A8A' },
    sidebar: 'tinted',
    theme: 'light',
    radius: 'soft',
  },
  {
    id: 'midnight-gold',
    label: 'سرمه‌ای و طلایی',
    hint: 'نوار کناری تیره، حس لوکس',
    colors: { brand: '#C79A3E', accent: '#12304F' },
    sidebar: 'dark',
    theme: 'light',
    radius: 'sharp',
  },
  {
    id: 'indigo',
    label: 'بنفش فناورانه',
    hint: 'شرکت‌های نرم‌افزاری و استارتاپ',
    colors: { brand: '#7C3AED', accent: '#312E81' },
    sidebar: 'dark',
    theme: 'light',
    radius: 'soft',
  },
  {
    id: 'teal-calm',
    label: 'فیروزه‌ای آرام',
    hint: 'سلامت، آموزش، سازمان‌های مردم‌نهاد',
    colors: { brand: '#0D9488', accent: '#134E4A' },
    sidebar: 'tinted',
    theme: 'light',
    radius: 'round',
  },
  {
    id: 'graphite',
    label: 'خاکستری و نارنجی',
    hint: 'حس صنعتی و عملیاتی',
    colors: { brand: '#EA580C', accent: '#1F2937' },
    sidebar: 'dark',
    theme: 'dark',
    radius: 'sharp',
  },
];

export const RADIUS_LABEL: Record<BrandRadius, string> = {
  sharp: 'گوشه‌های تیز',
  soft: 'گوشه‌های نرم',
  round: 'گوشه‌های گرد',
};

export const SIDEBAR_LABEL: Record<BrandSidebar, string> = {
  light: 'روشن',
  tinted: 'رنگ‌آمیخته با برند',
  dark: 'تیره',
};

export const THEME_LABEL: Record<BrandTheme, string> = { light: 'روشن', dark: 'تیره' };

export const FONT_LABEL: Record<BrandFont, string> = {
  vazirmatn: 'وزیرمتن (پیش‌فرض)',
  system: 'فونت سیستم دستگاه',
};

export const LOGIN_BG_LABEL: Record<BrandLoginBg, string> = {
  gradient: 'گرادیان برند',
  plain: 'ساده',
  mesh: 'لکه‌های رنگ',
};

/** What the client gets back: the saved choices plus the derived CSS variables. */
export interface BrandingPayload {
  branding: OrgBranding;
  /** CSS custom properties, ready to be set on an element. */
  tokens: Record<string, string>;
  /** Things we changed to keep the UI readable, in Persian. */
  warnings: string[];
  presets: BrandPreset[];
  /** What the public portal and the login screen may show of it. */
  isCustom: boolean;
}

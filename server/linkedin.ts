/**
 * Talent sourcing through a LinkedIn-compatible provider API.
 *
 * Why an «endpoint» and not a hard-coded URL: LinkedIn does not sell candidate
 * search over its public API. Searching people, reading their full profile and
 * filtering by «Open to work» is available only to Talent Solutions / partner
 * integrations, or through a licensed data provider the customer already pays
 * for. HOVIDA therefore talks to whatever compliant endpoint the deployment is
 * configured with, using the small JSON contract documented in
 * docs/CONNECT-LINKEDIN.md:
 *
 *   POST <LINKEDIN_API_URL>
 *   Authorization: Bearer <LINKEDIN_ACCESS_TOKEN>
 *   { "query": { booleanQuery, roleTitle, locations, skills, mustHave, seniority,
 *                openToWorkOnly }, "limit": 25, "cursor": null }
 *   →  { "items": [ { id, fullName, headline, location, profileUrl, openToWork,
 *                     currentCompany, experiences[{title,company,period,description}],
 *                     education[], skills[] } ], "total": 123, "nextCursor": "…" }
 *
 * Without a configured endpoint the search fails honestly (never with invented
 * people) and the UI points the workspace admin at the setup page.
 */
import type { SourcingBrief, SourcingExperience, SourcingProfile, SourcingStatusPublic } from '../src/types/integrations';
import { sourcingConnection } from './platform';

export const LINKEDIN_DOC_PATH = 'docs/CONNECT-LINKEDIN.md';

export class SourcingNotConfiguredError extends Error {
  code = 'SOURCING_NOT_CONFIGURED';
  constructor(message = 'اتصال LinkedIn در این نصب تنظیم نشده است.') {
    super(message);
  }
}

export class SourcingRequestError extends Error {
  code = 'SOURCING_FAILED';
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

interface ProviderConfig {
  endpoint: string;
  token: string;
  label: string;
}

/**
 * The endpoint and token come from /admin › «اتصال‌ها» (recommended) or, if
 * nothing was saved there, from LINKEDIN_API_URL / LINKEDIN_ACCESS_TOKEN.
 */
function config(): ProviderConfig | null {
  const conn = sourcingConnection();
  if (!conn) return null;
  return { endpoint: conn.endpointUrl, token: conn.token, label: conn.providerLabel };
}

export function sourcingStatus(configuredOverride?: boolean): SourcingStatusPublic {
  const cfg = config();
  const configured = configuredOverride ?? Boolean(cfg);
  return {
    configured,
    providerLabel: cfg?.label || 'LinkedIn',
    endpointHost: cfg ? safeHost(cfg.endpoint) : null,
    setupHint: configured
      ? 'جست‌وجوی افراد بر اساس مجوز سازمان شما در سرویس لینکدین انجام می‌شود.'
      : 'برای جست‌وجوی افراد در LinkedIn، مدیر سامانه باید در پنل مدیریت › «اتصال‌ها» آدرس سرویس و توکن را ثبت کند (دسترسی رسمی Talent Solutions یا سرویس دادهٔ دارای مجوز).',
    docPath: LINKEDIN_DOC_PATH,
  };
}

/**
 * One harmless request against the configured provider, used by the admin
 * «آزمایش اتصال» button and before saving, so a dead endpoint is never stored
 * as if it worked. Returns the Persian reason on failure.
 */
export async function probeProvider(cfg: { endpoint: string; token: string }): Promise<{ ok: boolean; error: string | null; count: number | null }> {
  const body = { query: { booleanQuery: '"test"', roleTitle: 'test', locations: [], skills: [], mustHave: [], seniority: null, openToWorkOnly: true, keywords: [] }, limit: 1, cursor: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'سرویس دسترسی را نپذیرفت؛ توکن یا مجوز سازمان معتبر نیست (۴۰۱/۴۰۳).', count: null };
    if (res.status === 429) return { ok: false, error: 'سهمیهٔ درخواست سرویس تمام شده است (۴۲۹)؛ بعداً دوباره آزمایش کنید.', count: null };
    if (!res.ok) return { ok: false, error: `سرویس پاسخ ${res.status} داد؛ آدرس و توکن را بررسی کنید.`, count: null };
    const json: any = await res.json().catch(() => null);
    const items = toArray(pick(json, ['items', 'elements', 'results', 'data', 'people']));
    return { ok: true, error: null, count: items.length };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, error: 'سرویس در ۱۵ ثانیه پاسخ نداد؛ آدرس و دسترسی شبکه را بررسی کنید.', count: null };
    return { ok: false, error: `ارتباط با سرویس برقرار نشد: ${err?.message || 'خطای شبکه'}`, count: null };
  } finally {
    clearTimeout(timer);
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

const asText = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const pick = (obj: any, keys: string[]): any => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
};

function toArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/** Defensive mapping: providers differ in field names, never invent values. */
export function normalizeProfile(raw: any, index: number): SourcingProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const fullName = asText(pick(raw, ['fullName', 'name', 'full_name', 'displayName']), 120);
  const profileUrl = asText(pick(raw, ['profileUrl', 'url', 'publicProfileUrl', 'linkedinUrl', 'profile_url']), 500);
  if (!fullName && !profileUrl) return null;
  const experiences: SourcingExperience[] = toArray(pick(raw, ['experiences', 'experience', 'positions', 'workHistory']))
    .slice(0, 12)
    .map((e: any) => ({
      title: asText(pick(e, ['title', 'role', 'position', 'jobTitle']), 160),
      company: asText(pick(e, ['company', 'companyName', 'organization', 'employer']), 160),
      period: asText(pick(e, ['period', 'dates', 'duration', 'dateRange', 'startEnd']), 80),
      description: asText(pick(e, ['description', 'summary', 'details']), 600),
    }))
    .filter((e) => e.title || e.company);

  const education = toArray(pick(raw, ['education', 'schools']))
    .map((e: any) => (typeof e === 'string' ? asText(e, 200) : asText(pick(e, ['school', 'schoolName', 'institution', 'degree', 'field']), 200)))
    .filter(Boolean)
    .slice(0, 6);

  const skills = toArray(pick(raw, ['skills', 'skillNames']))
    .map((s: any) => (typeof s === 'string' ? asText(s, 60) : asText(pick(s, ['name', 'skill', 'title']), 60)))
    .filter(Boolean)
    .slice(0, 25);

  const id = asText(pick(raw, ['id', 'profileId', 'memberId', 'urn']), 120) || profileUrl || `profile-${index}`;
  return {
    id,
    fullName: fullName || 'بدون نام',
    headline: asText(pick(raw, ['headline', 'title', 'occupation', 'summary']), 300),
    location: asText(pick(raw, ['location', 'geoLocation', 'city', 'region']), 160),
    profileUrl,
    // Only what the provider reports: absent means «نامشخص», not false-positive.
    openToWork: Boolean(pick(raw, ['openToWork', 'isOpenToWork', 'open_to_work', 'openToWorkFlag'])),
    currentCompany: asText(pick(raw, ['currentCompany', 'company', 'currentCompanyName']), 160) || null,
    experiences,
    education,
    skills,
  };
}

export interface SearchOptions {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
}

export interface SearchResponse {
  items: SourcingProfile[];
  total: number | null;
  nextCursor: string | null;
}

/**
 * One provider call. Errors are translated, never swallowed: the caller stores
 * the Persian message with the search so the recruiter sees what went wrong.
 */
export async function searchProfiles(brief: SourcingBrief, opts: SearchOptions = {}): Promise<SearchResponse> {
  const cfg = config();
  if (!cfg) throw new SourcingNotConfiguredError();

  const limit = Math.min(50, Math.max(1, opts.limit || 25));
  const body = {
    query: {
      booleanQuery: brief.booleanQuery,
      roleTitle: brief.roleTitle,
      locations: brief.locations,
      skills: brief.skills,
      mustHave: brief.mustHave,
      seniority: brief.seniority,
      openToWorkOnly: brief.openToWorkOnly,
      keywords: brief.keywords,
    },
    limit,
    cursor: opts.cursor || null,
  };

  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort);
  const timer = setTimeout(abort, 30_000);
  let res: Response;
  try {
    res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new SourcingRequestError('سرویس جست‌وجو در ۳۰ ثانیه پاسخ نداد؛ دوباره تلاش کنید.', 504);
    throw new SourcingRequestError(`ارتباط با سرویس جست‌وجو برقرار نشد: ${err?.message || 'خطای شبکه'}`, 502);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abort);
  }

  if (res.status === 401 || res.status === 403) {
    throw new SourcingRequestError('سرویس جست‌وجو دسترسی را نپذیرفت (توکن یا مجوز سازمان شما منقضی/نامعتبر است).', 502);
  }
  if (res.status === 429) {
    throw new SourcingRequestError('سهمیهٔ درخواست امروز سرویس لینکدین تمام شده است؛ بعداً تلاش کنید.', 429);
  }
  if (!res.ok) {
    throw new SourcingRequestError(`سرویس جست‌وجو پاسخ ${res.status} داد.`, 502);
  }

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new SourcingRequestError('پاسخ سرویس جست‌وجو قابل خواندن نبود (JSON نامعتبر).', 502);
  }

  const rawItems = toArray(pick(json, ['items', 'elements', 'results', 'data', 'people']));
  const items = rawItems.map((r, i) => normalizeProfile(r, i)).filter((p): p is SourcingProfile => Boolean(p));
  const totalRaw = Number(pick(json, ['total', 'totalCount', 'count', 'paging.total']));
  return {
    items,
    total: Number.isFinite(totalRaw) ? totalRaw : null,
    nextCursor: asText(pick(json, ['nextCursor', 'cursor', 'paging.start']), 400) || null,
  };
}

/** «Profile as it looks on LinkedIn», turned into text the screening engine can read. */
export function profileToResumeText(p: SourcingProfile): string {
  const lines: string[] = [];
  lines.push(p.fullName);
  if (p.headline) lines.push(p.headline);
  if (p.location) lines.push(`محل: ${p.location}`);
  if (p.currentCompany) lines.push(`شرکت فعلی: ${p.currentCompany}`);
  lines.push('');
  if (p.experiences.length) {
    lines.push('سابقهٔ کاری:');
    for (const e of p.experiences) {
      lines.push(`- ${[e.title, e.company].filter(Boolean).join(' — ')}${e.period ? ` (${e.period})` : ''}`);
      if (e.description) lines.push(`  ${e.description}`);
    }
    lines.push('');
  }
  if (p.education.length) lines.push(`تحصیلات: ${p.education.join('؛ ')}`);
  if (p.skills.length) lines.push(`مهارت‌ها: ${p.skills.join('، ')}`);
  if (p.profileUrl) lines.push(`پروفایل: ${p.profileUrl}`);
  lines.push(`منبع: نمایهٔ LinkedIn${p.openToWork ? ' (وضعیت: آمادهٔ همکاری)' : ''}`);
  return lines.join('\n').slice(0, 20_000);
}

// ------------------------------------------------------------ search brief ----

const CITY_HINTS = [
  'تهران', 'اصفهان', 'مشهد', 'شیراز', 'تبریز', 'کرج', 'قم', 'اهواز', 'رشت', 'کیش', 'یزد', 'کرمان', 'بندرعباس', 'همدان', 'اراک', 'ساری', 'زنجان', 'قم',
];

/** Quotes a term for a boolean query; Persian/Arabic variants stay as-is. */
function q(term: string): string {
  const t = term.replace(/"/g, ' ').trim();
  return t.includes(' ') ? `"${t}"` : t;
}

/**
 * Deterministic fallback when the AI is unavailable: keyword extraction good
 * enough for a first query, clearly labelled «جست‌وجوی ساده» in the UI.
 */
export function buildLocalBrief(prompt: string, roleTitle: string, openToWorkOnly: boolean): SourcingBrief {
  const text = String(prompt || '').trim();
  const locations = CITY_HINTS.filter((c) => text.includes(c));
  const years = text.match(/(\d+|[۰-۹]+)\s*(?:سال|سال\b)/);
  const seniority = /مدیر|head|lead/i.test(text)
    ? 'مدیر'
    : /ارشد|senior/i.test(text)
    ? 'کارشناس ارشد'
    : /کارآموز|junior|تازه‌کار/i.test(text)
    ? 'کارآموز/جونیور'
    : years
    ? `حدود ${years[0].replace(/\s+/g, ' ')} سابقه`
    : null;
  const STOPWORDS = /^(دنبال|میگردم|می‌گردم|کسی|فردی|با|که|و|یا|برای|در|از|تا|حداقل|حداکثر|سال|سابقه|تجربه|مسلط|آشنا|آماده|همکاری|ترجیحا|ترجیحاً|باید|باشد|دارد|هستند|نیز|هم|شرکت|شهر|ساکن|کار|نقش|موقعیت|استخدام)$/;
  const roleWords = new Set(roleTitle.split(/\s+/).map((w) => w.trim()).filter(Boolean));
  const words = text
    .replace(/[،؛.,!?()]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    // Words that only repeat the role title are already in the quoted query.
    .filter((w) => w.length >= 3 && !STOPWORDS.test(w) && !roleWords.has(w));
  const keywords = Array.from(new Set(words)).slice(0, 15);
  // «تهران» is a location, not a skill: never duplicate it in the query.
  const skills = keywords.filter((w) => !locations.includes(w)).slice(0, 8);
  const booleanQuery = Array.from(new Set([roleTitle, ...locations, ...skills].filter(Boolean)))
    .map(q)
    .join(' AND ');
  return {
    roleTitle,
    seniority,
    locations,
    skills,
    mustHave: keywords.slice(0, 3),
    keywords,
    booleanQuery,
    openToWorkOnly,
    notes: text.slice(0, 300),
    engine: 'local',
  };
}

/** Normalises whatever the model returned into a brief we can trust and edit. */
export function sanitizeBrief(candidate: any, fallback: SourcingBrief): SourcingBrief {
  const str = (v: unknown, max = 160) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v: unknown, max = 12, each = 60): string[] =>
    toArray(v)
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .slice(0, max)
      .map((x) => x.slice(0, each));

  if (!candidate || typeof candidate !== 'object') return fallback;
  const roleTitle = str(pick(candidate, ['roleTitle', 'role', 'title']), 120) || fallback.roleTitle;
  const locations = list(pick(candidate, ['locations', 'cities', 'location']));
  const skills = list(pick(candidate, ['skills', 'technologies']));
  const mustHave = list(pick(candidate, ['mustHave', 'must_have', 'musts']));
  const keywords = list(pick(candidate, ['keywords', 'terms']), 20);
  const booleanRaw = str(pick(candidate, ['booleanQuery', 'boolean', 'query']), 600);
  const booleanQuery =
    booleanRaw ||
    Array.from(new Set([roleTitle, ...locations, ...skills].filter(Boolean))).map(q).join(' AND ');
  return {
    roleTitle,
    seniority: str(pick(candidate, ['seniority', 'level']), 80) || fallback.seniority,
    locations: locations.length ? locations : fallback.locations,
    skills: skills.length ? skills : fallback.skills,
    mustHave,
    keywords,
    booleanQuery,
    openToWorkOnly:
      typeof candidate.openToWorkOnly === 'boolean' ? candidate.openToWorkOnly : fallback.openToWorkOnly,
    notes: str(pick(candidate, ['notes', 'summary']), 400) || fallback.notes,
    engine: 'ai',
  };
}

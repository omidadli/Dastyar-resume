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
  kind: 'contract' | 'apify';
  endpoint: string;
  actorId: string;
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
  return { kind: conn.kind, endpoint: conn.endpointUrl, actorId: conn.actorId, token: conn.token, label: conn.providerLabel };
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
export interface ProbeResult {
  ok: boolean;
  error: string | null;
  /** How many items the test call returned (contract providers only). */
  count: number | null;
  /** Extra, human-readable confirmation (e.g. the Apify account). */
  detail?: string;
}

export async function probeProvider(cfg: { kind?: 'contract' | 'apify'; endpoint: string; token: string; actorId?: string }): Promise<ProbeResult> {
  // Apify: checking the token is free (no actor run is started).
  if (cfg.kind === 'apify') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${cfg.endpoint.replace(/\/$/, '')}/users/me?token=${encodeURIComponent(cfg.token)}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) return { ok: false, error: 'اپافی این توکن را نپذیرفت؛ توکن API را از Console › Integrations بردارید.', count: null };
      if (res.status === 402) return { ok: false, error: 'اعتبار حساب اپافی کافی نیست (۴۰۲)؛ پلن یا اعتبار را بررسی کنید.', count: null };
      if (!res.ok) return { ok: false, error: `اپافی پاسخ ${res.status} داد؛ آدرس API و توکن را بررسی کنید.`, count: null };
      const json: any = await res.json().catch(() => null);
      const user = json?.data?.username || json?.data?.userId || '';
      return { ok: true, error: null, count: null, detail: user ? `توکن معتبر است؛ حساب: ${user}` : 'توکن معتبر است.' };
    } catch (err: any) {
      if (err?.name === 'AbortError') return { ok: false, error: 'اپافی در ۱۵ ثانیه پاسخ نداد؛ دسترسی شبکهٔ سرور را بررسی کنید.', count: null };
      return { ok: false, error: `ارتباط با اپافی برقرار نشد: ${err?.message || 'خطای شبکه'}`, count: null };
    } finally {
      clearTimeout(timer);
    }
  }
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
  const fullName =
    asText(pick(raw, ['fullName', 'name', 'full_name', 'displayName']), 120) ||
    [asText(pick(raw, ['firstName', 'first_name']), 60), asText(pick(raw, ['lastName', 'last_name']), 60)].filter(Boolean).join(' ');
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
    .map((e: any) => {
      if (typeof e === 'string') return asText(e, 200);
      const school = asText(pick(e, ['school', 'schoolName', 'institution']), 160);
      const degree = asText(pick(e, ['degree', 'degreeName', 'field', 'fieldOfStudy']), 80);
      return [school, degree].filter(Boolean).join(' — ');
    })
    .filter(Boolean)
    .slice(0, 6);

  const skills = toArray(pick(raw, ['skills', 'skillNames']))
    .map((s: any) => (typeof s === 'string' ? asText(s, 60) : asText(pick(s, ['name', 'skill', 'title']), 60)))
    .filter(Boolean)
    .slice(0, 25);

  const id = asText(pick(raw, ['id', 'profileId', 'memberId', 'urn', 'publicIdentifier']), 120) || profileUrl || `profile-${index}`;
  return {
    id,
    fullName: fullName || 'بدون نام',
    headline: asText(pick(raw, ['headline', 'title', 'occupation', 'summary']), 300),
    // Apify/HarvestAPI returns an object here (location.linkedinText / parsed.text).
    location: (() => {
      const raw2: any = pick(raw, ['location', 'geoLocation']);
      if (typeof raw2 === 'string') return asText(raw2, 160);
      if (raw2 && typeof raw2 === 'object') {
        return asText(raw2.linkedinText || raw2.parsed?.text || raw2.city || raw2.text || '', 160);
      }
      return asText(pick(raw, ['city', 'region']), 160);
    })(),
    profileUrl,
    // Only what the provider reports: absent means «نامشخص», not false-positive.
    openToWork: Boolean(pick(raw, ['openToWork', 'isOpenToWork', 'open_to_work', 'openToWorkFlag'])),
    currentCompany:
      asText(pick(raw, ['currentCompany', 'company', 'currentCompanyName']), 160) ||
      asText(toArray(pick(raw, ['currentPosition', 'currentPositions']))[0]?.companyName, 160) ||
      experiences[0]?.company ||
      null,
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
  /** An optional explanation of what was filtered or counted. */
  notes?: string | null;
}

// --------------------------------------------------------------- apify ----

/**
 * Apify actors are asynchronous: a run is started, then polled. The search row
 * keeps the run id, so a long run never holds an HTTP request open — the next
 * page load finishes it.
 */
export interface ApifyJob {
  provider: 'apify';
  runId: string;
  datasetId: string;
  startedAtISO: string;
  /** Profiles requested from the provider (more than shown, «open to work» is filtered here). */
  fetchLimit: number;
  openToWorkOnly: boolean;
}

export type JobState =
  | { state: 'pending' }
  | { state: 'done'; items: SourcingProfile[]; total: number | null; notes: string | null };

/** LinkedIn understands Latin place names; the brief is Persian. */
const LATIN_CITY: Record<string, string> = {
  تهران: 'Tehran',
  کرج: 'Karaj',
  اصفهان: 'Isfahan',
  مشهد: 'Mashhad',
  شیراز: 'Shiraz',
  تبریز: 'Tabriz',
  قم: 'Qom',
  اهواز: 'Ahvaz',
  رشت: 'Rasht',
  کیش: 'Kish',
  یزد: 'Yazd',
  کرمان: 'Kerman',
  بندرعباس: 'Bandar Abbas',
  همدان: 'Hamadan',
  اراک: 'Arak',
  ساری: 'Sari',
  زنجان: 'Zanjan',
};

/**
 * The brief, translated into an Apify actor input. Note what is *not* here:
 * the actor has no «open to work» filter, so that is applied after the run —
 * on what the provider actually reports, never guessed.
 */
export function apifyInput(brief: SourcingBrief, fetchLimit: number) {
  const keywords = Array.from(new Set([...(brief.skills || []), ...(brief.mustHave || [])]))
    .filter(Boolean)
    .slice(0, 5)
    .join(' ')
    .slice(0, 300);
  const query = keywords || brief.booleanQuery.replace(/\b(AND|OR|NOT)\b|"/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  const locations = (brief.locations || []).map((c) => LATIN_CITY[c.trim()] || c.trim()).filter(Boolean).slice(0, 10);
  const perPage = 25;
  return {
    profileScraperMode: 'Full',
    ...(brief.roleTitle ? { currentJobTitles: [brief.roleTitle] } : {}),
    ...(query ? { searchQuery: query } : {}),
    ...(locations.length ? { locations } : {}),
    maxItems: fetchLimit,
    takePages: Math.max(1, Math.min(100, Math.ceil(fetchLimit / perPage))),
  };
}

function apifyApi(cfg: ProviderConfig, path: string): string {
  return `${cfg.endpoint.replace(/\/$/, '')}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(cfg.token)}`;
}

async function apifyFetch(url: string, init: RequestInit = {}): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers || {}) },
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) throw new SourcingRequestError('اپافی این توکن را نپذیرفت؛ توکن API را بررسی کنید.', 502);
    if (res.status === 402) throw new SourcingRequestError('اعتبار حساب اپافی کافی نیست (۴۰۲)؛ پلن اپافی را بررسی کنید.', 502);
    if (res.status === 429) throw new SourcingRequestError('محدودیت نرخ اپافی فعال شد (۴۲۹)؛ چند دقیقه بعد دوباره تلاش کنید.', 429);
    if (!res.ok) {
      const detail = typeof json?.error?.message === 'string' ? ` — ${json.error.message.slice(0, 160)}` : '';
      throw new SourcingRequestError(`اپافی پاسخ ${res.status} داد${detail}`, 502);
    }
    return json;
  } catch (err: any) {
    if (err instanceof SourcingRequestError) throw err;
    if (err?.name === 'AbortError') throw new SourcingRequestError('اپافی در ۲۵ ثانیه پاسخ نداد؛ دوباره تلاش کنید.', 504);
    throw new SourcingRequestError(`ارتباط با اپافی برقرار نشد: ${err?.message || 'خطای شبکه'}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Starts an Apify actor run and returns the job the search row will keep. */
export async function startApifySearch(brief: SourcingBrief, fetchLimit: number): Promise<ApifyJob> {
  const cfg = config();
  if (!cfg) throw new SourcingNotConfiguredError();
  const actor = (cfg.actorId || 'harvestapi~linkedin-profile-search').replace(/\//g, '~');
  const json = await apifyFetch(apifyApi(cfg, `/acts/${encodeURIComponent(actor)}/runs`), {
    method: 'POST',
    body: JSON.stringify(apifyInput(brief, fetchLimit)),
  });
  const run = json?.data;
  if (!run?.id || !run?.defaultDatasetId) {
    throw new SourcingRequestError('اپافی اجرای جست‌وجو را شروع نکرد (پاسخ ناقص بود).', 502);
  }
  return {
    provider: 'apify',
    runId: String(run.id),
    datasetId: String(run.defaultDatasetId),
    startedAtISO: new Date().toISOString(),
    fetchLimit,
    openToWorkOnly: brief.openToWorkOnly,
  };
}

/**
 * A run that is still going after this long is treated as failed for the user
 * *and stopped at Apify*, so a forgotten browser tab cannot keep spending money.
 * The environment override exists for tests only.
 */
const APIFY_MAX_WAIT_MS = Number(process.env.APIFY_MAX_WAIT_MS) || 10 * 60_000;

/**
 * What a run is expected to cost, from Apify's published prices for the
 * HarvestAPI actor: $0.10 per result page (25 profiles) + $0.004 per full
 * profile. Shown before/after starting a search — a run is never silently
 * expensive.
 */
export function apifyCostEstimate(fetchLimit: number): { pages: number; usd: number } {
  const pages = Math.max(1, Math.ceil(Math.max(1, fetchLimit) / 25));
  const usd = pages * 0.1 + Math.max(0, fetchLimit) * 0.004;
  return { pages, usd: Math.round(usd * 100) / 100 };
}

function faNum(n: number, digits = 0): string {
  return Number(n)
    .toFixed(digits)
    .replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])
    .replace('.', '٫');
}

/** Minutes the app waits before it stops a run (mirrors APIFY_MAX_WAIT_MS). */
function maxWaitMinutes(): number {
  return Math.max(1, Math.round(APIFY_MAX_WAIT_MS / 60_000));
}

/** «برآورد هزینه: ۰٫۸۰ دلار (۴ صفحه، ۱۰۰ پروفایل)» */
export function apifyCostLine(fetchLimit: number): string {
  const { pages, usd } = apifyCostEstimate(fetchLimit);
  return `برآورد هزینهٔ این جست‌وجو در اپافی: ${faNum(usd, 2)} دلار (${faNum(pages)} صفحه، ${faNum(fetchLimit)} پروفایل)`;
}

/** Stops a run at Apify; a failure here must never hide the original problem. */
async function abortApifyRun(runId: string): Promise<boolean> {
  const cfg = config();
  if (!cfg) return false;
  try {
    await apifyFetch(apifyApi(cfg, `/actor-runs/${encodeURIComponent(runId)}/abort`), { method: 'POST' });
    return true;
  } catch (err: any) {
    console.error('[sourcing] abort failed:', err?.message || err);
    return false;
  }
}

/** Polls the run; returns the finished profiles (filtered) or «still running». */
export async function pollApifySearch(job: ApifyJob, limit: number): Promise<JobState> {
  const cfg = config();
  if (!cfg) throw new SourcingNotConfiguredError();
  const json = await apifyFetch(apifyApi(cfg, `/actor-runs/${encodeURIComponent(job.runId)}`), { method: 'GET' });
  const status = String(json?.data?.status || '').toUpperCase();
  if (['READY', 'RUNNING', ''].includes(status)) {
    const age = Date.now() - new Date(job.startedAtISO).getTime();
    if (age > APIFY_MAX_WAIT_MS) {
      // Stop it at Apify as well: an abandoned run keeps billing.
      const stopped = await abortApifyRun(job.runId);
      throw new SourcingRequestError(
        stopped
          ? `جست‌وجو بیش از ${faNum(maxWaitMinutes())} دقیقه طول کشید؛ اجرا در اپافی متوقف شد تا هزینهٔ بیشتری پرداخت نشود. با تعداد نتیجهٔ کمتر یا شهر مشخص‌تر دوباره تلاش کنید.`
          : `جست‌وجو بیش از ${faNum(maxWaitMinutes())} دقیقه طول کشید و متوقف شد؛ اجرای آن در اپافی را از Console هم لغو کنید. با شرایط محدودتر دوباره تلاش کنید.`,
        504
      );
    }
    return { state: 'pending' };
  }
  if (['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMED_OUT'].includes(status)) {
    throw new SourcingRequestError('اجرای جست‌وجو در اپافی ناکام ماند؛ پلن/اعتبار اپافی و شناسهٔ Actor را بررسی کنید.', 502);
  }
  const items = await apifyFetch(apifyApi(cfg, `/datasets/${encodeURIComponent(job.datasetId)}/items?clean=true&format=json&limit=500`), { method: 'GET' });
  const raw = Array.isArray(items) ? items : toArray(pick(items, ['items']));
  return finishProfiles(raw, job.openToWorkOnly, limit);
}

/**
 * Turns provider profiles into what the recruiter sees: only people the
 * provider itself reports as «open to work» when that was asked for.
 */
export function finishProfiles(raw: any[], openToWorkOnly: boolean, limit: number): { state: 'done'; items: SourcingProfile[]; total: number | null; notes: string | null } {
  const normalized = raw.map((r, i) => normalizeProfile(r, i)).filter((p): p is SourcingProfile => Boolean(p));
  const total = normalized.length;
  const reported = normalized.filter((p) => p.openToWork === true);
  const kept = (openToWorkOnly ? reported : normalized).slice(0, limit);
  let notes: string | null = null;
  if (openToWorkOnly) {
    if (total === 0) notes = null;
    else if (reported.length === 0) {
      notes = `${toPersianDigitsLocal(total)} پروفایل بررسی شد، ولی سرویس برای هیچ‌کدام وضعیت «آمادهٔ همکاری» را گزارش نکرد؛ چیزی نمایش داده نشد.`;
    } else {
      notes = `از ${toPersianDigitsLocal(total)} پروفایل بررسی‌شده، ${toPersianDigitsLocal(reported.length)} نفر «آمادهٔ همکاری» گزارش شده‌اند${reported.length > kept.length ? `؛ ${toPersianDigitsLocal(kept.length)} نفر نمایش داده شد` : ''}.`;
    }
  }
  return { state: 'done', items: kept, total, notes };
}

function toPersianDigitsLocal(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/**
 * One provider call. Errors are translated, never swallowed: the caller stores
 * the Persian message with the search so the recruiter sees what went wrong.
 */
export async function searchProfiles(brief: SourcingBrief, opts: SearchOptions = {}): Promise<SearchResponse> {
  const cfg = config();
  if (!cfg) throw new SourcingNotConfiguredError();
  if (cfg.kind === 'apify') {
    throw new SourcingRequestError('این سرویس ناهمگام است؛ از startSearch استفاده کنید.', 500);
  }

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

/** What a started search produced: finished profiles, or an Apify run to poll. */
export type StartSearchResult =
  | { state: 'done'; items: SourcingProfile[]; total: number | null; notes: string | null }
  | { state: 'pending'; job: ApifyJob };

/**
 * One entry point for a search, whatever the provider kind: a contract provider
 * answers in the same request, an Apify actor is started and polled later.
 */
export async function startSearch(brief: SourcingBrief, opts: SearchOptions = {}): Promise<StartSearchResult> {
  const cfg = config();
  if (!cfg) throw new SourcingNotConfiguredError();
  const limit = Math.min(50, Math.max(1, opts.limit || 25));
  if (cfg.kind === 'apify') {
    // «Open to work» cannot be filtered at the provider, so ask for more and keep
    // the reported ones: 4× the wanted number, capped to keep the run cheap.
    const fetchLimit = Math.min(200, Math.max(limit, limit * 4));
    return { state: 'pending', job: await startApifySearch(brief, fetchLimit) };
  }
  const found = await searchProfiles(brief, { ...opts, limit });
  return { state: 'done', items: found.items, total: found.total, notes: found.notes ?? null };
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
  if (p.email) lines.push(`ایمیل: ${p.email}`);
  if (p.notes) lines.push(`درباره: ${p.notes}`);
  if (p.profileUrl) lines.push(`پروفایل: ${p.profileUrl}`);
  lines.push(`منبع: ${p.id.startsWith('csv-') ? 'خروجی LinkedIn (فایل)' : 'نمایهٔ LinkedIn'}${p.openToWork ? ' (وضعیت: آمادهٔ همکاری)' : ''}`);
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

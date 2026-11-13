/**
 * «بازارچهٔ آزمون» — connecting an outside test service to one workspace.
 *
 * The bar this file holds itself to:
 *   - **A key is a secret.** It is encrypted with the app secret (AES-256-GCM,
 *     the same store the SMTP password uses), never returned by any read, and
 *     the snapshot on disk only ever contains the ciphertext.
 *   - **A connection is only «آماده» when a real request said so.** After a
 *     successful check the row reads `ready`; a failed check reads `degraded`
 *     and keeps the error text. There is no optimistic green tick.
 *   - **Nothing is invented.** No provider is pre-installed, no price or test
 *     catalogue comes from us: the customer types the vendor, the URL and the
 *     test list. An empty workspace sees an empty state.
 *   - **Sending is a human act.** Creating an invitation touches nothing
 *     outside; only `sendInvite` opens a session or mails a link.
 */
import crypto from 'crypto';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type {
  AssessmentProviderPublic,
  ProviderCheck,
  ProviderInput,
  ProviderMode,
  ProviderTest,
} from '../src/types/assessment-provider';
import type { AssessmentKind } from '../src/types/assessment';
import { ASSESSMENT_KIND_LABEL } from '../src/types/assessment';

export class ProviderError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'PROVIDER_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_PROVIDERS = 10;
const MAX_TESTS = 40;
const TIMEOUT_MS = 9000;

/** The three paths of the contract; a vendor implements these or says it cannot. */
export const DEFAULT_SESSION_PATH = '/sessions';
export const DEFAULT_CHECK_PATH = '/health';

/** http is only accepted for a loopback address — a test double, not the internet. */
function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

function normalizeUrl(raw: unknown, field: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new ProviderError(`${field} را وارد کنید.`, 400, 'URL_REQUIRED');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new ProviderError(`${field} باید یک نشانی کامل باشد (مثل https://tests.example.com).`, 400, 'BAD_URL');
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) {
    throw new ProviderError(`${field} باید https باشد؛ کلید API روی http فرستاده نمی‌شود.`, 400, 'HTTPS_REQUIRED');
  }
  if (u.username || u.password) throw new ProviderError('نام کاربری و گذرواژه را در نشانی نگذارید.', 400, 'URL_HAS_CREDENTIALS');
  return `${u.origin}${u.pathname.replace(/\/$/, '')}`;
}

function normalizePath(raw: unknown, fallback: string, field: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  if (!text.startsWith('/') || text.includes('..') || text.length > 120) {
    throw new ProviderError(`${field} باید با «/» شروع شود.`, 400, 'BAD_PATH');
  }
  return text;
}

function dateOf(d: Date): { iso: string; jalali: string } {
  return { iso: d.toISOString(), jalali: formatJalaliDate(tehranJalaliOf(d), true) };
}

/** The check stamp in the shape the type and the screen both use. */
function stampOf(d: Date): { atISO: string; atJalali: string } {
  return { atISO: d.toISOString(), atJalali: formatJalaliDate(tehranJalaliOf(d), true) };
}

function normalizeTests(input: unknown): ProviderTest[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ProviderError('فهرست آزمون‌ها نامعتبر است.', 400, 'BAD_TESTS');
  if (input.length > MAX_TESTS) throw new ProviderError(`حداکثر ${MAX_TESTS} آزمون برای هر سرویس.`, 400, 'TOO_MANY_TESTS');
  const out: ProviderTest[] = [];
  for (const raw of input) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 90) : '';
    if (name.length < 2) throw new ProviderError('هر آزمون به یک نام نیاز دارد.', 400, 'TEST_NAME_REQUIRED');
    const kind: AssessmentKind =
      raw?.kind === 'work-sample' || raw?.kind === 'behavioral' || raw?.kind === 'situational' ? raw.kind : 'situational';
    const minutes = Number(raw?.durationMinutes);
    const dims = Array.isArray(raw?.dimensions)
      ? raw.dimensions
      : typeof raw?.dimensions === 'string'
        ? raw.dimensions.split(/[,،]/)
        : [];
    const dimensions = dims
      .map((d: unknown) => (typeof d === 'string' ? d.trim() : ''))
      .filter((d: string) => d.length > 0)
      .slice(0, 8)
      .map((d: string) => d.slice(0, 40));
    out.push({
      id: typeof raw?.id === 'string' && /^pt_[a-z0-9]+$/i.test(raw.id) ? raw.id : db.uid('pt'),
      externalId: typeof raw?.externalId === 'string' && raw.externalId.trim() ? raw.externalId.trim().slice(0, 80) : null,
      name,
      kind,
      durationMinutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 480 ? Math.round(minutes) : 20,
      dimensions,
      scoring: raw?.scoring === 'profile' ? 'profile' : 'score',
      note: typeof raw?.note === 'string' && raw.note.trim() ? raw.note.trim().slice(0, 200) : null,
    });
  }
  return out;
}

/** Ciphertext → the browser's view. Never the other way round. */
export function publicProvider(orgId: string, row: db.AssessmentProviderRow): AssessmentProviderPublic {
  const invites = db.listAssessments(orgId).filter((a) => a.providerId === row.id);
  const state: AssessmentProviderPublic['state'] =
    row.mode === 'api' && (!row.baseUrl || !row.apiKeyEnc)
      ? 'unconfigured'
      : row.mode === 'link' && !row.tests.length
        ? 'unconfigured'
        : row.lastCheck
          ? row.lastCheck.ok
            ? 'ready'
            : 'degraded'
          : row.mode === 'link'
            ? 'ready'
            : 'unchecked';
  const reason =
    state === 'ready'
      ? null
      : state === 'unconfigured'
        ? row.mode === 'api'
          ? row.baseUrl
            ? 'کلید API ثبت نشده است؛ تا آن را وارد نکنید، جلسه‌ای ساخته نمی‌شود.'
            : 'نشانی سرویس و کلید API ثبت نشده است.'
          : 'یک آزمون برای این سرویس تعریف نشده است.'
        : state === 'unchecked'
          ? 'اتصال هنوز بررسی نشده است؛ تا پاسخ سالم نگیریم، ارسال از این سرویس انجام نمی‌شود.'
          : row.lastCheck?.error || 'آخرین بررسی اتصال ناموفق بود.';
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    endpointHost: row.baseUrl ? safeHost(row.baseUrl) : null,
    sessionPath: row.sessionPath,
    checkPath: row.checkPath,
    hasKey: Boolean(row.apiKeyEnc),
    keyHint: row.apiKeyHint,
    tests: row.tests,
    state,
    reason,
    lastCheck: row.lastCheck,
    createdAtISO: row.createdAtISO,
    createdAtJalali: dateOf(new Date(row.createdAtISO)).jalali,
    createdByName: row.createdByName,
    updatedAtISO: row.updatedAtISO,
    updatedAtJalali: dateOf(new Date(row.updatedAtISO)).jalali,
    updatedByName: row.updatedByName,
    invites: invites.length,
    completed: invites.filter((a) => a.status === 'completed').length,
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function listProviders(orgId: string): AssessmentProviderPublic[] {
  return db.listAssessmentProviders(orgId).map((row) => publicProvider(orgId, row));
}

export function getProviderRow(orgId: string, id: string): db.AssessmentProviderRow {
  const row = db.getAssessmentProvider(orgId, id);
  if (!row) throw new ProviderError('این سرویس آزمون پیدا نشد.', 404, 'PROVIDER_NOT_FOUND');
  return row;
}

export function createProvider(
  orgId: string,
  actor: { id: string; name: string } | null,
  input: ProviderInput
): db.AssessmentProviderRow {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (name.length < 2) throw new ProviderError('نام سرویس را بنویسید (مثلاً «آزمون زبان سازمانی»).', 400, 'NAME_REQUIRED');
  if (db.listAssessmentProviders(orgId).length >= MAX_PROVIDERS) {
    throw new ProviderError(`حداکثر ${MAX_PROVIDERS} سرویس آزمون برای هر فضای کاری.`, 409, 'TOO_MANY_PROVIDERS');
  }
  const mode: ProviderMode = input.mode === 'link' ? 'link' : 'api';
  const baseUrl = mode === 'api' ? normalizeUrl(input.baseUrl, 'نشانی سرویس') : input.baseUrl ? normalizeUrl(input.baseUrl, 'نشانی سرویس') : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (mode === 'api' && apiKey.length < 6) {
    throw new ProviderError('کلید API سرویس را وارد کنید (حداقل ۶ نویسه).', 400, 'KEY_REQUIRED');
  }
  const stamp = new Date();
  const row: db.AssessmentProviderRow = {
    id: db.uid('prv'),
    orgId,
    name,
    mode,
    baseUrl,
    sessionPath: normalizePath(input.sessionPath, DEFAULT_SESSION_PATH, 'مسیر ساخت جلسه'),
    checkPath: normalizePath(input.checkPath, DEFAULT_CHECK_PATH, 'مسیر بررسی سلامت'),
    apiKeyEnc: apiKey ? encryptSecret(apiKey) : null,
    apiKeyHint: apiKey ? apiKey.slice(-4) : null,
    tests: normalizeTests(input.tests),
    lastCheck: null,
    createdAtISO: stamp.toISOString(),
    createdByName: actor?.name ?? null,
    updatedAtISO: stamp.toISOString(),
    updatedByName: actor?.name ?? null,
  };
  db.saveAssessmentProvider(row);
  db.logActivity(orgId, actor, 'assessment.sent', `سرویس آزمون بیرونی «${name}» را به فضای کاری اضافه کرد`, {});
  return row;
}

export function updateProvider(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: ProviderInput
): db.AssessmentProviderRow {
  const row = getProviderRow(orgId, id);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : row.name;
  if (name.length < 2) throw new ProviderError('نام سرویس را بنویسید.', 400, 'NAME_REQUIRED');
  const mode: ProviderMode = input.mode === 'link' ? 'link' : 'api';
  const rawUrl = typeof input.baseUrl === 'string' ? input.baseUrl : row.baseUrl;
  const baseUrl = rawUrl ? normalizeUrl(rawUrl, 'نشانی سرویس') : '';
  if (mode === 'api' && !baseUrl) throw new ProviderError('نشانی سرویس را وارد کنید.', 400, 'URL_REQUIRED');
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const endpointChanged = baseUrl !== row.baseUrl;
  // A new endpoint invalidates the old key: it was issued for another host.
  const keyCleared = endpointChanged && !apiKey;
  const next: db.AssessmentProviderRow = {
    ...row,
    name,
    mode,
    baseUrl,
    sessionPath: normalizePath(input.sessionPath, row.sessionPath || DEFAULT_SESSION_PATH, 'مسیر ساخت جلسه'),
    checkPath: normalizePath(input.checkPath, row.checkPath || DEFAULT_CHECK_PATH, 'مسیر بررسی سلامت'),
    apiKeyEnc: apiKey ? encryptSecret(apiKey) : keyCleared ? null : row.apiKeyEnc,
    apiKeyHint: apiKey ? apiKey.slice(-4) : keyCleared ? null : row.apiKeyHint,
    tests: input.tests === undefined ? row.tests : normalizeTests(input.tests),
    lastCheck: endpointChanged || apiKey ? null : row.lastCheck,
    updatedAtISO: new Date().toISOString(),
    updatedByName: actor?.name ?? null,
  };
  if (mode === 'api' && !next.apiKeyEnc) {
    throw new ProviderError('برای حالت API کلید سرویس لازم است.', 400, 'KEY_REQUIRED');
  }
  db.saveAssessmentProvider(next);
  db.logActivity(orgId, actor, 'assessment.sent', `سرویس آزمون «${name}» را ویرایش کرد`, {});
  return next;
}

export function deleteProvider(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null
): { removed: true; keptInvites: number } {
  const row = getProviderRow(orgId, id);
  const used = db.listAssessments(orgId).filter((a) => a.providerId === row.id).length;
  db.deleteAssessmentProvider(orgId, row.id);
  db.logActivity(orgId, actor, 'assessment.sent', `سرویس آزمون «${row.name}» را از فهرست برداشت`, {});
  // Results already recorded stay where they are; they name the provider in words.
  return { removed: true, keptInvites: used };
}

function authHeaders(row: db.AssessmentProviderRow): Record<string, string> {
  if (!row.apiKeyEnc) return {};
  try {
    return { Authorization: `Bearer ${decryptSecret(row.apiKeyEnc)}` };
  } catch {
    // A key that cannot be decrypted (changed APP_SECRET) is not silently ignored.
    throw new ProviderError('کلید ذخیره‌شده خوانده نشد؛ کلید را دوباره وارد کنید.', 409, 'KEY_UNREADABLE');
  }
}

async function timedFetch(url: string, init: RequestInit): Promise<{ res: Response; latencyMs: number; body: string }> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    const body = await res.text();
    return { res, latencyMs: Date.now() - started, body };
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: any): { code: string; message: string } {
  if (err?.name === 'AbortError') {
    return { code: 'PROVIDER_TIMEOUT', message: `سرویس آزمون در ${Math.round(TIMEOUT_MS / 1000)} ثانیه پاسخ نداد.` };
  }
  const cause = String(err?.cause?.code || err?.code || err?.message || '');
  if (/ENOTFOUND|EAI_AGAIN/i.test(cause)) return { code: 'PROVIDER_UNREACHABLE', message: 'نشانی سرویس پیدا نشد (DNS).' };
  if (/ECONNREFUSED/i.test(cause)) return { code: 'PROVIDER_UNREACHABLE', message: 'سرویس اتصال را نپذیرفت (اتصال رد شد).' };
  if (/CERT|TLS|SSL/i.test(cause)) return { code: 'PROVIDER_TLS', message: 'گواهی TLS سرویس پذیرفته نشد.' };
  return { code: 'PROVIDER_UNREACHABLE', message: 'ارتباط با سرویس آزمون برقرار نشد.' };
}

/** A real GET, recorded as-is. The screen shows latency and the error text. */
export async function checkProvider(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null
): Promise<db.AssessmentProviderRow> {
  const row = getProviderRow(orgId, id);
  if (!row.baseUrl) throw new ProviderError('برای بررسی اتصال، نشانی سرویس لازم است.', 400, 'NO_ENDPOINT');
  let check: ProviderCheck;
  try {
    const headers = authHeaders(row);
    const { res, latencyMs, body } = await timedFetch(`${row.baseUrl}${row.checkPath}`, { method: 'GET', headers });
    const ok = res.status >= 200 && res.status < 300;
    check = {
      ...stampOf(new Date()),
      ok,
      status: res.status,
      latencyMs,
      error: ok ? null : `سرویس با کد ${res.status} پاسخ داد${body ? `: ${body.slice(0, 160)}` : ''}`,
    };
  } catch (err: any) {
    const info = err instanceof ProviderError ? { code: err.code, message: err.message } : describeFetchError(err);
    check = { ...stampOf(new Date()), ok: false, status: null, latencyMs: null, error: info.message };
  }
  const next = db.saveAssessmentProvider({ ...row, lastCheck: check, updatedAtISO: new Date().toISOString(), updatedByName: actor?.name ?? null });
  db.logActivity(
    orgId,
    actor,
    'assessment.sent',
    check.ok ? `اتصال سرویس آزمون «${row.name}» را بررسی کرد — سالم (${check.latencyMs} میلی‌ثانیه)` : `بررسی اتصال سرویس آزمون «${row.name}» ناموفق بود`,
    {}
  );
  return next;
}

export interface SessionResult {
  url: string;
  sessionId: string | null;
}

/**
 * Opens a session with the provider — the only outbound call in this module.
 * A non-2xx answer, an unreadable body or a non-https link is a failure the
 * caller must report; nothing gets mailed on a guess.
 */
export async function createProviderSession(
  row: db.AssessmentProviderRow,
  input: { test: ProviderTest; candidateName: string | null; candidateEmail: string; externalRef: string; expiresAtISO: string }
): Promise<SessionResult> {
  if (!row.baseUrl) throw new ProviderError('نشانی سرویس آزمون ثبت نشده است.', 409, 'NO_ENDPOINT');
  const headers = { 'Content-Type': 'application/json', ...authHeaders(row) };
  let answer: { res: Response; latencyMs: number; body: string };
  try {
    answer = await timedFetch(`${row.baseUrl}${row.sessionPath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        testId: input.test.externalId || input.test.id,
        testName: input.test.name,
        candidate: { name: input.candidateName, email: input.candidateEmail },
        externalRef: input.externalRef,
        expiresAtISO: input.expiresAtISO,
      }),
    });
  } catch (err: any) {
    if (err instanceof ProviderError) throw err;
    const info = describeFetchError(err);
    throw new ProviderError(`جلسهٔ آزمون ساخته نشد: ${info.message}`, 502, info.code);
  }
  const { res, body } = answer;
  if (res.status < 200 || res.status >= 300) {
    throw new ProviderError(`سرویس آزمون جلسه را نساخت (HTTP ${res.status})${body ? `: ${body.slice(0, 160)}` : ''}.`, 502, 'PROVIDER_FAILED');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderError('پاسخ سرویس آزمون JSON خوانا نبود؛ جلسه ساخته نشد.', 502, 'PROVIDER_BAD_RESPONSE');
  }
  const url = typeof parsed?.url === 'string' ? parsed.url.trim() : '';
  let safe: URL;
  try {
    safe = new URL(url);
  } catch {
    throw new ProviderError('سرویس آزمون نشانی آزمون را برنگرداند؛ جلسه ساخته نشد.', 502, 'PROVIDER_NO_URL');
  }
  if (safe.protocol !== 'https:' && !(safe.protocol === 'http:' && isLoopback(safe.hostname))) {
    throw new ProviderError('نشانی برگشتی سرویس آزمون https نیست؛ به کارجو فرستاده نمی‌شود.', 502, 'PROVIDER_BAD_URL');
  }
  return { url: safe.toString(), sessionId: typeof parsed?.id === 'string' ? parsed.id.slice(0, 80) : null };
}

/** True when this provider test can be sent at all — used before the click. */
export function readinessOf(row: db.AssessmentProviderRow): { ready: boolean; reason: string | null } {
  if (row.mode === 'link') {
    return row.tests.length ? { ready: true, reason: null } : { ready: false, reason: 'یک آزمون برای این سرویس تعریف نشده است.' };
  }
  if (!row.baseUrl) return { ready: false, reason: 'نشانی سرویس ثبت نشده است.' };
  if (!row.apiKeyEnc) return { ready: false, reason: 'کلید API ثبت نشده است.' };
  if (!row.lastCheck) {
    return { ready: false, reason: 'اتصال هنوز بررسی نشده است؛ دکمهٔ «بررسی اتصال» را بزنید.' };
  }
  if (!row.lastCheck.ok) return { ready: false, reason: `آخرین بررسی اتصال ناموفق بود: ${row.lastCheck.error || 'بدون جزئیات'}` };
  return { ready: true, reason: null };
}

export function kindLabelOfTest(test: ProviderTest): string {
  return ASSESSMENT_KIND_LABEL[test.kind];
}

export function newExternalRef(): string {
  return `ext_${crypto.randomBytes(9).toString('base64url')}`;
}

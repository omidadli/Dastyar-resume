/**
 * AI key pool — up to five provider keys with automatic failover.
 *
 * Every call goes to the first *ready* key (failover) or rotates over the
 * ready keys (round-robin). When a key hits a limit it is benched and the
 * same request continues on the next key, so users never see the limit:
 *
 *   429 / RESOURCE_EXHAUSTED  → cooldown = provider's retry hint, else 30 s × 2ⁿ (≤ 10 min)
 *   quota / billing / per-day → 60 min
 *   401 / 403 / invalid key   → «invalid» until an admin edits or re-tests it
 *   region not supported      → 60 min (needs a proxy base URL)
 *   5xx / timeout / network   → next key now; short cooldown after repeats
 *
 * Optional proactive limits (requests per minute, calls per day) skip a key
 * *before* the provider rejects it. State is kept in memory and persisted by
 * the provider module (exportState/importState) so a restart remembers which
 * keys are exhausted.
 */
import crypto from 'crypto';
import type { AiKeyRuntime, AiProviderKind, KeyHealth, KeyStrategy } from '../../src/types/admin';

export interface PoolEntry {
  id: string;
  label: string;
  provider: AiProviderKind;
  apiKey: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  rpm: number;
  dailyLimit: number;
  source: 'admin' | 'env';
}

export type FailureKind =
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'region'
  | 'model'
  | 'transient'
  | 'network'
  | 'timeout'
  | 'request'
  | 'unsupported'
  | 'unknown';

export interface FailureVerdict {
  kind: FailureKind;
  /** Whether the same request should continue on the next key. */
  tryNext: boolean;
  cooldownMs: number;
  message: string;
}

interface KeyState {
  fingerprint: string;
  cooldownUntil: number;
  cooldownKind: FailureKind | null;
  cooldownReason: string | null;
  invalid: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  lastLatencyMs: number | null;
  calls: number;
  successes: number;
  failures: number;
  rateLimits: number;
  strikes: number;
  limitStrikes: number;
  dayKey: string;
  todayCalls: number;
  todayFailures: number;
  recent: number[];
}

const states = new Map<string, KeyState>();
let rrCursor = 0;
let onChange: (() => void) | null = null;

/** Persistence hook (the provider module saves state through the store). */
export function setChangeListener(fn: (() => void) | null) {
  onChange = fn;
}

const tehranDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
export function dayKeyNow(): string {
  return tehranDay.format(new Date());
}

function fingerprintOf(e: Pick<PoolEntry, 'provider' | 'baseUrl' | 'apiKey'>): string {
  return crypto.createHash('sha256').update(`${e.provider}|${e.baseUrl}|${e.apiKey}`).digest('hex').slice(0, 16);
}

function freshState(fingerprint: string, previous?: KeyState): KeyState {
  return {
    fingerprint,
    cooldownUntil: 0,
    cooldownKind: null,
    cooldownReason: null,
    invalid: false,
    lastError: null,
    lastErrorAt: null,
    lastUsedAt: previous?.lastUsedAt ?? null,
    lastLatencyMs: null,
    // Usage counters survive a key edit; health does not (a new key gets a clean slate).
    calls: previous?.calls ?? 0,
    successes: previous?.successes ?? 0,
    failures: previous?.failures ?? 0,
    rateLimits: previous?.rateLimits ?? 0,
    strikes: 0,
    limitStrikes: 0,
    dayKey: previous?.dayKey ?? dayKeyNow(),
    todayCalls: previous?.todayCalls ?? 0,
    todayFailures: previous?.todayFailures ?? 0,
    recent: [],
  };
}

function stateOf(e: PoolEntry): KeyState {
  const fp = fingerprintOf(e);
  let s = states.get(e.id);
  if (!s || s.fingerprint !== fp) {
    s = freshState(fp, s);
    states.set(e.id, s);
  }
  const today = dayKeyNow();
  if (s.dayKey !== today) {
    s.dayKey = today;
    s.todayCalls = 0;
    s.todayFailures = 0;
    // A new day also ends daily-quota cooldowns.
    if (s.cooldownKind === 'quota') {
      s.cooldownUntil = 0;
      s.cooldownKind = null;
      s.cooldownReason = null;
    }
  }
  return s;
}

function overProactiveLimit(e: PoolEntry, s: KeyState, now: number): string | null {
  s.recent = s.recent.filter((t) => now - t < 60_000);
  if (e.rpm > 0 && s.recent.length >= e.rpm) return 'سقف درخواست در دقیقه';
  if (e.dailyLimit > 0 && s.todayCalls >= e.dailyLimit) return 'سقف درخواست روزانه';
  return null;
}

export function healthOf(e: PoolEntry, now = Date.now()): KeyHealth {
  if (!e.enabled) return 'disabled';
  const s = stateOf(e);
  if (s.invalid) return 'invalid';
  if (s.cooldownUntil > now) return 'cooling';
  if (overProactiveLimit(e, s, now)) return 'limited';
  return 'ready';
}

/**
 * Keys to try for one request, best first. `prefer` moves keys that can
 * handle the request natively (e.g. read a scanned PDF or a video) ahead.
 */
export function orderEntries(entries: PoolEntry[], strategy: KeyStrategy, prefer?: (e: PoolEntry) => boolean): PoolEntry[] {
  const now = Date.now();
  let ready = entries.filter((e) => healthOf(e, now) === 'ready');
  if (strategy === 'round-robin' && ready.length > 1) {
    const start = rrCursor++ % ready.length;
    ready = [...ready.slice(start), ...ready.slice(0, start)];
  }
  if (prefer) ready = [...ready.filter(prefer), ...ready.filter((e) => !prefer(e))];
  return ready;
}

/** Earliest moment a benched key becomes usable again (null if none will). */
export function nextAvailableAt(entries: PoolEntry[]): number | null {
  const now = Date.now();
  let best: number | null = null;
  for (const e of entries) {
    if (!e.enabled) continue;
    const s = stateOf(e);
    if (s.invalid) continue;
    let at = s.cooldownUntil > now ? s.cooldownUntil : now;
    if (overProactiveLimit(e, s, now)) {
      if (e.dailyLimit > 0 && s.todayCalls >= e.dailyLimit) continue; // tomorrow
      at = Math.max(at, (s.recent[0] || now) + 60_000);
    }
    if (best === null || at < best) best = at;
  }
  return best;
}

export function noteAttempt(e: PoolEntry) {
  const s = stateOf(e);
  const now = Date.now();
  s.recent.push(now);
  s.calls++;
  s.todayCalls++;
  s.lastUsedAt = now;
}

export function markSuccess(e: PoolEntry, latencyMs: number) {
  const s = stateOf(e);
  s.successes++;
  s.strikes = 0;
  s.limitStrikes = 0;
  s.invalid = false;
  s.lastLatencyMs = latencyMs;
  if (s.cooldownUntil && s.cooldownUntil <= Date.now()) {
    s.cooldownUntil = 0;
    s.cooldownKind = null;
    s.cooldownReason = null;
  }
  onChange?.();
}

function parseDurationMs(v: string): number | null {
  // "37s", "1.5s", "200ms", "6m0s", "1h2m"
  const m = v.trim().match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!m || !m.slice(1).some(Boolean)) return null;
  const [h, min, sec, ms] = m.slice(1).map((x) => (x ? Number(x) : 0));
  return Math.round(h * 3600_000 + min * 60_000 + sec * 1000 + ms);
}

/** Provider retry hint: Retry-After header, Gemini RetryInfo, or "try again in 20s". */
export function retryAfterOf(err: any): number | null {
  if (typeof err?.retryAfterMs === 'number' && err.retryAfterMs > 0) return err.retryAfterMs;
  const msg = String(err?.message || '');
  const delay = msg.match(/"retryDelay"\s*:\s*"([\d.]+s)"/);
  if (delay) return parseDurationMs(delay[1]);
  const again = msg.match(/(?:try again|retry) in\s+([\dhms.]+)/i);
  if (again) return parseDurationMs(again[1].replace(/\.$/, ''));
  const after = msg.match(/retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)?/i);
  if (after) return Math.round(Number(after[1]) * (/^ms|milli/i.test(after[2] || '') ? 1 : 1000));
  return null;
}

/**
 * A 429 / RESOURCE_EXHAUSTED is usually a short per-minute limit — even when
 * Gemini words it as «You exceeded your current quota, please check your plan
 * and billing details» (its free-tier per-minute message, with a retryDelay of
 * a few seconds). Only real exhaustion benches a key for an hour: no credit
 * left, or a per-day quota.
 */
function classifyLimit(err: any, msg: string): FailureKind {
  // Out of money/credit (OpenAI «insufficient_quota», gateways' balance errors).
  if (/insufficient_quota|insufficient.?(balance|credit|funds)|out of credit|credit balance|payment required/i.test(msg)) return 'quota';
  // «limit: 0»: this model has no quota at all on the key's tier — another model may.
  if (/\blimit\s*[:=]\s*0\b/i.test(msg)) return 'model';
  const perDay = /PerDay|per.?day|\bdaily\b|\bRPD\b/i.test(msg);
  const perMinute = /PerMinute|per.?min(ute)?\b|\bRPM\b|\bTPM\b/i.test(msg);
  if (perDay && !perMinute) return 'quota';
  if (perMinute) return 'rate_limit';
  // Ambiguous («exceeded your current quota» with no details): only a long
  // provider hint means exhaustion. Otherwise treat it as a rate limit — the
  // request moves to the next key anyway, and repeated hits back off further.
  const hint = retryAfterOf(err);
  return hint !== null && hint > 10 * 60_000 ? 'quota' : 'rate_limit';
}

export function classifyError(err: any): FailureKind {
  if (err?.code === 'UNSUPPORTED_INPUT') return 'unsupported';
  const status = Number(err?.status ?? (typeof err?.code === 'number' ? err.code : 0)) || 0;
  const msg = String(err?.message || err || '');
  if (err?.name === 'AbortError' || /\btimeout\b|timed? ?out|ETIMEDOUT|aborted/i.test(msg)) return 'timeout';
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(msg)) return classifyLimit(err, msg);
  if (status === 402 || /insufficient_quota|insufficient.?(balance|credit|funds)|payment required|out of credit/i.test(msg)) return 'quota';
  if (/location is not supported|unsupported_country|not available in your (country|region)|unsupported.?region/i.test(msg)) return 'region';
  if (
    status === 401 ||
    status === 403 ||
    /API key not valid|API_KEY_INVALID|invalid_api_key|Incorrect API key|invalid api key|PERMISSION_DENIED|unauthori[sz]ed|authentication/i.test(msg)
  ) {
    return 'auth';
  }
  if (status === 404 || /model.{0,60}(not found|does not exist|is not supported|not available)|unknown model|no such model|model_not_found/i.test(msg)) {
    return 'model';
  }
  if (status >= 500 || /\b(UNAVAILABLE|INTERNAL)\b|overloaded|high demand|bad gateway|service unavailable/i.test(msg)) return 'transient';
  if (/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket|network|certificate|TLS/i.test(msg)) return 'network';
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'request';
  return 'unknown';
}

const KIND_MESSAGE: Record<FailureKind, string> = {
  rate_limit: 'به محدودیت نرخ درخواست خورد',
  quota: 'سهمیه یا اعتبار این کلید تمام شده است',
  auth: 'کلید نامعتبر است یا به این سرویس دسترسی ندارد',
  region: 'سرویس از منطقه جغرافیایی این سرور پشتیبانی نمی‌کند؛ آدرس پراکسی یا درگاه تنظیم کنید',
  model: 'مدل انتخاب‌شده در این سرویس یافت نشد یا در دسترس نیست',
  transient: 'سرویس موقتاً در دسترس نبود',
  network: 'ارتباط شبکه با سرویس برقرار نشد',
  timeout: 'پاسخ در زمان مقرر نرسید',
  request: 'سرویس این درخواست را نپذیرفت',
  unsupported: 'این سرویس نوع فایل ارسالی را نمی‌خواند',
  unknown: 'خطای پیش‌بینی‌نشده از سرویس',
};

export function kindMessage(kind: FailureKind): string {
  return KIND_MESSAGE[kind];
}

/**
 * Records a failed call and decides what happens next. The same request
 * continues on the next key for every kind of failure: even a 4xx «request»
 * error may be specific to one provider/model (an unsupported parameter, a
 * file type it cannot read), so another key deserves a try — without benching
 * this one.
 */
export function markFailure(e: PoolEntry, err: any, _ctx: { hasFiles?: boolean } = {}): FailureVerdict {
  const s = stateOf(e);
  const now = Date.now();
  const kind = classifyError(err);
  if (kind === 'unsupported') {
    // Not the key's fault (the file type, not the key): no strike, no error shown on the key.
    return { kind, tryNext: true, cooldownMs: 0, message: KIND_MESSAGE[kind] };
  }
  const raw = String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 180);
  s.failures++;
  s.todayFailures++;
  s.lastErrorAt = now;
  s.lastError = `${KIND_MESSAGE[kind]} — ${raw}`;
  let cooldownMs = 0;
  const hint = retryAfterOf(err);

  switch (kind) {
    case 'rate_limit': {
      s.rateLimits++;
      s.limitStrikes++;
      const backoff = Math.min(10 * 60_000, 30_000 * 2 ** Math.max(0, s.limitStrikes - 1));
      // The provider's hint wins — unless the key keeps hitting the limit right
      // after every cooldown (e.g. a hidden daily cap): then back off further.
      cooldownMs = hint === null ? backoff : s.limitStrikes >= 3 ? Math.max(hint, backoff) : hint;
      cooldownMs = Math.max(5_000, Math.min(cooldownMs, 60 * 60_000));
      break;
    }
    case 'quota':
      s.rateLimits++;
      cooldownMs = Math.max(hint ?? 0, 60 * 60_000);
      break;
    case 'auth':
      s.invalid = true;
      break;
    case 'region':
      cooldownMs = 60 * 60_000;
      break;
    case 'model':
      cooldownMs = 10 * 60_000;
      break;
    case 'transient':
    case 'timeout':
    case 'unknown':
      s.strikes++;
      if (s.strikes >= 2) cooldownMs = Math.min(5 * 60_000, 20_000 * 2 ** (s.strikes - 2));
      break;
    case 'network':
      s.strikes++;
      if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) cooldownMs = 5 * 60_000;
      else if (s.strikes >= 2) cooldownMs = 60_000;
      break;
    case 'request':
      // Rejected by this provider/model only: try the next key, keep this one.
      break;
  }
  if (cooldownMs > 0) {
    s.cooldownUntil = Math.max(s.cooldownUntil, now + cooldownMs);
    s.cooldownKind = kind;
    s.cooldownReason = KIND_MESSAGE[kind];
  }
  onChange?.();
  return { kind, tryNext: true, cooldownMs, message: KIND_MESSAGE[kind] };
}

/** Admin «reset»: clears health (not counters). */
export function resetKey(id: string) {
  const s = states.get(id);
  if (!s) return;
  s.invalid = false;
  s.cooldownUntil = 0;
  s.cooldownKind = null;
  s.cooldownReason = null;
  s.strikes = 0;
  s.limitStrikes = 0;
  s.recent = [];
  onChange?.();
}

/** Explicit user actions skip short error cooldowns — never real rate limits. */
export function clearTransientCooldowns() {
  for (const s of states.values()) {
    if (s.cooldownKind && ['transient', 'timeout', 'network', 'unknown'].includes(s.cooldownKind)) {
      s.cooldownUntil = 0;
      s.cooldownKind = null;
      s.cooldownReason = null;
      s.strikes = 0;
    }
  }
}

export function runtimeOf(entries: PoolEntry[]): AiKeyRuntime[] {
  const now = Date.now();
  return entries.map((e) => {
    const s = stateOf(e);
    const health = healthOf(e, now);
    const limitReason = health === 'limited' ? overProactiveLimit(e, s, now) : null;
    return {
      id: e.id,
      health,
      cooldownUntil: s.cooldownUntil > now ? s.cooldownUntil : null,
      cooldownReason: s.cooldownUntil > now ? s.cooldownReason : limitReason,
      lastError: s.lastError,
      lastErrorAt: s.lastErrorAt,
      lastUsedAt: s.lastUsedAt,
      lastLatencyMs: s.lastLatencyMs,
      calls: s.calls,
      successes: s.successes,
      failures: s.failures,
      rateLimits: s.rateLimits,
      todayCalls: s.todayCalls,
      lastMinuteCalls: s.recent.filter((t) => now - t < 60_000).length,
    };
  });
}

export function todayTotals(): { calls: number; failures: number } {
  const today = dayKeyNow();
  let calls = 0;
  let failures = 0;
  for (const s of states.values()) {
    if (s.dayKey !== today) continue;
    calls += s.todayCalls;
    failures += s.todayFailures;
  }
  return { calls, failures };
}

export function exportState(): Record<string, Omit<KeyState, 'recent'>> {
  const out: Record<string, Omit<KeyState, 'recent'>> = {};
  for (const [id, s] of states) {
    const { recent: _r, ...rest } = s;
    out[id] = rest;
  }
  return out;
}

export function importState(blob: unknown) {
  if (!blob || typeof blob !== 'object') return;
  for (const [id, raw] of Object.entries(blob as Record<string, any>)) {
    if (!raw || typeof raw !== 'object' || typeof raw.fingerprint !== 'string') continue;
    states.set(id, { ...freshState(raw.fingerprint), ...raw, recent: [] });
  }
}

/** Tests only. */
export function _resetPoolForTests() {
  states.clear();
  rrCursor = 0;
}

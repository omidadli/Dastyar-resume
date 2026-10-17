/**
 * AI provider layer for HOVIDA.
 *
 * Keys come from the platform settings (/admin › کلیدهای هوش مصنوعی, up to
 * five, encrypted at rest) plus the legacy environment variables
 * (GEMINI_API_KEY, OPENAI_API_KEY/OPENAI_BASE_URL/OPENAI_MODEL). Every request
 * runs through the key pool (keypool.ts): when a key hits a rate limit, runs
 * out of quota or fails, the *same* request continues on the next key, so the
 * user never notices. Only when every key is benched do callers fall back to
 * the clearly-labelled local engine.
 *
 * Providers:
 *  - gemini  — Google Gemini (optional custom base URL for a proxy/mirror).
 *  - openai  — any OpenAI-compatible chat/completions gateway.
 */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AiStatus } from '../../src/types/app';
import type { AiCallLog, AiPurpose } from '../../src/types/admin';
import * as db from '../db';
import * as pool from './keypool';
import type { PoolEntry } from './keypool';
import { aiSettings, envForcedOff, keyEntryForTest, poolEntries } from '../platform';

export type ProviderId = 'gemini' | 'openai';

export interface AiFile {
  mimeType: string;
  base64: string;
  fileName?: string;
}

export interface GenerateOptions {
  temperature?: number;
  /** Budget for a single upstream call. */
  timeoutMs?: number;
  /** Absolute budget across keys / models / retries. */
  deadlineMs?: number;
  /** `deep` asks the model to think harder (user-requested deep review). */
  depth?: 'fast' | 'deep';
  /** Attachments for multimodal reading (PDF pages, scans, photos, audio/video). */
  files?: AiFile[];
  /** @deprecated single attachment — use `files`. */
  file?: AiFile;
  /** When true and no key can read the attachments, continue with text only. */
  fileOptional?: boolean;
  /** Expect a JSON object back (default true). */
  json?: boolean;
  /** System instruction (the behaviour configuration). */
  system?: string;
  purpose?: AiPurpose;
  /** Admin «test this key»: use only this key, even if it is benched. */
  onlyKeyId?: string;
}

export class AiUnavailableError extends Error {
  constructor(message = 'AI_NOT_CONFIGURED') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/** Thrown when every key is benched right now (callers use the local engine). */
export const CIRCUIT_OPEN = 'AI_CIRCUIT_OPEN';

// ------------------------------------------------------------- persistence ----

let poolLoaded = false;
let persistTimer: NodeJS.Timeout | null = null;

function ensurePoolLoaded() {
  if (poolLoaded) return;
  poolLoaded = true;
  try {
    pool.importState(db.getAiStatsBlob());
  } catch {
    /* fresh state */
  }
  pool.setChangeListener(() => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      db.setAiStatsBlob(pool.exportState());
    }, 4000);
    persistTimer.unref?.();
  });
}

/** Shutdown: hand pending key health/usage to the store before it is flushed. */
export function flushAiState() {
  if (!poolLoaded) return;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  db.setAiStatsBlob(pool.exportState());
}

// ------------------------------------------------------------------- calls ----

const CALL_LOG_CAP = 400;
const callLog: AiCallLog[] = [];
let callSeq = 0;

function logCall(entry: Omit<AiCallLog, 'id'>) {
  callLog.unshift({ id: `c${Date.now().toString(36)}${(callSeq++).toString(36)}`, ...entry });
  if (callLog.length > CALL_LOG_CAP) callLog.length = CALL_LOG_CAP;
}

export function recentCalls(limit = 200): AiCallLog[] {
  return callLog.slice(0, Math.max(1, Math.min(CALL_LOG_CAP, limit)));
}

// ------------------------------------------------------------------ config ----

const GEMINI_DEFAULT = 'gemini-3.5-flash-lite';
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];
const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

export function modelOf(e: PoolEntry): string {
  return e.model || (e.provider === 'gemini' ? GEMINI_DEFAULT : OPENAI_DEFAULT_MODEL);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function providerLabel(e: PoolEntry): string {
  if (e.provider === 'gemini') return e.baseUrl ? `Gemini (${hostOf(e.baseUrl)})` : 'Gemini';
  return hostOf(e.baseUrl || OPENAI_DEFAULT_BASE);
}

interface RuntimeConfig {
  envOff: boolean;
  enabled: boolean;
  strategy: 'failover' | 'round-robin';
  temperature: number;
  fastTimeoutSec: number;
  deepTimeoutSec: number;
  entries: PoolEntry[];
}

export function runtimeConfig(): RuntimeConfig {
  const s = aiSettings();
  return {
    envOff: envForcedOff(),
    enabled: s.enabled,
    strategy: s.strategy,
    temperature: s.temperature,
    fastTimeoutSec: s.fastTimeoutSec,
    deepTimeoutSec: s.deepTimeoutSec,
    entries: poolEntries(),
  };
}

/** Admin-tuned time budgets: per call and per request (across failover). */
export function aiBudgets(depth: 'fast' | 'deep'): { timeoutMs: number; deadlineMs: number } {
  const s = aiSettings();
  const sec = depth === 'deep' ? s.deepTimeoutSec : s.fastTimeoutSec;
  // One slow key may use 60% of the budget; the rest is left for failover.
  return { timeoutMs: Math.max(8_000, Math.round(sec * 1000 * 0.6)), deadlineMs: sec * 1000 };
}

export function aiTemperature(): number {
  return aiSettings().temperature;
}

const timeFa = (ms: number) => {
  const sec = Math.max(1, Math.round(ms / 1000));
  return sec < 90 ? `${sec.toLocaleString('fa-IR')} ثانیه` : `${Math.round(sec / 60).toLocaleString('fa-IR')} دقیقه`;
};

export function aiStatus(): AiStatus {
  ensurePoolLoaded();
  const cfg = runtimeConfig();
  const off = (reason: string): AiStatus => ({ available: false, provider: null, model: null, label: 'غیرفعال', reason, coolingDown: false, keys: 0, readyKeys: 0 });
  if (cfg.envOff) return off('هوش مصنوعی روی این سرور خاموش است (AI_PROVIDER=off).');
  if (!cfg.enabled) return off('هوش مصنوعی توسط مدیر سامانه غیرفعال شده است.');
  if (!cfg.entries.length) return off('هنوز هیچ کلید هوش مصنوعی ثبت نشده است؛ مدیر سامانه باید از پنل مدیریت کلید اضافه کند.');
  const runtime = pool.runtimeOf(cfg.entries);
  const usable = cfg.entries.filter((_, i) => runtime[i].health !== 'invalid');
  if (!usable.length) return off('کلیدهای هوش مصنوعی ثبت‌شده پذیرفته نشدند؛ مدیر سامانه باید آن‌ها را در پنل مدیریت بررسی کند.');
  const readyIdx = runtime.findIndex((r) => r.health === 'ready');
  const ready = runtime.filter((r) => r.health === 'ready').length;
  const lead = readyIdx >= 0 ? cfg.entries[readyIdx] : usable[0];
  const cooling = ready === 0;
  const next = cooling ? pool.nextAvailableAt(cfg.entries) : null;
  const n = cfg.entries.length;
  return {
    available: true,
    provider: lead.provider,
    model: modelOf(lead),
    // The count must follow a Persian word: right after the Latin model name the
    // bidi algorithm would pull «۲» into the Latin run, away from «از ۵».
    label: `${providerLabel(lead)} · ${modelOf(lead)}${n > 1 ? `، کلیدهای آماده: ${ready.toLocaleString('fa-IR')} از ${n.toLocaleString('fa-IR')}` : ''}`,
    reason: cooling
      ? `همه کلیدهای هوش مصنوعی موقتاً به محدودیت خورده‌اند${next ? `؛ حدود ${timeFa(next - Date.now())} دیگر خودکار برمی‌گردند` : ''}. تا آن زمان موتور محلی کار می‌کند.`
      : null,
    coolingDown: cooling,
    keys: n,
    readyKeys: ready,
  };
}

/** True while every key is benched. */
export function isCircuitOpen(): boolean {
  const cfg = runtimeConfig();
  return cfg.entries.length > 0 && pool.orderEntries(cfg.entries, 'failover').length === 0;
}

/** Explicit user actions (re-run, test) are not blocked by short error cooldowns. */
export function resetCircuitBreaker() {
  pool.clearTransientCooldowns();
}

// ---------------------------------------------------------- capabilities ----

const GEMINI_TYPES =
  /^(application\/pdf|text\/plain|image\/(png|jpeg|webp|heic|heif)|audio\/(wav|x-wav|mp3|mpeg|aiff|x-aiff|aac|ogg|flac|x-flac|mp4|x-m4a|m4a|webm)|video\/(mp4|mpeg|mov|quicktime|avi|x-msvideo|x-flv|mpg|webm|wmv|x-ms-wmv|3gpp))$/i;
const OPENAI_TYPES = /^(application\/pdf|image\/(png|jpeg|webp|gif|heic|heif))$/i;

function canRead(e: PoolEntry, f: AiFile): boolean {
  return e.provider === 'gemini' ? GEMINI_TYPES.test(f.mimeType) : OPENAI_TYPES.test(f.mimeType);
}

/** Gemini inline requests are limited to ~20 MB in total. */
const GEMINI_INLINE_BUDGET = 19 * 1024 * 1024;

function unsupported(message: string) {
  return Object.assign(new Error(message), { code: 'UNSUPPORTED_INPUT' });
}

/** Files in the shape the key's provider accepts (HEIC → JPEG for gateways). */
async function adaptFiles(e: PoolEntry, files: AiFile[], fileOptional: boolean): Promise<AiFile[]> {
  const out: AiFile[] = [];
  for (const f of files) {
    if (!canRead(e, f)) {
      if (!fileOptional) throw unsupported(`فرمت ${f.mimeType} برای ${providerLabel(e)} قابل خواندن نیست`);
      continue;
    }
    if (e.provider === 'openai' && /heic|heif/i.test(f.mimeType)) {
      try {
        const { heicToJpeg } = await import('../ingest/images');
        const jpg = await heicToJpeg(Buffer.from(f.base64, 'base64'));
        out.push({ mimeType: 'image/jpeg', base64: jpg.toString('base64'), fileName: f.fileName });
        continue;
      } catch {
        if (!fileOptional) throw unsupported('تبدیل تصویر HEIC ممکن نشد');
        continue;
      }
    }
    out.push(f);
  }
  if (e.provider === 'gemini') {
    let total = 0;
    const kept: AiFile[] = [];
    for (const f of out) {
      total += f.base64.length;
      if (total > GEMINI_INLINE_BUDGET) break;
      kept.push(f);
    }
    if (!kept.length && out.length && !fileOptional) throw unsupported('حجم فایل برای ارسال به هوش مصنوعی بیش از حد است');
    return kept;
  }
  return out;
}

// --------------------------------------------------------------- generate ----

export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  ensurePoolLoaded();
  const cfg = runtimeConfig();
  if (cfg.envOff || !cfg.enabled || !cfg.entries.length) throw new AiUnavailableError();
  const files = opts.files?.length ? opts.files : opts.file ? [opts.file] : [];
  let ordered: PoolEntry[];
  if (opts.onlyKeyId) {
    const only = cfg.entries.find((e) => e.id === opts.onlyKeyId);
    if (!only) throw new AiUnavailableError('KEY_NOT_FOUND');
    ordered = [only];
  } else {
    ordered = pool.orderEntries(cfg.entries, cfg.strategy, files.length ? (e) => files.every((f) => canRead(e, f)) : undefined);
  }
  if (!ordered.length) throw new Error(CIRCUIT_OPEN);

  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const temperature = opts.temperature ?? cfg.temperature;
  let lastErr: any = null;
  let switchedFrom: string | null = null;

  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i];
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    const isLast = i === ordered.length - 1;
    let sendFiles: AiFile[];
    try {
      sendFiles = await adaptFiles(entry, files, Boolean(opts.fileOptional));
    } catch (err) {
      lastErr = err; // this provider can't read the file — the next one may
      continue;
    }
    const started = Date.now();
    pool.noteAttempt(entry);
    try {
      const { text, model } =
        entry.provider === 'gemini'
          ? await callGemini(entry, prompt, sendFiles, { ...opts, temperature }, deadline, isLast)
          : await callOpenAI(entry, prompt, sendFiles, { ...opts, temperature }, deadline);
      const latency = Date.now() - started;
      pool.markSuccess(entry, latency);
      logCall({
        at: started,
        keyId: entry.id,
        keyLabel: entry.label,
        provider: entry.provider,
        model,
        purpose: opts.purpose || 'other',
        ok: true,
        latencyMs: latency,
        error: null,
        switchedFrom,
        attachments: sendFiles.length,
      });
      return text;
    } catch (err: any) {
      const verdict = pool.markFailure(entry, err, { hasFiles: sendFiles.length > 0 });
      logCall({
        at: started,
        keyId: entry.id,
        keyLabel: entry.label,
        provider: entry.provider,
        model: modelOf(entry),
        purpose: opts.purpose || 'other',
        ok: false,
        latencyMs: Date.now() - started,
        error: `${verdict.message} — ${String(err?.message || err).slice(0, 160)}`,
        switchedFrom,
        attachments: sendFiles.length,
      });
      lastErr = err;
      if (!verdict.tryNext) throw err;
      switchedFrom = entry.label;
      if (ordered.length > 1 && !isLast) {
        console.warn(`[ai] «${entry.label}» → ${verdict.message}; switching to the next key.`);
      }
    }
  }
  throw lastErr || new Error(CIRCUIT_OPEN);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`Timeout after ${ms}ms on ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => timer && clearTimeout(timer)) as Promise<T>;
}

const geminiClients = new Map<string, GoogleGenAI>();

function geminiClient(e: PoolEntry): GoogleGenAI {
  const cacheKey = `${e.id}|${e.baseUrl}|${e.apiKey.slice(-6)}`;
  let client = geminiClients.get(cacheKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey: e.apiKey, ...(e.baseUrl ? { httpOptions: { baseUrl: e.baseUrl } } : {}) });
    geminiClients.set(cacheKey, client);
  }
  return client;
}

/** Models that rejected our thinking config (base URL|model) — sent without it from then on. */
const noThinking = new Set<string>();

function thinkingFor(model: string, deep: boolean): Record<string, unknown> | undefined {
  if (/^gemini-3/.test(model) || /latest$/.test(model)) {
    return { thinkingConfig: { thinkingLevel: deep ? ThinkingLevel.HIGH : ThinkingLevel.LOW } };
  }
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingConfig: { thinkingBudget: deep ? 4096 : 0 } };
  return undefined;
}

async function callGemini(
  e: PoolEntry,
  prompt: string,
  files: AiFile[],
  opts: GenerateOptions,
  deadline: number,
  lastResort: boolean
): Promise<{ text: string; model: string }> {
  const client = geminiClient(e);
  // A model chosen by the admin is respected; the default gets fallbacks.
  const models = e.model ? [e.model] : Array.from(new Set([GEMINI_DEFAULT, ...GEMINI_FALLBACKS]));
  const perCall = opts.timeoutMs ?? 12_000;
  const contents = files.length
    ? { parts: [...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.base64 } })), { text: prompt }] }
    : prompt;
  let lastError: any = null;
  for (const model of models) {
    const memo = `${e.baseUrl}|${model}`;
    let thinking = noThinking.has(memo) ? undefined : thinkingFor(model, opts.depth === 'deep');
    // At most two tries per model: the second only without a rejected thinking config.
    for (let attempt = 0; attempt < 2; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining < 1500) throw lastError || new Error(`Timeout before ${model} could be tried`);
      const controller = new AbortController();
      try {
        const res = await withTimeout(
          client.models.generateContent({
            model,
            contents,
            config: {
              temperature: opts.temperature ?? 0.1,
              responseMimeType: opts.json === false ? 'text/plain' : 'application/json',
              ...(opts.system ? { systemInstruction: opts.system } : {}),
              ...(thinking || {}),
              abortSignal: controller.signal,
            },
          }),
          Math.max(2_000, Math.min(perCall, remaining)),
          model,
          () => controller.abort()
        );
        if (res.text) return { text: res.text, model };
        lastError = Object.assign(new Error(`مدل ${model} پاسخ متنی برنگرداند`), { status: 502 });
        break;
      } catch (err: any) {
        lastError = err;
        const kind = pool.classifyError(err);
        // e.g. «Thinking level is not supported for this model» / «Budget 0 is
        // invalid. This model only works in thinking mode»: same model, no config.
        if (thinking && (kind === 'request' || kind === 'model' || kind === 'unknown') && /thinking|budget/i.test(String(err?.message || ''))) {
          thinking = undefined;
          noThinking.add(memo);
          continue;
        }
        // Same key, next model: unknown model or a model-level overload. Gemini
        // free-tier limits are per model, so on the last usable key a 429 may
        // still pass on a sibling model.
        if (kind === 'model' || kind === 'transient' || (kind === 'rate_limit' && lastResort)) break;
        throw err;
      }
    }
  }
  throw lastError || new Error('All Gemini models are temporarily unavailable.');
}

function openAIContent(prompt: string, files: AiFile[]): any {
  if (!files.length) return prompt;
  const parts: any[] = [];
  for (const f of files) {
    if (f.mimeType === 'application/pdf') {
      parts.push({ type: 'file', file: { filename: f.fileName || 'resume.pdf', file_data: `data:application/pdf;base64,${f.base64}` } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: `data:${f.mimeType};base64,${f.base64}` } });
    }
  }
  parts.push({ type: 'text', text: prompt });
  return parts;
}

function retryAfterHeader(res: Response): number | null {
  const ms = Number(res.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const ra = res.headers.get('retry-after');
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec)) return sec * 1000;
    const at = Date.parse(ra);
    if (!isNaN(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

/** Models that reject a custom `temperature` (GPT-5, o-series…) — base URL|model. */
const noTemperature = new Set<string>();

async function callOpenAI(e: PoolEntry, prompt: string, files: AiFile[], opts: GenerateOptions, deadline: number): Promise<{ text: string; model: string }> {
  const base = (e.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, '');
  const model = modelOf(e);
  const perCall = opts.timeoutMs ?? 20_000;
  const wantJson = opts.json !== false;
  const memo = `${base}|${model}`;
  let useFiles = files.length > 0;
  let jsonMode = wantJson;
  let sendTemperature = !noTemperature.has(memo);
  let lastError: any = null;
  const systemText = [
    opts.system || 'You are HOVIDA, a careful, evidence-based HR screening assistant.',
    wantJson ? 'Reply with one valid JSON object only — no markdown, no commentary.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  for (let attempt = 0; attempt < 4; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 1500) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(3_000, Math.min(perCall, remaining)));
    try {
      const body: any = {
        model,
        ...(sendTemperature ? { temperature: opts.temperature ?? 0.1 } : {}),
        messages: [
          { role: 'system', content: systemText },
          { role: 'user', content: openAIContent(prompt, useFiles ? files : []) },
        ],
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${e.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (res.ok) {
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          throw Object.assign(new Error('پاسخ سرویس هوش مصنوعی قابل خواندن نبود'), { status: 502 });
        }
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
          ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : String(content ?? '');
        if (text.trim()) return { text, model };
        lastError = Object.assign(new Error('سرویس هوش مصنوعی پاسخ خالی برگرداند'), { status: 502 });
        continue;
      }
      const err = Object.assign(new Error(`OpenAI-compatible ${res.status}: ${raw.slice(0, 300)}`), {
        status: res.status,
        retryAfterMs: retryAfterHeader(res),
      });
      if (res.status === 400 || res.status === 415 || res.status === 422) {
        if (sendTemperature && /temperature/i.test(raw)) {
          // «Unsupported value: 'temperature' does not support 0.1 with this model»
          sendTemperature = false;
          noTemperature.add(memo);
          lastError = err;
          continue;
        }
        if (jsonMode && /response_format|json_object|json mode/i.test(raw)) {
          jsonMode = false; // gateway doesn't support JSON mode — the prompt still demands JSON
          lastError = err;
          continue;
        }
        if (useFiles && opts.fileOptional) {
          useFiles = false; // gateway/model can't read files — fall back to the extracted text
          lastError = err;
          continue;
        }
      }
      throw err;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error(`Timeout on ${model} (${hostOf(base)})`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('OpenAI-compatible provider did not answer in time.');
}

// ------------------------------------------------------------------ tests ----

export interface KeyTestResult {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  model: string;
  error: string | null;
}

const PING = 'Return exactly this JSON: {"ok": true, "message": "سلام"}';

/** Round-trip through one specific key (ignores its cooldown; success clears it). */
export async function testKey(id: string): Promise<KeyTestResult> {
  ensurePoolLoaded();
  const entry = keyEntryForTest(id);
  if (!entry) return { id, label: '—', ok: false, latencyMs: 0, model: '', error: 'این کلید فعال نیست یا یافت نشد.' };
  pool.resetKey(id);
  const started = Date.now();
  try {
    const out = await generateWith(entry, PING);
    const ok = /"ok"\s*:\s*true/.test(out);
    return { id, label: entry.label, ok, latencyMs: Date.now() - started, model: modelOf(entry), error: ok ? null : 'پاسخ دریافت شد اما در قالب مورد انتظار نبود.' };
  } catch (err: any) {
    return { id, label: entry.label, ok: false, latencyMs: Date.now() - started, model: modelOf(entry), error: friendlyAiError(err, entry) };
  }
}

async function generateWith(entry: PoolEntry, prompt: string): Promise<string> {
  pool.noteAttempt(entry);
  const started = Date.now();
  try {
    const deadline = Date.now() + 30_000;
    const r =
      entry.provider === 'gemini'
        ? await callGemini(entry, prompt, [], { temperature: 0, timeoutMs: 20_000, purpose: 'test' }, deadline, true)
        : await callOpenAI(entry, prompt, [], { temperature: 0, timeoutMs: 20_000, purpose: 'test' }, deadline);
    pool.markSuccess(entry, Date.now() - started);
    logCall({ at: started, keyId: entry.id, keyLabel: entry.label, provider: entry.provider, model: r.model, purpose: 'test', ok: true, latencyMs: Date.now() - started, error: null, switchedFrom: null, attachments: 0 });
    return r.text;
  } catch (err: any) {
    const verdict = pool.markFailure(entry, err);
    logCall({ at: started, keyId: entry.id, keyLabel: entry.label, provider: entry.provider, model: modelOf(entry), purpose: 'test', ok: false, latencyMs: Date.now() - started, error: `${verdict.message} — ${String(err?.message || err).slice(0, 160)}`, switchedFrom: null, attachments: 0 });
    throw err;
  }
}

/** «تنظیمات › هوش مصنوعی › آزمایش اتصال»: one round-trip through the pool. */
export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const started = Date.now();
  resetCircuitBreaker();
  try {
    const out = await generate(PING, { temperature: 0, timeoutMs: 20_000, deadlineMs: 40_000, purpose: 'test' });
    const ok = /"ok"\s*:\s*true/.test(out);
    return { ok, latencyMs: Date.now() - started, error: ok ? null : 'پاسخ دریافت شد اما در قالب مورد انتظار نبود.' };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - started, error: friendlyAiError(err) };
  }
}

/** Converts provider/network failures into honest, actionable Persian messages. */
export function friendlyAiError(err: any, entry?: PoolEntry): string {
  if (err instanceof AiUnavailableError || err?.message === 'AI_NOT_CONFIGURED') {
    return 'هوش مصنوعی هنوز پیکربندی نشده است؛ مدیر سامانه باید در پنل مدیریت (/admin) دست‌کم یک کلید ثبت کند.';
  }
  if (err?.message === CIRCUIT_OPEN) {
    return 'همه کلیدهای هوش مصنوعی موقتاً به محدودیت خورده‌اند؛ چند لحظه دیگر دوباره تلاش کنید.';
  }
  if (err?.code === 'UNSUPPORTED_INPUT') return String(err.message || 'این نوع فایل برای سرویس هوش مصنوعی قابل خواندن نیست.');
  const kind = pool.classifyError(err);
  const where = entry ? ` (${providerLabel(entry)})` : '';
  switch (kind) {
    case 'auth':
      if (entry?.provider === 'gemini' && entry.apiKey.startsWith('AQ.')) {
        return 'توکن موقت Gemini (پیشوند AQ.) پذیرفته نشد یا منقضی شده است؛ یک کلید دائمی با پیشوند AIza بسازید.';
      }
      return `کلید${where} پذیرفته نشد؛ کلید، آدرس سرویس و نام مدل را بررسی کنید.`;
    case 'region':
      return `سرویس${where} از منطقه جغرافیایی این سرور پشتیبانی نمی‌کند؛ برای Gemini یک آدرس پراکسی/درگاه در تنظیمات کلید وارد کنید یا از درگاه سازگار با OpenAI استفاده کنید.`;
    case 'model':
      if (/\blimit\s*[:=]\s*0\b/i.test(String(err?.message || ''))) {
        return `این مدل${where} برای سطح فعلی کلید سهمیه‌ای ندارد؛ مدل دیگری انتخاب کنید (یا فیلد مدل را خالی بگذارید تا مدل‌های جایگزین خودکار امتحان شوند).`;
      }
      if (entry?.provider === 'openai' && Number(err?.status) === 404 && !/model/i.test(String(err?.message || '').replace(/^OpenAI-compatible 404:\s*/, ''))) {
        return `آدرس سرویس${where} پیدا نشد (۴۰۴)؛ آدرس پایه را بررسی کنید — بیشتر درگاه‌ها به «/v1» در انتهای آدرس نیاز دارند.`;
      }
      return `مدل انتخاب‌شده${where} یافت نشد یا برای این کلید در دسترس نیست؛ نام مدل را بررسی کنید.`;
    case 'rate_limit':
      return 'محدودیت نرخ سرویس هوش مصنوعی پر شده است؛ چند لحظه دیگر دوباره تلاش کنید.';
    case 'quota':
      return `سهمیه یا اعتبار کلید${where} تمام شده است.`;
    case 'network':
    case 'timeout':
      return `ارتباط با سرویس هوش مصنوعی${where} برقرار نشد یا پاسخ دیر رسید؛ شبکه سرور یا آدرس سرویس را بررسی کنید.`;
    case 'request':
      return `سرویس هوش مصنوعی${where} درخواست را نپذیرفت (${String(err?.message || '').slice(0, 120)}).`;
    default:
      return 'پاسخ سرویس هوش مصنوعی دریافت نشد؛ لطفاً دوباره تلاش کنید.';
  }
}

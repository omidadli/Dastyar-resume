/**
 * AI provider abstraction for HOVIDA.
 *
 * The platform operator chooses the engine through environment variables:
 *
 *   AI_PROVIDER      auto | gemini | openai | off        (default: auto)
 *   GEMINI_API_KEY   Google AI Studio key                 (provider: gemini)
 *   GEMINI_MODEL     optional model override
 *   OPENAI_API_KEY   key of any OpenAI-compatible gateway (provider: openai)
 *   OPENAI_BASE_URL  e.g. https://api.openai.com/v1 or an Iranian gateway URL
 *   OPENAI_MODEL     e.g. gpt-4o-mini
 *
 * `auto` prefers Gemini when its key exists, otherwise the OpenAI-compatible
 * gateway. A shared circuit breaker stops hammering a failing provider; callers
 * then fall back to the clearly-labelled local engine.
 */
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AiStatus } from '../../src/types/app';

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
  /** Absolute budget across failover models / retries. */
  deadlineMs?: number;
  /** `deep` asks the model to think harder (user-requested deep review). */
  depth?: 'fast' | 'deep';
  /** Original resume file (PDF / image) for multimodal reading. */
  file?: AiFile;
  /** When true and the provider rejects the file part, retry with text only. */
  fileOptional?: boolean;
  /** Expect a JSON object back (default true). */
  json?: boolean;
}

export class AiUnavailableError extends Error {
  constructor(message = 'AI_NOT_CONFIGURED') {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

// ---------------------------------------------------------------- breaker ----

export const CIRCUIT_OPEN = 'AI_CIRCUIT_OPEN';
let circuitOpenUntil = 0;
let consecutiveFailures = 0;

export function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}
export function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}
export function resetCircuitBreaker() {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}
export function recordFailure(isQuota: boolean, isHighDemand: boolean) {
  // 503 "high demand" spikes are short and model-level; they don't trip the breaker.
  if (isHighDemand) return;
  consecutiveFailures++;
  if (consecutiveFailures >= 5) circuitOpenUntil = Date.now() + (isQuota ? 15_000 : 8_000);
}

function isQuotaError(err: any): boolean {
  return err?.status === 429 || /429|quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(String(err?.message || ''));
}
function isHighDemandError(err: any): boolean {
  return err?.status === 503 || /503|UNAVAILABLE|overloaded|high demand/i.test(String(err?.message || ''));
}
function isFatalAuthError(err: any): boolean {
  const status = err?.status || err?.code;
  const msg = String(err?.message || '');
  return status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|invalid_api_key|Incorrect API key/i.test(msg);
}

// ----------------------------------------------------------- configuration ----

export function resolveProvider(): ProviderId | null {
  const pref = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase();
  const hasGemini = Boolean(process.env.GEMINI_API_KEY?.trim());
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (pref === 'off' || pref === 'none' || pref === 'disabled') return null;
  if (pref === 'gemini') return hasGemini ? 'gemini' : null;
  if (pref === 'openai') return hasOpenAI ? 'openai' : null;
  return hasGemini ? 'gemini' : hasOpenAI ? 'openai' : null;
}

const GEMINI_DEFAULT = 'gemini-3.5-flash-lite';
const GEMINI_FALLBACKS = ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.1-flash-lite'];

/** GEMINI_MODEL is honoured whenever it looks like a model id (no more silent deny-list). */
export function resolveGeminiModel(): string {
  const env = process.env.GEMINI_MODEL?.trim().replace(/^models\//, '');
  if (env && /^gemini-[\w.-]{2,60}$/.test(env)) return env;
  return GEMINI_DEFAULT;
}

export function resolveOpenAIModel(): string {
  return process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
}

function openAIBase(): string {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/+$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function aiStatus(): AiStatus {
  const provider = resolveProvider();
  if (!provider) {
    const off = /^(off|none|disabled)$/i.test(process.env.AI_PROVIDER || '');
    return {
      available: false,
      provider: null,
      model: null,
      label: 'غیرفعال',
      reason: off
        ? 'هوش مصنوعی توسط مدیر سامانه غیرفعال شده است.'
        : 'هیچ کلید هوش مصنوعی روی سرور تنظیم نشده است (GEMINI_API_KEY یا OPENAI_API_KEY).',
      coolingDown: false,
    };
  }
  const model = provider === 'gemini' ? resolveGeminiModel() : resolveOpenAIModel();
  const cooling = isCircuitOpen();
  return {
    available: true,
    provider,
    model,
    label: provider === 'gemini' ? `Gemini · ${model}` : `${hostOf(openAIBase())} · ${model}`,
    reason: cooling ? 'سرویس هوش مصنوعی پس از چند خطای پیاپی، چند ثانیه در حالت استراحت است.' : null,
    coolingDown: cooling,
  };
}

// --------------------------------------------------------------- generate ----

export async function generate(prompt: string, opts: GenerateOptions = {}): Promise<string> {
  const provider = resolveProvider();
  if (!provider) throw new AiUnavailableError();
  if (isCircuitOpen()) throw new Error(CIRCUIT_OPEN);
  try {
    const text = provider === 'gemini' ? await generateGemini(prompt, opts) : await generateOpenAI(prompt, opts);
    recordSuccess();
    return text;
  } catch (err: any) {
    recordFailure(isQuotaError(err), isHighDemandError(err));
    throw err;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms on ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => timer && clearTimeout(timer)) as Promise<T>;
}

async function generateGemini(prompt: string, opts: GenerateOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new AiUnavailableError();
  const client = new GoogleGenAI({ apiKey });
  const models = Array.from(new Set([resolveGeminiModel(), ...GEMINI_FALLBACKS]));
  const perCall = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const contents = opts.file
    ? { parts: [{ inlineData: { mimeType: opts.file.mimeType, data: opts.file.base64 } }, { text: prompt }] }
    : prompt;

  let lastError: any = null;
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const res = await withTimeout(
        client.models.generateContent({
          model,
          contents,
          config: {
            temperature: opts.temperature ?? 0.1,
            responseMimeType: opts.json === false ? 'text/plain' : 'application/json',
            thinkingConfig: { thinkingLevel: opts.depth === 'deep' ? ThinkingLevel.HIGH : ThinkingLevel.LOW },
          },
        }),
        Math.max(2_000, Math.min(perCall, remaining)),
        model
      );
      if (res.text) return res.text;
      lastError = new Error(`مدل ${model} پاسخ متنی برنگرداند`);
    } catch (err: any) {
      lastError = err;
      if (isFatalAuthError(err)) break; // same key for every model
      console.warn(`[ai:gemini] ${model} failed: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  throw lastError || new Error('All Gemini models are temporarily unavailable.');
}

const OPENAI_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function openAIContent(prompt: string, file?: AiFile): any {
  if (!file) return prompt;
  const parts: any[] = [];
  if (file.mimeType === 'application/pdf') {
    parts.push({
      type: 'file',
      file: { filename: file.fileName || 'resume.pdf', file_data: `data:application/pdf;base64,${file.base64}` },
    });
  } else if (OPENAI_IMAGE_TYPES.includes(file.mimeType)) {
    parts.push({ type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.base64}` } });
  }
  parts.push({ type: 'text', text: prompt });
  return parts;
}

async function generateOpenAI(prompt: string, opts: GenerateOptions): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new AiUnavailableError();
  const deadline = Date.now() + (opts.deadlineMs ?? 30_000);
  const perCall = opts.timeoutMs ?? 20_000;
  const wantJson = opts.json !== false;
  const fileSupported =
    !!opts.file && (opts.file.mimeType === 'application/pdf' || OPENAI_IMAGE_TYPES.includes(opts.file.mimeType));
  if (opts.file && !fileSupported && !opts.fileOptional) {
    throw Object.assign(new Error(`فرمت ${opts.file.mimeType} برای این سرویس هوش مصنوعی پشتیبانی نمی‌شود`), { status: 415 });
  }
  let useFile = fileSupported;
  let jsonMode = wantJson;
  let lastError: any = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(3_000, Math.min(perCall, remaining)));
    try {
      const body: any = {
        model: resolveOpenAIModel(),
        temperature: opts.temperature ?? 0.1,
        messages: [
          {
            role: 'system',
            content: wantJson
              ? 'You are HOVIDA, a careful, evidence-based HR screening assistant. Reply with one valid JSON object only — no markdown, no commentary.'
              : 'You are HOVIDA, a careful, evidence-based HR screening assistant.',
          },
          { role: 'user', content: openAIContent(prompt, useFile ? opts.file : undefined) },
        ],
      };
      if (jsonMode) body.response_format = { type: 'json_object' };
      const res = await fetch(`${openAIBase()}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (res.ok) {
        let data: any = null;
        try {
          data = JSON.parse(raw);
        } catch {
          throw new Error('پاسخ سرویس هوش مصنوعی قابل خواندن نبود');
        }
        const content = data?.choices?.[0]?.message?.content;
        const text = Array.isArray(content)
          ? content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
          : String(content ?? '');
        if (text.trim()) return text;
        lastError = new Error('سرویس هوش مصنوعی پاسخ خالی برگرداند');
        continue;
      }
      const err = Object.assign(new Error(`OpenAI-compatible ${res.status}: ${raw.slice(0, 240)}`), { status: res.status });
      if (res.status === 400 || res.status === 415 || res.status === 422) {
        if (jsonMode && /response_format|json_object|json mode/i.test(raw)) {
          jsonMode = false; // gateway doesn't support JSON mode — the prompt still demands JSON
          lastError = err;
          continue;
        }
        if (useFile && opts.fileOptional) {
          useFile = false; // gateway/model can't read files — fall back to the extracted text
          lastError = err;
          continue;
        }
      }
      throw err;
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        lastError = new Error(`Timeout on ${resolveOpenAIModel()}`);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('OpenAI-compatible provider did not answer in time.');
}

/** Small round-trip used by «تنظیمات › هوش مصنوعی › آزمایش اتصال». */
export async function testConnection(): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const started = Date.now();
  resetCircuitBreaker();
  try {
    const out = await generate('Return exactly this JSON: {"ok": true, "message": "سلام"}', {
      temperature: 0,
      timeoutMs: 20_000,
      deadlineMs: 30_000,
    });
    const ok = /"ok"\s*:\s*true/.test(out);
    return { ok, latencyMs: Date.now() - started, error: ok ? null : 'پاسخ دریافت شد اما در قالب مورد انتظار نبود.' };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - started, error: friendlyAiError(err) };
  }
}

/** Converts provider/network failures into honest, actionable Persian messages. */
export function friendlyAiError(err: any): string {
  if (err instanceof AiUnavailableError || err?.message === 'AI_NOT_CONFIGURED') {
    return 'هوش مصنوعی روی این سرور پیکربندی نشده است؛ مدیر سامانه باید کلید GEMINI_API_KEY یا OPENAI_API_KEY را تنظیم کند.';
  }
  if (err?.message === CIRCUIT_OPEN) {
    return 'سرویس هوش مصنوعی پس از چند خطای پیاپی موقتاً در حالت استراحت است؛ چند ثانیه دیگر دوباره تلاش کنید.';
  }
  const status = err?.status || err?.code;
  const msg = String(err?.message || '');
  const provider = resolveProvider();
  if (isFatalAuthError(err) || status === 400) {
    if (provider === 'gemini' && (process.env.GEMINI_API_KEY || '').trim().startsWith('AQ.')) {
      return 'توکن موقت Gemini (پیشوند AQ.) پذیرفته نشد یا منقضی شده است؛ یک کلید دائمی با پیشوند AIza بسازید و در GEMINI_API_KEY قرار دهید.';
    }
    return provider === 'openai'
      ? 'کلید یا آدرس سرویس سازگار با OpenAI پذیرفته نشد؛ OPENAI_API_KEY، OPENAI_BASE_URL و OPENAI_MODEL را بررسی کنید.'
      : 'کلید GEMINI_API_KEY نامعتبر است یا به مدل انتخاب‌شده دسترسی ندارد.';
  }
  if (isQuotaError(err)) {
    return 'سهمیه یا محدودیت نرخ سرویس هوش مصنوعی پر شده است؛ چند لحظه دیگر دوباره تلاش کنید.';
  }
  if (/fetch failed|ECONN|network|ENOTFOUND|timeout|timed? ?out|socket/i.test(msg)) {
    return provider === 'openai'
      ? `ارتباط با سرویس هوش مصنوعی (${hostOf(openAIBase())}) برقرار نشد؛ شبکه سرور یا آدرس OPENAI_BASE_URL را بررسی کنید.`
      : 'ارتباط با سرویس Gemini برقرار نشد (شبکه یا فایروال سرور)؛ دسترسی سرور به generativelanguage.googleapis.com را بررسی کنید.';
  }
  return 'پاسخ سرویس هوش مصنوعی دریافت نشد؛ لطفاً دوباره تلاش کنید.';
}

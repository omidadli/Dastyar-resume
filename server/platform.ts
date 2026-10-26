/**
 * Platform settings managed from /admin — persisted in the store snapshot.
 *
 *  - AI: up to five provider keys (encrypted at rest), failover strategy,
 *    temperature and time budgets. Keys from the environment
 *    (GEMINI_API_KEY / OPENAI_API_KEY) still work and appear read-only.
 *  - System switches: signup, demo, upload limits, announcement banner,
 *    maintenance mode, session length.
 *  - AI behaviour configuration (see ai/behavior.ts) and its version history.
 *  - Platform admins: users flagged in /admin, e-mails in ADMIN_EMAILS, or the
 *    first user who enters the one-time setup code printed in the server log.
 */
import crypto from 'crypto';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import type { PoolEntry } from './ai/keypool';
import type {
  AiKeyInput,
  AiKeyPublic,
  AiProviderKind,
  BehaviorConfig,
  BehaviorVersionInfo,
  ConnectionsPayload,
  GoogleConnectionInput,
  KeyStrategy,
  PublicConfig,
  SourcingConnectionInput,
  SystemSettings,
} from '../src/types/admin';

export const MAX_AI_KEYS = 5;
export const MAX_FILE_MB_CAP = 50;
const BEHAVIOR_HISTORY_CAP = 20;

interface StoredKey {
  id: string;
  label: string;
  provider: AiProviderKind;
  keyEnc: string;
  keyHint: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  rpm: number;
  dailyLimit: number;
  createdAtISO: string;
  updatedAtISO: string;
}

interface AiSettingsStored {
  enabled: boolean;
  strategy: KeyStrategy;
  useEnvKeys: boolean;
  temperature: number;
  fastTimeoutSec: number;
  deepTimeoutSec: number;
  keys: StoredKey[];
}

/** The LinkedIn-compatible sourcing provider (one per deployment, not per org). */
interface StoredSourcingConnection {
  kind: 'contract' | 'apify';
  endpointUrl: string;
  /** Apify actor id, only for kind = 'apify'. */
  actorId: string;
  tokenEnc: string;
  tokenHint: string;
  providerLabel: string;
  updatedAtISO: string;
  updatedBy: string;
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
}

/** The OAuth *client* every workspace connects its own Google account with. */
interface StoredGoogleConnection {
  clientId: string;
  clientSecretEnc: string;
  calendarId: string;
  redirectUri: string;
  updatedAtISO: string;
  updatedBy: string;
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
}

interface ConnectionsStored {
  sourcing: StoredSourcingConnection | null;
  google: StoredGoogleConnection | null;
}

interface PlatformState {
  ai: AiSettingsStored;
  system: SystemSettings;
  behavior: BehaviorConfig | null;
  behaviorHistory: Array<BehaviorVersionInfo & { config: BehaviorConfig }>;
  connections: ConnectionsStored;
}

export const DEFAULT_SYSTEM: SystemSettings = {
  signupEnabled: true,
  demoEnabled: true,
  demoHours: 24,
  maxFileMb: 50,
  maxFilesPerBatch: 500,
  sessionDays: 30,
  announcement: { enabled: false, text: '', tone: 'info' },
  maintenance: { enabled: false, message: 'هویدا در حال به‌روزرسانی است؛ چند دقیقه دیگر دوباره سر بزنید.' },
  supportEmail: '',
};

const DEFAULT_AI: AiSettingsStored = {
  enabled: true,
  strategy: 'failover',
  useEnvKeys: true,
  temperature: 0.1,
  fastTimeoutSec: 25,
  deepTimeoutSec: 80,
  keys: [],
};

const clampNum = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const text = (v: unknown, max: number, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);

function normalizeSystem(raw: any): SystemSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tone = ['info', 'warning', 'success'].includes(r.announcement?.tone) ? r.announcement.tone : 'info';
  return {
    signupEnabled: bool(r.signupEnabled, DEFAULT_SYSTEM.signupEnabled),
    demoEnabled: bool(r.demoEnabled, DEFAULT_SYSTEM.demoEnabled),
    demoHours: Math.round(clampNum(r.demoHours, 1, 24 * 14, DEFAULT_SYSTEM.demoHours)),
    maxFileMb: Math.round(clampNum(r.maxFileMb, 1, MAX_FILE_MB_CAP, DEFAULT_SYSTEM.maxFileMb)),
    maxFilesPerBatch: Math.round(clampNum(r.maxFilesPerBatch, 1, 2000, DEFAULT_SYSTEM.maxFilesPerBatch)),
    sessionDays: Math.round(clampNum(r.sessionDays, 1, 365, DEFAULT_SYSTEM.sessionDays)),
    announcement: {
      enabled: bool(r.announcement?.enabled, false),
      text: text(r.announcement?.text, 400),
      tone,
    },
    maintenance: {
      enabled: bool(r.maintenance?.enabled, false),
      message: text(r.maintenance?.message, 400, DEFAULT_SYSTEM.maintenance.message) || DEFAULT_SYSTEM.maintenance.message,
    },
    supportEmail: text(r.supportEmail, 120).trim(),
  };
}

function normalizeKey(k: any): StoredKey | null {
  if (!k || typeof k !== 'object' || typeof k.id !== 'string' || typeof k.keyEnc !== 'string') return null;
  return {
    id: k.id,
    label: text(k.label, 60) || 'کلید',
    provider: k.provider === 'openai' ? 'openai' : 'gemini',
    keyEnc: k.keyEnc,
    keyHint: text(k.keyHint, 40),
    baseUrl: text(k.baseUrl, 300).trim(),
    model: text(k.model, 120).trim(),
    enabled: bool(k.enabled, true),
    rpm: Math.round(clampNum(k.rpm, 0, 100000, 0)),
    dailyLimit: Math.round(clampNum(k.dailyLimit, 0, 10_000_000, 0)),
    createdAtISO: text(k.createdAtISO, 40) || new Date().toISOString(),
    updatedAtISO: text(k.updatedAtISO, 40) || new Date().toISOString(),
  };
}

const APIFY_DEFAULT_BASE = 'https://api.apify.com/v2';
const APIFY_DEFAULT_ACTOR = 'harvestapi/linkedin-profile-search';

function normalizeSourcingConn(raw: any): StoredSourcingConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'apify' ? 'apify' : 'contract';
  const endpointUrl = text(raw.endpointUrl, 500).trim() || (kind === 'apify' ? APIFY_DEFAULT_BASE : '');
  const tokenEnc = text(raw.tokenEnc, 1000);
  if (!endpointUrl || !tokenEnc) return null;
  return {
    kind,
    actorId: kind === 'apify' ? text(raw.actorId, 200).trim() || APIFY_DEFAULT_ACTOR : '',
    endpointUrl,
    tokenEnc,
    tokenHint: text(raw.tokenHint, 40),
    providerLabel: text(raw.providerLabel, 80).trim() || 'LinkedIn Talent API',
    updatedAtISO: text(raw.updatedAtISO, 40) || new Date().toISOString(),
    updatedBy: text(raw.updatedBy, 120),
    lastTestAtISO: text(raw.lastTestAtISO, 40) || null,
    lastTestOk: typeof raw.lastTestOk === 'boolean' ? raw.lastTestOk : null,
    lastError: text(raw.lastError, 400) || null,
  };
}

function normalizeGoogleConn(raw: any): StoredGoogleConnection | null {
  if (!raw || typeof raw !== 'object') return null;
  const clientId = text(raw.clientId, 300).trim();
  const clientSecretEnc = text(raw.clientSecretEnc, 1000);
  if (!clientId || !clientSecretEnc) return null;
  return {
    clientId,
    clientSecretEnc,
    calendarId: text(raw.calendarId, 200).trim() || 'primary',
    redirectUri: text(raw.redirectUri, 400).trim(),
    updatedAtISO: text(raw.updatedAtISO, 40) || new Date().toISOString(),
    updatedBy: text(raw.updatedBy, 120),
    lastTestAtISO: text(raw.lastTestAtISO, 40) || null,
    lastTestOk: typeof raw.lastTestOk === 'boolean' ? raw.lastTestOk : null,
    lastError: text(raw.lastError, 400) || null,
  };
}

function normalize(raw: any): PlatformState {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ai = r.ai && typeof r.ai === 'object' ? r.ai : {};
  return {
    ai: {
      enabled: bool(ai.enabled, DEFAULT_AI.enabled),
      strategy: ai.strategy === 'round-robin' ? 'round-robin' : 'failover',
      useEnvKeys: bool(ai.useEnvKeys, DEFAULT_AI.useEnvKeys),
      temperature: clampNum(ai.temperature, 0, 1, DEFAULT_AI.temperature),
      fastTimeoutSec: Math.round(clampNum(ai.fastTimeoutSec, 8, 120, DEFAULT_AI.fastTimeoutSec)),
      deepTimeoutSec: Math.round(clampNum(ai.deepTimeoutSec, 20, 240, DEFAULT_AI.deepTimeoutSec)),
      keys: (Array.isArray(ai.keys) ? ai.keys : []).map(normalizeKey).filter(Boolean).slice(0, MAX_AI_KEYS) as StoredKey[],
    },
    system: normalizeSystem(r.system),
    behavior: r.behavior && typeof r.behavior === 'object' ? (r.behavior as BehaviorConfig) : null,
    behaviorHistory: Array.isArray(r.behaviorHistory) ? r.behaviorHistory.slice(0, BEHAVIOR_HISTORY_CAP) : [],
    connections: {
      sourcing: normalizeSourcingConn(r.connections?.sourcing),
      google: normalizeGoogleConn(r.connections?.google),
    },
  };
}

let cache: PlatformState | null = null;
let cacheSource: unknown = undefined;

function state(): PlatformState {
  const blob = db.getPlatformBlob();
  if (!cache || cacheSource !== blob) {
    cache = normalize(blob);
    cacheSource = blob;
  }
  return cache;
}

function commit(next: PlatformState) {
  // A fresh object each time, so the identity check in state() sees the change.
  const blob = JSON.parse(JSON.stringify(next));
  db.setPlatformBlob(blob);
  cache = normalize(blob);
  cacheSource = blob;
}

// ------------------------------------------------------------ system ----

export function systemSettings(): SystemSettings {
  return state().system;
}

export function updateSystemSettings(patch: Partial<SystemSettings>): SystemSettings {
  const s = state();
  const merged = {
    ...s.system,
    ...patch,
    announcement: { ...s.system.announcement, ...(patch.announcement || {}) },
    maintenance: { ...s.system.maintenance, ...(patch.maintenance || {}) },
  };
  commit({ ...s, system: normalizeSystem(merged) });
  return state().system;
}

export function demoAllowed(): boolean {
  return process.env.DISABLE_DEMO !== '1' && systemSettings().demoEnabled;
}

export function publicConfig(): PublicConfig {
  const s = systemSettings();
  return {
    demo: demoAllowed(),
    demoHours: s.demoHours,
    signup: s.signupEnabled,
    announcement: s.announcement.enabled && s.announcement.text.trim() ? { text: s.announcement.text.trim(), tone: s.announcement.tone } : null,
    maintenance: s.maintenance.enabled ? s.maintenance.message : null,
    maxFileMb: s.maxFileMb,
    maxFilesPerBatch: s.maxFilesPerBatch,
    supportEmail: s.supportEmail,
  };
}

export function sessionTtlMs(): number {
  return systemSettings().sessionDays * 24 * 3600_000;
}

export function demoTtlMs(): number {
  return systemSettings().demoHours * 3600_000;
}

// ---------------------------------------------------------------- AI ----

export function envForcedOff(): boolean {
  return /^(off|none|disabled)$/i.test((process.env.AI_PROVIDER || '').trim());
}

export function aiSettings(): Omit<AiSettingsStored, 'keys'> {
  const { keys: _k, ...rest } = state().ai;
  return rest;
}

export function updateAiSettings(patch: Partial<Omit<AiSettingsStored, 'keys'>>) {
  const s = state();
  const ai = normalize({ ai: { ...s.ai, ...patch, keys: s.ai.keys } }).ai;
  commit({ ...s, ai });
  return aiSettings();
}

export function keyHint(apiKey: string): string {
  const k = apiKey.trim();
  if (k.length <= 10) return `${k.slice(0, 2)}…`;
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/** Accepts a base URL or a full endpoint pasted by mistake. */
export function cleanBaseUrl(url: string): string {
  let u = (url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/v1beta\/models.*$/i, '');
  try {
    const parsed = new URL(u);
    if (!/^https?:$/.test(parsed.protocol)) return '';
    return u;
  } catch {
    return '';
  }
}

function envEntries(): Array<PoolEntry & { createdAtISO: string }> {
  const out: Array<PoolEntry & { createdAtISO: string }> = [];
  const pref = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase();
  const gem = process.env.GEMINI_API_KEY?.trim();
  const oai = process.env.OPENAI_API_KEY?.trim();
  const geminiModel = (process.env.GEMINI_MODEL || '').trim().replace(/^models\//, '');
  const entries = {
    gemini: gem
      ? {
          id: 'env-gemini',
          label: 'GEMINI_API_KEY (سرور)',
          provider: 'gemini' as const,
          apiKey: gem,
          baseUrl: '',
          model: /^gemini-[\w.-]{2,60}$/.test(geminiModel) ? geminiModel : '',
          enabled: true,
          rpm: 0,
          dailyLimit: 0,
          source: 'env' as const,
          createdAtISO: '',
        }
      : null,
    openai: oai
      ? {
          id: 'env-openai',
          label: 'OPENAI_API_KEY (سرور)',
          provider: 'openai' as const,
          apiKey: oai,
          baseUrl: cleanBaseUrl(process.env.OPENAI_BASE_URL || ''),
          model: (process.env.OPENAI_MODEL || '').trim(),
          enabled: true,
          rpm: 0,
          dailyLimit: 0,
          source: 'env' as const,
          createdAtISO: '',
        }
      : null,
  };
  // AI_PROVIDER=gemini|openai still chooses (only) that provider from the environment.
  if (pref === 'gemini') return entries.gemini ? [entries.gemini] : [];
  if (pref === 'openai') return entries.openai ? [entries.openai] : [];
  if (entries.gemini) out.push(entries.gemini);
  if (entries.openai) out.push(entries.openai);
  return out;
}

/** Keys the pool may use, in priority order (decrypted; server-side only). */
export function poolEntries(): PoolEntry[] {
  if (envForcedOff()) return [];
  const s = state().ai;
  if (!s.enabled) return [];
  const out: PoolEntry[] = [];
  for (const k of s.keys) {
    if (!k.enabled) continue;
    const apiKey = decryptSecret(k.keyEnc);
    if (!apiKey) continue; // stored with another APP_SECRET — the admin panel flags it
    out.push({
      id: k.id,
      label: k.label,
      provider: k.provider,
      apiKey,
      baseUrl: k.baseUrl,
      model: k.model,
      enabled: true,
      rpm: k.rpm,
      dailyLimit: k.dailyLimit,
      source: 'admin',
    });
  }
  if (s.useEnvKeys) out.push(...envEntries().map(({ createdAtISO: _c, ...e }) => e));
  return out;
}

/** One key by id — also disabled ones — for the admin «test» button. */
export function keyEntryForTest(id: string): PoolEntry | null {
  const k = state().ai.keys.find((x) => x.id === id);
  if (k) {
    const apiKey = decryptSecret(k.keyEnc);
    if (!apiKey) return null;
    return { id: k.id, label: k.label, provider: k.provider, apiKey, baseUrl: k.baseUrl, model: k.model, enabled: true, rpm: 0, dailyLimit: 0, source: 'admin' };
  }
  const env = envEntries().find((e) => e.id === id);
  if (!env) return null;
  const { createdAtISO: _c, ...entry } = env;
  return entry;
}

/** Every key (also disabled ones) for the admin list — without secrets. */
export function listKeysPublic(): Array<AiKeyPublic & { unreadable?: boolean }> {
  const s = state().ai;
  const admin = s.keys.map((k) => ({
    id: k.id,
    label: k.label,
    provider: k.provider,
    keyHint: k.keyHint,
    baseUrl: k.baseUrl,
    model: k.model,
    enabled: k.enabled,
    rpm: k.rpm,
    dailyLimit: k.dailyLimit,
    source: 'admin' as const,
    createdAtISO: k.createdAtISO,
    updatedAtISO: k.updatedAtISO,
    ...(decryptSecret(k.keyEnc) === null ? { unreadable: true } : {}),
  }));
  const env = envEntries().map((e) => ({
    id: e.id,
    label: e.label,
    provider: e.provider,
    keyHint: keyHint(e.apiKey),
    baseUrl: e.baseUrl,
    model: e.model,
    enabled: s.useEnvKeys,
    rpm: 0,
    dailyLimit: 0,
    source: 'env' as const,
    createdAtISO: '',
    updatedAtISO: '',
  }));
  return [...admin, ...env];
}

export class PlatformInputError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

function validateKeyInput(input: AiKeyInput, isNew: boolean) {
  if (isNew && !(input.apiKey || '').trim()) throw new PlatformInputError('کلید API را وارد کنید.', 'apiKey');
  if (input.apiKey !== undefined) {
    const k = input.apiKey.trim();
    if (k && (k.length < 8 || k.length > 400 || /\s/.test(k))) throw new PlatformInputError('کلید API معتبر به نظر نمی‌رسد.', 'apiKey');
  }
  if (input.baseUrl !== undefined && input.baseUrl.trim() && !cleanBaseUrl(input.baseUrl)) {
    throw new PlatformInputError('آدرس سرویس معتبر نیست؛ مثال: https://api.example.com/v1', 'baseUrl');
  }
  if (input.model !== undefined && input.model.length > 120) throw new PlatformInputError('نام مدل خیلی طولانی است.', 'model');
}

export function addKey(input: AiKeyInput): AiKeyPublic {
  const s = state();
  if (s.ai.keys.length >= MAX_AI_KEYS) throw new PlatformInputError(`حداکثر ${MAX_AI_KEYS.toLocaleString('fa-IR')} کلید قابل ثبت است.`);
  validateKeyInput(input, true);
  const apiKey = input.apiKey!.trim();
  const now = new Date().toISOString();
  const key: StoredKey = {
    id: db.uid('key'),
    label: (input.label || '').trim().slice(0, 60) || `کلید ${(s.ai.keys.length + 1).toLocaleString('fa-IR')}`,
    provider: input.provider === 'openai' ? 'openai' : 'gemini',
    keyEnc: encryptSecret(apiKey),
    keyHint: keyHint(apiKey),
    baseUrl: cleanBaseUrl(input.baseUrl || ''),
    model: (input.model || '').trim().replace(/^models\//, ''),
    enabled: input.enabled !== false,
    rpm: Math.round(clampNum(input.rpm, 0, 100000, 0)),
    dailyLimit: Math.round(clampNum(input.dailyLimit, 0, 10_000_000, 0)),
    createdAtISO: now,
    updatedAtISO: now,
  };
  commit({ ...s, ai: { ...s.ai, keys: [...s.ai.keys, key] } });
  return listKeysPublic().find((k) => k.id === key.id)!;
}

export function updateKey(id: string, input: AiKeyInput): AiKeyPublic {
  const s = state();
  const current = s.ai.keys.find((k) => k.id === id);
  if (!current) throw new PlatformInputError('کلید یافت نشد.');
  validateKeyInput(input, false);
  const next: StoredKey = { ...current, updatedAtISO: new Date().toISOString() };
  if (input.label !== undefined) next.label = input.label.trim().slice(0, 60) || current.label;
  if (input.provider !== undefined) next.provider = input.provider === 'openai' ? 'openai' : 'gemini';
  if (input.apiKey !== undefined && input.apiKey.trim()) {
    next.keyEnc = encryptSecret(input.apiKey.trim());
    next.keyHint = keyHint(input.apiKey);
  }
  if (input.baseUrl !== undefined) next.baseUrl = cleanBaseUrl(input.baseUrl);
  if (input.model !== undefined) next.model = input.model.trim().replace(/^models\//, '');
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  if (input.rpm !== undefined) next.rpm = Math.round(clampNum(input.rpm, 0, 100000, 0));
  if (input.dailyLimit !== undefined) next.dailyLimit = Math.round(clampNum(input.dailyLimit, 0, 10_000_000, 0));
  commit({ ...s, ai: { ...s.ai, keys: s.ai.keys.map((k) => (k.id === id ? next : k)) } });
  return listKeysPublic().find((k) => k.id === id)!;
}

export function deleteKey(id: string): boolean {
  const s = state();
  if (!s.ai.keys.some((k) => k.id === id)) return false;
  commit({ ...s, ai: { ...s.ai, keys: s.ai.keys.filter((k) => k.id !== id) } });
  return true;
}

/** New priority order (failover tries keys top to bottom). */
export function reorderKeys(ids: string[]) {
  const s = state();
  const byId = new Map(s.ai.keys.map((k) => [k.id, k]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as StoredKey[];
  for (const k of s.ai.keys) if (!ordered.includes(k)) ordered.push(k);
  commit({ ...s, ai: { ...s.ai, keys: ordered } });
}

// -------------------------------------------------------- connections ----

/**
 * Deployment-level connection credentials, entered in /admin › «اتصال‌ها».
 * The environment variables (LINKEDIN_API_URL, GOOGLE_CLIENT_ID…) still work and
 * are used only when nothing was saved in the panel — so an existing .env keeps
 * running, and a fresh install never has to touch the server at all.
 */

export interface SourcingConnection {
  kind: 'contract' | 'apify';
  endpointUrl: string;
  actorId: string;
  token: string;
  providerLabel: string;
  source: 'admin' | 'env';
}

export interface GoogleOAuthConnection {
  clientId: string;
  clientSecret: string;
  calendarId: string;
  /** Fixed redirect URI from the panel/environment; empty = derive from the request origin. */
  redirectUri: string;
  source: 'admin' | 'env';
}

export const GOOGLE_SCOPE_LIST = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'];

function envSourcing(): SourcingConnection | null {
  const endpointUrl = (process.env.LINKEDIN_API_URL || '').trim();
  const token = (process.env.LINKEDIN_API_TOKEN || process.env.LINKEDIN_ACCESS_TOKEN || '').trim();
  if (!endpointUrl || !token) return null;
  const kind = /apify\.com/i.test(endpointUrl) ? 'apify' : 'contract';
  return {
    kind,
    endpointUrl,
    actorId: kind === 'apify' ? (process.env.LINKEDIN_ACTOR_ID || '').trim() || APIFY_DEFAULT_ACTOR : '',
    token,
    providerLabel: (process.env.LINKEDIN_PROVIDER_LABEL || 'LinkedIn Talent API').trim() || 'LinkedIn Talent API',
    source: 'env',
  };
}

function envGoogle(): GoogleOAuthConnection | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    calendarId: (process.env.GOOGLE_CALENDAR_ID || 'primary').trim() || 'primary',
    redirectUri: (process.env.GOOGLE_REDIRECT_URI || '').trim(),
    source: 'env',
  };
}

/** The sourcing provider in effect (panel first, then the environment). */
export function sourcingConnection(): SourcingConnection | null {
  const stored = state().connections.sourcing;
  if (stored) {
    const token = decryptSecret(stored.tokenEnc);
    if (token) {
      return {
        kind: stored.kind,
        endpointUrl: stored.endpointUrl,
        actorId: stored.actorId,
        token,
        providerLabel: stored.providerLabel,
        source: 'admin',
      };
    }
    // An unreadable token (another APP_SECRET) must not silently look configured.
    return null;
  }
  return envSourcing();
}

/** The Google OAuth client in effect (panel first, then the environment). */
export function googleOAuthConnection(): GoogleOAuthConnection | null {
  const stored = state().connections.google;
  if (stored) {
    const clientSecret = decryptSecret(stored.clientSecretEnc);
    if (clientSecret) {
      return {
        clientId: stored.clientId,
        clientSecret,
        calendarId: stored.calendarId,
        redirectUri: stored.redirectUri,
        source: 'admin',
      };
    }
    return null;
  }
  return envGoogle();
}

function hostOfUrl(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function hintOf(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** What /admin and the workspace «اتصال‌ها» tab may see — never a secret. */
export function connectionsPublic(origin: string): ConnectionsPayload {
  const s = state().connections;
  const src = sourcingConnection();
  const goog = googleOAuthConnection();
  const base = origin.replace(/\/$/, '');
  const effective = goog?.redirectUri || `${base}/api/integrations/calendar/callback`;
  const storedGoogle = s.google;
  return {
    sourcing: {
      configured: Boolean(src),
      source: src?.source ?? null,
      kind: src?.kind ?? 'contract',
      actorId: src?.actorId ?? '',
      async: src?.kind === 'apify',
      endpointHost: src ? hostOfUrl(src.endpointUrl) : null,
      endpointUrl: src?.source === 'admin' ? src.endpointUrl : '',
      providerLabel: src?.providerLabel || 'LinkedIn',
      tokenHint: s.sourcing ? s.sourcing.tokenHint : src ? 'از متغیرهای محیطی سرور' : '',
      updatedAtISO: s.sourcing?.updatedAtISO ?? null,
      updatedBy: s.sourcing?.updatedBy ?? null,
      lastTestAtISO: s.sourcing?.lastTestAtISO ?? null,
      lastTestOk: s.sourcing?.lastTestOk ?? null,
      lastError: s.sourcing?.lastError ?? null,
      fromEnv: src?.source === 'env',
    },
    google: {
      configured: Boolean(goog),
      source: goog?.source ?? null,
      clientId: goog?.clientId || '',
      secretHint: storedGoogle
        ? hintOf(decryptSecret(storedGoogle.clientSecretEnc) || '')
        : goog
          ? 'از متغیرهای محیطی سرور'
          : '',
      hasSecret: Boolean(goog),
      calendarId: goog?.calendarId || 'primary',
      redirectUri: goog?.redirectUri || '',
      effectiveRedirectUri: effective,
      scopes: GOOGLE_SCOPE_LIST,
      updatedAtISO: storedGoogle?.updatedAtISO ?? null,
      updatedBy: storedGoogle?.updatedBy ?? null,
      lastTestAtISO: storedGoogle?.lastTestAtISO ?? null,
      lastTestOk: storedGoogle?.lastTestOk ?? null,
      lastError: storedGoogle?.lastError ?? null,
      fromEnv: goog?.source === 'env',
    },
    docs: { sourcing: 'docs/CONNECT-LINKEDIN.md', google: 'docs/CONNECT-GOOGLE-CALENDAR.md' },
  };
}

function validEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && Boolean(u.host);
  } catch {
    return false;
  }
}

function cleanSecret(v: unknown, max = 2000): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function saveSourcingConnection(input: SourcingConnectionInput, actor: string): void {
  const st = state();
  const previous = st.connections.sourcing;
  const kind: 'contract' | 'apify' = input.kind === 'apify' ? 'apify' : input.kind === 'contract' ? 'contract' : previous?.kind || 'contract';
  const fallbackUrl = kind === 'apify' ? APIFY_DEFAULT_BASE : '';
  const endpointUrl = (typeof input.endpointUrl === 'string' ? input.endpointUrl.trim() : '') || previous?.endpointUrl || fallbackUrl;
  if (!endpointUrl) throw new PlatformInputError('آدرس سرویس جست‌وجو را وارد کنید.', 'endpointUrl');
  if (!validEndpoint(endpointUrl)) throw new PlatformInputError('آدرس باید با http:// یا https:// شروع شود.', 'endpointUrl');
  let actorId = '';
  if (kind === 'apify') {
    const raw = (typeof input.actorId === 'string' ? input.actorId.trim() : '') || previous?.actorId || APIFY_DEFAULT_ACTOR;
    actorId = raw.replace(/\//g, '~');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,80}~[A-Za-z0-9][A-Za-z0-9_.-]{1,120}$/.test(actorId)) {
      throw new PlatformInputError('شناسهٔ Actor آپافی به شکل user~actor یا user/actor است.', 'actorId');
    }
  }
  const token = cleanSecret(input.token) || (st.connections.sourcing ? decryptSecret(st.connections.sourcing.tokenEnc) || '' : '');
  if (!token) throw new PlatformInputError('توکن دسترسی سرویس را وارد کنید.', 'token');
  if (token.length < 4 || /\s/.test(token)) throw new PlatformInputError('توکن معتبر به نظر نمی‌رسد (دست‌کم ۴ نویسه، بدون فاصله).', 'token');
  if (input.providerLabel !== undefined && input.providerLabel.length > 80) {
    throw new PlatformInputError('نام سرویس خیلی طولانی است.', 'providerLabel');
  }
  const now = new Date().toISOString();
  const next: StoredSourcingConnection = {
    kind,
    endpointUrl,
    actorId,
    tokenEnc: cleanSecret(input.token) ? encryptSecret(token) : previous!.tokenEnc,
    tokenHint: hintOf(token),
    providerLabel:
      (input.providerLabel || '').trim() ||
      previous?.providerLabel ||
      (kind === 'apify' ? 'Apify · HarvestAPI' : 'LinkedIn Talent API'),
    updatedAtISO: now,
    updatedBy: actor,
    lastTestAtISO: previous?.lastTestAtISO ?? null,
    lastTestOk: previous?.lastTestOk ?? null,
    lastError: previous?.lastError ?? null,
  };
  commit({ ...st, connections: { ...st.connections, sourcing: next } });
}

export function clearSourcingConnection(): boolean {
  const st = state();
  if (!st.connections.sourcing) return false;
  commit({ ...st, connections: { ...st.connections, sourcing: null } });
  return true;
}

export function markSourcingProbe(ok: boolean, error: string | null): void {
  const st = state();
  if (!st.connections.sourcing) return;
  commit({
    ...st,
    connections: {
      ...st.connections,
      sourcing: { ...st.connections.sourcing, lastTestAtISO: new Date().toISOString(), lastTestOk: ok, lastError: error },
    },
  });
}

export function saveGoogleConnection(input: GoogleConnectionInput, actor: string): void {
  const st = state();
  const previous = st.connections.google;
  const clientId = (typeof input.clientId === 'string' ? input.clientId.trim() : previous?.clientId || '').slice(0, 300);
  if (!clientId) throw new PlatformInputError('Client ID را وارد کنید.', 'clientId');
  if (!/^[0-9A-Za-z_-]{6,}\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new PlatformInputError('Client ID گوگل معمولاً به ‎.apps.googleusercontent.com ختم می‌شود.', 'clientId');
  }
  const secret = cleanSecret(input.clientSecret) || (previous ? decryptSecret(previous.clientSecretEnc) || '' : '');
  if (!secret) throw new PlatformInputError('Client Secret را وارد کنید.', 'clientSecret');
  if (secret.length < 8 || /\s/.test(secret)) throw new PlatformInputError('Client Secret معتبر به نظر نمی‌رسد.', 'clientSecret');
  const redirectUri = input.redirectUri !== undefined ? input.redirectUri.trim().slice(0, 400) : previous?.redirectUri || '';
  if (redirectUri && !validEndpoint(redirectUri)) throw new PlatformInputError('آدرس بازگشت باید یک URL کامل http(s) باشد.', 'redirectUri');
  const calendarId = (input.calendarId !== undefined ? input.calendarId.trim() : previous?.calendarId || 'primary').slice(0, 200) || 'primary';
  const now = new Date().toISOString();
  const next: StoredGoogleConnection = {
    clientId,
    clientSecretEnc: cleanSecret(input.clientSecret) ? encryptSecret(secret) : previous!.clientSecretEnc,
    calendarId,
    redirectUri,
    updatedAtISO: now,
    updatedBy: actor,
    // A changed client id/secret invalidates the previous probe result.
    lastTestAtISO: previous?.lastTestAtISO ?? null,
    lastTestOk: previous && previous.clientId === clientId ? previous.lastTestOk : null,
    lastError: previous && previous.clientId === clientId ? previous.lastError : null,
  };
  commit({ ...st, connections: { ...st.connections, google: next } });
}

export function clearGoogleConnection(): boolean {
  const st = state();
  if (!st.connections.google) return false;
  commit({ ...st, connections: { ...st.connections, google: null } });
  return true;
}

export function markGoogleProbe(ok: boolean | null, error: string | null): void {
  const st = state();
  if (!st.connections.google) return;
  commit({
    ...st,
    connections: {
      ...st.connections,
      google: { ...st.connections.google, lastTestAtISO: new Date().toISOString(), lastTestOk: ok, lastError: error },
    },
  });
}

// ---------------------------------------------------------- behaviour ----

export function storedBehavior(): BehaviorConfig | null {
  return state().behavior;
}

export function behaviorHistory(): Array<BehaviorVersionInfo & { config: BehaviorConfig }> {
  return state().behaviorHistory;
}

export function saveBehaviorConfig(config: BehaviorConfig, note: string) {
  const s = state();
  const entry = {
    version: config.version,
    savedAtISO: config.updatedAtISO,
    savedBy: config.updatedBy,
    note: note.slice(0, 160),
    config,
  };
  commit({ ...s, behavior: config, behaviorHistory: [entry, ...s.behaviorHistory].slice(0, BEHAVIOR_HISTORY_CAP) });
}

// ------------------------------------------------------------- admins ----

export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isEnvAdmin(user: { email: string }): boolean {
  return adminEmails().includes(user.email.toLowerCase());
}

export function isPlatformAdmin(user: db.UserRecord | null | undefined): boolean {
  if (!user || user.disabled) return false;
  const org = db.getOrg(user.orgId);
  if (!org || org.isDemo) return false;
  return user.platformAdmin === true || isEnvAdmin(user);
}

/** An actual, usable platform admin account exists (an ADMIN_EMAILS entry nobody signed up with does not count). */
export function platformAdminExists(): boolean {
  return db.allUsers().some((u) => isPlatformAdmin(u));
}

/** ADMIN_EMAILS entries that no account uses yet. */
export function unclaimedAdminEmails(): string[] {
  return adminEmails().filter((e) => !db.findUserByEmail(e));
}

let setupCode: string | null = null;

/** Called at startup: without any platform admin, print a one-time setup code. */
export function initPlatform() {
  const unclaimed = unclaimedAdminEmails();
  if (unclaimed.length) {
    // Accounts are not e-mail-verified: whoever signs up first with this address gets the role.
    console.warn(`[admin] ADMIN_EMAILS: no account yet for ${unclaimed.join(', ')} — sign up with that address now (the first sign-up with it becomes platform admin).`);
  }
  if (platformAdminExists()) {
    setupCode = null;
    return;
  }
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  setupCode = `HV-${group()}-${group()}-${group()}`;
  console.log('──────────────────────────────────────────────────────────────');
  console.log('[admin] هنوز مدیر سامانه‌ای تعریف نشده است. / No platform admin yet.');
  console.log(`[admin] Sign in, open /admin and enter this one-time setup code: ${setupCode}`);
  console.log('[admin] (Or set ADMIN_EMAILS=you@company.com and sign up with that address.)');
  console.log('──────────────────────────────────────────────────────────────');
}

export function setupPending(): boolean {
  return Boolean(setupCode) && !platformAdminExists();
}

/** Grants the platform-admin role to `user` when `code` matches (single use). */
export function claimWithSetupCode(user: db.UserRecord, code: string): boolean {
  if (!setupCode || platformAdminExists()) return false;
  const org = db.getOrg(user.orgId);
  if (!org || org.isDemo || user.disabled) return false;
  const a = Buffer.from(code.trim().toUpperCase());
  const b = Buffer.from(setupCode);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  db.updateUser(user.id, { platformAdmin: true });
  setupCode = null;
  return true;
}

// -------------------------------------------------------------- audit ----

export function audit(actor: { id: string; name: string } | null, ip: string | null, action: string, target: string, detail = '') {
  db.appendAudit({
    actorId: actor?.id ?? null,
    actorName: actor?.name ?? 'سامانه',
    action,
    target: target.slice(0, 200),
    detail: detail.slice(0, 500),
    ip,
  });
}

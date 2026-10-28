/**
 * Platform administration (/admin) — types shared by the server and the
 * admin panel. A *platform* admin operates the whole HOVIDA deployment
 * (every workspace); a workspace owner/admin only manages their own org.
 */

// ------------------------------------------------------------ AI key pool ----

export type AiProviderKind = 'gemini' | 'openai';
export type KeyStrategy = 'failover' | 'round-robin';
/** ready = usable now · cooling = rate-limited for a while · invalid = rejected credentials. */
export type KeyHealth = 'ready' | 'cooling' | 'invalid' | 'disabled' | 'limited';

export interface AiKeyPublic {
  id: string;
  label: string;
  provider: AiProviderKind;
  /** Never the key itself — e.g. «AIza…9xQ2». */
  keyHint: string;
  /** Custom endpoint: an OpenAI-compatible gateway, or a Gemini proxy. Empty = provider default. */
  baseUrl: string;
  /** Empty = provider default model. */
  model: string;
  enabled: boolean;
  /** Proactive limits (0 = none): the pool skips the key before the provider says 429. */
  rpm: number;
  dailyLimit: number;
  /** admin = added in /admin · env = GEMINI_API_KEY / OPENAI_API_KEY on the server (read-only). */
  source: 'admin' | 'env';
  createdAtISO: string;
  updatedAtISO: string;
}

export interface AiKeyRuntime {
  id: string;
  health: KeyHealth;
  /** Epoch ms until which the key is skipped (rate limit / quota / transient errors). */
  cooldownUntil: number | null;
  cooldownReason: string | null;
  lastError: string | null;
  lastErrorAt: number | null;
  lastUsedAt: number | null;
  lastLatencyMs: number | null;
  calls: number;
  successes: number;
  failures: number;
  rateLimits: number;
  /** Calls since local (Tehran) midnight. */
  todayCalls: number;
  /** Calls in the last 60 s (for the RPM limit). */
  lastMinuteCalls: number;
}

export interface AiSettingsPublic {
  enabled: boolean;
  /** AI_PROVIDER=off on the server overrides everything. */
  envForcedOff: boolean;
  strategy: KeyStrategy;
  useEnvKeys: boolean;
  temperature: number;
  fastTimeoutSec: number;
  deepTimeoutSec: number;
  keys: AiKeyPublic[];
  runtime: AiKeyRuntime[];
  maxKeys: number;
}

export interface AiKeyInput {
  label?: string;
  provider?: AiProviderKind;
  /** Only sent when adding or replacing the key. */
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
  rpm?: number;
  dailyLimit?: number;
}

export interface AiCallLog {
  id: string;
  at: number;
  keyId: string;
  keyLabel: string;
  provider: AiProviderKind;
  model: string;
  purpose: AiPurpose;
  ok: boolean;
  latencyMs: number;
  error: string | null;
  /** Label of the key we switched away from to make this call (failover). */
  switchedFrom: string | null;
  attachments: number;
}

export type AiPurpose = 'evaluate' | 'deep' | 'understand' | 'calibrate' | 'message' | 'test' | 'lab' | 'other';

// ----------------------------------------------------- outside connections ----
/**
 * Deployment-level credentials for the two connections that cannot be set per
 * workspace: the LinkedIn-compatible sourcing provider (licensed at deployment
 * level) and the Google OAuth client (registered once for this server).
 * Everything a workspace needs on its own — the SMTP mailbox and each
 * workspace's Google account — is connected from «تنظیمات ← اتصال‌ها».
 *
 * Both can also come from the environment (LINKEDIN_API_URL…, GOOGLE_CLIENT_ID…);
 * the value saved in /admin wins, and the panel shows which one is in effect.
 */

export type ConnectionSource = 'admin' | 'env';

/**
 * How the sourcing provider is spoken to:
 *  - contract: the small JSON contract documented in docs/CONNECT-LINKEDIN.md
 *    (any licensed provider or your own gateway).
 *  - apify: an Apify actor (e.g. harvestapi/linkedin-profile-search) run through
 *    the Apify API. Its search input cannot filter by «open to work», so full
 *    profiles are fetched and only those reporting openToWork are kept.
 */
export type SourcingProviderKind = 'contract' | 'apify';

export interface SourcingConnectionPublic {
  /** A provider endpoint + token are in effect (from /admin or the environment). */
  configured: boolean;
  source: ConnectionSource | null;
  kind: SourcingProviderKind;
  /** Apify actor id (only for kind = apify). */
  actorId: string;
  /** Apify: the run is asynchronous — a search may report «running» for a while. */
  async: boolean;
  /** Host only — the endpoint path is not a secret, the token never leaves the server. */
  endpointHost: string | null;
  endpointUrl: string;
  providerLabel: string;
  /** «سقف جست‌وجوی روزانه» (0 = بی‌سقف) — protects against a surprise invoice. */
  dailyLimit: number;
  /** Example: «AIza…9xQ2» — never the token itself. */
  tokenHint: string;
  updatedAtISO: string | null;
  updatedBy: string | null;
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  /** True when the value is read-only because it comes from the environment. */
  fromEnv: boolean;
}

export interface GoogleConnectionPublic {
  configured: boolean;
  source: ConnectionSource | null;
  clientId: string;
  /** Never the secret — only its last four characters. */
  secretHint: string;
  hasSecret: boolean;
  calendarId: string;
  /** Overrides the redirect URI derived from the request (rarely needed). */
  redirectUri: string;
  /** The URI to register in the Google Cloud console for this request's origin. */
  effectiveRedirectUri: string;
  /** openid, email, calendar.events */
  scopes: string[];
  updatedAtISO: string | null;
  updatedBy: string | null;
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
  fromEnv: boolean;
}

export interface ConnectionsPayload {
  sourcing: SourcingConnectionPublic;
  google: GoogleConnectionPublic;
  /** Both docs are served from the repository, absolute paths are not needed. */
  docs: { sourcing: string; google: string };
}

/**
 * One row of «همه را بررسی کن»: `ok` is null when the check could not be made
 * (nothing configured, no route to the provider, or a per-workspace secret that
 * needs a real send). Null is never displayed as «سالم».
 */
export interface ConnectionHealthCheck {
  key: 'sourcing' | 'google' | 'email' | 'calendar';
  title: string;
  configured: boolean;
  ok: boolean | null;
  message: string;
  detail: string | null;
}

export interface ConnectionsHealth {
  atISO: string;
  checks: ConnectionHealthCheck[];
  adoption: { orgs: number; email: number; calendar: number };
}

export interface SourcingConnectionInput {
  kind?: SourcingProviderKind;
  endpointUrl?: string;
  /** Only sent to set/replace the token. */
  token?: string;
  providerLabel?: string;
  /** Apify only, e.g. `harvestapi/linkedin-profile-search`. */
  actorId?: string;
  /** Daily search cap (0 = unlimited). Omitted keeps the current value. */
  dailyLimit?: number;
}

export interface GoogleConnectionInput {
  clientId?: string;
  /** Only sent to set/replace the secret. */
  clientSecret?: string;
  calendarId?: string;
  redirectUri?: string;
}

// ----------------------------------------------------------- system config ----

export type BannerTone = 'info' | 'warning' | 'success';

export interface SystemSettings {
  signupEnabled: boolean;
  demoEnabled: boolean;
  demoHours: number;
  /** Per resume file. */
  maxFileMb: number;
  maxFilesPerBatch: number;
  sessionDays: number;
  announcement: { enabled: boolean; text: string; tone: BannerTone };
  maintenance: { enabled: boolean; message: string };
  supportEmail: string;
}

/** Public, unauthenticated subset (GET /api/auth/config). */
export interface PublicConfig {
  demo: boolean;
  demoHours: number;
  signup: boolean;
  announcement: { text: string; tone: BannerTone } | null;
  maintenance: string | null;
  maxFileMb: number;
  maxFilesPerBatch: number;
  supportEmail: string;
}

// ------------------------------------------------------------ AI behaviour ----

export type Strictness = 'lenient' | 'balanced' | 'strict';

/** Domain knowledge the model uses for a whole industry / job family. */
export interface IndustryProfile {
  id: string;
  name: string;
  enabled: boolean;
  builtin: boolean;
  /** Persian + English terms matched against the job title, department and description. */
  keywords: string[];
  competencies: string[];
  /** What counts as strong, verifiable evidence in this field. */
  evidence: string[];
  credentials: string[];
  redFlags: string[];
  notes: string;
}

export type BehaviorSectionKey =
  | 'identity'
  | 'principles'
  | 'rubric'
  | 'documents'
  | 'fairness'
  | 'seniority'
  | 'output'
  | 'deep'
  | 'custom';

export interface BehaviorConfig {
  version: number;
  updatedAtISO: string;
  updatedBy: string | null;
  strictness: Strictness;
  /** Detect the industry of each job opening and add its guide to the prompt. */
  autoIndustry: boolean;
  sections: Record<BehaviorSectionKey, string>;
  industries: IndustryProfile[];
}

export interface BehaviorVersionInfo {
  version: number;
  savedAtISO: string;
  savedBy: string | null;
  note: string;
}

export interface BehaviorPayload {
  config: BehaviorConfig;
  defaults: BehaviorConfig;
  history: BehaviorVersionInfo[];
}

export interface LabResult {
  industry: { id: string; name: string } | null;
  systemPrompt: string;
  userPrompt: string;
  engine: 'ai' | 'local';
  evaluation: unknown;
  format: string | null;
  textPreview: string;
  warnings: string[];
  latencyMs: number;
}

// ------------------------------------------------------------- monitoring ----

export interface AuditItem {
  id: string;
  atISO: string;
  actorId: string | null;
  actorName: string;
  action: string;
  target: string;
  detail: string;
  ip: string | null;
}

export interface AdminOverview {
  orgs: { total: number; demo: number; suspended: number; newThisWeek: number };
  users: { total: number; admins: number; disabled: number; activeThisWeek: number };
  jobs: { total: number; open: number };
  resumes: { total: number; thisWeek: number; aiEngine: number; localEngine: number; unjudgeable: number };
  storageBytes: number;
  ai: { enabled: boolean; keys: number; ready: number; cooling: number; invalid: number; callsToday: number; failuresToday: number };
  formats: Array<{ format: string; count: number }>;
  daily: Array<{ day: string; resumes: number; signups: number }>;
  server: { startedAtISO: string; node: string; dataDir: string; version: string; storage: StorageDriverInfo };
}

export interface AdminOrgRow {
  id: string;
  name: string;
  isDemo: boolean;
  suspended: boolean;
  suspendedReason: string | null;
  createdAtISO: string;
  demoExpiresAt: string | null;
  owner: { id: string; name: string; email: string } | null;
  members: number;
  jobs: number;
  resumes: number;
  lastActivityISO: string | null;
}

export interface AdminUserRow {
  id: string;
  name: string;
  email: string;
  title: string;
  role: 'owner' | 'admin' | 'member';
  orgId: string;
  orgName: string;
  orgIsDemo: boolean;
  platformAdmin: boolean;
  platformAdminViaEnv: boolean;
  disabled: boolean;
  createdAtISO: string;
  lastLoginISO: string | null;
  sessions: number;
  /** «ورود دومرحله‌ای» is on for this account. */
  twoFactorEnabled: boolean;
}

export interface AdminMe {
  isAdmin: boolean;
  /** True while no platform admin exists — a setup code (printed in the server log) can claim the role. */
  setupPending: boolean;
}

// ---------------------------------------------------------------- backups ----

export interface StorageDriverInfo {
  /** fs: the server's disk (DATA_DIR); remote: an object store (Cloudflare R2). */
  driver: 'fs' | 'remote';
  location: string;
}

export interface BackupInfo {
  storage: StorageDriverInfo;
  lastSavedAtISO: string | null;
  counts: { orgs: number; users: number; jobs: number; resumes: number; files: number };
  storageBytes: number;
  lastBackup: { atISO: string; actorName: string } | null;
  limits: { maxBytes: number; chunkBytes: number };
  appVersion: string;
}

export interface BackupCounts {
  orgs: number;
  demoOrgs: number;
  users: number;
  jobs: number;
  resumes: number;
  files: number;
  missingFiles: number;
}

/** What an uploaded backup contains — shown before anything is replaced. */
export interface BackupSummary {
  fileName: string;
  bytes: number;
  createdAtISO: string;
  createdAtJalali: string;
  createdBy: string;
  appVersion: string;
  counts: BackupCounts;
  /** Accounts that will be platform admins after the restore. */
  admins: number;
  aiKeys: { total: number; readable: number };
}

export interface RestoreResult {
  counts: BackupCounts;
  filesRestored: number;
  filesMissing: number;
  aiKeys: { restored: number; unreadable: number; keptFromThisServer: number };
  admins: number;
  saved: boolean;
}

export interface RestoreStatus {
  state: 'applying' | 'done' | 'failed';
  progress: { done: number; total: number };
  result: RestoreResult | null;
  error: string | null;
}

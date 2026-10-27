import type {
  CriteriaSource,
  DecisionStatus,
  DraftMessage,
  EmploymentType,
  Job,
  JobStats,
  JobSummary,
  JobUnderstanding,
  MessageKind,
  PagedResult,
  ResumeListItem,
  ResumePage,
  ResumeQuery,
  ResumeRecord,
  ScreeningAnswers,
} from '../types/screening';
import type {
  ActivityFeed,
  AiStatus,
  AuthPayload,
  DashboardData,
  Department,
  MeResponse,
  OrgPublic,
  ReportRange,
  ReportsData,
  Role,
  SearchResults,
  TalentDepartment,
  TeamMember,
  UserPublic,
} from '../types/app';
import type {
  CalendarStatusPublic,
  EmailSettingsPublic,
  IntegrationsStatus,
  InterviewRecord,
  SentEmail,
  SourcingBrief,
  SourcingCsvPreview,
  SourcingCsvSummary,
  SourcingProfile,
  SourcingSearch,
} from '../types/integrations';
import type {
  AdminMe,
  AdminOrgRow,
  AdminOverview,
  AdminUserRow,
  AiCallLog,
  AiKeyInput,
  AiSettingsPublic,
  AuditItem,
  BackupInfo,
  BackupSummary,
  BehaviorConfig,
  BehaviorPayload,
  ConnectionsPayload,
  GoogleConnectionInput,
  KeyStrategy,
  LabResult,
  PublicConfig,
  RestoreStatus,
  SourcingConnectionInput,
  SystemSettings,
} from '../types/admin';

export const TOKEN_KEY = 'hovida.session.v1';
const SESSION_KIND_KEY = 'hovida.session.kind';

/**
 * The session token travels in a custom header rather than `Authorization`.
 * Reverse proxies and sandbox gateways (e.g. preview links) commonly strip
 * `Authorization`/`Cookie` before the request reaches the app, which made
 * every request after a successful login look like an expired session.
 */
export const SESSION_HEADER = 'X-Hovida-Session';

/**
 * The tab's session lives in memory; localStorage only carries it across
 * reloads and into new tabs. Memory keeps the app usable where storage is
 * blocked (third-party iframes, strict privacy modes), and a sign-in in
 * another tab can never silently swap the account this tab is acting as.
 */
let memoryToken: string | null | undefined; // undefined = not read yet

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  if (memoryToken === undefined) memoryToken = storedToken();
  return memoryToken;
}

export function setToken(token: string | null, opts: { persist?: boolean; demo?: boolean } = {}) {
  const previous = getToken();
  memoryToken = token;
  if (opts.persist === false) return;
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(SESSION_KIND_KEY, opts.demo ? 'demo' : 'user');
    } else if (previous && localStorage.getItem(TOKEN_KEY) === previous) {
      // Only forget our own session — another tab may have stored a newer one.
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    /* storage blocked — the session simply lasts until the tab is closed */
  }
}

/** Whether the last stored session belonged to a (now possibly expired) demo workspace. */
export function lastSessionWasDemo(): boolean {
  try {
    return localStorage.getItem(SESSION_KIND_KEY) === 'demo';
  } catch {
    return false;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  field?: string;
  data?: any;
  constructor(message: string, status: number, data?: any) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.field = data?.field;
    this.data = data;
  }
}

/** Fired once per expired session so the AuthProvider can sign the user out. */
export const UNAUTHORIZED_EVENT = 'hovida:unauthorized';
/**
 * Fired when maintenance mode starts or ends as seen by this tab's requests,
 * so the public config (and its banner) refreshes now rather than within the
 * next two-minute poll.
 */
export const MAINTENANCE_EVENT = 'hovida:maintenance';
let maintenanceSeen = false;

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Public endpoints (login, signup, demo): never attach the session token. */
  anonymous?: boolean;
  /** Binary upload (backup restore) instead of a JSON body. */
  rawBody?: Blob;
}

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = opts.anonymous ? null : getToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(opts.rawBody ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { [SESSION_HEADER]: token } : {}),
      },
      body: opts.rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (opts.signal?.aborted) throw err;
    if (err?.name === 'AbortError') {
      throw new ApiError(`پاسخ سرور بیش از ${Math.max(1, Math.round(timeoutMs / 1000)).toLocaleString('fa-IR')} ثانیه طول کشید؛ اتصال را بررسی کنید.`, 0);
    }
    throw new ApiError('ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی کنید.', 0);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const data = await res.json().catch(() => ({}));
  const inMaintenance = res.status === 503 && (data as any)?.code === 'MAINTENANCE';
  if (inMaintenance !== maintenanceSeen && (inMaintenance || res.ok)) {
    maintenanceSeen = inMaintenance;
    window.dispatchEvent(new Event(MAINTENANCE_EVENT));
  }
  if (!res.ok) {
    // Only a rejection of the *current* session signs the tab out: a late 401
    // for a token that a fresh login has since replaced must not wipe it.
    if (res.status === 401 && token && token === getToken()) {
      window.dispatchEvent(
        new CustomEvent(UNAUTHORIZED_EVENT, { detail: { code: (data as any)?.code ?? null, message: (data as any)?.error ?? null } })
      );
    }
    throw new ApiError((data as any)?.error || `خطای سرور (${res.status})`, res.status, data);
  }
  return data as T;
}

const get = <T>(url: string, opts?: RequestOptions) => request<T>('GET', url, undefined, opts);
const post = <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', url, body ?? {}, opts);
const patch = <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', url, body ?? {}, opts);
const put = <T>(url: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', url, body ?? {}, opts);
const del = <T>(url: string, opts?: RequestOptions) => request<T>('DELETE', url, undefined, opts);

function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface JobInput {
  departmentId: string;
  roleTitle: string;
  extraNotes: string;
  location: string;
  employmentType: EmploymentType | null;
}

export interface EvaluatePayload {
  fileName: string;
  extractedText: string;
  unjudgeableReason: string | null;
  fileBase64?: string;
  errorMessage?: string;
}

export interface FileUrlInfo {
  hasFile: boolean;
  url: string | null;
  expiresAt: number | null;
  fileName: string;
  ext: string;
  mimeType: string | null;
  previewable: boolean;
}

export const api = {
  auth: {
    config: () => get<PublicConfig>('/api/auth/config', { timeoutMs: 10_000, anonymous: true }),
    signup: (b: { orgName: string; name: string; email: string; password: string }) =>
      post<AuthPayload>('/api/auth/signup', b, { anonymous: true }),
    login: (b: { email: string; password: string }) => post<AuthPayload>('/api/auth/login', b, { anonymous: true }),
    demo: () => post<AuthPayload>('/api/auth/demo', {}, { timeoutMs: 45_000, anonymous: true }),
    logout: () => post<{ ok: boolean }>('/api/auth/logout'),
    me: () => get<MeResponse>('/api/auth/me', { timeoutMs: 15_000 }),
    updateMe: (b: { name?: string; title?: string; currentPassword?: string; newPassword?: string }) =>
      patch<{ user: UserPublic }>('/api/auth/me', b),
  },
  org: {
    get: () => get<{ org: OrgPublic; members: TeamMember[] }>('/api/org'),
    update: (b: { name?: string; messageSignature?: string }) => patch<{ org: OrgPublic }>('/api/org', b),
    setDepartments: (departments: Array<Partial<Department> & { name: string; hint: string }>) =>
      put<{ org: OrgPublic }>('/api/org/departments', { departments }),
    addMember: (b: { name: string; email: string; title: string; role: Role; password: string }) =>
      post<{ member: TeamMember; members: TeamMember[] }>('/api/org/members', b),
    updateMember: (id: string, role: Role) => patch<{ members: TeamMember[] }>(`/api/org/members/${id}`, { role }),
    removeMember: (id: string) => del<{ members: TeamMember[] }>(`/api/org/members/${id}`),
  },
  ai: {
    status: () => get<AiStatus>('/api/ai/status'),
    test: () => post<{ ok: boolean; latencyMs: number; error: string | null; status: AiStatus }>('/api/ai/test', {}, { timeoutMs: 45_000 }),
  },
  jobs: {
    list: (p: { status?: string; q?: string } = {}) =>
      get<{ items: JobSummary[]; counts: { all: number; open: number; paused: number; closed: number } }>(`/api/jobs${qs(p)}`),
    understand: (b: JobInput, opts?: RequestOptions) =>
      post<{ understanding: JobUnderstanding; source: CriteriaSource }>('/api/jobs/understand', b, { timeoutMs: 75_000, ...opts }),
    template: (b: { departmentId: string; roleTitle: string }) =>
      post<{ understanding: JobUnderstanding; source: CriteriaSource }>('/api/jobs/template', b),
    create: (b: JobInput & { understanding: JobUnderstanding; answers: ScreeningAnswers; criteriaSource: CriteriaSource }) =>
      post<{ job: Job }>('/api/jobs', b),
    get: (id: string, opts?: RequestOptions) => get<{ job: Job }>(`/api/jobs/${id}`, opts),
    update: (id: string, b: Partial<JobInput> & { status?: Job['status'] }) => patch<{ job: Job }>(`/api/jobs/${id}`, b),
    remove: (id: string) => del<{ ok: boolean }>(`/api/jobs/${id}`),
    analysis: (id: string, state: 'start' | 'cancel', opts?: RequestOptions) =>
      post<{ job: Job }>(`/api/jobs/${id}/analysis`, { state }, opts),
    evaluate: (id: string, b: EvaluatePayload, opts?: RequestOptions) =>
      post<{ record: ResumeListItem; stats: JobStats }>(`/api/jobs/${id}/evaluate`, b, {
        // Base64 uploads of large scans need more time on slow connections; the
        // server itself bounds the AI (admin-tunable budget + key failover).
        timeoutMs: b.fileBase64 ? 210_000 : 150_000,
        ...opts,
      }),
    calibrate: (id: string, count: number, opts?: RequestOptions) =>
      post<{ job: Job; adjusted: number }>(`/api/jobs/${id}/calibrate`, { count }, { timeoutMs: 60_000, ...opts }),
  },
  resumes: {
    list: (q: ResumeQuery, opts?: RequestOptions) =>
      get<ResumePage>(
        `/api/resumes${qs({
          jobId: q.jobId,
          match: q.match,
          decision: q.decision,
          q: q.q,
          departmentId: q.departmentId,
          minScore: q.minScore,
          minYears: q.minYears,
          from: q.fromJalali,
          to: q.toJalali,
          sort: q.sort,
          novelty: q.novelty,
          page: q.page,
          pageSize: q.pageSize,
        })}`,
        opts
      ),
    get: (id: string, opts?: RequestOptions) => get<{ record: ResumeRecord; job: Job | null }>(`/api/resumes/${id}`, opts),
    compare: (ids: string[]) =>
      get<{ job: Job; items: ResumeListItem[]; droppedOtherJobs: boolean; missingIds?: string[] }>(`/api/resumes/compare?ids=${ids.map(encodeURIComponent).join(',')}`),
    decide: (id: string, status: DecisionStatus, note?: string | null) =>
      patch<{ record: ResumeListItem }>(`/api/resumes/${id}`, { action: 'decision', status, note: note ?? null }),
    markMessageSent: (id: string, kind: MessageKind) => patch<{ record: ResumeListItem }>(`/api/resumes/${id}`, { action: 'message-sent', kind }),
    bulk: (ids: string[], action: 'decision' | 'delete', status?: DecisionStatus, note?: string) =>
      post<{ updated: number }>('/api/resumes/bulk', { ids, action, status, note }),
    remove: (id: string) => del<{ ok: boolean; stats?: JobStats }>(`/api/resumes/${id}`),
    rerun: (id: string) => post<{ record: ResumeRecord; engine: string }>(`/api/resumes/${id}/rerun`, {}, { timeoutMs: 150_000 }),
    deepRerun: (id: string) => post<{ record: ResumeRecord; engine: string }>(`/api/resumes/${id}/deep-rerun`, {}, { timeoutMs: 270_000 }),
    addTalent: (id: string, b: { departmentId: string; note: string; tags: string[] }) =>
      post<{ record: ResumeListItem }>(`/api/resumes/${id}/talent`, b),
    removeTalent: (id: string) => del<{ record: ResumeListItem }>(`/api/resumes/${id}/talent`),
    attachFile: (id: string, fileName: string, fileBase64: string) =>
      post<{ ok: boolean }>(`/api/resumes/${id}/file`, { fileName, fileBase64 }, { timeoutMs: 150_000 }),
    fileUrl: (id: string, inline: boolean) => get<FileUrlInfo>(`/api/resumes/${id}/file-url${inline ? '?inline=1' : ''}`),
  },
  messages: {
    draft: (resumeId: string, kind: MessageKind, opts?: RequestOptions) =>
      post<DraftMessage>('/api/messages/draft', { resumeId, kind }, { timeoutMs: 40_000, ...opts }),
  },
  integrations: {
    status: () => get<IntegrationsStatus>('/api/integrations/status'),
    saveEmail: (b: {
      host: string;
      port: number;
      secure: boolean;
      username: string;
      password?: string;
      fromName: string;
      fromAddress: string;
      replyTo?: string | null;
    }) => put<{ email: EmailSettingsPublic }>('/api/integrations/email', b, { timeoutMs: 60_000 }),
    disconnectEmail: () => del<{ email: EmailSettingsPublic }>('/api/integrations/email'),
    testEmail: () => post<{ ok: boolean; error: string | null }>('/api/integrations/email/test', {}, { timeoutMs: 60_000 }),
    sendEmail: (b: { resumeId?: string | null; to?: string; subject: string; body: string }) =>
      post<{ email: SentEmail; record: ResumeListItem | null }>('/api/integrations/email/send', b, { timeoutMs: 60_000 }),
    emails: (resumeId?: string) => get<{ items: SentEmail[] }>(`/api/integrations/emails${resumeId ? `?resumeId=${encodeURIComponent(resumeId)}` : ''}`),
    calendarConnectUrl: () => get<{ url: string; redirectUri: string }>('/api/integrations/calendar/connect-url'),
    disconnectCalendar: () => del<{ calendar: CalendarStatusPublic }>('/api/integrations/calendar'),
  },
  interviews: {
    list: (p: { jobId?: string; resumeId?: string } = {}) => get<{ items: InterviewRecord[] }>(`/api/interviews${qs(p)}`),
    create: (b: {
      jobId: string;
      resumeId?: string | null;
      candidateName?: string;
      candidateEmail?: string | null;
      title: string;
      date: string;
      time: string;
      durationMin: number;
      interviewerIds: string[];
      location: string;
      notes: string;
      withMeet: boolean;
      sendInvite: boolean;
    }) => post<{ interview: InterviewRecord; calendarError: string | null; emailError: string | null; record: ResumeListItem | null }>('/api/interviews', b, { timeoutMs: 90_000 }),
    cancel: (id: string) => del<{ interview: InterviewRecord; calendarError: string | null }>(`/api/interviews/${encodeURIComponent(id)}`),
    icsUrl: (id: string) => `/api/interviews/${encodeURIComponent(id)}/ics`,
  },
  sourcing: {
    status: () => get<{ sourcing: IntegrationsStatus['sourcing']; docPath: string }>('/api/sourcing/status'),
    brief: (b: { departmentId: string; jobId?: string | null; prompt: string; roleTitle?: string; openToWorkOnly: boolean }) =>
      post<{ brief: SourcingBrief }>('/api/sourcing/brief', b, { timeoutMs: 90_000 }),
    list: () => get<{ items: Array<SourcingSearch & { resultCount: number }> }>('/api/sourcing/searches'),
    get: (id: string) => get<{ search: SourcingSearch }>(`/api/sourcing/searches/${encodeURIComponent(id)}`),
    run: (b: { departmentId: string; jobId?: string | null; prompt: string; roleTitle?: string; openToWorkOnly: boolean; limit?: number; brief?: SourcingBrief }) =>
      post<{ search: SourcingSearch }>('/api/sourcing/searches', b, { timeoutMs: 120_000 }),
    remove: (id: string) => del<{ ok: boolean }>(`/api/sourcing/searches/${encodeURIComponent(id)}`),
    /** Reads an uploaded CSV without saving anything (columns + a few names). */
    csvPreview: (b: { csv: string; separator?: string }) =>
      post<{ preview: SourcingCsvPreview; profiles: SourcingProfile[] }>('/api/sourcing/csv/preview', b, { timeoutMs: 45_000 }),
    /** Turns the file into a normal search result (same screening + import path). */
    csv: (b: { csv: string; fileName?: string; departmentId: string; jobId?: string | null; roleTitle?: string; openToWorkOnly?: boolean }) =>
      post<{ search: SourcingSearch; summary: SourcingCsvSummary }>('/api/sourcing/csv', b, { timeoutMs: 60_000 }),
    import: (searchId: string, profileId: string, jobId: string) =>
      post<{ record: ResumeListItem; alreadyImported: boolean }>(`/api/sourcing/searches/${encodeURIComponent(searchId)}/import`, { profileId, jobId }, { timeoutMs: 180_000 }),
  },
  talent: {
    overview: () => get<{ departments: TalentDepartment[]; tags: string[]; total: number }>('/api/talent'),
    list: (p: { departmentId?: string; q?: string; tags?: string[]; minScore?: number; minYears?: number; sort?: string; page?: number }) =>
      get<PagedResult<ResumeListItem>>(`/api/talent/list${qs({ ...p, tags: p.tags?.length ? p.tags.join(',') : undefined })}`),
  },
  insights: {
    dashboard: () => get<DashboardData>('/api/dashboard'),
    reports: (range: ReportRange) => get<ReportsData>(`/api/reports?range=${range}`),
    search: (q: string, opts?: RequestOptions) => get<SearchResults>(`/api/search?q=${encodeURIComponent(q)}`, opts),
    activity: (limit = 30) => get<ActivityFeed>(`/api/activity?limit=${limit}`),
    markSeen: () => post<{ unread: number }>('/api/activity/seen'),
  },
};

export interface KeyTestResult {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  model: string;
  error: string | null;
}

/** Platform administration (/admin) — platform admins only. */
export const adminApi = {
  me: () => get<AdminMe>('/api/admin/me', { timeoutMs: 15_000 }),
  claim: (code: string) => post<{ ok: boolean }>('/api/admin/claim', { code }),
  overview: () => get<AdminOverview>('/api/admin/overview'),
  orgs: (p: { q?: string; filter?: string } = {}) => get<{ items: AdminOrgRow[] }>(`/api/admin/orgs${qs(p)}`),
  updateOrg: (id: string, b: { name?: string; suspended?: boolean; suspendedReason?: string }) => patch<{ org: AdminOrgRow }>(`/api/admin/orgs/${id}`, b),
  extendDemo: (id: string, hours: number) => post<{ org: AdminOrgRow }>(`/api/admin/orgs/${id}/extend-demo`, { hours }),
  convertDemo: (id: string) => post<{ org: AdminOrgRow }>(`/api/admin/orgs/${id}/convert-demo`),
  deleteOrg: (id: string, confirm: string) => request<{ ok: boolean }>('DELETE', `/api/admin/orgs/${id}`, { confirm }),
  support: (id: string) => post<{ token: string; expiresAt: number; user: UserPublic; org: OrgPublic }>(`/api/admin/orgs/${id}/support`),
  users: (p: { q?: string; filter?: string; orgId?: string } = {}) => get<{ items: AdminUserRow[] }>(`/api/admin/users${qs(p)}`),
  updateUser: (id: string, b: { name?: string; role?: Role; disabled?: boolean; platformAdmin?: boolean }) => patch<{ user: AdminUserRow }>(`/api/admin/users/${id}`, b),
  resetPassword: (id: string) => post<{ tempPassword: string }>(`/api/admin/users/${id}/reset-password`),
  revokeSessions: (id: string) => post<{ user: AdminUserRow }>(`/api/admin/users/${id}/revoke-sessions`),
  deleteUser: (id: string) => del<{ ok: boolean }>(`/api/admin/users/${id}`),
  ai: () => get<AiSettingsPublic>('/api/admin/ai'),
  updateAi: (b: Partial<{ enabled: boolean; strategy: KeyStrategy; useEnvKeys: boolean; temperature: number; fastTimeoutSec: number; deepTimeoutSec: number }>) =>
    patch<AiSettingsPublic>('/api/admin/ai', b),
  addKey: (b: AiKeyInput) => post<AiSettingsPublic>('/api/admin/ai/keys', b),
  updateKey: (id: string, b: AiKeyInput) => patch<AiSettingsPublic>(`/api/admin/ai/keys/${id}`, b),
  deleteKey: (id: string) => del<AiSettingsPublic>(`/api/admin/ai/keys/${id}`),
  reorderKeys: (ids: string[]) => post<AiSettingsPublic>('/api/admin/ai/keys/reorder', { ids }),
  testKey: (id: string) => post<{ result: KeyTestResult; ai: AiSettingsPublic }>(`/api/admin/ai/keys/${id}/test`, {}, { timeoutMs: 60_000 }),
  resetKey: (id: string) => post<AiSettingsPublic>(`/api/admin/ai/keys/${id}/reset`),
  calls: (limit = 200) => get<{ items: AiCallLog[] }>(`/api/admin/ai/calls?limit=${limit}`),
  behavior: () => get<BehaviorPayload>('/api/admin/behavior'),
  saveBehavior: (config: BehaviorConfig, note: string) => put<BehaviorPayload>('/api/admin/behavior', { config, note }),
  resetBehavior: () => post<BehaviorPayload>('/api/admin/behavior/reset'),
  restoreBehavior: (version: number) => post<BehaviorPayload>('/api/admin/behavior/restore', { version }),
  previewBehavior: (b: { config?: BehaviorConfig; roleTitle: string; departmentName: string; extraNotes?: string; deep?: boolean }) =>
    post<{ industry: { id: string; name: string; score: number } | null; systemPrompt: string }>('/api/admin/behavior/preview', b),
  lab: (b: {
    config?: BehaviorConfig;
    jobId?: string;
    roleTitle?: string;
    departmentName?: string;
    extraNotes?: string;
    resumeText?: string;
    fileName?: string;
    fileBase64?: string;
    mode?: 'standard' | 'deep';
  }) => post<LabResult>('/api/admin/behavior/lab', b, { timeoutMs: 270_000 }),
  jobs: () => get<{ items: Array<{ id: string; orgId: string | null; orgName: string; title: string; departmentName: string }> }>('/api/admin/jobs'),
  connections: () => get<ConnectionsPayload>('/api/admin/connections'),
  saveSourcingConnection: (b: SourcingConnectionInput) => put<ConnectionsPayload>('/api/admin/connections/sourcing', b, { timeoutMs: 60_000 }),
  testSourcingConnection: () =>
    post<{ result: { ok: boolean; error: string | null; count: number | null; detail?: string }; connections: ConnectionsPayload }>(
      '/api/admin/connections/sourcing/test',
      {},
      { timeoutMs: 60_000 }
    ),
  removeSourcingConnection: () => del<ConnectionsPayload>('/api/admin/connections/sourcing'),
  saveGoogleConnection: (b: GoogleConnectionInput) =>
    put<{ connections: ConnectionsPayload; check: { ok: boolean | null; error: string | null } }>('/api/admin/connections/google', b, { timeoutMs: 40_000 }),
  removeGoogleConnection: () => del<ConnectionsPayload>('/api/admin/connections/google'),
  system: () => get<SystemSettings>('/api/admin/system'),
  updateSystem: (b: Partial<SystemSettings>) => patch<SystemSettings>('/api/admin/system', b),
  audit: (p: { q?: string; limit?: number } = {}) => get<{ items: AuditItem[] }>(`/api/admin/audit${qs(p)}`),
  backupInfo: () => get<BackupInfo>('/api/admin/backup'),
  /** A 10-minute link: the browser downloads the ZIP itself (no size limit in memory). */
  backupLink: () => post<{ url: string; expiresAt: number }>('/api/admin/backup/link'),
  restoreStart: (fileName: string, size: number) => post<{ id: string; chunkBytes: number }>('/api/admin/restore', { fileName, size }),
  restoreChunk: (id: string, offset: number, chunk: Blob, signal?: AbortSignal) =>
    request<{ received: number }>('PUT', `/api/admin/restore/${encodeURIComponent(id)}/chunk?offset=${offset}`, undefined, { rawBody: chunk, timeoutMs: 180_000, signal }),
  restoreInspect: (id: string) => post<BackupSummary>(`/api/admin/restore/${encodeURIComponent(id)}/inspect`, {}, { timeoutMs: 180_000 }),
  restoreApply: (id: string, confirm: string) => post<{ state: string }>(`/api/admin/restore/${encodeURIComponent(id)}/apply`, { confirm }),
  restoreCancel: (id: string) => del<{ ok: boolean }>(`/api/admin/restore/${encodeURIComponent(id)}`),
  /** Public on purpose: a finished restore ends every session, this tab's too. */
  restoreStatus: (id: string) => get<RestoreStatus>(`/api/restore-status/${encodeURIComponent(id)}`, { anonymous: true, timeoutMs: 20_000 }),
};

export function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(reader.error || new Error('خواندن فایل ممکن نشد'));
    reader.readAsDataURL(file);
  });
}

/** Downloads (or opens) the original resume via a short-lived signed link. */
export async function openResumeFile(id: string, mode: 'download' | 'tab'): Promise<boolean> {
  const info = await api.resumes.fileUrl(id, mode === 'tab');
  if (!info.hasFile || !info.url) return false;
  if (mode === 'tab') {
    // Without 'noopener' we can tell whether the popup was blocked (embedded
    // previews often block them); our own file URL is safe to detach after.
    const w = window.open(info.url, '_blank');
    if (w) {
      try {
        w.opener = null;
      } catch {
        /* ignore */
      }
      return true;
    }
  }
  {
    const a = document.createElement('a');
    a.href = info.url;
    a.download = info.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return true;
}

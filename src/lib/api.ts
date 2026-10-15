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

const TOKEN_KEY = 'hovida.session.v1';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
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

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(method: string, url: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = getToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
  if (!res.ok) {
    if (res.status === 401 && token) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
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
    config: () => get<{ demo: boolean }>('/api/auth/config', { timeoutMs: 10_000 }),
    signup: (b: { orgName: string; name: string; email: string; password: string }) => post<AuthPayload>('/api/auth/signup', b),
    login: (b: { email: string; password: string }) => post<AuthPayload>('/api/auth/login', b),
    demo: () => post<AuthPayload>('/api/auth/demo', {}, { timeoutMs: 45_000 }),
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
        // Base64 uploads of large scans need more time on slow connections.
        timeoutMs: b.fileBase64 ? 150_000 : 60_000,
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
          page: q.page,
          pageSize: q.pageSize,
        })}`,
        opts
      ),
    get: (id: string, opts?: RequestOptions) => get<{ record: ResumeRecord; job: Job | null }>(`/api/resumes/${id}`, opts),
    compare: (ids: string[]) =>
      get<{ job: Job; items: ResumeListItem[]; droppedOtherJobs: boolean }>(`/api/resumes/compare?ids=${ids.map(encodeURIComponent).join(',')}`),
    decide: (id: string, status: DecisionStatus, note?: string | null) =>
      patch<{ record: ResumeListItem }>(`/api/resumes/${id}`, { action: 'decision', status, note: note ?? null }),
    markMessageSent: (id: string, kind: MessageKind) => patch<{ record: ResumeListItem }>(`/api/resumes/${id}`, { action: 'message-sent', kind }),
    bulk: (ids: string[], action: 'decision' | 'delete', status?: DecisionStatus, note?: string) =>
      post<{ updated: number }>('/api/resumes/bulk', { ids, action, status, note }),
    remove: (id: string) => del<{ ok: boolean; stats?: JobStats }>(`/api/resumes/${id}`),
    rerun: (id: string) => post<{ record: ResumeRecord; engine: string }>(`/api/resumes/${id}/rerun`, {}, { timeoutMs: 60_000 }),
    deepRerun: (id: string) => post<{ record: ResumeRecord; engine: string }>(`/api/resumes/${id}/deep-rerun`, {}, { timeoutMs: 120_000 }),
    addTalent: (id: string, b: { departmentId: string; note: string; tags: string[] }) =>
      post<{ record: ResumeListItem }>(`/api/resumes/${id}/talent`, b),
    removeTalent: (id: string) => del<{ record: ResumeListItem }>(`/api/resumes/${id}/talent`),
    attachFile: (id: string, fileName: string, fileBase64: string) =>
      post<{ ok: boolean }>(`/api/resumes/${id}/file`, { fileName, fileBase64 }, { timeoutMs: 150_000 }),
    fileUrl: (id: string, inline: boolean) => get<FileUrlInfo>(`/api/resumes/${id}/file-url${inline ? '?inline=1' : ''}`),
  },
  messages: {
    draft: (resumeId: string, kind: MessageKind) => post<DraftMessage>('/api/messages/draft', { resumeId, kind }, { timeoutMs: 40_000 }),
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
    window.open(info.url, '_blank', 'noopener');
  } else {
    const a = document.createElement('a');
    a.href = info.url;
    a.download = info.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return true;
}

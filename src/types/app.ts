// ================================================================
// HOVIDA — workspace (multi-tenant SaaS) types shared by client & server.
// ================================================================
import type { JobStatus, JobSummary, ResumeCategory, ResumeListItem } from './screening';

export type Role = 'owner' | 'admin' | 'member';

export interface Department {
  id: string;
  name: string;
  /** Short description of the department's work — fed to the AI. */
  hint: string;
}

export interface OrgPublic {
  id: string;
  name: string;
  departments: Department[];
  /** Appended to every candidate message draft. */
  messageSignature: string;
  isDemo: boolean;
  demoExpiresAt: string | null;
  /**
   * Public career portal («پورتال شغلی»): the slug in `/careers/<slug>` and the
   * short «دربارهٔ ما» shown above the openings. Editable by the workspace admin.
   */
  careerSlug: string;
  careerAbout: string;
  /**
   * «غربالگری بی‌طرف»: while on, screening views are redacted on the server and
   * contacting a candidate waits for an explicit, logged reveal.
   */
  blindScreening?: boolean;
  createdAtISO: string;
  /** Suspended by a platform admin — members cannot sign in. */
  suspended?: boolean;
  suspendedReason?: string | null;
}

export interface UserPublic {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  title: string;
  createdAtISO: string;
  lastLoginISO: string | null;
  /** Operator of the whole deployment (/admin). */
  platformAdmin?: boolean;
  /** «ورود دومرحله‌ای» is active for this account (the secret itself never leaves the server). */
  twoFactorEnabled?: boolean;
  disabled?: boolean;
}

export interface AiStatus {
  available: boolean;
  provider: 'gemini' | 'openai' | null;
  model: string | null;
  /** Human readable, e.g. «Gemini · gemini-3.5-flash-lite» */
  label: string;
  /** Persian explanation when unavailable. */
  reason: string | null;
  /** True while every key of the pool is cooling down after limits/errors. */
  coolingDown: boolean;
  /** Key pool size and how many keys are usable right now. */
  keys?: number;
  readyKeys?: number;
}

export interface AuthPayload {
  token: string;
  user: UserPublic;
  org: OrgPublic;
}

/** `POST /api/auth/login` for an account with «ورود دومرحله‌ای» on. */
export interface TwoFactorChallenge {
  twoFactorRequired: true;
  challenge: string;
  hint: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAtISO: string | null;
  recoveryLeft: number;
  pending: boolean;
}

export interface MeResponse {
  user: UserPublic;
  org: OrgPublic;
  ai: AiStatus;
  unread: number;
  /** Present when a platform admin opened this session for support. */
  support?: { adminName: string; expiresAt: number } | null;
}

export type ActivityType =
  | 'org.created'
  | 'member.added'
  | 'member.removed'
  | 'member.updated'
  | 'candidate.revealed'
  | 'job.created'
  | 'job.status'
  | 'job.deleted'
  | 'analysis.completed'
  | 'decision'
  | 'talent.added'
  | 'message.sent'
  | 'message.failed'
  | 'deep.review'
  | 'resume.deleted'
  | 'sourcing.search'
  | 'sourcing.imported'
  | 'interview.scheduled'
  | 'interview.cancelled'
  | 'interview.reminder'
  | 'automation.run'
  | 'automation.approved'
  | 'stage.moved'
  | 'scorecard.added'
  | 'offer.sent'
  | 'offer.accepted'
  | 'offer.declined'
  | 'offer.cancelled'
  | 'comment.added'
  | 'retention.applied'
  | 'survey.sent'
  | 'survey.answered'
  | 'assessment.sent'
  | 'assessment.completed'
  | 'settings.changed';

export interface ActivityItem {
  id: string;
  orgId: string;
  userId: string | null;
  userName: string | null;
  type: ActivityType;
  text: string;
  jobId: string | null;
  resumeId: string | null;
  atISO: string;
  atJalali: string;
}

export interface ActivityFeed {
  items: ActivityItem[];
  unread: number;
}

export interface DashboardData {
  kpis: {
    openJobs: number;
    totalJobs: number;
    analyzed30d: number;
    analyzedAll: number;
    pendingDecisions: number;
    highMatch: number;
    decided30d: number;
  };
  /** Clearly-labelled estimate, never presented as a measured number. */
  timeSaved: { hours: number; resumes: number; minutesManual: number; minutesWithHovida: number };
  pending: ResumeListItem[];
  jobs: JobSummary[];
  activity: ActivityItem[];
  aiShare: { ai: number; local: number };
}

export type ReportRange = '30' | '90' | '365' | 'all';

export interface ReportsData {
  range: ReportRange;
  totals: {
    analyzed: number;
    jobs: number;
    highMatch: number;
    avgScore: number;
    decided: number;
    approved: number;
    rejected: number;
    talentAdded: number;
    deepReviews: number;
  };
  timeline: { key: string; label: string; analyzed: number; high: number; approved: number }[];
  distribution: { category: ResumeCategory; count: number }[];
  byDepartment: { departmentId: string; name: string; analyzed: number; high: number; approved: number }[];
  funnel: { analyzed: number; matched: number; decided: number; approved: number };
  topSkills: { skill: string; count: number }[];
  engines: { ai: number; local: number };
  jobs: { id: string; roleTitle: string; departmentName: string; status: JobStatus; total: number; high: number; approved: number; avgScore: number }[];
  timeSaved: { hours: number; resumes: number; minutesManual: number; minutesWithHovida: number };
  /**
   * The hiring questions a manager actually asks: where do good people come
   * from, how long does it take, and is a stage becoming a bottleneck.
   */
  hiring: {
    bySource: { kind: ResumeSourceKind; label: string; count: number; hired: number }[];
    /** Current pipeline position across every open opening. */
    byStage: { id: string; name: string; kind: string; count: number }[];
    timeToHire: { medianDays: number | null; averageDays: number | null; sample: number };
    offers: { draft: number; sent: number; accepted: number; declined: number; cancelled: number; acceptRate: number | null };
    interviews: { scheduled: number; upcoming: number; cancelled: number };
  };
}

export type ResumeSourceKind = 'careers' | 'referral' | 'linkedin' | 'direct';

export interface SearchResults {
  jobs: { id: string; roleTitle: string; departmentName: string; status: JobStatus; total: number }[];
  candidates: {
    id: string;
    name: string;
    jobId: string;
    roleTitle: string;
    lastRole: string | null;
    score: number;
    category: ResumeCategory;
  }[];
}

export interface TalentDepartment {
  id: string;
  name: string;
  count: number;
}

export interface TeamMember extends UserPublic {
  isYou: boolean;
}

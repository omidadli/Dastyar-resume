/**
 * HOVIDA («هویدا») — types for the three outside connections:
 *   1. sourcing (LinkedIn-compatible provider)  → find specialists who are open to work
 *   2. organizational e-mail (SMTP)             → send the drafted message from the workspace
 *   3. Google Calendar                          → schedule the interview with the candidate
 *
 * Nothing here is fabricated: when a connection is not set up the UI says so.
 */

// ---------------------------------------------------------------- sourcing ----

export type SourcingEngine = 'ai' | 'local';

/** What the recruiter asked for, turned into fields a sourcing API can use. */
export interface SourcingBrief {
  roleTitle: string;
  seniority: string | null;
  locations: string[];
  skills: string[];
  mustHave: string[];
  /** Extra search words the AI (or the local parser) derived from the request. */
  keywords: string[];
  /** LinkedIn-style boolean query, e.g. ("SAP" OR "SAP HANA") AND "تهران". */
  booleanQuery: string;
  openToWorkOnly: boolean;
  notes: string;
  engine: SourcingEngine;
}

export interface SourcingExperience {
  title: string;
  company: string;
  /** Free-form period as stored by the provider, e.g. «۱۴۰۰ – اکنون». */
  period: string;
  description: string;
}

export interface SourcingProfile {
  /** Stable id at the provider (or the row position for a CSV import). */
  id: string;
  fullName: string;
  headline: string;
  location: string;
  profileUrl: string;
  /** «Open to work» as reported by the provider/file (never inferred). */
  openToWork: boolean;
  currentCompany: string | null;
  experiences: SourcingExperience[];
  education: string[];
  skills: string[];
  /** Only present when the source provided it (CSV column, provider field). */
  email?: string | null;
  /** Free-text summary from the source (CSV «Notes»/«About» column). */
  notes?: string | null;
}

export type SourcingStatus = 'running' | 'done' | 'error' | 'not_configured';

export interface SourcingSearch {
  id: string;
  departmentId: string;
  departmentName: string;
  jobId: string | null;
  jobTitle: string | null;
  prompt: string;
  brief: SourcingBrief;
  status: SourcingStatus;
  /** Persian, user-facing reason when status is error / not_configured. */
  message: string | null;
  results: SourcingProfile[];
  /** Profile id → resume id created when the candidate was added to an opening. */
  imported: Record<string, string>;
  /** Where the profiles came from: the connected service, or an uploaded file. */
  source?: 'provider' | 'csv';
  createdBy: string | null;
  createdByName: string | null;
  createdAtISO: string;
  createdAtJalali: string;
}

/** What an uploaded CSV looks like before anything is created. */
export interface SourcingCsvPreview {
  /** Header cells as they appear in the file (empty when there was no header). */
  headers: string[];
  /** The fields that were understood, in Persian. */
  recognised: string[];
  separator: string;
  totalRows: number;
  /** Rows without a usable name. */
  skippedRows: number;
  profileCount: number;
  /** The file itself reports «open to work» for some people. */
  hasOpenToWorkColumn: boolean;
  warnings: string[];
}

/** The result of turning a file into a search result. */
export interface SourcingCsvSummary {
  totalRows: number;
  profileCount: number;
  kept: number;
  filteredOut: number;
  skippedRows: number;
  hasOpenToWorkColumn: boolean;
  recognised: string[];
  warnings: string[];
}

/** Read-only status of the deployment's sourcing credential. */
export interface SourcingStatusPublic {
  configured: boolean;
  providerLabel: string;
  endpointHost: string | null;
  setupHint: string;
  docPath: string;
  /** Today's provider searches against the configured cap (CSV imports excluded). */
  usage?: {
    today: number;
    /** 0 = no cap. */
    dailyLimit: number;
    /** null when there is no cap. */
    remaining: number | null;
  };
}

// ------------------------------------------------------------------- email ----

export interface EmailSettingsPublic {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean;
  username: string | null;
  fromName: string;
  fromAddress: string | null;
  replyTo: string | null;
  /** Password is never returned — only whether one is stored. */
  hasPassword: boolean;
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
}

export type SentEmailStatus = 'sent' | 'failed';

export interface SentEmail {
  id: string;
  to: string;
  subject: string;
  body: string;
  resumeId: string | null;
  candidateName: string | null;
  jobId: string | null;
  status: SentEmailStatus;
  error: string | null;
  sentAtISO: string;
  sentAtJalali: string;
  sentByName: string | null;
  attachments: string[];
}

// ---------------------------------------------------------------- calendar ----

export interface CalendarStatusPublic {
  /** The deployment has an OAuth client (saved in /admin › «اتصال‌ها» or from GOOGLE_CLIENT_ID/SECRET). Without it no workspace can connect. */
  configured: boolean;
  /** This workspace has a stored Google connection. */
  connected: boolean;
  accountEmail: string | null;
  connectedAtISO: string | null;
  calendarId: string;
  /** Exact URI that must be registered in the Google Cloud console. */
  redirectUri: string | null;
  error: string | null;
}

export interface InterviewRecord {
  id: string;
  jobId: string;
  jobTitle: string;
  resumeId: string | null;
  candidateName: string;
  candidateEmail: string | null;
  title: string;
  /** UTC instant; the UI shows it in Tehran time. */
  startsAtISO: string;
  durationMin: number;
  timezone: string;
  interviewerIds: string[];
  interviewerNames: string[];
  location: string;
  notes: string;
  /** Google Calendar result (null when the event was only kept in HOVIDA). */
  calendarEventId: string | null;
  calendarHtmlLink: string | null;
  meetLink: string | null;
  inviteSentTo: string | null;
  status: 'scheduled' | 'cancelled';
  createdBy: string | null;
  createdByName: string | null;
  createdAtISO: string;
  createdAtJalali: string;
  cancelledAtISO?: string | null;
}

export interface IntegrationsStatus {
  sourcing: SourcingStatusPublic;
  email: EmailSettingsPublic;
  calendar: CalendarStatusPublic;
}

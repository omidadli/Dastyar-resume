/**
 * «اتوماسیون جذب» — the funnel does the routine work, the recruiter approves.
 *
 * The model is deliberately simple and auditable:
 *   ۱) a screening result exists (uploaded résumé or a sourced profile),
 *   ۲) the engine proposes one action per candidate (invite / reject / ask for
 *      information / book an interview) with the reason and a ready message,
 *   ۳) a human approves, edits or skips it — unless the workspace explicitly
 *      turned on automatic sending for that kind,
 *   ۴) every action keeps who approved it, when, and what was sent.
 *
 * Nothing is ever sent to a candidate without either a human approval or an
 * explicit workspace rule the admin turned on.
 */
import type { ResumeCategory } from './screening';

export type AutomationActionKind = 'invite' | 'reject' | 'request_info' | 'schedule';

export type AutomationActionStatus = 'pending' | 'sent' | 'skipped' | 'failed';

export interface MessageTemplate {
  subject: string;
  body: string;
}

export interface AutomationSettings {
  /** Master switch: when off, no proposals are built at all. */
  enabled: boolean;
  /** Score at/above which a candidate is worth inviting. */
  inviteThreshold: number;
  /** Score below which a candidate is a rejection. */
  rejectThreshold: number;
  /** Send without approval (still logged). Off by default: a human decides. */
  autoInvite: boolean;
  autoReject: boolean;
  /** Approving «دعوت» books an interview instead of only asking availability. */
  autoScheduleOnInvite: boolean;
  /** Suggested slot for the interview: N days from today, at this Tehran time. */
  scheduleDaysAhead: number;
  scheduleHour: string;
  scheduleDurationMin: number;
  /** Append the workspace signature to every message. */
  useSignature: boolean;
  /** Safety valve for a runaway loop: messages per hour for this workspace. */
  hourlyLimit: number;
  templates: {
    invite: MessageTemplate;
    reject: MessageTemplate;
    requestInfo: MessageTemplate;
  };
}

export interface AutomationProposal {
  id: string;
  jobId: string;
  jobTitle: string;
  departmentId: string;
  departmentName: string;
  resumeId: string;
  candidateName: string;
  candidateEmail: string | null;
  kind: AutomationActionKind;
  status: AutomationActionStatus;
  /** Persian, with the numbers that produced the decision. */
  reason: string;
  score: number;
  category: ResumeCategory;
  subject: string;
  body: string;
  /** For «schedule»: the slot the engine suggests (Tehran wall clock in the UI). */
  suggestedAtISO: string | null;
  /** Interview created when the proposal was approved. */
  interviewId: string | null;
  error: string | null;
  /** Set when the engine sent it by rule instead of a human. */
  auto: boolean;
  createdAtISO: string;
  createdAtJalali: string;
  decidedAtISO: string | null;
  decidedAtJalali: string | null;
  decidedByName: string | null;
  sentAtISO: string | null;
}

/** Everything the page needs in one call. */
export interface AutomationOverview {
  settings: AutomationSettings;
  queue: AutomationProposal[];
  /** Last decided proposals (sent, skipped, failed). */
  history: AutomationProposal[];
  counts: {
    pending: number;
    sent: number;
    skipped: number;
    failed: number;
  };
  /** What the last run found, and blockers worth showing (no mailbox, no e-mail). */
  readiness: {
    emailConfigured: boolean;
    calendarConnected: boolean;
    /** Candidates that cannot be contacted: no address on the résumé. */
    withoutEmail: number;
    /** Résumés still being analysed. */
    analysing: number;
  };
}

export interface AutomationRunResult {
  /** How many candidates the engine looked at. */
  examined: number;
  created: number;
  /** Sent immediately because a workspace rule allowed it. */
  autoSent: number;
  /** Already had a pending/sent proposal for the same action. */
  duplicates: number;
  skipped: Array<{ candidateName: string; reason: string }>;
  atISO: string;
}

/** One row of a dry run: exactly what `POST /automation/run` would propose. */
export interface AutomationPreviewItem {
  resumeId: string;
  candidateName: string;
  jobTitle: string;
  departmentName: string;
  kind: AutomationActionKind;
  reason: string;
  subject: string;
  body: string;
  suggestedAtISO: string | null;
  alreadyQueued: boolean;
}

/** Placeholders available in the templates (shown in the UI). */
export const TEMPLATE_VARS = [
  '{{نام}}',
  '{{عنوان شغلی}}',
  '{{دپارتمان}}',
  '{{شرکت}}',
  '{{امتیاز}}',
  '{{تاریخ}}',
  '{{مصاحبه‌گر}}',
  '{{امضای سازمان}}',
] as const;

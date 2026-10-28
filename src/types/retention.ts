/**
 * «نگه‌داری داده» — how long a workspace keeps a candidate who was never hired,
 * and what happens on the day the limit is reached.
 */
export type RetentionAction = 'anonymize' | 'delete';

export interface RetentionPolicy {
  /** 0 = off (nothing is ever removed automatically). */
  days: number;
  /** `anonymize` keeps the scores and removes the person; `delete` removes the row. */
  action: RetentionAction;
  updatedAtISO: string | null;
  updatedAtJalali: string | null;
  lastRunAtISO: string | null;
  lastRunAtJalali: string | null;
  /** How many records the last run touched. */
  lastRunCount: number;
}

export interface RetentionCandidate {
  id: string;
  name: string;
  jobId: string;
  roleTitle: string;
  updatedAtISO: string;
  decisionStatus: 'none' | 'approved' | 'rejected' | 'review';
}

export interface RetentionRunResult {
  dryRun: boolean;
  days: number;
  action: RetentionAction;
  anonymized: number;
  deleted: number;
  items: RetentionCandidate[];
}

/** Everything HOVIDA holds about one candidate, for a «right of access» request. */
export interface CandidateDataExport {
  exportedAtISO: string;
  exportedAtJalali: string;
  workspace: { id: string; name: string };
  candidate: Record<string, unknown> | null;
  job: Record<string, unknown> | null;
  /** Resume text, when it was still kept. */
  resumeText: string | null;
  notes: unknown[];
  interviews: unknown[];
  offers: unknown[];
  messages: { emails: unknown[]; sms: unknown[] };
  scorecards: unknown[];
  schedulingLinks: { id: string; createdAtISO: string; status: string }[];
  activity: { type: string; text: string; atISO: string }[];
}

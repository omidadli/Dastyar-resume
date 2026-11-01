/**
 * «گزارش عملکرد تیم» and «هزینهٔ هر استخدام» — the shapes the reports pages read.
 *
 * Two rules run through both:
 *  • every number is counted from something that actually happened in this
 *    workspace (a decision, a scorecard, a note, a booked interview, a cost row
 *    a human typed) — no invented activity;
 *  • the cost of *time* is an estimate and is labelled as one, and it is only
 *    added when the workspace has entered an hourly rate. Otherwise cost per
 *    hire is direct cost only, stated plainly.
 */
import type { ReportRange, Role } from './app';

export type CostKind = 'advertising' | 'agency' | 'referral' | 'tools' | 'assessment' | 'interview' | 'other';

export interface CostEntry {
  id: string;
  kind: CostKind;
  /** Whole تومان. Money is stored as an integer so it never gains a stray decimal. */
  amount: number;
  atISO: string;
  atJalali: string;
  /** null = a general cost that cannot honestly be pinned to one opening. */
  jobId: string | null;
  jobTitle: string | null;
  note: string;
  createdByName: string;
  createdAtISO: string;
}

/** The workspace's own estimate of internal recruiting time, in تومان per hour. */
export interface CostAssumption {
  hourlyRate: number;
  minutesPerScorecard: number;
  minutesPerComment: number;
  minutesPerDecision: number;
}

export interface CostReport {
  range: ReportRange;
  /** Newest first. */
  entries: CostEntry[];
  totals: {
    direct: number;
    /** Cost of internal time — 0 while no hourly rate is set. */
    time: number;
    total: number;
    /** Direct cost that was not attributed to any opening. */
    unattributed: number;
  };
  byKind: { kind: CostKind; label: string; amount: number; count: number }[];
  hires: number;
  /** null when nobody was hired in this range — never 0. */
  perHire: number | null;
  assumption: CostAssumption;
  /** Hours of real recorded work, the basis of the time estimate. */
  hours: { scorecards: number; comments: number; decisions: number; interviews: number; total: number };
  byJob: {
    jobId: string;
    roleTitle: string;
    direct: number;
    time: number;
    hires: number;
    perHire: number | null;
  }[];
}

export interface TeamMemberRow {
  userId: string;
  name: string;
  role: Role;
  title: string;
  decisions: number;
  approved: number;
  rejected: number;
  scorecards: number;
  comments: number;
  /** Interviews whose time has passed and that were not cancelled. */
  interviews: number;
  offersSent: number;
  /** Every recorded action above, added up — the workload number. */
  totalActions: number;
  /** Median hours from the candidate arriving to this member's decision. */
  medianDecideHours: number | null;
  lastActiveISO: string | null;
}

export interface TeamReport {
  range: ReportRange;
  members: TeamMemberRow[];
  totals: {
    decisions: number;
    approved: number;
    rejected: number;
    scorecards: number;
    comments: number;
    interviews: number;
    offersSent: number;
    /** Members with at least one recorded action in the range. */
    activeMembers: number;
    members: number;
  };
  /** Share of decisions taken by the busiest member (0–100, null with no decisions). */
  concentration: number | null;
  /** Share of decided candidates who got a decision within 72 hours. */
  fastShare: number | null;
}

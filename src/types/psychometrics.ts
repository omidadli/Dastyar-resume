/**
 * «سنجش نرم‌شده» — five work-relevant scales, scored against a norm group that is
 * named on screen.
 *
 * The distinction that matters: the behavioural test in «آزمون و ارزیابی» says
 * openly that it has no norms. This one either has a norm group and says which
 * one (with n), or says «بدون هنجار» and shows only the raw band. A percentile
 * without a named comparison group is a number pretending to be evidence.
 *
 * Items are short statements adapted from the International Personality Item
 * Pool (IPIP), which is public domain — no licensed instrument is copied, and no
 * clinical claim is made.
 */

export type PsychStatus = 'sent' | 'started' | 'submitted' | 'expired' | 'cancelled' | 'declined';

/** The five scales. Ids are stable; labels are what the workspace reads. */
export type PsychScaleId = 'conscientiousness' | 'agreeableness' | 'stability' | 'openness' | 'extraversion';

/** Where a percentile came from. `null` means there was no norm to use. */
export type PsychNormSource = 'internal' | 'external';

/** One answered item, as the public page sends it back. */
export type PsychAnswers = Record<string, 1 | 2 | 3 | 4 | 5>;

/** An item as the candidate sees it — no scale name, no keying direction. */
export interface PsychItemPublic {
  id: string;
  text: string;
  /** Attention checks are ordinary statements with a stated instruction. */
  instruction?: string;
}

/** The five-point agreement scale, from «کاملاً مخالفم» to «کاملاً موافقم». */
export const PSYCH_SCALE_POINTS: { value: 1 | 2 | 3 | 4 | 5; label: string }[] = [
  { value: 1, label: 'کاملاً مخالفم' },
  { value: 2, label: 'مخالفم' },
  { value: 3, label: 'بی‌نظر' },
  { value: 4, label: 'موافقم' },
  { value: 5, label: 'کاملاً موافقم' },
];

export interface PsychScaleSummary {
  id: PsychScaleId;
  label: string;
  /** What a high score tends to look like at work — never a hiring rule. */
  high: string;
  low: string;
  itemCount: number;
}

/** One quality indicator that can make a result unusable. */
export interface PsychFlag {
  code: 'ATTENTION' | 'STRAIGHT_LINE' | 'TOO_FAST' | 'INCOMPLETE';
  label: string;
}

export interface PsychScaleScore {
  id: PsychScaleId;
  label: string;
  /** Sum of keyed item values. */
  raw: number;
  min: number;
  max: number;
  /** 0–100, rounded: where this person sits on the scale's own width. */
  percent: number;
  /** 1–99, or null when no norm group was available. */
  percentile: number | null;
  /** Which norm produced the percentile; null when none did. */
  normSource: PsychNormSource | null;
}

export interface PsychResult {
  scales: PsychScaleScore[];
  quality: {
    /** True only when every indicator passed. */
    usable: boolean;
    flags: PsychFlag[];
    /** Seconds between opening the test and submitting it. */
    durationSeconds: number;
    attentionPassed: boolean;
  };
  norm: {
    source: PsychNormSource | null;
    /** Size of the comparison group, when there is one. */
    n: number | null;
    /** Human-readable: «هنجار داخلی این فضای کاری (n=۳۴)». */
    label: string;
  };
  submittedAtISO: string;
  submittedAtJalali: string;
}

export interface PsychInvite {
  id: string;
  resumeId: string;
  jobId: string;
  jobTitle: string;
  candidateName: string;
  candidateEmail: string | null;
  status: PsychStatus;
  createdAtISO: string;
  createdAtJalali: string;
  sentAtISO: string | null;
  startedAtISO: string | null;
  submittedAtISO: string | null;
  submittedAtJalali: string | null;
  expiresAtISO: string;
  result: PsychResult | null;
  url?: string;
}

/** What the candidate's page receives: items, scale points, and nothing else. */
export interface PublicPsychTest {
  org: { name: string };
  candidateName: string;
  jobTitle: string | null;
  status: PsychStatus;
  expiresAtISO: string;
  intro: string;
  aboutMinutes: number;
  scale: { value: number; label: string }[];
  items: PsychItemPublic[];
  /** Present once submitted: a closing note, never the scores. */
  submittedAtISO: string | null;
}

/** A workspace's own norm table, entered or computed. */
export interface PsychNormConfig {
  /** What is being said, in the workspace's own words: «نمونهٔ ۱۴۰۳ کارکنان». */
  source: string;
  /** Comparison-group size — required, because a percentile without n is a rumour. */
  n: number;
  scales: Record<string, { mean: number; sd: number }>;
  updatedAtISO: string;
  updatedByName: string;
}

/** One row of the group report. */
export interface PsychGroupRow {
  resumeId: string;
  candidateName: string;
  jobTitle: string;
  submittedAtJalali: string;
  usable: boolean;
  percentiles: Record<string, number | null>;
}

export interface PsychGroupReport {
  jobId: string;
  jobTitle: string;
  /** Submitted, usable results behind the averages. */
  n: number;
  norm: { source: PsychNormSource | null; n: number | null; label: string };
  /** Per scale; suppressed when fewer than five usable results exist. */
  scales: {
    id: PsychScaleId;
    label: string;
    n: number;
    meanPercentile: number | null;
    /** True when the group is too small to average without exposing a person. */
    suppressed: boolean;
    min: number | null;
    max: number | null;
  }[];
  rows: PsychGroupRow[];
  /** True when the averages come from fewer than five people. */
  suppressed: boolean;
}

export const PSYCH_STATUS_LABEL: Record<PsychStatus, string> = {
  sent: 'فرستاده شد',
  started: 'شروع شده',
  submitted: 'تکمیل شد',
  expired: 'منقضی شد',
  cancelled: 'لغو شد',
  declined: 'نپذیرفت',
};

/** Small-group rule for every aggregate in this module. */
export const SMALL_GROUP = 5;
/** Below this many completed results in a workspace, there is no internal norm. */
export const MIN_NORM_N = 20;

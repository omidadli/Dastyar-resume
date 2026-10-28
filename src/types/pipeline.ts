// ================================================================
// HOVIDA — pipeline stages and panel evaluation («تختهٔ جذب» و «کارت ارزیابی»)
// Shared by the client and the server; no runtime dependencies.
// ================================================================

/**
 * The meaning of a column, independent of its Persian name. A workspace may
 * rename «مصاحبه» to «مصاحبهٔ فنی»; the meaning is what the funnel metrics and
 * the automation rules read, so the numbers never depend on wording.
 */
export type StageKind = 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected';

export interface PipelineStage {
  id: string;
  name: string;
  kind: StageKind;
}

export const STAGE_KIND_LABEL: Record<StageKind, string> = {
  applied: 'درخواست تازه',
  screening: 'غربالگری',
  interview: 'مصاحبه',
  offer: 'پیشنهاد شغلی',
  hired: 'استخدام‌شده',
  rejected: 'رد‌شده',
};

/** The default board: the path almost every Iranian hiring team actually walks. */
export const DEFAULT_STAGES: PipelineStage[] = [
  { id: 'stage_applied', name: 'درخواست تازه', kind: 'applied' },
  { id: 'stage_screening', name: 'غربالگری', kind: 'screening' },
  { id: 'stage_interview', name: 'مصاحبه', kind: 'interview' },
  { id: 'stage_offer', name: 'پیشنهاد شغلی', kind: 'offer' },
  { id: 'stage_hired', name: 'استخدام‌شده', kind: 'hired' },
  { id: 'stage_rejected', name: 'کنار گذاشته‌شده', kind: 'rejected' },
];

/** Light card the board renders; the heavy résumé fields stay on the server. */
export interface PipelineCard {
  id: string;
  name: string;
  score: number;
  category: string;
  decisionStatus: string;
  novelty: string;
  stageId: string;
  hasEmail: boolean;
  engine: string | null;
  createdAtISO: string;
}

export interface PipelineColumn {
  stage: PipelineStage;
  cards: PipelineCard[];
}

export interface PipelineBoard {
  jobId: string;
  stages: PipelineStage[];
  columns: PipelineColumn[];
  total: number;
}

// ------------------------------------------------------------- scorecards ----

/** How strongly an interviewer backs the candidate. */
export type FeedbackRecommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no';

export const FEEDBACK_LABEL: Record<FeedbackRecommendation, string> = {
  strong_yes: 'کاملاً موافق',
  yes: 'موافق',
  no: 'مخالف',
  strong_no: 'کاملاً مخالف',
};

export interface ScorecardCriterion {
  criterionId: string;
  title: string;
  /** 1..5 — deliberately a small scale so reviewers actually finish it. */
  score: number;
  note: string;
}

/**
 * One interviewer's structured opinion on one candidate. Deliberately a separate
 * record from the AI screening: this is what humans decided, and the panel view
 * shows the two side by side instead of blending them into one number.
 */
export interface InterviewFeedback {
  id: string;
  interviewId: string | null;
  resumeId: string;
  jobId: string;
  reviewerId: string;
  reviewerName: string;
  recommendation: FeedbackRecommendation;
  criteria: ScorecardCriterion[];
  notes: string;
  atISO: string;
  atJalali: string;
}

export interface ScorecardSummary {
  count: number;
  /** Average of the 1..5 criterion scores across reviewers, 0 when none. */
  averageScore: number;
  byRecommendation: Record<FeedbackRecommendation, number>;
  feedback: InterviewFeedback[];
}

/**
 * «آزمون و ارزیابی» — the shape shared by the server, the public page the
 * candidate opens, and the panel inside the workspace.
 *
 * Two kinds of test live here:
 *   • `single` — a scenario with four answers, each carrying a score 0–10. The
 *     score is the *key* and never leaves the server before the answer.
 *   • `scale`  — a five-point statement ("کاملاً مخالفم" … "کاملاً موافقم") that
 *     feeds one behavioural dimension; a few are reverse-keyed.
 */
export type AssessmentKind = 'situational' | 'work-sample' | 'behavioral';

/** `strong` is not "hired"; it is only a reading of one test. */
export type AssessmentBand = 'strong' | 'medium' | 'review';

export type AssessmentStatus = 'sent' | 'started' | 'completed' | 'expired' | 'cancelled';

/** Where the numbers came from: this page, or an outside provider's API. */
export type AssessmentSource = 'hovida' | 'external';

export interface AssessmentOption {
  id: string;
  label: string;
}

/** The five labels of the agreement scale, from «کاملاً مخالفم» to «کاملاً موافقم». */
export interface AssessmentScalePoint {
  value: number;
  label: string;
}

export interface AssessmentQuestionPublic {
  id: string;
  type: 'single' | 'scale';
  text: string;
  hint?: string;
  options?: AssessmentOption[];
}

export interface AssessmentTemplateSummary {
  id: string;
  name: string;
  kind: AssessmentKind;
  summary: string;
  durationMinutes: number;
  questionCount: number;
  dimensions: string[];
  /** How to read the result — shown to HR, never to the candidate. */
  reading: string;
  /** True when the reading is a keyed total (score/100); false for profiles. */
  scored: boolean;
}

export interface PublicAssessment {
  orgName: string;
  candidateName: string | null;
  jobTitle: string | null;
  intro: string;
  durationMinutes: number;
  status: AssessmentStatus;
  expiresAtJalali: string;
  started: boolean;
  scale: AssessmentScalePoint[];
  questions: AssessmentQuestionPublic[];
  template: { id: string; name: string; kind: AssessmentKind };
}

export interface AssessmentDimensionScore {
  id: string;
  label: string;
  /** 0–100, rounded. */
  score: number;
}

export interface AssessmentInvite {
  id: string;
  resumeId: string;
  jobId: string | null;
  jobTitle: string | null;
  templateId: string;
  templateName: string;
  kind: AssessmentKind;
  candidateName: string | null;
  candidateEmail: string | null;
  status: AssessmentStatus;
  source: AssessmentSource;
  createdAtISO: string;
  sentAtISO: string | null;
  startedAtISO: string | null;
  completedAtISO: string | null;
  expiresAtISO: string;
  /** 0–100 for keyed tests; null for behavioural profiles. */
  score: number | null;
  band: AssessmentBand | null;
  dimensions: AssessmentDimensionScore[] | null;
  answeredCount: number;
  questionCount: number;
  note: string | null;
  /** The public link — only inside the workspace. */
  url?: string;
}

export interface AssessmentAnswerInput {
  questionId: string;
  /** `optionId` for a single-choice question, the 1–5 number for a scale. */
  value: string | number;
}

export const ASSESSMENT_KIND_LABEL: Record<AssessmentKind, string> = {
  situational: 'قضاوت موقعیتی',
  'work-sample': 'نمونه‌کار',
  behavioral: 'رفتار کاری',
};

export const ASSESSMENT_STATUS_LABEL: Record<AssessmentStatus, string> = {
  sent: 'فرستاده‌شده',
  started: 'در حال پاسخ',
  completed: 'تکمیل‌شده',
  expired: 'منقضی',
  cancelled: 'لغو‌شده',
};

export const ASSESSMENT_BAND_LABEL: Record<AssessmentBand, string> = {
  strong: 'هم‌راستا با نقش',
  medium: 'نیازمند بررسی',
  review: 'فاصلهٔ روشن با نقش',
};

/** The five agreement labels. Kept here so the page and the report agree. */
export const AGREEMENT_SCALE: AssessmentScalePoint[] = [
  { value: 1, label: 'کاملاً مخالفم' },
  { value: 2, label: 'مخالفم' },
  { value: 3, label: 'بی‌نظرم' },
  { value: 4, label: 'موافقم' },
  { value: 5, label: 'کاملاً موافقم' },
];

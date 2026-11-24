/**
 * «استعلام مرجع» — structured reference checks.
 *
 * The last honest question in a hiring process is usually the oldest one:
 * *«کسی که با این شخص کار کرده، چه می‌گوید؟»* Every serious ATS records that
 * answer somewhere; most record it as a free-text note typed by the recruiter
 * afterwards, which is exactly where bias and memory live.
 *
 * This module does it as a *structure*:
 *
 *   • **Consent first.** No letter leaves until the candidate has agreed, with
 *     the date and who recorded it. A reference call is personal data about a
 *     candidate and (often) about the referee; «we just called» is not a legal
 *     basis. Without consent the API refuses with a real error, not a warning.
 *   • **The referee answers, not the recruiter.** A token link, no account, six
 *     questions, three minutes. Their answers are visible to the hiring team
 *     only — never to the candidate, never to other referees.
 *   • **Phone calls are still allowed — and labelled.** Many Iranian referees
 *     prefer a call. HR can record what they heard, and the record says
 *     `source: 'phone'` and who typed it, so nobody later mistakes a
 *     recruiter's summary for a verbatim answer.
 *   • **Nothing is decided automatically.** The summary is an average and a list
 *     of words; it never moves a candidate's stage. A low score raises
 *     «نیازمند بررسی» and a human decides — the same rule as every other signal
 *     in this product.
 */
/** Who the referee was to the candidate — asked, not guessed. */
export type RefereeRelation = 'manager' | 'colleague' | 'subordinate' | 'client' | 'other';

export type RefereeStatus = 'pending' | 'sent' | 'opened' | 'completed' | 'declined' | 'expired';

/** A referee's answers: four 1–5 numbers and two pieces of text. */
export interface ReferenceAnswers {
  relationship: RefereeRelation | null;
  /** Free text, because «از ۱۳۹۹ تا ۱۴۰۱» cannot be a dropdown. */
  duration: string;
  performance: number | null;
  collaboration: number | null;
  reliability: number | null;
  wouldRehire: number | null;
  strengths: string;
  concerns: string;
}

export const EMPTY_ANSWERS: ReferenceAnswers = {
  relationship: null,
  duration: '',
  performance: null,
  collaboration: null,
  reliability: null,
  wouldRehire: null,
  strengths: '',
  concerns: '',
};

/** The three 1–5 dimensions, fixed so averages stay comparable across the team. */
export const REFERENCE_DIMENSIONS = [
  { id: 'performance', label: 'کیفیت کار', hint: 'کارش را درست و به‌موقع تحویل می‌داد؟' },
  { id: 'collaboration', label: 'کار تیمی', hint: 'همکاری با او راحت بود؟' },
  { id: 'reliability', label: 'تعهد و وقت‌شناسی', hint: 'می‌شد روی حرف و حضور او حساب کرد؟' },
] as const;

export const REHIRE_LABELS: Record<number, string> = {
  1: 'دوباره همکاری نمی‌کردم',
  2: 'با تردید',
  3: 'بی‌نظر',
  4: 'با خیال راحت',
  5: 'حتماً دوباره همکاری می‌کردم',
};

export const RELATION_LABEL: Record<RefereeRelation, string> = {
  manager: 'مدیر مستقیم',
  colleague: 'همکار',
  subordinate: 'زیردست',
  client: 'مشتری یا ذی‌نفع',
  other: 'دیگر',
};

export const STATUS_LABEL: Record<RefereeStatus, string> = {
  pending: 'در انتظار ارسال',
  sent: 'فرستاده شد',
  opened: 'باز شد، پاسخ نداده',
  completed: 'پاسخ داده شد',
  declined: 'عذر خواست',
  expired: 'منقضی شد',
};

/** The referee who answers, as stored. */
export interface Referee {
  id: string;
  name: string;
  title: string;
  company: string;
  email: string | null;
  phone: string | null;
  relation: RefereeRelation;
  status: RefereeStatus;
  /** `self` = the referee filled the form; `phone` = HR recorded a call. */
  source: 'self' | 'phone';
  recordedByName: string | null;
  answers: ReferenceAnswers;
  createdAtISO: string;
  sentAtISO: string | null;
  openedAtISO: string | null;
  completedAtISO: string | null;
  completedAtJalali: string | null;
  declinedAtISO: string | null;
  declinedReason: string | null;
  remindCount: number;
  expiresAtISO: string;
  /** Absolute link the workspace can copy and send by hand. */
  url?: string;
}

/** Consent + the referee list for one candidate. */
export interface ReferenceCase {
  resumeId: string;
  candidateName: string;
  jobTitle: string;
  /** Set only when the candidate agreed to reference contact. */
  consentAtISO: string | null;
  consentAtJalali: string | null;
  consentByName: string | null;
  consentNote: string;
  note: string;
  referees: Referee[];
  summary: ReferenceSummary;
}

export interface ReferenceSummary {
  invited: number;
  completed: number;
  declined: number;
  /** Average 1–5 per dimension; null when nothing is complete. */
  average: { performance: number | null; collaboration: number | null; reliability: number | null };
  wouldRehire: number | null;
  /** True when someone rated «دوباره همکاری نمی‌کردم» or «با تردید». */
  needsReview: boolean;
  /** One line a human reads before the numbers. */
  headline: string;
}

/** What the referee sees — no candidate contact details, no other referees. */
export interface PublicReference {
  org: { name: string };
  candidateName: string;
  jobTitle: string;
  refereeName: string;
  relation: RefereeRelation;
  status: RefereeStatus;
  dimensions: { id: string; label: string; hint: string }[];
  rehireLabels: Record<number, string>;
  completedAtJalali: string | null;
  expiresAtISO: string;
  /** The workspace's own words if it set any (branding terms). */
  terms?: { job?: string };
}

export interface ReferenceAnswerInput {
  relationship?: RefereeRelation;
  duration?: string;
  performance?: number;
  collaboration?: number;
  reliability?: number;
  wouldRehire?: number;
  strengths?: string;
  concerns?: string;
}

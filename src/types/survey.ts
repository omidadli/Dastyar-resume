/**
 * «تجربهٔ کارجو» — one short survey after an interview, a rejection or a hire.
 *
 * Two numbers matter and they are different:
 *   • **NPS** — «چقدر احتمال دارد این تجربه را به یک دوست معرفی کنید؟» ۰ تا ۱۰.
 *     Promoters ۹–۱۰، passives ۷–۸، detractors ۰–۶؛ NPS = ٪promoters − ٪detractors.
 *   • **three experience dimensions** (clarity, communication, respect) on ۱–۵,
 *     because NPS alone never says *what* to fix.
 *
 * The link is public and token-only, like the offer and scheduling pages.
 */

export type SurveyStage = 'after_apply' | 'after_interview' | 'after_rejection' | 'after_hire';

export type SurveyStatus = 'sent' | 'opened' | 'answered' | 'expired';

/** The three 1–5 questions, fixed so the numbers are comparable over time. */
export interface SurveyDimension {
  id: 'clarity' | 'speed' | 'respect';
  label: string;
  hint: string;
}

export const SURVEY_DIMENSIONS: SurveyDimension[] = [
  { id: 'clarity', label: 'روشن بودن مراحل', hint: 'می‌دانستید در هر مرحله چه انتظاری داشته باشید؟' },
  { id: 'speed', label: 'سرعت و اطلاع‌رسانی', hint: 'به‌موقع خبر دادیم و منتظر نماندید؟' },
  { id: 'respect', label: 'رفتار محترمانه', hint: 'در همهٔ تماس‌ها با شما محترمانه رفتار شد؟' },
];

export const SURVEY_STAGE_LABEL: Record<SurveyStage, string> = {
  after_apply: 'پس از ثبت درخواست',
  after_interview: 'پس از مصاحبه',
  after_rejection: 'پس از نتیجهٔ منفی',
  after_hire: 'پس از استخدام',
};

export interface SurveyAnswers {
  clarity: number | null;
  speed: number | null;
  respect: number | null;
}

/** An invitation as stored. `token` opens the public page. */
export interface SurveyInvite {
  id: string;
  jobId: string | null;
  jobTitle: string;
  resumeId: string | null;
  candidateName: string;
  candidateEmail: string | null;
  stage: SurveyStage;
  status: SurveyStatus;
  /** 0–10, or null until answered. */
  score: number | null;
  comment: string | null;
  answers: SurveyAnswers;
  createdAtISO: string;
  createdAtJalali: string;
  sentAtISO: string | null;
  sentAtJalali: string | null;
  sentByName: string | null;
  answeredAtISO: string | null;
  answeredAtJalali: string | null;
  /** Absolute link the workspace can also copy and send by hand. */
  url?: string;
}

/** What the candidate may see — no internal ids, no other candidates. */
export interface PublicSurvey {
  org: { name: string };
  candidateName: string;
  jobTitle: string;
  stage: SurveyStage;
  status: SurveyStatus;
  /** The question above the 0–10 row and the three dimensions. */
  prompt: string;
  dimensions: SurveyDimension[];
  /** Set once answered, so a second visit shows thanks instead of the form. */
  answeredAtJalali: string | null;
  expiresAtISO: string;
}

export interface SurveySubmitInput {
  score: number;
  comment?: string;
  answers?: Partial<SurveyAnswers>;
}

/** The «تجربهٔ کارجو» block of the reports page. */
export interface ExperienceReport {
  sent: number;
  opened: number;
  answered: number;
  /** answered / sent, 0–100, or null when nothing was sent. */
  responseRate: number | null;
  /** −100 … 100، یا null وقتی هنوز پاسخی نیست. */
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
  /** Average 1–5 per dimension; null when unanswered. */
  average: { clarity: number | null; speed: number | null; respect: number | null };
  /** Answers grouped by the point of the journey. */
  byStage: { stage: SurveyStage; label: string; sent: number; answered: number; nps: number | null }[];
  /** The newest free-text comments, for the person who has to act on them. */
  comments: { id: string; score: number; comment: string; atISO: string; atJalali: string; jobTitle: string; stage: SurveyStage }[];
}

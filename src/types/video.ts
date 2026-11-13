/**
 * «مصاحبهٔ ویدئویی» — one-way recorded answers, the thing HireVue, Willo and
 * Spark Hire sell.
 *
 * Why it exists in HOVIDA: a hiring manager in Tehran cannot always meet a
 * candidate in Shiraz before the first shortlist, and a recruiter cannot be on
 * every first call. A short recording does what a phone screen does, without a
 * meeting on the calendar — and it stays a *screening aid*: the score never
 * replaces the interview, and the candidate always sees the questions, the
 * time limit and how many takes they have before starting.
 */

/** One question the candidate answers on video. */
export interface VideoQuestion {
  id: string;
  text: string;
  /** Time limit for the answer, in seconds. */
  seconds: number;
}

/** Per-job settings. Saved on the job, not on the workspace. */
export interface VideoSettings {
  enabled: boolean;
  /** How many *extra* takes a candidate may record per question (0 = one take). */
  retakes: number;
  /** Days the link stays open. */
  ttlDays: number;
  /** A sentence from HR shown above the questions. */
  intro: string;
  questions: VideoQuestion[];
}

export type VideoStatus = 'invited' | 'recording' | 'submitted' | 'reviewed' | 'cancelled' | 'expired';

export const VIDEO_STATUS_LABEL: Record<VideoStatus, string> = {
  invited: 'دعوت‌شده',
  recording: 'در حال ضبط',
  submitted: 'ارسال‌شده',
  reviewed: 'بررسی‌شده',
  cancelled: 'لغوشده',
  expired: 'مهلت گذشته',
};

/** One recorded answer, as the workspace sees it (the file itself stays private). */
export interface VideoAnswer {
  questionId: string;
  questionText: string;
  durationMs: number;
  sizeBytes: number;
  /** `video/webm`, `video/mp4`, … — the browser picks it. */
  mimeType: string;
  recordedAtISO: string;
}

/** A workspace-facing invitation. */
export interface VideoInvite {
  id: string;
  jobId: string | null;
  jobTitle: string | null;
  resumeId: string | null;
  candidateName: string | null;
  candidateEmail: string | null;
  status: VideoStatus;
  createdAtISO: string;
  sentAtISO: string | null;
  expiresAtISO: string;
  submittedAtISO: string | null;
  questions: VideoQuestion[];
  answers: VideoAnswer[];
  /** 1–5, set by the reviewer. */
  rating: number | null;
  note: string | null;
  /** How many times HR opened the recording. */
  views: number;
  lastViewedAtISO: string | null;
  /** Public link the candidate opens. */
  url: string;
}

/** What the candidate's page is allowed to know. */
export interface PublicVideoInvite {
  orgName: string;
  candidateName: string | null;
  jobTitle: string | null;
  intro: string;
  status: VideoStatus;
  expiresAtJalali: string;
  retakes: number;
  questions: VideoQuestion[];
  /** Answers already uploaded for this link (question id → seconds). */
  recorded: Array<{ questionId: string; durationMs: number; takesLeft: number }>;
  canRecord: boolean;
}

/** The workspace list, with the jobs that have questions ready. */
export interface VideoOverview {
  invites: VideoInvite[];
  jobs: Array<{ id: string; roleTitle: string; enabled: boolean; questionCount: number }>;
  stats: { waiting: number; submitted: number; reviewed: number };
  mailbox: boolean;
}

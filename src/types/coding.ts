/**
 * «چالش کد» — a small, real programming task a candidate solves in the browser,
 * graded by running their code against tests.
 *
 * Why this exists at all: a work-sample test with five multiple-choice questions
 * measures reading, not programming. Every serious technical ATS runs the code.
 *
 * The rules that make it fair rather than a trap:
 *   • the visible examples are enough to understand the task — hidden tests only
 *     guard against hard-coding the examples;
 *   • the candidate runs their code as often as they like before submitting;
 *   • a submission is graded once and the result is final — no silent rescoring;
 *   • the failure message says *what* differed (expected vs. produced) for the
 *     visible cases, and only «پنهان» for the hidden ones, so the hidden tests
 *     cannot be reverse-engineered by submitting again.
 */

export type CodeLanguage = 'javascript';

export type CodeStatus = 'sent' | 'started' | 'submitted' | 'expired' | 'cancelled' | 'declined';

/** One test: arguments in, expected value out. */
export interface CodeTest {
  name: string;
  args: unknown[];
  expected: unknown;
  /** Hidden cases are never shown to the candidate — not even their input. */
  hidden?: boolean;
}

/** A challenge as the workspace sees it (full tests, reference solution). */
export interface CodeChallenge {
  id: string;
  title: string;
  /** One paragraph of context, in Persian, no riddles. */
  prompt: string;
  /** What the function should be called and return. */
  signature: string;
  starterCode: string;
  difficulty: 'easy' | 'medium' | 'hard';
  minutes: number;
  language: CodeLanguage;
  tests: CodeTest[];
  /** HR-only reading of what a good solution shows. */
  rubric: string;
  /** HR-only; never sent to the candidate. */
  referenceSolution: string;
}

export interface CodeChallengeSummary {
  id: string;
  title: string;
  difficulty: 'easy' | 'medium' | 'hard';
  minutes: number;
  language: CodeLanguage;
  signature: string;
  /** How many tests, and how many of them the candidate can see. */
  testCount: number;
  visibleCount: number;
  rubric: string;
}

/** What the candidate's page receives — no reference solution, no hidden inputs. */
export interface PublicCodeChallenge {
  org: { name: string };
  candidateName: string;
  jobTitle: string | null;
  status: CodeStatus;
  expiresAtISO: string;
  challenge: {
    id: string;
    title: string;
    prompt: string;
    signature: string;
    starterCode: string;
    difficulty: 'easy' | 'medium' | 'hard';
    minutes: number;
    language: CodeLanguage;
    /** Visible cases only: input + expected, so the task is unambiguous. */
    examples: { name: string; args: unknown[]; expected: unknown }[];
    hiddenCount: number;
  };
  /** Present once submitted: the final result, never editable. */
  result: CodeSubmissionResult | null;
}

export interface CodeCaseResult {
  name: string;
  passed: boolean;
  hidden: boolean;
  expected?: string;
  actual?: string;
  error?: string;
}

export interface CodeSubmissionResult {
  passed: number;
  total: number;
  /** 0–100, rounded; null when nothing could run at all. */
  score: number | null;
  ok: boolean;
  timedOut: boolean;
  error: string | null;
  cases: CodeCaseResult[];
  /** What the candidate printed, capped. */
  logs: string;
  submittedAtISO: string;
  submittedAtJalali: string;
  /** True when the platform killed the run (never a candidate-facing penalty). */
  killed: boolean;
  durationMs: number;
}

/** An invitation as stored, in the workspace's list. */
export interface CodeInvite {
  id: string;
  resumeId: string;
  jobId: string;
  jobTitle: string;
  candidateName: string;
  candidateEmail: string | null;
  challengeId: string;
  challengeTitle: string;
  status: CodeStatus;
  createdAtISO: string;
  createdAtJalali: string;
  sentAtISO: string | null;
  startedAtISO: string | null;
  submittedAtISO: string | null;
  submittedAtJalali: string | null;
  expiresAtISO: string;
  /** How many times the candidate pressed «اجرا» — a signal, not a penalty. */
  runCount: number;
  result: CodeSubmissionResult | null;
  url?: string;
}

export const CODE_STATUS_LABEL: Record<CodeStatus, string> = {
  sent: 'فرستاده شد',
  started: 'شروع شده',
  submitted: 'ارسال شد',
  expired: 'منقضی شد',
  cancelled: 'لغو شد',
  declined: 'نپذیرفت',
};

export const CODE_DIFFICULTY_LABEL = {
  easy: 'مقدماتی',
  medium: 'متوسط',
  hard: 'پیشرفته',
} as const;

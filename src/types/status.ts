/**
 * «پیگیری درخواست» — the page a candidate can open to see where they stand.
 *
 * Why it belongs in an ATS: after the first call, most candidates hear nothing
 * for two weeks and reasonably assume they were ignored. A token link that says
 * «در حال بررسی رزومه» removes that doubt without giving HR more work — and it
 * is written in the candidate's language, not the pipeline's.
 *
 * What it never shows: scores, notes, interviewer opinions, other candidates,
 * or the reason for a decision. A closed application says «بسته شد», not
 * «رد شد»، because a rejection reason is a conversation, not a status page.
 */

export type PublicStageState = 'received' | 'screening' | 'interview' | 'offer' | 'hired' | 'closed';

export const PUBLIC_STATE_LABEL: Record<PublicStageState, string> = {
  received: 'درخواست ثبت شد',
  screening: 'در حال بررسی',
  interview: 'مرحلهٔ مصاحبه',
  offer: 'پیشنهاد شغلی',
  hired: 'استخدام',
  closed: 'بسته شد',
};

/** The link HR holds: it can be copied, sent, and revoked. */
export interface StatusLink {
  id: string;
  resumeId: string;
  jobId: string | null;
  candidateName: string;
  jobTitle: string | null;
  /** Absolute URL of the public page. */
  url: string;
  createdAtISO: string;
  createdAtJalali: string;
  revokedAtISO: string | null;
  expiresAtISO: string;
  expiresAtJalali: string;
  views: number;
  lastViewedAtISO: string | null;
}

export interface PublicStatusStep {
  key: PublicStageState;
  label: string;
  state: 'done' | 'current' | 'upcoming';
}

/** What the candidate's browser receives — nothing else is on the wire. */
export interface PublicStatus {
  orgName: string;
  candidateName: string;
  jobTitle: string;
  state: PublicStageState;
  message: string;
  steps: PublicStatusStep[];
  updatedAtJalali: string;
  expiresAtJalali: string;
  /** The next interview, if one is booked and still ahead. */
  nextInterviewJalali: string | null;
  contactEmail: string | null;
}

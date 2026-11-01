/**
 * «لینک زمان‌بندی» — the candidate picks the interview slot instead of a chain of
 * e-mails. HR offers a few concrete times; the candidate chooses one on a public
 * page, and the same booking code that the Interview modal uses creates the
 * meeting, the calendar event and the invitation.
 *
 * A slot can be taken by one candidate only: two people cannot hold the same
 * hour with the same interviewer.
 */

export interface SchedulingSlot {
  /** ISO instant — the canonical key a booking uses. */
  startsAtISO: string;
  /** Tehran wall clock, as typed by HR. */
  date: string;
  time: string;
  /** Set once somebody has booked it. */
  takenBy: string | null;
  takenAtISO: string | null;
}

export interface SchedulingLink {
  id: string;
  jobId: string;
  jobTitle: string;
  resumeId: string;
  candidateName: string;
  candidateEmail: string | null;
  title: string;
  durationMin: number;
  notes: string;
  interviewerIds: string[];
  interviewerNames: string[];
  status: 'open' | 'booked' | 'cancelled';
  slots: SchedulingSlot[];
  /** The interview created when the candidate chose a slot. */
  interviewId: string | null;
  createdAtISO: string;
  createdAtJalali: string;
  expiresAtISO: string;
  /** Built on the server: the link the workspace sends. */
  url?: string;
}

/** What the candidate sees — no workspace internals, no other candidates. */
export interface PublicSchedulingLink {
  org: { name: string };
  candidateName: string;
  jobTitle: string;
  title: string;
  durationMin: number;
  notes: string;
  interviewerNames: string[];
  orgTimeNote: string;
  slots: { startsAtISO: string; date: string; time: string; taken: boolean }[];
  status: 'open' | 'booked' | 'cancelled';
  bookedAtJalali: string | null;
}

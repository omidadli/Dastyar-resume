// ================================================================
// HOVIDA — «معرفی همکار» و پاداش معرفی
// A colleague's referral is the cheapest hire a company makes, and the one
// every ATS forgets to pay for. These are the shapes the workspace sees.
// ================================================================

/** How far a referral got, as far as the reward is concerned. */
export type ReferralOutcome = 'submitted' | 'hired' | 'rejected' | 'closed';

/**
 * The money side. `pending` = the person was hired, HR has not confirmed the
 * payout yet; `approved` = confirmed and waiting to be paid; `paid` = done.
 * Nothing ever moves to `paid` without a human clicking it.
 */
export type ReferralRewardStatus = 'none' | 'pending' | 'approved' | 'paid' | 'void';

/** What has to happen before a reward is owed. */
export type ReferralTrigger = 'hire' | 'offer' | 'probation';

export interface ReferralProgram {
  enabled: boolean;
  /** Toman. Zero means «معرفی بدون پاداش نقدی» — the tracking still works. */
  rewardAmount: number;
  trigger: ReferralTrigger;
  /** The terms the colleague reads before sharing the link. */
  terms: string;
  /** Only members may refer (an outside link is not paid). */
  membersOnly: boolean;
}

export interface ReferralRow {
  id: string;
  orgId: string;
  jobId: string;
  jobTitle: string;
  resumeId: string;
  candidateName: string;
  /** The member who shared the link; null when the code was typed by hand. */
  referrerUserId: string | null;
  referrerName: string;
  code: string;
  outcome: ReferralOutcome;
  rewardAmount: number;
  rewardStatus: ReferralRewardStatus;
  submittedAtISO: string;
  submittedAtJalali: string;
  decidedAtISO: string | null;
  decidedAtJalali: string | null;
  decidedByName: string | null;
  paidAtISO: string | null;
  paidAtJalali: string | null;
  paidByName: string | null;
  /** «چطور با ما آشنا شدید؟» — what the candidate said. */
  heardFrom: string | null;
  note: string;
}

/** One member's share link and what it has produced so far. */
export interface MemberReferralLink {
  userId: string;
  name: string;
  email: string | null;
  code: string;
  /** Absolute link to the portal with the code attached. */
  link: string;
  total: number;
  hired: number;
  pendingAmount: number;
  approvedAmount: number;
  paidAmount: number;
}

export interface ReferralSummary {
  total: number;
  hired: number;
  pending: number;
  approved: number;
  paid: number;
  pendingAmount: number;
  approvedAmount: number;
  paidAmount: number;
}

export interface ReferralsPayload {
  program: ReferralProgram;
  items: ReferralRow[];
  members: MemberReferralLink[];
  summary: ReferralSummary;
  /** The public address of the portal (the link prefix). */
  portalUrl: string;
}

export interface ReferralProgramInput {
  enabled?: boolean;
  rewardAmount?: number;
  trigger?: ReferralTrigger;
  terms?: string;
  membersOnly?: boolean;
}

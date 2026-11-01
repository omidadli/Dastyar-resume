/**
 * «کارتابل تأیید» — one place that answers «منتظر من چه چیزی است؟».
 *
 * The product promises that nothing reaches a candidate without a human. That
 * promise is only believable if the human can see, in one screen, every decision
 * waiting on them: an offer stage, an automation proposal, a referral reward.
 */

export type InboxKind = 'offer' | 'automation' | 'referral';

export interface InboxItem {
  /** `offer:<id>`, `automation:<id>`, `referral:<id>` — stable for the row. */
  id: string;
  kind: InboxKind;
  title: string;
  /** One line of context: what exactly will happen if it is approved. */
  detail: string;
  candidateName: string;
  jobTitle: string | null;
  jobId: string | null;
  resumeId: string | null;
  waitingSinceISO: string;
  waitingSinceJalali: string;
  /** Who has to act, in words («نگار رضایی — مدیر فنی»). */
  waitingOn: string;
  /** True when that person is the signed-in user. */
  mine: boolean;
  /** False when the viewer can see the item but may not decide it. */
  canAct: boolean;
  /** Why the button is closed, when it is. */
  blockedReason: string | null;
  /** Where the decision is made, when that page is the honest place to make it. */
  href: string | null;
}

export interface InboxCounts {
  total: number;
  mine: number;
  offers: number;
  automation: number;
  referrals: number;
}

export interface InboxView {
  items: InboxItem[];
  counts: InboxCounts;
  /** Which queues exist in this workspace at all (an unused chain is not «empty»). */
  enabled: { offers: boolean; automation: boolean; referrals: boolean };
}

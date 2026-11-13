/**
 * «استعلام سوءپیشینه» — a criminal-record check, recorded honestly.
 *
 * What this module is, in one line: **a ledger for a check that happens
 * elsewhere.** No Iranian authority offers a public API for a criminal-record
 * certificate, and claiming a live connection would be a lie a customer would
 * discover at the worst moment. So HOVIDA records the truth instead:
 *
 *   • **Consent is a document, not a checkbox.** The candidate reads a notice
 *     (what is checked, why, who sees it, how long it is kept) and agrees — by
 *     opening a link, or by a signed form HR files. Nothing can be marked as
 *     requested before that, and the record names the person, the date and the
 *     method.
 *   • **The request is a fact with a reference number.** Which office, which
 *     date, which case number. A check stuck at «در انتظار» is a real state and
 *     is shown as one.
 *   • **The result is recorded, never computed.** `clear` / `record_found` /
 *     `inconclusive` is what the paper says. HOVIDA does not infer, score, or
 *     auto-reject: a finding goes to a human who writes a decision, and the
 *     decision needs a reason.
 *   • **Small circles.** Only admins see the verdict, the documents and the
 *     decision note; a member sees that a check is in progress and nothing more.
 *     Every action lands in the activity feed with a name.
 *
 * Iranian note kept deliberately neutral: which body issues the certificate and
 * which roles may lawfully require it is a legal question for the employer. The
 * module asks for the authority in the workspace's own words and never invents a
 * list.
 */

/** Where a check stands. Every step needs a fact; none is skipped. */
export type BackgroundStatus =
  /** Created; nothing has been said to the candidate yet. */
  | 'draft'
  /** The consent link has been sent (or a form handed over) and is waiting. */
  | 'consent_pending'
  /** The candidate agreed. */
  | 'consented'
  /** Handed to the office; a reference number exists. */
  | 'requested'
  /** The paper came back and was recorded. */
  | 'completed'
  /** The candidate refused. A refusal is never a negative signal by itself. */
  | 'declined'
  | 'cancelled';

/** What the certificate says, in the coarsest words that are still true. */
export type BackgroundVerdict = 'clear' | 'record_found' | 'inconclusive';

/** How consent was given. `portal` = the candidate's own click, the strongest. */
export type ConsentMethod = 'portal' | 'signed_form' | 'in_person';

/** The human decision after a result — never made by the software. */
export type BackgroundOutcome = 'proceed' | 'hold' | 'withdraw';

export interface BackgroundConsent {
  atISO: string;
  atJalali: string;
  method: ConsentMethod;
  /** The candidate typed their own name (portal) or the HR person filed the form. */
  byName: string;
  note: string;
  /** Version of the notice text the candidate agreed to. */
  noticeVersion: string;
  /** True when it came from the candidate's own link, false when HR recorded it. */
  selfGiven: boolean;
}

export interface BackgroundResult {
  verdict: BackgroundVerdict;
  /** Date on the certificate, not the day it was typed in. */
  issuedAtISO: string | null;
  issuedAtJalali: string | null;
  /** The office that issued it, if different from the requested authority. */
  issuedBy: string;
  note: string;
  recordedAtISO: string;
  recordedAtJalali: string;
  recordedByName: string;
}

export interface BackgroundDocument {
  id: string;
  fileName: string;
  size: number;
  mimeType: string;
  uploadedAtISO: string;
  uploadedAtJalali: string;
  uploadedByName: string;
}

export interface BackgroundDecision {
  outcome: BackgroundOutcome;
  note: string;
  byName: string;
  atISO: string;
  atJalali: string;
}

export interface BackgroundCheck {
  id: string;
  resumeId: string;
  candidateName: string | null;
  jobTitle: string | null;
  status: BackgroundStatus;
  /** The office the request went to, in the workspace's own words. */
  authority: string;
  /** Case/reference number the office gave. */
  reference: string;
  /** Why this check is proportionate for this role — written by a human. */
  purpose: string;
  consent: BackgroundConsent | null;
  requestedAtISO: string | null;
  requestedAtJalali: string | null;
  /** Set when the office promises an answer by a date (optional). */
  dueAtISO: string | null;
  dueAtJalali: string | null;
  result: BackgroundResult | null;
  documents: BackgroundDocument[];
  decision: BackgroundDecision | null;
  note: string;
  createdAtISO: string;
  createdAtJalali: string;
  createdByName: string | null;
  cancelledAtISO: string | null;
  declinedAtISO: string | null;
  declinedReason: string | null;
  /**
   * True when the viewer may not see the verdict, the documents or the decision.
   * The row still exists and says so — hiding the whole check would look like
   * nothing is happening.
   */
  restricted: boolean;
  /** Absolute consent link, only for people who may send it. */
  consentUrl?: string;
}

/** Everything the candidate panel needs in one read. */
export interface BackgroundPayload {
  check: BackgroundCheck | null;
  /** Printed on the candidate's page; also the text HR files on paper. */
  notice: string;
  noticeVersion: string;
  /** True when the current user is allowed to see verdicts and documents. */
  canManage: boolean;
  /** Every requirement the module enforces, stated where HR reads it. */
  rules: string[];
}

export interface BackgroundInput {
  authority?: string;
  purpose?: string;
  reference?: string;
  dueAtISO?: string | null;
  note?: string;
}

export interface BackgroundResultInput {
  verdict: BackgroundVerdict;
  issuedAtISO?: string | null;
  issuedBy?: string;
  note?: string;
}

export interface BackgroundDecisionInput {
  outcome: BackgroundOutcome;
  note: string;
}

/** What the candidate sees at `/background/<token>` — nothing about the verdict. */
export interface PublicBackgroundConsent {
  orgName: string;
  candidateName: string | null;
  jobTitle: string | null;
  authority: string;
  purpose: string;
  notice: string;
  noticeVersion: string;
  status: BackgroundStatus;
  /** Already agreed: the page reads as a receipt, not a form. */
  consentAtJalali: string | null;
  declinedAtJalali: string | null;
  contact: string;
  /** What the candidate may do now. */
  canConsent: boolean;
  canDecline: boolean;
}

export const BACKGROUND_STATUS_LABEL: Record<BackgroundStatus, string> = {
  draft: 'پیش‌نویس — هنوز رضایت گرفته نشده',
  consent_pending: 'در انتظار رضایت کارجو',
  consented: 'رضایت ثبت شد',
  requested: 'درخواست به مرجع داده شد',
  completed: 'نتیجه ثبت شد',
  declined: 'کارجو رضایت نداد',
  cancelled: 'لغو شد',
};

export const BACKGROUND_VERDICT_LABEL: Record<BackgroundVerdict, string> = {
  clear: 'پاک — سابقه‌ای اعلام نشده',
  record_found: 'سابقه اعلام شده',
  inconclusive: 'نیازمند بررسی — پاسخ روشن نبود',
};

export const CONSENT_METHOD_LABEL: Record<ConsentMethod, string> = {
  portal: 'لینک اختصاصی کارجو',
  signed_form: 'فرم امضاشده',
  in_person: 'حضوری، ثبت‌شده توسط منابع انسانی',
};

export const OUTCOME_LABEL: Record<BackgroundOutcome, string> = {
  proceed: 'ادامهٔ فرایند',
  hold: 'نگه‌داشتن تا بررسی بیشتر',
  withdraw: 'کنار گذاشتن این درخواست',
};

/** A refusal is not a red flag; this sentence goes next to the status everywhere. */
export const DECLINED_NOTE =
  'نپذیرفتن استعلام، به‌خودی‌خود نشانهٔ منفی نیست؛ تصمیم دربارهٔ ادامهٔ فرایند با انسان است و باید با سیاست سازمان سنجیده شود.';

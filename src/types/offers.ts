/**
 * «پیشنهاد شغلی» (offer) with an electronic signature.
 *
 * The offer is written inside the workspace, sent as a link on the workspace's
 * own mailbox, and the candidate accepts or declines it on a public page — with
 * their typed full name standing as the signature. Every step is on the
 * candidate's timeline, so nobody has to guess whether the offer was sent, seen
 * or accepted.
 */

export type OfferStatus = 'draft' | 'sent' | 'accepted' | 'declined' | 'cancelled';

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  draft: 'پیش‌نویس',
  sent: 'فرستاده‌شده',
  accepted: 'پذیرفته‌شده',
  declined: 'رد‌شده',
  cancelled: 'لغو‌شده',
};

export type SalaryPeriod = 'monthly' | 'annual';

export const SALARY_PERIOD_LABEL: Record<SalaryPeriod, string> = {
  monthly: 'ماهانه',
  annual: 'سالانه',
};

export interface OfferTerms {
  /** The job title written on the offer — may differ slightly from the advert. */
  title: string;
  /** Amount in Toman; null when the workspace prefers not to put a number. */
  salaryAmount: number | null;
  salaryPeriod: SalaryPeriod;
  /** What sits on top of the salary («بیمهٔ تکمیلی، پاداش عملکرد…»). */
  benefitsNote: string;
  /** Jalali start date, e.g. «۱۴۰۵/۰۹/۰۱». */
  startDate: string;
  location: string;
  /** «تمام‌وقت»، «پاره‌وقت»، «دورکاری» … free text, chosen from the job's type. */
  employmentType: string;
  probationMonths: number;
  /** Anything else that belongs on the paper («۴ روز دورکاری در هفته»). */
  notes: string;
}

export interface JobOffer {
  id: string;
  jobId: string;
  resumeId: string;
  candidateName: string;
  candidateEmail: string | null;
  jobTitle: string;
  departmentName: string;
  status: OfferStatus;
  terms: OfferTerms;
  /** The covering note that goes with the link. */
  message: string;
  createdByName: string;
  createdAtISO: string;
  createdAtJalali: string;
  sentAtISO: string | null;
  sentAtJalali: string | null;
  respondedAtISO: string | null;
  respondedAtJalali: string | null;
  /** Typed full name from the candidate — the signature. */
  signatureName: string | null;
  signatureNote: string | null;
  /** Absolute link the workspace can also copy and send by hand. */
  url?: string;
}

export interface PublicOffer {
  org: { name: string; about: string };
  candidateName: string;
  jobTitle: string;
  terms: OfferTerms;
  message: string;
  status: OfferStatus;
  sentAtJalali: string | null;
  respondedAtJalali: string | null;
  signatureName: string | null;
  signatureNote: string | null;
}

export interface OfferInput {
  jobId: string;
  resumeId: string;
  terms: OfferTerms;
  message: string;
}

export interface OfferDecisionInput {
  /** The candidate's typed full name — required to accept. */
  name?: string;
  note?: string;
}

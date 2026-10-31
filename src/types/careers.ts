// ================================================================
// HOVIDA — the public career portal («پورتال شغلی»)
// Only what a stranger outside the workspace is allowed to see.
// ================================================================
import type { EmploymentType } from './screening';

/** The languages the public portal can be read in. Persian is always available. */
export type PortalLang = 'fa' | 'en';
export const PORTAL_LANGS: PortalLang[] = ['fa', 'en'];

export interface PublicJobSummary {
  id: string;
  roleTitle: string;
  departmentName: string;
  location: string;
  employmentType: EmploymentType | null;
  seniority: string;
  summary: string;
  publishedAtJalali: string;
  /** «مهلت درخواست» as the recruiter typed it (۱۴۰۴/۰۸/۱۲), null = open-ended. */
  applyByJalali: string | null;
  /** True once that Tehran day is over: readable, but nothing can be submitted. */
  expired: boolean;
  /**
   * The English version, written (or approved) by the recruiter. Null means the
   * posting is Persian-only — the English portal then shows the original text and
   * says so, instead of pretending a machine translation is the employer's words.
   */
  titleEn: string | null;
}

export interface PublicOrg {
  name: string;
  about: string;
  slug: string;
}

/** Which languages this workspace publishes in, and which one a newcomer lands on. */
export interface PublicPortalLanguages {
  languages: PortalLang[];
  defaultLang: PortalLang;
  /** True when the workspace collects voluntary self-identification. */
  eeoEnabled: boolean;
}

export interface PublicCareersPage {
  org: PublicOrg;
  jobs: PublicJobSummary[];
  portal: PublicPortalLanguages;
}

export interface PublicJobDetail extends PublicJobSummary {
  description: string;
  /** The English body, if the recruiter wrote one. */
  descriptionEn: string | null;
  requirements: string[];
  /** The workspace's own knockout/bonus questions, if it wants them answered. */
  questions: Array<{ id: string; label: string; kind: 'knockout' | 'bonus'; type: string; options?: string[] }>;
}

/** What the apply form sends. The résumé may be a file or pasted text. */
export interface CareerApplicationInput {
  name: string;
  email: string;
  phone: string;
  city: string;
  message: string;
  fileName?: string;
  fileBase64?: string;
  text?: string;
  answers?: Record<string, string | string[] | boolean>;
  /** Explicit agreement to the workspace keeping the résumé for this opening. */
  consent: boolean;
  /** The colleague (or channel) that pointed the candidate here, if any. */
  ref?: string;
  /** «چطور با ما آشنا شدید؟» — the candidate's own answer. */
  heardFrom?: string;
  /** Voluntary self-identification; ignored unless the workspace enabled it. */
  eeo?: { gender?: string; ageBand?: string; disability?: string };
}

export interface CareerApplicationResult {
  applicationId: string;
  /** Persian sentence the public page shows; never claims an e-mail that was not sent. */
  message: string;
}

export interface CareerSettings {
  slug: string;
  about: string;
  /** Enabled languages (`fa` always) and the one the portal opens in. */
  languages: PortalLang[];
  defaultLang: PortalLang;
  /** Absolute URL a workspace can put on its website (built on the server). */
  url: string;
  publishedJobs: number;
  totalJobs: number;
}

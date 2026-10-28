// ================================================================
// HOVIDA — the public career portal («پورتال شغلی»)
// Only what a stranger outside the workspace is allowed to see.
// ================================================================
import type { EmploymentType } from './screening';

export interface PublicJobSummary {
  id: string;
  roleTitle: string;
  departmentName: string;
  location: string;
  employmentType: EmploymentType | null;
  seniority: string;
  summary: string;
  publishedAtJalali: string;
}

export interface PublicOrg {
  name: string;
  about: string;
  slug: string;
}

export interface PublicCareersPage {
  org: PublicOrg;
  jobs: PublicJobSummary[];
}

export interface PublicJobDetail extends PublicJobSummary {
  description: string;
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
}

export interface CareerApplicationResult {
  applicationId: string;
  /** Persian sentence the public page shows; never claims an e-mail that was not sent. */
  message: string;
}

export interface CareerSettings {
  slug: string;
  about: string;
  /** Absolute URL a workspace can put on its website (built on the server). */
  url: string;
  publishedJobs: number;
  totalJobs: number;
}

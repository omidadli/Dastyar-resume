/**
 * «کیت مصاحبه» — the shape of what the server sends to the interviewer.
 *
 * The kit is composed, not stored: the bank supplies the competency questions,
 * the job's own criteria decide which packs come in, and the candidate's résumé
 * (when one is chosen) adds the questions no generic bank can know.
 */

export interface KitQuestion {
  id: string;
  text: string;
  /** What a strong answer contains — the interviewer listens for these. */
  listen: string;
  /** A sign the answer is thin, or that the claim does not hold. */
  red: string;
  /** The job criterion this question probes, when it maps to one. */
  criterionId?: string | null;
  /** Where it came from: the curated bank, or this candidate's résumé. */
  source: 'bank' | 'resume' | 'criterion';
}

export interface KitSection {
  id: string;
  title: string;
  /** Why this section is in this interview. */
  why: string;
  minutes: number;
  questions: KitQuestion[];
}

export interface InterviewKit {
  jobId: string;
  roleTitle: string;
  departmentName: string;
  seniority: string | null;
  /** Suggested total, adding up the sections. */
  durationMin: number;
  /** How to run it: four lines, no theory. */
  howTo: string[];
  sections: KitSection[];
  /** The criteria being probed, in the job's own words. */
  criteria: Array<{ id: string; title: string; weight: number; mustHave: boolean }>;
  thresholds: { interview: number; review: number };
  candidate: { resumeId: string; label: string; score: number; category: string } | null;
  /** The last two minutes: what to tell the candidate, what to write down. */
  closing: string[];
  /** Which bank packs were matched, so the reader can see the reasoning. */
  matched: string[];
}

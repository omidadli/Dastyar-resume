/**
 * «خلاصهٔ جلسه» — the ten lines a hiring manager actually needs after a call.
 *
 * Why it exists: a 25-minute transcript is evidence, not a document anyone
 * re-reads. What the next person needs is what was said that matters, what is
 * still open, and what was promised — in the candidate's own words where
 * possible.
 *
 * The rule this module keeps: a summary never adds a fact that is not in the
 * transcript, and never turns into a decision. It is not a score, not a
 * recommendation, not a personality read. When no AI key is configured, the
 * same page still works: the local engine quotes and groups the transcript's
 * own sentences and is labelled as exactly that.
 */

export type SummarySource = 'ai' | 'local';

export const SUMMARY_SOURCE_LABEL: Record<SummarySource, string> = {
  ai: 'هوش مصنوعی',
  local: 'موتور محلی (بدون هوش مصنوعی)',
};

export interface MeetingSummary {
  id: string;
  transcriptId: string;
  resumeId: string;
  jobId: string | null;
  /** Copied from the transcript so the summary still means something if it is edited. */
  title: string;
  source: SummarySource;
  /** e.g. «Gemini · gemini-2.5-flash» or «موتور محلی». */
  engineLabel: string;
  headline: string;
  highlights: string[];
  /** Unresolved questions and hesitations — not weaknesses of the person. */
  concerns: string[];
  nextSteps: string[];
  /** Verbatim sentences, quoted from the transcript. */
  quotes: string[];
  sentenceCount: number;
  createdAtISO: string;
  createdByName: string | null;
}

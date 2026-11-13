/**
 * «رونویسی گفتار» — turning a phone screen, a voice note or a recorded video
 * answer into searchable text.
 *
 * Why it belongs in an ATS: the first interview is often a 20-minute call that
 * nobody wrote down. The transcript is evidence a colleague can read later, a
 * quote a hiring manager can put in a scorecard, and — with the candidate's
 * data removed — material for a proper «درخواست حذف داده».
 *
 * The rule the module keeps: a transcript is either produced by a configured
 * provider (and labelled with it) or written/uploaded by a person. Never a
 * guessed text presented as if someone had said it.
 */

export type TranscriptSource = 'audio' | 'manual' | 'subtitle';
export type TranscriptStatus = 'ready' | 'needs_text';
export type TranscriptLanguage = 'fa' | 'en' | 'unknown';

/** One subtitle/segment cue, in milliseconds. */
export interface TranscriptCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  id: string;
  resumeId: string;
  jobId: string | null;
  jobTitle: string | null;
  /** Set when the text came from a «مصاحبهٔ ویدئویی» answer. */
  videoInviteId: string | null;
  questionId: string | null;
  title: string;
  source: TranscriptSource;
  status: TranscriptStatus;
  language: TranscriptLanguage;
  /** Human-readable provider label, or «دستی» for typed text. */
  provider: string | null;
  text: string;
  /** Timed segments when they came from a subtitle file. */
  cues: TranscriptCue[] | null;
  durationSec: number | null;
  fileName: string | null;
  sizeBytes: number | null;
  createdAtISO: string;
  createdByName: string | null;
  /** Short-lived signed link to the original audio/video, when a file exists. */
  audioUrl: string | null;
}

export interface TranscriptStatusPayload {
  /** The AI layer's real state — the UI says «تنظیم نشده» instead of failing later. */
  aiReady: boolean;
  aiReason: string | null;
  /** True when the configured provider can actually read audio/video. */
  canTranscribe: boolean;
}

export const TRANSCRIPT_SOURCE_LABEL: Record<TranscriptSource, string> = {
  audio: 'فایل صوتی/تصویری',
  manual: 'متن دستی',
  subtitle: 'زیرنویس',
};

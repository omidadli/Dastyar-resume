/**
 * «رونویسی گفتار» — a call recording, a voice note or a recorded video answer
 * becomes text that a colleague can read, quote and search.
 *
 * Three doors, in this order of honesty:
 *   1. **auto** — only when a provider that can actually read audio is
 *      configured. The row carries the provider's name, so nobody mistakes a
 *      machine transcript for a person's notes.
 *   2. **subtitle** — an `.srt`/`.vtt` file is parsed here, locally, with its
 *      timings. No key, no vendor, works on any server.
 *   3. **manual** — HR types or pastes what was said.
 *
 * What it never does: invent a transcript. With AI off, the upload is kept and
 * the row says «متن لازم است» — it does not silently return an empty page.
 */
import crypto from 'crypto';
import * as db from './db';
import { storage, isSafeKey } from './storage';
import { AiUnavailableError, aiStatus, generate, runtimeConfig } from './ai/provider';
import { toPersianDigits } from '../src/utils/jalali';
import type { TranscriptCue, TranscriptLanguage, TranscriptSource } from '../src/types/transcript';
import type { ResumeRecord } from '../src/types/screening';

export class TranscriptError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'TRANSCRIPT_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const TRANSCRIPT_PREFIX = 'transcripts/';
/** A 40-minute call as MP3 is well under this; larger files are refused early. */
export const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const MAX_TEXT = 200_000;

const MIME_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

export function languageOf(text: string): TranscriptLanguage {
  if (/[\u0600-\u06FF]/.test(text)) return 'fa';
  if (/[A-Za-z]/.test(text)) return 'en';
  return 'unknown';
}

function stamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** «۰۰:۱۲» — what a reader wants next to a quote. */
export function cueLabel(cue: TranscriptCue): string {
  const fmt = (ms: number) => toPersianDigits(stamp(ms));
  return `${fmt(cue.startMs)} تا ${fmt(cue.endMs)}`;
}

function parseClock(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = m[3] === undefined ? null : Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  const total = c === null ? (a * 60 + b) * 1000 : ((a * 60 + b) * 60 + c) * 1000;
  return total + ms;
}

/**
 * SRT and WebVTT, with the timings kept. Anything that is not a subtitle file
 * is treated as plain text — including a `.txt` export from a phone.
 */
export function parseSubtitles(raw: string, fileName = ''): { cues: TranscriptCue[]; text: string } {
  const content = String(raw || '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  if (!content.trim()) return { cues: [], text: '' };
  const looksTimed = /-->/.test(content);
  if (!looksTimed) {
    const text = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_TEXT);
    return { cues: [], text };
  }

  const blocks = content.split(/\n{2,}/);
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    // A WebVTT header or a cue number may sit above the timing line.
    const timingIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingIndex < 0) continue;
    const [fromRaw, toRaw] = lines[timingIndex].split('-->');
    const startMs = parseClock(String(fromRaw || '').replace(/^.*\s/, (m) => m));
    const endRaw = String(toRaw || '').trim().split(/\s+/)[0];
    const endMs = parseClock(endRaw);
    if (startMs === null || endMs === null) continue;
    const text = lines
      .slice(timingIndex + 1)
      .join(' ')
      // karaoke tags (<c.colorE5E5E5>), italic markers and speaker dashes.
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .replace(/^\s*-\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({ startMs, endMs: Math.max(endMs, startMs), text });
  }

  // Overlapping/repeated cues (auto-captions do this) are merged.
  const merged: TranscriptCue[] = [];
  for (const cue of cues) {
    const last = merged[merged.length - 1];
    if (last && last.text === cue.text) {
      last.endMs = Math.max(last.endMs, cue.endMs);
      continue;
    }
    if (last && cue.startMs < last.endMs && last.text.endsWith(cue.text)) continue;
    merged.push({ ...cue });
  }
  const text = merged
    .map((c) => c.text)
    .join('\n')
    .slice(0, MAX_TEXT);
  return { cues: merged.slice(0, 2000), text };
}

/** The provider has to be able to read the media, not just chat about it. */
export function canTranscribeNow(): { ready: boolean; reason: string | null; label: string | null } {
  const status = aiStatus();
  if (!status.available) return { ready: false, reason: status.reason || 'هوش مصنوعی تنظیم نشده است.', label: null };
  const cfg = runtimeConfig();
  const gemini = cfg.entries.find((e) => e.provider === 'gemini');
  if (!gemini) {
    return {
      ready: false,
      reason: 'کلیدهای فعلی (OpenAI-compatible) صدای ضبط‌شده را نمی‌خوانند؛ برای رونویسی خودکار یک کلید Gemini لازم است. تا آن وقت از متن دستی یا فایل زیرنویس استفاده کنید.',
      label: null,
    };
  }
  return { ready: true, reason: null, label: `Gemini · ${gemini.model || 'gemini'}` };
}

const PROMPT = [
  'تو یک رونویس‌کنندهٔ دقیق گفتار هستی. فایل صوتی/تصویری پیوست را کلمه‌به‌کلمه رونویسی کن.',
  '',
  'قواعد قطعی:',
  '۱) فقط چیزی را بنویس که شنیده می‌شود. هیچ جملهٔ تازه نساز، خلاصه نکن و تفسیر نکن.',
  '۲) اگر گویندگان معلوم‌اند، هر تغییر گوینده را با «گوینده ۱:»، «گوینده ۲:» جدا کن؛ اگر معلوم نیست، پاراگراف‌های پشت‌سرهم بنویس.',
  '۳) بخش‌های نامفهوم را «[نامفهوم]» بنویس و حدس نزن.',
  '۴) اگر فایل صدا ندارد، فقط بنویس: [بدون صدا]',
  '۵) زبان اصلی گفتار را نگه دار؛ ترجمه نکن.',
  '۶) خروجی فقط متن رونویسی باشد — بدون مقدمه، بدون توضیح.',
].join('\n');

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

interface NewTranscriptInput {
  resumeId: string;
  title: string;
  source: TranscriptSource;
  status: 'ready' | 'needs_text';
  text: string;
  cues: TranscriptCue[] | null;
  provider: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  filePath: string | null;
  durationSec: number | null;
  videoInviteId?: string | null;
  questionId?: string | null;
}

function buildRow(orgId: string, rec: ResumeRecord, input: NewTranscriptInput, actorName: string | null): db.TranscriptRow {
  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  return {
    id: db.uid('trn'),
    orgId,
    resumeId: rec.id,
    jobId: rec.jobId || null,
    jobTitle: job?.roleTitle || null,
    videoInviteId: input.videoInviteId ?? null,
    questionId: input.questionId ?? null,
    title: input.title.slice(0, 120) || 'رونویسی گفتار',
    source: input.source,
    status: input.status,
    language: languageOf(input.text),
    provider: input.provider,
    text: input.text,
    cues: input.cues,
    durationSec: input.durationSec,
    fileName: input.fileName,
    sizeBytes: input.sizeBytes,
    createdAtISO: new Date().toISOString(),
    createdByName: actorName,
    filePath: input.filePath,
  };
}

function keyOf(row: Pick<db.TranscriptRow, 'orgId' | 'resumeId' | 'id'>, ext: string): string | null {
  const key = `${TRANSCRIPT_PREFIX}${row.orgId}/${row.resumeId}/${row.id}.${ext}`;
  return isSafeKey(key) ? key : null;
}

function saveFile(row: db.TranscriptRow, base64: string, mimeType: string): Promise<string | null> {
  const ext = MIME_EXT[mimeType];
  if (!ext) return Promise.resolve(null);
  const key = keyOf(row, ext);
  if (!key) return Promise.resolve(null);
  return storage()
    .put(key, Buffer.from(base64, 'base64'))
    .then(() => key)
    .catch(() => null);
}

/** Manual or pasted text — the path that works with no key at all. */
export function addManualText(
  orgId: string,
  rec: ResumeRecord,
  input: { text?: unknown; title?: unknown },
  actorName: string | null
): db.TranscriptRow {
  const text = trimText(input.text);
  if (text.length < 10) throw new TranscriptError('متن رونویسی خیلی کوتاه است.', 400, 'TEXT_TOO_SHORT');
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const row = buildRow(
    orgId,
    rec,
    {
      resumeId: rec.id,
      title: title || 'متن دستی گفت‌وگو',
      source: 'manual',
      status: 'ready',
      text,
      cues: null,
      provider: 'دستی',
      fileName: null,
      sizeBytes: null,
      filePath: null,
      durationSec: null,
    },
    actorName
  );
  db.saveTranscript(row);
  db.logActivity(orgId, null, 'transcript.added', `متن گفت‌وگو را برای «${rec.candidateName || 'کارجو'}» ثبت کرد`, {
    jobId: row.jobId,
    resumeId: rec.id,
  });
  return row;
}

/** An `.srt` / `.vtt` (or a `.txt`) file — parsed locally, timings kept. */
export function addSubtitle(
  orgId: string,
  rec: ResumeRecord,
  input: { content?: unknown; fileName?: unknown },
  actorName: string | null
): db.TranscriptRow {
  const content = typeof input.content === 'string' ? input.content.slice(0, 2_000_000) : '';
  const { cues, text } = parseSubtitles(content, typeof input.fileName === 'string' ? input.fileName : '');
  if (text.length < 10) throw new TranscriptError('از این فایل متنی استخراج نشد؛ فایل زیرنویس یا متن ساده بفرستید.', 400, 'NO_TEXT');
  const fileName = typeof input.fileName === 'string' ? input.fileName.slice(0, 160) : null;
  const row = buildRow(
    orgId,
    rec,
    {
      resumeId: rec.id,
      title: fileName ? `زیرنویس ${fileName}` : 'زیرنویس گفت‌وگو',
      source: 'subtitle',
      status: 'ready',
      text,
      cues: cues.length ? cues : null,
      provider: 'پردازش محلی',
      fileName,
      sizeBytes: content.length,
      filePath: null,
      durationSec: cues.length ? Math.round(cues[cues.length - 1].endMs / 1000) : null,
    },
    actorName
  );
  db.saveTranscript(row);
  db.logActivity(orgId, null, 'transcript.added', `زیرنویس گفت‌وگوی «${rec.candidateName || 'کارجو'}» را افزود`, {
    jobId: row.jobId,
    resumeId: rec.id,
  });
  return row;
}

export interface AudioUpload {
  fileName?: unknown;
  mimeType?: unknown;
  dataBase64?: unknown;
  durationSec?: unknown;
}

/**
 * An audio/video file. When a provider can read it, the transcript is ready in
 * one step; otherwise the file is kept, the row says «متن لازم است» and HR can
 * paste the text — no invented text, no lost upload.
 */
export async function addAudio(
  orgId: string,
  rec: ResumeRecord,
  input: AudioUpload,
  actorName: string | null
): Promise<{ row: db.TranscriptRow; note: string | null }> {
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType.split(';')[0].trim().toLowerCase() : '';
  if (!MIME_EXT[mimeType]) throw new TranscriptError('این نوع فایل پشتیبانی نمی‌شود؛ صدا یا ویدئوی معمول (mp3، m4a، wav، webm، mp4) بفرستید.', 400, 'BAD_MEDIA');
  const raw = typeof input.dataBase64 === 'string' ? input.dataBase64.replace(/^data:[^,]*,/, '') : '';
  const buf = Buffer.from(raw, 'base64');
  if (!buf.length) throw new TranscriptError('فایلی دریافت نشد.', 400, 'NO_DATA');
  if (buf.length > MAX_MEDIA_BYTES) throw new TranscriptError('حجم فایل بیش از ۴۰ مگابایت است؛ آن را کوتاه‌تر کنید.', 413, 'TOO_LARGE');

  const fileName = typeof input.fileName === 'string' ? input.fileName.slice(0, 160) : `صدا.${MIME_EXT[mimeType]}`;
  const durationRaw = Number(input.durationSec);
  const durationSec = Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : null;

  let row = buildRow(
    orgId,
    rec,
    {
      resumeId: rec.id,
      title: `رونویسی ${fileName}`,
      source: 'audio',
      status: 'needs_text',
      text: '',
      cues: null,
      provider: null,
      fileName,
      sizeBytes: buf.length,
      filePath: null,
      durationSec,
    },
    actorName
  );
  row.filePath = await saveFile(row, raw, mimeType);

  const capability = canTranscribeNow();
  if (!capability.ready) {
    db.saveTranscript(row);
    return {
      row,
      note: `فایل ذخیره شد. ${capability.reason} متن را خودتان بچسبانید یا فایل زیرنویس بفرستید.`,
    };
  }

  try {
    const text = trimText(
      await generate(PROMPT, {
        files: [{ mimeType, base64: raw, fileName }],
        json: false,
        depth: 'fast',
        purpose: 'transcribe',
      })
    );
    if (text.length < 5) throw new TranscriptError('متنی از این فایل به دست نیامد؛ شاید صدا ندارد.', 422, 'EMPTY_TRANSCRIPT');
    row = db.saveTranscript({ ...row, status: 'ready', text, provider: capability.label || 'هوش مصنوعی' });
    db.logActivity(orgId, null, 'transcript.added', `گفت‌وگوی «${rec.candidateName || 'کارجو'}» را رونویسی کرد`, {
      jobId: row.jobId,
      resumeId: rec.id,
    });
    return { row, note: null };
  } catch (err: any) {
    const reason =
      err instanceof AiUnavailableError
        ? 'سرویس هوش مصنوعی در دسترس نیست.'
        : String(err?.message || 'رونویسی خودکار انجام نشد.');
    db.saveTranscript(row);
    return { row, note: `فایل ذخیره شد، ولی رونویسی خودکار انجام نشد (${reason}). متن را دستی ثبت کنید.` };
  }
}

/** A recorded video-interview answer, transcribed by the configured provider. */
export async function addFromVideoAnswer(
  orgId: string,
  rec: ResumeRecord,
  invite: db.VideoInviteRow,
  questionId: string,
  actorName: string | null
): Promise<{ row: db.TranscriptRow; note: string | null }> {
  const answer = invite.answers.find((a) => a.questionId === questionId);
  if (!answer) throw new TranscriptError('این پاسخ ویدئویی پیدا نشد.', 404, 'ANSWER_NOT_FOUND');
  const { readAnswerFile } = await import('./video');
  const file = await readAnswerFile(invite, questionId);
  if (!file) throw new TranscriptError('فایل این پاسخ در دسترس نیست.', 404, 'ANSWER_FILE_MISSING');

  const capability = canTranscribeNow();
  let row = buildRow(
    orgId,
    rec,
    {
      resumeId: rec.id,
      title: `رونویسی پاسخ «${answer.questionText.slice(0, 60)}…»`,
      source: 'audio',
      status: 'needs_text',
      text: '',
      cues: null,
      provider: null,
      fileName: `پاسخ ${questionId}`,
      sizeBytes: file.buffer.length,
      filePath: null,
      durationSec: Math.round(answer.durationMs / 1000),
      videoInviteId: invite.id,
      questionId,
    },
    actorName
  );

  if (!capability.ready) {
    db.saveTranscript(row);
    return { row, note: capability.reason };
  }
  try {
    const text = trimText(
      await generate(PROMPT, {
        files: [{ mimeType: file.mimeType, base64: file.buffer.toString('base64'), fileName: `answer-${questionId}` }],
        json: false,
        depth: 'fast',
        purpose: 'transcribe',
      })
    );
    if (text.length < 3) throw new TranscriptError('در این پاسخ گفتاری شنیده نشد.', 422, 'EMPTY_TRANSCRIPT');
    row = db.saveTranscript({ ...row, status: 'ready', text, provider: capability.label || 'هوش مصنوعی' });
    db.logActivity(orgId, null, 'transcript.added', `پاسخ ویدئویی «${rec.candidateName || 'کارجو'}» را رونویسی کرد`, {
      jobId: row.jobId,
      resumeId: rec.id,
    });
    return { row, note: null };
  } catch (err: any) {
    db.saveTranscript(row);
    return { row, note: String(err?.message || 'رونویسی این پاسخ انجام نشد.') };
  }
}

/** HR pastes or corrects the text — the row then becomes readable. */
export function setText(
  orgId: string,
  id: string,
  input: { text?: unknown; title?: unknown },
  actorName: string | null
): db.TranscriptRow {
  const row = db.getTranscript(orgId, id);
  if (!row) throw new TranscriptError('این رونویسی پیدا نشد.', 404, 'NOT_FOUND');
  const text = trimText(input.text);
  if (text.length < 10) throw new TranscriptError('متن رونویسی خیلی کوتاه است.', 400, 'TEXT_TOO_SHORT');
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : row.title;
  const next = db.saveTranscript({
    ...row,
    text,
    title,
    status: 'ready',
    language: languageOf(text),
    // A hand-written correction is no longer «the provider's output».
    provider: row.source === 'manual' ? 'دستی' : 'دستی (بازبینی‌شده)',
    createdByName: row.createdByName || actorName,
  });
  db.logActivity(orgId, null, 'transcript.added', `متن رونویسی «${row.title}» را ویرایش کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

export async function remove(orgId: string, id: string, actorName: string | null): Promise<boolean> {
  const row = db.getTranscript(orgId, id);
  if (!row) return false;
  if (row.filePath) storage().delete(row.filePath).catch(() => {});
  // The summaries were derived from this text: they cannot outlive it.
  db.deleteSummariesOfTranscript(orgId, id);
  db.deleteTranscript(orgId, id);
  db.logActivity(orgId, null, 'transcript.added', `رونویسی «${row.title}» را پاک کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return true;
}

/** The original file, for a signed playback link. */
export async function readMedia(row: db.TranscriptRow): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!row.filePath) return null;
  const obj = await storage().get(row.filePath);
  if (!obj) return null;
  const ext = row.filePath.split('.').pop() || '';
  const entry = Object.entries(MIME_EXT).find(([, e]) => e === ext);
  return { buffer: obj.body, mimeType: entry?.[0] || 'application/octet-stream' };
}

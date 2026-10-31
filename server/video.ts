/**
 * «مصاحبهٔ ویدئویی» — one-way recorded answers.
 *
 * What this module guarantees:
 *   - **The candidate is never surprised.** The page opens with the questions,
 *     the seconds per answer and the number of takes; the same facts are in the
 *     e-mail. Recording starts only after a click.
 *   - **A take is replaceable only within the limit.** The server counts takes
 *     per question, so clearing localStorage or reopening the page does not buy
 *     a fourth attempt.
 *   - **The file never meets the browser unasked.** Answers live in object
 *     storage under `videos/<org>/<invite>/` and are streamed only to a signed-in
 *     member of the owning workspace.
 *   - **A recording is evidence, not a verdict.** Submitting only marks it ready;
 *     HR rates it after watching, and that rating is what travels with the
 *     candidate — the video never auto-rejects anyone.
 *   - **Blind screening wins.** While «غربالگری بی‌طرف» is on, a video cannot be
 *     requested at all — a face and a voice identify a person, so the honest
 *     answer is to say so instead of quietly leaking identity.
 */
import crypto from 'crypto';
import * as db from './db';
import { storage, isSafeKey } from './storage';
import { isEmailConfigured, sendMail, friendlySmtpError } from './mailer';
import { formatJalaliDate, toPersianDigits } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { PublicVideoInvite, VideoAnswer, VideoInvite, VideoQuestion, VideoSettings, VideoStatus } from '../src/types/video';

export class VideoError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'VIDEO_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const VIDEO_PREFIX = 'videos/';
/** 60 seconds of a phone camera is rarely over 8 MB; 40 MB is a hard ceiling. */
export const MAX_ANSWER_BYTES = 40 * 1024 * 1024;
const MIME_EXT: Record<string, string> = {
  'video/webm': 'webm',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/** Three questions that actually separate candidates, not three personality tests. */
export const DEFAULT_QUESTIONS: VideoQuestion[] = [
  { id: 'q1', text: 'خودتان را در ۹۰ ثانیه معرفی کنید و بگویید چرا این نقش را می‌خواهید.', seconds: 90 },
  { id: 'q2', text: 'یک کار مشخص که خودتان انجام دادید و به آن افتخار می‌کنید را توضیح دهید: مسئله چه بود، خودتان چه کردید و نتیجه چه شد؟', seconds: 120 },
  { id: 'q3', text: 'یک بار که با همکاری اختلاف داشتید را بگویید؛ چطور حلش کردید؟', seconds: 120 },
];

/** A starting point that fits the role — HR edits it freely. */
export function suggestedQuestions(jobTitle: string): VideoQuestion[] {
  const t = (jobTitle || '').toLowerCase();
  if (/فروش|sales|مذاکره|business development/.test(t)) {
    return [
      { id: 'q1', text: 'یک محصول یا خدمت را در ۹۰ ثانیه به کسی بفروشید که ادعا می‌کند به آن نیاز ندارد.', seconds: 90 },
      { id: 'q2', text: 'سخت‌ترین «نه»ای که در فروش شنیدید چه بود و بعدش چه کردید؟', seconds: 120 },
      { id: 'q3', text: 'قیمت محصول ما را چگونه برای مشتری توضیح می‌دهید؟', seconds: 90 },
    ];
  }
  if (/پشتیبان|support|خدمات مشتری|موفقیت مشتری/.test(t)) {
    return [
      { id: 'q1', text: 'یک مشتری عصبانی را تصور کنید که حق با او نیست؛ در ۹۰ ثانیه پاسخ شما چیست؟', seconds: 90 },
      { id: 'q2', text: 'یک مشکل تکراری را چطور ریشه‌ای حل کردید؟', seconds: 120 },
      { id: 'q3', text: 'آخرین چیزی که برای یادگیریِ کارتان انجام دادید چه بود؟', seconds: 90 },
    ];
  }
  if (/مهندس|توسعه|developer|engineer|برنامه‌نویس|داده/.test(t)) {
    return [
      { id: 'q1', text: 'یکی از کارهای فنی خودتان را در ۹۰ ثانیه طوری توضیح دهید که یک نفر غیرفنی بفهمد.', seconds: 90 },
      { id: 'q2', text: 'یک تصمیم فنی که بعداً پشیمان شدید را بگویید؛ چه چیزی یاد گرفتید؟', seconds: 120 },
      { id: 'q3', text: 'چطور بین سرعت تحویل و کیفیت تعادل برقرار می‌کنید؟ با یک مثال.', seconds: 120 },
    ];
  }
  return DEFAULT_QUESTIONS;
}

export function settingsOf(orgId: string, jobId: string): VideoSettings {
  const saved = db.getVideoSettings(orgId, jobId);
  if (saved) return saved;
  const job = db.getJob(orgId, jobId);
  return { enabled: false, retakes: 1, ttlDays: 7, intro: '', questions: suggestedQuestions(job?.roleTitle || '') };
}

export function normalizeQuestions(raw: unknown): VideoQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 8)
    .map((q: any, i: number) => {
      const text = typeof q?.text === 'string' ? q.text.trim().slice(0, 400) : '';
      const seconds = Math.round(Number(q?.seconds));
      return {
        id: typeof q?.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(q.id) ? q.id : `q${i + 1}`,
        text,
        seconds: Number.isFinite(seconds) ? Math.min(300, Math.max(30, seconds)) : 90,
      };
    })
    .filter((q) => q.text.length > 0);
}

export function saveSettings(
  orgId: string,
  jobId: string,
  input: { enabled?: unknown; retakes?: unknown; ttlDays?: unknown; intro?: unknown; questions?: unknown }
): VideoSettings {
  if (!db.getJob(orgId, jobId)) throw new VideoError('این فرصت شغلی پیدا نشد.', 404, 'JOB_NOT_FOUND');
  const before = settingsOf(orgId, jobId);
  const questions = input.questions === undefined ? before.questions : normalizeQuestions(input.questions);
  if (!questions.length) throw new VideoError('دست‌کم یک پرسش لازم است.', 400, 'NO_QUESTIONS');
  if (questions.length > 5) throw new VideoError('بیش از پنج پرسش، کارجو را خسته می‌کند؛ حداکثر پنج تا.', 400, 'TOO_MANY_QUESTIONS');
  const retakes = input.retakes === undefined ? before.retakes : Math.round(Number(input.retakes));
  const ttlDays = input.ttlDays === undefined ? before.ttlDays : Math.round(Number(input.ttlDays));
  return db.saveVideoSettings(orgId, jobId, {
    enabled: input.enabled === undefined ? before.enabled : Boolean(input.enabled),
    retakes: Number.isFinite(retakes) ? Math.min(3, Math.max(0, retakes)) : before.retakes,
    ttlDays: Number.isFinite(ttlDays) ? Math.min(30, Math.max(1, ttlDays)) : before.ttlDays,
    intro: typeof input.intro === 'string' ? input.intro.trim().slice(0, 600) : before.intro,
    questions,
  });
}

function expired(row: db.VideoInviteRow): boolean {
  return (
    (row.status === 'invited' || row.status === 'recording') && new Date(row.expiresAtISO).getTime() < Date.now()
  );
}

export function statusOf(row: db.VideoInviteRow): VideoStatus {
  return expired(row) ? 'expired' : row.status;
}

export function viewOf(row: db.VideoInviteRow, baseUrl: string): VideoInvite {
  const { orgId: _o, token, takes: _t, ...rest } = row;
  return { ...rest, status: statusOf(row), url: `${baseUrl.replace(/\/$/, '')}/video/${token}` };
}

/** The candidate's page: questions, limits, and what is already recorded. */
export function publicView(row: db.VideoInviteRow): PublicVideoInvite {
  const org = db.getOrg(row.orgId);
  const settings = row.jobId ? settingsOf(row.orgId, row.jobId) : null;
  const retakes = settings?.retakes ?? 1;
  const status = statusOf(row);
  return {
    orgName: org?.name || '',
    candidateName: row.candidateName,
    jobTitle: row.jobTitle,
    intro: settings?.intro || '',
    status,
    expiresAtJalali: formatJalaliDate(tehranJalaliOf(new Date(row.expiresAtISO)), true),
    retakes,
    questions: row.questions.map((q) => ({ id: q.id, text: q.text, seconds: q.seconds })),
    recorded: row.questions
      .map((q) => ({
        questionId: q.id,
        durationMs: row.answers.find((a) => a.questionId === q.id)?.durationMs || 0,
        takesLeft: Math.max(0, retakes + 1 - (row.takes[q.id] || 0)),
      }))
      .filter((r) => r.durationMs > 0),
    canRecord: status === 'invited' || status === 'recording',
  };
}

export interface CreateVideoInput {
  resumeId?: unknown;
  jobId?: unknown;
}

export function createInvite(orgId: string, actor: { id: string; name: string } | null, input: CreateVideoInput): db.VideoInviteRow {
  const resumeId = typeof input.resumeId === 'string' ? input.resumeId : '';
  const rec = resumeId ? db.getResume(orgId, resumeId) : null;
  if (!rec) throw new VideoError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');
  const jobId = (typeof input.jobId === 'string' && input.jobId) || rec.jobId || '';
  const job = jobId ? db.getJob(orgId, jobId) : null;
  if (!job) throw new VideoError('این کارجو به فرصت شغلی‌ای وصل نیست؛ اول فرصت را انتخاب کنید.', 400, 'JOB_REQUIRED');
  const settings = settingsOf(orgId, job.id);
  if (!settings.enabled) {
    throw new VideoError('پرسش‌های ویدئویی این فرصت شغلی روشن نیست؛ در همین صفحه روشنش کنید.', 409, 'VIDEO_DISABLED');
  }
  const open = db.videoInviteFor(orgId, rec.id);
  if (open && open.status !== 'submitted') {
    throw new VideoError('برای این کارجو یک دعوت باز وجود دارد؛ همان لینک را بفرستید.', 409, 'VIDEO_OPEN');
  }
  const stamp = new Date();
  const row: db.VideoInviteRow = {
    id: db.uid('vid'),
    orgId,
    token: crypto.randomBytes(18).toString('base64url'),
    resumeId: rec.id,
    jobId: job.id,
    jobTitle: job.roleTitle || null,
    candidateName: rec.candidateName || null,
    candidateEmail: rec.contact?.email?.toLowerCase() || null,
    status: 'invited',
    createdAtISO: stamp.toISOString(),
    sentAtISO: null,
    expiresAtISO: new Date(stamp.getTime() + settings.ttlDays * 86_400_000).toISOString(),
    submittedAtISO: null,
    questions: settings.questions,
    answers: [],
    takes: {},
    rating: null,
    note: null,
    views: 0,
    lastViewedAtISO: null,
  };
  db.saveVideoInvite(row);
  db.logActivity(orgId, actor, 'video.invited', `دعوت به مصاحبهٔ ویدئویی «${job.roleTitle}» را برای «${row.candidateName || 'کارجو'}» آماده کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return row;
}

export function invitationText(row: db.VideoInviteRow, orgName: string, url: string): { subject: string; body: string } {
  const total = row.questions.reduce((sum, q) => sum + q.seconds, 0);
  return {
    subject: `یک مصاحبهٔ ویدئویی کوتاه برای ${row.jobTitle ? `«${row.jobTitle}» — ` : ''}${orgName}`,
    body: [
      `${row.candidateName || 'سلام'} عزیز،`,
      '',
      `از اینکه برای ${row.jobTitle ? `نقش «${row.jobTitle}» در ` : ''}${orgName} درخواست دادید سپاسگزاریم.`,
      `به‌جای یک تماس تلفنی، ${toPersianDigits(row.questions.length)} پرسش کوتاه داریم که خودتان با ویدئو پاسخ می‌دهید —`,
      `در مجموع حدود ${toPersianDigits(Math.round(total / 60))} دقیقه. سؤال‌ها از قبل روی صفحه دیده می‌شوند و`,
      'برای هر سؤال یک بار (و در صورت نیاز یک بار دیگر) می‌توانید ضبط کنید.',
      '',
      'لینک مصاحبهٔ ویدئویی:',
      url,
      '',
      `این لینک تا ${formatJalaliDate(tehranJalaliOf(new Date(row.expiresAtISO)), true)} باز است.`,
      'با گوشی هم می‌شود؛ لازم نیست چیزی نصب کنید.',
      '',
      'با احترام،',
      orgName,
    ].join('\n'),
  };
}

export async function sendInvite(
  orgId: string,
  id: string,
  url: string,
  actor: { id: string; name: string } | null
): Promise<{ invite: db.VideoInviteRow; emailed: boolean }> {
  const row = db.getVideoInvite(orgId, id);
  if (!row) throw new VideoError('این دعوت پیدا نشد.', 404, 'VIDEO_NOT_FOUND');
  if (row.status === 'cancelled') throw new VideoError('این دعوت لغو شده است.', 409, 'CANCELLED');
  if (statusOf(row) === 'expired') throw new VideoError('مهلت این دعوت گذشته است؛ یک دعوت تازه بسازید.', 409, 'EXPIRED');
  if (!row.candidateEmail) throw new VideoError('برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'NO_EMAIL');
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new VideoError('ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  const org = db.getOrg(orgId);
  const { subject, body } = invitationText(row, org?.name || 'سازمان', url);
  try {
    await sendMail(secrets.email!, { to: row.candidateEmail, subject, text: body });
  } catch (err: any) {
    throw new VideoError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const next = db.saveVideoInvite({ ...row, sentAtISO: new Date().toISOString() });
  db.logActivity(orgId, actor, 'video.invited', `لینک مصاحبهٔ ویدئویی را برای «${row.candidateName || 'کارجو'}» فرستاد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return { invite: next, emailed: true };
}

/** The first open of the link, so HR can tell «فرستاده شد» from «باز شد». */
export function markOpened(row: db.VideoInviteRow): db.VideoInviteRow {
  if (row.status !== 'invited') return row;
  return db.saveVideoInvite({ ...row, status: 'recording' });
}

function keyOf(row: db.VideoInviteRow, questionId: string): string | null {
  const key = `${VIDEO_PREFIX}${row.orgId}/${row.id}/${questionId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  return isSafeKey(key) ? key : null;
}

export interface AnswerInput {
  questionId?: unknown;
  dataBase64?: unknown;
  mimeType?: unknown;
  durationMs?: unknown;
}

/** Stores one take. A newer take replaces the old file; the counter decides. */
export async function saveAnswer(
  row: db.VideoInviteRow,
  input: AnswerInput,
  limits: { retakes: number }
): Promise<db.VideoInviteRow> {
  const questionId = typeof input.questionId === 'string' ? input.questionId : '';
  const question = row.questions.find((q) => q.id === questionId);
  if (!question) throw new VideoError('این پرسش در این دعوت وجود ندارد.', 400, 'QUESTION_NOT_FOUND');
  if (!publicView(row).canRecord) throw new VideoError('این لینک دیگر برای ضبط باز نیست.', 409, 'CLOSED');

  // The format is checked before the take limit: a browser that cannot produce
  // a video should hear that, not «you are out of takes».
  const mime = typeof input.mimeType === 'string' ? input.mimeType.split(';')[0].trim() : '';
  const ext = MIME_EXT[mime];
  if (!ext) throw new VideoError('فرمت ویدئو پشتیبانی نمی‌شود؛ از مرورگر به‌روز استفاده کنید.', 400, 'BAD_MIME');

  const takes = row.takes[questionId] || 0;
  if (takes >= limits.retakes + 1) {
    throw new VideoError(`برای این پرسش ${toPersianDigits(limits.retakes + 1)} بار ضبط کرده‌اید و امکان ضبط دوباره نیست.`, 409, 'NO_TAKES_LEFT');
  }

  const raw = typeof input.dataBase64 === 'string' ? input.dataBase64 : '';
  const base64 = raw.replace(/^data:[^,]*,/, '');
  if (!base64) throw new VideoError('فایلی دریافت نشد.', 400, 'NO_DATA');
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw new VideoError('فایل خالی است.', 400, 'NO_DATA');
  if (buf.length > MAX_ANSWER_BYTES) throw new VideoError('حجم ویدئو بیش از حد مجاز است؛ کوتاه‌تر ضبط کنید.', 413, 'TOO_LARGE');

  const durationMs = Math.min(question.seconds * 1000 + 4000, Math.max(0, Math.round(Number(input.durationMs) || 0)));
  const key = keyOf(row, questionId);
  if (!key) throw new VideoError('شناسهٔ پرسش معتبر نیست.', 400, 'BAD_QUESTION_ID');
  await storage().put(`${key}.${ext}`, buf);

  // Remove a previous take with a different extension (webm → mp4 on Safari).
  for (const other of Object.values(MIME_EXT)) {
    if (other !== ext) storage().delete(`${key}.${other}`).catch(() => {});
  }

  const answer: VideoAnswer = {
    questionId,
    questionText: question.text,
    durationMs,
    sizeBytes: buf.length,
    mimeType: mime,
    recordedAtISO: new Date().toISOString(),
  };
  const answers = [...row.answers.filter((a) => a.questionId !== questionId), answer];
  return db.saveVideoInvite({
    ...row,
    answers,
    takes: { ...row.takes, [questionId]: takes + 1 },
    ...(row.status === 'invited' ? { status: 'recording' as VideoStatus } : {}),
  });
}

/** Submitting is final: the link turns into a thank-you screen. */
export function submit(row: db.VideoInviteRow): db.VideoInviteRow {
  if (row.status === 'submitted' || row.status === 'reviewed') {
    throw new VideoError('پاسخ‌های شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_SUBMITTED');
  }
  if (!publicView(row).canRecord) throw new VideoError('این لینک دیگر باز نیست؛ اگر لازم است با منابع انسانی تماس بگیرید.', 409, 'CLOSED');
  const missing = row.questions.filter((q) => !row.answers.some((a) => a.questionId === q.id));
  if (missing.length) {
    throw new VideoError(`هنوز ${toPersianDigits(missing.length)} پرسش بی‌پاسخ مانده است.`, 400, 'ANSWERS_INCOMPLETE');
  }
  const next = db.saveVideoInvite({ ...row, status: 'submitted', submittedAtISO: new Date().toISOString() });
  db.logActivity(row.orgId, null, 'video.submitted', `مصاحبهٔ ویدئویی «${row.jobTitle || ''}» را تکمیل کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

/** HR watches a recording. Counting views is honest: it is per workspace member. */
export function markViewed(row: db.VideoInviteRow): db.VideoInviteRow {
  return db.saveVideoInvite({ ...row, views: row.views + 1, lastViewedAtISO: new Date().toISOString() });
}

export function review(
  orgId: string,
  id: string,
  input: { rating?: unknown; note?: unknown },
  actor: { id: string; name: string } | null
): db.VideoInviteRow {
  const row = db.getVideoInvite(orgId, id);
  if (!row) throw new VideoError('این مصاحبه پیدا نشد.', 404, 'VIDEO_NOT_FOUND');
  if (row.status !== 'submitted' && row.status !== 'reviewed') {
    throw new VideoError('این مصاحبه هنوز ارسال نشده است.', 409, 'NOT_SUBMITTED');
  }
  const rating = input.rating === null || input.rating === undefined ? row.rating : Math.round(Number(input.rating));
  if (rating !== null && (!Number.isFinite(rating) || rating < 1 || rating > 5)) {
    throw new VideoError('امتیاز باید بین ۱ تا ۵ باشد.', 400, 'BAD_RATING');
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 800) : row.note;
  const next = db.saveVideoInvite({ ...row, rating, note, status: 'reviewed' });
  db.logActivity(orgId, actor, 'video.reviewed', `مصاحبهٔ ویدئویی «${row.candidateName || 'کارجو'}» را بررسی کرد${rating ? ` — ${toPersianDigits(rating)} از ۵` : ''}`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

export function cancel(orgId: string, id: string, actor: { id: string; name: string } | null): db.VideoInviteRow {
  const row = db.getVideoInvite(orgId, id);
  if (!row) throw new VideoError('این دعوت پیدا نشد.', 404, 'VIDEO_NOT_FOUND');
  if (row.status === 'submitted' || row.status === 'reviewed') {
    throw new VideoError('این مصاحبه پاسخ دارد؛ لغو نمی‌شود، فقط می‌توانید بایگانی‌اش کنید.', 409, 'HAS_ANSWERS');
  }
  const next = db.saveVideoInvite({ ...row, status: 'cancelled' });
  db.logActivity(orgId, actor, 'video.cancelled', `دعوت مصاحبهٔ ویدئویی «${row.candidateName || 'کارجو'}» را لغو کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

/** Deletes the invitation and every recorded file with it. */
export async function remove(orgId: string, id: string, actor: { id: string; name: string } | null): Promise<boolean> {
  const row = db.getVideoInvite(orgId, id);
  if (!row) return false;
  await storage()
    .deletePrefix(`${VIDEO_PREFIX}${orgId}/${id}/`)
    .catch(() => 0);
  db.deleteVideoInvite(orgId, id);
  db.logActivity(orgId, actor, 'video.cancelled', `مصاحبهٔ ویدئویی «${row.candidateName || 'کارجو'}» و فایل‌هایش را پاک کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return true;
}

/**
 * One answer, as bytes. Videos are small enough to serve from memory, which is
 * also what makes `Range` requests work — Safari refuses an MP4 it cannot seek.
 */
export async function readAnswerFile(
  row: db.VideoInviteRow,
  questionId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const answer = row.answers.find((a) => a.questionId === questionId);
  if (!answer) return null;
  const ext = MIME_EXT[answer.mimeType];
  if (!ext) return null;
  const key = keyOf(row, questionId);
  if (!key) return null;
  const obj = await storage().get(`${key}.${ext}`);
  if (!obj) return null;
  return { buffer: obj.body, mimeType: answer.mimeType };
}

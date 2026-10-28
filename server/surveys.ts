/**
 * «تجربهٔ کارجو» — the survey behind the NPS number.
 *
 * Rules that hold here:
 *   - **Nothing is sent without a click.** HR chooses the moment (after an
 *     interview, after a rejection, after a hire) and presses «ارسال نظرسنجی»;
 *     there is no silent auto-send. Without SMTP the link is still copied by
 *     hand and the UI says so instead of pretending it was e-mailed.
 *   - **One link, one answer.** The token opens a public page; after the answer
 *     the same link shows thanks, not the form again.
 *   - **The maths is the textbook one**: promoters ۹–۱۰, passives ۷–۸,
 *     detractors ۰–۶, NPS = %promoters − %detractors.
 */
import crypto from 'crypto';
import * as db from './db';
import { isEmailConfigured, sendMail, friendlySmtpError } from './mailer';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { SURVEY_DIMENSIONS, SURVEY_STAGE_LABEL } from '../src/types/survey';
import type { ExperienceReport, PublicSurvey, SurveyAnswers, SurveyStage, SurveyStatus } from '../src/types/survey';

export class SurveyError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'SURVEY_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const SURVEY_TTL_DAYS = 30;
const MAX_COMMENT = 1200;

export function stageLabel(stage: SurveyStage): string {
  return SURVEY_STAGE_LABEL[stage] || SURVEY_STAGE_LABEL.after_interview;
}

/** The one sentence above the 0–10 row, changed by the moment of the journey. */
function promptFor(stage: SurveyStage, orgName: string): string {
  switch (stage) {
    case 'after_rejection':
      return `چقدر احتمال دارد تجربهٔ خود از فرایند استخدام در «${orgName}» را به یک دوست معرفی کنید؟`;
    case 'after_hire':
      return `چقدر احتمال دارد «${orgName}» را به‌عنوان محل کار به یک دوست معرفی کنید؟`;
    case 'after_apply':
      return `چقدر احتمال دارد فرایند درخواست کار در «${orgName}» را به یک دوست معرفی کنید؟`;
    default:
      return `چقدر احتمال دارد تجربهٔ مصاحبه در «${orgName}» را به یک دوست معرفی کنید؟`;
  }
}

/** Overdue invitations are marked, never deleted — the response rate stays honest. */
export function expireOld(orgId: string): void {
  const now = Date.now();
  for (const row of db.listSurveys(orgId)) {
    if ((row.status === 'sent' || row.status === 'opened') && new Date(row.expiresAtISO).getTime() < now) {
      db.saveSurvey({ ...row, status: 'expired' });
    }
  }
}

export function publicView(row: db.SurveyInviteRow): PublicSurvey {
  const org = db.getOrg(row.orgId);
  const name = org?.name || '';
  const stale = (row.status === 'sent' || row.status === 'opened') && new Date(row.expiresAtISO).getTime() < Date.now();
  return {
    org: { name },
    candidateName: row.candidateName,
    jobTitle: row.jobTitle,
    stage: row.stage,
    status: stale ? 'expired' : row.status,
    prompt: promptFor(row.stage, name),
    dimensions: SURVEY_DIMENSIONS,
    answeredAtJalali: row.answeredAtJalali,
    expiresAtISO: row.expiresAtISO,
  };
}

export interface CreateSurveyInput {
  resumeId?: unknown;
  stage?: unknown;
  /** Set only when a survey is created for someone who is not a candidate row. */
  candidateName?: unknown;
  candidateEmail?: unknown;
  jobTitle?: unknown;
}

/**
 * Creates the invitation. Does **not** send anything: the caller decides that,
 * and the UI shows the link before the first e-mail leaves.
 */
export function createInvite(orgId: string, actor: { id: string; name: string } | null, input: CreateSurveyInput): db.SurveyInviteRow {
  const rec = typeof input.resumeId === 'string' ? db.getResume(orgId, input.resumeId) : null;
  if (input.resumeId && !rec) throw new SurveyError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');

  const stage: SurveyStage = (['after_apply', 'after_interview', 'after_rejection', 'after_hire'] as const).includes(input.stage as SurveyStage)
    ? (input.stage as SurveyStage)
    : 'after_interview';

  if (rec) {
    const open = db.openSurveyFor(orgId, rec.id);
    if (open && new Date(open.expiresAtISO).getTime() > Date.now()) {
      throw new SurveyError('برای این کارجو یک نظرسنجی باز وجود دارد؛ همان لینک را بفرستید یا لغو کنید.', 409, 'SURVEY_OPEN');
    }
  }

  const job = rec ? db.getJob(orgId, rec.jobId) : null;
  const candidateName = rec?.candidateName || (typeof input.candidateName === 'string' ? input.candidateName.trim().slice(0, 120) : '');
  if (!candidateName) throw new SurveyError('نام کارجو برای متن نظرسنجی لازم است.', 400, 'NAME_REQUIRED');

  const email = (rec?.contact?.email || (typeof input.candidateEmail === 'string' ? input.candidateEmail.trim() : '') || '').toLowerCase();
  const stamp = new Date();
  const row: db.SurveyInviteRow = {
    id: db.uid('srv'),
    orgId,
    token: crypto.randomBytes(18).toString('base64url'),
    jobId: rec?.jobId ?? null,
    jobTitle: job?.roleTitle || (typeof input.jobTitle === 'string' ? input.jobTitle.trim().slice(0, 160) : ''),
    resumeId: rec?.id ?? null,
    candidateName,
    candidateEmail: email || null,
    stage,
    status: 'sent',
    score: null,
    comment: null,
    answers: { clarity: null, speed: null, respect: null },
    createdAtISO: stamp.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    sentAtISO: null,
    sentAtJalali: null,
    sentByName: actor?.name ?? null,
    answeredAtISO: null,
    answeredAtJalali: null,
    expiresAtISO: new Date(stamp.getTime() + SURVEY_TTL_DAYS * 86_400_000).toISOString(),
  };
  db.saveSurvey(row);
  return row;
}

/** «نامهٔ نظرسنجی» — deliberately short, from the workspace's own mailbox. */
export function invitationText(row: db.SurveyInviteRow, orgName: string, url: string): { subject: string; body: string } {
  const subject = `نظر شما دربارهٔ فرایند استخدام — ${orgName}`;
  const body = [
    `${row.candidateName} عزیز، سلام`,
    '',
    `از زمانی که برای ${row.jobTitle ? `«${row.jobTitle}» در ` : ''}${orgName} گذاشتید سپاسگزاریم.`,
    'می‌خواهیم بدانیم این تجربه از نگاه شما چطور بود؛ سه سؤال کوتاه و یک امتیاز، کمتر از دو دقیقه.',
    '',
    `لینک نظرسنجی:`,
    url,
    '',
    'پاسخ شما فقط برای بهبود فرایند جذب استفاده می‌شود و به نتیجهٔ درخواست شما ارتباطی ندارد.',
    '',
    'با احترام،',
    orgName,
  ].join('\n');
  return { subject, body };
}

export interface SendResult {
  survey: db.SurveyInviteRow;
  /** Honest state: `true` only when the mail server accepted the message. */
  emailed: boolean;
  emailError: string | null;
}

/** Sends the link by e-mail — only when HR asked for exactly that. */
export async function sendInvite(orgId: string, id: string, url: string, actor: { id: string; name: string } | null): Promise<SendResult> {
  const row = db.getSurvey(orgId, id);
  if (!row) throw new SurveyError('نظرسنجی پیدا نشد.', 404, 'SURVEY_NOT_FOUND');
  if (row.status === 'answered') throw new SurveyError('این کارجو پیش‌تر پاسخ داده است.', 409, 'ALREADY_ANSWERED');
  if (!row.candidateEmail) throw new SurveyError('برای این کارجو ایمیل ثبت نشده است؛ لینک را دستی بفرستید.', 409, 'NO_EMAIL');
  const secrets = db.getOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new SurveyError('ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  const org = db.getOrg(orgId);
  const { subject, body } = invitationText(row, org?.name || 'سازمان', url);
  try {
    await sendMail(secrets.email!, { to: row.candidateEmail, subject, text: body });
  } catch (err: any) {
    throw new SurveyError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const stamp = new Date();
  const next = db.saveSurvey({
    ...row,
    status: row.status === 'expired' ? 'sent' : row.status,
    sentAtISO: stamp.toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    sentByName: actor?.name ?? row.sentByName,
  });
  db.logActivity(orgId, actor, 'survey.sent', `نظرسنجی تجربهٔ کارجو برای «${row.candidateName}» فرستاد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return { survey: next, emailed: true, emailError: null };
}

/** Marks that the candidate opened the page (once: the first visit only). */
export function markOpened(row: db.SurveyInviteRow): db.SurveyInviteRow {
  if (row.status !== 'sent') return row;
  return db.saveSurvey({ ...row, status: 'opened' as SurveyStatus });
}

export function submitAnswer(
  row: db.SurveyInviteRow,
  input: { score?: unknown; comment?: unknown; answers?: unknown }
): db.SurveyInviteRow {
  if (row.status === 'answered') throw new SurveyError('پاسخ شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_ANSWERED');
  if (new Date(row.expiresAtISO).getTime() < Date.now()) {
    throw new SurveyError('مهلت این نظرسنجی گذشته است؛ اما نظر شما برای ما ارزشمند است — با منابع انسانی تماس بگیرید.', 409, 'EXPIRED');
  }
  const score = Math.round(Number(input.score));
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    throw new SurveyError('امتیاز باید عددی بین ۰ تا ۱۰ باشد.', 400, 'INVALID_SCORE');
  }
  const rawAnswers = (input.answers && typeof input.answers === 'object' ? input.answers : {}) as Record<string, unknown>;
  const answers: SurveyAnswers = { clarity: null, speed: null, respect: null };
  for (const dim of SURVEY_DIMENSIONS) {
    const value = Math.round(Number(rawAnswers[dim.id]));
    // Optional on purpose: a candidate may answer the 0–10 and skip the rest.
    answers[dim.id] = Number.isFinite(value) && value >= 1 && value <= 5 ? value : null;
  }
  const comment = typeof input.comment === 'string' ? input.comment.trim().slice(0, MAX_COMMENT) : '';
  const stamp = new Date();
  const next = db.saveSurvey({
    ...row,
    status: 'answered',
    score,
    comment: comment || null,
    answers,
    answeredAtISO: stamp.toISOString(),
    answeredAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
  });
  db.logActivity(row.orgId, null, 'survey.answered', `«${row.candidateName}» به نظرسنجی تجربه پاسخ داد (امتیاز ${score} از ۱۰)`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

// ------------------------------------------------------------- reporting ----

export function bucketOf(score: number): 'promoter' | 'passive' | 'detractor' {
  if (score >= 9) return 'promoter';
  if (score >= 7) return 'passive';
  return 'detractor';
}

function npsOf(scores: number[]): number | null {
  if (!scores.length) return null;
  const promoters = scores.filter((s) => bucketOf(s) === 'promoter').length;
  const detractors = scores.filter((s) => bucketOf(s) === 'detractor').length;
  return Math.round(((promoters - detractors) / scores.length) * 100);
}

export function report(orgId: string, days: number | null = null): ExperienceReport {
  expireOld(orgId);
  const cutoff = days ? Date.now() - days * 86_400_000 : 0;
  const all = db.listSurveys(orgId).filter((s) => new Date(s.sentAtISO || s.createdAtISO).getTime() >= cutoff);
  const answered = all.filter((s) => s.status === 'answered' && typeof s.score === 'number');
  const scores = answered.map((s) => s.score as number);

  const avg = (pick: (s: db.SurveyInviteRow) => number | null) => {
    const values = answered.map(pick).filter((v): v is number => typeof v === 'number');
    return values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null;
  };

  const stages: SurveyStage[] = ['after_apply', 'after_interview', 'after_rejection', 'after_hire'];
  return {
    sent: all.length,
    opened: all.filter((s) => s.status === 'opened' || s.status === 'answered').length,
    answered: answered.length,
    responseRate: all.length ? Math.round((answered.length / all.length) * 100) : null,
    nps: npsOf(scores),
    promoters: scores.filter((s) => bucketOf(s) === 'promoter').length,
    passives: scores.filter((s) => bucketOf(s) === 'passive').length,
    detractors: scores.filter((s) => bucketOf(s) === 'detractor').length,
    average: { clarity: avg((s) => s.answers?.clarity ?? null), speed: avg((s) => s.answers?.speed ?? null), respect: avg((s) => s.answers?.respect ?? null) },
    byStage: stages.map((stage) => {
      const mine = all.filter((s) => s.stage === stage);
      const mineAnswered = mine.filter((s) => s.status === 'answered' && typeof s.score === 'number').map((s) => s.score as number);
      return { stage, label: stageLabel(stage), sent: mine.length, answered: mineAnswered.length, nps: npsOf(mineAnswered) };
    }),
    comments: answered
      .filter((s) => s.comment)
      .sort((a, b) => (b.answeredAtISO || '').localeCompare(a.answeredAtISO || ''))
      .slice(0, 12)
      .map((s) => ({
        id: s.id,
        score: s.score as number,
        comment: s.comment!,
        atISO: s.answeredAtISO || s.createdAtISO,
        atJalali: s.answeredAtJalali || s.createdAtJalali,
        jobTitle: s.jobTitle,
        stage: s.stage,
      })),
  };
}

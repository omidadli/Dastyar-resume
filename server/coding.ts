/**
 * «چالش کد» — the rules around the judge.
 *
 * The runner (code-runner.ts) can execute code; this decides *who may run what,
 * how often, and what the result means*. Two principles, same as everywhere else
 * in this product:
 *
 *   • **The candidate is never trapped.** Running is free and unlimited before
 *     submitting; the result is written once and cannot be edited afterwards.
 *   • **The machine does not decide.** The score is shown to HR as one number
 *     among the test results; nothing moves the candidate's stage.
 */
import crypto from 'crypto';
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { isEmailConfigured, friendlySmtpError, sendMail } from './mailer';
import { mailBrandOf } from './mail-brand';
import { noteEmailSend, withinEmailLimit } from './email-rate';
import { CHALLENGE_BANK, findChallenge, scoreOf } from './code-challenges';
import { runCode, type RunResult } from './code-runner';
import type { CodeCaseResult, CodeInvite, PublicCodeChallenge } from '../src/types/coding';

export const CODE_TTL_DAYS = 14;
/** Free runs before submitting — enough to experiment, not a harness to fuzz tests. */
export const MAX_RUNS = 20;

export class CodingError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'CODING_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jalali(iso: string | null): string | null {
  return iso ? formatJalaliDate(tehranJalaliOf(new Date(iso)), true) : null;
}

/** Only the cases the candidate may see — hidden inputs never leave the server. */
export function publicView(baseUrl: string, row: db.CodeInviteRow): PublicCodeChallenge {
  const challenge = findChallenge(row.challengeId);
  if (!challenge) throw new CodingError('این چالش پیدا نشد.', 404, 'CHALLENGE_NOT_FOUND');
  const org = db.getOrg(row.orgId);
  const stale =
    row.status !== 'submitted' && row.status !== 'cancelled' && row.status !== 'declined' && new Date(row.expiresAtISO).getTime() < Date.now();
  return {
    org: { name: org?.name || '' },
    candidateName: row.candidateName,
    jobTitle: row.jobTitle || null,
    status: stale ? 'expired' : row.status,
    expiresAtISO: row.expiresAtISO,
    challenge: {
      id: challenge.id,
      title: challenge.title,
      prompt: challenge.prompt,
      signature: challenge.signature,
      starterCode: challenge.starterCode,
      difficulty: challenge.difficulty,
      minutes: challenge.minutes,
      language: challenge.language,
      examples: challenge.tests.filter((t) => !t.hidden).map((t) => ({ name: t.name, args: t.args, expected: t.expected })),
      hiddenCount: challenge.tests.filter((t) => t.hidden).length,
    },
    result: row.result,
  };
}

/** The workspace's list shape: the shareable link, never the token itself. */
export function inviteView(baseUrl: string, row: db.CodeInviteRow): CodeInvite {
  return {
    id: row.id,
    resumeId: row.resumeId,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    candidateName: row.candidateName,
    candidateEmail: row.candidateEmail,
    challengeId: row.challengeId,
    challengeTitle: row.challengeTitle,
    status: row.status,
    createdAtISO: row.createdAtISO,
    createdAtJalali: jalali(row.createdAtISO) || '',
    sentAtISO: row.sentAtISO,
    startedAtISO: row.startedAtISO,
    submittedAtISO: row.submittedAtISO,
    submittedAtJalali: jalali(row.submittedAtISO),
    expiresAtISO: row.expiresAtISO,
    runCount: row.runCount,
    result: row.result,
    url: `${baseUrl.replace(/\/$/, '')}/code/${row.token}`,
  };
}

export function createInvite(
  orgId: string,
  actor: { id: string; name: string },
  input: { resumeId?: unknown; challengeId?: unknown }
): db.CodeInviteRow {
  const resumeId = String(input.resumeId || '');
  const challengeId = String(input.challengeId || '');
  const challenge = findChallenge(challengeId);
  if (!challenge) throw new CodingError('چالش انتخاب‌شده معتبر نیست.', 400, 'CHALLENGE_NOT_FOUND');
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new CodingError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  // One live invitation per candidate per challenge — no accidental double send.
  const live = db.listCodeInvites(orgId, { resumeId }).find((c) => c.challengeId === challengeId && (c.status === 'sent' || c.status === 'started'));
  if (live) throw new CodingError('برای این کارجو و همین چالش یک دعوت باز وجود دارد؛ همان لینک را بفرستید یا لغو کنید.', 409, 'INVITE_OPEN');
  const job = db.getJob(orgId, rec.jobId);
  const stamp = new Date();
  const row: db.CodeInviteRow = {
    id: db.uid('cod'),
    orgId,
    resumeId: rec.id,
    jobId: rec.jobId,
    jobTitle: job?.roleTitle || '',
    candidateName: rec.candidateName || 'کارجو',
    candidateEmail: (rec.contact?.email || '').toLowerCase() || null,
    challengeId: challenge.id,
    challengeTitle: challenge.title,
    status: 'sent',
    token: crypto.randomBytes(18).toString('base64url'),
    createdAtISO: stamp.toISOString(),
    sentAtISO: null,
    startedAtISO: null,
    submittedAtISO: null,
    expiresAtISO: new Date(stamp.getTime() + CODE_TTL_DAYS * 86_400_000).toISOString(),
    runCount: 0,
    result: null,
    sentByName: actor.name,
  };
  db.saveCodeInvite(row);
  return row;
}

export function invitationText(row: db.CodeInviteRow, orgName: string, url: string): { subject: string; body: string } {
  const challenge = findChallenge(row.challengeId);
  const minutes = challenge?.minutes ?? 15;
  return {
    subject: `یک تمرین کوتاه کدنویسی — ${orgName}`,
    body: [
      `${row.candidateName} عزیز،`,
      '',
      `برای آشنایی بهتر با شیوهٔ کار شما، یک تمرین کوتاه کدنویسی (حدود ${minutes} دقیقه) در نظر گرفته‌ایم: «${row.challengeTitle}».`,
      '',
      'میتوانید کد را هر چند بار که خواستید اجرا کنید و وقتی راضی بودید، آن را بفرستید؛ پس از ارسال، پاسخ نهایی است.',
      '',
      url,
      '',
      'نیازی به نصب چیزی نیست؛ همین صفحه در مرورگر کافی است. اگر این تمرین برایتان مناسب نیست، در همان صفحه اطلاع دهید.',
      '',
      'با احترام،',
      orgName,
    ].join('\n'),
  };
}

export async function sendInvite(orgId: string, id: string, baseUrl: string, actor: { id: string; name: string }): Promise<db.CodeInviteRow> {
  const row = db.getCodeInvite(orgId, id);
  if (!row) throw new CodingError('دعوت پیدا نشد.', 404, 'INVITE_NOT_FOUND');
  if (row.status === 'submitted') throw new CodingError('این چالش ارسال شده است.', 409, 'ALREADY_SUBMITTED');
  if (closed(row)) throw new CodingError('این دعوت بسته شده است؛ دعوت تازه بسازید.', 409, 'INVITE_CLOSED');
  if (!row.candidateEmail) throw new CodingError('برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و خودتان بفرستید.', 409, 'NO_EMAIL');
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) throw new CodingError('صندوق ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  if (!withinEmailLimit(orgId)) throw new CodingError('سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد دوباره تلاش کنید.', 429, 'EMAIL_LIMIT');
  const org = db.getOrg(orgId);
  const { subject, body } = invitationText(row, org?.name || 'سازمان', `${baseUrl.replace(/\/$/, '')}/code/${row.token}`);
  try {
    await sendMail(secrets.email!, { to: row.candidateEmail, subject, text: body, brand: mailBrandOf(org) });
    noteEmailSend(orgId);
  } catch (err: any) {
    throw new CodingError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const next = db.saveCodeInvite({ ...row, status: 'sent', sentAtISO: new Date().toISOString(), sentByName: actor.name });
  db.logActivity(orgId, actor, 'code.sent', `چالش کد «${row.challengeTitle}» برای «${row.candidateName}» فرستاده شد`, { resumeId: row.resumeId });
  return next;
}

function expired(row: db.CodeInviteRow): boolean {
  return row.status !== 'submitted' && new Date(row.expiresAtISO).getTime() < Date.now();
}

/** A link HR cancelled, or the candidate turned down, is closed for good. */
function closed(row: db.CodeInviteRow): boolean {
  return row.status === 'cancelled' || row.status === 'declined';
}

const CLOSED_MESSAGE = 'این تمرین بسته شده است؛ اگر لازم است، از تیم جذب بخواهید لینک تازه بفرستد.';

/**
 * A practice run: the visible cases only, no hidden ones, no result written.
 * Free, because experimenting is how people actually solve problems.
 */
export async function practiceRun(token: string, code: string, baseUrl: string): Promise<{ run: RunResult; publicChallenge: PublicCodeChallenge; runsLeft: number }> {
  const row = db.findCodeInviteByToken(token);
  if (!row) throw new CodingError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') throw new CodingError('پاسخ شما ثبت شده است؛ اجرای دوباره ممکن نیست.', 409, 'ALREADY_SUBMITTED');
  if (closed(row)) throw new CodingError(CLOSED_MESSAGE, 409, 'INVITE_CLOSED');
  if (expired(row)) throw new CodingError('مهلت این تمرین تمام شده است؛ از تیم جذب بخواهید دوباره بفرستد.', 409, 'EXPIRED');
  if (row.runCount >= MAX_RUNS) {
    throw new CodingError(`به سقف ${MAX_RUNS} اجرای آزمایشی رسیدید؛ می‌توانید پاسخ را بفرستید یا از تیم جذب بخواهید لینک تازه بفرستد.`, 429, 'RUN_LIMIT');
  }
  const challenge = findChallenge(row.challengeId);
  if (!challenge) throw new CodingError('این چالش پیدا نشد.', 404, 'CHALLENGE_NOT_FOUND');
  const visible = challenge.tests.filter((t) => !t.hidden);
  const run = await runCode(code, visible, { timeLimitMs: 5000 });
  const next = db.saveCodeInvite({
    ...row,
    status: row.status === 'sent' ? 'started' : row.status,
    startedAtISO: row.startedAtISO || new Date().toISOString(),
    runCount: row.runCount + 1,
  });
  return { run, publicChallenge: publicView(baseUrl, next), runsLeft: Math.max(0, MAX_RUNS - next.runCount) };
}

/**
 * The final submission: every case, graded once. Refuses a second attempt —
 * a candidate who could resubmit against feedback would reverse-engineer the
 * hidden tests instead of solving the problem.
 */
export async function submit(token: string, code: string, baseUrl: string): Promise<db.CodeInviteRow> {
  const row = db.findCodeInviteByToken(token);
  if (!row) throw new CodingError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') throw new CodingError('پاسخ شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_SUBMITTED');
  if (closed(row)) throw new CodingError(CLOSED_MESSAGE, 409, 'INVITE_CLOSED');
  if (expired(row)) throw new CodingError('مهلت این تمرین تمام شده است.', 409, 'EXPIRED');
  const challenge = findChallenge(row.challengeId);
  if (!challenge) throw new CodingError('این چالش پیدا نشد.', 404, 'CHALLENGE_NOT_FOUND');
  const source = String(code || '');
  if (source.trim().length < 10) throw new CodingError('کد خیلی کوتاه است؛ دست‌کم تابع solution را بنویسید.', 400, 'CODE_TOO_SHORT');
  if (source.length > 40_000) throw new CodingError('کد بیش از حد بلند است (حداکثر ۴۰٬۰۰۰ نویسه).', 400, 'CODE_TOO_LONG');

  const run = await runCode(source, challenge.tests, { timeLimitMs: 7000 });
  const cases: CodeCaseResult[] = run.outcomes.map((o) => ({
    name: o.name,
    passed: o.passed,
    hidden: o.hidden,
    // Hidden cases never reveal the input or the expected value.
    ...(o.hidden ? {} : { expected: o.expected, actual: o.actual }),
    error: o.hidden && o.error ? 'اجرا نشد.' : o.error,
  }));
  const stamp = new Date().toISOString();
  const next = db.saveCodeInvite({
    ...row,
    status: 'submitted',
    startedAtISO: row.startedAtISO || stamp,
    submittedAtISO: stamp,
    result: {
      passed: run.passed,
      total: run.total,
      score: scoreOf(run.passed, run.total),
      ok: run.ok,
      timedOut: run.timedOut,
      error: run.error,
      cases,
      logs: run.logs,
      submittedAtISO: stamp,
      submittedAtJalali: jalali(stamp) || '',
      killed: run.timedOut,
      durationMs: run.durationMs,
    },
  });
  db.logActivity(row.orgId, null, 'code.submitted', `«${row.candidateName}» چالش کد را فرستاد — ${run.passed} از ${run.total} تست`, {
    resumeId: row.resumeId,
  });
  return next;
}

/** HR cancelling an invitation: the link stops working immediately. */
export function cancel(orgId: string, id: string, actor: { id: string; name: string }): db.CodeInviteRow {
  const row = db.getCodeInvite(orgId, id);
  if (!row) throw new CodingError('دعوت پیدا نشد.', 404, 'INVITE_NOT_FOUND');
  if (row.status === 'submitted') throw new CodingError('این چالش ارسال شده است؛ لغو آن نتیجه را پاک نمی‌کند.', 409, 'ALREADY_SUBMITTED');
  const next = db.saveCodeInvite({ ...row, status: 'cancelled' });
  db.logActivity(orgId, actor, 'code.cancelled', `چالش کد «${row.challengeTitle}» لغو شد`, { resumeId: row.resumeId });
  return next;
}

export function inviteOf(orgId: string, id: string): db.CodeInviteRow {
  const row = db.getCodeInvite(orgId, id);
  if (!row) throw new CodingError('دعوت پیدا نشد.', 404, 'INVITE_NOT_FOUND');
  return row;
}

export { CHALLENGE_BANK };

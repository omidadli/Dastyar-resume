/**
 * «استعلام مرجع» — the rules behind structured reference checks.
 *
 * The storage lives in db.ts; every decision about *who may do what* lives here
 * so the routes stay thin and the same rules apply wherever the feature is used.
 */
import crypto from 'crypto';
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { isEmailConfigured, friendlySmtpError, sendMail } from './mailer';
import { mailBrandOf } from './mail-brand';
import { noteEmailSend, withinEmailLimit } from './email-rate';
import type { OrgBranding } from '../src/types/branding';
import {
  EMPTY_ANSWERS,
  REFERENCE_DIMENSIONS,
  REHIRE_LABELS,
  RELATION_LABEL,
  STATUS_LABEL,
  type PublicReference,
  type ReferenceAnswerInput,
  type ReferenceAnswers,
  type ReferenceCase,
  type ReferenceSummary,
  type Referee,
  type RefereeRelation,
  type RefereeStatus,
} from '../src/types/references';

export const REFERENCE_TTL_DAYS = 21;
/** A hiring team needs two or three voices; five is already plenty. */
export const MAX_REFEREES = 5;
const MAX_TEXT = 1200;

export class ReferenceError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'REFERENCE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jalaliNow(iso: string | null): string | null {
  return iso ? formatJalaliDate(tehranJalaliOf(new Date(iso)), true) : null;
}

/** A referee whose link ran out is «منقضی», never silently «در انتظار». */
export function expireOld(orgId: string): void {
  const now = Date.now();
  for (const row of db.listReferees(orgId)) {
    const live = row.status === 'sent' || row.status === 'opened' || row.status === 'pending';
    if (live && row.sentAtISO && new Date(row.expiresAtISO).getTime() < now) {
      db.saveReferee({ ...row, status: 'expired' });
    }
  }
}

function answersOf(row: db.RefereeRow): ReferenceAnswers {
  return { ...EMPTY_ANSWERS, ...(row.answers || {}) };
}

/** The workspace-facing shape. Tokens never leave the server; the URL does. */
export function viewOf(baseUrl: string, row: db.RefereeRow): Referee {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    company: row.company,
    email: row.email,
    phone: row.phone,
    relation: row.relation,
    status: row.status,
    source: row.source,
    recordedByName: row.recordedByName,
    answers: answersOf(row),
    createdAtISO: row.createdAtISO,
    sentAtISO: row.sentAtISO,
    openedAtISO: row.openedAtISO,
    completedAtISO: row.completedAtISO,
    completedAtJalali: jalaliNow(row.completedAtISO),
    declinedAtISO: row.declinedAtISO,
    declinedReason: row.declinedReason,
    remindCount: row.remindCount || 0,
    expiresAtISO: row.expiresAtISO,
    url: `${baseUrl.replace(/\/$/, '')}/reference/${row.token}`,
  };
}

/** The summary a human reads. Numbers, plus one sentence in plain Persian. */
export function summaryOf(rows: db.RefereeRow[]): ReferenceSummary {
  const done = rows.filter((r) => r.status === 'completed');
  const avg = (key: 'performance' | 'collaboration' | 'reliability'): number | null => {
    const values = done.map((r) => answersOf(r)[key]).filter((v): v is number => typeof v === 'number');
    if (!values.length) return null;
    return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
  };
  const rehireValues = done.map((r) => answersOf(r).wouldRehire).filter((v): v is number => typeof v === 'number');
  const wouldRehire = rehireValues.length ? Math.round((rehireValues.reduce((a, b) => a + b, 0) / rehireValues.length) * 10) / 10 : null;
  const declined = rows.filter((r) => r.status === 'declined').length;
  // «دوباره همکاری نمی‌کردم» or «با تردید» — a flag for a human, never a veto.
  const needsReview = rehireValues.some((v) => v <= 2);
  const headline = !done.length
    ? rows.length
      ? 'هنوز پاسخی نرسیده است.'
      : 'هنوز مرجعی اضافه نشده است.'
    : needsReview
      ? `${done.length.toLocaleString('fa-IR')} پاسخ ثبت شده و دست‌کم یکی از مراجع، همکاری دوباره را با تردید پاسخ داده؛ پیش از تصمیم، متن پاسخ‌ها را بخوانید.`
      : `${done.length.toLocaleString('fa-IR')} پاسخ ثبت شده؛ میانگین تمایل به همکاری دوباره ${wouldRehire?.toLocaleString('fa-IR') ?? '—'} از ۵.`;
  return {
    invited: rows.length,
    completed: done.length,
    declined,
    average: { performance: avg('performance'), collaboration: avg('collaboration'), reliability: avg('reliability') },
    wouldRehire,
    needsReview,
    headline,
  };
}

export function caseOf(baseUrl: string, orgId: string, resumeId: string): ReferenceCase {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new ReferenceError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  const c = db.getReferenceCase(orgId, resumeId);
  const rows = db.listReferees(orgId, { resumeId });
  const job = db.getJob(orgId, rec.jobId);
  return {
    resumeId,
    candidateName: rec.candidateName || 'کارجو',
    jobTitle: job?.roleTitle || '',
    consentAtISO: c?.consentAtISO ?? null,
    consentAtJalali: jalaliNow(c?.consentAtISO ?? null),
    consentByName: c?.consentByName || null,
    consentNote: c?.consentNote ?? '',
    note: c?.note ?? '',
    referees: rows.map((r) => viewOf(baseUrl, r)),
    summary: summaryOf(rows),
  };
}

/** Consent is a fact with a date and a name — not a checkbox somebody ticked once. */
export function recordConsent(orgId: string, resumeId: string, actor: { id: string; name: string }, note: string): db.ReferenceCaseRow {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new ReferenceError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  const existing = db.getReferenceCase(orgId, resumeId);
  const stamp = new Date().toISOString();
  const row: db.ReferenceCaseRow = {
    id: existing?.id || db.uid('rfc'),
    orgId,
    resumeId,
    consentAtISO: stamp,
    consentByName: actor.name,
    consentNote: String(note || '').trim().slice(0, 300),
    note: existing?.note || '',
    createdAtISO: existing?.createdAtISO || stamp,
    createdByName: existing?.createdByName || actor.name,
  };
  db.saveReferenceCase(row);
  db.logActivity(orgId, actor, 'reference.consent', `رضایت کارجو برای «استعلام مرجع» ثبت شد`, { resumeId });
  return row;
}

export interface AddRefereeInput {
  name?: unknown;
  title?: unknown;
  company?: unknown;
  email?: unknown;
  phone?: unknown;
  relation?: unknown;
}

export function addReferee(orgId: string, resumeId: string, actor: { id: string; name: string }, input: AddRefereeInput): db.RefereeRow {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new ReferenceError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  expireOld(orgId);
  const existing = db.listReferees(orgId, { resumeId });
  if (existing.length >= MAX_REFEREES) {
    throw new ReferenceError(`برای هر کارجو حداکثر ${MAX_REFEREES.toLocaleString('fa-IR')} مرجع ثبت می‌شود.`, 400, 'TOO_MANY_REFEREES');
  }
  const name = String(input.name || '').trim().slice(0, 120);
  if (name.length < 2) throw new ReferenceError('نام مرجع را کامل وارد کنید.', 400, 'NAME_REQUIRED');
  const email = String(input.email || '').trim().toLowerCase();
  const phone = String(input.phone || '').trim().slice(0, 40);
  if (email && !EMAIL_RE.test(email)) throw new ReferenceError('ایمیل مرجع معتبر نیست.', 400, 'BAD_EMAIL');
  // A referee with no address can still be called — but the form needs an
  // e-mail, so say plainly which channel will be used.
  if (!email && !phone) throw new ReferenceError('دست‌کم ایمیل یا شمارهٔ تماس مرجع را وارد کنید.', 400, 'CONTACT_REQUIRED');
  if (existing.some((r) => r.email && email && r.email === email)) {
    throw new ReferenceError('این مرجع قبلاً برای همین کارجو ثبت شده است.', 409, 'DUPLICATE_REFEREE');
  }
  const relation: RefereeRelation = (['manager', 'colleague', 'subordinate', 'client', 'other'] as const).includes(input.relation as RefereeRelation)
    ? (input.relation as RefereeRelation)
    : 'manager';
  const stamp = new Date();
  const caseRow = db.getReferenceCase(orgId, resumeId);
  const row: db.RefereeRow = {
    id: db.uid('ref'),
    orgId,
    caseId: caseRow?.id || '',
    resumeId,
    name,
    title: String(input.title || '').trim().slice(0, 120),
    company: String(input.company || '').trim().slice(0, 120),
    email: email || null,
    phone: phone || null,
    relation,
    status: 'pending',
    token: crypto.randomBytes(18).toString('base64url'),
    answers: { ...EMPTY_ANSWERS },
    source: 'self',
    recordedByName: null,
    createdAtISO: stamp.toISOString(),
    sentAtISO: null,
    openedAtISO: null,
    completedAtISO: null,
    declinedAtISO: null,
    declinedReason: null,
    remindCount: 0,
    expiresAtISO: new Date(stamp.getTime() + REFERENCE_TTL_DAYS * 86_400_000).toISOString(),
  };
  db.saveReferee(row);
  return row;
}

/** Edits are allowed while the referee has not answered — then a fact is a fact. */
export function updateReferee(orgId: string, id: string, input: AddRefereeInput, actor: { id: string; name: string }): db.RefereeRow {
  const row = db.getReferee(orgId, id);
  if (!row) throw new ReferenceError('مرجع پیدا نشد.', 404, 'REFEREE_NOT_FOUND');
  if (row.status === 'completed') throw new ReferenceError('این مرجع پاسخ داده است؛ ویرایش ممکن نیست.', 409, 'ALREADY_ANSWERED');
  const name = input.name === undefined ? row.name : String(input.name).trim().slice(0, 120);
  if (name.length < 2) throw new ReferenceError('نام مرجع را کامل وارد کنید.', 400, 'NAME_REQUIRED');
  const email = input.email === undefined ? row.email : String(input.email).trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new ReferenceError('ایمیل مرجع معتبر نیست.', 400, 'BAD_EMAIL');
  const phone = input.phone === undefined ? row.phone : String(input.phone).trim().slice(0, 40) || null;
  if (!email && !phone) throw new ReferenceError('دست‌کم ایمیل یا شمارهٔ تماس مرجع را وارد کنید.', 400, 'CONTACT_REQUIRED');
  const relation = (['manager', 'colleague', 'subordinate', 'client', 'other'] as const).includes(input.relation as RefereeRelation)
    ? (input.relation as RefereeRelation)
    : row.relation;
  return db.saveReferee({
    ...row,
    name,
    email,
    phone,
    relation,
    title: input.title === undefined ? row.title : String(input.title).trim().slice(0, 120),
    company: input.company === undefined ? row.company : String(input.company).trim().slice(0, 120),
    recordedByName: row.recordedByName,
    ...(actor ? {} : {}),
  });
}

export function removeReferee(orgId: string, id: string): void {
  const row = db.getReferee(orgId, id);
  if (!row) throw new ReferenceError('مرجع پیدا نشد.', 404, 'REFEREE_NOT_FOUND');
  db.deleteReferee(id);
}

/** The one sentence in the invitation that keeps a referee comfortable. */
export function invitationText(row: db.RefereeRow, orgName: string, candidateName: string, jobTitle: string, url: string): { subject: string; body: string } {
  const subject = `درخواست معرفی — ${candidateName}`;
  const body = [
    `${row.name} عزیز، سلام`,
    '',
    `${candidateName} شما را به‌عنوان مرجع (${RELATION_LABEL[row.relation]}) معرفی کرده است${jobTitle ? ` در فرایند استخدام «${jobTitle}»` : ''} در ${orgName}.`,
    'سه دقیقه وقت داریم؟ شش سؤال کوتاه دربارهٔ تجربهٔ همکاری با ایشان:',
    '',
    url,
    '',
    'پاسخ شما فقط برای تیم جذب این سازمان دیده می‌شود و به کارجو نشان داده نمی‌شود. اگر ترجیح می‌دهید پاسخ ندهید، همان صفحه دکمهٔ «عذر خواهی» دارد.',
    '',
    `با احترام،`,
    orgName,
  ].join('\n');
  return { subject, body };
}

export interface SendResult {
  referee: db.RefereeRow;
  emailed: boolean;
}

/** Sending is explicit, consented, and honest about what it could not do. */
export async function sendInvitation(
  orgId: string,
  id: string,
  baseUrl: string,
  actor: { id: string; name: string }
): Promise<SendResult> {
  const row = db.getReferee(orgId, id);
  if (!row) throw new ReferenceError('مرجع پیدا نشد.', 404, 'REFEREE_NOT_FOUND');
  if (row.status === 'completed') throw new ReferenceError('این مرجع پاسخ داده است.', 409, 'ALREADY_ANSWERED');
  if (row.status === 'declined') throw new ReferenceError('این مرجع عذر خواسته است؛ او را دوباره مزاحم نکنید.', 409, 'DECLINED');
  const consent = db.getReferenceCase(orgId, row.resumeId);
  if (!consent?.consentAtISO) {
    throw new ReferenceError(
      'پیش از تماس با مرجع، رضایت کارجو را ثبت کنید. یک مرجع، اطلاعات شخصی کارجوست و بدون رضایت فرستاده نمی‌شود.',
      409,
      'CONSENT_REQUIRED'
    );
  }
  if (!row.email) {
    throw new ReferenceError('این مرجع ایمیل ندارد؛ با او تماس بگیرید و پاسخ را از «ثبت پاسخ تلفنی» وارد کنید.', 409, 'NO_EMAIL');
  }
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new ReferenceError('صندوق ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  if (!withinEmailLimit(orgId)) throw new ReferenceError('سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد دوباره تلاش کنید.', 429, 'EMAIL_LIMIT');
  const rec = db.getResume(orgId, row.resumeId);
  const org = db.getOrg(orgId);
  const job = rec ? db.getJob(orgId, rec.jobId) : null;
  const { subject, body } = invitationText(row, org?.name || 'سازمان', rec?.candidateName || 'کارجو', job?.roleTitle || '', `${baseUrl.replace(/\/$/, '')}/reference/${row.token}`);
  try {
    await sendMail(secrets.email!, { to: row.email, subject, text: body, brand: mailBrandOf(org) });
    noteEmailSend(orgId);
  } catch (err: any) {
    throw new ReferenceError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const next = db.saveReferee({
    ...row,
    status: 'sent',
    sentAtISO: new Date().toISOString(),
    // A resend restarts the clock rather than reviving an expired token.
    expiresAtISO: new Date(Date.now() + REFERENCE_TTL_DAYS * 86_400_000).toISOString(),
  });
  db.logActivity(orgId, actor, 'reference.sent', `درخواست معرفی برای «${row.name}» فرستاده شد`, { resumeId: row.resumeId });
  return { referee: next, emailed: true };
}

/** One nudge, not a campaign: a referee is doing us a favour. */
export async function sendReminder(orgId: string, id: string, baseUrl: string, actor: { id: string; name: string }): Promise<SendResult> {
  const row = db.getReferee(orgId, id);
  if (!row) throw new ReferenceError('مرجع پیدا نشد.', 404, 'REFEREE_NOT_FOUND');
  if (row.status !== 'sent' && row.status !== 'opened') throw new ReferenceError('یادآوری فقط برای مرجعی است که هنوز پاسخ نداده.', 409, 'NOT_WAITING');
  if ((row.remindCount || 0) >= 1) throw new ReferenceError('یک یادآوری کافی است؛ دوباره فرستادن، مزاحمت است.', 409, 'ALREADY_REMINDED');
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets) || !row.email) throw new ReferenceError('ارسال ایمیل ممکن نیست؛ لینک را دستی بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  if (!withinEmailLimit(orgId)) throw new ReferenceError('سقف ارسال ساعتی این فضای کاری پر شده است.', 429, 'EMAIL_LIMIT');
  const rec = db.getResume(orgId, row.resumeId);
  const org = db.getOrg(orgId);
  const url = `${baseUrl.replace(/\/$/, '')}/reference/${row.token}`;
  try {
    await sendMail(secrets.email!, {
      to: row.email,
      subject: `یادآوری — درخواست معرفی ${rec?.candidateName || ''}`.trim(),
      text: [
        `${row.name} عزیز،`,
        '',
        `پیش‌تر دربارهٔ همکاری با ${rec?.candidateName || 'کارجو'} از شما نظر خواستیم. اگر فرصت داشتید، لینک زیر هنوز باز است:`,
        '',
        url,
        '',
        'اگر ترجیح می‌دهید پاسخ ندهید، همان صفحه دکمهٔ «عذر خواهی» دارد و دیگر پیگیری نمی‌کنیم.',
        '',
        org?.name || '',
      ].join('\n'),
      brand: mailBrandOf(org),
    });
    noteEmailSend(orgId);
  } catch (err: any) {
    throw new ReferenceError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const next = db.saveReferee({ ...row, remindCount: (row.remindCount || 0) + 1 });
  db.logActivity(orgId, actor, 'reference.reminded', `یادآوری برای مرجع «${row.name}» فرستاده شد`, { resumeId: row.resumeId });
  return { referee: next, emailed: true };
}

function clampScore(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n)));
}

function answersFrom(input: ReferenceAnswerInput): ReferenceAnswers {
  const relation = (['manager', 'colleague', 'subordinate', 'client', 'other'] as const).includes(input.relationship as RefereeRelation)
    ? (input.relationship as RefereeRelation)
    : null;
  return {
    relationship: relation,
    duration: String(input.duration || '').trim().slice(0, 120),
    performance: clampScore(input.performance),
    collaboration: clampScore(input.collaboration),
    reliability: clampScore(input.reliability),
    wouldRehire: clampScore(input.wouldRehire),
    strengths: String(input.strengths || '').trim().slice(0, MAX_TEXT),
    concerns: String(input.concerns || '').trim().slice(0, MAX_TEXT),
  };
}

/** HR typing what they heard on the phone. Always marked as such. */
export function recordByPhone(orgId: string, id: string, input: ReferenceAnswerInput, actor: { id: string; name: string }): db.RefereeRow {
  const row = db.getReferee(orgId, id);
  if (!row) throw new ReferenceError('مرجع پیدا نشد.', 404, 'REFEREE_NOT_FOUND');
  if (row.status === 'completed') throw new ReferenceError('این مرجع پاسخ داده است؛ اگر اصلاح لازم است، یک یادداشت روی کارجو بگذارید.', 409, 'ALREADY_ANSWERED');
  const consent = db.getReferenceCase(orgId, row.resumeId);
  if (!consent?.consentAtISO) {
    throw new ReferenceError('پیش از ثبت پاسخ تلفنی، رضایت کارجو را ثبت کنید.', 409, 'CONSENT_REQUIRED');
  }
  const answers = answersFrom(input);
  if (answers.wouldRehire === null) throw new ReferenceError('پرسش «همکاری دوباره» را پاسخ دهید تا خلاصه معنا داشته باشد.', 400, 'REHIRE_REQUIRED');
  const stamp = new Date().toISOString();
  const next = db.saveReferee({
    ...row,
    status: 'completed',
    source: 'phone',
    recordedByName: actor.name,
    answers,
    completedAtISO: stamp,
    openedAtISO: row.openedAtISO || stamp,
  });
  db.logActivity(orgId, actor, 'reference.recorded', `پاسخ تلفنی مرجع «${row.name}» ثبت شد`, { resumeId: row.resumeId });
  return next;
}

// ------------------------------------------------------------------ public --

export function publicView(row: db.RefereeRow): PublicReference {
  const org = db.getOrg(row.orgId);
  const rec = db.getResume(row.orgId, row.resumeId);
  const job = rec ? db.getJob(row.orgId, rec.jobId) : null;
  const stale = (row.status === 'sent' || row.status === 'opened') && new Date(row.expiresAtISO).getTime() < Date.now();
  const branding = org?.branding as OrgBranding | undefined;
  return {
    org: { name: org?.name || '' },
    candidateName: rec?.candidateName || '',
    jobTitle: job?.roleTitle || '',
    refereeName: row.name,
    relation: row.relation,
    status: (stale ? 'expired' : row.status) as RefereeStatus,
    dimensions: REFERENCE_DIMENSIONS.map((d) => ({ id: d.id, label: d.label, hint: d.hint })),
    rehireLabels: REHIRE_LABELS,
    completedAtJalali: jalaliNow(row.completedAtISO),
    expiresAtISO: row.expiresAtISO,
    terms: { job: branding?.terms?.job || 'فرصت شغلی' },
  };
}

export function markOpened(token: string): db.RefereeRow | null {
  const row = db.findRefereeByToken(token);
  if (!row) return null;
  if (row.status !== 'sent') return row;
  return db.saveReferee({ ...row, status: 'opened', openedAtISO: new Date().toISOString() });
}

/** One answer per referee: a second submit is refused, not merged. */
export function submitAnswer(token: string, input: ReferenceAnswerInput): db.RefereeRow {
  const row = db.findRefereeByToken(token);
  if (!row) throw new ReferenceError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'completed') throw new ReferenceError('پاسخ شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_ANSWERED');
  if (row.status === 'declined') throw new ReferenceError('پاسخ این لینک بسته شده است.', 409, 'DECLINED');
  if (new Date(row.expiresAtISO).getTime() < Date.now()) {
    throw new ReferenceError('این لینک منقضی شده است؛ از تیم جذب بخواهید دوباره بفرستد.', 409, 'EXPIRED');
  }
  const answers = answersFrom({ ...input, relationship: input.relationship || row.relation });
  if (answers.wouldRehire === null) throw new ReferenceError('لطفاً به پرسش «دوباره همکاری می‌کردید؟» پاسخ دهید.', 400, 'REHIRE_REQUIRED');
  const stamp = new Date().toISOString();
  const next = db.saveReferee({ ...row, status: 'completed', answers, completedAtISO: stamp, openedAtISO: row.openedAtISO || stamp });
  db.logActivity(row.orgId, null, 'reference.answered', `مرجع «${row.name}» پاسخ داد`, { resumeId: row.resumeId });
  return next;
}

/** Saying no is a complete answer: it stops every future reminder. */
export function decline(token: string, reason: string): db.RefereeRow {
  const row = db.findRefereeByToken(token);
  if (!row) throw new ReferenceError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'completed') throw new ReferenceError('پاسخ شما ثبت شده است.', 409, 'ALREADY_ANSWERED');
  const stamp = new Date().toISOString();
  const next = db.saveReferee({
    ...row,
    status: 'declined',
    declinedAtISO: stamp,
    declinedReason: String(reason || '').trim().slice(0, 300) || null,
  });
  db.logActivity(row.orgId, null, 'reference.declined', `مرجع «${row.name}» از پاسخ دادن عذر خواست`, { resumeId: row.resumeId });
  return next;
}

export { STATUS_LABEL, RELATION_LABEL };

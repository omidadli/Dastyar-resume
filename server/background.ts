/**
 * «استعلام سوءپیشینه» — a criminal-record check, recorded honestly.
 *
 * Rules this file exists to keep:
 *
 *   1. **No invented authority.** There is no API to a criminal-record office in
 *      Iran, and nothing here pretends otherwise: the check is a paper process
 *      that HOVIDA keeps a faithful ledger of. The office is typed by HR.
 *   2. **Consent gates the request.** `markRequested` refuses with
 *      `409 CONSENT_REQUIRED` until a consent record exists — either the
 *      candidate's own click on `/background/<token>` or a signed form HR filed
 *      with a name and a date. A refusal by the candidate closes the check and is
 *      explicitly *not* a negative signal.
 *   3. **The verdict is quoted, never computed.** `recordResult` stores what the
 *      certificate says. It changes no score, no stage and no decision.
 *   4. **A human decides, in writing.** `recordDecision` needs a reason of at
 *      least ten characters, whether the outcome is «ادامه» or «کنار گذاشتن».
 *   5. **Small circles.** Members see that a check exists and where it stands;
 *      only admins see the verdict, the documents and the decision note.
 *   6. **Deletion is real.** Documents live in the storage driver and are removed
 *      from disk, not just from the row; a candidate's erasure takes the check
 *      with it.
 */
import crypto from 'crypto';
import * as db from './db';
import { isEmailConfigured, sendMail, friendlySmtpError } from './mailer';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { isSafeKey, storage } from './storage';
import { hasRole } from './auth';
import type { Role } from '../src/types/app';
import { mailBrandOf } from './mail-brand';
import { DECLINED_NOTE } from '../src/types/background-check';
import type {
  BackgroundCheck,
  BackgroundDecisionInput,
  BackgroundDocument,
  BackgroundInput,
  BackgroundPayload,
  BackgroundResultInput,
  BackgroundStatus,
  BackgroundVerdict,
  ConsentMethod,
  PublicBackgroundConsent,
} from '../src/types/background-check';

export class BackgroundError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'BACKGROUND_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Bumping this makes old consents visibly old — the text they agreed to changes. */
export const NOTICE_VERSION = '1.0';
export const MIN_DECISION_NOTE = 10;
const MAX_DOC_BYTES = 8 * 1024 * 1024;
const DOC_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};
const DOC_EXT = Object.keys(DOC_MIME);

const OPEN_STATUSES: BackgroundStatus[] = ['draft', 'consent_pending', 'consented', 'requested'];

function jalali(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : formatJalaliDate(tehranJalaliOf(d), true);
}

function stampOf(d: Date): { iso: string; jalali: string } {
  return { iso: d.toISOString(), jalali: formatJalaliDate(tehranJalaliOf(d), true) };
}

/** The notice the candidate agrees to. Printed, mailed and filed as-is. */
export function noticeText(input: {
  orgName: string;
  candidateName: string | null;
  jobTitle: string | null;
  authority: string;
  purpose: string;
  contact: string;
}): string {
  const lines = [
    `اطلاعیهٔ استعلام سوءپیشینه — ${input.orgName}`,
    '',
    `${input.candidateName || 'کارجو'} عزیز،`,
    '',
    `برای ${input.jobTitle ? `نقش «${input.jobTitle}»` : 'این موقعیت'}، سازمان قصد دارد گواهی عدم سوءپیشینه را از «${input.authority || 'مرجع مربوط'}» درخواست کند.`,
    '',
    'چه چیزی بررسی می‌شود:',
    '  • فقط همان چیزی که گواهی رسمی اعلام می‌کند؛ نه پروندهٔ قضایی باز، نه اطلاعات دیگر.',
    '',
    'چرا:',
    `  ${input.purpose || 'این استعلام برای این نقش ضروری تشخیص داده شده است.'}`,
    '',
    'چه کسی می‌بیند:',
    '  • فقط مدیران همین فضای کاری در هویدا؛ همکاران دیگر تنها می‌بینند که «یک استعلام در جریان است».',
    '',
    'چقدر نگه داشته می‌شود:',
    '  • تصویر گواهی تا پایان فرایند استخدام و طبق سیاست نگه‌داری سازمان؛ پس از آن حذف می‌شود. می‌توانید هر زمان درخواست حذف کنید.',
    '',
    'حق شما:',
    '  • دادن یا ندادن رضایت، آزاد است. نپذیرفتن، به‌خودی‌خود نشانهٔ منفی نیست و تصمیم دربارهٔ ادامهٔ فرایند با انسان است.',
    '',
    `برای پرسش یا پس‌گرفتن رضایت: ${input.contact}`,
    '',
    `نسخهٔ اطلاعیه: ${NOTICE_VERSION}`,
  ];
  return lines.join('\n');
}

function contactOf(org: db.OrgRecord | null): string {
  const email = db.getOrgSecrets(org?.id || '');
  const address = email.email?.replyTo || email.email?.fromAddress || '';
  return address || 'واحد منابع انسانی سازمان';
}

function noticeOf(orgId: string, row: db.BackgroundCheckRow): string {
  const org = db.getOrg(orgId);
  return noticeText({
    orgName: org?.name || 'سازمان',
    candidateName: row.candidateName,
    jobTitle: row.jobTitle,
    authority: row.authority,
    purpose: row.purpose,
    contact: contactOf(org),
  });
}

/**
 * Who may see the paper. Uses the same ranking `requireRole` uses, so a
 * workspace owner is never locked out of the record they own, and a plain member
 * is never let in.
 */
function canSeePaper(role: string): boolean {
  return hasRole(role as Role, 'admin');
}

/** A member sees the process; an admin sees the paper. */
export function viewOf(orgId: string, row: db.BackgroundCheckRow, viewer: { role: string }, baseUrl: string): BackgroundCheck {
  const admin = canSeePaper(viewer.role);
  const { orgId: _o, token, ...rest } = row;
  const base: BackgroundCheck = {
    ...rest,
    documents: admin ? row.documents : [],
    result: admin ? row.result : null,
    decision: admin ? row.decision : null,
    declinedReason: admin ? row.declinedReason : null,
    consent: row.consent && !admin ? { ...row.consent, note: '' } : row.consent,
    restricted: !admin,
  };
  if (admin) base.consentUrl = `${baseUrl.replace(/\/$/, '')}/background/${token}`;
  return base;
}

export function payloadOf(
  orgId: string,
  resumeId: string,
  viewer: { role: string },
  baseUrl: string
): BackgroundPayload {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new BackgroundError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  const rows = db.listBackgroundChecks(orgId, { resumeId });
  const open = rows.find((r) => OPEN_STATUSES.includes(r.status)) || rows[0] || null;
  const org = db.getOrg(orgId);
  return {
    check: open ? viewOf(orgId, open, viewer, baseUrl) : null,
    notice: open
      ? noticeOf(orgId, open)
      : noticeText({
          orgName: org?.name || 'سازمان',
          candidateName: rec.candidateName,
          jobTitle: db.getJob(orgId, rec.jobId)?.roleTitle || null,
          authority: '',
          purpose: '',
          contact: contactOf(org),
        }),
    noticeVersion: NOTICE_VERSION,
    canManage: canSeePaper(viewer.role),
    rules: [
      'پیش از رضایت کارجو، درخواست به هیچ مرجعی ثبت نمی‌شود؛ دکمهٔ «ثبت درخواست» تا آن روز غیرفعال است.',
      'نتیجه همان چیزی است که گواهی می‌گوید — هویدا آن را محاسبه، امتیازدهی یا به تصمیم تبدیل نمی‌کند.',
      'نتیجهٔ گواهی فقط برای مدیران فضای کاری دیده می‌شود؛ اعضای دیگر وضعیت «در جریان» را می‌بینند.',
      'پس از هر نتیجه، یک انسان با دلیل نوشته‌شده تصمیم می‌گیرد؛ تصمیم خودکار وجود ندارد.',
      'نپذیرفتن استعلام از سوی کارجو، به‌خودی‌خود نشانهٔ منفی نیست.',
      'حذف تصویر گواهی، فایل را از فضای ذخیره‌سازی هم پاک می‌کند، نه فقط از صفحه.',
    ],
  };
}

export function createCheck(
  orgId: string,
  resumeId: string,
  actor: { id: string; name: string } | null,
  input: BackgroundInput
): db.BackgroundCheckRow {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new BackgroundError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  const existing = db.listBackgroundChecks(orgId, { resumeId });
  if (existing.some((r) => OPEN_STATUSES.includes(r.status))) {
    throw new BackgroundError('برای این کارجو یک استعلام باز وجود دارد؛ همان را ادامه بدهید یا لغو کنید.', 409, 'CHECK_OPEN');
  }
  const authority = typeof input.authority === 'string' ? input.authority.trim().slice(0, 120) : '';
  if (authority.length < 3) {
    throw new BackgroundError('نام مرجع صادرکنندهٔ گواهی را بنویسید (مثلاً «ادارهٔ تشخیص هویت»).', 400, 'AUTHORITY_REQUIRED');
  }
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim().slice(0, 400) : '';
  if (purpose.length < 15) {
    throw new BackgroundError('دلیل این استعلام برای این نقش را بنویسید (حداقل ۱۵ نویسه) — همین جمله به کارجو نشان داده می‌شود.', 400, 'PURPOSE_REQUIRED');
  }
  const job = db.getJob(orgId, rec.jobId);
  const stamp = new Date();
  const row: db.BackgroundCheckRow = {
    id: db.uid('bgc'),
    orgId,
    token: crypto.randomBytes(18).toString('base64url'),
    resumeId,
    candidateName: rec.candidateName || null,
    jobTitle: job?.roleTitle || null,
    status: 'draft',
    authority,
    purpose,
    reference: typeof input.reference === 'string' ? input.reference.trim().slice(0, 80) : '',
    consent: null,
    consentViewedAtISO: null,
    requestedAtISO: null,
    requestedAtJalali: null,
    dueAtISO: typeof input.dueAtISO === 'string' && input.dueAtISO ? input.dueAtISO : null,
    dueAtJalali: typeof input.dueAtISO === 'string' && input.dueAtISO ? jalali(input.dueAtISO) : null,
    result: null,
    documents: [],
    decision: null,
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 600) : '',
    createdAtISO: stamp.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    createdByName: actor?.name ?? null,
    updatedAtISO: stamp.toISOString(),
    updatedByName: actor?.name ?? null,
    cancelledAtISO: null,
    declinedAtISO: null,
    declinedReason: null,
  };
  db.saveBackgroundCheck(row);
  db.logActivity(orgId, actor, 'background.created', `استعلام سوءپیشینه برای «${row.candidateName || 'کارجو'}» را آغاز کرد`, {
    resumeId,
    jobId: rec.jobId,
  });
  return row;
}

export function getCheck(orgId: string, id: string): db.BackgroundCheckRow {
  const row = db.getBackgroundCheck(orgId, id);
  if (!row) throw new BackgroundError('این استعلام پیدا نشد.', 404, 'CHECK_NOT_FOUND');
  return row;
}

export function updateCheck(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: BackgroundInput
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  if (row.status !== 'draft' && row.status !== 'consent_pending') {
    throw new BackgroundError('پس از شروع استعلام، مرجع و دلیل تغییر نمی‌کند؛ استعلام تازه بسازید.', 409, 'NOT_EDITABLE');
  }
  const authority = typeof input.authority === 'string' ? input.authority.trim().slice(0, 120) : row.authority;
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim().slice(0, 400) : row.purpose;
  if (authority.length < 3) throw new BackgroundError('نام مرجع صادرکننده را بنویسید.', 400, 'AUTHORITY_REQUIRED');
  if (purpose.length < 15) throw new BackgroundError('دلیل استعلام را بنویسید (حداقل ۱۵ نویسه).', 400, 'PURPOSE_REQUIRED');
  const next = db.saveBackgroundCheck({
    ...row,
    authority,
    purpose,
    note: typeof input.note === 'string' ? input.note.trim().slice(0, 600) : row.note,
    dueAtISO: input.dueAtISO === undefined ? row.dueAtISO : input.dueAtISO || null,
    dueAtJalali: input.dueAtISO === undefined ? row.dueAtJalali : input.dueAtISO ? jalali(input.dueAtISO) : null,
    updatedAtISO: new Date().toISOString(),
    updatedByName: actor?.name ?? null,
  });
  db.logActivity(orgId, actor, 'background.created', `جزئیات استعلام سوءپیشینه «${row.candidateName || 'کارجو'}» را ویرایش کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

/** Mails the consent link. Without a mailbox it still returns the link to copy. */
export async function sendConsentLink(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  url: string
): Promise<{ check: db.BackgroundCheckRow; emailed: boolean; error: string | null }> {
  const row = getCheck(orgId, id);
  if (row.status === 'completed' || row.status === 'cancelled') {
    throw new BackgroundError('این استعلام بسته شده است.', 409, 'CHECK_CLOSED');
  }
  if (row.consent) throw new BackgroundError('کارجو پیش‌تر رضایت داده است؛ لینک رضایت دیگر لازم نیست.', 409, 'ALREADY_CONSENTED');
  const rec = db.getResume(orgId, row.resumeId);
  const email = rec?.contact?.email?.toLowerCase() || '';
  if (!email) {
    return { check: row, emailed: false, error: 'برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و از صندوق خودتان بفرستید.' };
  }
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    return { check: row, emailed: false, error: 'ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.' };
  }
  const org = db.getOrg(orgId);
  const subject = `درخواست رضایت برای استعلام سوءپیشینه — ${org?.name || 'سازمان'}`;
  const body = [
    `${row.candidateName || 'سلام'} عزیز،`,
    '',
    `سازمان «${org?.name || ''}» برای ${row.jobTitle ? `نقش «${row.jobTitle}»` : 'این موقعیت'} قصد دارد گواهی عدم سوءپیشینه را از «${row.authority}» درخواست کند.`,
    'پیش از هر اقدامی، متن اطلاعیه را بخوانید و اگر موافقید رضایت بدهید:',
    url,
    '',
    'دادن یا ندادن رضایت آزاد است؛ نپذیرفتن به‌خودی‌خود نشانهٔ منفی نیست.',
    'اگر رضایت بدهید، همین صفحه تاریخ رضایت شما را نشان می‌دهد.',
    '',
    'با احترام،',
    org?.name || 'سازمان',
  ].join('\n');
  try {
    await sendMail(secrets.email!, { to: email, subject, text: body, brand: mailBrandOf(org) });
  } catch (err: any) {
    return { check: row, emailed: false, error: friendlySmtpError(err) };
  }
  const next = db.saveBackgroundCheck({
    ...row,
    status: row.status === 'draft' ? 'consent_pending' : row.status,
    updatedAtISO: new Date().toISOString(),
    updatedByName: actor?.name ?? null,
  });
  db.saveEmail({
    id: db.uid('eml'),
    orgId,
    resumeId: row.resumeId,
    candidateName: row.candidateName,
    jobId: rec?.jobId || null,
    to: email,
    subject,
    body,
    status: 'sent',
    error: null,
    sentAtISO: new Date().toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(new Date()), true),
    sentByName: actor?.name || null,
    attachments: [],
  });
  db.logActivity(orgId, actor, 'background.consent', `لینک رضایت استعلام سوءپیشینه را برای «${row.candidateName || 'کارجو'}» فرستاد`, {
    resumeId: row.resumeId,
  });
  return { check: next, emailed: true, error: null };
}

function applyConsent(
  row: db.BackgroundCheckRow,
  method: ConsentMethod,
  byName: string,
  note: string,
  self: boolean
): db.BackgroundCheckRow {
  const stamp = stampOf(new Date());
  return db.saveBackgroundCheck({
    ...row,
    status: 'consented',
    consent: {
      atISO: stamp.iso,
      atJalali: stamp.jalali,
      method,
      byName: byName.slice(0, 80) || (self ? 'کارجو' : 'منابع انسانی'),
      note: note.slice(0, 300),
      noticeVersion: NOTICE_VERSION,
      selfGiven: self,
    },
    updatedAtISO: stamp.iso,
    updatedByName: byName.slice(0, 80) || null,
  });
}

/** HR files a signed form or a consent given in person. */
export function recordConsentByHr(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: { method?: unknown; note?: unknown }
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  if (row.consent) throw new BackgroundError('رضایت پیش‌تر ثبت شده است.', 409, 'ALREADY_CONSENTED');
  if (row.status === 'completed' || row.status === 'cancelled') throw new BackgroundError('این استعلام بسته شده است.', 409, 'CHECK_CLOSED');
  const method: ConsentMethod = input.method === 'signed_form' || input.method === 'in_person' ? input.method : 'signed_form';
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < 5) {
    throw new BackgroundError('بنویسید رضایت چگونه گرفته شد (تاریخ فرم، شمارهٔ نامه یا نام شاهد).', 400, 'NOTE_REQUIRED');
  }
  const next = applyConsent(row, method, actor?.name || '', note, false);
  db.logActivity(orgId, actor, 'background.consent', `رضایت کتبی استعلام سوءپیشینه «${row.candidateName || 'کارجو'}» را ثبت کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

/** The candidate's own click — the strongest form of consent this module records. */
export function consentByToken(token: string, name: unknown, agreed: unknown): db.BackgroundCheckRow {
  const row = db.findBackgroundCheckByToken(token);
  if (!row) throw new BackgroundError('این لینک معتبر نیست.', 404, 'TOKEN_INVALID');
  if (row.status === 'cancelled') throw new BackgroundError('این استعلام لغو شده است.', 409, 'CHECK_CLOSED');
  if (row.consent) return row;
  if (agreed !== true) throw new BackgroundError('برای ثبت رضایت باید کادر تأیید علامت بخورد.', 400, 'AGREEMENT_REQUIRED');
  const typed = typeof name === 'string' ? name.trim() : '';
  if (typed.length < 3) throw new BackgroundError('نام و نام خانوادگی خود را بنویسید؛ رضایت بی‌نام ثبت نمی‌شود.', 400, 'NAME_REQUIRED');
  const next = applyConsent(row, 'portal', typed, 'رضایت از طریق لینک اختصاصی کارجو.', true);
  db.logActivity(row.orgId, null, 'background.consent', `کارجو «${row.candidateName || ''}» رضایت استعلام سوءپیشینه را از لینک اختصاصی ثبت کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

export function declineByToken(token: string, reason: unknown): db.BackgroundCheckRow {
  const row = db.findBackgroundCheckByToken(token);
  if (!row) throw new BackgroundError('این لینک معتبر نیست.', 404, 'TOKEN_INVALID');
  if (row.consent) throw new BackgroundError('رضایت پیش‌تر ثبت شده است؛ برای پس‌گرفتن با منابع انسانی تماس بگیرید.', 409, 'ALREADY_CONSENTED');
  if (row.status === 'cancelled' || row.status === 'declined') return row;
  const stamp = stampOf(new Date());
  const next = db.saveBackgroundCheck({
    ...row,
    status: 'declined',
    declinedAtISO: stamp.iso,
    declinedReason: typeof reason === 'string' ? reason.trim().slice(0, 400) : '',
    updatedAtISO: stamp.iso,
  });
  db.logActivity(row.orgId, null, 'background.declined', `کارجو «${row.candidateName || ''}» رضایت استعلام سوءپیشینه را نداد`, {
    resumeId: row.resumeId,
  });
  return next;
}

export function markConsentViewed(token: string): void {
  const row = db.findBackgroundCheckByToken(token);
  if (!row || row.consentViewedAtISO) return;
  db.saveBackgroundCheck({ ...row, consentViewedAtISO: new Date().toISOString() });
}

/** Handing the request to the office. Consent must exist first. */
export function markRequested(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: { reference?: unknown; requestedAtISO?: unknown; dueAtISO?: unknown }
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  // A refusal is a different fact from «consent not taken yet», so it is named
  // first — the person acting needs to know which one they are looking at.
  if (row.status === 'declined') throw new BackgroundError(`کارجو رضایت نداده است. ${DECLINED_NOTE}`, 409, 'DECLINED');
  if (!row.consent) {
    throw new BackgroundError(
      'پیش از ثبت درخواست، رضایت کارجو لازم است: یا لینک رضایت را بفرستید، یا فرم امضاشده را ثبت کنید.',
      409,
      'CONSENT_REQUIRED'
    );
  }
  if (row.status === 'completed') throw new BackgroundError('این استعلام نتیجه دارد؛ درخواست دوباره معنا ندارد.', 409, 'ALREADY_COMPLETED');
  if (row.status === 'cancelled') throw new BackgroundError('این استعلام لغو شده است.', 409, 'CHECK_CLOSED');
  if (row.status !== 'consented' && row.status !== 'requested') {
    throw new BackgroundError('این استعلام در وضعیت درستی برای ثبت درخواست نیست.', 409, 'BAD_STATE');
  }
  const reference = typeof input.reference === 'string' ? input.reference.trim().slice(0, 80) : row.reference;
  if (reference.length < 3) {
    throw new BackgroundError('شمارهٔ نامه یا کد پیگیری مرجع را بنویسید تا بعداً قابل ردیابی باشد.', 400, 'REFERENCE_REQUIRED');
  }
  const requestedAtISO =
    typeof input.requestedAtISO === 'string' && input.requestedAtISO ? input.requestedAtISO : row.requestedAtISO || new Date().toISOString();
  const stamp = stampOf(new Date());
  const next = db.saveBackgroundCheck({
    ...row,
    status: 'requested',
    reference,
    requestedAtISO,
    requestedAtJalali: jalali(requestedAtISO),
    dueAtISO: typeof input.dueAtISO === 'string' && input.dueAtISO ? input.dueAtISO : row.dueAtISO,
    dueAtJalali:
      typeof input.dueAtISO === 'string' && input.dueAtISO ? jalali(input.dueAtISO) : row.dueAtJalali,
    updatedAtISO: stamp.iso,
    updatedByName: actor?.name ?? null,
  });
  db.logActivity(orgId, actor, 'background.requested', `درخواست سوءپیشینه «${row.candidateName || 'کارجو'}» را با شمارهٔ «${reference}» ثبت کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

/** The verdict, as quoted from the certificate. No arithmetic anywhere. */
export function recordResult(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: BackgroundResultInput
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  if (!row.consent) throw new BackgroundError('بدون رضایت کارجو، نتیجه‌ای ثبت نمی‌شود.', 409, 'CONSENT_REQUIRED');
  if (row.status === 'cancelled') throw new BackgroundError('این استعلام لغو شده است.', 409, 'CHECK_CLOSED');
  if (row.status === 'completed') throw new BackgroundError('این استعلام پیش‌تر نتیجه دارد؛ نتیجه تغییر نمی‌کند.', 409, 'ALREADY_COMPLETED');
  const verdict: BackgroundVerdict =
    input.verdict === 'clear' || input.verdict === 'record_found' || input.verdict === 'inconclusive' ? input.verdict : ('inconclusive' as BackgroundVerdict);
  if (input.verdict !== verdict) throw new BackgroundError('نتیجه باید «پاک»، «سابقه اعلام شده» یا «نیازمند بررسی» باشد.', 400, 'BAD_VERDICT');
  const issuedAtISO = typeof input.issuedAtISO === 'string' && input.issuedAtISO ? input.issuedAtISO : null;
  const stamp = stampOf(new Date());
  const next = db.saveBackgroundCheck({
    ...row,
    status: 'completed',
    result: {
      verdict,
      issuedAtISO,
      issuedAtJalali: jalali(issuedAtISO),
      issuedBy: typeof input.issuedBy === 'string' ? input.issuedBy.trim().slice(0, 120) : row.authority,
      note: typeof input.note === 'string' ? input.note.trim().slice(0, 600) : '',
      recordedAtISO: stamp.iso,
      recordedAtJalali: stamp.jalali,
      recordedByName: actor?.name || 'منابع انسانی',
    },
    updatedAtISO: stamp.iso,
    updatedByName: actor?.name ?? null,
  });
  db.logActivity(orgId, actor, 'background.result', `نتیجهٔ سوءپیشینه «${row.candidateName || 'کارجو'}» را ثبت کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

/** A human, in writing. Required for every outcome, not just the hard one. */
export function recordDecision(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: BackgroundDecisionInput
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  if (row.status !== 'completed') {
    throw new BackgroundError('تصمیم پس از ثبت نتیجه گرفته می‌شود، نه پیش از آن.', 409, 'NO_RESULT');
  }
  const outcome = input.outcome === 'proceed' || input.outcome === 'hold' || input.outcome === 'withdraw' ? input.outcome : null;
  if (!outcome) throw new BackgroundError('تصمیم باید «ادامه»، «نگه‌داشتن» یا «کنار گذاشتن» باشد.', 400, 'BAD_OUTCOME');
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length < MIN_DECISION_NOTE) {
    throw new BackgroundError(`دلیل تصمیم را بنویسید (حداقل ${MIN_DECISION_NOTE} نویسه) — این جمله در پرونده می‌ماند.`, 400, 'NOTE_REQUIRED');
  }
  const stamp = stampOf(new Date());
  const next = db.saveBackgroundCheck({
    ...row,
    decision: {
      outcome,
      note: note.slice(0, 600),
      byName: actor?.name || 'منابع انسانی',
      atISO: stamp.iso,
      atJalali: stamp.jalali,
    },
    updatedAtISO: stamp.iso,
    updatedByName: actor?.name ?? null,
  });
  db.logActivity(orgId, actor, 'background.decision', `تصمیم پس از سوءپیشینهٔ «${row.candidateName || 'کارجو'}» را ثبت کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

export function cancelCheck(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null
): db.BackgroundCheckRow {
  const row = getCheck(orgId, id);
  if (row.status === 'completed') {
    throw new BackgroundError('استعلام دارای نتیجه را نمی‌توان لغو کرد؛ نتیجه در پرونده می‌ماند.', 409, 'ALREADY_COMPLETED');
  }
  if (row.status === 'cancelled') return row;
  const next = db.saveBackgroundCheck({ ...row, status: 'cancelled', cancelledAtISO: new Date().toISOString() });
  db.logActivity(orgId, actor, 'background.created', `استعلام سوءپیشینه «${row.candidateName || 'کارجو'}» را لغو کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

// ------------------------------------------------------------- documents ----

function docKey(orgId: string, checkId: string, docId: string, ext: string): string | null {
  const key = `background/${orgId}/${checkId}-${docId}.${ext}`;
  return isSafeKey(key) ? key : null;
}

export async function uploadDocument(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null,
  input: { fileName?: unknown; fileBase64?: unknown }
): Promise<db.BackgroundCheckRow> {
  const row = getCheck(orgId, id);
  if (row.status === 'draft' && !row.consent) {
    throw new BackgroundError('تصویر گواهی پس از ثبت درخواست و رضایت کارجو بارگذاری می‌شود.', 409, 'CONSENT_REQUIRED');
  }
  const fileName = typeof input.fileName === 'string' ? input.fileName.slice(0, 160) : 'certificate';
  const ext = fileName.toLowerCase().split('.').pop() || '';
  if (!DOC_EXT.includes(ext)) {
    throw new BackgroundError('فقط تصویر یا PDF پذیرفته می‌شود (pdf، png، jpg، webp).', 400, 'BAD_FILE_TYPE');
  }
  const base64 = typeof input.fileBase64 === 'string' ? input.fileBase64 : '';
  if (base64.length < 20) throw new BackgroundError('محتوای فایل خالی است.', 400, 'EMPTY_FILE');
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_DOC_BYTES) throw new BackgroundError('حجم فایل بیش از ۸ مگابایت است.', 413, 'FILE_TOO_LARGE');
  if (row.documents.length >= 5) throw new BackgroundError('برای هر استعلام حداکثر ۵ فایل نگه داشته می‌شود.', 409, 'TOO_MANY_DOCUMENTS');
  const docId = db.uid('doc');
  const key = docKey(orgId, row.id, docId, ext);
  if (!key) throw new BackgroundError('نام فایل مجاز نیست.', 400, 'BAD_FILE_NAME');
  await storage().put(key, buf);
  const stamp = stampOf(new Date());
  const doc: BackgroundDocument = {
    id: docId,
    fileName,
    size: buf.length,
    mimeType: DOC_MIME[ext],
    uploadedAtISO: stamp.iso,
    uploadedAtJalali: stamp.jalali,
    uploadedByName: actor?.name || 'منابع انسانی',
  };
  const next = db.saveBackgroundCheck({ ...row, documents: [...row.documents, doc], updatedAtISO: stamp.iso });
  db.logActivity(orgId, actor, 'background.result', `تصویر گواهی سوءپیشینهٔ «${row.candidateName || 'کارجو'}» را بارگذاری کرد`, {
    resumeId: row.resumeId,
  });
  return next;
}

export async function readDocument(
  orgId: string,
  id: string,
  docId: string
): Promise<{ doc: BackgroundDocument; body: Buffer }> {
  const row = getCheck(orgId, id);
  const doc = row.documents.find((d) => d.id === docId);
  if (!doc) throw new BackgroundError('این فایل پیدا نشد.', 404, 'DOCUMENT_NOT_FOUND');
  const ext = doc.fileName.toLowerCase().split('.').pop() || '';
  const key = docKey(orgId, row.id, doc.id, ext);
  if (!key) throw new BackgroundError('نام فایل مجاز نیست.', 400, 'BAD_FILE_NAME');
  const obj = await storage().get(key);
  if (!obj) throw new BackgroundError('فایل در فضای ذخیره‌سازی نیست.', 404, 'DOCUMENT_MISSING');
  return { doc, body: obj.body };
}

/** Removes the row entry *and* the bytes. Called by delete, erasure and the API. */
export async function deleteDocument(
  orgId: string,
  id: string,
  docId: string,
  actor: { id: string; name: string } | null
): Promise<db.BackgroundCheckRow> {
  const row = getCheck(orgId, id);
  const doc = row.documents.find((d) => d.id === docId);
  if (!doc) throw new BackgroundError('این فایل پیدا نشد.', 404, 'DOCUMENT_NOT_FOUND');
  const ext = doc.fileName.toLowerCase().split('.').pop() || '';
  const key = docKey(orgId, row.id, doc.id, ext);
  if (key) await storage().delete(key).catch(() => undefined);
  const next = db.saveBackgroundCheck({ ...row, documents: row.documents.filter((d) => d.id !== docId) });
  db.logActivity(orgId, actor, 'background.result', `تصویر گواهی «${row.candidateName || 'کارجو'}» را حذف کرد`, { resumeId: row.resumeId });
  return next;
}

/** Used by erasure and workspace deletion: the files go too. */
export async function deleteCheckFiles(row: db.BackgroundCheckRow): Promise<void> {
  for (const doc of row.documents) {
    const ext = doc.fileName.toLowerCase().split('.').pop() || '';
    const key = docKey(row.orgId, row.id, doc.id, ext);
    if (key) await storage().delete(key).catch(() => undefined);
  }
}

// --------------------------------------------------------------- public -----

export function publicViewOfRow(row: db.BackgroundCheckRow): PublicBackgroundConsent {
  const org = db.getOrg(row.orgId);
  return {
    orgName: org?.name || 'سازمان',
    candidateName: row.candidateName,
    jobTitle: row.jobTitle,
    authority: row.authority,
    purpose: row.purpose,
    notice: noticeOf(row.orgId, row),
    noticeVersion: NOTICE_VERSION,
    status: row.status,
    consentAtJalali: row.consent?.atJalali ?? null,
    declinedAtJalali: jalali(row.declinedAtISO),
    contact: contactOf(org),
    canConsent: !row.consent && row.status !== 'cancelled' && row.status !== 'declined' && row.status !== 'completed',
    canDecline: !row.consent && row.status !== 'cancelled' && row.status !== 'declined' && row.status !== 'completed',
  };
}

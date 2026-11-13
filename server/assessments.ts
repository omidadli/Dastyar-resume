/**
 * «آزمون و ارزیابی» — sending a structured test, taking it, and scoring it.
 *
 * Rules this file keeps:
 *   - **Nothing is sent without a click.** Creating a test only makes the link;
 *     the e-mail leaves when HR presses the button, from the workspace's own
 *     mailbox, and the UI says so when no mailbox is connected.
 *   - **The key never reaches the candidate.** The public page receives the
 *     question and the option labels, never the score of an option and never a
 *     dimension name — otherwise the test is answerable by inspection.
 *   - **One answer, one result.** After submitting, the same link shows the
 *     closing screen instead of the form. Answers are stored on the server and
 *     the workspace only ever sees the result.
 *   - **A result is not a verdict.** Keyed tests produce a 0–100 score with a
 *     band; behavioural tests produce five dimension profiles and no total.
 */
import crypto from 'crypto';
import * as db from './db';
import { isEmailConfigured, sendMail, friendlySmtpError } from './mailer';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { ASSESSMENT_TEMPLATES, templateById } from './assessment-bank';
import { AGREEMENT_SCALE } from '../src/types/assessment';
import type {
  AssessmentAnswerInput,
  AssessmentBand,
  AssessmentDimensionScore,
  AssessmentInvite,
  AssessmentKind,
  AssessmentStatus,
  AssessmentTemplateSummary,
  PublicAssessment,
} from '../src/types/assessment';
import type { AssessmentTemplate } from './assessment-bank';
import { mailBrandOf } from './mail-brand';
import {
  ProviderError,
  createProviderSession,
  getProviderRow,
  newExternalRef,
  readinessOf,
} from './assessment-providers';
import type { ProviderTest } from '../src/types/assessment-provider';

export class AssessmentError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'ASSESSMENT_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ASSESSMENT_TTL_DAYS = 14;

/** Which template a kind of role should probably start with — shown as a hint. */
export function suggestTemplateId(jobTitle: string): string {
  const t = (jobTitle || '').toLowerCase();
  if (/فروش|sales|مذاکره/.test(t)) return 'situational-sales';
  if (/پشتیبان|support|خدمات مشتری/.test(t)) return 'work-sample-support';
  if (/مدیر|سرپرست|رهبر|lead|manager|head/.test(t)) return 'situational-management';
  if (/جذب|استخدام|recruit|hr|منابع انسانی/.test(t)) return 'situational-recruiting';
  return 'behavioral-core';
}

export function bandOf(score: number): AssessmentBand {
  if (score >= 75) return 'strong';
  if (score >= 55) return 'medium';
  return 'review';
}

/** The catalogue the settings/panel offers. */
export function templateSummaries(): AssessmentTemplateSummary[] {
  return ASSESSMENT_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    kind: t.kind,
    summary: t.summary,
    durationMinutes: t.durationMinutes,
    questionCount: t.questions.length,
    dimensions: t.dimensions.map((d) => d.label),
    reading: t.reading,
    scored: t.scored,
  }));
}

/** The catalogue plus the two extra fields the send dialog needs. */
export function templateForSend(id: string): AssessmentTemplate | null {
  return templateById(id);
}

/** A workspace view: the stored row plus its public link. */
export function viewOf(row: db.AssessmentInviteRow, baseUrl: string): AssessmentInvite {
  const { orgId: _o, token, answers: _a, ...rest } = row;
  return { ...rest, url: `${baseUrl.replace(/\/$/, '')}/assess/${token}` };
}

/** The page a candidate opens. No scores, no dimension names, no org ids. */
export function publicView(row: db.AssessmentInviteRow): PublicAssessment {
  const tpl = templateById(row.templateId);
  const org = db.getOrg(row.orgId);
  const expired = (row.status === 'sent' || row.status === 'started') && new Date(row.expiresAtISO).getTime() < Date.now();
  return {
    orgName: org?.name || '',
    candidateName: row.candidateName,
    jobTitle: row.jobTitle,
    intro: tpl?.intro || '',
    durationMinutes: tpl?.durationMinutes || 10,
    status: expired ? 'expired' : row.status,
    expiresAtJalali: formatJalaliDate(tehranJalaliOf(new Date(row.expiresAtISO)), true),
    started: row.status !== 'sent' || Boolean(row.startedAtISO),
    scale: AGREEMENT_SCALE,
    questions: (tpl?.questions || []).map((q) =>
      q.type === 'single'
        ? { id: q.id, type: 'single' as const, text: q.text, ...(q.hint ? { hint: q.hint } : {}), options: q.options.map((o) => ({ id: o.id, label: o.label })) }
        : { id: q.id, type: 'scale' as const, text: q.text }
    ),
    template: { id: row.templateId, name: row.templateName, kind: row.kind },
    provider:
      row.driver === 'provider'
        ? {
            name: row.providerName || 'سرویس آزمون بیرونی',
            url: row.externalUrl || '',
            note: 'این آزمون در سرویس بیرونی برگزار می‌شود؛ پاسخ‌ها همان‌جا ثبت می‌شوند و نتیجه به پروندهٔ شما اضافه می‌شود.',
          }
        : null,
  };
}

/**
 * Scores one submission against the template's key.
 * Keyed tests: sum of the chosen option scores / (10 × questions).
 * Behavioural tests: per-dimension average on the 1–5 scale, reversed where the
 * item says so, mapped to 0–100.
 */
export function scoreAnswers(
  tpl: AssessmentTemplate,
  answers: Record<string, AssessmentAnswerInput['value']>
): { score: number | null; band: AssessmentBand | null; dimensions: AssessmentDimensionScore[] | null } {
  if (tpl.scored) {
    let total = 0;
    for (const q of tpl.questions) {
      if (q.type !== 'single') continue;
      const chosen = q.options.find((o) => o.id === answers[q.id]);
      total += chosen ? chosen.score : 0;
    }
    const score = Math.round((100 * total) / (tpl.questions.length * 10));
    return { score, band: bandOf(score), dimensions: null };
  }

  const sums = new Map<string, { total: number; count: number }>();
  for (const q of tpl.questions) {
    if (q.type !== 'scale') continue;
    const raw = Number(answers[q.id]);
    if (!Number.isFinite(raw) || raw < 1 || raw > 5) continue;
    const value = q.reverse ? 6 - raw : raw;
    const cur = sums.get(q.dimension) || { total: 0, count: 0 };
    cur.total += value;
    cur.count += 1;
    sums.set(q.dimension, cur);
  }
  const dimensions = tpl.dimensions.map((d) => {
    const s = sums.get(d.id);
    const avg = s && s.count ? s.total / s.count : 0;
    return { id: d.id, label: d.label, score: Math.round(((avg - 1) / 4) * 100) };
  });
  return { score: null, band: null, dimensions };
}

export interface CreateAssessmentInput {
  resumeId?: unknown;
  templateId?: unknown;
  jobId?: unknown;
}

/** Creates the invitation and the link. Sends nothing. */
export function createInvite(orgId: string, actor: { id: string; name: string } | null, input: CreateAssessmentInput): db.AssessmentInviteRow {
  const resumeId = typeof input.resumeId === 'string' ? input.resumeId : '';
  const rec = resumeId ? db.getResume(orgId, resumeId) : null;
  if (!rec) throw new AssessmentError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');

  const tpl = templateById(typeof input.templateId === 'string' ? input.templateId : '');
  if (!tpl) throw new AssessmentError('این آزمون در بانک موجود نیست.', 400, 'TEMPLATE_NOT_FOUND');

  const open = db.openAssessmentFor(orgId, rec.id);
  if (open && open.templateId === tpl.id && new Date(open.expiresAtISO).getTime() > Date.now()) {
    throw new AssessmentError('برای این کارجو همین آزمون باز است؛ همان لینک را بفرستید یا لغو کنید.', 409, 'ASSESSMENT_OPEN');
  }

  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  const stamp = new Date();
  const row: db.AssessmentInviteRow = {
    id: db.uid('asm'),
    orgId,
    token: crypto.randomBytes(18).toString('base64url'),
    resumeId: rec.id,
    jobId: rec.jobId || null,
    jobTitle: job?.roleTitle || null,
    templateId: tpl.id,
    templateName: tpl.name,
    kind: tpl.kind,
    candidateName: rec.candidateName || null,
    candidateEmail: rec.contact?.email?.toLowerCase() || null,
    status: 'sent',
    source: 'hovida',
    createdAtISO: stamp.toISOString(),
    sentAtISO: null,
    startedAtISO: null,
    completedAtISO: null,
    expiresAtISO: new Date(stamp.getTime() + ASSESSMENT_TTL_DAYS * 86_400_000).toISOString(),
    score: null,
    band: null,
    dimensions: null,
    answeredCount: 0,
    questionCount: tpl.questions.length,
    note: null,
    answers: null,
    driver: 'hovida',
  };
  // `createdByName` is not part of the public type; the history line carries it.
  db.saveAssessment(row);
  db.logActivity(orgId, actor, 'assessment.sent', `آزمون «${tpl.name}» را برای «${row.candidateName || 'کارجو'}» آماده کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return row;
}

export interface CreateProviderInviteInput {
  resumeId?: unknown;
  providerId?: unknown;
  testId?: unknown;
  jobId?: unknown;
  /** `link` mode: the provider's own test URL, pasted once by HR. */
  externalUrl?: unknown;
}

/**
 * An invitation for a test that lives elsewhere.
 *
 * In `api` mode the provider's session is opened on send, not here — creating a
 * link must never call an outside service. In `link` mode the URL is required
 * up front, because it is the thing that will be mailed.
 */
export function createProviderInvite(
  orgId: string,
  actor: { id: string; name: string } | null,
  input: CreateProviderInviteInput
): db.AssessmentInviteRow {
  const rec = typeof input.resumeId === 'string' ? db.getResume(orgId, input.resumeId) : null;
  if (!rec) throw new AssessmentError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');

  let provider: db.AssessmentProviderRow;
  try {
    provider = getProviderRow(orgId, typeof input.providerId === 'string' ? input.providerId : '');
  } catch {
    throw new AssessmentError('این سرویس آزمون پیدا نشد.', 404, 'PROVIDER_NOT_FOUND');
  }
  const testId = typeof input.testId === 'string' ? input.testId : '';
  const test: ProviderTest | undefined = provider.tests.find((t) => t.id === testId);
  if (!test) throw new AssessmentError('این آزمون در فهرست سرویس نیست.', 400, 'PROVIDER_TEST_NOT_FOUND');

  const readiness = readinessOf(provider);
  if (!readiness.ready) {
    throw new AssessmentError(
      `سرویس «${provider.name}» هنوز آماده نیست: ${readiness.reason || 'تنظیمات کامل نشده است.'}`,
      409,
      'PROVIDER_NOT_READY'
    );
  }

  const open = db.openAssessmentFor(orgId, rec.id);
  if (open && open.templateId === providerTestTemplateId(provider.id, test.id) && new Date(open.expiresAtISO).getTime() > Date.now()) {
    throw new AssessmentError('برای این کارجو همین آزمون باز است؛ همان را بفرستید یا لغو کنید.', 409, 'ASSESSMENT_OPEN');
  }

  let externalUrl: string | null = null;
  if (provider.mode === 'link') {
    const raw = typeof input.externalUrl === 'string' ? input.externalUrl.trim() : '';
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new AssessmentError('نشانی آزمون سرویس را وارد کنید (با https).', 400, 'EXTERNAL_URL_REQUIRED');
    }
    if (parsed.protocol !== 'https:') {
      throw new AssessmentError('نشانی آزمون باید https باشد.', 400, 'EXTERNAL_URL_HTTPS');
    }
    externalUrl = parsed.toString();
  }

  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  const stamp = new Date();
  const row: db.AssessmentInviteRow = {
    id: db.uid('asm'),
    orgId,
    token: crypto.randomBytes(18).toString('base64url'),
    resumeId: rec.id,
    jobId: rec.jobId || null,
    jobTitle: job?.roleTitle || null,
    templateId: providerTestTemplateId(provider.id, test.id),
    templateName: test.name,
    kind: test.kind,
    candidateName: rec.candidateName || null,
    candidateEmail: rec.contact?.email?.toLowerCase() || null,
    status: 'sent',
    source: 'external',
    createdAtISO: stamp.toISOString(),
    sentAtISO: null,
    startedAtISO: null,
    completedAtISO: null,
    expiresAtISO: new Date(stamp.getTime() + ASSESSMENT_TTL_DAYS * 86_400_000).toISOString(),
    score: null,
    band: null,
    dimensions: null,
    answeredCount: 0,
    questionCount: 0,
    note: null,
    answers: null,
    driver: 'provider',
    providerId: provider.id,
    providerName: provider.name,
    providerTestId: test.externalId || test.id,
    externalRef: newExternalRef(),
    externalUrl,
  };
  db.saveAssessment(row);
  db.logActivity(orgId, actor, 'assessment.sent', `آزمون بیرونی «${test.name}» را برای «${row.candidateName || 'کارجو'}» آماده کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return row;
}

/** The local template id of a provider test — how the panel tells the two kinds apart. */
export function providerTestTemplateId(providerId: string, testId: string): string {
  return `provider:${providerId}:${testId}`;
}

/** `provider:<providerId>:<testId>` → the two halves, or null for a bank test. */
export function splitProviderTemplateId(templateId: string): { providerId: string; testId: string } | null {
  if (!templateId.startsWith('provider:')) return null;
  const [, providerId, ...rest] = templateId.split(':');
  const testId = rest.join(':');
  if (!providerId || !testId) return null;
  return { providerId, testId };
}

export function cancelInvite(orgId: string, id: string, actor: { id: string; name: string } | null): db.AssessmentInviteRow {
  const row = db.getAssessment(orgId, id);
  if (!row) throw new AssessmentError('آزمون پیدا نشد.', 404, 'ASSESSMENT_NOT_FOUND');
  if (row.status === 'completed') throw new AssessmentError('آزمون تکمیل‌شده را نمی‌توان لغو کرد؛ نتیجه در پرونده می‌ماند.', 409, 'ALREADY_COMPLETED');
  const next = db.saveAssessment({ ...row, status: 'cancelled' });
  db.logActivity(orgId, actor, 'assessment.sent', `آزمون «${row.templateName}» را برای «${row.candidateName || 'کارجو'}» لغو کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

export interface SendResult {
  assessment: db.AssessmentInviteRow;
  /** True only when the mail server accepted the message. */
  emailed: boolean;
}

/** The e-mail is short, names the role, and says what the test is and is not. */
export function invitationText(row: db.AssessmentInviteRow, orgName: string, url: string): { subject: string; body: string } {
  return {
    subject: `یک ارزیابی کوتاه برای ${row.jobTitle ? `«${row.jobTitle}» — ` : ''}${orgName}`,
    body: [
      `${row.candidateName || 'سلام'} عزیز،`,
      '',
      `برای آشنایی بهتر با شیوهٔ کار شما در ${row.jobTitle ? `نقش «${row.jobTitle}» در ` : ''}${orgName}، یک ارزیابی کوتاه «${row.templateName}» داریم.`,
      `حدود ${templateById(row.templateId)?.durationMinutes || 10} دقیقه وقت می‌برد و پاسخ درست یا غلط ندارد؛ آنچه واقعاً انجام می‌دهید مهم است.`,
      '',
      'لینک آزمون:',
      url,
      '',
      `این لینک تا ${formatJalaliDate(tehranJalaliOf(new Date(row.expiresAtISO)), true)} باز است و فقط یک‌بار می‌توانید پاسخ بدهید.`,
      'نتیجه در کنار رزومه و گفت‌وگوی ما خوانده می‌شود، نه به‌تنهایی.',
      '',
      'با احترام،',
      orgName,
    ].join('\n'),
  };
}

/**
 * The mail for a provider-hosted test: shorter, and it does not sell the test.
 * No score expectation, no «آزمون شخصیت» claim we cannot stand behind.
 */
export function providerInvitationText(
  row: db.AssessmentInviteRow,
  orgName: string,
  url: string
): { subject: string; body: string } {
  return {
    subject: `یک ارزیابی برای ${row.jobTitle ? `«${row.jobTitle}» — ` : ''}${orgName}`,
    body: [
      `${row.candidateName || 'سلام'} عزیز،`,
      '',
      `برای آشنایی بهتر با شیوهٔ کار شما در ${row.jobTitle ? `نقش «${row.jobTitle}» در ` : ''}${orgName}، یک ارزیابی «${row.templateName}» داریم.`,
      ...(row.providerName ? [`این ارزیابی در سرویس «${row.providerName}» برگزار می‌شود و لینک زیر مخصوص شماست.`] : []),
      '',
      'لینک آزمون:',
      url,
      '',
      `این لینک تا ${formatJalaliDate(tehranJalaliOf(new Date(row.expiresAtISO)), true)} باز است.`,
      'نتیجه در کنار رزومه و گفت‌وگوی ما خوانده می‌شود، نه به‌تنهایی.',
      '',
      'با احترام،',
      orgName,
    ].join('\n'),
  };
}

/**
 * Sends an invitation. For a provider test in `api` mode this is also the moment
 * the provider's session is opened — the only outbound call, and it happens
 * because a human pressed «ارسال». Every failure is reported and nothing is
 * mailed: a half-sent invitation is worse than a visible error.
 */
export async function sendInvite(orgId: string, id: string, url: string, actor: { id: string; name: string } | null): Promise<SendResult> {
  const fetched = db.getAssessment(orgId, id);
  if (!fetched) throw new AssessmentError('آزمون پیدا نشد.', 404, 'ASSESSMENT_NOT_FOUND');
  if (fetched.status === 'completed') throw new AssessmentError('این کارجو آزمون را تکمیل کرده است.', 409, 'ALREADY_COMPLETED');
  if (fetched.status === 'cancelled') throw new AssessmentError('این آزمون لغو شده است.', 409, 'CANCELLED');
  if (!fetched.candidateEmail) throw new AssessmentError('برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'NO_EMAIL');
  const candidateEmail = fetched.candidateEmail;
  // Check the mailbox *before* dialling a vendor: opening a session we cannot
  // deliver the link for would bill the customer for nothing.
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new AssessmentError('ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  const invite: db.AssessmentInviteRow = { ...fetched, candidateEmail };

  let row: db.AssessmentInviteRow = invite;
  let target = url;
  if (invite.driver === 'provider' && invite.providerId) {
    const prov = db.getAssessmentProvider(orgId, invite.providerId);
    if (!prov) throw new AssessmentError('سرویس آزمون این دعوت حذف شده است؛ آن را دوباره وصل کنید.', 409, 'PROVIDER_GONE');
    if (prov.mode === 'api') {
      if (invite.externalUrl) {
        // Already opened once (a retry of a failed mail): reuse the same session.
        target = invite.externalUrl;
      } else {
        const test = prov.tests.find((t) => invite.templateId === providerTestTemplateId(prov.id, t.id));
        if (!test) throw new AssessmentError('این آزمون دیگر در فهرست سرویس نیست.', 409, 'PROVIDER_TEST_NOT_FOUND');
        try {
          const session = await createProviderSession(prov, {
            test,
            candidateName: invite.candidateName,
            candidateEmail,
            externalRef: invite.externalRef || invite.id,
            expiresAtISO: invite.expiresAtISO,
          });
          row = db.saveAssessment({ ...invite, externalUrl: session.url, externalRef: invite.externalRef || invite.id });
          target = session.url;
        } catch (err) {
          const message = err instanceof ProviderError ? err.message : 'سرویس آزمون جلسه را نساخت.';
          db.logActivity(orgId, actor, 'assessment.sent', `ساخت جلسهٔ آزمون «${invite.templateName}» در سرویس «${prov.name}» ناموفق بود`, {
            jobId: invite.jobId,
            resumeId: invite.resumeId,
          });
          throw new AssessmentError(message, 502, err instanceof ProviderError ? err.code : 'PROVIDER_FAILED');
        }
      }
    } else if (!invite.externalUrl) {
      throw new AssessmentError('نشانی آزمون سرویس ثبت نشده است؛ آن را در همان دعوت وارد کنید.', 409, 'EXTERNAL_URL_REQUIRED');
    } else {
      target = invite.externalUrl;
    }
  }

  const org = db.getOrg(orgId);
  const { subject, body } =
    row.driver === 'provider' ? providerInvitationText(row, org?.name || 'سازمان', target) : invitationText(row, org?.name || 'سازمان', target);
  try {
    await sendMail(secrets.email!, { to: candidateEmail, subject, text: body, brand: mailBrandOf(org) });
  } catch (err: any) {
    throw new AssessmentError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const stamp = new Date();
  const next = db.saveAssessment({ ...row, sentAtISO: stamp.toISOString() });
  // Every mail we send belongs in the candidate's file, exactly like an offer
  // mail — «چه چیزی برای این نفر فرستادیم؟» must have one answer.
  db.saveEmail({
    id: db.uid('eml'),
    orgId,
    resumeId: row.resumeId,
    candidateName: row.candidateName,
    jobId: row.jobId,
    to: candidateEmail,
    subject,
    body,
    status: 'sent',
    error: null,
    sentAtISO: stamp.toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    sentByName: actor?.name || null,
    attachments: [],
  });
  db.logActivity(orgId, actor, 'assessment.sent', `آزمون «${row.templateName}» را برای «${row.candidateName || 'کارجو'}» فرستاد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return { assessment: next, emailed: true };
}

/** Records the first open, so HR can tell «فرستاده شد» from «دیده شد». */
export function markStarted(row: db.AssessmentInviteRow): db.AssessmentInviteRow {
  // A provider-hosted test is not «در حال پاسخ» just because the info page was
  // opened: the candidate answers somewhere else.
  if (row.driver === 'provider') return row;
  if (row.status !== 'sent') return row;
  return db.saveAssessment({ ...row, status: 'started' as AssessmentStatus, startedAtISO: new Date().toISOString() });
}

function readAnswers(input: unknown): Record<string, AssessmentAnswerInput['value']> {
  const out: Record<string, AssessmentAnswerInput['value']> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.slice(0, 60);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The candidate's submission. Every question must be answered, once. */
export function submitAnswers(row: db.AssessmentInviteRow, raw: unknown): db.AssessmentInviteRow {
  if (row.driver === 'provider') {
    throw new AssessmentError('این آزمون در سرویس بیرونی برگزار می‌شود؛ پاسخ‌ها همان‌جا ثبت می‌شود.', 409, 'PROVIDER_HOSTED');
  }
  if (row.status === 'completed') throw new AssessmentError('پاسخ شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_COMPLETED');
  if (row.status === 'cancelled') throw new AssessmentError('این آزمون لغو شده است.', 409, 'CANCELLED');
  if (new Date(row.expiresAtISO).getTime() < Date.now()) {
    throw new AssessmentError('مهلت این آزمون گذشته است؛ اگر لازم است با منابع انسانی تماس بگیرید.', 409, 'EXPIRED');
  }
  const tpl = templateById(row.templateId);
  if (!tpl) throw new AssessmentError('این آزمون در بانک موجود نیست.', 400, 'TEMPLATE_NOT_FOUND');
  const answers = readAnswers(raw);

  for (const q of tpl.questions) {
    const value = answers[q.id];
    if (q.type === 'single') {
      const ok = typeof value === 'string' && q.options.some((o) => o.id === value);
      if (!ok) throw new AssessmentError('همهٔ سؤال‌ها را پاسخ بدهید؛ پاسخ ناقص ثبت نمی‌شود.', 400, 'ANSWERS_INCOMPLETE');
    } else {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 5) throw new AssessmentError('همهٔ گزاره‌ها را از ۱ تا ۵ مشخص کنید.', 400, 'ANSWERS_INCOMPLETE');
      answers[q.id] = n;
    }
  }

  const scored = scoreAnswers(tpl, answers);
  const stamp = new Date();
  const next = db.saveAssessment({
    ...row,
    status: 'completed' as AssessmentStatus,
    startedAtISO: row.startedAtISO || stamp.toISOString(),
    completedAtISO: stamp.toISOString(),
    answeredCount: tpl.questions.length,
    answers,
    score: scored.score,
    band: scored.band,
    dimensions: scored.dimensions,
  });
  db.logActivity(row.orgId, null, 'assessment.completed', `آزمون «${row.templateName}» را تکمیل کرد${scored.score !== null ? ` — نمرهٔ ${scored.score}` : ''}`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

/**
 * The provider contract: an outside test service (or an interviewer's manual
 * entry) writes its own result into the same record, marked `external` so the
 * report never pretends it came from this page.
 */
export function recordExternal(
  orgId: string,
  id: string,
  input: { score?: unknown; dimensions?: unknown; note?: unknown },
  actor: { id: string; name: string } | null
): db.AssessmentInviteRow {
  const row = db.getAssessment(orgId, id);
  if (!row) throw new AssessmentError('آزمون پیدا نشد.', 404, 'ASSESSMENT_NOT_FOUND');
  if (row.status === 'completed') throw new AssessmentError('این آزمون پیش‌تر نتیجه دارد.', 409, 'ALREADY_COMPLETED');

  const rawScore = input.score === null || input.score === undefined ? null : Number(input.score);
  if (rawScore !== null && (!Number.isFinite(rawScore) || rawScore < 0 || rawScore > 100)) {
    throw new AssessmentError('نمرهٔ بیرونی باید بین ۰ تا ۱۰۰ باشد.', 400, 'BAD_SCORE');
  }
  const dimensions: AssessmentDimensionScore[] = Array.isArray(input.dimensions)
    ? (input.dimensions as any[])
        .slice(0, 12)
        .map((d, i) => ({
          id: String(d?.id || `d${i}`).slice(0, 40),
          label: String(d?.label || `بُعد ${i + 1}`).slice(0, 80),
          score: Math.max(0, Math.min(100, Math.round(Number(d?.score) || 0))),
        }))
    : [];
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 600) : null;
  // A provider may return a verdict in words («قبول»، «سطح B۲») with no number.
  // That is a real result and is stored as one — never invented into a score.
  if (rawScore === null && !dimensions.length && !(note && note.length >= 3)) {
    throw new AssessmentError('نتیجهٔ بیرونی باید نمره، ابعاد یا یادداشت داشته باشد.', 400, 'NO_RESULT');
  }
  const score = rawScore === null ? null : Math.round(rawScore);
  const stamp = new Date();
  const next = db.saveAssessment({
    ...row,
    status: 'completed' as AssessmentStatus,
    source: 'external',
    completedAtISO: stamp.toISOString(),
    score,
    band: score === null ? null : bandOf(score),
    dimensions: dimensions.length ? dimensions : null,
    note: note || null,
  });
  db.logActivity(orgId, actor, 'assessment.completed', `نتیجهٔ بیرونی آزمون «${row.templateName}» را ثبت کرد${score !== null ? ` — نمرهٔ ${score}` : ''}`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return next;
}

export interface ProviderResultInput {
  /** What the provider was told to send back with every result. */
  externalRef?: unknown;
  /** The HOVIDA id, for a provider that was given the whole URL instead. */
  assessmentId?: unknown;
  score?: unknown;
  dimensions?: unknown;
  note?: unknown;
}

/**
 * The provider's way back in. The referee is `externalRef` — a value the
 * provider received when the session was opened — so a provider never needs to
 * know our internal ids, and a result can only land on its own workspace.
 */
export function recordProviderResult(
  orgId: string,
  input: ProviderResultInput,
  actor: { id: string; name: string } | null
): db.AssessmentInviteRow {
  const ref = typeof input.externalRef === 'string' ? input.externalRef.trim() : '';
  let row: db.AssessmentInviteRow | null = ref ? db.findAssessmentByExternalRef(orgId, ref) : null;
  if (!row && typeof input.assessmentId === 'string') {
    row = db.getAssessment(orgId, input.assessmentId);
  }
  if (!row) throw new AssessmentError('دعوتی با این شناسه پیدا نشد.', 404, 'ASSESSMENT_NOT_FOUND');
  if (row.driver !== 'provider') {
    throw new AssessmentError('این دعوت مربوط به آزمون‌های خود هویدا است؛ نتیجه‌اش با پاسخ کارجو ثبت می‌شود.', 409, 'NOT_PROVIDER_TEST');
  }
  return recordExternal(orgId, row.id, { score: input.score, dimensions: input.dimensions, note: input.note }, actor);
}

/** Overdue links are marked, never deleted. */
export function expireOld(orgId: string): void {
  const now = Date.now();
  for (const row of db.listAssessments(orgId)) {
    if ((row.status === 'sent' || row.status === 'started') && new Date(row.expiresAtISO).getTime() < now) {
      db.saveAssessment({ ...row, status: 'expired' });
    }
  }
}

/** What a candidate can do with an old link, read from the row itself. */
export function canAnswer(row: db.AssessmentInviteRow): boolean {
  if (row.driver === 'provider') return false;
  if (row.status === 'completed' || row.status === 'cancelled') return false;
  return new Date(row.expiresAtISO).getTime() >= Date.now();
}

export type { AssessmentKind };

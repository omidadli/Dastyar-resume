/**
 * «اتوماسیون جذب» — turns screening results into decisions a recruiter only has
 * to approve.
 *
 * Division of labour, deliberately: the machine does the repetitive, auditable
 * part (compare scores, pick the message, address it, keep the record); the
 * human keeps the judgement (approve / edit / skip). A workspace admin may switch
 * on automatic sending per kind, and then the record says `auto: true` instead of
 * pretending a person pressed the button.
 *
 * Every function here is pure with respect to *policy*: thresholds and templates
 * come from the workspace settings, never from this file.
 */
import * as db from './db';
import type { OrgPublic } from '../src/types/app';
import type { ResumeRecord } from '../src/types/screening';
import type {
  AutomationActionKind,
  AutomationOverview,
  AutomationProposal,
  AutomationRunResult,
  AutomationSettings,
  MessageTemplate,
} from '../src/types/automation';
import { normalizeAutomationSettings, renderTemplate } from './automation-settings';
import { EMAIL_HOURLY_LIMIT, noteEmailSend, withinEmailLimit } from './email-rate';
import { isEmailConfigured, friendlySmtpError, sendMail } from './mailer';
import { bookInterview } from './interviews';
import { calendarStatus } from './gcal';
import { formatJalaliDate, toPersianDigits } from '../src/utils/jalali';
import { jalaliAndTehranTime, tehranIsoFromJalali, tehranJalaliOf } from './tehran-time';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AUTOMATION_ACTOR = { id: 'automation', name: 'اتوماسیون جذب' };

export class AutomationError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'AUTOMATION_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function settingsFor(orgId: string): AutomationSettings {
  return normalizeAutomationSettings(db.getAutomationSettings(orgId));
}

function candidateEmail(rec: ResumeRecord): string | null {
  const email = rec.contact?.email?.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}

function templateOf(settings: AutomationSettings, kind: AutomationActionKind): MessageTemplate {
  if (kind === 'reject') return settings.templates.reject;
  if (kind === 'request_info') return settings.templates.requestInfo;
  return settings.templates.invite;
}

/** The slot a booking proposal suggests (Tehran wall clock, reported as Jalali). */
export function suggestedSlot(settings: AutomationSettings, now = new Date()): { date: string; time: string; iso: string } {
  const target = new Date(now.getTime() + settings.scheduleDaysAhead * 24 * 3600_000);
  const date = formatJalaliDate(tehranJalaliOf(target), true);
  const iso = tehranIsoFromJalali(date, settings.scheduleHour) || target.toISOString();
  return { date, time: settings.scheduleHour, iso };
}

type Decision = { kind: AutomationActionKind; reason: string } | { skip: string };

/**
 * What should happen to this candidate? Pure and explainable: every branch
 * returns the Persian sentence the recruiter reads next to the proposal, with the
 * numbers that produced it.
 */
export function decideAction(rec: ResumeRecord, settings: AutomationSettings): Decision {
  const fa = (n: number) => toPersianDigits(Math.round(n));

  if (rec.category === 'ERROR') return { skip: 'تحلیل رزومه انجام نشده؛ اول «تحلیل دوباره» را بزنید.' };
  if (rec.unjudgeableReason) return { skip: 'متن رزومه قابل قضاوت نبود؛ بررسی دستی لازم است.' };
  if (rec.novelty === 'duplicate') return { skip: 'در همین دپارتمان قبلاً غربال شده است (تکراری).' };
  if (!candidateEmail(rec)) return { skip: 'ایمیلی برای این کارجو ثبت نشده است.' };
  if (rec.decisionStatus === 'rejected' && rec.messageStatus === 'sent') {
    return { skip: 'نامهٔ نتیجه پیش‌تر برای این کارجو فرستاده شده است.' };
  }
  if (rec.decisionStatus === 'approved' && rec.messageStatus === 'sent') {
    return { skip: 'دعوت‌نامه پیش‌تر برای این کارجو فرستاده شده است.' };
  }

  if (rec.decisionStatus === 'rejected') {
    return { kind: 'reject', reason: 'منابع انسانی این کارجو را رد کرده است؛ نامهٔ نتیجه هنوز فرستاده نشده.' };
  }
  if (rec.decisionStatus === 'approved') {
    return settings.autoScheduleOnInvite
      ? { kind: 'schedule', reason: 'منابع انسانی این کارجو را تأیید کرده است؛ زمان جلسه پیشنهاد می‌شود.' }
      : { kind: 'invite', reason: 'منابع انسانی این کارجو را تأیید کرده است؛ دعوت‌نامه آماده است.' };
  }

  if (rec.score >= settings.inviteThreshold) {
    const why = `امتیاز ${fa(rec.score)} از ${fa(100)} و بالاتر از آستانهٔ دعوت (${fa(settings.inviteThreshold)}) است.`;
    return settings.autoScheduleOnInvite
      ? { kind: 'schedule', reason: `${why} زمان پیشنهادی جلسه آماده است.` }
      : { kind: 'invite', reason: `${why} دعوت‌نامه آماده است.` };
  }
  if (rec.score < settings.rejectThreshold) {
    return {
      kind: 'reject',
      reason: `امتیاز ${fa(rec.score)} از ${fa(100)} و پایین‌تر از آستانهٔ رد (${fa(settings.rejectThreshold)}) است.`,
    };
  }
  return {
    skip: `امتیاز ${fa(rec.score)} بین دو آستانه است (${fa(settings.rejectThreshold)} تا ${fa(settings.inviteThreshold)}); تصمیم با شماست.`,
  };
}

export interface DraftProposal {
  kind: AutomationActionKind;
  reason: string;
  subject: string;
  body: string;
  suggestedAtISO: string | null;
}

/** What the engine would do for one candidate, without writing anything. */
export function previewProposal(org: OrgPublic, rec: ResumeRecord, settings: AutomationSettings): DraftProposal | { skip: string } {
  const decision = decideAction(rec, settings);
  if ('skip' in decision) return decision;
  const job = db.getJob(org.id, rec.jobId);
  const slot = decision.kind === 'schedule' ? suggestedSlot(settings) : null;
  const vars = {
    name: rec.candidateName || 'کارجو',
    roleTitle: job?.roleTitle || rec.roleTitle || 'این نقش',
    department: rec.departmentName,
    orgName: org.name,
    score: rec.score,
    date: slot ? `${slot.date} ساعت ${slot.time}` : null,
    signature: settings.useSignature ? org.messageSignature : '',
  };
  const tpl = templateOf(settings, decision.kind);
  return {
    kind: decision.kind,
    reason: decision.reason,
    subject: renderTemplate(tpl.subject, vars),
    body: renderTemplate(tpl.body, vars),
    suggestedAtISO: slot?.iso || null,
  };
}

/** One row of the queue, built from a candidate and the draft, ready to save. */
function buildRow(
  org: OrgPublic,
  rec: ResumeRecord,
  draft: DraftProposal,
  stamp: Date,
  existingId?: string
): db.AutomationActionRow {
  const job = db.getJob(org.id, rec.jobId);
  return {
    id: existingId || db.uid('atm'),
    orgId: org.id,
    jobId: rec.jobId,
    jobTitle: job?.roleTitle || rec.roleTitle || '—',
    departmentId: rec.departmentId,
    departmentName: rec.departmentName,
    resumeId: rec.id,
    candidateName: rec.candidateName || 'بدون نام',
    candidateEmail: candidateEmail(rec),
    kind: draft.kind,
    status: 'pending',
    reason: draft.reason,
    score: rec.score,
    category: rec.category,
    subject: draft.subject,
    body: draft.body,
    suggestedAtISO: draft.suggestedAtISO,
    interviewId: null,
    error: null,
    auto: false,
    createdAtISO: stamp.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    decidedAtISO: null,
    decidedAtJalali: null,
    decidedByName: null,
    sentAtISO: null,
  };
}

/**
 * Builds the queue for a workspace (or one opening). Idempotent: a candidate
 * never gets a second proposal for the same action unless the previous one
 * genuinely failed.
 */
export async function runAutomation(
  org: OrgPublic,
  actor: { id: string; name: string } | null,
  jobId?: string
): Promise<AutomationRunResult> {
  const settings = settingsFor(org.id);
  const result: AutomationRunResult = {
    examined: 0,
    created: 0,
    autoSent: 0,
    duplicates: 0,
    skipped: [],
    atISO: new Date().toISOString(),
  };
  if (!settings.enabled) {
    result.skipped.push({ candidateName: '—', reason: 'اتوماسیون در تنظیمات این فضای کاری خاموش است.' });
    return result;
  }

  const emailReady = isEmailConfigured(db.resolveOrgSecrets(org.id));
  for (const rec of db.listOrgResumes(org.id, jobId)) {
    if (rec.category === 'ERROR' && !rec.candidateName) continue;
    result.examined += 1;
    const draft = previewProposal(org, rec, settings);
    if ('skip' in draft) {
      // «امتیاز بین دو آستانه» is the normal middle of the funnel and would bury
      // the real blockers, so only candidates we cannot contact are reported.
      if (draft.skip.startsWith('ایمیلی')) {
        result.skipped.push({ candidateName: rec.candidateName || 'بدون نام', reason: draft.skip });
      }
      continue;
    }

    const existing = db.findAutomationAction(org.id, rec.id, draft.kind);
    if (existing && existing.status !== 'failed') {
      result.duplicates += 1;
      continue;
    }

    const row = buildRow(org, rec, draft, new Date(), existing?.id);
    db.saveAutomationAction(row);
    result.created += 1;

    // A rule the admin switched on: send now, and say so in the record.
    const auto =
      draft.kind === 'reject' ? settings.autoReject : draft.kind === 'invite' ? settings.autoInvite : false;
    if (auto && emailReady) {
      try {
        await approveAction(org, AUTOMATION_ACTOR, row, { auto: true });
        result.autoSent += 1;
      } catch (err: any) {
        result.skipped.push({ candidateName: row.candidateName, reason: err?.message || 'ارسال خودکار ممکن نشد.' });
      }
    }
  }

  db.logActivity(
    org.id,
    actor,
    'automation.run',
    `اتوماسیون ${toPersianDigits(result.created)} پیشنهاد ساخت (${toPersianDigits(result.examined)} کارجو بررسی شد)`,
    { jobId: jobId || null }
  );
  return result;
}

export interface ApproveOptions {
  subject?: string;
  body?: string;
  date?: string;
  time?: string;
  durationMin?: number;
  /** True when a workspace rule sent it, so the log never claims a human did. */
  auto?: boolean;
}

/**
 * Approves — and therefore performs — a proposal: sends the message, or books the
 * interview at the chosen slot. Everything is re-checked here, because the page
 * may have been open for a while and the mailbox can disappear meanwhile.
 */
export async function approveAction(
  org: OrgPublic,
  user: { id: string; name: string },
  action: db.AutomationActionRow,
  opts: ApproveOptions = {}
): Promise<db.AutomationActionRow> {
  if (action.status !== 'pending') {
    throw new AutomationError('این پیشنهاد قبلاً بررسی شده است.', 409, 'ACTION_NOT_PENDING');
  }
  const settings = settingsFor(org.id);
  const rec = db.getResume(org.id, action.resumeId);
  if (!rec) throw new AutomationError('این رزومه دیگر در دسترس نیست.', 404, 'RESUME_NOT_FOUND');
  const email = action.candidateEmail || candidateEmail(rec);
  const stamp = new Date();

  if (action.kind === 'schedule') {
    const slot = action.suggestedAtISO ? jalaliAndTehranTime(action.suggestedAtISO) : suggestedSlot(settings);
    const date = opts.date || slot.date;
    const time = opts.time || slot.time;
    try {
      const booked = await bookInterview({
        org,
        user,
        body: {
          jobId: action.jobId,
          resumeId: action.resumeId,
          title: `مصاحبهٔ ${action.candidateName} — ${action.jobTitle}`,
          date,
          time,
          durationMin: opts.durationMin || settings.scheduleDurationMin,
          notes: 'جلسه از طریق اتوماسیون جذب پیشنهاد و توسط منابع انسانی تأیید شد.',
          withMeet: true,
          sendInvite: true,
        },
      });
      action.status = 'sent';
      action.interviewId = booked.interview.id;
      action.sentAtISO = stamp.toISOString();
      action.decidedAtISO = stamp.toISOString();
      action.decidedAtJalali = formatJalaliDate(tehranJalaliOf(stamp), true);
      action.decidedByName = opts.auto ? AUTOMATION_ACTOR.name : user.name;
      action.auto = Boolean(opts.auto);
      // The interview exists; a calendar/email hiccup is reported, not hidden.
      action.error = booked.calendarError || booked.emailError || null;
      db.setDecision(rec, 'approved', 'اتوماسیون: جلسهٔ مصاحبه ثبت شد', user);
      db.saveAutomationAction(action);
      db.logActivity(
        org.id,
        user,
        'interview.scheduled',
        `جلسهٔ مصاحبه با «${action.candidateName}» از اتوماسیون ثبت شد (${date} ساعت ${time})`,
        { jobId: action.jobId, resumeId: action.resumeId }
      );
      return action;
    } catch (err: any) {
      action.status = 'failed';
      action.error = err?.message || 'ثبت جلسه ممکن نشد.';
      action.decidedAtISO = stamp.toISOString();
      action.decidedAtJalali = formatJalaliDate(tehranJalaliOf(stamp), true);
      action.decidedByName = user.name;
      db.saveAutomationAction(action);
      throw new AutomationError(action.error!, 502, 'SCHEDULE_FAILED');
    }
  }

  // ---- message kinds: invite / reject / request_info ----
  if (!email) throw new AutomationError('ایمیلی برای این کارجو ثبت نشده است.', 400, 'NO_EMAIL');
  const mailSecrets = db.resolveOrgSecrets(org.id).email;
  if (!mailSecrets) {
    throw new AutomationError(
      'صندوق ایمیل سازمان وصل نیست؛ در «تنظیمات ← اتصال‌ها» آن را وصل کنید.',
      409,
      'EMAIL_NOT_CONFIGURED'
    );
  }
  const cap = Math.min(EMAIL_HOURLY_LIMIT, settings.hourlyLimit);
  if (!withinEmailLimit(org.id, cap)) {
    throw new AutomationError(
      `سقف ارسال ساعتی این فضای کاری (${toPersianDigits(cap)} پیام) پر شده است؛ کمی بعد تلاش کنید.`,
      429,
      'EMAIL_RATE_LIMITED'
    );
  }

  const subject = (opts.subject || action.subject).slice(0, 200);
  const body = (opts.body || action.body).slice(0, 20_000);
  const sign =
    settings.useSignature && org.messageSignature && !body.includes(org.messageSignature)
      ? `\n\n${org.messageSignature}`
      : '';
  const text = `${body}${sign}`;

  const mail: db.SentEmailRow = {
    id: db.uid('mail'),
    orgId: org.id,
    to: email,
    subject,
    body: text,
    resumeId: rec.id,
    candidateName: rec.candidateName,
    jobId: rec.jobId,
    status: 'sent',
    error: null,
    sentAtISO: stamp.toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    sentByName: opts.auto ? AUTOMATION_ACTOR.name : user.name,
    attachments: [],
  };
  try {
    await sendMail(mailSecrets, { to: email, subject, text });
  } catch (err: any) {
    mail.status = 'failed';
    mail.error = friendlySmtpError(err);
    db.saveEmail(mail);
    action.status = 'failed';
    action.error = mail.error;
    action.decidedAtISO = stamp.toISOString();
    action.decidedAtJalali = mail.sentAtJalali;
    action.decidedByName = user.name;
    db.saveAutomationAction(action);
    db.logActivity(org.id, user, 'message.failed', `ارسال پیام اتوماسیون به «${action.candidateName}» ناموفق بود`, {
      jobId: rec.jobId,
      resumeId: rec.id,
    });
    throw new AutomationError(mail.error!, 502, 'EMAIL_SEND_FAILED');
  }

  noteEmailSend(org.id);
  db.saveEmail(mail);
  db.markMessageSent(rec);
  if (action.kind === 'reject') {
    db.setDecision(rec, 'rejected', 'اتوماسیون: نامهٔ نتیجه فرستاده شد', user);
  } else {
    db.setDecision(
      rec,
      'approved',
      action.kind === 'invite' ? 'اتوماسیون: دعوت به مصاحبه فرستاده شد' : 'اتوماسیون: درخواست اطلاعات تکمیلی',
      user
    );
  }

  action.status = 'sent';
  action.subject = subject;
  action.body = body;
  action.sentAtISO = stamp.toISOString();
  action.decidedAtISO = stamp.toISOString();
  action.decidedAtJalali = mail.sentAtJalali;
  action.decidedByName = opts.auto ? AUTOMATION_ACTOR.name : user.name;
  action.auto = Boolean(opts.auto);
  action.error = null;
  db.saveAutomationAction(action);
  db.logActivity(org.id, user, 'message.sent', `پیام «${subject}» از اتوماسیون برای «${action.candidateName}» فرستاده شد`, {
    jobId: rec.jobId,
    resumeId: rec.id,
  });
  return action;
}

/** «کنار گذاشتن» — the recruiter decides this candidate needs nothing right now. */
export function skipAction(action: db.AutomationActionRow, user: { id: string; name: string }, note?: string): db.AutomationActionRow {
  if (action.status !== 'pending') {
    throw new AutomationError('این پیشنهاد قبلاً بررسی شده است.', 409, 'ACTION_NOT_PENDING');
  }
  const stamp = new Date();
  action.status = 'skipped';
  action.error = note?.trim()
    ? note.trim().slice(0, 300)
    : 'بدون پیام؛ توسط منابع انسانی کنار گذاشته شد.';
  action.decidedAtISO = stamp.toISOString();
  action.decidedAtJalali = formatJalaliDate(tehranJalaliOf(stamp), true);
  action.decidedByName = user.name;
  return db.saveAutomationAction(action);
}

/** Everything the «اتوماسیون جذب» page renders, in one request. */
export function overview(orgId: string, opts: { jobId?: string } = {}): AutomationOverview {
  const settings = settingsFor(orgId);
  const all = db.listAutomationActions(orgId, { jobId: opts.jobId, limit: 400 });
  const queue = all.filter((a) => a.status === 'pending').slice(0, 200);
  const history = all.filter((a) => a.status !== 'pending').slice(0, 60);
  const count = (s: string) => all.filter((a) => a.status === s).length;

  const resumes = db.listOrgResumes(orgId, opts.jobId);
  const withoutEmail = resumes.filter(
    (r) => r.category !== 'ERROR' && !r.unjudgeableReason && !candidateEmail(r)
  ).length;
  const analysing = resumes.filter((r) => r.category === 'ERROR' || r.decisionStatus === 'none' && r.score === 0).length;

  return {
    settings,
    queue: queue.map(db.withoutOrg),
    history: history.map(db.withoutOrg),
    counts: {
      pending: count('pending'),
      sent: count('sent'),
      skipped: count('skipped'),
      failed: count('failed'),
    },
    readiness: {
      emailConfigured: isEmailConfigured(db.resolveOrgSecrets(orgId)),
      calendarConnected: calendarStatus(db.resolveOrgSecrets(orgId), null).connected,
      withoutEmail,
      analysing,
    },
  };
}

export function proposalOf(orgId: string, id: string): db.AutomationActionRow {
  const action = db.getAutomationAction(orgId, id);
  if (!action) throw new AutomationError('این پیشنهاد پیدا نشد.', 404, 'ACTION_NOT_FOUND');
  return action;
}

export type { AutomationProposal };

/**
 * «پیگیری درخواست» — the candidate's own window into the pipeline.
 *
 * Design rules:
 *   • **One link per application, revocable.** A token is random, unguessable,
 *     expires after 120 days, and HR can kill it in one click.
 *   • **The wording is the candidate's, not the board's.** «در حال بررسی»،
 *     «مرحلهٔ مصاحبه» — never «رد‌شده» and never an internal stage name.
 *   • **Nothing about anyone else, ever.** No scores, notes, interviewers,
 *     other candidates, or the reason for a decision. A closed application says
 *     it is closed and offers a human e-mail.
 *   • **It reflects the record, not a guess.** The state comes from the stage and
 *     the offer/interview tables; the date shown is the real last change.
 */
import crypto from 'crypto';
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { PublicStageState, PublicStatus, PublicStatusStep, StatusLink } from '../src/types/status';
import type { StageKind } from '../src/types/pipeline';
import type { Job, ResumeRecord } from '../src/types/screening';

export class StatusError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'STATUS_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TTL_DAYS = 120;
const DAY = 86_400_000;

/** The five steps a candidate sees, in order. «closed» is not a step. */
const FLOW: { key: Exclude<PublicStageState, 'closed'>; label: string }[] = [
  { key: 'received', label: 'ثبت درخواست' },
  { key: 'screening', label: 'بررسی اولیه' },
  { key: 'interview', label: 'مصاحبه' },
  { key: 'offer', label: 'پیشنهاد شغلی' },
  { key: 'hired', label: 'شروع همکاری' },
];

const KIND_TO_STATE: Record<StageKind, PublicStageState> = {
  applied: 'received',
  screening: 'screening',
  interview: 'interview',
  offer: 'offer',
  hired: 'hired',
  rejected: 'closed',
};

const KIND_INDEX: Record<StageKind, number> = {
  applied: 0,
  screening: 1,
  interview: 2,
  offer: 3,
  hired: 4,
  rejected: 1,
};

const MESSAGE: Record<PublicStageState, string> = {
  received: 'درخواست شما ثبت شد و در نوبت بررسی قرار دارد. اگر مدرک یا توضیحی لازم باشد، از همین ایمیل با شما تماس می‌گیریم.',
  screening: 'رزومهٔ شما در حال بررسی است. این مرحله معمولاً چند روز کاری طول می‌کشد و اگر برای ادامه انتخاب شوید، برای مصاحبه پیام می‌دهیم.',
  interview: 'در حال هماهنگی یا انجام مصاحبه هستیم. جزئیات زمان از طریق ایمیل یا پیامک با شما هماهنگ می‌شود.',
  offer: 'پیشنهاد شغلی برای شما آماده شده یا فرستاده شده است. اگر سؤالی دربارهٔ شرایط دارید، همین‌جا پاسخ دهید.',
  hired: 'به تیم خوش آمدید. هماهنگی‌های روز اول از طرف منابع انسانی با شما گرفته می‌شود.',
  closed: 'این درخواست بسته شده است. ممنون که وقت گذاشتید؛ اگر می‌خواهید بازخورد بگیرید یا برای موقعیت‌های بعدی در فهرست ما بمانید، به ایمیل زیر بنویسید.',
};

function stateOf(rec: ResumeRecord, job: Job | null): PublicStageState {
  const stage = db.stagesOf(job).find((s) => s.id === rec.stageId);
  if (!stage) return 'received';
  return KIND_TO_STATE[stage.kind] || 'received';
}

function stepsFor(state: PublicStageState, kind: StageKind): PublicStatusStep[] {
  const reached = KIND_INDEX[kind] ?? 0;
  return FLOW.map((step, i) => {
    if (state === 'closed') {
      // Only the steps the application actually passed stay «done»; the rest are
      // removed from the list rather than left greyed out forever.
      if (i > reached) return { key: step.key, label: step.label, state: 'upcoming' as const };
      return { key: step.key, label: step.label, state: i < reached ? ('done' as const) : ('current' as const) };
    }
    if (i < KIND_INDEX[kind]) return { key: step.key, label: step.label, state: 'done' as const };
    if (i === KIND_INDEX[kind]) return { key: step.key, label: step.label, state: 'current' as const };
    return { key: step.key, label: step.label, state: 'upcoming' as const };
  }).filter((s) => state !== 'closed' || s.state !== 'upcoming');
}

function linkView(row: db.StatusLinkRow): StatusLink {
  const { orgId: _o, token, ...rest } = row;
  return { ...rest, url: `/status/${token}` };
}

/** One live link per candidate: creating a new one revokes the old. */
export function createLink(orgId: string, resumeId: string, actorName: string | null): StatusLink {
  const rec = db.getResume(orgId, resumeId);
  if (!rec) throw new StatusError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');
  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  for (const old of db.listStatusLinks(orgId, { resumeId })) {
    if (!old.revokedAtISO) db.saveStatusLink({ ...old, revokedAtISO: new Date().toISOString() });
  }
  const now = new Date();
  const row: db.StatusLinkRow = {
    id: db.uid('stl'),
    orgId,
    resumeId,
    candidateName: rec.candidateName || rec.fileName || 'کارجو',
    jobId: rec.jobId || null,
    jobTitle: job?.roleTitle || null,
    token: crypto.randomBytes(24).toString('base64url'),
    createdAtISO: now.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(now), true),
    revokedAtISO: null,
    expiresAtISO: new Date(now.getTime() + TTL_DAYS * DAY).toISOString(),
    expiresAtJalali: formatJalaliDate(tehranJalaliOf(new Date(now.getTime() + TTL_DAYS * DAY)), true),
    views: 0,
    lastViewedAtISO: null,
    sentAtISO: null,
    sentAtJalali: null,
    sentTo: null,
  };
  db.saveStatusLink(row);
  db.logActivity(orgId, actorName ? { id: 'actor', name: actorName } : null, 'status.link', `لینک پیگیری درخواست «${row.candidateName}» را ساخت`, {
    jobId: row.jobId,
    resumeId,
  });
  return linkView(row);
}

export function revokeLink(orgId: string, id: string): StatusLink {
  const row = db.getStatusLink(orgId, id);
  if (!row) throw new StatusError('این لینک پیدا نشد.', 404, 'LINK_NOT_FOUND');
  const saved = db.saveStatusLink({ ...row, revokedAtISO: row.revokedAtISO || new Date().toISOString() });
  return linkView(saved);
}

/** HR pressed «فرستادن با ایمیل سازمان» — recorded on the link itself. */
export function markLinkSent(orgId: string, id: string, to: string): StatusLink {
  const row = db.getStatusLink(orgId, id);
  if (!row) throw new StatusError('این لینک پیدا نشد.', 404, 'LINK_NOT_FOUND');
  const now = new Date();
  const saved = db.saveStatusLink({
    ...row,
    sentAtISO: now.toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(now), true),
    sentTo: to,
  });
  return linkView(saved);
}

/** The plain-text letter that carries the link. Short, honest, no scores. */
export function statusEmailText(opts: { candidateName: string; orgName: string; jobTitle: string; link: string; expiresJalali: string }): string {
  return [
    `${opts.candidateName} عزیز،`,
    '',
    `وضعیت درخواست شما برای «${opts.jobTitle}» در ${opts.orgName} را می‌توانید در همین صفحه ببینید:`,
    opts.link,
    '',
    `این صفحه فقط مرحلهٔ فعلی را نشان می‌دهد و هیچ امتیاز یا یادداشت داخلی در آن نیست. لینک تا ${opts.expiresJalali} معتبر است؛ اگر بسته شد، از منابع انسانی لینک تازه بخواهید.`,
    '',
    'با احترام',
    opts.orgName,
  ].join('\n');
}

export function listLinks(orgId: string, resumeId: string): StatusLink[] {
  return db.listStatusLinks(orgId, { resumeId }).map(linkView);
}

/**
 * The public page. Opening it marks a view — HR should know whether the person
 * actually read the update, and the candidate should not have to wonder.
 */
export function publicStatus(token: string): PublicStatus {
  const row = db.findStatusLinkByToken(token);
  if (!row) throw new StatusError('این لینک پیدا نشد. لطفاً از منابع انسانی لینک تازه بخواهید.', 404, 'LINK_NOT_FOUND');
  if (row.revokedAtISO) {
    throw new StatusError('این لینک غیرفعال شده است. برای اطلاع از وضعیت، با منابع انسانی تماس بگیرید.', 410, 'LINK_REVOKED');
  }
  if (new Date(row.expiresAtISO).getTime() < Date.now()) {
    throw new StatusError('این لینک منقضی شده است. لطفاً از منابع انسانی لینک تازه بخواهید.', 410, 'LINK_EXPIRED');
  }

  const rec = db.getResume(row.orgId, row.resumeId);
  if (!rec) throw new StatusError('این درخواست دیگر در دسترس نیست.', 410, 'APPLICATION_GONE');
  const job = rec.jobId ? db.getJob(row.orgId, rec.jobId) : null;
  const org = db.getOrg(row.orgId);
  const stage = db.stagesOf(job).find((s) => s.id === rec.stageId);
  const kind: StageKind = stage?.kind || 'applied';
  const state = KIND_TO_STATE[kind] || 'received';

  const upcoming = db
    .listInterviews(row.orgId, { resumeId: row.resumeId })
    .filter((i) => new Date(i.startsAtISO).getTime() > Date.now() - 60 * 60_000)
    .sort((a, b) => a.startsAtISO.localeCompare(b.startsAtISO))[0];

  const saved = db.saveStatusLink({ ...row, views: row.views + 1, lastViewedAtISO: new Date().toISOString() });
  const updated = rec.updatedAtISO || saved.createdAtISO;

  return {
    orgName: org?.name || 'سازمان',
    candidateName: row.candidateName,
    jobTitle: job?.roleTitle || row.jobTitle || 'موقعیت شغلی',
    state,
    message: MESSAGE[state],
    steps: stepsFor(state, kind),
    updatedAtJalali: formatJalaliDate(tehranJalaliOf(new Date(updated)), true),
    expiresAtJalali: row.expiresAtJalali,
    nextInterviewJalali: upcoming ? formatJalaliDate(tehranJalaliOf(new Date(upcoming.startsAtISO)), true) : null,
    contactEmail: db.resolveOrgSecrets(row.orgId).email?.fromAddress || null,
  };
}


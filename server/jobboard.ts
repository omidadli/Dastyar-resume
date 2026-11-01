/**
 * «انتشار در جاب‌بورد» — the copy, the record, and the honest limits.
 *
 * What this module does:
 *   • writes one paste-ready ad per opening (plain text, plus the schema.org
 *     `JobPosting` the workspace's own page already serves);
 *   • keeps a record of where a human posted it, with the board's link and the
 *     Jalali date, so «آیا جابینجا گذاشتیم؟» has an answer;
 *   • names, per board, what is needed before posting — an employer account and
 *     a paid posting contract — instead of a disabled button that explains
 *     nothing.
 *
 * What it does not do, on purpose: send anything to a board. No Iranian job board
 * offers a public write API; posting is a contract plus a human in a form. A
 * «publish» button that quietly did nothing would be worse than none.
 */
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import {
  JOB_BOARDS,
  JOB_BOARD_LABEL,
  type JobBoardId,
  type JobPublication,
  type PublicationKit,
  type PublicationsView,
  type PublicationStatus,
} from '../src/types/jobboard';
import type { Job } from '../src/types/screening';
import { EMPLOYMENT_LABELS } from '../src/lib/match';
import type { OrgPublic } from '../src/types/app';

const BOARD_IDS = new Set(JOB_BOARDS.map((b) => b.id));
const STATUSES: PublicationStatus[] = ['submitted', 'live', 'expired', 'removed'];

export function boardIdOf(value: unknown): JobBoardId | null {
  const id = String(value || '').trim() as JobBoardId;
  return BOARD_IDS.has(id) ? id : null;
}

function viewOf(row: db.PublicationRow): JobPublication {
  return {
    id: row.id,
    jobId: row.jobId,
    board: (boardIdOf(row.board) || 'other') as JobBoardId,
    status: (STATUSES.includes(row.status as PublicationStatus) ? row.status : 'submitted') as PublicationStatus,
    url: row.url,
    note: row.note,
    postedAtISO: row.postedAtISO,
    postedAtJalali: row.postedAtJalali,
    postedByName: row.postedByName,
    closedAtISO: row.closedAtISO,
  };
}

/** The workspace's own public page for this opening, when it is published. */
export function portalUrlFor(org: OrgPublic, job: Job, origin: string): string | null {
  if (!job.isPublic) return null;
  return `${origin.replace(/\/$/, '')}/careers/${org.careerSlug}/jobs/${job.id}`;
}

export function publicationsView(org: OrgPublic, job: Job, origin: string): PublicationsView {
  const items = db.listPublications(org.id, job.id).map(viewOf);
  const live = items.filter((i) => i.status === 'live').length;
  return {
    jobId: job.id,
    items,
    boards: JOB_BOARDS.map((b) => ({
      ...b,
      count: items.filter((i) => i.board === b.id).length,
      live: items.some((i) => i.board === b.id && i.status === 'live'),
    })),
    portalUrl: portalUrlFor(org, job, origin),
    isPublic: Boolean(job.isPublic),
    readyToPost: Boolean(job.isPublic && job.status === 'open'),
    counts: { total: items.length, live, removed: items.filter((i) => i.status === 'removed').length },
  };
}

/**
 * The ad as a person would paste it. Facts only — every line comes from the
 * opening itself, and a line we do not have is left out rather than invented.
 */
export function kitFor(org: OrgPublic, job: Job, board: JobBoardId, origin: string): PublicationKit {
  const meta = JOB_BOARDS.find((b) => b.id === board) || JOB_BOARDS[JOB_BOARDS.length - 1];
  const portalUrl = portalUrlFor(org, job, origin);
  const applyLine = portalUrl
    ? `برای دیدن جزئیات و ارسال درخواست: ${portalUrl}`
    : 'این آگهی هنوز در صفحهٔ استخدام ما منتشر نشده است؛ اول از «فرصت شغلی» آن را منتشر کنید تا لینک درخواست داشته باشید.';

  const lines = [
    `${job.roleTitle} — ${org.name}`,
    '',
    job.departmentName ? `دپارتمان: ${job.departmentName}` : '',
    job.location ? `محل کار: ${job.location}` : '',
    job.employmentType ? `نوع همکاری: ${EMPLOYMENT_LABELS[job.employmentType] || job.employmentType}` : '',
    job.applyByJalali ? `مهلت درخواست: ${job.applyByJalali}` : '',
    '',
    (job.extraNotes || job.understanding?.plainExplanation || '').trim(),
    '',
    applyLine,
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '');

  // Ask the board for what we actually do not have, instead of guessing it.
  const missing: string[] = [];
  if (!job.location) missing.push('محل کار');
  if (!job.employmentType) missing.push('نوع همکاری (تمام‌وقت/پاره‌وقت/دورکاری)');
  if (!job.extraNotes) missing.push('شرح شغل');
  if (!portalUrl) missing.push('لینک درخواست (آگهی عمومی نشده)');

  return {
    board: meta.id,
    boardLabel: meta.label,
    title: job.roleTitle,
    text: lines.join('\n').trim(),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'JobPosting',
      title: job.titleEn || job.roleTitle,
      description: (job.descriptionEn || job.extraNotes || job.understanding?.plainExplanation || '').slice(0, 5000),
      datePosted: job.publishedAtISO || job.createdAtISO,
      hiringOrganization: { '@type': 'Organization', name: org.name },
      jobLocation: {
        '@type': 'Place',
        address: { '@type': 'PostalAddress', ...(job.location ? { addressLocality: job.location } : {}), addressCountry: 'IR' },
      },
      ...(portalUrl ? { url: portalUrl, directApply: true } : {}),
      ...(job.applyByISO ? { validThrough: job.applyByISO } : {}),
    },
    portalUrl,
    requires: meta.requires,
    missing,
  };
}

export interface PublicationInput {
  board?: unknown;
  url?: unknown;
  note?: unknown;
  status?: unknown;
}

/** Records a posting a human made. Nothing leaves the workspace. */
export function recordPublication(
  org: OrgPublic,
  job: Job,
  input: PublicationInput,
  actor: { id: string; name: string }
): JobPublication {
  const board = boardIdOf(input.board);
  if (!board) {
    throw Object.assign(new Error('جاب‌بورد را انتخاب کنید.'), { status: 400, code: 'BAD_BOARD' });
  }
  const url = String(input.url || '').trim().slice(0, 500);
  if (url && !/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error('لینک آگهی باید با http یا https شروع شود.'), { status: 400, code: 'BAD_URL' });
  }
  const stamp = new Date();
  const status = (STATUSES.includes(input.status as PublicationStatus) ? input.status : 'live') as PublicationStatus;
  const row: db.PublicationRow = {
    id: db.uid('pub'),
    orgId: org.id,
    jobId: job.id,
    board,
    status,
    url: url || null,
    note: String(input.note || '').slice(0, 400),
    postedAtISO: stamp.toISOString(),
    postedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    postedByUserId: actor.id,
    postedByName: actor.name,
    closedAtISO: null,
  };
  db.savePublication(row);
  return viewOf(row);
}

/** Changes the state of a posting: it went live, expired, or was taken down. */
export function updatePublication(
  org: OrgPublic,
  id: string,
  input: PublicationInput
): JobPublication | null {
  const row = db.getPublication(org.id, id);
  if (!row) return null;
  const status = STATUSES.includes(input.status as PublicationStatus)
    ? (input.status as PublicationStatus)
    : (row.status as PublicationStatus);
  const url = input.url === undefined ? row.url : String(input.url || '').trim().slice(0, 500) || null;
  if (url && !/^https?:\/\//i.test(url)) {
    throw Object.assign(new Error('لینک آگهی باید با http یا https شروع شود.'), { status: 400, code: 'BAD_URL' });
  }
  const closed = status === 'removed' || status === 'expired';
  return viewOf(
    db.savePublication({
      ...row,
      status,
      url,
      note: input.note === undefined ? row.note : String(input.note || '').slice(0, 400),
      // Keep the first closing moment: a posting that was withdrawn stays dated.
      closedAtISO: closed ? row.closedAtISO || new Date().toISOString() : null,
    })
  );
}

export function boardLabel(id: JobBoardId): string {
  return JOB_BOARD_LABEL[id];
}

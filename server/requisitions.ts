/**
 * «نیازمندسنجی و سرفصل نیرو» — a hiring request that carries numbers.
 *
 * What this module refuses to do, on purpose:
 *   • **no self-approval.** The person who asked cannot approve, even if they are
 *     an admin — otherwise the control is decoration. (The only exception is a
 *     workspace whose only admin is the requester; then the page says so instead
 *     of hiding the button.) That exception is implemented as: approval needs a
 *     different user id.
 *   • **no silent seat changes.** An approver may grant fewer seats; the change is
 *     written to the row's history with the note, and the number asked for stays
 *     visible.
 *   • **no hand-typed «filled».** Filled seats are counted from accepted offers on
 *     the attached openings, so nobody can close a requisition by typing a number.
 *   • **no invisible gate.** «انتشار آگهی فقط با نیازمندسنجی تأییدشده» is a
 *     workspace setting, off by default, and the refusal names the reason.
 */
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import {
  PRIORITY_LABEL,
  type Requisition,
  type RequisitionHistoryEntry,
  type RequisitionPriority,
  type RequisitionRollup,
  type RequisitionSeniority,
  type RequisitionSettings,
  type RequisitionStatus,
  type RequisitionSummaryRow,
  type RequisitionWorkMode,
  type SalaryBasis,
} from '../src/types/requisition';

export class RequisitionError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'REQUISITION_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_SLOTS = 100;

function jalali(iso: string | null): string | null {
  return iso ? formatJalaliDate(tehranJalaliOf(new Date(iso)), true) : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v || '');
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

const PRIORITIES: readonly RequisitionPriority[] = ['low', 'normal', 'high', 'critical'];
const SENIORITIES: readonly RequisitionSeniority[] = ['junior', 'mid', 'senior', 'lead'];
const WORK_MODES: readonly RequisitionWorkMode[] = ['onsite', 'hybrid', 'remote'];
const BASIS: readonly SalaryBasis[] = ['gross_monthly', 'total_monthly'];

// ------------------------------------------------------------------- view ---

/** Accepted offers on the openings attached to this requisition. */
export function filledOf(row: db.RequisitionRow): number {
  const jobs = db.listJobs(row.orgId).filter((j) => j.requisitionId === row.id);
  let filled = 0;
  for (const job of jobs) {
    for (const offer of db.listOffers(row.orgId, { jobId: job.id })) if (offer.status === 'accepted') filled++;
  }
  return filled;
}

export function jobsOf(row: db.RequisitionRow) {
  return db.listJobs(row.orgId).filter((j) => j.requisitionId === row.id);
}

/** Effective status: an approved requisition becomes «تکمیل‌شده» once its seats are used. */
export function effectiveStatus(row: db.RequisitionRow, filled = filledOf(row)): RequisitionStatus {
  if (row.status !== 'approved') return row.status;
  const granted = row.approvedSlots ?? row.slots;
  return filled >= granted ? 'filled' : 'approved';
}

export function supportsHeadcount(row: db.RequisitionRow, filled = filledOf(row)): boolean {
  const status = effectiveStatus(row, filled);
  if (status !== 'approved') return false;
  const granted = row.approvedSlots ?? row.slots;
  return filled < granted;
}

export function viewOf(row: db.RequisitionRow): Requisition {
  const filled = filledOf(row);
  const granted = row.approvedSlots ?? row.slots;
  const jobs = jobsOf(row);
  const mid = row.salaryMin !== null && row.salaryMax !== null ? (row.salaryMin + row.salaryMax) / 2 : (row.salaryMin ?? row.salaryMax);
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    departmentId: row.departmentId,
    departmentName: row.departmentName,
    hiringManagerName: row.hiringManagerName,
    requestedByName: row.requestedByName,
    status: effectiveStatus(row, filled),
    priority: row.priority,
    seniority: row.seniority,
    employmentType: row.employmentType,
    workMode: row.workMode,
    location: row.location,
    slots: row.slots,
    approvedSlots: row.approvedSlots,
    salaryMin: row.salaryMin,
    salaryMax: row.salaryMax,
    salaryBasis: row.salaryBasis,
    justification: row.justification,
    targetStartISO: row.targetStartISO,
    targetStartJalali: jalali(row.targetStartISO),
    createdAtISO: row.createdAtISO,
    createdAtJalali: jalali(row.createdAtISO) || '',
    updatedAtISO: row.updatedAtISO,
    submittedAtISO: row.submittedAtISO,
    decidedAtISO: row.decidedAtISO,
    decidedAtJalali: jalali(row.decidedAtISO),
    decidedByName: row.decidedByName,
    decisionNote: row.decisionNote,
    jobIds: jobs.map((j) => j.id),
    jobTitles: jobs.map((j) => j.roleTitle),
    filled,
    remaining: Math.max(0, (row.approvedSlots ?? row.slots) - filled),
    complete: filled >= granted && (row.status === 'approved' || row.status === 'filled'),
    monthlyCost: mid === null ? null : Math.round(mid * granted),
    overBandOffers: jobs.flatMap((job) =>
      db
        .listOffers(row.orgId, { jobId: job.id })
        .filter((o) => o.band?.status === 'above' && o.status !== 'cancelled' && o.status !== 'superseded')
        .map((o) => ({
          offerId: o.id,
          candidateName: o.candidateName,
          monthly: o.band?.offerMonthly ?? null,
          reason: o.band?.overrideReason ?? null,
          status: o.status,
        }))
    ),
    history: row.history || [],
  };
}

export function summaryOf(row: db.RequisitionRow): RequisitionSummaryRow {
  const view = viewOf(row);
  return { ...view, openForHiring: supportsHeadcount(row) };
}

// ------------------------------------------------------------------ write ---

function pushHistory(row: db.RequisitionRow, byName: string, action: string, note: string, atISO = new Date().toISOString()): RequisitionHistoryEntry[] {
  return [
    ...(row.history || []),
    { atISO, atJalali: jalali(atISO) || '', byName, action, note },
  ].slice(-60);
}

/** The next `REQ-<jalali year>-<nnn>` handle for this workspace. */
function nextCode(orgId: string): string {
  // Latin digits on purpose: this is a handle people paste into a ticket or a
  // budget spreadsheet, not a Persian sentence.
  const year = String(tehranJalaliOf(new Date()).year || 1404);
  const existing = db
    .listRequisitions(orgId)
    .map((r) => r.code)
    .filter((c) => c.startsWith(`REQ-${year}-`));
  let max = 0;
  for (const code of existing) {
    const n = Number(code.split('-')[2]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `REQ-${year}-${String(max + 1).padStart(3, '0')}`;
}

export interface RequisitionInput {
  title?: unknown;
  departmentId?: unknown;
  hiringManagerId?: unknown;
  slots?: unknown;
  priority?: unknown;
  seniority?: unknown;
  employmentType?: unknown;
  workMode?: unknown;
  location?: unknown;
  salaryMin?: unknown;
  salaryMax?: unknown;
  salaryBasis?: unknown;
  justification?: unknown;
  targetStartISO?: unknown;
}

/** Read + validate an editable payload. Shared by create and edit. */
function readInput(orgId: string, body: RequisitionInput, existing?: db.RequisitionRow) {
  const title = String(body.title ?? existing?.title ?? '').trim().slice(0, 120);
  if (title.length < 2) throw new RequisitionError('عنوان شغلی نیازمندسنجی را بنویسید.', 400, 'TITLE_REQUIRED');

  const departmentId = String(body.departmentId ?? existing?.departmentId ?? '');
  const org = db.getOrg(orgId);
  const dept = org?.departments.find((d) => d.id === departmentId);
  if (!dept) throw new RequisitionError('دپارتمان انتخاب‌شده معتبر نیست.', 400, 'DEPARTMENT_REQUIRED');

  const slots = body.slots === undefined ? (existing?.slots ?? 1) : Number(body.slots);
  if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) {
    throw new RequisitionError(`تعداد نیرو باید بین ۱ تا ${MAX_SLOTS} باشد.`, 400, 'BAD_SLOTS');
  }

  const salaryMin = body.salaryMin === undefined ? (existing?.salaryMin ?? null) : num(body.salaryMin);
  const salaryMax = body.salaryMax === undefined ? (existing?.salaryMax ?? null) : num(body.salaryMax);
  if (salaryMin !== null && salaryMax !== null && salaryMin > salaryMax) {
    throw new RequisitionError('کف بازهٔ حقوق نمی‌تواند از سقف بیشتر باشد.', 400, 'BAD_SALARY_RANGE');
  }
  if (salaryMax !== null && salaryMax > 2_000_000_000) {
    throw new RequisitionError('سقف حقوق خارج از محدودهٔ معقول است.', 400, 'BAD_SALARY_RANGE');
  }

  const targetRaw = body.targetStartISO === undefined ? existing?.targetStartISO ?? null : body.targetStartISO ? String(body.targetStartISO) : null;
  let targetStartISO: string | null = null;
  if (targetRaw) {
    const d = new Date(targetRaw);
    if (Number.isNaN(d.getTime())) throw new RequisitionError('تاریخ شروع هدف معتبر نیست.', 400, 'BAD_DATE');
    targetStartISO = d.toISOString();
  }

  const hiringManagerId = body.hiringManagerId === undefined ? (existing?.hiringManagerId ?? null) : body.hiringManagerId ? String(body.hiringManagerId) : null;
  const manager = hiringManagerId ? db.listMembers(orgId).find((u) => u.id === hiringManagerId) : null;

  return {
    title,
    departmentId: dept.id,
    departmentName: dept.name,
    hiringManagerId: manager?.id ?? null,
    hiringManagerName: manager?.name ?? '',
    slots,
    priority: oneOf(body.priority ?? existing?.priority, PRIORITIES, 'normal'),
    seniority: oneOf(body.seniority ?? existing?.seniority, SENIORITIES, 'mid'),
    employmentType: String(body.employmentType ?? existing?.employmentType ?? 'full-time').slice(0, 40),
    workMode: oneOf(body.workMode ?? existing?.workMode, WORK_MODES, 'onsite'),
    location: String(body.location ?? existing?.location ?? '').trim().slice(0, 80),
    salaryMin,
    salaryMax,
    salaryBasis: oneOf(body.salaryBasis ?? existing?.salaryBasis, BASIS, 'gross_monthly'),
    justification: String(body.justification ?? existing?.justification ?? '').trim().slice(0, 2000),
    targetStartISO,
  };
}

export function createRequisition(orgId: string, actor: { id: string; name: string }, body: RequisitionInput): db.RequisitionRow {
  const input = readInput(orgId, body);
  const now = new Date().toISOString();
  const row: db.RequisitionRow = {
    id: db.uid('req'),
    orgId,
    code: nextCode(orgId),
    ...input,
    requestedById: actor.id,
    requestedByName: actor.name,
    status: 'draft',
    approvedSlots: null,
    submittedAtISO: null,
    decidedAtISO: null,
    decidedById: null,
    decidedByName: null,
    decisionNote: null,
    createdAtISO: now,
    updatedAtISO: now,
    history: [{ atISO: now, atJalali: jalali(now) || '', byName: actor.name, action: 'created', note: '' }],
  };
  db.saveRequisition(row);
  db.logActivity(orgId, actor, 'requisition.created', `نیازمندسنجی «${row.title}» (${row.code}) ساخته شد`, {});
  return row;
}

export function updateRequisition(orgId: string, id: string, actor: { id: string; name: string }, body: RequisitionInput): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  if (row.status !== 'draft' && row.status !== 'rejected') {
    throw new RequisitionError('فقط پیش‌نویس یا درخواست رد‌شده ویرایش می‌شود؛ برای تغییر یک درخواست تأییدشده، درخواست تازه بسازید.', 409, 'NOT_EDITABLE');
  }
  const input = readInput(orgId, body, row);
  const next = db.saveRequisition({
    ...row,
    ...input,
    // A rejected request that is edited goes back to draft: it has to be submitted again.
    status: 'draft',
    updatedAtISO: new Date().toISOString(),
    history: pushHistory(row, actor.name, 'edited', ''),
  });
  db.logActivity(orgId, actor, 'requisition.updated', `نیازمندسنجی «${next.title}» ویرایش شد`, {});
  return next;
}

export function submitForApproval(orgId: string, id: string, actor: { id: string; name: string }): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  if (row.status !== 'draft' && row.status !== 'rejected') {
    throw new RequisitionError('این درخواست در وضعیتی نیست که برای تأیید فرستاده شود.', 409, 'NOT_SUBMITTABLE');
  }
  if (row.justification.trim().length < 20) {
    throw new RequisitionError('دلیل نیاز به این نیرو را بنویسید (دست‌کم ۲۰ نویسه): چه کاری زمین می‌ماند اگر این پست پر نشود؟', 400, 'JUSTIFICATION_REQUIRED');
  }
  const now = new Date().toISOString();
  const next = db.saveRequisition({
    ...row,
    status: 'pending',
    submittedAtISO: now,
    updatedAtISO: now,
    history: pushHistory(row, actor.name, 'submitted', ''),
  });
  db.logActivity(orgId, actor, 'requisition.submitted', `نیازمندسنجی «${row.title}» برای تأیید فرستاده شد`, {});
  return next;
}

/** May this user decide it? Approvers come from settings; admins/owners by default. */
export function canApprove(
  orgId: string,
  row: db.RequisitionRow,
  user: { id: string; role: string }
): { allowed: boolean; reason: string | null; selfApprovalOnly: boolean } {
  if (row.status !== 'pending') return { allowed: false, reason: 'این درخواست در انتظار تأیید نیست.', selfApprovalOnly: false };
  const settings = db.getRequisitionSettings(orgId);
  const isAdmin = user.role === 'admin' || user.role === 'owner';
  const named = settings.approverUserIds;
  const eligible = (id: string, role: string) => id !== row.requestedById && (named.includes(id) || role === 'admin' || role === 'owner');
  const others = db.listMembers(orgId).filter((u) => eligible(u.id, u.role)).length;

  if (row.requestedById === user.id) {
    // A one-person workspace still has to be able to approve its own hiring, but
    // it must say so out loud — and the moment a second approver exists, the
    // door closes again.
    if (others === 0 && (isAdmin || named.includes(user.id))) {
      return {
        allowed: true,
        reason: 'در این فضای کاری تأییدکنندهٔ دیگری نیست؛ تأیید شما در تاریخچه با همین توضیح ثبت می‌شود.',
        selfApprovalOnly: true,
      };
    }
    return { allowed: false, reason: 'درخواست‌دهنده نمی‌تواند درخواست خودش را تأیید کند.', selfApprovalOnly: false };
  }
  if (named.includes(user.id)) return { allowed: true, reason: null, selfApprovalOnly: false };
  if (isAdmin) return { allowed: true, reason: null, selfApprovalOnly: false };
  return { allowed: false, reason: 'تأیید نیازمندسنجی با مدیران فضای کاری یا تأییدکنندگان تعیین‌شده است.', selfApprovalOnly: false };
}

export function decide(
  orgId: string,
  id: string,
  user: { id: string; name: string; role: string },
  body: { decision?: unknown; note?: unknown; approvedSlots?: unknown }
): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  const gate = canApprove(orgId, row, user);
  if (!gate.allowed) throw new RequisitionError(gate.reason || 'اجازهٔ تأیید ندارید.', gate.reason?.includes('نمی‌تواند') ? 403 : 409, 'NOT_APPROVER');

  const decision = String(body.decision || '') === 'rejected' ? 'rejected' : 'approved';
  const note = String(body.note || '').trim().slice(0, 800);
  if (decision === 'rejected' && note.length < 5) {
    throw new RequisitionError('برای رد، دلیل را بنویسید تا درخواست‌دهنده بداند چه چیزی را باید اصلاح کند.', 400, 'NOTE_REQUIRED');
  }
  let granted: number | null = null;
  if (decision === 'approved') {
    granted = body.approvedSlots === undefined || body.approvedSlots === null ? row.slots : Number(body.approvedSlots);
    if (!Number.isInteger(granted) || granted < 1 || granted > row.slots) {
      throw new RequisitionError(`تعداد تأییدشده باید بین ۱ تا ${row.slots} باشد (بیش از درخواست، تأیید نمی‌شود).`, 400, 'BAD_APPROVED_SLOTS');
    }
  }
  const now = new Date().toISOString();
  const change = decision === 'approved' && granted !== row.slots ? ` — ${row.slots} خواسته شده بود، ${granted} تأیید شد` : '';
  const selfNote = gate.selfApprovalOnly ? ' (تنها تأییدکنندهٔ فضای کاری، خودِ درخواست‌دهنده بود)' : '';
  const next = db.saveRequisition({
    ...row,
    status: decision === 'approved' ? 'approved' : 'rejected',
    approvedSlots: decision === 'approved' ? granted : null,
    decidedAtISO: now,
    decidedById: user.id,
    decidedByName: user.name,
    decisionNote: note || null,
    updatedAtISO: now,
    history: pushHistory(
      row,
      user.name,
      decision === 'approved' ? 'approved' : 'rejected',
      `${note}${change}${selfNote}`.trim()
    ),
  });
  db.logActivity(
    orgId,
    { id: user.id, name: user.name },
    decision === 'approved' ? 'requisition.approved' : 'requisition.rejected',
    decision === 'approved'
      ? `نیازمندسنجی «${row.title}» تأیید شد (${granted} از ${row.slots} پست)`
      : `نیازمندسنجی «${row.title}» رد شد — ${note}`,
    {}
  );
  return next;
}

export function hold(orgId: string, id: string, actor: { id: string; name: string }, on: boolean): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  if (row.status !== 'approved' && row.status !== 'on_hold') {
    throw new RequisitionError('فقط درخواست تأییدشده را می‌توان متوقف یا از سر گرفت.', 409, 'BAD_STATE');
  }
  const now = new Date().toISOString();
  const next = db.saveRequisition({
    ...row,
    status: on ? 'on_hold' : 'approved',
    updatedAtISO: now,
    history: pushHistory(row, actor.name, on ? 'held' : 'resumed', ''),
  });
  db.logActivity(orgId, actor, 'requisition.updated', `نیازمندسنجی «${row.title}» ${on ? 'متوقف' : 'از سر گرفته'} شد`, {});
  return next;
}

export function cancelRequisition(orgId: string, id: string, actor: { id: string; name: string }, note: string): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  if (row.status === 'cancelled') throw new RequisitionError('این درخواست پیش‌تر لغو شده است.', 409, 'ALREADY_CANCELLED');
  const filled = filledOf(row);
  if (filled > 0) {
    throw new RequisitionError(
      `برای این درخواست ${filled} استخدام پذیرفته شده است؛ لغو آن سابقه را پاک نمی‌کند. آن را «متوقف» کنید تا پست تازه باز نشود.`,
      409,
      'HAS_HIRES'
    );
  }
  const now = new Date().toISOString();
  const next = db.saveRequisition({
    ...row,
    status: 'cancelled',
    updatedAtISO: now,
    history: pushHistory(row, actor.name, 'cancelled', note.slice(0, 500)),
  });
  db.logActivity(orgId, actor, 'requisition.updated', `نیازمندسنجی «${row.title}» لغو شد`, {});
  return next;
}

// ---------------------------------------------------------------- openings ---

export function attachJob(orgId: string, id: string, jobId: string, actor: { id: string; name: string }): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  if (!supportsHeadcount(row)) {
    const status = effectiveStatus(row);
    const message =
      status === 'draft'
        ? 'این نیازمندسنجی هنوز تأیید نشده است؛ اول آن را بفرستید و تأیید بگیرید.'
        : status === 'pending'
          ? 'این نیازمندسنجی در انتظار تأیید است؛ پیش از تأیید، آگهی به آن وصل نمی‌شود.'
          : status === 'filled'
            ? 'همهٔ پست‌های این نیازمندسنجی پر شده است؛ برای استخدام بیشتر، درخواست تازه بسازید.'
            : 'این نیازمندسنجی در وضعیت «' + status + '» است و سرفصل باز ندارد.';
    throw new RequisitionError(message, 409, 'REQUISITION_NOT_OPEN');
  }
  const job = db.getJob(orgId, jobId);
  if (!job) throw new RequisitionError('فرصت شغلی پیدا نشد.', 404, 'JOB_NOT_FOUND');
  if (job.departmentId !== row.departmentId) {
    throw new RequisitionError('این آگهی برای دپارتمان دیگری است؛ سرفصل نیروی این نیازمندسنجی قابل استفاده نیست.', 400, 'DEPARTMENT_MISMATCH');
  }
  if (job.requisitionId === row.id) return row;
  if (job.requisitionId) {
    const other = db.getRequisition(orgId, job.requisitionId);
    throw new RequisitionError(`این آگهی به نیازمندسنجی «${other?.code || 'دیگر'}» وصل است؛ اول آن را جدا کنید.`, 409, 'JOB_ALREADY_ATTACHED');
  }
  db.updateJob(orgId, job.id, { requisitionId: row.id });
  const now = new Date().toISOString();
  const next = db.saveRequisition({
    ...row,
    updatedAtISO: now,
    history: pushHistory(row, actor.name, 'job_attached', job.roleTitle),
  });
  db.logActivity(orgId, actor, 'requisition.updated', `آگهی «${job.roleTitle}» به نیازمندسنجی «${row.code}» وصل شد`, { jobId: job.id });
  return next;
}

export function detachJob(orgId: string, id: string, jobId: string, actor: { id: string; name: string }): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  const job = db.getJob(orgId, jobId);
  if (!job || job.requisitionId !== row.id) throw new RequisitionError('این آگهی به این نیازمندسنجی وصل نیست.', 404, 'NOT_ATTACHED');
  db.updateJob(orgId, job.id, { requisitionId: null });
  const now = new Date().toISOString();
  const next = db.saveRequisition({
    ...row,
    updatedAtISO: now,
    history: pushHistory(row, actor.name, 'job_detached', job.roleTitle),
  });
  db.logActivity(orgId, actor, 'requisition.updated', `آگهی «${job.roleTitle}» از نیازمندسنجی «${row.code}» جدا شد`, { jobId: job.id });
  return next;
}

/**
 * The publish gate. Returns null when publishing may go ahead, or a refusal with
 * a code and a sentence a human can act on.
 */
export function publishGate(orgId: string, jobId: string): { code: string; message: string } | null {
  const settings = db.getRequisitionSettings(orgId);
  if (!settings.requireApprovedForPublish) return null;
  const row = db.requisitionOfJob(orgId, jobId);
  if (!row) {
    return {
      code: 'REQUISITION_REQUIRED',
      message:
        'در این فضای کاری، انتشار آگهی فقط با یک نیازمندسنجی تأییدشده انجام می‌شود. یک نیازمندسنجی بسازید و پس از تأیید، این آگهی را به آن وصل کنید.',
    };
  }
  if (!supportsHeadcount(row)) {
    const status = effectiveStatus(row);
    return {
      code: status === 'filled' ? 'REQUISITION_FILLED' : 'REQUISITION_NOT_APPROVED',
      message:
        status === 'filled'
          ? `همهٔ پست‌های نیازمندسنجی «${row.code}» پر شده است؛ برای انتشار، درخواست تازه بسازید.`
          : `نیازمندسنجی «${row.code}» در وضعیت «${status}» است؛ تا تأیید نشود، انتشار ممکن نیست.`,
    };
  }
  return null;
}

// ------------------------------------------------------------------ rollup ---

function getOrThrow(orgId: string, id: string): db.RequisitionRow {
  const row = db.getRequisition(orgId, id);
  if (!row) throw new RequisitionError('نیازمندسنجی پیدا نشد.', 404, 'REQUISITION_NOT_FOUND');
  return row;
}

export function rollup(orgId: string): RequisitionRollup {
  const rows = db.listRequisitions(orgId).filter((r) => r.status !== 'cancelled');
  let approvedSeats = 0;
  let filledSeats = 0;
  let pendingApproval = 0;
  let monthlyOpenCost = 0;
  let anyCost = false;
  const deptMap = new Map<string, { departmentId: string; departmentName: string; approved: number; filled: number; pending: number }>();
  for (const row of rows) {
    const filled = filledOf(row);
    const grant = row.status === 'approved' || row.status === 'filled' ? (row.approvedSlots ?? row.slots) : 0;
    if (row.status === 'pending') pendingApproval++;
    approvedSeats += grant;
    filledSeats += Math.min(filled, grant);
    const view = viewOf(row);
    if (grant > filled && view.monthlyCost !== null) {
      const mid = row.salaryMin !== null && row.salaryMax !== null ? (row.salaryMin + row.salaryMax) / 2 : (row.salaryMin ?? row.salaryMax)!;
      monthlyOpenCost += Math.round(mid * (grant - filled));
      anyCost = true;
    }
    const entry = deptMap.get(row.departmentId) || {
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      approved: 0,
      filled: 0,
      pending: 0,
    };
    entry.approved += grant;
    entry.filled += Math.min(filled, grant);
    if (row.status === 'pending') entry.pending++;
    deptMap.set(row.departmentId, entry);
  }
  return {
    approvedSeats,
    filledSeats,
    remainingSeats: Math.max(0, approvedSeats - filledSeats),
    pendingApproval,
    monthlyOpenCost: anyCost ? monthlyOpenCost : null,
    byDepartment: Array.from(deptMap.values()).sort((a, b) => b.approved - a.approved || b.pending - a.pending),
  };
}

export function readSettings(orgId: string): { settings: RequisitionSettings; approvers: { id: string; name: string; email: string; role: 'owner' | 'admin' | 'member' }[] } {
  const settings = db.getRequisitionSettings(orgId);
  return {
    settings,
    approvers: db.listMembers(orgId).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
  };
}

export function saveSettings(orgId: string, actor: { id: string; name: string }, body: { requireApprovedForPublish?: unknown; approverUserIds?: unknown }): RequisitionSettings {
  const current = db.getRequisitionSettings(orgId);
  const ids = Array.isArray(body.approverUserIds) ? Array.from(new Set(body.approverUserIds.map((v) => String(v)))) : current.approverUserIds;
  const known = new Set(db.listMembers(orgId).map((u) => u.id));
  const approverUserIds = ids.filter((id) => known.has(id)).slice(0, 50);
  const next: RequisitionSettings = {
    requireApprovedForPublish: body.requireApprovedForPublish === undefined ? current.requireApprovedForPublish : Boolean(body.requireApprovedForPublish),
    approverUserIds,
  };
  db.saveRequisitionSettings(orgId, next);
  db.logActivity(
    orgId,
    actor,
    'requisition.settings',
    next.requireApprovedForPublish
      ? 'از این پس انتشار آگهی فقط با نیازمندسنجی تأییدشده ممکن است'
      : 'قید «انتشار فقط با نیازمندسنجی» خاموش شد',
    {}
  );
  return next;
}

export { PRIORITY_LABEL };

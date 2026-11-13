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
import type { Job } from '../src/types/screening';
import {
  CHAIN_MAX_STEPS,
  PRIORITY_LABEL,
  type Requisition,
  type RequisitionApprovalStep,
  type RequisitionApprovalView,
  type RequisitionChainStepConfig,
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

// ------------------------------------------------------------------ chain ---

/**
 * The chain an old row never had. Reading through this keeps every caller free
 * of `row.approvals?.length` checks and makes «no chain» mean «one decision».
 */
export function approvalsOf(row: db.RequisitionRow): RequisitionApprovalStep[] {
  return Array.isArray(row.approvals) ? row.approvals : [];
}

/** The one step whose turn it is — the chain is strictly in order. */
export function pendingStep(row: db.RequisitionRow): RequisitionApprovalStep | null {
  return approvalsOf(row).find((step) => step.status === 'pending') || null;
}

/**
 * The configured chain, copied onto a request the moment it is sent — later
 * edits to the setting never rewrite a request that is already circulating.
 * A named approver who has left the workspace is dropped rather than frozen in.
 */
function buildChain(orgId: string): RequisitionApprovalStep[] {
  const cfg = db.getRequisitionSettings(orgId).chain;
  if (!Array.isArray(cfg) || !cfg.length) return [];
  const members = new Map(db.listMembers(orgId).map((u) => [u.id, u]));
  const out: RequisitionApprovalStep[] = [];
  for (const configured of cfg.slice(0, CHAIN_MAX_STEPS)) {
    const member = members.get(configured.approverId);
    if (!member) continue;
    out.push({
      id: configured.id || db.uid('apv'),
      label: (configured.label || '').trim() || member.name,
      approverId: member.id,
      approverName: member.name,
      status: 'pending',
      decidedAtISO: null,
      decidedAtJalali: null,
      note: null,
      approvedSlots: null,
    });
  }
  return out;
}

/**
 * How many seats may this signature still grant? A step earlier in the chain may
 * have cut the number; the reduction cascades so nobody can raise it back later.
 */
function seatCeiling(row: db.RequisitionRow, chain: RequisitionApprovalStep[]): number {
  return chain
    .filter((step) => step.status === 'approved')
    .reduce((min, step) => Math.min(min, step.approvedSlots ?? row.slots), row.slots);
}

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
    approvals: approvalsOf(row),
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
    approvals: [],
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
    // A rejected request that is edited goes back to draft: it has to be submitted
    // again, and the old signatures — right or wrong — no longer apply to it.
    status: 'draft',
    approvals: [],
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
  const chain = buildChain(orgId);
  const next = db.saveRequisition({
    ...row,
    status: 'pending',
    approvals: chain,
    submittedAtISO: now,
    updatedAtISO: now,
    history: pushHistory(
      row,
      actor.name,
      'submitted',
      chain.length ? `زنجیرهٔ تأیید: ${chain.map((step) => step.label).join(' → ')}` : ''
    ),
  });
  db.logActivity(
    orgId,
    actor,
    'requisition.submitted',
    chain.length
      ? `نیازمندسنجی «${row.title}» برای تأیید فرستاده شد (${chain.length} مرحله)`
      : `نیازمندسنجی «${row.title}» برای تأیید فرستاده شد`,
    {}
  );
  return next;
}

/** What a reader may do with the request right now — and why not, if not. */
export interface ApprovalGate {
  allowed: boolean;
  reason: string | null;
  /** True when the rule bends because nobody else could sign it. */
  selfApprovalOnly: boolean;
  /** True when an admin/owner signs in the named approver's place. */
  onBehalf: boolean;
  /** The step this reader would decide; null for a chain-less request. */
  step: RequisitionApprovalStep | null;
}

/**
 * May this user decide it?
 *
 * With a chain, only *the step whose turn it is* may be decided: its named
 * approver, or — recorded, never hidden — an admin/owner in their place. Without
 * a chain the old rule still holds: named approvers, admins and owners, and
 * never the person who asked (unless they are literally the only one who could).
 */
export function canApprove(
  orgId: string,
  row: db.RequisitionRow,
  user: { id: string; role: string }
): ApprovalGate {
  if (row.status !== 'pending') {
    return { allowed: false, reason: 'این درخواست در انتظار تأیید نیست.', selfApprovalOnly: false, onBehalf: false, step: null };
  }
  const isAdmin = user.role === 'admin' || user.role === 'owner';
  const chain = approvalsOf(row);
  const step = pendingStep(row);

  if (chain.length) {
    if (!step) {
      return { allowed: false, reason: 'همهٔ مراحل تأیید این درخواست انجام شده است.', selfApprovalOnly: false, onBehalf: false, step: null };
    }
    if (row.requestedById === user.id) {
      // The door stays shut for the requester; it only opens when nobody else in
      // the workspace could possibly sign — and then it says so on the page.
      const others = db.listMembers(orgId).filter((u) => u.id !== user.id && (u.role === 'admin' || u.role === 'owner')).length;
      if (others === 0 && (step.approverId === user.id || isAdmin)) {
        return {
          allowed: true,
          reason: 'در این فضای کاری تأییدکنندهٔ دیگری نیست؛ تأیید شما در تاریخچه با همین توضیح ثبت می‌شود.',
          selfApprovalOnly: true,
          onBehalf: false,
          step,
        };
      }
      return {
        allowed: false,
        reason: 'شما درخواست‌دهندهٔ این نیازمندسنجی هستید و نمی‌توانید آن را تأیید کنید؛ این مرحله با شخص دیگری است.',
        selfApprovalOnly: false,
        onBehalf: false,
        step,
      };
    }
    if (step.approverId === user.id) return { allowed: true, reason: null, selfApprovalOnly: false, onBehalf: false, step };
    if (isAdmin) return { allowed: true, reason: null, selfApprovalOnly: false, onBehalf: true, step };
    return {
      allowed: false,
      reason: `این مرحله («${step.label}») در اختیار «${step.approverName}» است.`,
      selfApprovalOnly: false,
      onBehalf: false,
      step,
    };
  }

  const settings = db.getRequisitionSettings(orgId);
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
        onBehalf: false,
        step: null,
      };
    }
    return { allowed: false, reason: 'درخواست‌دهنده نمی‌تواند درخواست خودش را تأیید کند.', selfApprovalOnly: false, onBehalf: false, step: null };
  }
  if (named.includes(user.id)) return { allowed: true, reason: null, selfApprovalOnly: false, onBehalf: false, step: null };
  if (isAdmin) return { allowed: true, reason: null, selfApprovalOnly: false, onBehalf: false, step: null };
  return {
    allowed: false,
    reason: 'تأیید نیازمندسنجی با مدیران فضای کاری یا تأییدکنندگان تعیین‌شده است.',
    selfApprovalOnly: false,
    onBehalf: false,
    step: null,
  };
}

/**
 * What the request page draws: the steps in order, the one that is waiting, and
 * whether *this* reader can take it. A refusal is a sentence, never a dead grey
 * button — the reader must be able to tell «not me» from «not yet».
 */
export function approvalViewFor(
  orgId: string,
  row: db.RequisitionRow,
  user: { id: string; role: string }
): RequisitionApprovalView {
  const chain = approvalsOf(row);
  const step = pendingStep(row);
  const gate = canApprove(orgId, row, user);
  const index = step ? chain.findIndex((s) => s.id === step.id) + 1 : 0;
  return {
    steps: chain,
    pending: step,
    position: step && index > 0 ? { index, total: chain.length } : null,
    canAct: gate.allowed,
    reason: gate.allowed ? null : gate.reason,
    onBehalf: gate.onBehalf,
  };
}

/**
 * One decision. With a chain this decides *the current step*: an approval hands
 * the request to the next person and only the last signature makes it
 * «تأییدشده»; a rejection ends it and the steps that never got their turn are
 * written down as `skipped` rather than left waiting forever.
 */
export function decide(
  orgId: string,
  id: string,
  user: { id: string; name: string; role: string },
  body: { decision?: unknown; note?: unknown; approvedSlots?: unknown }
): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  const gate = canApprove(orgId, row, user);
  if (!gate.allowed) {
    // «You are the requester» is a forbidden, not a conflict; «not your turn» is
    // a conflict with the current state of the chain. The status says which.
    const forbidden = /درخواست‌دهنده|نمی‌تواند|نمی‌توانید/.test(gate.reason || '');
    throw new RequisitionError(gate.reason || 'اجازهٔ تأیید ندارید.', forbidden ? 403 : 409, 'NOT_APPROVER');
  }

  const decision = String(body.decision || '') === 'rejected' ? 'rejected' : 'approved';
  const note = String(body.note || '').trim().slice(0, 800);
  if (decision === 'rejected' && note.length < 5) {
    throw new RequisitionError('برای رد، دلیل را بنویسید تا درخواست‌دهنده بداند چه چیزی را باید اصلاح کند.', 400, 'NOTE_REQUIRED');
  }

  const chain = approvalsOf(row);
  const step = chain.length ? gate.step : null;
  if (chain.length && !step) throw new RequisitionError('همهٔ مراحل تأیید این درخواست انجام شده است.', 409, 'APPROVAL_DONE');

  // Each step may grant fewer seats; the ceiling is what the earlier signatures
  // already allowed, so a reduction cannot be undone further down the chain.
  const ceiling = chain.length ? seatCeiling(row, chain) : row.slots;
  let granted: number | null = null;
  if (decision === 'approved') {
    granted = body.approvedSlots === undefined || body.approvedSlots === null ? ceiling : Number(body.approvedSlots);
    if (!Number.isInteger(granted) || granted < 1 || granted > ceiling) {
      throw new RequisitionError(
        `تعداد تأییدشده باید بین ۱ تا ${ceiling} باشد (بیش از درخواست، تأیید نمی‌شود).`,
        400,
        'BAD_APPROVED_SLOTS'
      );
    }
  }

  const now = new Date().toISOString();
  const actedIndex = step ? chain.findIndex((entry) => entry.id === step.id) : -1;
  const chainAfter: RequisitionApprovalStep[] = chain.map((entry, index) => {
    if (step && entry.id === step.id) {
      return {
        ...entry,
        status: decision === 'approved' ? ('approved' as const) : ('rejected' as const),
        decidedAtISO: now,
        decidedAtJalali: jalali(now),
        note: note || null,
        approvedSlots: decision === 'approved' ? granted : null,
        onBehalf: gate.onBehalf || undefined,
      };
    }
    // A rejection ends the chain: the steps that never got their turn are
    // recorded as skipped, not left «waiting» on a request nobody will sign.
    if (decision === 'rejected' && entry.status === 'pending' && index > actedIndex) {
      return { ...entry, status: 'skipped' as const };
    }
    return entry;
  });

  const stillWaiting = chainAfter.some((entry) => entry.status === 'pending');
  const isFinal = chain.length ? !stillWaiting : true;
  const seatWord = decision === 'approved' && granted !== row.slots ? ` — ${row.slots} خواسته شده بود، ${granted} تأیید شد` : '';
  const selfNote = gate.selfApprovalOnly ? ' (تنها تأییدکنندهٔ فضای کاری، خودِ درخواست‌دهنده بود)' : '';
  const behalfNote = gate.onBehalf && step ? ` (به‌جای «${step.approverName}»)` : '';
  const stepPrefix = step ? `مرحلهٔ «${step.label}»: ` : '';

  const historyAction = !isFinal
    ? decision === 'approved'
      ? 'step_approved'
      : 'step_rejected'
    : decision === 'approved'
      ? 'approved'
      : 'rejected';

  const next = db.saveRequisition({
    ...row,
    approvals: chainAfter,
    status: decision === 'rejected' ? 'rejected' : isFinal ? 'approved' : 'pending',
    approvedSlots: decision === 'approved' && isFinal ? granted : null,
    decidedAtISO: isFinal ? now : row.decidedAtISO,
    decidedById: isFinal ? user.id : row.decidedById,
    decidedByName: isFinal ? user.name : row.decidedByName,
    decisionNote: isFinal ? note || null : row.decisionNote,
    updatedAtISO: now,
    history: pushHistory(
      row,
      user.name,
      historyAction,
      `${stepPrefix}${note}${decision === 'approved' ? seatWord : ''}${behalfNote}${selfNote}`.trim()
    ),
  });

  const label = step ? `مرحلهٔ «${step.label}»` : 'تأیید';
  db.logActivity(
    orgId,
    { id: user.id, name: user.name },
    decision === 'rejected' ? 'requisition.rejected' : isFinal ? 'requisition.approved' : 'requisition.updated',
    decision === 'rejected'
      ? `نیازمندسنجی «${row.title}» در ${label} رد شد — ${note}`
      : isFinal
        ? `نیازمندسنجی «${row.title}» تأیید شد (${granted} از ${row.slots} پست)${behalfNote}`
        : `${label} نیازمندسنجی «${row.title}» تأیید شد؛ در انتظار امضای بعدی${behalfNote}`,
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

/**
 * Why an opening cannot be attached right now — one sentence a human can act on,
 * shared by every door (create-with-requisition, the job page, the requisition
 * page) so the same refusal is never worded two different ways.
 */
export function attachRefusal(row: db.RequisitionRow): { message: string; code: string } | null {
  if (supportsHeadcount(row)) return null;
  const status = effectiveStatus(row);
  const message =
    status === 'draft'
      ? 'این نیازمندسنجی هنوز تأیید نشده است؛ اول آن را بفرستید و تأیید بگیرید.'
      : status === 'pending'
        ? 'این نیازمندسنجی در انتظار تأیید است؛ پیش از تأیید، آگهی به آن وصل نمی‌شود.'
        : status === 'filled'
          ? 'همهٔ پست‌های این نیازمندسنجی پر شده است؛ برای استخدام بیشتر، درخواست تازه بسازید.'
          : 'این نیازمندسنجی در وضعیت «' + status + '» است و سرفصل باز ندارد.';
  return { message, code: 'REQUISITION_NOT_OPEN' };
}

export function attachJob(orgId: string, id: string, jobId: string, actor: { id: string; name: string }): db.RequisitionRow {
  const row = getOrThrow(orgId, id);
  const refusal = attachRefusal(row);
  if (refusal) throw new RequisitionError(refusal.message, 409, refusal.code);
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

/**
 * Preflight for «create an opening against this requisition». Runs before the
 * job exists, so a refused link never leaves a half-created opening behind.
 */
export function checkAttachable(orgId: string, requisitionId: string, departmentId: string): db.RequisitionRow {
  const row = getOrThrow(orgId, requisitionId);
  const refusal = attachRefusal(row);
  if (refusal) throw new RequisitionError(refusal.message, 409, refusal.code);
  if (row.departmentId !== departmentId) {
    throw new RequisitionError('این آگهی برای دپارتمان دیگری است؛ سرفصل نیروی این نیازمندسنجی قابل استفاده نیست.', 400, 'DEPARTMENT_MISMATCH');
  }
  return row;
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

// ------------------------------------------------------------- job linkage ---

/** One choice in the «نیازمندسنجی» picker on the job page. */
export interface RequisitionOption {
  id: string;
  code: string;
  title: string;
  departmentId: string;
  departmentName: string;
  status: RequisitionStatus;
  approvedSlots: number;
  filled: number;
  remaining: number;
  /** True when an opening may be attached right now. */
  selectable: boolean;
  /** Why not — printed next to a disabled option, never a silent grey row. */
  reason: string | null;
  /** The opening already attached to it, when one is. */
  jobTitle: string | null;
}

export function optionsFor(orgId: string, departmentId: string, currentJobId: string | null): RequisitionOption[] {
  return db
    .listRequisitions(orgId, { departmentId })
    .map((row) => {
      const filled = filledOf(row);
      const granted = row.approvedSlots ?? row.slots;
      const refusal = attachRefusal(row);
      // A requisition may carry several openings — it is a pool of seats, and
      // filled seats are counted from accepted offers. So an existing opening is
      // information for the picker, not a reason to refuse.
      const holder = jobsOf(row).find((j) => j.id !== currentJobId) || null;
      const reason = refusal?.message || null;
      return {
        id: row.id,
        code: row.code,
        title: row.title,
        departmentId: row.departmentId,
        departmentName: row.departmentName,
        status: effectiveStatus(row, filled),
        approvedSlots: granted,
        filled,
        remaining: Math.max(0, granted - filled),
        selectable: !reason,
        reason,
        jobTitle: holder?.roleTitle || null,
      };
    })
    .sort((a, b) => Number(b.selectable) - Number(a.selectable) || b.code.localeCompare(a.code));
}

/**
 * What the job page needs about its requisition, in one read: the attached row,
 * the options for the same department, and whether publishing is gated.
 */
export function jobRequisitionPayload(orgId: string, job: Job) {
  const row = job.requisitionId ? db.getRequisition(orgId, job.requisitionId) : null;
  const settings = db.getRequisitionSettings(orgId);
  const gate = publishGate(orgId, job.id);
  return {
    requisition: row
      ? {
          id: row.id,
          code: row.code,
          title: row.title,
          status: effectiveStatus(row),
          approvedSlots: row.approvedSlots ?? row.slots,
          filled: filledOf(row),
          remaining: Math.max(0, (row.approvedSlots ?? row.slots) - filledOf(row)),
          departmentName: row.departmentName,
          decidedAtJalali: row.decidedAtISO ? formatJalaliDate(tehranJalaliOf(new Date(row.decidedAtISO)), true) : null,
          decidedByName: row.decidedByName,
        }
      : null,
    options: optionsFor(orgId, job.departmentId, job.id),
    /* The workspace's rule, stated even when it lets this opening through. */
    gate: { required: settings.requireApprovedForPublish, blocked: gate },
  };
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

/**
 * Read the configured chain, made safe: known members only, no duplicates (one
 * person cannot sign twice), at most `CHAIN_MAX_STEPS`, and a label that is never
 * blank — an unnamed step falls back to the approver's own name.
 */
function readChain(orgId: string, raw: unknown, fallback: RequisitionChainStepConfig[]): RequisitionChainStepConfig[] {
  if (!Array.isArray(raw)) return fallback;
  const members = new Map(db.listMembers(orgId).map((u) => [u.id, u]));
  const out: RequisitionChainStepConfig[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (out.length >= CHAIN_MAX_STEPS) break;
    const approverId = String((entry as any)?.approverId || '');
    const member = members.get(approverId);
    if (!member || seen.has(approverId)) continue;
    seen.add(approverId);
    const label = String((entry as any)?.label || '').trim().slice(0, 60) || member.name;
    out.push({ id: String((entry as any)?.id || `chain-${out.length + 1}`).slice(0, 60), label, approverId });
  }
  return out;
}

export function saveSettings(
  orgId: string,
  actor: { id: string; name: string },
  body: { requireApprovedForPublish?: unknown; approverUserIds?: unknown; chain?: unknown }
): RequisitionSettings {
  const current = db.getRequisitionSettings(orgId);
  const ids = Array.isArray(body.approverUserIds) ? Array.from(new Set(body.approverUserIds.map((v) => String(v)))) : current.approverUserIds;
  const known = new Set(db.listMembers(orgId).map((u) => u.id));
  const approverUserIds = ids.filter((id) => known.has(id)).slice(0, 50);
  const next: RequisitionSettings = {
    requireApprovedForPublish: body.requireApprovedForPublish === undefined ? current.requireApprovedForPublish : Boolean(body.requireApprovedForPublish),
    approverUserIds,
    chain: readChain(orgId, body.chain, current.chain),
  };
  db.saveRequisitionSettings(orgId, next);
  db.logActivity(
    orgId,
    actor,
    'requisition.settings',
    next.chain.length
      ? `زنجیرهٔ تأیید نیازمندسنجی: ${next.chain.map((step) => step.label).join(' → ')}${next.requireApprovedForPublish ? '؛ انتشار آگهی فقط با نیازمندسنجی تأییدشده' : ''}`
      : next.requireApprovedForPublish
        ? 'از این پس انتشار آگهی فقط با نیازمندسنجی تأییدشده ممکن است'
        : 'قید «انتشار فقط با نیازمندسنجی» خاموش شد؛ تأیید یک‌مرحله‌ای است',
    {}
  );
  return next;
}

export { PRIORITY_LABEL };

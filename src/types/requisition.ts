/**
 * «نیازمندسنجی» — a requisition with real headcount, a real approval, and a real
 * cost, so "we are hiring three people" stops being a sentence in a chat.
 *
 * The rules that make it a control rather than a form:
 *   • a **draft** cannot be attached to an opening, and (when the workspace turns
 *     the gate on) an opening cannot be published on the public portal without an
 *     approved requisition that still has room;
 *   • an approver may **grant fewer seats than were asked for** — that is what
 *     approval means — and the reason is kept;
 *   • **filled** is counted from accepted offers, not typed in by hand;
 *   • the **history** of every state change is kept with the row, in order.
 */

export type RequisitionStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'on_hold' | 'filled' | 'cancelled';

export type RequisitionPriority = 'low' | 'normal' | 'high' | 'critical';

export type RequisitionSeniority = 'junior' | 'mid' | 'senior' | 'lead';

export type RequisitionWorkMode = 'onsite' | 'hybrid' | 'remote';

/** Where the money figure came from, so nobody reads an estimate as a budget. */
export type SalaryBasis = 'gross_monthly' | 'total_monthly';

export interface RequisitionHistoryEntry {
  atISO: string;
  atJalali: string;
  byName: string;
  action: string;
  note: string;
}

export type RequisitionApprovalStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

/**
 * One signature in the chain. The chain is copied onto the requisition at submit
 * time — later edits to the settings do not rewrite a request that is already
 * circulating. `skipped` is written on the steps that never got their turn
 * because someone earlier said no.
 */
export interface RequisitionApprovalStep {
  id: string;
  /** «مدیر فنی»، «مالی»، «مدیرعامل» — the label the workspace chose. */
  label: string;
  approverId: string;
  approverName: string;
  status: RequisitionApprovalStatus;
  decidedAtISO: string | null;
  decidedAtJalali: string | null;
  note: string | null;
  /** Seats this signature granted; the final approval's number is the one that counts. */
  approvedSlots: number | null;
  /** True when an admin decided in the named approver's place (recorded, not hidden). */
  onBehalf?: boolean;
}

/** A configured step, before it becomes part of any one requisition. */
export interface RequisitionChainStepConfig {
  id: string;
  label: string;
  approverId: string;
}

/** One requisition, as the workspace reads it. */
export interface Requisition {
  id: string;
  /** Human handle, e.g. `REQ-1404-003`. Unique per workspace. */
  code: string;
  title: string;
  departmentId: string;
  departmentName: string;
  hiringManagerName: string;
  requestedByName: string;
  status: RequisitionStatus;
  priority: RequisitionPriority;
  seniority: RequisitionSeniority;
  employmentType: string;
  workMode: RequisitionWorkMode;
  location: string;
  /** Seats asked for. */
  slots: number;
  /** Seats granted by the approver (≤ slots); null while not approved. */
  approvedSlots: number | null;
  /** Gross monthly salary band in toman. */
  salaryMin: number | null;
  salaryMax: number | null;
  salaryBasis: SalaryBasis;
  /** Why the seat exists, and what happens if it does not — required to submit. */
  justification: string;
  targetStartISO: string | null;
  targetStartJalali: string | null;
  createdAtISO: string;
  createdAtJalali: string;
  updatedAtISO: string;
  submittedAtISO: string | null;
  decidedAtISO: string | null;
  decidedAtJalali: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  /** Openings attached to this requisition. */
  jobIds: string[];
  jobTitles: string[];
  /** Counted from accepted offers on the attached openings. */
  filled: number;
  /** granted − filled, never below zero. */
  remaining: number;
  /** True when filled ≥ granted: the seats are used up. */
  complete: boolean;
  /** Monthly cost of the granted seats at the mid point of the band. */
  monthlyCost: number | null;
  /**
   * Offers written above the approved ceiling, with the reason someone gave.
   * Visible on the requisition so cost creep has a face, not just a total.
   */
  overBandOffers: { offerId: string; candidateName: string; monthly: number | null; reason: string | null; status: string }[];
  history: RequisitionHistoryEntry[];
  /** Empty when the workspace has no chain (single decision, as before). */
  approvals: RequisitionApprovalStep[];
}

/** The list view adds the two computed flags a dashboard needs. */
export interface RequisitionSummaryRow extends Requisition {
  /** Can an opening still be published against this requisition? */
  openForHiring: boolean;
}

export interface RequisitionRollup {
  /** Approved seats across every live requisition. */
  approvedSeats: number;
  filledSeats: number;
  remainingSeats: number;
  pendingApproval: number;
  /** Monthly cost of everything still unfilled, at band mid points. */
  monthlyOpenCost: number | null;
  byDepartment: { departmentId: string; departmentName: string; approved: number; filled: number; pending: number }[];
}

export interface RequisitionSettings {
  /** When true, publishing on the public portal requires an approved requisition. */
  requireApprovedForPublish: boolean;
  /**
   * Who may approve when there is no chain. Empty = every admin/owner, which is
   * the default because a small team has nobody else.
   */
  approverUserIds: string[];
  /**
   * «زنجیرهٔ تأیید» — when it has steps, a submitted requisition walks them in
   * order and only turns «تأییدشده» after the last one. Empty = one decision.
   */
  chain: RequisitionChainStepConfig[];
}

/** What the requisition page needs to draw the approval state for this reader. */
export interface RequisitionApprovalView {
  /** Steps, in order (empty when the workspace has no chain). */
  steps: RequisitionApprovalStep[];
  /** The step waiting right now, if the request is pending. */
  pending: RequisitionApprovalStep | null;
  /** 1-based position of the pending step, e.g. 2 of 3. Null when not pending. */
  position: { index: number; total: number } | null;
  /** May this reader decide the pending step? */
  canAct: boolean;
  /** Why not — the sentence shown instead of a disabled button with no reason. */
  reason: string | null;
  /** True when acting would be «به‌جای» the named approver (admin fallback). */
  onBehalf: boolean;
}

export const CHAIN_MAX_STEPS = 4;

export interface RequisitionApprovers {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
}

/**
 * «نیازمندسنجی» as the *job* page sees it: the attached requisition, the choices
 * for this department, and the workspace's publishing rule stated even when it
 * lets the opening through.
 */
export interface JobRequisitionInfo {
  id: string;
  code: string;
  title: string;
  status: RequisitionStatus;
  approvedSlots: number;
  filled: number;
  remaining: number;
  departmentName: string;
  decidedAtJalali: string | null;
  decidedByName: string | null;
}

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
  /** False when a row is shown but cannot be picked — `reason` says why. */
  selectable: boolean;
  reason: string | null;
  /** An opening already spending this requisition, shown as information only. */
  jobTitle: string | null;
}

export interface JobRequisitionPayload {
  requisition: JobRequisitionInfo | null;
  options: RequisitionOption[];
  gate: {
    /** true when this workspace only publishes openings with an approved requisition. */
    required: boolean;
    /** The refusal that publishing would hit right now, if any. */
    blocked: { code: string; message: string } | null;
  };
}

/** The editable payload, as the form sends it. */
export interface RequisitionInput {
  title?: string;
  departmentId?: string;
  hiringManagerId?: string | null;
  slots?: number;
  priority?: RequisitionPriority;
  seniority?: RequisitionSeniority;
  employmentType?: string;
  workMode?: RequisitionWorkMode;
  location?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryBasis?: SalaryBasis;
  justification?: string;
  targetStartISO?: string | null;
}

export const REQUISITION_STATUS_LABEL: Record<RequisitionStatus, string> = {
  draft: 'پیش‌نویس',
  pending: 'در انتظار تأیید',
  approved: 'تأیید‌شده',
  rejected: 'رد‌شده',
  on_hold: 'متوقف',
  filled: 'تکمیل‌شده',
  cancelled: 'لغو‌شده',
};

export const PRIORITY_LABEL: Record<RequisitionPriority, string> = {
  low: 'کم',
  normal: 'معمول',
  high: 'بالا',
  critical: 'بحرانی',
};

export const SENIORITY_LABEL: Record<RequisitionSeniority, string> = {
  junior: 'جوان/تازه‌کار',
  mid: 'میان‌کار',
  senior: 'ارشد',
  lead: 'سرپرست',
};

export const WORK_MODE_LABEL: Record<RequisitionWorkMode, string> = {
  onsite: 'حضوری',
  hybrid: 'ترکیبی',
  remote: 'دورکاری',
};

export const SALARY_BASIS_LABEL: Record<SalaryBasis, string> = {
  gross_monthly: 'حقوق ماهانه (ناخالص)',
  total_monthly: 'کل هزینهٔ ماهانهٔ شرکت',
};

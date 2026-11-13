/**
 * «بستهٔ شواهد انطباق» — ISO/IEC 27001:2022 and SOC 2 evidence.
 *
 * The one rule that shapes every type here: **the product only ever claims what
 * it can show.** Each control is either measured from the workspace's real
 * state (`source: 'product'`), or it is a document only the customer can supply
 * (`source: 'customer'`) and the pack says so instead of inventing a green tick.
 */

export type Framework = 'iso27001' | 'soc2';

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  iso27001: 'ISO/IEC 27001:2022',
  soc2: 'SOC 2 (TSC 2017)',
};

export const FRAMEWORK_SHORT: Record<Framework, string> = {
  iso27001: 'ISO 27001',
  soc2: 'SOC 2',
};

/**
 * `met`      — the thing exists and the evidence was collected from live state.
 * `partial`  — it exists with a named limitation (the reason says which).
 * `gap`      — this product has no such control; a real gap, not a to-do.
 * `missing_evidence` — the customer has not supplied the document yet.
 */
export type ControlState = 'met' | 'partial' | 'gap' | 'missing_evidence';

export const STATE_LABEL: Record<ControlState, string> = {
  met: 'پوشش‌داده‌شده',
  partial: 'پوشش جزئی',
  gap: 'جای خالی',
  missing_evidence: 'سند ارسال نشده',
};

export type ControlSource = 'product' | 'customer';

export interface ControlEvidence {
  /** What was looked at — a fact, in the customer's own language. */
  label: string;
  value: string;
  kind: 'auto' | 'upload' | 'declaration';
}

export interface EvidenceAttachment {
  id: string;
  controlId: string;
  fileName: string;
  contentType: string;
  bytes: number;
  /** SHA-256 of the bytes — the auditor can verify the file has not changed. */
  sha256: string;
  uploadedByName: string;
  uploadedAtISO: string;
  uploadedAtJalali: string;
}

export interface ControlDeclaration {
  text: string;
  byName: string;
  atISO: string;
  atJalali: string;
}

export interface ComplianceControl {
  /** ISO control number where one exists, otherwise our own stable slug. */
  id: string;
  group: string;
  title: string;
  /** What an auditor actually asks for. */
  requirement: string;
  /** What HOVIDA does about it — and what it does not. */
  howWeHelp: string;
  /** `ISO A.5.15` / `SOC2 CC6.1` — both frameworks, one catalogue. */
  refs: string[];
  source: ControlSource;
  state: ControlState;
  /** One honest sentence: why this state, with the numbers that produced it. */
  reason: string;
  evidence: ControlEvidence[];
  /** Where to fix a product-side state. */
  action: { label: string; to: string } | null;
  /** What to upload / write when the evidence is the customer's. */
  customerAction: string | null;
  attachments: EvidenceAttachment[];
  declaration: ControlDeclaration | null;
  /** True when a declaration is older than a year — the pack labels it. */
  stale: boolean;
  measuredAtISO: string;
}

export interface ComplianceSummary {
  framework: Framework;
  total: number;
  counts: Record<ControlState, number>;
  /** met = 1, partial = 0.5, everything else = 0. Weighted, not a certificate. */
  score: number;
  readiness: 'ready' | 'nearly' | 'starting';
  /** The controls a team should look at first, hardest first. */
  gaps: { id: string; title: string; reason: string; state: ControlState }[];
  lastMeasuredISO: string;
  lastMeasuredJalali: string;
  /** Named limitations the pack prints above the controls. */
  limits: string[];
}

export interface AccessReviewMember {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  twoFactor: boolean;
  lastLoginISO: string | null;
  /** Flagged by the system for the reviewer to look at twice. */
  flag: 'admin' | 'no_2fa' | 'inactive' | null;
  confirmed: boolean;
  confirmedAtISO: string | null;
  confirmedByName: string | null;
}

export interface AccessReview {
  id: string;
  framework: Framework;
  status: 'open' | 'completed';
  note: string;
  startedByName: string;
  startedAtISO: string;
  startedAtJalali: string;
  members: AccessReviewMember[];
  completedAtISO: string | null;
  completedAtJalali: string | null;
  completedByName: string | null;
  /** How many members were confirmed vs removed from the workspace since. */
  summary: string | null;
  /** Frozen counts at completion, so the record cannot drift. */
  snapshot: { total: number; confirmed: number; admins: number; withoutTwoFactor: number } | null;
}

export interface IssuedPack {
  id: string;
  framework: Framework;
  scopeNote: string;
  issuedByName: string;
  issuedAtISO: string;
  issuedAtJalali: string;
  /** Hash of the canonical JSON — printed on the cover and in the manifest. */
  sha256: string;
  bytes: number;
  counts: Record<ControlState, number>;
  score: number;
  attachments: number;
  /** Files inside the ZIP. */
  files: string[];
}

export interface CompliancePayload {
  controls: ComplianceControl[];
  summary: ComplianceSummary;
  reviews: AccessReview[];
  packs: IssuedPack[];
  /** Who may change evidence and issue packs (admin/owner). */
  canManage: boolean;
  /** Roster the access review would freeze right now — for the «شروع بازنگری» dialog. */
  rosterSize: number;
  canIssue: boolean;
  lastBackupISO: string | null;
}

export const PACK_FORMAT_LABEL: Record<'md' | 'json' | 'zip', string> = {
  md: 'گزارش خوانا (Markdown)',
  json: 'دادهٔ کامل (JSON)',
  zip: 'بستهٔ کامل (ZIP با پیوست‌ها)',
};

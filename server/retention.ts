/**
 * «نگه‌داری داده» و درخواست دادهٔ شخصی (DSAR).
 *
 * Two obligations every HR team has toward a candidate:
 *   1. **Don't keep it forever.** A retention policy says: after N days without
 *      activity, either delete the record or strip it down to the numbers the
 *      reports need (anonymise). We never touch a hired person or a talent-pool
 *      member — both are deliberate decisions to keep someone.
 *   2. **Give it back / take it away on request.** One endpoint assembles
 *      everything we hold about a candidate (record, notes, interviews, offers,
 *      messages, scorecards) as a JSON download; another erases all of it.
 *
 * Both are irreversible, so both are admin-only, recorded in the activity feed,
 * and the erasure requires an explicit `confirm` string from the UI.
 */
import type { DecisionStatus, ResumeRecord } from '../src/types/screening';
import type { RetentionAction, RetentionCandidate, RetentionPolicy, RetentionRunResult } from '../src/types/retention';
import * as db from './db';
import { DEFAULT_STAGES } from '../src/types/pipeline';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';

export class RetentionError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'RETENTION_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const MAX_DAYS = 3650;
export const RETENTION_PRESETS = [90, 180, 365, 730];

/** `days: 0` = the policy is off, which is the default for a new workspace. */
export function policyOf(orgId: string): RetentionPolicy {
  return (
    db.getRetention(orgId) || {
      days: 0,
      action: 'anonymize',
      updatedAtISO: null,
      updatedAtJalali: null,
      lastRunAtISO: null,
      lastRunAtJalali: null,
      lastRunCount: 0,
    }
  );
}

export function savePolicy(orgId: string, input: { days?: unknown; action?: unknown }): RetentionPolicy {
  const days = Math.round(Number(input.days));
  if (!Number.isFinite(days) || days < 0 || days > MAX_DAYS) {
    throw new RetentionError(`مدت نگه‌داری باید بین ۰ تا ${MAX_DAYS} روز باشد.`);
  }
  const action: RetentionAction = input.action === 'delete' ? 'delete' : 'anonymize';
  const current = policyOf(orgId);
  const stamp = new Date();
  const next: RetentionPolicy = {
    ...current,
    days,
    action,
    updatedAtISO: stamp.toISOString(),
    updatedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
  };
  db.setRetention(orgId, next);
  return next;
}

/** A candidate is protected while they are hired or deliberately kept in the pool. */
function hired(orgId: string, rec: { jobId: string; stageId?: string | null; decisionStatus: DecisionStatus }): boolean {
  if (rec.decisionStatus !== 'approved' || !rec.stageId) return false;
  const job = db.getJob(orgId, rec.jobId);
  const stages = job?.stages?.length ? job.stages : DEFAULT_STAGES;
  return stages.find((s) => s.id === rec.stageId)?.kind === 'hired';
}

function eligible(orgId: string, days: number, now = Date.now()): ResumeRecord[] {
  const cutoff = now - days * 86_400_000;
  return db
    .listOrgResumes(orgId)
    .filter((rec) => {
      if (rec.inBank) return false;
      if (hired(orgId, rec)) return false;
      const stamp = new Date(rec.updatedAtISO || rec.createdAtISO).getTime();
      return Number.isFinite(stamp) && stamp <= cutoff;
    })
    .sort((a, b) => a.updatedAtISO.localeCompare(b.updatedAtISO));
}

function describe(rec: ResumeRecord): RetentionCandidate {
  return {
    id: rec.id,
    name: rec.anonymizedAtISO ? 'کارجوی ناشناس‌شده' : rec.candidateName || rec.fileName,
    jobId: rec.jobId,
    roleTitle: rec.roleTitle || rec.departmentName,
    updatedAtISO: rec.updatedAtISO,
    decisionStatus: rec.decisionStatus,
  };
}

/** What would happen — shown before anything irreversible runs. */
export function preview(orgId: string, daysOverride?: number): { days: number; action: RetentionAction; items: RetentionCandidate[] } {
  const policy = policyOf(orgId);
  const days = Number.isFinite(daysOverride) ? Math.max(0, Number(daysOverride)) : policy.days;
  return { days, action: policy.action, items: eligible(orgId, days).map(describe) };
}

/**
 * Applies the policy. `dryRun` returns the same list without touching anything;
 * the button says «اجرای آزمایشی» and never claims to have deleted something.
 */
export function sweep(
  orgId: string,
  opts: { days?: number; dryRun?: boolean; actor?: { id: string; name: string } | null } = {}
): RetentionRunResult {
  const policy = policyOf(orgId);
  const days = Number.isFinite(opts.days) ? Math.max(0, Number(opts.days)) : policy.days;
  const targets = eligible(orgId, days);
  const items = targets.map(describe);
  if (opts.dryRun) {
    return { dryRun: true, days, action: policy.action, anonymized: 0, deleted: 0, items };
  }
  let anonymized = 0;
  let deleted = 0;
  for (const rec of targets) {
    if (policy.action === 'delete') {
      db.eraseCandidate(orgId, rec.id);
      deleted += 1;
    } else {
      db.anonymizeCandidate(rec);
      anonymized += 1;
    }
  }
  if (targets.length) {
    const stamp = new Date();
    db.setRetention(orgId, {
      // A one-off window (`days` in the request) never rewrites the saved policy.
      ...policy,
      lastRunAtISO: stamp.toISOString(),
      lastRunAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
      lastRunCount: targets.length,
    });
    db.logActivity(
      orgId,
      opts.actor || null,
      'retention.applied',
      policy.action === 'delete'
        ? `سیاست نگه‌داری: ${deleted.toLocaleString('fa-IR')} رکورد قدیمی‌تر از ${days.toLocaleString('fa-IR')} روز پاک شد`
        : `سیاست نگه‌داری: ${anonymized.toLocaleString('fa-IR')} رکورد قدیمی‌تر از ${days.toLocaleString('fa-IR')} روز ناشناس شد`
    );
  }
  return { dryRun: false, days, action: policy.action, anonymized, deleted, items };
}

/** Hourly housekeeping: a policy nobody clicked «اجرا» on still has to happen. */
export function runDuePolicies(): number {
  let affected = 0;
  for (const org of db.allOrgs()) {
    const policy = db.getRetention(org.id);
    if (!policy || policy.days <= 0) continue;
    const due = Date.now() - new Date(policy.lastRunAtISO || policy.updatedAtISO || 0).getTime() > 86_400_000;
    if (!due) continue;
    try {
      const result = sweep(org.id, { actor: null });
      affected += result.anonymized + result.deleted;
    } catch (err: any) {
      console.error(`[retention] ${org.id}: ${err?.message || err}`);
    }
  }
  return affected;
}

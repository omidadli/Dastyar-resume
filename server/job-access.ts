/**
 * «دسترسی به هر آگهی» — who in the workspace may open an opening.
 *
 * The default is what every other tool does: everybody sees every opening. The
 * moment a search is confidential (a CFO, the founder's replacement, a role a
 * team lead must not learn about) an admin narrows it to a named list, and then
 * the rule has to hold *everywhere* — the list, the board, the candidate panel,
 * the files, the offers and the interviews. Hiding only the list would be a
 * lock on a door with no wall next to it, so every workspace route that resolves
 * a job or a résumé asks this module first.
 *
 * Admins and the owner always see everything (they are the ones who hand out
 * access), and the creator of an opening keeps seeing it even after being
 * removed from the list — otherwise they could lose their own work.
 */
import type { Request, Response } from 'express';
import type { Job, ResumeRecord } from '../src/types/screening';
import type { Role } from '../src/types/app';
import * as db from './db';
import { ctxOf } from './auth';

export interface Viewer {
  id: string;
  role: Role;
}

export const JOB_FORBIDDEN_ERROR = 'این فرصت شغلی برای شما به اشتراک گذاشته نشده است؛ برای دیدن آن از مدیر فضای کاری دسترسی بگیرید.';
export const JOB_FORBIDDEN_CODE = 'JOB_FORBIDDEN';

/** The one rule. Absent fields mean «everyone» — old jobs keep working. */
export function canSeeJob(viewer: Viewer, job: Job | null | undefined): boolean {
  if (!job) return false;
  if (viewer.role !== 'member') return true;
  if (job.accessMode !== 'restricted') return true;
  if (job.createdBy === viewer.id) return true;
  return (job.allowedUserIds || []).includes(viewer.id);
}

/** Openings this person may see, in the usual order. */
export function visibleJobs(orgId: string, viewer: Viewer): Job[] {
  return db.listJobs(orgId).filter((j) => canSeeJob(viewer, j));
}

/**
 * The ids to hand to `queryResumes`. `null` means «no narrowing» — the common
 * case stays a plain org-wide query.
 */
export function visibleJobIds(orgId: string, viewer: Viewer): string[] | null {
  if (viewer.role !== 'member') return null;
  const all = db.listJobs(orgId);
  const visible = all.filter((j) => canSeeJob(viewer, j));
  if (visible.length === all.length) return null;
  return visible.map((j) => j.id);
}

/** A résumé carries its jobId; the job decides. A résumé whose job is gone is unreachable anyway. */
export function canSeeResume(viewer: Viewer, rec: ResumeRecord): boolean {
  const job = rec.orgId ? db.getJob(rec.orgId, rec.jobId) : null;
  return canSeeJob(viewer, job);
}

// ------------------------------------------------------------ route helpers ----

/**
 * `true` = the request was answered and the handler must stop. Only members can
 * be blocked; an admin always passes.
 */
export function blockedByJob(req: Request, res: Response, job: Job | null): boolean {
  if (job && canSeeJob(ctxOf(req).user, job)) return false;
  res.status(403).json({ error: JOB_FORBIDDEN_ERROR, code: JOB_FORBIDDEN_CODE });
  return true;
}

/** For rows that carry a `jobId` instead of the job itself (offers, interviews). */
export function blockedByJobId(req: Request, res: Response, jobId: string | null | undefined): boolean {
  if (!jobId) return false;
  return blockedByJob(req, res, db.getJob(ctxOf(req).org.id, jobId));
}

export function blockedByResume(req: Request, res: Response, rec: ResumeRecord | null): boolean {
  if (!rec) return false;
  if (canSeeResume(ctxOf(req).user, rec)) return false;
  res.status(403).json({ error: JOB_FORBIDDEN_ERROR, code: JOB_FORBIDDEN_CODE });
  return true;
}

/**
 * The access a client needs to render the editor: the mode, the chosen members
 * and the whole team (so an admin can pick without a second request).
 */
export function accessPayload(orgId: string, job: Job) {
  return {
    accessMode: job.accessMode === 'restricted' ? ('restricted' as const) : ('everyone' as const),
    allowedUserIds: job.allowedUserIds || [],
    members: db.listMembers(orgId).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      isCreator: u.id === job.createdBy,
    })),
  };
}

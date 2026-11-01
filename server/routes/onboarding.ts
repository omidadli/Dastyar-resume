/**
 * «تحویل پس از استخدام» — the handover checklist after the offer is signed.
 *
 * The list, the checklist, the welcome mail and a CSV the payroll/HR team can
 * import. No new public surface: everything here needs a session, and a plan
 * belonging to a confidential opening obeys the same per-job lock as the rest
 * of the candidate record.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf } from '../auth';
import { BLIND_MESSAGE, blindOn, blockedByBlind } from '../blind';
import { blockedByResume, visibleJobIds } from '../job-access';
import { h, str } from './util';
import {
  OnboardingError,
  addTask,
  cancelPlan,
  createPlan,
  removePlan,
  removeTask,
  sendWelcome,
  summaryLine,
  toggleTask,
  updatePlan,
  viewOf,
} from '../onboarding';
import type { OnboardingOverview } from '../../src/types/onboarding';
import { ONBOARDING_STATUS_LABEL } from '../../src/types/onboarding';

function fail(res: express.Response, err: unknown) {
  if (err instanceof OnboardingError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

/** A plan's candidate must be visible to whoever is asking. */
function planBlocked(req: express.Request, res: express.Response, row: db.OnboardingRow): boolean {
  const rec = db.getResume(ctxOf(req).org.id, row.resumeId);
  return rec ? blockedByResume(req, res, rec) : false;
}

export function onboardingRoutes() {
  const r = express.Router();

  // A plan is a person's name, e-mail and first day. While «غربالگری بی‌طرف» is
  // on, no screening view may show that — including this one.
  //
  // The path matters: a router-level `use` without one guards *every* `/api`
  // route mounted after it (the inbox, referrals, payroll hand-off), which is
  // not what «hide onboarding names» means.
  r.use('/onboarding', (req, res, next) => {
    if (blindOn(ctxOf(req).org)) {
      return res.status(409).json({ error: BLIND_MESSAGE, code: 'BLIND_REVEAL_REQUIRED' });
    }
    next();
  });

  r.get(
    '/onboarding',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rows = db.listOnboarding(org.id).map((row) => viewOf(row));
      // A member without access to a confidential opening must not see its hires.
      const allowedJobs = visibleJobIds(org.id, ctxOf(req).user);
      const visible = allowedJobs === null ? rows : rows.filter((row) => !row.jobId || allowedJobs.includes(row.jobId));
      const active = visible.filter((i) => i.status !== 'cancelled');
      const payload: OnboardingOverview = {
        items: visible,
        counts: {
          planned: active.filter((i) => i.status === 'planned').length,
          inProgress: active.filter((i) => i.status === 'in_progress').length,
          completed: active.filter((i) => i.status === 'completed').length,
          startingThisWeek: active.filter((i) => i.daysUntil >= 0 && i.daysUntil <= 7).length,
        },
        mailbox: Boolean(db.resolveOrgSecrets(org.id).email),
      };
      res.json(payload);
    })
  );

  /** People the funnel says are hired and who have no handover yet. */
  r.get(
    '/onboarding/hired',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const allowed = visibleJobIds(org.id, user);
      const items = db
        .listOrgResumes(org.id)
        .filter((rec) => (allowed === null ? true : Boolean(rec.jobId && allowed.includes(rec.jobId))))
        .map((rec) => {
          const job = rec.jobId ? db.getJob(org.id, rec.jobId) : null;
          const stage = db.stagesOf(job).find((s) => s.id === rec.stageId);
          return { rec, job, hired: stage?.kind === 'hired' };
        })
        .filter((x) => x.hired && !db.onboardingFor(org.id, x.rec.id))
        .map(({ rec, job }) => ({
          id: rec.id,
          candidateName: rec.candidateName || rec.fileName || 'کارجو',
          candidateEmail: rec.contact?.email || null,
          jobTitle: job?.roleTitle || null,
          departmentName: job?.departmentName || null,
          hiredAtISO: rec.updatedAtISO,
        }));
      res.json({ items });
    })
  );

  /** CSV for the payroll/HR system — the honest version of «HRIS export». */
  r.get(
    '/onboarding/export',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rows = db.listOnboarding(org.id).filter((row) => row.status !== 'cancelled');
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['نام کارجو', 'ایمیل', 'نقش', 'دپارتمان', 'روز شروع (شمسی)', 'مسئول تحویل', 'وضعیت', 'پیشرفت', 'موارد باز'];
      const lines = [header.map(esc).join(',')];
      for (const row of rows) {
        const view = viewOf(row);
        lines.push(
          [
            view.candidateName,
            view.candidateEmail || '',
            view.jobTitle || '',
            view.departmentName || '',
            view.startDateJalali,
            view.ownerName || '',
            ONBOARDING_STATUS_LABEL[view.status],
            summaryLine(row),
            row.tasks.filter((t) => !t.done).map((t) => t.label).join(' | '),
          ]
            .map(esc)
            .join(',')
        );
      }
      // BOM so Excel reads the Persian columns as UTF-8.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="onboarding-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send('\uFEFF' + lines.join('\r\n'));
    })
  );

  r.get(
    '/onboarding/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getOnboarding(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این برنامهٔ تحویل پیدا نشد.' });
      if (planBlocked(req, res, row)) return;
      res.json({ plan: viewOf(row) });
    })
  );

  r.post(
    '/onboarding',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (rec && blockedByResume(req, res, rec)) return;
      try {
        const row = createPlan(org.id, actorOf(req), {
          resumeId: req.body?.resumeId,
          startDateJalali: req.body?.startDateJalali,
          startDateISO: req.body?.startDateISO,
          ownerName: req.body?.ownerName,
          note: req.body?.note,
        });
        res.status(201).json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.patch(
    '/onboarding/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = updatePlan(
          org.id,
          str(req.params.id, 80),
          { startDateJalali: req.body?.startDateJalali, startDateISO: req.body?.startDateISO, ownerName: req.body?.ownerName, note: req.body?.note },
          actorOf(req)
        );
        res.json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/onboarding/:id/tasks',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = addTask(org.id, str(req.params.id, 80), req.body?.label, actorOf(req));
        res.status(201).json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/onboarding/:id/tasks/:taskId/toggle',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = toggleTask(org.id, str(req.params.id, 80), str(req.params.taskId, 80), actorOf(req));
        res.json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/onboarding/:id/tasks/:taskId',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = removeTask(org.id, str(req.params.id, 80), str(req.params.taskId, 80));
        res.json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** The welcome mail is a click, from the workspace's own mailbox. */
  r.post(
    '/onboarding/:id/welcome',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const result = await sendWelcome(org.id, str(req.params.id, 80), actorOf(req));
        res.json({ plan: viewOf(result.plan), emailed: result.emailed });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/onboarding/:id/cancel',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = cancelPlan(org.id, str(req.params.id, 80), actorOf(req));
        res.json({ plan: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/onboarding/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const ok = removePlan(org.id, str(req.params.id, 80), actorOf(req));
      if (!ok) return res.status(404).json({ error: 'این برنامهٔ تحویل پیدا نشد.' });
      res.status(204).end();
    })
  );

  return r;
}

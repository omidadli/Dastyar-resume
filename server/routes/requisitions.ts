/**
 * «نیازمندسنجی» — the workspace cockpit.
 *
 * Reading is open to every member (a recruiter needs to know how many seats are
 * left); writing is `member` and up; decisions and the workspace rule are
 * admin/owner or an explicitly named approver. Nothing here sends a letter or
 * messages a candidate — a requisition is an internal control.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import {
  RequisitionError,
  attachJob,
  canApprove,
  cancelRequisition,
  createRequisition,
  decide,
  detachJob,
  hold,
  readSettings,
  rollup,
  saveSettings,
  submitForApproval,
  summaryOf,
  updateRequisition,
  viewOf,
} from '../requisitions';

function fail(res: express.Response, err: unknown) {
  if (err instanceof RequisitionError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

export function requisitionRoutes() {
  const r = express.Router();

  /** The rollup the list header and the dashboard read. */
  r.get('/requisitions/summary', (req, res) => {
    const { org } = ctxOf(req);
    res.json({ rollup: rollup(org.id), settings: db.getRequisitionSettings(org.id) });
  });

  // Declared before `/:id` so the literal path wins the match.
  r.get('/requisitions/settings', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    res.json(readSettings(org.id));
  });

  r.get('/requisitions', (req, res) => {
    const { org } = ctxOf(req);
    const status = str(req.query?.status, 20);
    const rows = db.listRequisitions(org.id, {
      departmentId: str(req.query?.departmentId, 80) || undefined,
      status: (['draft', 'pending', 'approved', 'rejected', 'on_hold', 'filled', 'cancelled'] as const).find((s) => s === status),
    });
    res.json({ items: rows.map(summaryOf) });
  });

  r.get(
    '/requisitions/:id',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getRequisition(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'نیازمندسنجی پیدا نشد.' });
      const gate = canApprove(org.id, row, { id: user.id, role: user.role });
      res.json({
        requisition: viewOf(row),
        canApprove: gate.allowed,
        cannotApproveReason: gate.reason,
        /** True when the rule bends because nobody else could sign it. */
        selfApprovalOnly: gate.selfApprovalOnly,
        // The jobs of the same department that are not attached anywhere yet —
        // the only ones the picker offers.
        attachableJobs: db
          .listJobs(org.id)
          .filter((j) => j.departmentId === row.departmentId && !j.requisitionId)
          .map((j) => ({ id: j.id, roleTitle: j.roleTitle, status: j.status, isPublic: Boolean(j.isPublic) })),
      });
    })
  );

  r.post(
    '/requisitions',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = createRequisition(org.id, { id: user.id, name: user.name }, req.body || {});
        res.status(201).json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.patch(
    '/requisitions/:id',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = updateRequisition(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, req.body || {});
        res.json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/requisitions/:id/submit',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        res.json({ requisition: viewOf(submitForApproval(org.id, str(req.params.id, 80), { id: user.id, name: user.name })) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /** «تأیید» / «رد» — with the seats granted, which may be fewer than asked for. */
  r.post(
    '/requisitions/:id/decision',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = decide(org.id, str(req.params.id, 80), user, req.body || {});
        res.json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/requisitions/:id/hold',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        res.json({ requisition: viewOf(hold(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, true)) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/requisitions/:id/resume',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        res.json({ requisition: viewOf(hold(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, false)) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/requisitions/:id/cancel',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancelRequisition(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, str(req.body?.note, 500));
        res.json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/requisitions/:id/jobs',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = attachJob(org.id, str(req.params.id, 80), str(req.body?.jobId, 80), { id: user.id, name: user.name });
        res.json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.delete(
    '/requisitions/:id/jobs/:jobId',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = detachJob(org.id, str(req.params.id, 80), str(req.params.jobId, 80), { id: user.id, name: user.name });
        res.json({ requisition: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.put(
    '/requisitions/settings',
    requireRole('admin'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const settings = saveSettings(org.id, { id: user.id, name: user.name }, req.body || {});
        res.json({ settings });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  return r;
}

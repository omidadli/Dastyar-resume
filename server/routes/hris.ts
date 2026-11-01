/**
 * «انتقال به حقوق و دستمزد» — routes.
 *
 * Five calls: read the payroll roster, change the column names, download the
 * file, point at the receiver, and send. Nothing here runs on a timer, and no
 * route ever invents a value payroll expects (an empty cell stays empty).
 */
import express from 'express';
import { actorOf, ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import * as db from '../db';
import { HrisError, mappingOf, normalizeMapping, pushRoster, rosterFor, saveEndpoint, toCsv } from '../hris';
import { h } from './util';

function fail(res: express.Response, err: unknown) {
  if (err instanceof HrisError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

function adminOnly(req: express.Request, res: express.Response): boolean {
  const { user } = ctxOf(req);
  if (user.role === 'admin' || user.role === 'owner') return true;
  res.status(403).json({ error: 'تنظیم اتصال حقوق و دستمزد فقط با مدیر فضای کاری است.' });
  return false;
}

export function hrisRoutes() {
  const r = express.Router();

  r.get(
    '/hris',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      // Payroll means names and salaries: blind mode is not compatible with it.
      if (blockedByBlind(org, res)) return;
      res.json(rosterFor(org.id));
    })
  );

  /** Column names are HR's, not ours: rename, reorder (by field order) or drop. */
  r.patch(
    '/hris/mapping',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const mapping = normalizeMapping(req.body?.mapping, mappingOf(org.id));
        const existing = db.getHrisConfig(org.id);
        if (existing) {
          db.saveHrisConfig({ ...existing, mapping, updatedAtISO: new Date().toISOString() });
        } else {
          // No endpoint yet: the mapping is stored on its own row (no URL), and
          // `endpointView` keeps reporting «تنظیم نشده» until one is added.
          db.saveHrisConfig({
            orgId: org.id,
            urlEnc: '',
            secretEnc: '',
            secretHint: '',
            urlHost: '',
            urlMasked: '',
            mapping,
            updatedAtISO: new Date().toISOString(),
          });
        }
        res.json({ mapping, roster: rosterFor(org.id) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/hris/export.csv',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const roster = rosterFor(org.id);
      const csv = toCsv(roster.items, roster.mapping);
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="hovida-payroll-${stamp}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(csv);
    })
  );

  r.put(
    '/hris/endpoint',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (!adminOnly(req, res)) return;
      try {
        const row = saveEndpoint(org.id, { url: req.body?.url, secret: req.body?.secret });
        db.logActivity(org.id, actorOf(req), 'settings.changed', `گیرندهٔ فایل حقوق را تنظیم کرد (${row.urlHost})`, {
          jobId: null,
          resumeId: null,
        });
        res.json({ roster: rosterFor(org.id) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/hris/endpoint',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (!adminOnly(req, res)) return;
      const existing = db.getHrisConfig(org.id);
      if (existing) {
        // The mapping is HR's work; removing the receiver must not erase it.
        db.saveHrisConfig({ ...existing, urlEnc: '', secretEnc: '', secretHint: '', urlHost: '', urlMasked: '' });
        db.logActivity(org.id, actorOf(req), 'settings.changed', 'اتصال به سیستم حقوق و دستمزد را برداشت', { jobId: null, resumeId: null });
      }
      res.json({ roster: rosterFor(org.id) });
    })
  );

  r.post(
    '/hris/push',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      // Sending salaries to another system is an admin action, decided by a human.
      if (!adminOnly(req, res)) return;
      if (blockedByBlind(org, res)) return;
      try {
        const result = await pushRoster(org.id, actorOf(req));
        res.json({ push: result.push, roster: rosterFor(org.id) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

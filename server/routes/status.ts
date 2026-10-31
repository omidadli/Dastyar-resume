/**
 * «پیگیری درخواست» — one public route with a token, three workspace routes.
 *
 * The public route is deliberately tiny: it answers only what the candidate is
 * allowed to know, and it is mounted before `requireAuth` so the candidate never
 * needs an account.
 */
import express from 'express';
import { actorOf, ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { blockedByResume } from '../job-access';
import * as db from '../db';
import { StatusError, createLink, listLinks, publicStatus, revokeLink } from '../status';
import { h, str } from './util';

function fail(res: express.Response, err: unknown) {
  if (err instanceof StatusError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

export function statusPublicRoutes() {
  const r = express.Router();

  r.get(
    '/status/:token',
    h(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        res.json({ status: publicStatus(str(req.params.token, 120)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

export function statusRoutes() {
  const r = express.Router();

  /** The link HR copies and sends. Creating a new one revokes the previous. */
  r.post(
    '/resumes/:id/status-link',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      try {
        res.status(201).json({ link: createLink(org.id, rec.id, actorOf(req).name) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/resumes/:id/status-links',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      res.json({ items: listLinks(org.id, rec.id) });
    })
  );

  r.delete(
    '/status-links/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getStatusLink(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این لینک پیدا نشد.' });
      const rec = db.getResume(org.id, row.resumeId);
      if (rec && blockedByResume(req, res, rec)) return;
      try {
        res.json({ link: revokeLink(org.id, row.id) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

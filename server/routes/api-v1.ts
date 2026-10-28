/**
 * `/api/v1` — the documented REST API.
 *
 * Mounted ahead of the session middleware and authenticated by an API key, so a
 * customer's system can read the hiring record without a person's browser.
 *
 * Design rules:
 *   - only what an outside system genuinely needs: openings, candidates, a
 *     decision; never mail, never deletion, never a file with a personal photo;
 *   - the shape is the same as the app's (`ResumeListItem`), so a field added
 *     for the UI is immediately available to integrators;
 *   - every response carries `apiVersion`, and errors are `{ error, code }` —
 *     the same contract the app itself uses.
 */
import express from 'express';
import * as db from '../db';
import { apiOf, requireApiKey } from '../api-keys';
import { h, int, oneOf, str } from './util';
import { blindLabel, blindOn } from '../blind';
import { appVersion } from '../version';
import type { DecisionStatus, MatchFilter, NoveltyFilter } from '../../src/types/screening';

const API_VERSION = 1;

/** One place that stamps the envelope, so no endpoint drifts. */
function send(res: express.Response, body: Record<string, unknown>, status = 200) {
  res.status(status).json({ apiVersion: API_VERSION, ...body });
}

export function apiV1Routes(): express.Router {
  const r = express.Router();

  // Unauthenticated liveness probe: a customer's monitor should not need a key.
  r.get('/v1/health', (_req, res) => {
    send(res, { ok: true, service: 'hovida', version: appVersion(), time: new Date().toISOString() });
  });

  r.use('/v1', requireApiKey('read'));

  r.get(
    '/v1/me',
    h(async (req, res) => {
      const { key, org } = apiOf(req);
      send(res, {
        workspace: { id: org.id, name: org.name },
        key: { id: key.id, name: key.name, scopes: key.scopes },
      });
    })
  );

  r.get(
    '/v1/jobs',
    h(async (req, res) => {
      const { org } = apiOf(req);
      const status = oneOf(req.query.status, ['open', 'closed', 'archived'] as const, 'open');
      const all = db.listJobs(org.id).map(db.toJobSummary);
      const filtered = req.query.status ? all.filter((j) => j.status === status) : all;
      send(res, {
        items: filtered.map((j) => ({
          id: j.id,
          roleTitle: j.roleTitle || j.departmentName,
          departmentName: j.departmentName,
          location: j.location,
          employmentType: j.employmentType,
          status: j.status,
          createdAtISO: j.createdAtISO,
          updatedAtISO: j.updatedAtISO,
          stats: j.stats,
          stages: j.stages?.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
        })),
        total: filtered.length,
      });
    })
  );

  r.get(
    '/v1/jobs/:id',
    h(async (req, res) => {
      const { org } = apiOf(req);
      const job = db.getJob(org.id, str(req.params.id, 80));
      if (!job) return send(res, { error: 'فرصت شغلی پیدا نشد.', code: 'JOB_NOT_FOUND' }, 404);
      const summary = db.toJobSummary(job);
      send(res, {
        job: {
          id: summary.id,
          roleTitle: summary.roleTitle || summary.departmentName,
          departmentName: summary.departmentName,
          location: summary.location,
          employmentType: summary.employmentType,
          status: summary.status,
          extraNotes: summary.extraNotes,
          createdAtISO: summary.createdAtISO,
          updatedAtISO: summary.updatedAtISO,
          stats: summary.stats,
          stages: summary.stages?.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
          criteria: job.understanding?.criteria?.map((c) => ({ id: c.id, title: c.title, weight: c.weight, mustHave: c.mustHave })),
        },
      });
    })
  );

  r.get(
    '/v1/candidates',
    h(async (req, res) => {
      const { org } = apiOf(req);
      const page = db.queryResumes(org.id, {
        jobId: str(req.query.jobId, 80) || undefined,
        departmentId: str(req.query.departmentId, 80) || undefined,
        q: str(req.query.q, 120) || undefined,
        match: oneOf<MatchFilter>(req.query.match, ['all', 'high', 'review', 'low', 'insufficient'], 'all'),
        novelty: oneOf<NoveltyFilter>(req.query.novelty, ['all', 'new', 'duplicate', 'unknown'], 'all'),
        decision: oneOf(req.query.decision, ['all', 'undecided', 'pending', 'approved', 'rejected', 'review'] as const, 'all'),
        sort: oneOf(req.query.sort, ['match', 'newest', 'oldest', 'experience', 'name', 'decided'] as const, 'newest'),
        page: req.query.page ? int(req.query.page, 1) : 1,
        pageSize: req.query.pageSize ? Math.min(100, int(req.query.pageSize, 25)) : 25,
      });
      send(res, {
        items: page.items.map((c) => ({
          id: c.id,
          jobId: c.jobId,
          // An API key sees what the browser sees: no identity in blind mode.
          name: blindOn(org) ? blindLabel(c.id) : c.candidateName || c.fileName,
          roleTitle: c.roleTitle || c.departmentName,
          score: c.score,
          category: c.category,
          decision: c.decisionStatus,
          stageId: c.stageId,
          source: c.source,
          contact: blindOn(org) ? null : c.contact || null,
          createdAtISO: c.createdAtISO,
          decidedAtISO: c.decidedAtISO,
        })),
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        totalPages: page.totalPages,
      });
    })
  );

  r.get(
    '/v1/candidates/:id',
    h(async (req, res) => {
      const { org } = apiOf(req);
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return send(res, { error: 'کاندیدا پیدا نشد.', code: 'CANDIDATE_NOT_FOUND' }, 404);
      const job = db.getJob(org.id, rec.jobId);
      const item = db.toListItem(rec);
      send(res, {
        candidate: blindOn(org) ? { ...item, candidateName: blindLabel(rec.id), fileName: '', contact: null, filePath: null } : item,
        job: job ? { id: job.id, roleTitle: job.roleTitle, status: job.status } : null,
      });
    })
  );

  // The only write an API key may perform. It is recorded in the activity feed
  // exactly like a decision made in the browser, with the key's name as actor.
  r.post(
    '/v1/candidates/:id/decision',
    requireApiKey('write'),
    h(async (req, res) => {
      const { key, org } = apiOf(req);
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return send(res, { error: 'کاندیدا پیدا نشد.', code: 'CANDIDATE_NOT_FOUND' }, 404);
      const raw = req.body?.status;
      if (!['approved', 'rejected', 'review', 'none'].includes(raw)) {
        return send(res, { error: 'وضعیت باید approved، rejected، review یا none باشد.', code: 'INVALID_STATUS' }, 400);
      }
      const status = raw as DecisionStatus;
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 400) : '';
      const actor = { id: `apikey:${key.id}`, name: `کلید API «${key.name}»` };
      db.setDecision(rec, status, note || null, actor);
      db.logActivity(org.id, actor, 'decision', `از طریق API تصمیم «${rec.candidateName || rec.fileName}» را «${status}» ثبت کرد`, {
        jobId: rec.jobId,
        resumeId: rec.id,
      });
      send(res, { candidate: db.toListItem(rec) });
    })
  );

  r.use('/v1', (_req, res) => send(res, { error: 'این مسیر در API وجود ندارد.', code: 'NOT_FOUND' }, 404));

  return r;
}

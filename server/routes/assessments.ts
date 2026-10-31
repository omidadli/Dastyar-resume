/**
 * «آزمون و ارزیابی» — two routers:
 *   • `assessmentPublicRoutes()` — no session. The token is the key: read the
 *     test, mark the first open, submit once. Nothing about the candidate's
 *     workspace, score or colleagues is reachable from here.
 *   • `assessmentRoutes()` — inside the workspace: the catalogue, creating a
 *     link, sending it by e-mail, cancelling it, and recording a result that an
 *     outside provider produced.
 */
import express from 'express';
import type { Request } from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  AssessmentError,
  cancelInvite,
  canAnswer,
  createInvite,
  markStarted,
  publicView,
  recordExternal,
  sendInvite,
  submitAnswers,
  suggestTemplateId,
  templateForSend,
  templateSummaries,
  viewOf,
} from '../assessments';

function originOf(req: Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof AssessmentError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

/** A public form must not become a free compute source. */
const attempts = new Map<string, number[]>();
const HOUR = 3600_000;
function tooMany(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < HOUR);
  attempts.set(ip, list);
  return list.length >= 40;
}
function noteAttempt(ip: string) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}

function ipOf(req: Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || 'unknown';
}

// --------------------------------------------------------------- public -----

export function assessmentPublicRoutes() {
  const r = express.Router();

  r.get(
    '/assessment/public/:token',
    h(async (req, res) => {
      const row = db.findAssessmentByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک آزمون معتبر نیست.' });
      res.json({ assessment: publicView(row), canAnswer: canAnswer(row) });
    })
  );

  /** The first open is recorded once; a refresh does not move the timestamp. */
  r.post(
    '/assessment/public/:token/start',
    h(async (req, res) => {
      const row = db.findAssessmentByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک آزمون معتبر نیست.' });
      res.json({ assessment: publicView(markStarted(row)) });
    })
  );

  r.post(
    '/assessment/public/:token/submit',
    h(async (req, res) => {
      const ip = ipOf(req);
      if (tooMany(ip)) return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد بود؛ یک ساعت دیگر دوباره امتحان کنید.' });
      noteAttempt(ip);
      const row = db.findAssessmentByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک آزمون معتبر نیست.' });
      try {
        const saved = submitAnswers(row, req.body?.answers);
        res.json({ assessment: publicView(saved), thanks: 'پاسخ شما ثبت شد؛ سپاسگزاریم.' });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function assessmentRoutes() {
  const r = express.Router();

  r.get(
    '/assessments/templates',
    h(async (req, res) => {
      const hint = suggestTemplateId(str(req.query.jobTitle, 160));
      res.json({ templates: templateSummaries(), suggestedId: hint });
    })
  );

  /** Member-level read: an interviewer must see the result before the next round. */
  r.get(
    '/assessments',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const base = originOf(req);
      const items = db
        .listAssessments(org.id, { jobId: str(req.query.jobId, 80) || undefined, resumeId: str(req.query.resumeId, 80) || undefined })
        .map((row) => viewOf(row, base));
      const completed = items.filter((a) => a.status === 'completed');
      const scored = completed.filter((a) => a.score !== null);
      res.json({
        items,
        summary: {
          total: items.length,
          completed: completed.length,
          pending: items.filter((a) => a.status === 'sent' || a.status === 'started').length,
          averageScore: scored.length ? Math.round(scored.reduce((n, a) => n + (a.score || 0), 0) / scored.length) : null,
          external: completed.filter((a) => a.source === 'external').length,
        },
      });
    })
  );

  r.get(
    '/assessments/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getAssessment(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'آزمون پیدا نشد.' });
      res.json({ assessment: viewOf(row, originOf(req)) });
    })
  );

  /** Creates the link only — nothing leaves the server until `/:id/send`. */
  r.post(
    '/assessments',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const row = createInvite(org.id, user, {
          resumeId: req.body?.resumeId,
          templateId: req.body?.templateId,
          jobId: req.body?.jobId,
        });
        res.status(201).json({ assessment: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/assessments/:id/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const row = db.getAssessment(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'آزمون پیدا نشد.' });
      try {
        const result = await sendInvite(org.id, row.id, viewOf(row, originOf(req)).url || '', user);
        res.json({ assessment: viewOf(result.assessment, originOf(req)), emailed: result.emailed });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/assessments/:id/cancel',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancelInvite(org.id, str(req.params.id, 80), user);
        res.json({ assessment: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /**
   * The provider contract: an outside test service (or a human) writes the
   * result here. It is labelled `external` in the record and in the panel.
   */
  r.post(
    '/assessments/:id/result',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = recordExternal(
          org.id,
          str(req.params.id, 80),
          { score: req.body?.score, dimensions: req.body?.dimensions, note: req.body?.note },
          user
        );
        res.json({ assessment: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** The preview a recruiter reads before sending: how the test is scored. */
  r.get(
    '/assessments/templates/:id',
    h(async (req, res) => {
      const tpl = templateForSend(str(req.params.id, 80));
      if (!tpl) return res.status(404).json({ error: 'این آزمون در بانک موجود نیست.' });
      res.json({
        template: {
          id: tpl.id,
          name: tpl.name,
          kind: tpl.kind,
          summary: tpl.summary,
          intro: tpl.intro,
          durationMinutes: tpl.durationMinutes,
          reading: tpl.reading,
          scored: tpl.scored,
          dimensions: tpl.dimensions,
          questions: tpl.questions.map((q) =>
            q.type === 'single'
              ? { id: q.id, type: q.type, text: q.text, options: q.options.map((o) => ({ id: o.id, label: o.label })) }
              : { id: q.id, type: q.type, text: q.text, dimension: q.dimension, reverse: Boolean(q.reverse) }
          ),
        },
      });
    })
  );

  return r;
}

/**
 * «تجربهٔ کارجو» — the survey link and its results.
 *
 * Two routers:
 *   • `surveyPublicRoutes()` — no session; the token in the e-mail is the key.
 *     It can read the question, register the first open, and submit once.
 *   • `surveyRoutes()` — inside the workspace: create the invitation, send it by
 *     e-mail on an explicit click, cancel it, and read the answers.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { h, int, str } from './util';
import { SurveyError, createInvite, markOpened, publicView, report, sendInvite, submitAnswer } from '../surveys';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import type { SurveyInvite } from '../../src/types/survey';

function originOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function publicUrl(req: express.Request, token: string): string {
  return `${originOf(req)}/survey/${token}`;
}

/** The workspace-facing shape: no token, but the shareable link. */
function viewOf(req: express.Request, row: db.SurveyInviteRow): SurveyInvite {
  const { orgId: _o, token, ...rest } = row;
  return { ...rest, url: publicUrl(req, token) };
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof SurveyError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// --------------------------------------------------------------- public -----

export function surveyPublicRoutes() {
  const r = express.Router();

  r.get(
    '/survey/public/:token',
    h(async (req, res) => {
      const row = db.findSurveyByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک نظرسنجی معتبر نیست.' });
      res.json({ survey: publicView(row) });
    })
  );

  /** A page that is actually opened is different from a link that was only sent. */
  r.post(
    '/survey/public/:token/open',
    h(async (req, res) => {
      const row = db.findSurveyByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک نظرسنجی معتبر نیست.' });
      res.json({ survey: publicView(markOpened(row)) });
    })
  );

  r.post(
    '/survey/public/:token/answer',
    h(async (req, res) => {
      const row = db.findSurveyByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک نظرسنجی معتبر نیست.' });
      try {
        const saved = submitAnswer(row, { score: req.body?.score, comment: req.body?.comment, answers: req.body?.answers });
        res.json({ survey: publicView(saved), thanks: 'پاسخ شما ثبت شد؛ سپاسگزاریم.' });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function surveyRoutes() {
  const r = express.Router();

  r.get(
    '/surveys',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const items = db
        .listSurveys(org.id, { jobId: str(req.query.jobId, 80) || undefined, resumeId: str(req.query.resumeId, 80) || undefined })
        .map((row) => viewOf(req, row));
      res.json({ items, report: report(org.id) });
    })
  );

  r.get(
    '/surveys/report',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const range = str(req.query.range, 10);
      const days = range === 'all' ? null : Math.max(1, int(range, 365));
      res.json({ report: report(org.id, days) });
    })
  );

  /** Creates the invitation only — no e-mail leaves until `/:id/send`. */
  r.post(
    '/surveys',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const row = createInvite(org.id, user, {
          resumeId: req.body?.resumeId,
          stage: req.body?.stage,
          candidateName: req.body?.candidateName,
          candidateEmail: req.body?.candidateEmail,
          jobTitle: req.body?.jobTitle,
        });
        res.status(201).json({ survey: viewOf(req, row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/surveys/:id/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getSurvey(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'نظرسنجی پیدا نشد.' });
      try {
        const result = await sendInvite(org.id, row.id, publicUrl(req, row.token), user);
        res.json({ survey: viewOf(req, result.survey), emailed: result.emailed, emailError: result.emailError });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/surveys/:id/cancel',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getSurvey(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'نظرسنجی پیدا نشد.' });
      if (row.status === 'answered') return res.status(409).json({ error: 'این نظرسنجی پاسخ داده شده و قابل لغو نیست.' });
      const stamp = new Date();
      const next = db.saveSurvey({
        ...row,
        status: 'expired',
        expiresAtISO: stamp.toISOString(),
      });
      res.json({ survey: viewOf(req, next) });
    })
  );

  /** A record that the workspace looked at the answers (nothing leaves the app). */
  r.get(
    '/surveys/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getSurvey(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'نظرسنجی پیدا نشد.' });
      const answeredAt = row.answeredAtISO ? formatJalaliDate(tehranJalaliOf(new Date(row.answeredAtISO)), true) : null;
      res.json({ survey: viewOf(req, row), answeredAtJalali: answeredAt });
    })
  );

  return r;
}

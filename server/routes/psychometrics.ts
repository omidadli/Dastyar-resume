/**
 * «سنجش نرم‌شده» — the candidate's token page and the workspace's cockpit.
 *
 *   • `psychPublicRoutes()` — no session. The token opens the test; the answers
 *     come back one click at a time so a refresh does not lose them; submitting is
 *     final and the page never receives the scores.
 *   • `psychRoutes()` — the workspace: send, cancel, read one result, read the
 *     scales with their reading, set a norm table, and see a group report that
 *     suppresses small groups.
 *
 * The norm table is HR's own data; it is never sent to a candidate and never
 * applied silently — the reading always names the group it used.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  PsychError,
  PSYCH_SCALES,
  PSYCH_TTL_DAYS,
  cancel,
  createInvite,
  decline,
  groupReport,
  inviteView,
  publicView,
  saveAnswers,
  scaleSummaries,
  sendInvite,
  start,
  submit,
} from '../psychometrics';
import { MIN_NORM_N, SMALL_GROUP } from '../../src/types/psychometrics';
import { codingOriginOf } from './coding';

function fail(res: express.Response, err: unknown) {
  if (err instanceof PsychError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// --------------------------------------------------------------- public -----

export function psychPublicRoutes() {
  const r = express.Router();

  r.get(
    '/psych/public/:token',
    h(async (req, res) => {
      const row = db.findPsychInviteByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک آزمون معتبر نیست.' });
      try {
        start(str(req.params.token, 80));
        res.json({ test: publicView(codingOriginOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** Answers are saved progressively; nothing is scored until submission. */
  r.post(
    '/psych/public/:token/answers',
    h(async (req, res) => {
      try {
        const row = saveAnswers(str(req.params.token, 80), req.body?.answers);
        res.json({ saved: true, answered: row.answers ? Object.keys(row.answers).length : 0 });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/psych/public/:token/submit',
    h(async (req, res) => {
      const token = str(req.params.token, 80);
      try {
        // The last save arrives with the submit, so a dropped request never loses answers.
        saveAnswers(token, req.body?.answers);
        const row = submit(token);
        // No scores on this page — only that it was received.
        const view = publicView(codingOriginOf(req), row);
        res.json({ test: { ...view, items: [], scale: [] } });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** «این مرحله را انجام نمی‌دهم» — a real answer, and it closes the link. */
  r.post(
    '/psych/public/:token/decline',
    h(async (req, res) => {
      const token = str(req.params.token, 80);
      const row = db.findPsychInviteByToken(token);
      if (!row) return res.status(404).json({ error: 'این لینک آزمون معتبر نیست.' });
      try {
        decline(token, codingOriginOf(req));
        res.json({ test: publicView(codingOriginOf(req), db.findPsychInviteByToken(token) || row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function psychRoutes() {
  const r = express.Router();

  /** What the scales mean — the same text HR reads next to any result. */
  r.get('/psych/scales', (req, res) => {
    res.json({
      scales: scaleSummaries(),
      ttlDays: PSYCH_TTL_DAYS,
      smallGroup: SMALL_GROUP,
      minNormN: MIN_NORM_N,
    });
  });

  r.get(
    '/psych/invites',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const items = db
        .listPsychInvites(org.id, { resumeId: str(req.query?.resumeId, 80) || undefined, jobId: str(req.query?.jobId, 80) || undefined })
        .map((row) => inviteView(codingOriginOf(req), row));
      res.json({ items });
    })
  );

  r.post(
    '/psych/invites',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const row = createInvite(org.id, { id: user.id, name: user.name }, { resumeId: req.body?.resumeId });
        res.status(201).json({ invite: inviteView(codingOriginOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/psych/invites/:id/send',
    requireRole('member'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = await sendInvite(org.id, str(req.params.id, 80), codingOriginOf(req), { id: user.id, name: user.name });
        res.json({ invite: inviteView(codingOriginOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/psych/invites/:id/cancel',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancel(org.id, str(req.params.id, 80), { id: user.id, name: user.name });
        res.json({ invite: inviteView(codingOriginOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /** One result, with the reading for each scale — never the answer sheet. */
  r.get(
    '/psych/invites/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getPsychInvite(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'آزمون پیدا نشد.' });
      res.json({
        invite: inviteView(codingOriginOf(req), row),
        reading: PSYCH_SCALES.map((s) => ({ id: s.id, label: s.label, high: s.high, low: s.low })),
      });
    })
  );

  // ----------------------------------------------------------- the norms --
  r.get('/psych/norms', (req, res) => {
    const { org } = ctxOf(req);
    const config = db.getPsychNorms(org.id);
    res.json({ norms: config, minNormN: MIN_NORM_N, scales: PSYCH_SCALES.map((sc) => ({ id: sc.id, label: sc.label })) });
  });

  r.put(
    '/psych/norms',
    requireRole('admin'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      const source = str(req.body?.source, 120);
      const n = Number(req.body?.n);
      if (!source) return res.status(400).json({ error: 'برای هنجار، نام گروه مقایسه لازم است.', code: 'SOURCE_REQUIRED' });
      if (!Number.isFinite(n) || n < 1 || n > 1_000_000) return res.status(400).json({ error: 'تعداد نفرات گروه مقایسه باید یک عدد مثبت باشد.', code: 'BAD_N' });
      const input = (req.body?.scales || {}) as Record<string, { mean?: unknown; sd?: unknown }>;
      const scales: Record<string, { mean: number; sd: number }> = {};
      for (const sc of PSYCH_SCALES) {
        const row = input[sc.id];
        if (!row) continue;
        const mean = Number(row.mean);
        const sd = Number(row.sd);
        if (!Number.isFinite(mean) || !Number.isFinite(sd) || sd <= 0) {
          return res.status(400).json({ error: `برای «${sc.label}» میانگین و انحراف معیار مثبت لازم است.`, code: 'BAD_STATS' });
        }
        scales[sc.id] = { mean, sd };
      }
      if (!Object.keys(scales).length) return res.status(400).json({ error: 'دست‌کم برای یک مقیاس، میانگین و انحراف معیار وارد کنید.', code: 'NO_SCALES' });
      const saved = db.savePsychNorms(org.id, {
        source,
        n,
        scales,
        updatedAtISO: new Date().toISOString(),
        updatedByName: user.name,
      });
      db.logActivity(org.id, user, 'psych.norms', `هنجار مقایسه‌ای «${source}» ثبت شد (n=${n})`, {});
      res.json({ norms: saved });
    }
  );

  r.delete('/psych/norms', requireRole('admin'), (req, res) => {
    const { org, user } = ctxOf(req);
    db.dropPsychNorms(org.id);
    db.logActivity(org.id, user, 'psych.norms', 'هنجار مقایسه‌ای حذف شد؛ نتیجه‌ها از این پس «بدون هنجار» نمایش داده می‌شوند', {});
    res.json({ norms: null });
  });

  /** Group view for one job — averages suppressed for small groups. */
  r.get(
    '/psych/report',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        res.json({ report: groupReport(org.id, str(req.query?.jobId, 80)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

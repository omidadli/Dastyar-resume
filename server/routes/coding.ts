/**
 * «چالش کد» — the token page for the candidate and the cockpit inside the
 * workspace.
 *
 *   • `codingPublicRoutes()` — no session. The token is the key: read the task,
 *     run the visible tests, submit once, or say «مناسب نیست».
 *   • `codingRoutes()` — the workspace: the challenge bank, invitations, sending,
 *     cancelling and reading results.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  CodingError,
  cancel,
  createInvite,
  inviteOf,
  inviteView,
  practiceRun,
  publicView,
  sendInvite,
  submit,
} from '../coding';
import { challengeSummaries, findChallenge } from '../code-challenges';

function originOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof CodingError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// --------------------------------------------------------------- public -----

export function codingPublicRoutes() {
  const r = express.Router();

  r.get(
    '/code/public/:token',
    h(async (req, res) => {
      const row = db.findCodeInviteByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک تمرین معتبر نیست.' });
      try {
        res.json({ challenge: publicView(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** «اجرا» — visible tests only, nothing is graded, nothing is stored. */
  r.post(
    '/code/public/:token/run',
    h(async (req, res) => {
      try {
        const out = await practiceRun(str(req.params.token, 80), str(req.body?.code, 40_000), originOf(req));
        res.json({ run: out.run, challenge: out.publicChallenge, runsLeft: out.runsLeft });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** «ارسال پاسخ» — graded once, final. */
  r.post(
    '/code/public/:token/submit',
    h(async (req, res) => {
      try {
        const row = await submit(str(req.params.token, 80), str(req.body?.code, 40_000), originOf(req));
        res.json({ challenge: publicView(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** «این تمرین مناسب من نیست» — an honest exit, recorded, never punished. */
  r.post(
    '/code/public/:token/decline',
    h(async (req, res) => {
      const row = db.findCodeInviteByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک تمرین معتبر نیست.' });
      if (row.status === 'submitted') return res.status(409).json({ error: 'پاسخ شما ثبت شده است.' });
      const next = db.saveCodeInvite({ ...row, status: 'declined' });
      db.logActivity(row.orgId, null, 'code.cancelled', `«${row.candidateName}» تمرین کد را نپذیرفت`, { resumeId: row.resumeId });
      res.json({ challenge: publicView(originOf(req), next) });
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function codingRoutes() {
  const r = express.Router();

  /** The bank, with the rubric HR needs to read a result fairly. */
  r.get('/code/challenges', (req, res) => {
    res.json({ challenges: challengeSummaries(), maxRuns: 20 });
  });

  r.get(
    '/code/invites',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const items = db.listCodeInvites(org.id, { resumeId: str(req.query?.resumeId, 80) || undefined }).map((row) => inviteView(originOf(req), row));
      res.json({ items });
    })
  );

  r.post(
    '/code/invites',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (blockedByBlind(org, res)) return;
      try {
        const row = createInvite(org.id, { id: user.id, name: user.name }, { resumeId: rec?.id, challengeId: req.body?.challengeId });
        res.status(201).json({ invite: inviteView(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/code/invites/:id/send',
    requireRole('member'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = await sendInvite(org.id, str(req.params.id, 80), originOf(req), { id: user.id, name: user.name });
        res.json({ invite: inviteView(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/code/invites/:id/cancel',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancel(org.id, str(req.params.id, 80), { id: user.id, name: user.name });
        res.json({ invite: inviteView(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  /** One invitation with the challenge's rubric — for the person reading it. */
  r.get(
    '/code/invites/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = inviteOf(org.id, str(req.params.id, 80));
        const challenge = findChallenge(row.challengeId);
        res.json({
          invite: inviteView(originOf(req), row),
          rubric: challenge?.rubric || '',
          tests: (challenge?.tests || []).map((t) => ({ name: t.name, hidden: Boolean(t.hidden) })),
        });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

export { originOf as codingOriginOf };

/**
 * «استعلام مرجع» — the referee link and the hiring team's view of it.
 *
 * Two routers, same split as every other candidate-facing surface:
 *   • `referencePublicRoutes()` — no session. The token in the e-mail is the key;
 *     it can read its own questions, register the first open, answer once, or
 *     decline politely. It never sees the candidate's contact details, the
 *     other referees, the notes or the final decision.
 *   • `referenceRoutes()` — inside the workspace: consent, referees, sending,
 *     phone records and the summary.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  ReferenceError,
  addReferee,
  caseOf,
  decline,
  markOpened,
  publicView,
  recordByPhone,
  recordConsent,
  removeReferee,
  sendInvitation,
  sendReminder,
  submitAnswer,
  updateReferee,
  viewOf,
} from '../references';

function originOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof ReferenceError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// --------------------------------------------------------------- public -----

export function referencePublicRoutes() {
  const r = express.Router();

  r.get(
    '/reference/public/:token',
    h(async (req, res) => {
      const row = db.findRefereeByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک استعلام معتبر نیست.' });
      res.json({ reference: publicView(row) });
    })
  );

  /** A link that was opened is different from one that was only sent. */
  r.post(
    '/reference/public/:token/open',
    h(async (req, res) => {
      const row = markOpened(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک استعلام معتبر نیست.' });
      res.json({ reference: publicView(row) });
    })
  );

  r.post(
    '/reference/public/:token/answer',
    h(async (req, res) => {
      try {
        const row = submitAnswer(str(req.params.token, 80), req.body || {});
        res.json({ reference: publicView(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/reference/public/:token/decline',
    h(async (req, res) => {
      try {
        const row = decline(str(req.params.token, 80), str(req.body?.reason, 300));
        res.json({ reference: publicView(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function referenceRoutes() {
  const r = express.Router();

  /** Every referee and the consent record for one candidate. */
  r.get(
    '/references/:resumeId',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const data = caseOf(originOf(req), org.id, str(req.params.resumeId, 80));
        res.json(data);
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/references/:resumeId/consent',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      // A reference call names the candidate out loud: blind mode waits for a reveal.
      if (blockedByBlind(org, res)) return;
      try {
        recordConsent(org.id, str(req.params.resumeId, 80), { id: user.id, name: user.name }, str(req.body?.note, 300));
        res.json(caseOf(originOf(req), org.id, str(req.params.resumeId, 80)));
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/references/:resumeId/referees',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      // A reference call names the candidate out loud: blind mode waits for a reveal.
      if (blockedByBlind(org, res)) return;
      try {
        addReferee(org.id, str(req.params.resumeId, 80), { id: user.id, name: user.name }, req.body || {});
        res.status(201).json(caseOf(originOf(req), org.id, str(req.params.resumeId, 80)));
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.patch(
    '/references/referees/:id',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = updateReferee(org.id, str(req.params.id, 80), req.body || {}, { id: user.id, name: user.name });
        res.json({ referee: viewOf(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.delete(
    '/references/referees/:id',
    requireRole('member'),
    (req, res) => {
      const { org } = ctxOf(req);
      try {
        removeReferee(org.id, str(req.params.id, 80));
        res.json({ ok: true });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  r.post(
    '/references/referees/:id/send',
    requireRole('member'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const out = await sendInvitation(org.id, str(req.params.id, 80), originOf(req), { id: user.id, name: user.name });
        res.json({ referee: viewOf(originOf(req), out.referee), emailed: out.emailed });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/references/referees/:id/remind',
    requireRole('member'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const out = await sendReminder(org.id, str(req.params.id, 80), originOf(req), { id: user.id, name: user.name });
        res.json({ referee: viewOf(originOf(req), out.referee), emailed: out.emailed });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** HR typing what they heard on the phone — stored as `source: 'phone'`. */
  r.post(
    '/references/referees/:id/record',
    requireRole('member'),
    (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = recordByPhone(org.id, str(req.params.id, 80), req.body || {}, { id: user.id, name: user.name });
        res.json({ referee: viewOf(originOf(req), row) });
      } catch (err) {
        fail(res, err);
      }
    }
  );

  return r;
}

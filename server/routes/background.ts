/**
 * «استعلام سوءپیشینه» — two routers.
 *
 *   • `backgroundPublicRoutes()` — no session. The token is the whole key: read
 *     the notice, agree, or decline. It returns nothing about the verdict, the
 *     documents, who else is involved, or the workspace's other candidates.
 *   • `backgroundRoutes()` — inside the workspace. Reading the process is
 *     member-level (a recruiter must know a check is running); recording
 *     anything and seeing the verdict is admin-only, because a criminal record
 *     is the most sensitive row in the whole product.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  BackgroundError,
  cancelCheck,
  consentByToken,
  createCheck,
  declineByToken,
  deleteDocument,
  markConsentViewed,
  markRequested,
  payloadOf,
  publicViewOfRow,
  readDocument,
  recordConsentByHr,
  recordDecision,
  recordResult,
  sendConsentLink,
  updateCheck,
  uploadDocument,
  viewOf,
} from '../background';

function originOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof BackgroundError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

// --------------------------------------------------------------- public -----

/** A public form must not become a free compute source. */
const attempts = new Map<string, number[]>();
const HOUR = 3600_000;
function tooMany(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < HOUR);
  attempts.set(ip, list);
  return list.length >= 60;
}
function noteAttempt(ip: string) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}
function ipOf(req: express.Request): string {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || 'unknown';
}

export function backgroundPublicRoutes() {
  const r = express.Router();

  r.get(
    '/background/public/:token',
    h(async (req, res) => {
      const row = db.findBackgroundCheckByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک معتبر نیست.' });
      res.json({ background: publicViewOfRow(row) });
    })
  );

  /** «دیده شد» is a different fact from «رضایت داد» and is recorded as such. */
  r.post(
    '/background/public/:token/open',
    h(async (req, res) => {
      const row = db.findBackgroundCheckByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک معتبر نیست.' });
      markConsentViewed(str(req.params.token, 120));
      const fresh = db.findBackgroundCheckByToken(str(req.params.token, 120)) || row;
      res.json({ background: publicViewOfRow(fresh) });
    })
  );

  r.post(
    '/background/public/:token/consent',
    h(async (req, res) => {
      const ip = ipOf(req);
      if (tooMany(ip)) return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد بود؛ یک ساعت دیگر دوباره امتحان کنید.' });
      noteAttempt(ip);
      try {
        const row = consentByToken(str(req.params.token, 120), req.body?.name, req.body?.agreed);
        res.json({ background: publicViewOfRow(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/public/:token/decline',
    h(async (req, res) => {
      const ip = ipOf(req);
      if (tooMany(ip)) return res.status(429).json({ error: 'تعداد تلاش‌ها زیاد بود؛ یک ساعت دیگر دوباره امتحان کنید.' });
      noteAttempt(ip);
      try {
        const row = declineByToken(str(req.params.token, 120), req.body?.reason);
        res.json({ background: publicViewOfRow(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function backgroundRoutes() {
  const r = express.Router();

  /** The process plus the notice text. Members see status; admins see the paper. */
  r.get(
    '/background/:resumeId',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        res.json(payloadOf(org.id, str(req.params.resumeId, 80), { role: user.role }, originOf(req)));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/:resumeId',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        createCheck(org.id, str(req.params.resumeId, 80), { id: user.id, name: user.name }, {
          authority: req.body?.authority,
          purpose: req.body?.purpose,
          reference: req.body?.reference,
          dueAtISO: req.body?.dueAtISO,
          note: req.body?.note,
        });
        res.status(201).json(payloadOf(org.id, str(req.params.resumeId, 80), { role: user.role }, originOf(req)));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.patch(
    '/background/checks/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        updateCheck(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, req.body || {});
        const row = db.getBackgroundCheck(org.id, str(req.params.id, 80))!;
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** Mails the consent link (or hands it back to copy when no mailbox is set). */
  r.post(
    '/background/checks/:id/consent-link',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const row = db.getBackgroundCheck(org.id, str(req.params.id, 80));
        if (!row) throw new BackgroundError('این استعلام پیدا نشد.', 404, 'CHECK_NOT_FOUND');
        const url = `${originOf(req)}/background/${row.token}`;
        const result = await sendConsentLink(org.id, row.id, { id: user.id, name: user.name }, url);
        res.json({ check: viewOf(org.id, result.check, { role: user.role }, originOf(req)), emailed: result.emailed, error: result.error, url });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** Consent given on paper or in person — filed with a name and a date. */
  r.post(
    '/background/checks/:id/consent',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = recordConsentByHr(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, {
          method: req.body?.method,
          note: req.body?.note,
        });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/checks/:id/request',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = markRequested(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, {
          reference: req.body?.reference,
          requestedAtISO: req.body?.requestedAtISO,
          dueAtISO: req.body?.dueAtISO,
        });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/checks/:id/result',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = recordResult(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, {
          verdict: req.body?.verdict,
          issuedAtISO: req.body?.issuedAtISO,
          issuedBy: req.body?.issuedBy,
          note: req.body?.note,
        });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/checks/:id/decision',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = recordDecision(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, {
          outcome: req.body?.outcome,
          note: req.body?.note,
        });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/checks/:id/cancel',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancelCheck(org.id, str(req.params.id, 80), { id: user.id, name: user.name });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/background/checks/:id/documents',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = await uploadDocument(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, {
          fileName: req.body?.fileName,
          fileBase64: req.body?.fileBase64,
        });
        res.status(201).json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** Admin-only, and a real stream — no signed URL that could outlive the session. */
  r.get(
    '/background/checks/:id/documents/:docId',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const { doc, body } = await readDocument(org.id, str(req.params.id, 80), str(req.params.docId, 80));
        res.setHeader('Content-Type', doc.mimeType);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.fileName)}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(body);
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/background/checks/:id/documents/:docId',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = await deleteDocument(org.id, str(req.params.id, 80), str(req.params.docId, 80), { id: user.id, name: user.name });
        res.json({ check: viewOf(org.id, row, { role: user.role }, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

/**
 * «بستهٔ شواهد انطباق» — workspace routes.
 *
 * Everything here is admin-only, including reading: the payload contains the
 * member roster with e-mails and 2FA status, which is access-control evidence,
 * not something a plain member should browse. Uploading evidence and issuing a
 * pack are always recorded in the activity feed, because the point of the
 * artefact is that a human did it on a date.
 */
import express from 'express';
import { actorOf, ctxOf, requireRole } from '../auth';
import * as db from '../db';
import { storage } from '../storage';
import {
  ComplianceError,
  buildControls,
  buildPackZip,
  clearDeclaration,
  completeAccessReview,
  confirmAccessMember,
  deleteEvidence,
  deletePack,
  issuePack,
  loadPayload,
  publicPack,
  publicReview,
  readPackArtifact,
  saveDeclaration,
  saveEvidence,
  startAccessReview,
} from '../compliance';
import type { Framework } from '../../src/types/compliance';
import { FRAMEWORK_LABEL } from '../../src/types/compliance';
import { h, str } from './util';

function frameworkOf(raw: unknown): Framework {
  return raw === 'soc2' ? 'soc2' : 'iso27001';
}

export function complianceRoutes() {
  const r = express.Router();

  const fail = (res: express.Response, err: unknown) => {
    if (err instanceof ComplianceError) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  };

  /** One payload for the whole tab: controls, summary, reviews, issued packs. */
  r.get(
    '/compliance',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const framework = frameworkOf(req.query.framework);
      const admin = user.role === 'admin' || user.role === 'owner';
      if (!admin) {
        return res.status(403).json({ error: 'بستهٔ شواهد انطباق فقط برای مالک یا مدیر فضای کاری است.', code: 'FORBIDDEN' });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.json(loadPayload(org.id, framework, true));
    })
  );

  /** Evidence upload — same shape as the resume/background-check uploads. */
  r.post(
    '/compliance/controls/:id/evidence',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const attachment = await saveEvidence(org.id, str(req.params.id, 40), req.body || {}, actorOf(req));
        db.logActivity(org.id, actorOf(req), 'compliance.evidence', `شاهد انطباق برای کنترل «${str(req.params.id, 40)}» بارگذاری شد: ${attachment.fileName}`);
        res.status(201).json({ attachment });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/compliance/evidence/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getComplianceAttachment(org.id, str(req.params.id, 60));
      if (!row) return res.status(404).json({ error: 'سند یافت نشد.' });
      const obj = await storage().get(row.key);
      if (!obj) return res.status(404).json({ error: 'فایل این سند در ذخیره‌سازی پیدا نشد.' });
      res.setHeader('Content-Type', row.contentType);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.fileName)}`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(obj.body);
    })
  );

  r.delete(
    '/compliance/controls/:id/evidence/:evidenceId',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const ok = await deleteEvidence(org.id, str(req.params.id, 40), str(req.params.evidenceId, 60));
      if (!ok) return res.status(404).json({ error: 'سند یافت نشد.' });
      res.json({ ok: true });
    })
  );

  /** A written attestation for a customer-supplied control. */
  r.post(
    '/compliance/controls/:id/declaration',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const declaration = saveDeclaration(org.id, str(req.params.id, 40), str(req.body?.text, 2000), actorOf(req));
        db.logActivity(org.id, actorOf(req), 'compliance.evidence', `اعلام کتبی برای کنترل «${str(req.params.id, 40)}» ثبت شد`);
        res.json({ declaration });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/compliance/controls/:id/declaration',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const ok = clearDeclaration(org.id, str(req.params.id, 40));
      res.json({ ok });
    })
  );

  // ------------------------------------------------------------ access review
  r.post(
    '/compliance/access-reviews',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const review = startAccessReview(org.id, frameworkOf(req.body?.framework), str(req.body?.note, 400), actorOf(req));
        db.logActivity(org.id, actorOf(req), 'compliance.review', `بازنگری دسترسی با ${review.members.length} عضو آغاز شد`);
        res.status(201).json({ review });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/compliance/access-reviews/:id/confirm',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const review = confirmAccessMember(org.id, str(req.params.id, 60), str(req.body?.userId, 80), req.body?.confirmed !== false, actorOf(req));
        res.json({ review });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/compliance/access-reviews/:id/complete',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const review = completeAccessReview(org.id, str(req.params.id, 60), str(req.body?.note, 400), actorOf(req));
        db.logActivity(org.id, actorOf(req), 'compliance.review', `بازنگری دسترسی بسته شد — ${review.summary || ''}`);
        res.json({ review });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/compliance/access-reviews/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getAccessReview(org.id, str(req.params.id, 60));
      if (!row) return res.status(404).json({ error: 'بازنگری یافت نشد.' });
      res.json({ review: publicReview(row) });
    })
  );

  // -------------------------------------------------------------- the packs
  /** Issue a frozen pack: builds it, hashes it, writes the artefacts to storage. */
  r.post(
    '/compliance/packs',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const framework = frameworkOf(req.body?.framework);
      const scopeNote = str(req.body?.scopeNote, 400);
      // A pack is evidence of a moment; say what moment in words the auditor can read.
      const pack = await issuePack(org.id, framework, scopeNote, actorOf(req));
      db.logActivity(
        org.id,
        actorOf(req),
        'compliance.pack',
        `بستهٔ شواهد ${FRAMEWORK_LABEL[framework]} صادر شد — ${pack.counts.met} پوشش‌داده‌شده، ${pack.counts.gap} جای خالی (SHA-256: ${pack.sha256.slice(0, 16)}…)`
      );
      res.status(201).json({ pack: publicPack(pack) });
    })
  );

  r.get(
    '/compliance/packs',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const framework = req.query.framework ? frameworkOf(req.query.framework) : undefined;
      res.json({ items: db.listIssuedPacks(org.id, framework).map(publicPack) });
    })
  );

  /** The artefact as it was issued — never rebuilt from today's state. */
  r.get(
    '/compliance/packs/:id/download',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getIssuedPack(org.id, str(req.params.id, 60));
      if (!row) return res.status(404).json({ error: 'بسته یافت نشد.' });
      const format = str(req.query.format, 10) || 'md';
      try {
        if (format === 'zip') {
          const zip = await buildPackZip(org.id, row);
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', `attachment; filename="hovida-evidence-${row.id}.zip"`);
          res.setHeader('Cache-Control', 'no-store');
          return res.send(zip);
        }
        const buf = await readPackArtifact(row, format === 'json' ? 'json' : 'md');
        res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="hovida-evidence-${row.id}.${format === 'json' ? 'json' : 'md'}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.send(buf);
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/compliance/packs/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const ok = await deletePack(org.id, str(req.params.id, 60));
      if (!ok) return res.status(404).json({ error: 'بسته یافت نشد.' });
      res.json({ ok: true });
    })
  );

  /** Live preview of the numbers before issuing — no storage, no record. */
  r.get(
    '/compliance/preview',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const { summary } = buildControls(org.id, frameworkOf(req.query.framework));
      res.json({ summary });
    })
  );

  return r;
}

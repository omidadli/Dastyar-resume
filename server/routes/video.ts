/**
 * «مصاحبهٔ ویدئویی» — two routers:
 *   • `videoPublicRoutes()` — no session. The token is the key: read the
 *     questions, upload one take, submit once. Nothing about the workspace,
 *     the other candidates or the reviewer's notes is reachable from here.
 *   • `videoRoutes()` — inside the workspace: the questions per job, creating a
 *     link, sending it from the workspace's own mailbox, watching the answers
 *     and rating them.
 */
import express from 'express';
import type { Request } from 'express';
import * as db from '../db';
import { ctxOf, requireRole, signedVideoUrl, verifyVideoSignature } from '../auth';
import { blockedByBlind } from '../blind';
import { h, str } from './util';
import {
  MAX_ANSWER_BYTES,
  VideoError,
  cancel,
  createInvite,
  markOpened,
  markViewed,
  publicView,
  readAnswerFile,
  remove,
  review,
  saveAnswer,
  saveSettings,
  sendInvite,
  settingsOf,
  submit,
  viewOf,
} from '../video';
import type { VideoOverview } from '../../src/types/video';

function originOf(req: Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function fail(res: express.Response, err: unknown) {
  if (err instanceof VideoError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

/** A public upload endpoint must not become free storage. */
const attempts = new Map<string, number[]>();
const HOUR = 3600_000;
function tooMany(ip: string, limit: number): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < HOUR);
  attempts.set(ip, list);
  return list.length >= limit;
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

function retakesOf(row: db.VideoInviteRow): number {
  return row.jobId ? settingsOf(row.orgId, row.jobId).retakes : 1;
}

// --------------------------------------------------------------- public -----

export function videoPublicRoutes() {
  const r = express.Router();

  r.get(
    '/video/public/:token',
    h(async (req, res) => {
      const row = db.findVideoInviteByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک مصاحبه معتبر نیست.' });
      res.json({ invite: publicView(row) });
    })
  );

  /** The first open turns «دعوت‌شده» into «در حال ضبط» — HR sees the difference. */
  r.post(
    '/video/public/:token/open',
    h(async (req, res) => {
      const row = db.findVideoInviteByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک مصاحبه معتبر نیست.' });
      res.json({ invite: publicView(markOpened(row)) });
    })
  );

  /** One take per request. The size ceiling is per answer, not per person. */
  r.post(
    '/video/public/:token/answer',
    h(async (req, res) => {
      const ip = ipOf(req);
      if (tooMany(ip, 60)) return res.status(429).json({ error: 'تعداد درخواست‌ها زیاد بود؛ یک ساعت دیگر دوباره امتحان کنید.' });
      const row = db.findVideoInviteByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک مصاحبه معتبر نیست.' });
      const size = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64.length : 0;
      if (size > MAX_ANSWER_BYTES * 1.4) return res.status(413).json({ error: 'حجم ویدئو بیش از حد مجاز است؛ کوتاه‌تر ضبط کنید.' });
      noteAttempt(ip);
      try {
        const saved = await saveAnswer(row, req.body || {}, { retakes: retakesOf(row) });
        res.json({ invite: publicView(saved) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /**
   * The signed playback link a `<video>` tag can use. The signature names one
   * answer; it expires in half an hour and cannot reach another workspace.
   */
  r.get(
    '/video/watch/:id/:questionId',
    h(async (req, res) => {
      const id = str(req.params.id, 80);
      const questionId = str(req.params.questionId, 40);
      const exp = Number(req.query.exp);
      const sig = str(req.query.sig, 200);
      if (!verifyVideoSignature(id, questionId, exp, sig)) return res.status(403).json({ error: 'این لینک پخش منقضی شده است؛ صفحه را تازه کنید.' });
      const row = db.findVideoInviteById(id);
      if (!row) return res.status(404).json({ error: 'این مصاحبه پیدا نشد.' });
      const file = await readAnswerFile(row, questionId);
      if (!file) return res.status(404).json({ error: 'این پاسخ ویدئویی پیدا نشد.' });
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      const range = String(req.headers.range || '');
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const total = file.buffer.length;
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return res.end(file.buffer.subarray(start, end + 1));
      }
      res.setHeader('Content-Length', String(file.buffer.length));
      res.end(file.buffer);
    })
  );

  r.post(
    '/video/public/:token/submit',
    h(async (req, res) => {
      const row = db.findVideoInviteByToken(str(req.params.token, 120));
      if (!row) return res.status(404).json({ error: 'این لینک مصاحبه معتبر نیست.' });
      try {
        const saved = submit(row);
        res.json({ invite: publicView(saved), thanks: 'پاسخ‌های شما ثبت شد؛ سپاسگزاریم.' });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function videoRoutes() {
  const r = express.Router();

  /** One read for the page: invitations, the openings, and the totals. */
  r.get(
    '/video',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobFilter = str(req.query.jobId, 80);
      const resumeFilter = str(req.query.resumeId, 80);
      const invites = db.listVideoInvites(org.id, {
        ...(jobFilter ? { jobId: jobFilter } : {}),
        ...(resumeFilter ? { resumeId: resumeFilter } : {}),
      });
      const jobs = db
        .listJobs(org.id)
        .map((j) => {
          const saved = db.getVideoSettings(org.id, j.id);
          const settings = saved || settingsOf(org.id, j.id);
          return { id: j.id, roleTitle: j.roleTitle, enabled: Boolean(saved?.enabled), questionCount: settings.questions.length };
        });
      const payload: VideoOverview = {
        invites: invites.map((row) => viewOf(row, originOf(req))),
        jobs,
        stats: {
          waiting: invites.filter((i) => i.status === 'invited' || i.status === 'recording').length,
          submitted: invites.filter((i) => i.status === 'submitted').length,
          reviewed: invites.filter((i) => i.status === 'reviewed').length,
        },
        mailbox: Boolean(db.resolveOrgSecrets(org.id).email),
      };
      res.json(payload);
    })
  );

  r.get(
    '/video/settings',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobId = str(req.query.jobId, 80);
      if (!jobId) return res.status(400).json({ error: 'فرصت شغلی را مشخص کنید.' });
      if (!db.getJob(org.id, jobId)) return res.status(404).json({ error: 'فرصت شغلی پیدا نشد.' });
      res.json({ settings: settingsOf(org.id, jobId) });
    })
  );

  /** Questions are a decision about the role — HR owns them. */
  r.put(
    '/video/settings',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const jobId = str(req.body?.jobId, 80);
      try {
        const settings = saveSettings(org.id, jobId, {
          enabled: req.body?.enabled,
          retakes: req.body?.retakes,
          ttlDays: req.body?.ttlDays,
          intro: req.body?.intro,
          questions: req.body?.questions,
        });
        const job = db.getJob(org.id, jobId);
        db.logActivity(
          org.id,
          { id: user.id, name: user.name },
          'settings.changed',
          `پرسش‌های مصاحبهٔ ویدئویی «${job?.roleTitle || ''}» را ${settings.enabled ? 'روشن و ذخیره' : 'ذخیره'} کرد (${settings.questions.length} پرسش)`,
          { jobId }
        );
        res.json({ settings });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/video/invites',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      try {
        const row = createInvite(org.id, user, { resumeId: req.body?.resumeId, jobId: req.body?.jobId });
        res.status(201).json({ invite: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/video/invites/:id/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const row = db.getVideoInvite(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این دعوت پیدا نشد.' });
      try {
        const result = await sendInvite(org.id, row.id, viewOf(row, originOf(req)).url, user);
        res.json({ invite: viewOf(result.invite, originOf(req)), emailed: result.emailed });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/video/invites/:id/cancel',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = cancel(org.id, str(req.params.id, 80), user);
        res.json({ invite: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/video/invites/:id/review',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = review(org.id, str(req.params.id, 80), { rating: req.body?.rating, note: req.body?.note }, user);
        res.json({ invite: viewOf(row, originOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/video/invites/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const ok = await remove(org.id, str(req.params.id, 80), user);
      if (!ok) return res.status(404).json({ error: 'این دعوت پیدا نشد.' });
      res.status(204).end();
    })
  );

  /** «دیده شد» — the reviewer opened the recording, so HR can tell it apart. */
  r.post(
    '/video/invites/:id/viewed',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getVideoInvite(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این مصاحبه پیدا نشد.' });
      const next = markViewed(row);
      res.json({ invite: viewOf(next, originOf(req)) });
    })
  );

  /**
   * A short-lived link to one answer. The bytes are served by the public watch
   * route above, which checks the signature — never a bare video URL.
   */
  r.get(
    '/video/invites/:id/answer/:questionId',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getVideoInvite(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این مصاحبه پیدا نشد.' });
      const questionId = str(req.params.questionId, 40);
      if (!row.answers.some((a) => a.questionId === questionId)) return res.status(404).json({ error: 'این پاسخ ویدئویی پیدا نشد.' });
      const signed = signedVideoUrl(row.id, questionId);
      res.json({ url: signed.url, expiresAt: signed.expiresAt });
    })
  );

  return r;
}

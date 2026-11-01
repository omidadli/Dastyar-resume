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
import { isEmailConfigured, sendMail, friendlySmtpError } from '../mailer';
import { noteEmailSend, withinEmailLimit } from '../email-rate';
import { StatusError, createLink, listLinks, markLinkSent, publicStatus, revokeLink, statusEmailText } from '../status';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import { h, str } from './util';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function originOf(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

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

  /**
   * «فرستادن با ایمیل سازمان» — the one place a status link leaves the
   * workspace, and only because a human pressed this button. Nothing is ever
   * e-mailed on creation, on a stage change, or on a timer.
   */
  r.post(
    '/status-links/:id/send',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getStatusLink(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این لینک پیدا نشد.' });
      const rec = db.getResume(org.id, row.resumeId);
      if (rec && blockedByResume(req, res, rec)) return;
      if (row.revokedAtISO) {
        return res.status(409).json({ error: 'این لینک لغو شده است؛ اول «لینک تازه» بسازید.', code: 'LINK_REVOKED' });
      }
      if (new Date(row.expiresAtISO).getTime() < Date.now()) {
        return res.status(409).json({ error: 'این لینک منقضی شده است؛ اول «لینک تازه» بسازید.', code: 'LINK_EXPIRED' });
      }
      const to = (rec?.contact?.email || '').toLowerCase().trim();
      if (!EMAIL_RE.test(to)) {
        return res.status(400).json({
          error: 'برای این کارجو ایمیل معتبری ثبت نشده است؛ نشانی را در پروفایل کامل کنید یا لینک را دستی بفرستید.',
          code: 'NO_CANDIDATE_EMAIL',
        });
      }
      if (!isEmailConfigured(db.resolveOrgSecrets(org.id))) {
        return res.status(409).json({
          error: 'صندوق ایمیل سازمان هنوز وصل نشده است؛ از «تنظیمات ← اتصال‌ها» آن را وصل کنید تا نامه از ایمیل خودتان برود. تا آن موقع می‌توانید لینک را کپی و دستی بفرستید.',
          code: 'EMAIL_NOT_CONFIGURED',
        });
      }
      if (!withinEmailLimit(org.id)) {
        return res.status(429).json({ error: 'سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد دوباره تلاش کنید.' });
      }

      const link = `${originOf(req)}/status/${row.token}`;
      const subject = `پیگیری درخواست — ${row.jobTitle || 'موقعیت شغلی'}`;
      const text = statusEmailText({
        candidateName: row.candidateName,
        orgName: org.name,
        jobTitle: row.jobTitle || 'موقعیت شغلی',
        link,
        expiresJalali: row.expiresAtJalali,
      });
      const stamp = new Date();
      try {
        await sendMail(db.resolveOrgSecrets(org.id).email!, { to, subject, text });
        noteEmailSend(org.id);
      } catch (err: any) {
        db.saveEmail({
          id: db.uid('eml'),
          orgId: org.id,
          resumeId: row.resumeId,
          candidateName: row.candidateName,
          jobId: row.jobId,
          to,
          subject,
          body: text,
          status: 'failed',
          error: friendlySmtpError(err),
          sentAtISO: stamp.toISOString(),
          sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
          sentByName: actorOf(req).name,
          attachments: [],
        });
        return res.status(502).json({ error: `ارسال نشد: ${friendlySmtpError(err)}`, code: 'SMTP_FAILED' });
      }

      db.saveEmail({
        id: db.uid('eml'),
        orgId: org.id,
        resumeId: row.resumeId,
        candidateName: row.candidateName,
        jobId: row.jobId,
        to,
        subject,
        body: text,
        status: 'sent',
        error: null,
        sentAtISO: stamp.toISOString(),
        sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        sentByName: actorOf(req).name,
        attachments: [],
      });
      db.logActivity(org.id, actorOf(req), 'status.sent', `لینک پیگیری درخواست «${row.candidateName}» با ایمیل سازمان فرستاده شد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ link: markLinkSent(org.id, row.id, to) });
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

/**
 * «حق دسترسی به دادهٔ شخصی» (DSAR) for one candidate.
 *
 *   GET  /resumes/:id/export  — everything we hold, as one JSON file
 *   POST /resumes/:id/erase   — removes every row and the stored file
 *
 * Both are admin-only and both are written to the activity feed: a deletion
 * nobody can trace is exactly what an audit fails on.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import type { CandidateDataExport } from '../../src/types/retention';

/** The string the UI must send back; makes an accidental POST impossible. */
export const ERASE_CONFIRM = 'ERASE';

export function privacyRoutes(): express.Router {
  const r = express.Router();

  r.get(
    '/resumes/:id/export',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const job = db.getJob(org.id, rec.jobId);
      const stamp = new Date();

      // The candidate's name/email may appear in the activity feed and in the
      // messages we sent, so both are included — that is the point of a DSAR.
      const activity = db
        .listActivity(org.id, 600)
        .filter((a) => a.resumeId === rec.id)
        .map((a) => ({ type: a.type, text: a.text, atISO: a.atISO, atJalali: a.atJalali }));

      const payload: CandidateDataExport = {
        exportedAtISO: stamp.toISOString(),
        exportedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        workspace: { id: org.id, name: org.name },
        candidate: { ...db.toListItem(rec), orgId: org.id },
        job: job ? { id: job.id, roleTitle: job.roleTitle, departmentName: job.departmentName, status: job.status } : null,
        resumeText: rec.extractedText || null,
        notes: db.listComments(org.id, rec.id).map(db.withoutOrg),
        interviews: db.listInterviews(org.id, { resumeId: rec.id }).map(db.withoutOrg),
        offers: db.listOffers(org.id, { resumeId: rec.id }).map(db.withoutOrg),
        messages: {
          emails: db.listEmails(org.id, rec.id).map(db.withoutOrg),
          sms: db.listSms(org.id, rec.id).map(db.withoutOrg),
        },
        scorecards: db.listFeedback(org.id, { resumeId: rec.id }).map(db.withoutOrg),
        schedulingLinks: db.listSchedulingLinks(org.id, { resumeId: rec.id }).map((l) => ({ id: l.id, createdAtISO: l.createdAtISO, status: l.status })),
        activity,
      };
      res.setHeader('Content-Disposition', `attachment; filename="candidate-${rec.id}.json"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.json(payload);
    })
  );

  r.post(
    '/resumes/:id/erase',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.params.id, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (str(req.body?.confirm, 20) !== ERASE_CONFIRM) {
        return res.status(400).json({
          error: 'برای پاک‌سازی کامل، تأیید صریح لازم است؛ این کار برگشت‌پذیر نیست.',
          code: 'CONFIRM_REQUIRED',
        });
      }
      const name = rec.candidateName || rec.fileName;
      const counts = db.eraseCandidate(org.id, rec.id);
      if (!counts) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      db.logActivity(org.id, actorOf(req), 'resume.deleted', `به درخواست حذف دادهٔ شخصی، همهٔ اطلاعات «${name}» را پاک کرد`, {
        jobId: rec.jobId,
      });
      res.json({ erased: counts });
    })
  );

  return r;
}

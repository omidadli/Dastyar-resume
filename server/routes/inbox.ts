/**
 * «کارتابل تأیید» — one read route, and the two decisions that send nothing.
 *
 * Approving an offer stage is a document decision (the candidate is not mailed
 * from here), and confirming a referral reward moves money that is already owed.
 * Approving an automation proposal *sends a letter*, so that one stays on the
 * automation page where the wording is on screen — the kar­tableh only links to it.
 */
import express from 'express';
import { actorOf, ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { blockedByJobId, blockedByResume } from '../job-access';
import * as db from '../db';
import { inboxFor } from '../inbox';
import { approveReward } from '../referrals';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import { h, str } from './util';

export function inboxRoutes() {
  const r = express.Router();

  r.get(
    '/inbox',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      res.json(inboxFor(org, user));
    })
  );

  /**
   * «تأیید این مرحله» from the inbox. The same rules as the offer page: only the
   * step's approver (or an admin acting in their place) may decide, and a note
   * is kept with the decision.
   */
  r.post(
    '/inbox/offers/:id/decision',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      if (blockedByJobId(req, res, row.jobId)) return;
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, row.resumeId);
      if (rec && blockedByResume(req, res, rec)) return;
      if (row.status !== 'draft') {
        return res.status(409).json({ error: 'این پیشنهاد دیگر پیش‌نویس نیست؛ تأیید مرحله معنا ندارد.' });
      }
      const step = (row.approvals || []).find((a) => a.status === 'pending');
      if (!step) return res.status(409).json({ error: 'همهٔ مراحل تأیید تمام شده‌اند.', code: 'APPROVAL_DONE' });
      const isApprover = user.id === step.approverId;
      const isAdmin = user.role === 'admin' || user.role === 'owner';
      if (!isApprover && !isAdmin) {
        return res.status(403).json({ error: `این مرحله در اختیار «${step.approverName}» است.`, code: 'NOT_YOUR_TURN' });
      }
      const decision = req.body?.decision === 'rejected' ? 'rejected' : 'approved';
      const note = str(req.body?.note, 400) || null;
      const stamp = new Date();
      const next = db.saveOffer({
        ...row,
        approvals: (row.approvals || []).map((a) =>
          a.id === step.id
            ? {
                ...a,
                status: decision,
                decidedAtISO: stamp.toISOString(),
                decidedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
                note,
              }
            : a
        ),
        status: decision === 'rejected' ? 'cancelled' : row.status,
        updatedAtISO: stamp.toISOString(),
      });
      db.logActivity(
        org.id,
        actorOf(req),
        decision === 'rejected' ? 'offer.cancelled' : 'settings.changed',
        decision === 'rejected'
          ? `تأیید «${step.label}» پیشنهاد «${row.terms.title || row.jobTitle}» برای «${row.candidateName}» را رد کرد${note ? ` — ${note}` : ''}`
          : `از کارتابل، تأیید «${step.label}» پیشنهاد «${row.terms.title || row.jobTitle}» را داد${isApprover ? '' : ` (به‌جای «${step.approverName}»)`}`,
        { jobId: row.jobId, resumeId: row.resumeId }
      );
      res.json({ inbox: inboxFor(org, user), offerId: next.id });
    })
  );

  /** «تأیید پاداش» — the money is owed; this is the human saying yes. */
  r.post(
    '/inbox/referrals/:id/approve',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (user.role !== 'admin' && user.role !== 'owner') {
        return res.status(403).json({ error: 'تأیید پاداش فقط با مدیر یا مالک فضای کاری است.' });
      }
      const note = str(req.body?.note, 500) || '';
      const id = str(req.params.id, 80);
      // A reward from another workspace does not exist here — say so, instead of
      // a 409 that would imply it exists but is in the wrong state.
      if (!db.getReferral(org.id, id)) return res.status(404).json({ error: 'این معرفی در این فضای کاری نیست.' });
      const row = approveReward(org.id, id, { name: user.name }, note);
      if (!row) return res.status(409).json({ error: 'این پاداش در وضعیت «در انتظار تأیید» نیست.' });
      db.logActivity(org.id, actorOf(req), 'settings.changed', `از کارتابل، پاداش معرفی «${row.candidateName}» را تأیید کرد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ inbox: inboxFor(org, user) });
    })
  );

  return r;
}

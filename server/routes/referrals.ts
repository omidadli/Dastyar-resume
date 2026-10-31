/**
 * «معرفی همکار» — the workspace side of the referral program.
 *
 * The public side is the career portal (`?ref=<code>`); this router is where an
 * admin turns the program on, copies each member's link, and — the important
 * part — approves and marks the payout. Money never moves on its own.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import { approveReward, confirmProbation, formatToman, payReward, referralsPayload, voidReward } from '../referrals';

function portalUrlOf(req: express.Request, slug: string): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  const base = fixed ? fixed.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  return `${base}/careers/${slug}`;
}

export function referralRoutes(): express.Router {
  const r = express.Router();

  /** One read for the whole page: program, every referral, every member's link. */
  r.get('/referrals', (req, res) => {
    const { org } = ctxOf(req);
    res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
  });

  r.put(
    '/referrals/program',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const before = db.getReferralProgram(org.id);
      const program = db.saveReferralProgram(org.id, {
        enabled: req.body?.enabled === undefined ? before.enabled : Boolean(req.body.enabled),
        rewardAmount: req.body?.rewardAmount === undefined ? before.rewardAmount : Number(req.body.rewardAmount),
        trigger: req.body?.trigger === undefined ? before.trigger : req.body.trigger,
        terms: typeof req.body?.terms === 'string' ? req.body.terms : before.terms,
        membersOnly: req.body?.membersOnly === undefined ? before.membersOnly : Boolean(req.body.membersOnly),
      });
      const changes: string[] = [];
      if (program.enabled !== before.enabled) changes.push(program.enabled ? 'روشن' : 'خاموش');
      if (program.rewardAmount !== before.rewardAmount) changes.push(`مبلغ ${formatToman(program.rewardAmount)}`);
      if (program.trigger !== before.trigger) changes.push('شرط پرداخت');
      if (program.terms !== before.terms) changes.push('شرایط');
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'settings.changed',
        changes.length ? `برنامهٔ معرفی همکار را تغییر داد (${changes.join('، ')})` : 'تنظیمات معرفی همکار را ذخیره کرد'
      );
      res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
    })
  );

  /** HR confirms a reward — the candidate is hired and the payout is owed. */
  r.post(
    '/referrals/:id/approve',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const note = str(req.body?.note, 500);
      const row = approveReward(org.id, req.params.id, { name: user.name }, note);
      if (!row) return res.status(409).json({ error: 'این پاداش در وضعیت «در انتظار تأیید» نیست.' });
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'settings.changed',
        `پاداش معرفی «${row.candidateName}» را تأیید کرد (${formatToman(row.rewardAmount)})`,
        { resumeId: row.resumeId, jobId: row.jobId }
      );
      res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
    })
  );

  /** «دورهٔ آزمایشی تمام شد» — the probation trigger's manual switch. */
  r.post(
    '/referrals/:id/confirm',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = confirmProbation(org.id, req.params.id, { name: user.name });
      if (!row) return res.status(409).json({ error: 'این معرفی برای تأیید دورهٔ آزمایشی آماده نیست.' });
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'settings.changed',
        `پاداش معرفی «${row.candidateName}» را پس از دورهٔ آزمایشی در انتظار تأیید گذاشت`,
        { resumeId: row.resumeId, jobId: row.jobId }
      );
      res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
    })
  );

  /** «پرداخت شد» — a human confirms the money actually left the account. */
  r.post(
    '/referrals/:id/pay',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = payReward(org.id, req.params.id, { name: user.name });
      if (!row) return res.status(409).json({ error: 'برای ثبت پرداخت، پاداش باید اول تأیید شده باشد.' });
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'settings.changed',
        `پرداخت پاداش معرفی «${row.candidateName}» را ثبت کرد (${formatToman(row.rewardAmount)})`,
        { resumeId: row.resumeId, jobId: row.jobId }
      );
      res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
    })
  );

  /** Cancels a reward that should not be paid. A paid one stays paid (audit). */
  r.post(
    '/referrals/:id/void',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = voidReward(org.id, req.params.id, str(req.body?.note, 500));
      if (!row) return res.status(409).json({ error: 'پاداش پرداخت‌شده قابل لغو نیست؛ برای اصلاح، یادداشت بگذارید.' });
      db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', `پاداش معرفی «${row.candidateName}» را لغو کرد`, {
        resumeId: row.resumeId,
        jobId: row.jobId,
      });
      res.json(referralsPayload(org.id, portalUrlOf(req, org.careerSlug)));
    })
  );

  return r;
}

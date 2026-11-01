/**
 * «انتشار در جاب‌بورد» — the copy kit and the record of where a human posted.
 *
 * There is no «publish» route that talks to a board: no Iranian job board offers
 * a public write API, and inventing one would be a lie a demo cannot survive.
 * What is here is everything around that last step — the ad in the right shape,
 * the canonical link, and a record with a date and a name.
 */
import express from 'express';
import { actorOf, ctxOf } from '../auth';
import { blockedByJob } from '../job-access';
import * as db from '../db';
import { boardIdOf, kitFor, publicationsView, recordPublication, updatePublication } from '../jobboard';
import { careerOriginOf } from './careers';
import { JOB_BOARDS } from '../../src/types/jobboard';
import { h, str } from './util';

function resolveJob(req: express.Request, res: express.Response) {
  const { org } = ctxOf(req);
  const job = db.getJob(org.id, str(req.params.id, 80));
  if (!job) {
    res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
    return null;
  }
  if (blockedByJob(req, res, job)) return null;
  return job;
}

export function jobBoardRoutes() {
  const r = express.Router();

  /** The catalogue — with each board's honest requirement, never a fake API. */
  r.get('/job-boards', (_req, res) => {
    res.json({
      items: JOB_BOARDS,
      note: 'هویدا در جاب‌بوردها منتشر نمی‌کند: هیچ‌کدام رابط نوشتن عمومی ندارند و انتشار، قرارداد و حساب کارفرمای خودتان را می‌خواهد. متن آماده را می‌دهیم و ثبت می‌کنیم کجا منتشر شد.',
    });
  });

  r.get(
    '/jobs/:id/publications',
    h(async (req, res) => {
      const job = resolveJob(req, res);
      if (!job) return;
      res.json(publicationsView(ctxOf(req).org, job, careerOriginOf(req)));
    })
  );

  /** The paste-ready ad for one board. */
  r.get(
    '/jobs/:id/publication-kit',
    h(async (req, res) => {
      const job = resolveJob(req, res);
      if (!job) return;
      const board = boardIdOf(req.query.board);
      if (!board) return res.status(400).json({ error: 'جاب‌بورد را انتخاب کنید.', code: 'BAD_BOARD' });
      res.json({ kit: kitFor(ctxOf(req).org, job, board, careerOriginOf(req)) });
    })
  );

  r.post(
    '/jobs/:id/publications',
    h(async (req, res) => {
      const job = resolveJob(req, res);
      if (!job) return;
      const { org, user } = ctxOf(req);
      try {
        const item = recordPublication(org, job, req.body || {}, { id: user.id, name: user.name });
        db.logActivity(
          org.id,
          actorOf(req),
          'job.status',
          `انتشار «${job.roleTitle}» در ${item.board} را ثبت کرد`,
          { jobId: job.id }
        );
        res.status(201).json({ item, view: publicationsView(org, job, careerOriginOf(req)) });
      } catch (err: any) {
        res.status(err?.status || 400).json({ error: err?.message || 'ثبت انتشار ممکن نشد.', code: err?.code });
      }
    })
  );

  r.patch(
    '/publications/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getPublication(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این انتشار پیدا نشد.' });
      const job = db.getJob(org.id, row.jobId);
      if (job && blockedByJob(req, res, job)) return;
      try {
        const item = updatePublication(org, row.id, req.body || {});
        if (!item) return res.status(404).json({ error: 'این انتشار پیدا نشد.' });
        res.json({ item, view: job ? publicationsView(org, job, careerOriginOf(req)) : null });
      } catch (err: any) {
        res.status(err?.status || 400).json({ error: err?.message || 'تغییر وضعیت ممکن نشد.', code: err?.code });
      }
    })
  );

  /** Deleting is for mistakes; a real removal is a status, so the record stays. */
  r.delete(
    '/publications/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getPublication(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این انتشار پیدا نشد.' });
      const job = db.getJob(org.id, row.jobId);
      if (job && blockedByJob(req, res, job)) return;
      db.deletePublication(org.id, row.id);
      res.json({ view: job ? publicationsView(org, job, careerOriginOf(req)) : null });
    })
  );

  return r;
}

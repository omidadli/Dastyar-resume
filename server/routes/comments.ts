/**
 * «یادداشت تیمی» on a candidate — comments with @mentions.
 *
 * The point is the record: a decision discussed in a chat app disappears, while a
 * comment here stays on the candidate's timeline, with its author and time, and
 * the people mentioned see it in the activity feed.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import { h, str } from './util';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import type { CandidateComment } from '../../src/types/pipeline';

const MAX_BODY = 4000;

/** «@سارا محمدی» → the member with that name, when the name matches exactly. */
function findMentions(body: string, members: Array<{ id: string; name: string }>) {
  const found: Array<{ id: string; name: string }> = [];
  for (const m of members) {
    const needle = `@${m.name}`;
    if (body.includes(needle) && !found.some((x) => x.id === m.id)) found.push({ id: m.id, name: m.name });
  }
  return found.slice(0, 10);
}

export function commentRoutes() {
  const r = express.Router();

  r.get(
    '/resumes/:id/comments',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const items = db.listComments(org.id, rec.id).map(db.withoutOrg);
      res.json({ items, members: db.listMembers(org.id).map((m) => ({ id: m.id, name: m.name })) });
    })
  );

  r.post(
    '/resumes/:id/comments',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const body = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, MAX_BODY) : '';
      if (body.length < 2) return res.status(400).json({ error: 'متن یادداشت را بنویسید.' });

      const members = db.listMembers(org.id).map((m) => ({ id: m.id, name: m.name }));
      const mentions = findMentions(body, members);
      const stamp = new Date();
      const row: db.CommentRow = {
        id: db.uid('cmt'),
        orgId: org.id,
        resumeId: rec.id,
        jobId: rec.jobId,
        authorId: user.id,
        authorName: user.name,
        body,
        mentions,
        atISO: stamp.toISOString(),
        atJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
      };
      db.saveComment(row);
      const name = rec.candidateName || rec.fileName;
      db.logActivity(
        org.id,
        user,
        'comment.added',
        mentions.length
          ? `دربارهٔ «${name}» یادداشت گذاشت و ${mentions.map((m) => `«${m.name}»`).join('، ')} را صدا زد`
          : `دربارهٔ «${name}» یادداشت گذاشت`,
        { jobId: rec.jobId, resumeId: rec.id }
      );
      const items = db.listComments(org.id, rec.id).map(db.withoutOrg);
      res.status(201).json({ comment: db.withoutOrg(row) as CandidateComment, items, members });
    })
  );

  r.delete(
    '/comments/:id',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getComment(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'یادداشت یافت نشد.' });
      // The author may delete their own note; an admin may delete any.
      if (row.authorId !== user.id && user.role === 'member') {
        return res.status(403).json({ error: 'فقط نویسنده یا مدیر می‌تواند یادداشت را پاک کند.' });
      }
      db.deleteComment(org.id, row.id);
      res.json({ items: db.listComments(org.id, row.resumeId).map(db.withoutOrg) });
    })
  );

  return r;
}

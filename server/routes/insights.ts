import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import type { ReportRange } from '../../src/types/app';
import { int, oneOf, str } from './util';
import { blindOn, knownNames, maskActivity, maskText, redactList } from '../blind';

export function insightRoutes(): express.Router {
  const r = express.Router();

  r.get('/dashboard', (req, res) => {
    const { org } = ctxOf(req);
    const data = db.dashboard(org.id);
    if (!blindOn(org)) return res.json(data);
    // Blind mode covers the dashboard too: the «منتظر تصمیم» queue and the feed.
    res.json({
      ...data,
      pending: redactList(data.pending),
      activity: maskActivity(data.activity, knownNames(db.listOrgResumes(org.id))),
    });
  });

  r.get('/reports', (req, res) => {
    const range = oneOf<ReportRange>(req.query.range, ['30', '90', '365', 'all'], '90');
    res.json(db.reports(ctxOf(req).org.id, range));
  });

  r.get('/search', (req, res) => {
    const { org } = ctxOf(req);
    const q = str(req.query.q, 100);
    const found = db.search(org.id, q);
    if (!blindOn(org)) return res.json(found);
    // Searching by a name in blind mode would confirm a guess: the person is
    // not searchable by identity, only by role, skill or score.
    res.json({ jobs: found.jobs, candidates: found.candidates.map((c) => ({ ...c, name: maskText(c.name, [c.name]) })) });
  });

  r.get('/activity', (req, res) => {
    const { org, user } = ctxOf(req);
    const limit = Math.min(100, Math.max(1, int(req.query.limit, 30)));
    const items = db.listActivity(org.id, limit);
    res.json({
      items: blindOn(org) ? maskActivity(items, knownNames(db.listOrgResumes(org.id))) : items,
      unread: db.unreadCount(user),
    });
  });

  r.post('/activity/seen', (req, res) => {
    const { user } = ctxOf(req);
    db.updateUser(user.id, { lastSeenActivityISO: new Date().toISOString() });
    res.json({ unread: 0 });
  });

  r.get('/talent', (req, res) => {
    const { org } = ctxOf(req);
    const departments = db.talentDepartments(org);
    res.json({ departments, tags: db.talentTags(org.id), total: departments.reduce((s, d) => s + d.count, 0) });
  });

  r.get('/talent/list', (req, res) => {
    const { org } = ctxOf(req);
    const q = req.query;
    const page = db.queryTalent(org.id, {
        departmentId: str(q.departmentId, 80) || undefined,
        q: str(q.q, 120) || undefined,
        tags: str(q.tags, 600) ? str(q.tags, 600).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        minScore: q.minScore ? int(q.minScore) : undefined,
        minYears: q.minYears ? int(q.minYears) : undefined,
        sort: oneOf(q.sort, ['newest', 'score', 'experience'] as const, 'newest'),
        page: q.page ? int(q.page, 1) : 1,
        pageSize: q.pageSize ? int(q.pageSize, 12) : 12,
    });
    res.json(blindOn(org) ? { ...page, items: redactList(page.items) } : page);
  });

  return r;
}

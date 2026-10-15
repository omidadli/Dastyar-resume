import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import type { ReportRange } from '../../src/types/app';
import { int, oneOf, str } from './util';

export function insightRoutes(): express.Router {
  const r = express.Router();

  r.get('/dashboard', (req, res) => {
    res.json(db.dashboard(ctxOf(req).org.id));
  });

  r.get('/reports', (req, res) => {
    const range = oneOf<ReportRange>(req.query.range, ['30', '90', '365', 'all'], '90');
    res.json(db.reports(ctxOf(req).org.id, range));
  });

  r.get('/search', (req, res) => {
    res.json(db.search(ctxOf(req).org.id, str(req.query.q, 100)));
  });

  r.get('/activity', (req, res) => {
    const { org, user } = ctxOf(req);
    const limit = Math.min(100, Math.max(1, int(req.query.limit, 30)));
    res.json({ items: db.listActivity(org.id, limit), unread: db.unreadCount(user) });
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
    res.json(
      db.queryTalent(org.id, {
        departmentId: q.departmentId ? String(q.departmentId) : undefined,
        q: str(q.q, 120) || undefined,
        tags: q.tags ? String(q.tags).split(',').map((t) => t.trim()).filter(Boolean) : undefined,
        minScore: q.minScore ? int(q.minScore) : undefined,
        minYears: q.minYears ? int(q.minYears) : undefined,
        sort: oneOf(q.sort, ['newest', 'score', 'experience'] as const, 'newest'),
        page: q.page ? int(q.page, 1) : 1,
        pageSize: q.pageSize ? int(q.pageSize, 12) : 12,
      })
    );
  });

  return r;
}

import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import type { ReportRange } from '../../src/types/app';
import { int, oneOf, str } from './util';
import { blindOn, knownNames, maskActivity, maskText, redactList } from '../blind';
import { readAssumptionInput, readCostInput } from '../costs';

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

  // ------------------------------------------- performance & cost of hire ----

  /**
   * «عملکرد تیم» is readable by every member: the point is that the team sees
   * its own workload, not that a manager keeps a secret scoreboard.
   */
  r.get('/reports/team', (req, res) => {
    const range = oneOf<ReportRange>(req.query.range, ['30', '90', '365', 'all'], '90');
    res.json(db.teamReport(ctxOf(req).org.id, range));
  });

  /**
   * «هزینهٔ هر استخدام» is money: only an admin or the owner reads and writes it.
   * A member gets a clear 403 rather than an empty page.
   */
  r.get('/reports/cost', requireRole('admin'), (req, res) => {
    const range = oneOf<ReportRange>(req.query.range, ['30', '90', '365', 'all'], '90');
    res.json(db.costReport(ctxOf(req).org.id, range));
  });

  r.post('/costs', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const input = readCostInput(req.body);
    if ('error' in input) return res.status(400).json({ error: input.error });
    let jobTitle: string | null = null;
    if (input.jobId) {
      const job = db.getJob(org.id, input.jobId);
      if (!job) return res.status(400).json({ error: 'فرصت شغلی انتخاب‌شده پیدا نشد.' });
      jobTitle = job.roleTitle || job.departmentName;
    }
    const entry = db.addCost(org.id, { ...input, jobTitle }, actorOf(req)?.name || 'عضو تیم');
    // No amount in the feed: the activity list is readable by every member.
    db.logActivity(org.id, actorOf(req), 'settings.changed', 'یک ردیف «هزینهٔ استخدام» ثبت کرد');
    res.status(201).json({ entry });
  });

  r.patch('/costs/:id', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const existing = db.listCosts(org.id, 'all').find((c) => c.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'این ردیف هزینه پیدا نشد.' });
    const body = { ...req.body } as Record<string, unknown>;
    // Any field left out keeps its old value, so the form can send one change.
    const merged = {
      kind: body.kind ?? existing.kind,
      amount: body.amount ?? existing.amount,
      atISO: body.atISO === undefined ? existing.atISO : body.atISO,
      jobId: body.jobId === undefined ? existing.jobId : body.jobId,
      note: body.note === undefined ? existing.note : body.note,
    };
    const input = readCostInput(merged);
    if ('error' in input) return res.status(400).json({ error: input.error });
    let jobTitle: string | null = null;
    if (input.jobId) {
      const job = db.getJob(org.id, input.jobId);
      if (!job) return res.status(400).json({ error: 'فرصت شغلی انتخاب‌شده پیدا نشد.' });
      jobTitle = job.roleTitle || job.departmentName;
    }
    const entry = db.updateCost(org.id, req.params.id, { ...input, jobTitle });
    if (!entry) return res.status(404).json({ error: 'این ردیف هزینه پیدا نشد.' });
    res.json({ entry });
  });

  r.delete('/costs/:id', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    if (!db.deleteCost(org.id, req.params.id)) return res.status(404).json({ error: 'این ردیف هزینه پیدا نشد.' });
    db.logActivity(org.id, actorOf(req), 'settings.changed', 'یک ردیف «هزینهٔ استخدام» را حذف کرد');
    res.json({ ok: true });
  });

  r.put('/costs/assumption', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const parsed = readAssumptionInput(req.body, db.getCostAssumption(org.id));
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    const assumption = db.setCostAssumption(org.id, parsed.value);
    db.logActivity(
      org.id,
      actorOf(req),
      'settings.changed',
      assumption.hourlyRate > 0 ? 'نرخ ساعتی زمان تیم جذب را برای «هزینهٔ هر استخدام» تنظیم کرد' : 'محاسبهٔ هزینهٔ زمان تیم را خاموش کرد'
    );
    res.json({ assumption });
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

/**
 * «اتوماسیون جذب» — API.
 *
 *   GET  /automation                 → settings + queue + history + readiness
 *   PUT  /automation/settings        → thresholds, templates, automatic rules (admin)
 *   POST /automation/run             → build the proposals for a workspace/opening
 *   POST /automation/preview         → show what would be proposed, write nothing
 *   POST /automation/:id/approve     → perform it (send the message / book the slot)
 *   POST /automation/:id/skip        → dismiss it with a note
 *
 * The invariant every route keeps: nothing reaches a candidate here without an
 * explicit approval, except a rule the admin switched on — and that is recorded
 * with `auto: true` so the log never pretends a person did it.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import { normalizeAutomationSettings } from '../automation-settings';
import {
  AutomationError,
  approveAction,
  overview,
  previewProposal,
  proposalOf,
  runAutomation,
  settingsFor,
  skipAction,
} from '../automation';

/** Turns the engine's typed failures into the message the UI shows verbatim. */
function fail(res: express.Response, err: any) {
  if (err instanceof AutomationError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error('[automation]', err?.message || err);
  return res.status(500).json({ error: 'خطای داخلی در اتوماسیون؛ لطفاً دوباره تلاش کنید.' });
}

export function automationRoutes() {
  const r = express.Router();

  r.get(
    '/automation',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobId = str(req.query.jobId, 80) || undefined;
      if (jobId && !db.getJob(org.id, jobId)) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      res.json(overview(org.id, { jobId }));
    })
  );

  r.put(
    '/automation/settings',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const before = settingsFor(org.id);
      const next = normalizeAutomationSettings({ ...before, ...(req.body || {}) });
      // Saving a rule that can mail candidates is an admin decision worth a log line.
      const riskier =
        (next.autoInvite && !before.autoInvite) ||
        (next.autoReject && !before.autoReject) ||
        (next.enabled && !before.enabled);
      db.saveAutomationSettings(org.id, next);
      db.logActivity(
        org.id,
        user,
        'settings.changed',
        riskier ? 'تنظیمات اتوماسیون جذب با اجازهٔ ارسال خودکار ذخیره شد' : 'تنظیمات اتوماسیون جذب به‌روزرسانی شد',
        {}
      );
      res.json({
        settings: next,
        // The UI shows this once, so nobody discovers the rule from a candidate's reply.
        warning: next.autoInvite || next.autoReject
          ? 'ارسال خودکار روشن است: پیام‌هایی که بر اساس آستانه ساخته می‌شوند بدون تأیید شما نیز فرستاده می‌شوند.'
          : null,
      });
    })
  );

  r.post(
    '/automation/preview',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobId = str(req.body?.jobId, 80) || undefined;
      const settings = settingsFor(org.id);
      const existing = new Set(
        db.listAutomationActions(org.id, { jobId, limit: 400 }).map((a) => `${a.resumeId}:${a.kind}`)
      );
      const items = [];
      for (const rec of db.listOrgResumes(org.id, jobId)) {
        const draft = previewProposal(org, rec, settings);
        if ('skip' in draft) continue;
        items.push({
          resumeId: rec.id,
          candidateName: rec.candidateName || 'بدون نام',
          jobTitle: db.getJob(org.id, rec.jobId)?.roleTitle || rec.roleTitle || '—',
          departmentName: rec.departmentName,
          kind: draft.kind,
          reason: draft.reason,
          subject: draft.subject,
          body: draft.body,
          suggestedAtISO: draft.suggestedAtISO,
          alreadyQueued: existing.has(`${rec.id}:${draft.kind}`),
        });
        if (items.length >= 60) break;
      }
      res.json({ enabled: settings.enabled, items });
    })
  );

  r.post(
    '/automation/run',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const jobId = str(req.body?.jobId, 80) || undefined;
      if (jobId && !db.getJob(org.id, jobId)) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      try {
        const result = await runAutomation(org, { id: user.id, name: user.name }, jobId);
        res.json({ result, ...overview(org.id, { jobId }) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/automation/:id/approve',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      let action;
      try {
        action = proposalOf(org.id, str(req.params.id, 80));
      } catch (err) {
        return fail(res, err);
      }
      // A recruiter may edit the wording before sending: their text wins.
      const patch = {
        subject: str(req.body?.subject, 200) || undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
        date: str(req.body?.date, 20) || undefined,
        time: str(req.body?.time, 10) || undefined,
        durationMin: Number(req.body?.durationMin) || undefined,
      };
      try {
        const done = await approveAction(org, { id: user.id, name: user.name }, action, patch);
        res.json({ action: db.withoutOrg(done), ...overview(org.id, { jobId: done.jobId }) });
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  r.post(
    '/automation/:id/skip',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      let action;
      try {
        action = proposalOf(org.id, str(req.params.id, 80));
        const done = skipAction(action, { id: user.id, name: user.name }, str(req.body?.note, 300));
        res.json({ action: db.withoutOrg(done), ...overview(org.id) });
      } catch (err) {
        return fail(res, err);
      }
    })
  );

  return r;
}

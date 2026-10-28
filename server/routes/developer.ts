/**
 * «توسعه‌دهندگان» settings page: API keys and outbound webhooks.
 *
 * Everything here is admin-only and everything is reversible: a key can be
 * revoked in one click and a webhook deleted, so a leaked integration never
 * means shutting the workspace down.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import { API_SCOPES, ApiKeyError, createApiKey, publicKey, revokeApiKey } from '../api-keys';
import { WEBHOOK_EVENTS, WebhookError, prepareEndpoint, publicEndpoint, testEndpoint } from '../webhooks';
import { CHAT_EVENT_LABEL } from '../../src/types/integrations';
import type { DeveloperOverview } from '../../src/types/developer';

function baseUrlOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return `${fixed.replace(/\/$/, '')}/api/v1`;
  return `${req.protocol}://${req.get('host')}/api/v1`;
}

/** A typed failure from one of the two modules becomes the same JSON shape. */
function fail(res: express.Response, err: unknown) {
  if (err instanceof ApiKeyError || err instanceof WebhookError) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  throw err;
}

export function developerRoutes(): express.Router {
  const r = express.Router();

  r.get(
    '/developer/overview',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const payload: DeveloperOverview = {
        baseUrl: baseUrlOf(req),
        docsPath: 'docs/API.md',
        keys: db.listApiKeys(org.id).map(publicKey),
        webhooks: db.listWebhookEndpoints(org.id).map(publicEndpoint),
        deliveries: db.listWebhookDeliveries(org.id, 20).map(db.withoutOrg),
        events: WEBHOOK_EVENTS.map((id) => ({ id, label: CHAT_EVENT_LABEL[id] || id })),
        scopes: API_SCOPES,
      };
      res.json(payload);
    })
  );

  r.post(
    '/developer/keys',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const { token, row } = createApiKey(org.id, actorOf(req), { name: req.body?.name, scopes: req.body?.scopes });
        db.logActivity(org.id, actorOf(req), 'settings.changed', `کلید API «${row.name}» را ساخت`);
        res.status(201).json({ key: token, record: publicKey(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/developer/keys/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = revokeApiKey(org.id, str(req.params.id, 80));
        db.logActivity(org.id, actorOf(req), 'settings.changed', `کلید API «${row.name}» را باطل کرد`);
        res.json({ keys: db.listApiKeys(org.id).map(publicKey) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/developer/webhooks',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      let row: db.WebhookEndpointRow;
      try {
        row = prepareEndpoint({ name: req.body?.name, url: req.body?.url, events: req.body?.events });
      } catch (err) {
        return fail(res, err);
      }
      row.orgId = org.id;
      db.saveWebhookEndpoint(row);
      db.logActivity(org.id, actorOf(req), 'settings.changed', `وب‌هوک «${row.name}» را ثبت کرد`, {});
      // A real POST, immediately — so the admin learns now, not on the first
      // candidate decision, whether the receiver answers.
      let test: { ok: boolean; status: number | null; error: string | null } = { ok: false, status: null, error: 'ارسال آزمایشی انجام نشد.' };
      try {
        test = await testEndpoint(org.id, row.id);
      } catch (err) {
        if (!(err instanceof WebhookError)) throw err;
        test = { ok: false, status: null, error: err.message };
      }
      const saved = db.getWebhookEndpoint(org.id, row.id) || row;
      res.status(201).json({ endpoint: publicEndpoint(saved), test, webhooks: db.listWebhookEndpoints(org.id).map(publicEndpoint) });
    })
  );

  r.patch(
    '/developer/webhooks/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const current = db.getWebhookEndpoint(org.id, str(req.params.id, 80));
      if (!current) return res.status(404).json({ error: 'این وب‌هوک پیدا نشد.' });
      let next: db.WebhookEndpointRow;
      try {
        next = prepareEndpoint({ name: req.body?.name ?? current.name, url: req.body?.url ?? '', events: req.body?.events }, current);
      } catch (err) {
        return fail(res, err);
      }
      if (typeof req.body?.active === 'boolean') next.active = req.body.active;
      db.saveWebhookEndpoint(next);
      res.json({ endpoint: publicEndpoint(next), webhooks: db.listWebhookEndpoints(org.id).map(publicEndpoint) });
    })
  );

  r.post(
    '/developer/webhooks/:id/test',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const test = await testEndpoint(org.id, str(req.params.id, 80));
        const saved = db.getWebhookEndpoint(org.id, str(req.params.id, 80));
        res.json({ test, endpoint: saved ? publicEndpoint(saved) : null, deliveries: db.listWebhookDeliveries(org.id, 20).map(db.withoutOrg) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/developer/webhooks/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const removed = db.deleteWebhookEndpoint(org.id, str(req.params.id, 80));
      if (!removed) return res.status(404).json({ error: 'این وب‌هوک پیدا نشد.' });
      res.json({ webhooks: db.listWebhookEndpoints(org.id).map(publicEndpoint) });
    })
  );

  r.get(
    '/developer/deliveries',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      res.json({ deliveries: db.listWebhookDeliveries(org.id, req.query.limit ? Number(req.query.limit) : 50).map(db.withoutOrg) });
    })
  );

  return r;
}

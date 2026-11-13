/**
 * «بازارچهٔ آزمون» — the workspace's own list of outside test services.
 *
 * Reads are member-level: an interviewer may see which service a result came
 * from. Every write is admin-only, because a write means a credential or a URL
 * that will receive a candidate's name and e-mail.
 */
import express from 'express';
import { ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import {
  ProviderError,
  checkProvider,
  createProvider,
  deleteProvider,
  getProviderRow,
  listProviders,
  publicProvider,
  updateProvider,
} from '../assessment-providers';
import type { ProviderListPayload } from '../../src/types/assessment-provider';

function fail(res: express.Response, err: unknown) {
  if (err instanceof ProviderError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

export function assessmentProviderRoutes(): express.Router {
  const r = express.Router();

  r.get(
    '/assessment-providers',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const items = listProviders(org.id);
      const payload: ProviderListPayload = {
        items,
        contract: {
          check: 'GET {baseUrl}{checkPath} → هر پاسخ 2xx یعنی اتصال سالم است.',
          session: 'POST {baseUrl}{sessionPath} با { testId, candidate:{name,email}, externalRef, expiresAtISO } → { url, id? }',
          result: 'POST /api/v1/results با { externalRef, score?, dimensions?, note? } و کلید API با دسترسی assessments.',
          scope: 'assessments',
        },
        summary: {
          total: items.length,
          ready: items.filter((p) => p.state === 'ready').length,
          unchecked: items.filter((p) => p.state === 'unchecked').length,
          unconfigured: items.filter((p) => p.state === 'unconfigured').length,
          degraded: items.filter((p) => p.state === 'degraded').length,
        },
      };
      res.json(payload);
    })
  );

  r.post(
    '/assessment-providers',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = createProvider(org.id, { id: user.id, name: user.name }, req.body || {});
        res.status(201).json({ provider: publicProvider(org.id, row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.patch(
    '/assessment-providers/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = updateProvider(org.id, str(req.params.id, 80), { id: user.id, name: user.name }, req.body || {});
        res.json({ provider: publicProvider(org.id, row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** A real GET, and the screen shows what came back — status and latency. */
  r.post(
    '/assessment-providers/:id/check',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const row = await checkProvider(org.id, str(req.params.id, 80), { id: user.id, name: user.name });
        res.json({ provider: publicProvider(org.id, row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/assessment-providers/:id',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      try {
        const result = deleteProvider(org.id, str(req.params.id, 80), { id: user.id, name: user.name });
        res.json(result);
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** One provider, with its tests — used by the send dialog after a reload. */
  r.get(
    '/assessment-providers/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const row = getProviderRow(org.id, str(req.params.id, 80));
        res.json({ provider: publicProvider(org.id, row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

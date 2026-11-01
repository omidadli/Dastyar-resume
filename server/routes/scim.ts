/**
 * `/scim/v2` — the provisioning API an identity provider calls.
 *
 * It is mounted **before** `requireAuth` on purpose: Okta does not carry a user
 * session, it carries the workspace's SCIM bearer token. Every route below goes
 * through the same token check, so a request without a valid token never reaches
 * a handler.
 *
 * Every refusal is a SCIM error with a `scimType`, so the IT admin sees *why* the
 * sync failed (bad filter, duplicate userName, unsupported path) instead of a
 * silent partial import.
 */
import express from 'express';
import {
  SCIM_SCHEMAS,
  ScimError,
  applyScimPatch,
  createScimUser,
  ensureScimContentType,
  listScimUsers,
  parseUserFilter,
  scimError,
  scimGroups,
  scimOrgOf,
  scimServiceProviderConfig,
  scimUserResource,
  userById,
} from '../scim';
import { h, int, str } from './util';
import * as db from '../db';

declare global {
  namespace Express {
    interface Request {
      /** Set by the SCIM token middleware; never present on workspace routes. */
      scimOrg?: db.OrgRecord;
    }
  }
}

const MAX_COUNT = 200;

export function scimRoutes(): express.Router {
  const r = express.Router();

  r.use((req, res, next) => {
    const org = scimOrgOf(req);
    if (!org) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="scim"');
      ensureScimContentType(res);
      return res.status(401).json({
        schemas: [SCIM_SCHEMAS.SCHEMA_ERROR],
        detail: 'توکن SCIM نامعتبر است یا باطل شده است؛ در تنظیمات › توسعه‌دهندگان توکن تازه صادر کنید.',
        status: '401',
        scimType: 'invalidToken',
      });
    }
    req.scimOrg = org;
    ensureScimContentType(res);
    next();
  });

  const orgOf = (req: express.Request) => req.scimOrg!;

  // ------------------------------------------------------- discovery ----
  r.get('/ServiceProviderConfig', (_req, res) => res.json(scimServiceProviderConfig()));

  r.get('/ResourceTypes', (_req, res) =>
    res.json({
      schemas: [SCIM_SCHEMAS.SCHEMA_LIST],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
      Resources: [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'User',
          name: 'User',
          endpoint: '/Users',
          schema: SCIM_SCHEMAS.SCHEMA_USER,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
        },
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
          id: 'Group',
          name: 'Group',
          endpoint: '/Groups',
          schema: SCIM_SCHEMAS.SCHEMA_GROUP,
          meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/Group' },
        },
      ],
    })
  );

  r.get('/Schemas', (_req, res) =>
    res.json({
      schemas: [SCIM_SCHEMAS.SCHEMA_LIST],
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [
        {
          id: SCIM_SCHEMAS.SCHEMA_USER,
          name: 'User',
          description: 'کاربر هویدا — نام، ایمیل، عنوان، نقش و وضعیت فعال.',
          attributes: [
            { name: 'userName', type: 'string', multiValued: false, required: true, uniqueness: 'server', mutability: 'readWrite', returned: 'default' },
            { name: 'displayName', type: 'string', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
            { name: 'title', type: 'string', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
            { name: 'active', type: 'boolean', multiValued: false, required: false, mutability: 'readWrite', returned: 'default' },
            { name: 'roles', type: 'complex', multiValued: true, required: false, mutability: 'readWrite', returned: 'default', subAttributes: [{ name: 'value', type: 'string', mutability: 'readWrite', returned: 'default' }] },
          ],
          meta: { resourceType: 'Schema', location: `/scim/v2/Schemas/${SCIM_SCHEMAS.SCHEMA_USER}` },
        },
      ],
    })
  );

  // ------------------------------------------------------------ users ----
  r.get('/Users', (req, res) => {
    try {
      const org = orgOf(req);
      const filter = str(req.query.filter, 400);
      const wanted = filter ? parseUserFilter(filter) : null;
      const rows = listScimUsers(org.id, wanted);
      const startIndex = Math.max(1, int(req.query.startIndex, 1));
      const count = Math.min(MAX_COUNT, Math.max(1, int(req.query.count, 50)));
      const page = rows.slice(startIndex - 1, startIndex - 1 + count);
      res.json({
        schemas: [SCIM_SCHEMAS.SCHEMA_LIST],
        totalResults: rows.length,
        startIndex,
        itemsPerPage: page.length,
        Resources: page.map((u) => scimUserResource(u, org)),
      });
    } catch (err) {
      scimError(res, err);
    }
  });

  r.get('/Users/:id', (req, res) => {
    const org = orgOf(req);
    const u = userById(org.id, req.params.id);
    if (!u) return scimError(res, new ScimError(404, 'کاربر در این فضای کاری پیدا نشد.', 'notFound'));
    res.json(scimUserResource(u, org));
  });

  r.post(
    '/Users',
    h(async (req, res) => {
      try {
        const org = orgOf(req);
        const created = await createScimUser(org, req.body);
        res.status(201).location(`/scim/v2/Users/${created.id}`).json(scimUserResource(created, org));
      } catch (err) {
        scimError(res, err);
      }
    })
  );

  r.put('/Users/:id', (req, res) => {
    try {
      const org = orgOf(req);
      const u = userById(org.id, req.params.id);
      if (!u) throw new ScimError(404, 'کاربر در این فضای کاری پیدا نشد.', 'notFound');
      // A full replace is expressed as replace operations on every mutable field.
      const body = req.body || {};
      const ops: any[] = [];
      if (body.displayName !== undefined || body.name) ops.push({ op: 'replace', path: 'displayName', value: body.displayName ?? body.name?.formatted });
      if (body.title !== undefined) ops.push({ op: 'replace', path: 'title', value: body.title });
      if (body.active !== undefined) ops.push({ op: 'replace', path: 'active', value: body.active });
      if (body.roles !== undefined) ops.push({ op: 'replace', path: 'roles', value: Array.isArray(body.roles) ? body.roles[0]?.value : body.roles });
      const updated = applyScimPatch(u, org, { Operations: ops.filter((o) => o.value !== undefined) });
      res.json(scimUserResource(updated, org));
    } catch (err) {
      scimError(res, err);
    }
  });

  r.patch('/Users/:id', (req, res) => {
    try {
      const org = orgOf(req);
      const u = userById(org.id, req.params.id);
      if (!u) throw new ScimError(404, 'کاربر در این فضای کاری پیدا نشد.', 'notFound');
      const updated = applyScimPatch(u, org, req.body);
      res.json(scimUserResource(updated, org));
    } catch (err) {
      scimError(res, err);
    }
  });

  /**
   * Deprovisioning means «this person no longer works here». We deactivate and
   * end their sessions instead of erasing them: the hiring history they left
   * behind belongs to the workspace, and an IdP mistake must be reversible.
   */
  r.delete('/Users/:id', (req, res) => {
    try {
      const org = orgOf(req);
      const u = userById(org.id, req.params.id);
      if (!u) throw new ScimError(404, 'کاربر در این فضای کاری پیدا نشد.', 'notFound');
      applyScimPatch(u, org, { Operations: [{ op: 'replace', path: 'active', value: false }] });
      res.status(204).end();
    } catch (err) {
      scimError(res, err);
    }
  });

  // ----------------------------------------------------------- groups ----
  r.get('/Groups', (req, res) => {
    const org = orgOf(req);
    const groups = scimGroups(org);
    res.json({
      schemas: [SCIM_SCHEMAS.SCHEMA_LIST],
      totalResults: groups.length,
      startIndex: 1,
      itemsPerPage: groups.length,
      Resources: groups,
    });
  });

  r.get('/Groups/:id', (req, res) => {
    const org = orgOf(req);
    const group = scimGroups(org).find((g) => g.id === req.params.id);
    if (!group) return scimError(res, new ScimError(404, 'گروه پیدا نشد.', 'notFound'));
    res.json(group);
  });

  /**
   * Groups are roles. Creating a new one would mean inventing a permission model
   * the app does not have, so we refuse loudly instead of pretending: roles are
   * changed on the user (`roles`), and the change is logged.
   */
  const groupsReadOnly = (_req: express.Request, res: express.Response) =>
    scimError(
      res,
      new ScimError(
        501,
        'گروه‌ها در هویدا همان نقش‌ها هستند و فقط خواندنی‌اند. برای تغییر نقش، فیلد roles کاربر را با PATCH عوض کنید (member یا admin).',
        'notImplemented'
      )
    );
  r.post('/Groups', groupsReadOnly);
  r.patch('/Groups/:id', groupsReadOnly);
  r.put('/Groups/:id', groupsReadOnly);
  r.delete('/Groups/:id', groupsReadOnly);

  return r;
}

/**
 * «SCIM 2.0» — the standard an IT department expects before it will let HOVIDA
 * into the company: people are created, renamed and deactivated in the identity
 * provider (Okta, Entra ID, Google Workspace), and the app follows.
 *
 * What this module deliberately does *not* do:
 *   • it never deletes a person's record — `active: false` disables the account
 *     and ends its sessions, so hiring history and audit stay intact;
 *   • it never lets a provisioning token create an owner, and only an
 *     owner-issued token may mark someone as admin;
 *   • it never returns a password. A provisioned member signs in through the
 *     workspace's SSO, or an admin sets a password in «تیم».
 *
 * Token shape: `hvd_scim_<12 hex id>_<43 char secret>`. Only a SHA-256 of the
 * secret and the id are stored, so a copied snapshot cannot be replayed.
 */
import crypto from 'crypto';
import type express from 'express';
import * as db from './db';
import { hashPassword, hashToken, isValidEmail } from './auth';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { Role } from '../src/types/app';

export const SCIM_BASE = '/scim/v2';
const TOKEN_RE = /^hvd_scim_([a-f0-9]{12})_([A-Za-z0-9_-]{32,})$/;
const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const SCHEMA_SPC = 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';

export class ScimError extends Error {
  status: number;
  scimType: string;
  constructor(status: number, detail: string, scimType = 'invalidValue') {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
}

// ------------------------------------------------------------------ token ----

export function issueScimToken(orgId: string, actor: { name: string; role: Role }): { token: string; record: NonNullable<db.OrgRecord['scim']> } {
  const org = db.getOrg(orgId);
  if (!org) throw new ScimError(404, 'فضای کاری پیدا نشد.', 'notFound');
  const id = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const record = {
    id,
    tokenHash: hashToken(secret),
    createdAtISO: new Date().toISOString(),
    createdByName: actor.name,
    // Only an owner's token may hand out admin; an admin's token provisions members.
    canManageAdmins: actor.role === 'owner',
    lastUsedISO: null,
  };
  db.updateOrg(orgId, { scim: record });
  return { token: `hvd_scim_${id}_${secret}`, record };
}

export function revokeScimToken(orgId: string): void {
  db.updateOrg(orgId, { scim: null });
}

/** Public view — never the hash. */
export function publicScimToken(org: db.OrgRecord) {
  const s = org.scim;
  return s
    ? {
        configured: true,
        tokenId: s.id,
        createdAtISO: s.createdAtISO,
        createdByName: s.createdByName,
        canManageAdmins: s.canManageAdmins,
        lastUsedISO: s.lastUsedISO,
      }
    : { configured: false, tokenId: null, createdAtISO: null, createdByName: null, canManageAdmins: false, lastUsedISO: null };
}

/**
 * Resolves the bearer token to a workspace. One map scan is fine: workspaces are
 * few and the id prefix keeps it to a single string compare per workspace.
 */
export function scimOrgOf(req: express.Request): db.OrgRecord | null {
  const header = String(req.headers.authorization || '');
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const parsed = TOKEN_RE.exec(m[1].trim());
  if (!parsed) return null;
  const [, id, secret] = parsed;
  const org = db.findOrgByScimId(id);
  if (!org?.scim) return null;
  const expected = Buffer.from(org.scim.tokenHash, 'utf8');
  const actual = Buffer.from(hashToken(secret), 'utf8');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  // Keep a light trail: the settings page shows when the IdP last called. At most
  // one write every five minutes — an IdP can poll a lot.
  const seen = org.scim.lastUsedISO ? new Date(org.scim.lastUsedISO).getTime() : 0;
  if (Date.now() - seen > 5 * 60_000) {
    org.scim.lastUsedISO = new Date().toISOString();
    db.scheduleSave();
  }
  return org;
}

// -------------------------------------------------------------- responses ----

export function scimError(res: express.Response, err: unknown) {
  if (err instanceof ScimError) {
    return res.status(err.status).json({
      schemas: [SCHEMA_ERROR],
      detail: err.message,
      status: String(err.status),
      scimType: err.scimType,
    });
  }
  throw err;
}

export function ensureScimContentType(res: express.Response) {
  res.setHeader('Content-Type', 'application/scim+json');
}

// ---------------------------------------------------------------- mapping ----

function memberOf(orgId: string): db.UserRecord[] {
  return db.listMembers(orgId);
}

function scimUserOf(u: db.UserRecord, org: db.OrgRecord) {
  const base = `${SCIM_BASE}/Users/${u.id}`;
  const [givenName, ...rest] = String(u.name || '').trim().split(/\s+/);
  return {
    schemas: [SCHEMA_USER],
    id: u.id,
    externalId: u.id,
    userName: u.email,
    name: {
      formatted: u.name,
      givenName: givenName || '',
      familyName: rest.join(' ') || '',
    },
    displayName: u.name,
    title: u.title || null,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    roles: [{ value: u.role, primary: true }],
    active: !u.disabled,
    meta: {
      resourceType: 'User',
      created: u.createdAtISO,
      lastModified: u.createdAtISO,
      location: base,
    },
    // The workspace this resource belongs to; useful when one IdP feeds several.
    'urn:hovida:params:scim:schemas:extension:2.0:Org': { name: org.name, slug: org.careerSlug },
  };
}

function scimGroupOf(org: db.OrgRecord, role: Role) {
  const members = memberOf(org.id).filter((u) => u.role === role && !u.disabled);
  const label = role === 'owner' ? 'owners' : role === 'admin' ? 'admins' : 'members';
  return {
    schemas: [SCHEMA_GROUP],
    id: `${org.id}:${label}`,
    displayName: label,
    members: members.map((u) => ({ value: u.id, display: u.name, $ref: `${SCIM_BASE}/Users/${u.id}` })),
    meta: { resourceType: 'Group', location: `${SCIM_BASE}/Groups/${org.id}:${label}` },
  };
}

// ---------------------------------------------------------------- filters ----

/**
 * Only the two filters identity providers actually send are supported:
 * `userName eq "..."` and `externalId eq "..."`. Anything else is refused with
 * `invalidFilter` — silently ignoring a filter would sync the wrong people.
 */
export function parseUserFilter(raw: string): string | null {
  const text = raw.trim();
  const m = /^(userName|externalId)\s+eq\s+"([^"]{1,200})"$/i.exec(text);
  if (!m) throw new ScimError(400, `این فیلتر پشتیبانی نمی‌شود: «${text}». فقط userName eq "…" و externalId eq "…" پذیرفته می‌شوند.`, 'invalidFilter');
  return m[2];
}

// --------------------------------------------------------------- mutation ----

function readActive(body: any, fallback: boolean): boolean {
  if (typeof body?.active === 'boolean') return body.active;
  return fallback;
}

function readName(body: any): string | null {
  const formatted = typeof body?.displayName === 'string' ? body.displayName.trim() : '';
  const fromName = typeof body?.name?.formatted === 'string' ? body.name.formatted.trim() : '';
  const parts = [body?.name?.givenName, body?.name?.familyName].filter((x: unknown) => typeof x === 'string' && x.trim());
  const joined = parts.length ? parts.join(' ').trim() : '';
  const value = formatted || fromName || joined;
  return value ? value.slice(0, 80) : null;
}

function readRole(body: any, canManageAdmins: boolean): Role | null {
  const raw = Array.isArray(body?.roles) ? body.roles.find((r: any) => typeof r?.value === 'string')?.value : null;
  if (raw === 'admin') {
    if (!canManageAdmins) {
      throw new ScimError(403, 'این توکن اجازهٔ تعیین مدیر را ندارد؛ توکن را مالک فضای کاری صادر کند یا نقش را در هویدا تغییر دهید.', 'mutability');
    }
    return 'admin';
  }
  if (raw === 'member') return 'member';
  if (raw === 'owner') throw new ScimError(403, 'نقش مالک از طریق SCIM قابل تعیین نیست.', 'mutability');
  return null;
}

/** A strong random password. Callers decide whether it is ever shown. */
export function randomPassword(): string {
  return crypto.randomBytes(24).toString('base64url') + 'aA1!';
}

export async function createScimUser(org: db.OrgRecord, body: any) {
  const canManageAdmins = Boolean(org.scim?.canManageAdmins);
  const userName = typeof body?.userName === 'string' ? body.userName.trim().toLowerCase() : '';
  if (!userName) throw new ScimError(400, 'فیلد userName الزامی است.', 'invalidValue');
  if (!isValidEmail(userName)) throw new ScimError(400, 'userName باید یک ایمیل معتبر باشد.', 'invalidValue');
  const name = readName(body) || userName.split('@')[0];
  const role = readRole(body, canManageAdmins) || 'member';
  if (db.findUserByEmail(userName)) {
    throw new ScimError(409, 'کاربری با این ایمیل (در همین یا فضای کاری دیگر) از قبل وجود دارد.', 'uniqueness');
  }
  const passwordHash = await hashPassword(randomPassword() + crypto.randomBytes(8).toString('hex'));
  const created = db.createUser({
    orgId: org.id,
    name,
    email: userName,
    title: typeof body?.title === 'string' ? body.title.slice(0, 60) : '',
    role,
    passwordHash,
  });
  if (readActive(body, true) === false) db.updateUser(created.id, { disabled: true });
  const fresh = db.getUser(created.id)!;
  db.logActivity(
    org.id,
    { id: 'scim', name: 'SCIM (فراهم‌کنندهٔ هویت)' },
    'member.added',
    role === 'admin' ? `«${fresh.name}» را از طریق SCIM به‌عنوان مدیر افزود` : `«${fresh.name}» را از طریق SCIM به تیم افزود`
  );
  return db.getUser(created.id)!;
}

export function applyScimPatch(user: db.UserRecord, org: db.OrgRecord, body: any) {
  const canManageAdmins = Boolean(org.scim?.canManageAdmins);
  const operations = Array.isArray(body?.Operations) ? body.Operations : Array.isArray(body?.operations) ? body.operations : null;
  if (!operations) throw new ScimError(400, 'بدنهٔ درخواست باید Operations داشته باشد.', 'invalidSyntax');
  const next: { name?: string; title?: string; role?: Role; disabled?: boolean } = {};

  const applyOne = (op: string, path: string, value: any) => {
    const verb = op.toLowerCase();
    const p = path.toLowerCase();
    if (p === 'active') {
      if (verb === 'remove') next.disabled = true;
      else next.disabled = !value;
      return;
    }
    if (p === 'displayname' || p === 'name.formatted' || p === 'name' || p === '') {
      if (verb === 'remove') throw new ScimError(400, 'نام نمی‌تواند خالی شود.', 'invalidPath');
      const name = readName(typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { displayName: value });
      if (!name) throw new ScimError(400, 'مقدار نام نامعتبر است.', 'invalidValue');
      next.name = name;
      return;
    }
    if (p === 'name.givenname' || p === 'name.familyname') {
      if (typeof value !== 'string' || !value.trim()) throw new ScimError(400, 'مقدار نام نامعتبر است.', 'invalidValue');
      const [given, ...family] = String(user.name || '').split(/\s+/);
      next.name = p === 'name.givenname' ? `${value.trim()} ${family.join(' ')}`.trim() : `${given || ''} ${value.trim()}`.trim();
      return;
    }
    if (p === 'title') {
      next.title = verb === 'remove' ? '' : String(value ?? '').slice(0, 60);
      return;
    }
    if (p === 'roles') {
      const role = readRole({ roles: [{ value }] }, canManageAdmins);
      if (!role) throw new ScimError(400, 'نقش ناشناخته است؛ فقط member و admin پذیرفته می‌شوند.', 'invalidValue');
      next.role = role;
      return;
    }
    throw new ScimError(400, `مسیر «${path}» پشتیبانی نمی‌شود و برای جلوگیری از همگام‌سازی ناقص رد شد.`, 'invalidPath');
  };

  for (const raw of operations) {
    const op = typeof raw?.op === 'string' ? raw.op : '';
    if (!op) throw new ScimError(400, 'هر عملیات باید op داشته باشد.', 'invalidSyntax');
    const path = typeof raw?.path === 'string' ? raw.path : '';
    const value = raw?.value;
    // Azure sends `{op:'replace', value:{active:false, name:{…}}}` with no path.
    if (!path && value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>);
      for (const [k, v] of entries) applyOne(op, k, v);
      continue;
    }
    if (!path && typeof value === 'object' && Array.isArray((value as any)?.roles)) {
      applyOne(op, 'roles', (value as any).roles[0]?.value);
      continue;
    }
    applyOne(op, path, value);
  }

  if (user.role === 'owner') {
    if (next.role && next.role !== 'owner') throw new ScimError(403, 'نقش مالک فضای کاری از طریق SCIM قابل تغییر نیست.', 'mutability');
    if (next.disabled) throw new ScimError(403, 'حساب مالک فضای کاری از طریق SCIM غیرفعال نمی‌شود.', 'mutability');
  }
  const updated = db.updateUser(user.id, {
    ...(next.name ? { name: next.name } : {}),
    ...(next.title !== undefined ? { title: next.title } : {}),
    ...(next.role ? { role: next.role } : {}),
    ...(next.disabled !== undefined ? { disabled: next.disabled } : {}),
  });
  if (next.disabled) db.deleteSessionsOfUser(user.id);
  if (next.disabled !== undefined || next.role) {
    db.logActivity(
      org.id,
      { id: 'scim', name: 'SCIM (فراهم‌کنندهٔ هویت)' },
      'member.updated',
      next.disabled === true
        ? `«${user.name}» را از طریق SCIM غیرفعال کرد`
        : next.disabled === false
          ? `«${user.name}» را از طریق SCIM دوباره فعال کرد`
          : `نقش «${user.name}» را از طریق SCIM تغییر داد`
    );
  }
  return db.getUser(user.id) || updated!;
}

export function userCount(orgId: string) {
  return memberOf(orgId).length;
}

export function userById(orgId: string, id: string) {
  const u = db.getUser(id);
  return u && u.orgId === orgId ? u : null;
}

export function listScimUsers(orgId: string, filterValue: string | null) {
  const all = memberOf(orgId);
  if (!filterValue) return all;
  return all.filter((u) => u.email === filterValue.toLowerCase() || u.id === filterValue);
}

export function scimUserResource(u: db.UserRecord, org: db.OrgRecord) {
  return scimUserOf(u, org);
}

export function scimGroups(org: db.OrgRecord) {
  return (['owner', 'admin', 'member'] as Role[]).map((r) => scimGroupOf(org, r));
}

export function scimServiceProviderConfig() {
  return {
    schemas: [SCHEMA_SPC],
    documentationUri: `${SCIM_BASE}/ServiceProviderConfig`,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description: 'توکن SCIM که مدیر فضای کاری در تنظیمات › توسعه‌دهندگان صادر می‌کند.',
        specUri: 'https://www.rfc-editor.org/info/rfc6750',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${SCIM_BASE}/ServiceProviderConfig` },
  };
}

export const SCIM_SCHEMAS = { SCHEMA_USER, SCHEMA_GROUP, SCHEMA_LIST, SCHEMA_ERROR, SCHEMA_PATCH };

export function jDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return formatJalaliDate(tehranJalaliOf(new Date(iso)), true);
}

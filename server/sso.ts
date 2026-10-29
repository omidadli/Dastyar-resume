/**
 * «ورود سازمانی (SSO)» — the workspace-facing half of the OIDC flow.
 *
 * One workspace can connect one provider (Google Workspace, Microsoft Entra ID,
 * Okta, Keycloak…). People then sign in with their company account instead of a
 * password; the workspace decides whether that is optional or mandatory.
 *
 * Honest boundaries, written into the UI as well:
 *  • A person is only let in when the e-mail domain is on the workspace's list
 *    **and** the provider says the address is verified.
 *  • Auto-join creates a member (never an owner/admin unless the workspace said so).
 *  • An e-mail that already belongs to another workspace is refused, not merged:
 *    two tenants never share an account.
 */
import crypto from 'crypto';
import type express from 'express';
import * as db from './db';
import type { Role } from '../src/types/app';
import type { SsoStatus } from '../src/types/sso';
import { decryptSecret, encryptSecret } from './secret';
import { OidcError, type DiscoveryDoc, type IdClaims, discover } from './oidc';

export interface SsoRowData {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  domains: string[];
  autoJoin: boolean;
  defaultRole: 'admin' | 'member';
  requireSso: boolean;
  updatedAtISO: string;
  updatedByName: string | null;
  lastLoginAtISO: string | null;
  lastError: string | null;
}

export interface PendingFlow {
  orgId: string;
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  /** Where to send the browser after a successful login. */
  next: string | null;
  createdAt: number;
}

const FLOW_TTL_MS = 10 * 60_000;
const flows = new Map<string, PendingFlow>();

export function purgeFlows(now = Date.now()) {
  for (const [state, flow] of flows) if (now - flow.createdAt > FLOW_TTL_MS) flows.delete(state);
}

export function rememberFlow(flow: PendingFlow) {
  purgeFlows();
  // A single instance holds at most a few hundred open logins; a cap keeps a
  // flood of half-finished attempts from becoming a memory leak.
  if (flows.size > 2000) flows.delete(flows.keys().next().value as string);
  flows.set(flow.state, flow);
}

/** Single use: a replayed callback finds nothing. */
export function takeFlow(state: string): PendingFlow | null {
  purgeFlows();
  const flow = flows.get(state);
  if (!flow) return null;
  flows.delete(state);
  return flow;
}

/** Test/QA helper: how many logins are mid-flight. */
export function pendingFlowCount(): number {
  purgeFlows();
  return flows.size;
}

export function forgetFlowsOf(orgId: string) {
  for (const [state, flow] of flows) if (flow.orgId === orgId) flows.delete(state);
}

// ------------------------------------------------------------------ config ----

export function ssoOf(orgId: string): SsoRowData | null {
  const row = db.getOrgSecrets(orgId).sso;
  return row && typeof row === 'object' ? (row as SsoRowData) : null;
}

export function ssoSecret(orgId: string): string | null {
  const row = ssoOf(orgId);
  if (!row?.clientSecretEnc) return null;
  return decryptSecret(row.clientSecretEnc);
}

export function redirectUriFor(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  const base = fixed ? fixed.replace(/\/$/, '') : `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/sso/callback`;
}

/** Lowercased, de-duplicated, syntax-checked domain list. */
export function normalizeDomains(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const item of list.slice(0, 50)) {
    const d = String(item || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (!d) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) continue;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase() || null;
}

/** The workspace that claims this e-mail domain (at most one, first match wins). */
export function orgForDomain(domain: string): { org: db.OrgRecord; row: SsoRowData } | null {
  const d = domain.trim().toLowerCase();
  if (!d) return null;
  for (const org of db.allOrgs()) {
    const row = ssoOf(org.id);
    if (row?.enabled && row.domains.includes(d)) return { org, row };
  }
  return null;
}

export function ssoConfigured(orgId: string): boolean {
  const row = ssoOf(orgId);
  return Boolean(row?.enabled && row.issuer && row.clientId && row.clientSecretEnc && row.domains.length);
}

export function statusOf(orgId: string, redirectUri: string): SsoStatus {
  const row = ssoOf(orgId);
  return {
    enabled: ssoConfigured(orgId),
    issuer: row?.issuer || null,
    clientId: row?.clientId || null,
    domains: row?.domains || [],
    autoJoin: row?.autoJoin ?? true,
    defaultRole: row?.defaultRole || 'member',
    requireSso: Boolean(row?.requireSso),
    clientSecretSet: Boolean(row?.clientSecretEnc),
    updatedAtISO: row?.updatedAtISO || null,
    updatedByName: row?.updatedByName || null,
    lastLoginAtISO: row?.lastLoginAtISO || null,
    lastError: row?.lastError || null,
    redirectUri,
  };
}

export function saveSso(
  orgId: string,
  input: {
    issuer: string;
    clientId: string;
    clientSecret?: string;
    domains: string[];
    autoJoin?: boolean;
    defaultRole?: 'admin' | 'member';
    requireSso?: boolean;
  },
  actorName: string
): SsoRowData {
  const previous = ssoOf(orgId);
  // An empty secret box means «keep the one we have»; there is no way to read it
  // back into the browser, so requiring a retype would be hostile.
  const secretEnc = input.clientSecret ? encryptSecret(input.clientSecret) : previous?.clientSecretEnc || '';
  const row: SsoRowData = {
    enabled: Boolean(secretEnc),
    issuer: input.issuer.trim().replace(/\/$/, ''),
    clientId: input.clientId.trim(),
    clientSecretEnc: secretEnc,
    domains: normalizeDomains(input.domains),
    autoJoin: input.autoJoin !== false,
    defaultRole: input.defaultRole === 'admin' ? 'admin' : 'member',
    requireSso: Boolean(input.requireSso),
    updatedAtISO: new Date().toISOString(),
    updatedByName: actorName,
    lastLoginAtISO: previous?.lastLoginAtISO || null,
    lastError: null,
  };
  db.patchOrgSecrets(orgId, { sso: row });
  return row;
}

export function clearSso(orgId: string) {
  // `undefined` removes the key from the stored object (a merge cannot delete it).
  db.patchOrgSecrets(orgId, { sso: undefined });
  forgetFlowsOf(orgId);
}

export function noteSsoLogin(orgId: string) {
  const row = ssoOf(orgId);
  if (!row) return;
  db.patchOrgSecrets(orgId, { sso: { ...row, lastLoginAtISO: new Date().toISOString(), lastError: null } });
}

export function noteSsoError(orgId: string, message: string) {
  const row = ssoOf(orgId);
  if (!row) return;
  db.patchOrgSecrets(orgId, { sso: { ...row, lastError: message.slice(0, 300) } });
}

/** Discovery for one workspace, or a typed error the UI can show in Persian. */
export async function discoveryFor(orgId: string, opts: { fresh?: boolean } = {}): Promise<DiscoveryDoc> {
  const row = ssoOf(orgId);
  if (!row?.issuer) throw new OidcError('ابتدا نشانی سرویس ورود سازمانی را ذخیره کنید.', 'NOT_CONFIGURED');
  return discover(row.issuer, opts);
}

// ------------------------------------------------------------------- login ----

export interface SsoIdentity {
  email: string;
  name: string;
  subject: string;
}

/** Reads the identity out of verified claims; refuses unverified addresses. */
export function identityFromClaims(claims: IdClaims): SsoIdentity {
  const email = String(claims.email || claims.preferred_username || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new OidcError('سرویس ورود سازمانی ایمیل کاربر را برنگرداند؛ دسترسی به ایمیل را در تنظیمات IdP روشن کنید.', 'NO_EMAIL');
  }
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  if (!verified) throw new OidcError('ایمیل این حساب در سرویس سازمانی تأیید نشده است.', 'EMAIL_UNVERIFIED');
  const name = String(claims.name || claims.given_name || email.split('@')[0]).trim().slice(0, 80);
  return { email, name: name || email.split('@')[0], subject: String(claims.sub) };
}

export type SsoLoginResult =
  | { ok: true; user: db.UserRecord; org: db.OrgRecord; created: boolean }
  | { ok: false; status: number; code: string; error: string };

/**
 * Turns a verified identity into a session subject.
 *
 * `autoJoin` off means only people already invited into the workspace may enter —
 * that is the safe default for a team that hires slowly.
 */
export function signInWithIdentity(org: db.OrgRecord, row: SsoRowData, identity: SsoIdentity): SsoLoginResult {
  const domain = emailDomain(identity.email);
  if (!domain || !row.domains.includes(domain)) {
    return { ok: false, status: 403, code: 'SSO_DOMAIN', error: 'این ایمیل در فهرست دامنه‌های مجاز این فضای کاری نیست.' };
  }

  const existing = db.findUserByEmail(identity.email);
  if (existing) {
    if (existing.orgId !== org.id) {
      return {
        ok: false,
        status: 409,
        code: 'SSO_OTHER_ORG',
        error: 'این ایمیل به فضای کاری دیگری تعلق دارد؛ ورود سازمانی بین دو سازمان ادغام نمی‌شود.',
      };
    }
    if (existing.disabled) {
      return { ok: false, status: 403, code: 'ACCOUNT_DISABLED', error: 'حساب کاربری شما غیرفعال شده است؛ با مدیر سامانه تماس بگیرید.' };
    }
    db.updateUser(existing.id, { lastLoginISO: new Date().toISOString() });
    noteSsoLogin(org.id);
    db.logActivity(org.id, { id: existing.id, name: existing.name }, 'settings.changed', 'با حساب سازمانی (SSO) وارد شد');
    return { ok: true, user: existing, org, created: false };
  }

  if (!row.autoJoin) {
    return {
      ok: false,
      status: 403,
      code: 'SSO_NOT_INVITED',
      error: 'برای این ایمیل عضویتی در این فضای کاری نیست. «ورود خودکار اعضای جدید» خاموش است؛ از مدیر بخواهید دعوت‌تان کند.',
    };
  }

  // SSO accounts have no password: a random one nobody knows keeps the password
  // route closed even if «SSO only» is later switched off.
  const passwordHash = `scrypt$16384$8$1$${crypto.randomBytes(16).toString('base64')}$${crypto.randomBytes(64).toString('base64')}`;
  const role: Role = row.defaultRole === 'admin' ? 'admin' : 'member';
  const user = db.createUser({ orgId: org.id, name: identity.name, email: identity.email, passwordHash, role, title: '' });
  db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
  noteSsoLogin(org.id);
  db.logActivity(org.id, { id: user.id, name: user.name }, 'member.added', `با حساب سازمانی (SSO) به تیم اضافه شد — نقش «${role === 'admin' ? 'مدیر' : 'عضو تیم'}»`);
  return { ok: true, user, org, created: true };
}

/** «SSO only» for the workspaces that asked for it. */
export function passwordBlockedFor(email: string): { org: db.OrgRecord; row: SsoRowData } | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  const found = orgForDomain(domain);
  if (!found) return null;
  return found.row.requireSso ? found : null;
}

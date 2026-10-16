/**
 * Authentication & authorization for HOVIDA workspaces.
 *
 *  - Passwords: scrypt (N=16384, r=8, p=1) with a per-user random salt.
 *  - Sessions: random 32-byte bearer tokens; only their SHA-256 hash is stored.
 *  - Files: short-lived HMAC-signed URLs, so <iframe>/<img>/downloads work
 *    without exposing the bearer token in a URL.
 *  - Brute force: in-memory sliding-window rate limits on login/signup/demo.
 */
import crypto from 'crypto';
import type express from 'express';
import type { Role } from '../src/types/app';
import * as db from './db';
import { appSecret } from './secret';
import { demoTtlMs, isPlatformAdmin, sessionTtlMs, systemSettings } from './platform';

export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const DEMO_TTL_MS = 24 * 3600_000;
const FILE_URL_TTL_MS = 10 * 60_000;

// ------------------------------------------------------------- passwords ----

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key as Buffer)))
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** Persian feedback for weak passwords; null when acceptable. */
export function passwordProblem(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) return 'رمز عبور باید حداقل ۸ کاراکتر باشد.';
  if (password.length > 128) return 'رمز عبور بیش از حد طولانی است.';
  if (!/[A-Za-z\u0600-\u06FF]/.test(password) || !/[0-9۰-۹]/.test(password)) {
    return 'برای امنیت بیشتر، رمز عبور را ترکیبی از حروف و عدد انتخاب کنید.';
  }
  return null;
}

export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

// --------------------------------------------------------------- sessions ----

export function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function issueSession(userId: string, ttlMs = sessionTtlMs(), support?: { adminId: string; adminName: string }): string {
  const { token, hash } = newSessionToken();
  db.createSession(userId, hash, ttlMs, support);
  return token;
}

export interface AuthContext {
  user: db.UserRecord;
  org: db.OrgRecord;
  tokenHash: string;
  /** Set for sessions a platform admin opened for support. */
  support: { adminId: string; adminName: string; expiresAt: number } | null;
}

/** Why an account may not use the app right now (null = allowed). */
export function accessBlock(
  user: db.UserRecord,
  org: db.OrgRecord,
  opts: { support?: boolean } = {}
): { status: number; code: string; error: string } | null {
  if (user.disabled) {
    return { status: 403, code: 'ACCOUNT_DISABLED', error: 'حساب کاربری شما غیرفعال شده است؛ برای پیگیری با مدیر سامانه تماس بگیرید.' };
  }
  // A platform admin's support session may enter a suspended workspace (to look into it).
  if (org.suspended && !opts.support && !isPlatformAdmin(user)) {
    return {
      status: 403,
      code: 'ORG_SUSPENDED',
      error: `دسترسی فضای کاری «${org.name}» موقتاً متوقف شده است${org.suspendedReason ? ` (${org.suspendedReason})` : ''}؛ با مدیر سامانه تماس بگیرید.`,
    };
  }
  return null;
}

declare global {
  namespace Express {
    interface Request {
      ctx?: AuthContext;
    }
  }
}

/** Header the web client uses; see SESSION_HEADER in src/lib/api.ts. */
export const SESSION_HEADER = 'x-hovida-session';

/**
 * The session token, from `X-Hovida-Session` (web client) or
 * `Authorization: Bearer` (scripts / API clients). The custom header wins:
 * proxies and sandbox gateways often strip or replace `Authorization`.
 */
export function sessionToken(req: express.Request): string | null {
  const custom = req.headers[SESSION_HEADER];
  const fromCustom = (Array.isArray(custom) ? custom[0] : custom)?.trim();
  if (fromCustom) return fromCustom.length <= 256 ? fromCustom : null;
  const h = req.headers.authorization;
  if (typeof h === 'string' && /^Bearer\s+/i.test(h)) {
    const t = h.replace(/^Bearer\s+/i, '').trim();
    return t && t.length <= 256 ? t : null;
  }
  return null;
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = sessionToken(req);
  if (!token) return res.status(401).json({ error: 'برای ادامه وارد حساب کاربری خود شوید.', code: 'AUTH_REQUIRED' });
  const tokenHash = hashToken(token);
  const session = db.getSession(tokenHash);
  const user = session ? db.getUser(session.userId) : null;
  const org = user ? db.getOrg(user.orgId) : null;
  if (!session || !user || !org) {
    return res.status(401).json({ error: 'نشست شما به پایان رسیده است؛ دوباره وارد شوید.', code: 'SESSION_EXPIRED' });
  }
  const blocked = accessBlock(user, org, { support: Boolean(session.support) });
  if (blocked) {
    // 401 signs the tab out; the message explains why.
    db.deleteSession(tokenHash);
    return res.status(401).json({ error: blocked.error, code: blocked.code });
  }
  db.touchSession(session, org.isDemo ? demoTtlMs() : sessionTtlMs());
  req.ctx = {
    user,
    org,
    tokenHash,
    support: session.support ? { ...session.support, expiresAt: session.expiresAt } : null,
  };
  next();
}

/**
 * Maintenance mode (/admin › تنظیمات سامانه): workspace APIs answer 503 with
 * the operator's message; platform admins keep working.
 */
export function maintenanceGate(req: express.Request, res: express.Response, next: express.NextFunction) {
  const m = systemSettings().maintenance;
  if (m.enabled && !(req.ctx && isPlatformAdmin(req.ctx.user))) {
    return res.status(503).json({ error: m.message, code: 'MAINTENANCE' });
  }
  next();
}

const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };

export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export function requireRole(min: Role) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.ctx || !hasRole(req.ctx.user.role, min)) {
      return res.status(403).json({ error: 'این کار فقط از عهده مدیر فضای کاری برمی‌آید.', code: 'FORBIDDEN' });
    }
    next();
  };
}

/** Context helper for route handlers mounted behind requireAuth. */
export function ctxOf(req: express.Request): AuthContext {
  if (!req.ctx) throw new Error('auth context missing');
  return req.ctx;
}

/**
 * Who did it — for activity feeds and decision stamps. In a support session
 * the workspace must see that HOVIDA support acted, not its owner.
 */
export function actorOf(req: express.Request): { id: string; name: string } {
  const { user, support } = ctxOf(req);
  // A distinct id also makes these events show up as unread for the owner.
  return support ? { id: `support:${support.adminId}`, name: `پشتیبانی هویدا (${support.adminName})` } : { id: user.id, name: user.name };
}

// ------------------------------------------------------------ signed URLs ----

function fileSignature(resumeId: string, exp: number, inline: boolean): string {
  return crypto
    .createHmac('sha256', appSecret())
    .update(`${resumeId}.${exp}.${inline ? 1 : 0}`)
    .digest('base64url');
}

export function signedFileUrl(resumeId: string, inline: boolean): { url: string; expiresAt: number } {
  const exp = Date.now() + FILE_URL_TTL_MS;
  const sig = fileSignature(resumeId, exp, inline);
  const qs = new URLSearchParams({ exp: String(exp), sig });
  if (inline) qs.set('inline', '1');
  return { url: `/api/files/${encodeURIComponent(resumeId)}?${qs.toString()}`, expiresAt: exp };
}

export function verifyFileSignature(resumeId: string, exp: number, inline: boolean, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + FILE_URL_TTL_MS + 60_000) return false;
  const expected = Buffer.from(fileSignature(resumeId, exp, inline));
  const given = Buffer.from(String(sig || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ------------------------------------------------------------ rate limits ----

export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}

  /** Over budget? (does not record anything) */
  check(key: string): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) return { ok: false, retryAfterSec: Math.ceil((this.windowMs - (now - list[0])) / 1000) };
    return { ok: true, retryAfterSec: 0 };
  }

  /** Records a hit; returns seconds to wait when the key is over budget. */
  hit(key: string): { ok: boolean; retryAfterSec: number } {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length >= this.max) {
      this.hits.set(key, list);
      return { ok: false, retryAfterSec: Math.ceil((this.windowMs - (now - list[0])) / 1000) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    return { ok: true, retryAfterSec: 0 };
  }

  reset(key: string) {
    this.hits.delete(key);
  }
}

/**
 * Client IP for rate limiting.
 *
 * - CLIENT_IP_HEADER: a header that a trusted edge sets to the visitor's
 *   address (Cloudflare: cf-connecting-ip). On Render — fronted by Cloudflare,
 *   which rejects spoofed values — this is the default.
 * - Otherwise X-Forwarded-For, counted from the RIGHT: the first entry is
 *   whatever the client typed (rotating it dodged the login limiter) and the
 *   last ones were appended by our own proxies. TRUST_PROXY_HOPS = proxies in
 *   front of the app (default 1; 0 = none, use the socket address).
 */
export function clientIp(req: express.Request): string {
  const header = (process.env.CLIENT_IP_HEADER ?? (process.env.RENDER ? 'cf-connecting-ip' : '')).trim().toLowerCase();
  if (header) {
    const raw = req.headers[header];
    const ip = (Array.isArray(raw) ? raw[0] : raw || '').split(',')[0].trim();
    if (ip) return ip;
  }
  const hops = Math.max(0, Math.min(5, Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10) || 0));
  const fwd = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(fwd) ? fwd.join(',') : fwd || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (hops > 0 && chain.length) return chain[Math.max(0, chain.length - hops)];
  return req.socket.remoteAddress || 'unknown';
}

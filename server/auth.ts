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
import fs from 'fs';
import path from 'path';
import type express from 'express';
import type { Role } from '../src/types/app';
import * as db from './db';

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

// --------------------------------------------------------------- secrets ----

let cachedSecret: Buffer | null = null;

/** APP_SECRET from the environment, or a random secret persisted next to the data. */
function appSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.APP_SECRET?.trim();
  if (env && env.length >= 16) {
    cachedSecret = Buffer.from(env, 'utf-8');
    return cachedSecret;
  }
  const file = path.join(db.DATA_DIR, '.app-secret');
  try {
    cachedSecret = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'hex');
    if (cachedSecret.length >= 32) return cachedSecret;
  } catch {
    /* create below */
  }
  cachedSecret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(db.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, cachedSecret.toString('hex'), { mode: 0o600 });
  } catch (err) {
    console.warn('[auth] could not persist app secret; signed links reset on restart.', err);
  }
  return cachedSecret;
}

// --------------------------------------------------------------- sessions ----

export function newSessionToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function issueSession(userId: string, ttlMs = SESSION_TTL_MS): string {
  const { token, hash } = newSessionToken();
  db.createSession(userId, hash, ttlMs);
  return token;
}

export interface AuthContext {
  user: db.UserRecord;
  org: db.OrgRecord;
  tokenHash: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: AuthContext;
    }
  }
}

function bearerToken(req: express.Request): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  return null;
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'برای ادامه وارد حساب کاربری خود شوید.', code: 'AUTH_REQUIRED' });
  const tokenHash = hashToken(token);
  const session = db.getSession(tokenHash);
  const user = session ? db.getUser(session.userId) : null;
  const org = user ? db.getOrg(user.orgId) : null;
  if (!session || !user || !org) {
    return res.status(401).json({ error: 'نشست شما به پایان رسیده است؛ دوباره وارد شوید.', code: 'SESSION_EXPIRED' });
  }
  db.touchSession(session, org.isDemo ? DEMO_TTL_MS : SESSION_TTL_MS);
  req.ctx = { user, org, tokenHash };
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

export function actorOf(req: express.Request): { id: string; name: string } {
  const { user } = ctxOf(req);
  return { id: user.id, name: user.name };
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

export function clientIp(req: express.Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd || '').split(',')[0].trim();
  return first || req.socket.remoteAddress || 'unknown';
}

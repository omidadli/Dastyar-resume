/**
 * REST API keys («کلید API»).
 *
 * A key is a bearer token that belongs to one workspace:
 *
 *     hvd_sk_<16 hex>_<43 chars>
 *
 * Only a SHA-256 hash is stored, so a stolen snapshot cannot be replayed. The
 * key id travels in the token so verification is one map lookup plus a
 * constant-time compare — no scan over every workspace's keys.
 *
 * Scopes are deliberately coarse: `read` (list jobs/candidates) and `write`
 * (also record a decision). There is no scope that can send mail or delete a
 * candidate: those stay human actions inside the app.
 */
import crypto from 'crypto';
import type express from 'express';
import type { ApiScope } from '../src/types/developer';
import * as db from './db';
import { hashToken } from './auth';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';

const TOKEN_PREFIX = 'hvd_sk_';
/** Key ids are pure hex so the token can be split on `_` without ambiguity. */
const KEY_RE = /^hvd_sk_([a-f0-9]{16})_([A-Za-z0-9_-]{32,})$/;

export const API_SCOPES: { id: ApiScope; label: string; hint: string }[] = [
  { id: 'read', label: 'فقط خواندن', hint: 'فهرست فرصت‌ها و کاندیداها را می‌خواند؛ هیچ چیزی را تغییر نمی‌دهد.' },
  { id: 'write', label: 'خواندن و ثبت تصمیم', hint: 'علاوه بر خواندن، می‌تواند تصمیم «تأیید / رد / نیاز به بررسی» ثبت کند.' },
];

export class ApiKeyError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'API_KEY_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface IssuedKey {
  token: string;
  row: db.ApiKeyRow;
}

function normalizeScopes(input: unknown): ApiScope[] {
  const list = Array.isArray(input) ? input : [];
  const out: ApiScope[] = [];
  for (const value of list) {
    if (value === 'read' || value === 'write') out.push(value);
  }
  // Any key can read; «write» implies it.
  if (!out.includes('read')) out.unshift('read');
  return Array.from(new Set(out));
}

export function createApiKey(
  orgId: string,
  actor: { id: string; name: string } | null,
  input: { name?: unknown; scopes?: unknown }
): IssuedKey {
  const name = (typeof input.name === 'string' ? input.name.trim() : '').slice(0, 60);
  if (name.length < 2) throw new ApiKeyError('یک نام کوتاه برای کلید بنویسید (مثلاً «سامانهٔ منابع انسانی»).');
  const mine = db.listApiKeys(orgId).filter((k) => !k.revokedAtISO);
  if (mine.length >= 20) throw new ApiKeyError('حداکثر ۲۰ کلید فعال برای هر فضای کاری مجاز است؛ کلید بلااستفاده را باطل کنید.', 409, 'TOO_MANY_KEYS');
  const scopes = normalizeScopes(input.scopes);
  const id = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${id}_${secret}`;
  const stamp = new Date();
  const row: db.ApiKeyRow = {
    id,
    orgId,
    name,
    prefix: `${TOKEN_PREFIX}${id}`,
    hash: hashToken(token),
    scopes,
    createdById: actor?.id ?? null,
    createdByName: actor?.name ?? null,
    createdAtISO: stamp.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    lastUsedAtISO: null,
    lastUsedAtJalali: null,
    calls: 0,
    revokedAtISO: null,
  };
  db.saveApiKey(row);
  return { token, row };
}

export function revokeApiKey(orgId: string, id: string): db.ApiKeyRow {
  const row = db.getApiKey(id);
  if (!row || row.orgId !== orgId) throw new ApiKeyError('کلید پیدا نشد.', 404, 'KEY_NOT_FOUND');
  if (row.revokedAtISO) return row;
  row.revokedAtISO = new Date().toISOString();
  db.saveApiKey(row);
  return row;
}

/** Public shape — the hash never leaves the server. */
export function publicKey(row: db.ApiKeyRow) {
  const { hash: _h, orgId: _o, createdById: _c, ...rest } = row;
  return rest;
}

export function tokenOf(req: express.Request): string | null {
  const header = req.headers.authorization;
  if (typeof header === 'string' && /^Bearer\s+/i.test(header)) {
    const token = header.replace(/^Bearer\s+/i, '').trim();
    if (token.startsWith(TOKEN_PREFIX)) return token.length <= 200 ? token : null;
  }
  const custom = req.headers['x-hovida-api-key'];
  const value = (Array.isArray(custom) ? custom[0] : custom)?.trim();
  return value && value.startsWith(TOKEN_PREFIX) && value.length <= 200 ? value : null;
}

// A workspace integration may poll; it may not hammer. 600 calls a minute per key.
const RATE_LIMIT = 600;
const RATE_WINDOW_MS = 60_000;
const rate = new Map<string, { windowStart: number; count: number }>();

function withinRateLimit(keyId: string): boolean {
  const now = Date.now();
  const entry = rate.get(keyId);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rate.set(keyId, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT;
}

export interface ApiContext {
  key: db.ApiKeyRow;
  org: db.OrgRecord;
}

declare global {
  namespace Express {
    interface Request {
      api?: ApiContext;
    }
  }
}

export function requireApiKey(minScope: ApiScope = 'read') {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const token = tokenOf(req);
    if (!token) {
      return res.status(401).json({
        error: 'کلید API را در سرآیند Authorization: Bearer … بفرستید.',
        code: 'API_KEY_REQUIRED',
      });
    }
    const match = KEY_RE.exec(token);
    const row = match ? db.getApiKey(match[1]) : null;
    if (!row) return res.status(401).json({ error: 'کلید API معتبر نیست.', code: 'API_KEY_INVALID' });
    const expected = Buffer.from(row.hash, 'hex');
    const given = Buffer.from(hashToken(token), 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return res.status(401).json({ error: 'کلید API معتبر نیست.', code: 'API_KEY_INVALID' });
    }
    if (row.revokedAtISO) {
      return res.status(401).json({ error: 'این کلید باطل شده است؛ از تنظیمات، کلید تازه بسازید.', code: 'API_KEY_REVOKED' });
    }
    const org = db.getOrg(row.orgId);
    if (!org) return res.status(401).json({ error: 'کلید API معتبر نیست.', code: 'API_KEY_INVALID' });
    if (org.suspended) {
      return res.status(403).json({ error: 'دسترسی این فضای کاری موقتاً متوقف شده است.', code: 'ORG_SUSPENDED' });
    }
    if (!withinRateLimit(row.id)) {
      res.setHeader('Retry-After', '60');
      return res.status(429).json({ error: 'تعداد درخواست‌ها بیش از حد مجاز است؛ یک دقیقه بعد دوباره تلاش کنید.', code: 'RATE_LIMITED' });
    }
    if (minScope === 'write' && !row.scopes.includes('write')) {
      return res.status(403).json({ error: 'این کلید فقط اجازهٔ خواندن دارد.', code: 'SCOPE_REQUIRED' });
    }
    // Counted on every call: the settings page must show real usage, and the
    // snapshot write itself is debounced by the store.
    db.touchApiKey(row.id, new Date().toISOString());
    req.api = { key: row, org };
    next();
  };
}

/** The context for handlers mounted behind `requireApiKey`. */
export function apiOf(req: express.Request): ApiContext {
  if (!req.api) throw new Error('api context missing');
  return req.api;
}

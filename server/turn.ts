/**
 * «رلهٔ TURN» — the one piece of a live interview that a self-hosted product
 * cannot supply by itself.
 *
 * A direct browser-to-browser call (STUN) works on most home and mobile
 * networks and fails on symmetric NAT and strict corporate firewalls. The fix
 * is a relay the two sides can both reach — and the honest position is: *you*
 * run it (coturn on your own server, or a TURN service you already pay for),
 * we read your settings and hand the browser the right ICE servers.
 *
 * Two credential shapes, because that is what coturn offers:
 *   • `static-auth-secret` → ephemeral username/password, HMAC-SHA1 over
 *     `<expiry>:<label>` with base64 output (the coturn/RFC 5766 convention).
 *     Short-lived, per call, nothing permanent in the page.
 *   • a fixed username/password → handed over as-is. Simpler, weaker: anyone who
 *     reads the page can relay through your server until you change it, and the
 *     settings card says so in those words.
 *
 * Nothing here is invented: with no settings the answer is «relay: none».
 */
import crypto from 'crypto';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import { toPersianDigits } from '../src/utils/jalali';
import type { OrgPublic } from '../src/types/app';

/** The always-available part: two public STUN servers, no account needed. */
const STUN_ONLY = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

/**
 * Deployments that run their relay outside the workspace can still hand in a
 * full ICE list with `ROOM_ICE_SERVERS` — the same JSON shape the browser takes.
 * It is a fallback for the operator, not a secret hiding place: whatever it
 * contains reaches the page, so it should hold credentials you accept exposing.
 */
function envIce(): IceServer[] | null {
  const raw = process.env.ROOM_ICE_SERVERS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed.slice(0, 4);
  } catch {
    // A malformed value must not break the call: fall through to STUN.
  }
  return null;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface TurnPublicStatus {
  configured: boolean;
  /** Human-readable server list, exactly what the browser will receive. */
  urls: string[];
  /** «secret» = ephemeral HMAC credentials, «static» = fixed user/password. */
  mode: 'secret' | 'static' | 'none';
  ttlMin: number;
  username: string | null;
  /** Never the password itself — only whether one is stored. */
  hasCredential: boolean;
  updatedAtISO: string | null;
  updatedByName: string | null;
  /** The honest sentence the settings card and the call page both show. */
  note: string;
}

function urlsOf(raw: string | undefined): string[] {
  if (!raw) return [];
  // Accept «turn:a:3478, turns:b:5349» or one per line — both are typed by hand.
  return raw
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^turns?:[^\s]+$/i.test(u))
    .slice(0, 4);
}

function raw(orgId: string) {
  return db.getOrgSecrets(orgId).turn || null;
}

export function turnStatus(orgId: string): TurnPublicStatus {
  const row = raw(orgId);
  const urls = urlsOf(row?.urls);
  const mode: TurnPublicStatus['mode'] = !row || urls.length === 0 ? 'none' : row.secretEnc ? 'secret' : 'static';
  const note =
    mode === 'none'
      ? 'رله‌ای تنظیم نشده است؛ تماس مستقیم است. روی شبکهٔ شرکتی که اتصال مستقیم را می‌بندد، ممکن است تماس برقرار نشود.'
      : mode === 'secret'
        ? `رلهٔ خودتان وصل است؛ هر تماس گذرواژهٔ موقت ${toPersianDigits(row?.ttlMin || 60)} دقیقه‌ای می‌گیرد (HMAC از کلید مشترک).`
        : 'رلهٔ خودتان با نام کاربری و گذرواژهٔ ثابت وصل است؛ برای امنیت بیشتر، کلید مشترک (static-auth-secret) را ترجیح دهید.';
  return {
    configured: mode !== 'none',
    urls,
    mode,
    ttlMin: row?.ttlMin || 60,
    // In secret mode there is no standing username to show; each call mints one.
    username: row?.usernameEnc ? (decryptSecret(row.usernameEnc) ?? null) : null,
    hasCredential: Boolean(row?.credentialEnc),
    updatedAtISO: row?.updatedAtISO || null,
    updatedByName: row?.updatedByName || null,
    note,
  };
}

/** What the browser actually receives. Ephemeral credentials never repeat. */
export function iceServersFor(orgId: string, who: 'host' | 'candidate' = 'host'): IceServer[] {
  const row = raw(orgId);
  const turnUrls = urlsOf(row?.urls);
  if (!row || turnUrls.length === 0) return envIce() || [...STUN_ONLY];

  if (row.secretEnc) {
    const secret = decryptSecret(row.secretEnc);
    if (!secret) return envIce() || [...STUN_ONLY]; // a broken key must not break the call
    const ttlSec = Math.min(Math.max(row.ttlMin || 60, 5), 1440) * 60;
    const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${who}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    // STUN first (cheaper, direct), the relay as the fallback path.
    return [...STUN_ONLY, { urls: turnUrls, username, credential }];
  }

  const username = row.usernameEnc ? decryptSecret(row.usernameEnc) : null;
  const credential = row.credentialEnc ? decryptSecret(row.credentialEnc) : null;
  if (!username || !credential) return envIce() || [...STUN_ONLY];
  return [...STUN_ONLY, { urls: turnUrls, username, credential }];
}

/** `relayNote` for the call page: what will happen, before it happens. */
export function relayNote(org: OrgPublic | null | undefined): string {
  const status = org ? turnStatus(org.id) : null;
  if (status?.configured) {
    return 'این تماس مستقیم بین دو مرورگر است (WebRTC) و تصویر و صدا روی سرور هویدا نمی‌رود؛ اگر اتصال مستقیم ممکن نباشد، از رلهٔ خودِ سازمان عبور می‌کند. هیچ ضبطی انجام نمی‌شود.';
  }
  return 'این تماس مستقیم بین دو مرورگر است (WebRTC)؛ تصویر و صدا از سرور هویدا عبور نمی‌کند و ضبط نمی‌شود. رلهٔ TURN تنظیم نشده است، پس اگر شبکهٔ سازمان شما اتصال مستقیم را ببندد، تماس برقرار نمی‌شود — در آن صورت از تماس تلفنی یا Meet استفاده کنید.';
}

export interface TurnInput {
  urls?: string;
  username?: string;
  credential?: string;
  secret?: string;
  ttlMin?: number;
}

/**
 * Saves the relay settings. Blank username/credential/secret mean «remove it»,
 * so an admin can switch from a fixed password back to a shared secret without
 * leaving the old password behind.
 */
export function saveTurn(orgId: string, input: TurnInput, actor: { id: string; name: string }): TurnPublicStatus {
  const previous = raw(orgId);
  const urls = String(input.urls || '').trim().slice(0, 500);
  const clean = urlsOf(urls);
  if (urls && clean.length === 0) {
    throw Object.assign(new Error('نشانی رله باید با turn: یا turns: شروع شود (مثلاً turn:turn.example.ir:3478).'), {
      status: 400,
      code: 'BAD_TURN_URL',
    });
  }
  if (clean.length > 4) {
    throw Object.assign(new Error('حداکثر چهار نشانی رله.'), { status: 400, code: 'TOO_MANY_TURN_URLS' });
  }
  const hasSecret = typeof input.secret === 'string' && input.secret.trim().length > 0;
  const hasUser = typeof input.username === 'string' && input.username.trim().length > 0;
  const hasCred = typeof input.credential === 'string' && input.credential.trim().length > 0;
  if (clean.length > 0 && !hasSecret && !(hasUser && hasCred)) {
    throw Object.assign(
      new Error('برای رلهٔ TURN یا «کلید مشترک» را وارد کنید یا هم نام کاربری و هم گذرواژه را.'),
      { status: 400, code: 'TURN_CREDENTIALS_REQUIRED' }
    );
  }
  const ttl = Math.min(Math.max(Number(input.ttlMin) || previous?.ttlMin || 60, 5), 1440);
  const next: NonNullable<db.OrgSecrets['turn']> = {
    urls: clean.join(','),
    secretEnc: hasSecret ? encryptSecret(input.secret!.trim()) : hasUser ? null : previous?.secretEnc ?? null,
    usernameEnc: hasUser ? encryptSecret(input.username!.trim()) : hasSecret ? null : previous?.usernameEnc ?? null,
    credentialEnc: hasCred ? encryptSecret(input.credential!.trim()) : hasSecret ? null : previous?.credentialEnc ?? null,
    ttlMin: ttl,
    updatedAtISO: new Date().toISOString(),
    updatedByName: actor.name,
  };
  if (clean.length === 0) {
    db.patchOrgSecrets(orgId, { turn: undefined });
    return turnStatus(orgId);
  }
  db.patchOrgSecrets(orgId, { turn: next });
  return turnStatus(orgId);
}

/** Removes the relay settings — the call page falls back to direct/STUN. */
export function clearTurn(orgId: string): TurnPublicStatus {
  db.patchOrgSecrets(orgId, { turn: undefined });
  return turnStatus(orgId);
}

/**
 * «وب‌هوک خروجی» — HOVIDA tells another system what just happened.
 *
 * Where the Slack/Teams bridge posts a sentence into a chat channel, this is a
 * machine-to-machine contract: a JSON body, a signed header the receiver can
 * verify, and a retry. A customer's HRIS learns about a decision or an accepted
 * offer without polling our REST API every minute.
 *
 * Rules that hold here:
 *   - the URL is a secret (it often carries its own token), so it is encrypted
 *     and the browser only sees host + masked path;
 *   - every body is signed with HMAC-SHA256 over `<timestamp>.<body>`, so a
 *     receiver can reject replays and forgeries;
 *   - a failing endpoint never breaks a hiring action — delivery is
 *     fire-and-forget and the failure is only recorded for the settings page.
 */
import crypto from 'crypto';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import { CHAT_EVENTS, allowedByEnv } from './chat-webhook';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { WebhookTestResult } from '../src/types/developer';

/**
 * The same event names the chat bridge uses, so the settings page has one
 * vocabulary: a decision is a decision whether it lands in Slack or in a HRIS.
 */
export const WEBHOOK_EVENTS = CHAT_EVENTS;

export class WebhookError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'WEBHOOK_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 2;

function originOf(url: string): { host: string; masked: string } {
  const u = new URL(url);
  const path = u.pathname === '/' ? '' : u.pathname;
  const visible = path.slice(0, 5);
  return {
    host: u.host,
    masked: `${u.origin}${visible}${path.length > visible.length ? '…' : ''}`,
  };
}

export function normalizeEvents(input: unknown, previous?: string[]): string[] {
  const list = Array.isArray(input)
    ? input.filter((e: unknown): e is string => typeof e === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(e))
    : [];
  const events = Array.from(new Set(list));
  if (events.length) return events;
  // Nothing valid sent: keep what the endpoint had, or subscribe to everything.
  if (previous?.length) return previous;
  return [...WEBHOOK_EVENTS];
}

export function prepareEndpoint(
  input: { name?: unknown; url?: unknown; events?: unknown },
  previous?: db.WebhookEndpointRow
): db.WebhookEndpointRow {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (!rawUrl && !previous) throw new WebhookError('نشانی وب‌هوک را وارد کنید.');
  if (rawUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) throw new WebhookError('نشانی وب‌هوک معتبر نیست؛ باید با https:// شروع شود.', 400, 'INVALID_URL');
    const allowed = parsed.protocol === 'https:' || allowedByEnv(rawUrl);
    if (!allowed) {
      throw new WebhookError(
        'برای امنیت، نشانی وب‌هوک باید https باشد؛ برای سرور داخلی، میزبان را در WEBHOOK_ALLOW_HOSTS اضافه کنید.',
        400,
        'INVALID_URL'
      );
    }
    if (rawUrl.length > 500) throw new WebhookError('نشانی وب‌هوک بیش از حد طولانی است.', 400, 'INVALID_URL');
  }

  const stamp = new Date();
  const origin = rawUrl ? originOf(rawUrl) : { host: previous!.urlHost, masked: previous!.urlMasked };
  const freshSecret = previous ? null : `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  const nameInput = typeof input.name === 'string' ? input.name.trim().slice(0, 60) : '';
  return {
    id: previous?.id ?? db.uid('whk'),
    orgId: previous?.orgId ?? '',
    name: nameInput || previous?.name || origin.host,
    urlEnc: rawUrl ? encryptSecret(rawUrl) : previous!.urlEnc,
    secretEnc: previous?.secretEnc ?? encryptSecret(freshSecret!),
    secretHint: previous?.secretHint ?? freshSecret!.slice(-4),
    urlHost: origin.host,
    urlMasked: origin.masked,
    events: normalizeEvents(input.events, previous?.events),
    active: previous?.active ?? true,
    createdAtISO: previous?.createdAtISO ?? stamp.toISOString(),
    createdAtJalali: previous?.createdAtJalali ?? formatJalaliDate(tehranJalaliOf(stamp), true),
    lastDeliveryAtISO: previous?.lastDeliveryAtISO ?? null,
    lastDeliveryAtJalali: previous?.lastDeliveryAtJalali ?? null,
    lastStatus: previous?.lastStatus ?? null,
    lastOk: previous?.lastOk ?? null,
    lastError: previous?.lastError ?? null,
    failures: previous?.failures ?? 0,
  };
}

/** Decrypted signing secret, or a throw when the vault key does not match. */
export function endpointSecret(row: db.WebhookEndpointRow): string {
  const secret = decryptSecret(row.secretEnc);
  if (!secret) throw new WebhookError('کلید امضای این وب‌هوک در دسترس نیست؛ آن را دوباره ثبت کنید.', 409, 'SECRET_UNAVAILABLE');
  return secret;
}

export function publicEndpoint(row: db.WebhookEndpointRow) {
  const { urlEnc: _u, secretEnc: _s, orgId: _o, ...rest } = row;
  return rest;
}

/** `t=<unix>,v1=<hmac>` — the shape most receivers already know how to check. */
export function signatureFor(secret: string, timestamp: number, body: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

interface DeliveryResult {
  ok: boolean;
  status: number | null;
  durationMs: number;
  error: string | null;
}

async function postOnce(url: string, body: string, event: string, secret: string, deliveryId: string): Promise<DeliveryResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Hovida-Webhooks/1',
        'X-Hovida-Event': event,
        'X-Hovida-Delivery': deliveryId,
        'X-Hovida-Signature': signatureFor(secret, Math.floor(started / 1000), body),
      },
      body,
      signal: controller.signal,
    });
    const text = res.ok ? '' : await res.text().catch(() => '');
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Date.now() - started,
      error: res.ok ? null : `پاسخ ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: null,
      durationMs: Date.now() - started,
      error: err?.name === 'AbortError' ? 'در زمان مقرر پاسخ نداد.' : 'ارسال به وب‌هوک ممکن نشد.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One event to one endpoint, with a single retry on network errors and 5xx. */
async function deliver(row: db.WebhookEndpointRow, event: string, payload: Record<string, unknown>): Promise<DeliveryResult> {
  let url: string;
  let secret: string;
  try {
    const decoded = decryptSecret(row.urlEnc);
    if (!decoded) throw new WebhookError('نشانی این وب‌هوک در دسترس نیست.', 409, 'URL_UNAVAILABLE');
    url = decoded;
    secret = endpointSecret(row);
  } catch {
    return { ok: false, status: null, durationMs: 0, error: 'کلید رمزنگاری این اتصال در دسترس نیست.' };
  }
  const deliveryId = db.uid('dlv');
  const body = JSON.stringify({
    id: deliveryId,
    event,
    apiVersion: 1,
    occurredAt: new Date().toISOString(),
    ...payload,
  });
  let result = await postOnce(url, body, event, secret, deliveryId);
  if (!result.ok && (result.status === null || result.status >= 500)) {
    await new Promise((r) => setTimeout(r, 400));
    result = await postOnce(url, body, event, secret, deliveryId);
  }
  const stamp = new Date();
  db.saveWebhookDelivery({
    id: deliveryId,
    orgId: row.orgId,
    endpointId: row.id,
    event,
    atISO: stamp.toISOString(),
    atJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error,
  });
  const current = db.getWebhookEndpoint(row.orgId, row.id) || row;
  db.saveWebhookEndpoint({
    ...current,
    lastDeliveryAtISO: stamp.toISOString(),
    lastDeliveryAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    lastStatus: result.status,
    lastOk: result.ok,
    lastError: result.error,
    failures: result.ok ? 0 : current.failures + 1,
  });
  return result;
}

/**
 * The bridge registered at boot. Deliberately synchronous in shape and
 * fire-and-forget in behaviour: an activity item must never wait for a network.
 */
export function deliverActivity(item: {
  orgId: string | null;
  type: string;
  text: string;
  userId?: string | null;
  userName?: string | null;
  jobId?: string | null;
  resumeId?: string | null;
  atISO?: string;
}): void {
  if (!item.orgId) return;
  const endpoints = db.listWebhookEndpoints(item.orgId).filter((w) => w.active && w.events.includes(item.type));
  if (!endpoints.length) return;
  const org = db.getOrg(item.orgId);
  const payload = {
    workspace: { id: item.orgId, name: org?.name || '' },
    actor: item.userId || item.userName ? { id: item.userId || null, name: item.userName || null } : null,
    message: item.text,
    links: { jobId: item.jobId || null, candidateId: item.resumeId || null },
  };
  for (const row of endpoints) {
    void deliver(row, item.type, payload).catch(() => {
      // Never rethrow: the hiring action already succeeded.
    });
  }
}

/** «ارسال آزمایشی» from the settings page — a real POST, and the honest result. */
export async function testEndpoint(orgId: string, id: string): Promise<WebhookTestResult> {
  const row = db.getWebhookEndpoint(orgId, id);
  if (!row) throw new WebhookError('این وب‌هوک پیدا نشد.', 404, 'ENDPOINT_NOT_FOUND');
  const org = db.getOrg(orgId);
  const result = await deliver(row, 'ping', {
    workspace: { id: orgId, name: org?.name || '' },
    actor: null,
    message: 'این یک رویداد آزمایشی است؛ هویدا وصل است ✅',
    links: { jobId: null, candidateId: null },
  });
  return { ok: result.ok, status: result.status, error: result.error };
}

/**
 * «اطلاع‌رسانی در اسلک / تیمز» — a line in the team's own channel when something
 * happens in HOVIDA (a new application, an offer accepted, an automation run).
 *
 * The URL is a secret: anyone holding it can post to the channel. It is stored
 * encrypted and never returned to the browser. A webhook that fails is logged and
 * ignored — a chat outage must never break a hiring action.
 */
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';

export type ChatProvider = 'slack' | 'teams' | 'generic';

/** The events a workspace may forward. Unknown values are dropped on save. */
export const CHAT_EVENTS = [
  'application.received',
  'decision',
  'message.sent',
  'interview.scheduled',
  'stage.moved',
  'scorecard.added',
  'offer.sent',
  'offer.accepted',
  'offer.declined',
  'automation.run',
  'automation.approved',
  'comment.added',
  'survey.sent',
  'survey.answered',
] as const;

export type ChatEvent = (typeof CHAT_EVENTS)[number];

export interface ChatStatusPublic {
  configured: boolean;
  provider: ChatProvider | null;
  host: string | null;
  events: string[];
  lastTestAtISO: string | null;
  lastTestOk: boolean | null;
  lastError: string | null;
}

export class ChatError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'CHAT_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Only real webhook hosts: an arbitrary URL would let a workspace post anywhere.
 * `WEBHOOK_ALLOW_HOSTS` is the deliberate escape hatch for self-hosted chat
 * (Mattermost, Rocket.Chat, an internal relay): a comma-separated host list that
 * may receive the posts. Nothing else is allowed.
 */
const HOSTS: Record<ChatProvider, RegExp> = {
  slack: /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}$/,
  teams: /^https:\/\/[A-Za-z0-9.-]+\.(webhook\.office\.com|logic\.azure\.com)\/[A-Za-z0-9@/._:-]{20,}$/,
  generic: /^$/,
};

export function allowedByEnv(url: string): boolean {
  const list = (process.env.WEBHOOK_ALLOW_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && list.includes(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function prepareChatWebhook(input: { provider: unknown; url?: unknown; events?: unknown }, previous?: db.OrgSecrets['chat']) {
  const provider: ChatProvider = input.provider === 'teams' ? 'teams' : input.provider === 'generic' ? 'generic' : 'slack';
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  const events = Array.isArray(input.events)
    ? input.events.filter((e: unknown): e is string => typeof e === 'string' && (CHAT_EVENTS as readonly string[]).includes(e))
    : previous?.events?.length
      ? previous.events
      : [...CHAT_EVENTS];
  if (!rawUrl && !previous?.urlEnc) throw new ChatError('نشانی وبهوک را وارد کنید.');
  if (rawUrl && !HOSTS[provider].test(rawUrl) && !allowedByEnv(rawUrl)) {
    throw new ChatError(
      provider === 'slack'
        ? 'نشانی وبهوک اسلک باید با https://hooks.slack.com/services/ شروع شود.'
        : provider === 'teams'
          ? 'نشانی وبهوک تیمز باید یک نشانی webhook.office.com یا logic.azure.com باشد.'
          : 'برای سرویس دلخواه، میزبان باید در فهرست WEBHOOK_ALLOW_HOSTS سرور باشد.',
      400,
      'INVALID_WEBHOOK'
    );
  }
  return {
    provider,
    urlEnc: rawUrl ? encryptSecret(rawUrl) : previous!.urlEnc,
    events: events.length ? events : [...CHAT_EVENTS],
    lastTestAtISO: previous?.lastTestAtISO ?? null,
    lastTestOk: previous?.lastTestOk ?? null,
    lastError: previous?.lastError ?? null,
  };
}

export function chatStatus(secrets: db.OrgSecrets): ChatStatusPublic {
  const s = secrets.chat;
  const url = s?.urlEnc ? decryptSecret(s.urlEnc) : null;
  return {
    configured: Boolean(url),
    provider: url ? s!.provider : null,
    host: url ? hostOf(url) : null,
    events: s?.events || [],
    lastTestAtISO: s?.lastTestAtISO ?? null,
    lastTestOk: s?.lastTestOk ?? null,
    lastError: s?.lastError ?? null,
  };
}

/** One POST, `{text}`-shaped — both Slack and Teams accept it. */
export async function postToChat(url: string, text: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ChatError(`وبهوک با کد ${res.status} پاسخ داد${body ? `: ${body.slice(0, 120)}` : ''}.`, 502, 'CHAT_FAILED');
    }
  } catch (err: any) {
    if (err instanceof ChatError) throw err;
    throw new ChatError(err?.name === 'AbortError' ? 'وبهوک در زمان مقرر پاسخ نداد.' : 'ارسال به وبهوک ممکن نشد.', 502, 'CHAT_FAILED');
  } finally {
    clearTimeout(timer);
  }
}

export async function testChat(orgId: string): Promise<{ ok: boolean; error: string | null }> {
  const secrets = db.getOrgSecrets(orgId);
  const url = secrets.chat?.urlEnc ? decryptSecret(secrets.chat.urlEnc) : null;
  if (!url) throw new ChatError('ابتدا نشانی وبهوک را ذخیره کنید.', 409, 'CHAT_NOT_CONFIGURED');
  const stamp = new Date().toISOString();
  try {
    await postToChat(url, 'هویدا وصل شد ✅ — این پیام آزمایشی است؛ اطلاع‌رسانی‌های استخدام از همین‌جا می‌آید.');
    db.patchOrgSecrets(orgId, { chat: { ...secrets.chat!, lastTestAtISO: stamp, lastTestOk: true, lastError: null } });
    return { ok: true, error: null };
  } catch (err: any) {
    const message = err?.message || 'ارسال آزمایشی ممکن نشد.';
    db.patchOrgSecrets(orgId, { chat: { ...secrets.chat!, lastTestAtISO: stamp, lastTestOk: false, lastError: message } });
    return { ok: false, error: message };
  }
}

/**
 * The bridge registered at boot: an activity item becomes a chat line when the
 * workspace asked for that event. Deliberately fire-and-forget.
 */
export function forwardActivity(item: { orgId: string | null; type: string; text: string; userName: string | null }) {
  if (!item.orgId) return;
  const secrets = db.getOrgSecrets(item.orgId);
  const s = secrets.chat;
  if (!s?.urlEnc) return;
  if (!s.events.includes(item.type)) return;
  const url = decryptSecret(s.urlEnc);
  if (!url) return;
  const text = `*هویدا* — ${item.text}${item.userName ? ` (${item.userName})` : ''}`;
  void postToChat(url, text).catch((err) => {
    db.patchOrgSecrets(item.orgId!, { chat: { ...s, lastTestAtISO: new Date().toISOString(), lastTestOk: false, lastError: err?.message || 'ارسال به وبهوک ممکن نشد.' } });
  });
}

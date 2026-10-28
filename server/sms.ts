/**
 * «پیامک سازمان» — sending a text to a candidate through the workspace's own
 * Iranian gateway (Kavenegar or sms.ir).
 *
 * Why a separate channel from e-mail: in Iran a large share of candidates never
 * check e-mail, so a hiring product that cannot text them is a demo, not a tool.
 * As with e-mail, the workspace brings its own account: nothing is sent from a
 * shared line, and an unconfigured gateway says so instead of pretending.
 */
import type { OrgSecrets } from './db';
import type { SmsProvider, SmsSettingsInput, SmsSettingsPublic } from '../src/types/integrations';
import { decryptSecret, encryptSecret } from './secret';

export class SmsNotConfiguredError extends Error {
  code = 'SMS_NOT_CONFIGURED';
  constructor() {
    super('پیامک سازمان هنوز متصل نشده است؛ مدیر فضای کاری می‌تواند در «تنظیمات ← اتصال‌ها» آن را وصل کند.');
  }
}

export class SmsRequestError extends Error {
  code = 'SMS_REQUEST_FAILED';
  constructor(message: string) {
    super(message);
  }
}

const KAVENEGAR_BASE = process.env.KAVENEGAR_API_BASE || 'https://api.kavenegar.com';
const SMSIR_BASE = process.env.SMSIR_API_BASE || 'https://api.sms.ir';

/** «۰۹۱۲…», «+98912…», «9121234567» → «09121234567». */
export function normalizeIranMobile(raw: unknown): string | null {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  const latin = String(raw ?? '')
    .split('')
    .map((ch) => (fa.includes(ch) ? String(fa.indexOf(ch)) : ar.includes(ch) ? String(ar.indexOf(ch)) : ch))
    .join('')
    .replace(/[^\d+]/g, '');
  let digits = latin.replace(/^\+?98/, '0');
  if (/^9\d{9}$/.test(digits)) digits = `0${digits}`;
  return /^09\d{9}$/.test(digits) ? digits : null;
}

export function isSmsConfigured(secrets: OrgSecrets): boolean {
  const s = secrets.sms;
  return Boolean(s && s.provider && s.sender && s.apiKeyEnc && decryptSecret(s.apiKeyEnc));
}

export function smsStatus(secrets: OrgSecrets): SmsSettingsPublic {
  const s = secrets.sms;
  if (!s) {
    return {
      configured: false,
      provider: null,
      sender: null,
      hasApiKey: false,
      lastTestAtISO: null,
      lastTestOk: null,
      lastError: null,
    };
  }
  return {
    configured: isSmsConfigured(secrets),
    provider: s.provider,
    sender: s.sender,
    hasApiKey: Boolean(s.apiKeyEnc),
    lastTestAtISO: s.lastTestAtISO ?? null,
    lastTestOk: s.lastTestOk ?? null,
    lastError: s.lastError ?? null,
  };
}

/** Validates what the panel sent, before anything is stored or called. */
export function prepareSmsSettings(input: SmsSettingsInput, previous: OrgSecrets['sms'] | undefined): NonNullable<OrgSecrets['sms']> {
  const provider: SmsProvider = input.provider === 'smsir' ? 'smsir' : input.provider === 'kavenegar' ? 'kavenegar' : ('' as SmsProvider);
  if (!provider) throw new SmsRequestError('سرویس پیامک را انتخاب کنید (کاوه‌نگار یا sms.ir).');
  const sender = String(input.sender || '').trim();
  if (!/^(\+?\d{3,14}|[A-Za-z0-9._-]{2,20})$/.test(sender)) {
    throw new SmsRequestError('شمارهٔ خط فرستنده معتبر نیست (مثلاً 10004346 یا 3000…).');
  }
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!key && !previous?.apiKeyEnc) throw new SmsRequestError('کلید API سرویس پیامک را وارد کنید.');
  return {
    provider,
    sender,
    apiKeyEnc: key ? encryptSecret(key) : previous!.apiKeyEnc,
    lastTestAtISO: previous?.lastTestAtISO ?? null,
    lastTestOk: previous?.lastTestOk ?? null,
    lastError: previous?.lastError ?? null,
  };
}

function describe(provider: SmsProvider, key: string): { url: string; headers: Record<string, string> } {
  return provider === 'smsir'
    ? { url: `${SMSIR_BASE}/v1/send/bulk`, headers: { 'x-api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' } }
    : {
        url: `${KAVENEGAR_BASE}/v1/${encodeURIComponent(key)}/sms/send.json`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      };
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** True when the provider answered that the account is usable. */
export async function verifySms(settings: NonNullable<OrgSecrets['sms']>): Promise<{ ok: boolean; error: string | null }> {
  const key = decryptSecret(settings.apiKeyEnc);
  if (!key) return { ok: false, error: 'کلید API ذخیره‌شده خوانا نیست؛ دوباره واردش کنید.' };
  try {
    if (settings.provider === 'smsir') {
      const res = await fetch(`${SMSIR_BASE}/v1/credit`, {
        headers: { 'x-api-key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await readJson(res);
      if (res.ok && (body?.status === 1 || body?.data !== undefined)) return { ok: true, error: null };
      return { ok: false, error: friendlySmsError(body, res.status) };
    }
    const res = await fetch(`${KAVENEGAR_BASE}/v1/${encodeURIComponent(key)}/account/info.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await readJson(res);
    if (res.ok && (body?.return?.status === 200 || body?.entries)) return { ok: true, error: null };
    return { ok: false, error: friendlySmsError(body, res.status) };
  } catch (err: any) {
    return { ok: false, error: friendlySmsError(err, 0) };
  }
}

export interface SmsSendResult {
  messageId: string | null;
}

/** Sends one message. Throws a Persian, actionable error on failure. */
export async function sendSms(
  settings: NonNullable<OrgSecrets['sms']>,
  input: { to: string; text: string }
): Promise<SmsSendResult> {
  const key = decryptSecret(settings.apiKeyEnc);
  if (!key) throw new SmsNotConfiguredError();
  const to = normalizeIranMobile(input.to);
  if (!to) throw new SmsRequestError('شمارهٔ موبایل گیرنده معتبر نیست (نمونه: ۰۹۱۲۱۲۳۴۵۶۷).');
  const text = String(input.text || '').trim().slice(0, 900);
  if (!text) throw new SmsRequestError('متن پیامک خالی است.');
  const { url, headers } = describe(settings.provider, key);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body:
        settings.provider === 'smsir'
          ? JSON.stringify({ lineNumber: settings.sender, messageText: text, mobiles: [to] })
          : new URLSearchParams({ receptor: to, sender: settings.sender, message: text }).toString(),
      signal: AbortSignal.timeout(25_000),
    });
    const body = await readJson(res);
    if (!res.ok) throw new SmsRequestError(friendlySmsError(body, res.status));
    if (settings.provider === 'smsir') {
      if (body?.status !== 1) throw new SmsRequestError(friendlySmsError(body, res.status));
      return { messageId: String(body?.data?.packId ?? body?.data?.messageIds?.[0] ?? '') || null };
    }
    if (body?.return?.status !== 200) throw new SmsRequestError(friendlySmsError(body, res.status));
    return { messageId: String(body?.entries?.[0]?.messageid ?? '') || null };
  } catch (err: any) {
    if (err instanceof SmsRequestError) throw err;
    throw new SmsRequestError(friendlySmsError(err, 0));
  }
}

/** Turns provider errors into a sentence a recruiter can act on. */
export function friendlySmsError(err: any, status: number): string {
  const message = String(err?.message ?? err?.return?.message ?? err?.statusText ?? '').trim();
  const text = `${status} ${message} ${JSON.stringify(err ?? '').slice(0, 200)}`;
  if (/401|403|invalid api|apikey|کلید|unauthor/i.test(text)) return 'کلید API سرویس پیامک پذیرفته نشد؛ کلید را از پنل سرویس دوباره بگیرید.';
  if (/credit|اعتبار|موجودی|insufficient/i.test(text)) return 'اعتبار پنل پیامک کافی نیست؛ حساب سرویس پیامک را شارژ کنید.';
  if (/line|sender|خط/i.test(text)) return 'خط فرستنده در سرویس پیامک تأیید نشده است؛ شمارهٔ خط را در پنل سرویس بررسی کنید.';
  if (/402/i.test(text)) return 'سرویس پیامک درخواست را رد کرد (۴۰۲)؛ متن یا شمارهٔ گیرنده را بررسی کنید.';
  if (/timeout|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(text)) return 'ارتباط با سرویس پیامک برقرار نشد؛ شبکهٔ میزبان را بررسی کنید.';
  return message || 'ارسال پیامک ممکن نشد.';
}

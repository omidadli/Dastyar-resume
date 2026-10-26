/**
 * «ایمیل سازمان» — send candidate messages from the workspace's own mailbox.
 *
 * Every tenant stores its own SMTP connection (host, port, user, password —
 * the password encrypted with APP_SECRET). Nothing is ever sent implicitly:
 * the recruiter presses «ارسال با ایمیل سازمان» on a drafted message.
 *
 * Works with Gmail/Workspace (app password), Outlook/Microsoft 365 (SMTP AUTH),
 * Zoho, Yandex, or the company's own mail server. The settings page explains
 * the needed values; a failed test shows the server's own error message instead
 * of a generic «خطا».
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { EmailSettingsPublic } from '../src/types/integrations';
import type { OrgSecrets } from './db';
import { decryptSecret, encryptSecret } from './secret';

export interface EmailSettingsInput {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  /** Omitted/empty on edit means «keep the stored password». */
  password?: string;
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class EmailNotConfiguredError extends Error {
  code = 'EMAIL_NOT_CONFIGURED';
  constructor() {
    super('ایمیل سازمان هنوز متصل نشده است؛ مدیر فضای کاری می‌تواند در «تنظیمات ← اتصال‌ها» آن را وصل کند.');
  }
}

export function isEmailConfigured(secrets: OrgSecrets): boolean {
  const e = secrets.email;
  return Boolean(e && e.host && e.username && e.passwordEnc && e.fromAddress && decryptSecret(e.passwordEnc));
}

export function emailStatus(secrets: OrgSecrets): EmailSettingsPublic {
  const e = secrets.email;
  if (!e) {
    return {
      configured: false,
      host: null,
      port: null,
      secure: true,
      username: null,
      fromName: '',
      fromAddress: null,
      replyTo: null,
      hasPassword: false,
      lastTestAtISO: null,
      lastTestOk: null,
      lastError: null,
    };
  }
  return {
    configured: isEmailConfigured(secrets),
    host: e.host,
    port: e.port,
    secure: e.secure,
    username: e.username,
    fromName: e.fromName,
    fromAddress: e.fromAddress,
    replyTo: e.replyTo,
    hasPassword: Boolean(e.passwordEnc && decryptSecret(e.passwordEnc)),
    lastTestAtISO: e.lastTestAtISO,
    lastTestOk: e.lastTestOk,
    lastError: e.lastError,
  };
}

/** Validates and encrypts the submitted settings (password stays optional on edit). */
export function prepareEmailSettings(input: EmailSettingsInput, previous: OrgSecrets['email'] | undefined): NonNullable<OrgSecrets['email']> {
  const host = String(input.host || '').trim().toLowerCase();
  const username = String(input.username || '').trim();
  const fromAddress = String(input.fromAddress || '').trim().toLowerCase();
  const fromName = String(input.fromName || '').trim().slice(0, 80);
  const replyToRaw = String(input.replyTo || '').trim().toLowerCase();
  const port = Number(input.port) || (input.secure ? 465 : 587);

  // Domain names, single-label intranet hosts and IP addresses are all valid.
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) || host.includes('..')) {
    throw new Error('آدرس سرور ایمیل معتبر نیست (مثال: smtp.gmail.com یا 192.168.1.10).');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('شمارهٔ پورت باید بین ۱ و ۶۵۵۳۵ باشد.');
  if (!username) throw new Error('نام کاربری ایمیل الزامی است.');
  if (!EMAIL_RE.test(fromAddress)) throw new Error('نشانی فرستنده معتبر نیست.');
  if (replyToRaw && !EMAIL_RE.test(replyToRaw)) throw new Error('نشانی «پاسخ به» معتبر نیست.');

  const password = typeof input.password === 'string' ? input.password.trim() : '';
  const passwordEnc = password ? encryptSecret(password) : previous?.passwordEnc || '';
  if (!passwordEnc) throw new Error('رمز عبور (یا App Password) ایمیل الزامی است.');

  return {
    host,
    port,
    secure: Boolean(input.secure),
    username,
    passwordEnc,
    fromName: fromName || 'واحد منابع انسانی',
    fromAddress,
    replyTo: replyToRaw || null,
    lastTestAtISO: previous?.lastTestAtISO ?? null,
    lastTestOk: previous?.lastTestOk ?? null,
    lastError: previous?.lastError ?? null,
  };
}

interface CachedTransport {
  key: string;
  transporter: Transporter;
}

const transports = new Map<string, CachedTransport>();

function transportFor(settings: NonNullable<OrgSecrets['email']>): Transporter {
  const password = decryptSecret(settings.passwordEnc);
  if (!password) throw new Error('رمز ذخیره‌شدهٔ ایمیل خوانده نشد (کلید رمزنگاری سرور تغییر کرده است)؛ آن را دوباره وارد کنید.');
  const key = [settings.host, settings.port, settings.secure, settings.username, password].join('\u0000');
  const hit = transports.get(key);
  if (hit) return hit.transporter;
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.username, pass: password },
    // A hung mail server must not hold the request: fail fast and say so.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 25_000,
    ...(settings.port === 587 && !settings.secure ? { requireTLS: true } : {}),
  });
  // Keep only the newest connection for a workspace's settings.
  for (const [k] of transports) if (k.split('\u0000').slice(0, 4).join() === [settings.host, settings.port, settings.secure, settings.username].join()) transports.delete(k);
  transports.set(key, { key, transporter });
  return transporter;
}

function plainToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<!doctype html><html dir="rtl" lang="fa"><body style="margin:0;padding:24px;background:#f7f8f9;font-family:Tahoma,'Segoe UI',sans-serif"><div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e6e8eb;border-radius:12px;padding:28px 26px;color:#1d2329;font-size:14px;line-height:2;white-space:pre-wrap">${escaped.replace(/\n/g, '<br>')}</div></body></html>`;
}

/** Header-injection guard: a newline in the subject could add recipients. */
export function cleanSubject(subject: string): string {
  return String(subject || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

export async function verifyEmail(settings: NonNullable<OrgSecrets['email']>): Promise<{ ok: boolean; error: string | null }> {
  try {
    await transportFor(settings).verify();
    return { ok: true, error: null };
  } catch (err: any) {
    return { ok: false, error: friendlySmtpError(err) };
  }
}

export interface SendResult {
  messageId: string;
  accepted: string[];
}

export async function sendMail(
  settings: NonNullable<OrgSecrets['email']>,
  message: { to: string; subject: string; text: string; attachments?: Array<{ filename: string; content: Buffer | string; contentType?: string }> }
): Promise<SendResult> {
  const to = String(message.to || '').trim().toLowerCase();
  if (!EMAIL_RE.test(to)) throw new Error('نشانی ایمیل گیرنده معتبر نیست.');
  const subject = cleanSubject(message.subject);
  if (!subject) throw new Error('موضوع ایمیل خالی است.');
  const text = String(message.text || '').slice(0, 20_000);
  if (!text.trim()) throw new Error('متن ایمیل خالی است.');

  const from = settings.fromName ? `"${settings.fromName.replace(/"/g, '')}" <${settings.fromAddress}>` : settings.fromAddress;
  const info = await transportFor(settings).sendMail({
    from,
    to,
    replyTo: settings.replyTo || undefined,
    subject,
    text,
    html: plainToHtml(text),
    attachments: message.attachments,
  });
  return { messageId: String(info.messageId || ''), accepted: (info.accepted || []).map(String) };
}

/** Turns nodemailer/SMTP codes into Persian guidance a recruiter can act on. */
export function friendlySmtpError(err: any): string {
  const raw = String(err?.message || err || '').trim();
  const code = String(err?.code || '');
  const response = String(err?.response || '');
  const both = `${code} ${response} ${raw}`;
  if (/EAUTH|535|Invalid login|Username and Password not accepted|authentication failed/i.test(both)) {
    return 'سرور ایمیل نام کاربری/رمز را نپذیرفت. برای Gmail یا Outlook باید «App Password» بسازید و احراز هویت دومرحله‌ای فعال باشد.';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(both)) return 'آدرس سرور ایمیل پیدا نشد؛ نام سرور (مثل smtp.gmail.com) را بررسی کنید.';
  if (/ECONNREFUSED|ETIMEDOUT|ESOCKET|timeout/i.test(both)) return 'اتصال به سرور ایمیل برقرار نشد؛ پورت و دسترسی شبکه (فایروال میزبان) را بررسی کنید.';
  if (/ETLS|certificate|SSL/i.test(both)) return 'اتصال امن (TLS) برقرار نشد؛ گزینهٔ «اتصال امن» و پورت را بررسی کنید (۴۶۵ امن، ۵۸۷ با STARTTLS).';
  if (/550|551|553|Sender address rejected|not owned by user/i.test(both)) return 'سرور ایمیل نشانی فرستنده را قبول نکرد؛ «نشانی فرستنده» باید همان حساب کاربری یا دامنهٔ تأییدشده باشد.';
  return raw || 'ارسال ایمیل ممکن نشد.';
}

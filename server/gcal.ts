/**
 * Google Calendar — «جلسهٔ مصاحبه» scheduled from inside HOVIDA.
 *
 * The deployment holds one OAuth client (GOOGLE_CLIENT_ID/SECRET); every
 * workspace connects its own Google account, so the event is created on the
 * calendar the recruiter actually uses and Google itself sends the invitation
 * to the candidate (`sendUpdates=all`).
 *
 * Only two REST calls are needed, so the Google SDK is deliberately not a
 * dependency. Scopes: calendar.events (create/update one event) + openid/email
 * (to show which account is connected).
 */
import crypto from 'crypto';
import type { CalendarStatusPublic, InterviewRecord } from '../src/types/integrations';
import type { OrgSecrets } from './db';
import { deriveKey } from './secret';
import { googleOAuthConnection } from './platform';

/**
 * Google endpoints. They are constants in production and overridable through
 * the environment only so the whole OAuth + event flow can be exercised against
 * a local stand-in (scripts/mock-google.mjs) — a deployment never sets these.
 */
function endpoint(envName: string, fallback: string): string {
  return (process.env[envName] || '').trim() || fallback;
}
const AUTH_URL = () => endpoint('GOOGLE_OAUTH_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth');
const TOKEN_URL = () => endpoint('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token');
const USERINFO_URL = () => endpoint('GOOGLE_USERINFO_URL', 'https://www.googleapis.com/oauth2/v3/userinfo');
const EVENTS_URL = () => endpoint('GOOGLE_CALENDAR_API_BASE', 'https://www.googleapis.com/calendar/v3') + '/calendars';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
];

/**
 * The OAuth client is saved in /admin › «اتصال‌ها» (or comes from
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the server).
 */

export const CALENDAR_TIMEZONE = 'Asia/Tehran';

export function googleClient(): { clientId: string; clientSecret: string } | null {
  const conn = googleOAuthConnection();
  return conn ? { clientId: conn.clientId, clientSecret: conn.clientSecret } : null;
}

export function calendarCalendarId(): string {
  return googleOAuthConnection()?.calendarId || 'primary';
}

/** The exact redirect URI to paste into the Google Cloud console. */
export function redirectUriFor(origin: string): string {
  const fixed = googleOAuthConnection()?.redirectUri || '';
  if (fixed) return fixed;
  return `${origin.replace(/\/$/, '')}/api/integrations/calendar/callback`;
}

export class CalendarError extends Error {
  code: string;
  constructor(message: string, code = 'CALENDAR_ERROR') {
    super(message);
    this.code = code;
  }
}

/**
 * Checks the OAuth client itself (not a workspace's connection): Google's token
 * endpoint answers `invalid_grant` for a real client and `invalid_client` for a
 * wrong id/secret — no user interaction and no data is touched.
 * `ok: null` means the check could not be made (this server has no route to
 * Google), which is reported honestly rather than as a success or a failure.
 */
export async function verifyGoogleClient(
  clientId: string,
  clientSecret: string,
  redirectUri: string
): Promise<{ ok: boolean | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(TOKEN_URL(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'hovida-connectivity-probe',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
      signal: controller.signal,
    });
    const json: any = await res.json().catch(() => ({}));
    const code = String(json?.error || '');
    if (code === 'invalid_grant' || (res.ok && code !== 'invalid_client')) {
      return { ok: true, error: null };
    }
    if (code === 'invalid_client' || res.status === 401) {
      return {
        ok: false,
        error: 'گوگل این Client ID/Secret را نپذیرفت؛ مقدارها را از همان OAuth Client در Google Cloud بردارید و دوباره ذخیره کنید.',
      };
    }
    return { ok: false, error: `گوگل پاسخ ${res.status} داد${code ? ` (${code})` : ''}.` };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: null, error: 'گوگل در ۱۲ ثانیه پاسخ نداد؛ اتصال سرور به اینترنت را بررسی کنید.' };
    return { ok: null, error: `بررسی آنلاین ممکن نشد (${err?.message || 'خطای شبکه'}); ذخیره شد و در اولین اتصال حساب مشخص می‌شود.` };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- state ----

/**
 * OAuth `state` is signed and short-lived: it carries the workspace and the
 * user who started the flow, so the callback can never attach a Google account
 * to the wrong tenant.
 */
export interface OAuthState {
  orgId: string;
  userId: string;
  redirectUri: string;
  exp: number;
}

export function signState(state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', deriveKey('oauth-state')).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyState(raw: string, now = Date.now()): OAuthState | null {
  const [payload, sig] = String(raw || '').split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', deriveKey('oauth-state')).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as OAuthState;
    if (!parsed.orgId || !parsed.userId || !parsed.exp || parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function authUrl(input: { redirectUri: string; state: string }): string {
  const client = googleClient();
  if (!client) throw new CalendarError('اتصال Google Calendar در این نصب تنظیم نشده است.', 'CALENDAR_NOT_CONFIGURED');
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Without prompt=consent Google skips the refresh token on re-connect.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: input.state,
  });
  return `${AUTH_URL()}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const reason = json?.error_description || json?.error || `پاسخ ${res.status}`;
    throw new CalendarError(`Google دسترسی را نداد: ${reason}`, 'CALENDAR_OAUTH_FAILED');
  }
  return json as TokenResponse;
}

export async function exchangeCode(code: string, redirectUri: string) {
  const client = googleClient();
  if (!client) throw new CalendarError('اتصال Google Calendar در این نصب تنظیم نشده است.', 'CALENDAR_NOT_CONFIGURED');
  const tokens = await tokenRequest({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (!tokens.refresh_token) {
    throw new CalendarError(
      'گوگل توکن ماندگار نداد؛ اتصال را از حساب گوگل حذف کنید (myaccount.google.com/permissions) و دوباره امتحان کنید.',
      'CALENDAR_NO_REFRESH_TOKEN'
    );
  }
  const email = await userEmail(tokens.access_token).catch(() => null);
  return { tokens, email };
}

async function userEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(USERINFO_URL(), { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const json: any = await res.json().catch(() => null);
  return typeof json?.email === 'string' ? json.email : null;
}

/** Silent refresh: access tokens live one hour. */
export async function accessTokenFor(secrets: OrgSecrets, decrypt: (v: string) => string | null, encrypt: (v: string) => string): Promise<string> {
  const cal = secrets.calendar;
  if (!cal) throw new CalendarError('حساب گوگل برای این فضای کاری وصل نیست.', 'CALENDAR_NOT_CONNECTED');
  if (cal.accessTokenEnc && cal.expiresAt > Date.now() + 60_000) {
    const token = decrypt(cal.accessTokenEnc);
    if (token) return token;
  }
  const refreshToken = decrypt(cal.refreshTokenEnc);
  if (!refreshToken) {
    throw new CalendarError('دسترسی گوگل منقضی شده است؛ دوباره وصل کنید.', 'CALENDAR_RECONNECT');
  }
  const client = googleClient();
  if (!client) throw new CalendarError('اتصال Google Calendar در این نصب تنظیم نشده است.', 'CALENDAR_NOT_CONFIGURED');
  const tokens = await tokenRequest({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  cal.accessTokenEnc = encrypt(tokens.access_token);
  cal.expiresAt = Date.now() + Math.max(60, tokens.expires_in - 120) * 1000;
  return tokens.access_token;
}

export interface CalendarEventInput {
  title: string;
  description: string;
  startsAtISO: string;
  durationMin: number;
  attendeeEmails: string[];
  location?: string;
  /** Create a Google Meet link. */
  withMeet: boolean;
}

export interface CalendarEventResult {
  id: string;
  htmlLink: string | null;
  meetLink: string | null;
}

export async function createEvent(accessToken: string, calendarId: string, input: CalendarEventInput): Promise<CalendarEventResult> {
  const start = new Date(input.startsAtISO);
  const end = new Date(start.getTime() + Math.max(15, input.durationMin) * 60_000);
  const body: any = {
    summary: input.title.slice(0, 250),
    description: input.description.slice(0, 4000),
    start: { dateTime: start.toISOString(), timeZone: CALENDAR_TIMEZONE },
    end: { dateTime: end.toISOString(), timeZone: CALENDAR_TIMEZONE },
    attendees: Array.from(new Set(input.attendeeEmails.filter(Boolean))).slice(0, 20).map((email) => ({ email })),
    reminders: { useDefault: true },
    ...(input.location ? { location: input.location.slice(0, 300) } : {}),
    ...(input.withMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: `hovida-${crypto.randomBytes(8).toString('hex')}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  };
  const url = `${EVENTS_URL()}/${encodeURIComponent(calendarId)}/events?sendUpdates=all&conferenceDataVersion=1`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = json?.error?.message || `پاسخ ${res.status}`;
    throw new CalendarError(`ثبت رویداد در Google Calendar انجام نشد: ${reason}`, 'CALENDAR_EVENT_FAILED');
  }
  const meetLink =
    json?.hangoutLink ||
    (Array.isArray(json?.conferenceData?.entryPoints)
      ? json.conferenceData.entryPoints.find((e: any) => e?.entryPointType === 'video')?.uri || null
      : null);
  return { id: String(json?.id || ''), htmlLink: json?.htmlLink || null, meetLink: meetLink || null };
}

export async function deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
  const res = await fetch(`${EVENTS_URL()}/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 410 = already deleted in Google; nothing left to do.
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    throw new CalendarError(`حذف رویداد از Google Calendar انجام نشد (${res.status}).`, 'CALENDAR_DELETE_FAILED');
  }
}

export function calendarStatus(secrets: OrgSecrets, redirectUri: string | null): CalendarStatusPublic {
  const cal = secrets.calendar;
  return {
    configured: Boolean(googleClient()),
    connected: Boolean(cal?.refreshTokenEnc),
    accountEmail: cal?.accountEmail ?? null,
    connectedAtISO: cal?.connectedAtISO ?? null,
    calendarId: cal?.calendarId || calendarCalendarId(),
    redirectUri,
    error: null,
  };
}

// --------------------------------------------------------------------- ICS ----

const icsDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Wall-clock stamp for a TZID-qualified property (Tehran is a fixed +03:30). */
function icsTehran(d: Date): string {
  const shifted = new Date(d.getTime() + (3 * 60 + 30) * 60_000);
  return shifted.toISOString().slice(0, 19).replace(/[-:]/g, '');
}

function icsEscape(text: string): string {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * A plain .ics file for the candidate/organizer when Google Calendar is not
 * connected (also attached to the invitation e-mail). Every mail client and
 * calendar app understands it.
 */
export function buildInviteIcs(input: {
  interview: Pick<InterviewRecord, 'id' | 'title' | 'notes' | 'startsAtISO' | 'durationMin' | 'location' | 'candidateName' | 'jobTitle'>;
  organizer: { name: string; email: string };
  attendeeEmails: string[];
}): string {
  const start = new Date(input.interview.startsAtISO);
  const end = new Date(start.getTime() + Math.max(15, input.interview.durationMin) * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//HOVIDA//Interview//FA',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${input.interview.id}@hovida`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART;TZID=${CALENDAR_TIMEZONE}:${icsTehran(start)}`,
    `DTEND;TZID=${CALENDAR_TIMEZONE}:${icsTehran(end)}`,
    `SUMMARY:${icsEscape(input.interview.title)}`,
    `DESCRIPTION:${icsEscape(input.interview.notes || input.interview.jobTitle)}`,
    `LOCATION:${icsEscape(input.interview.location || '')}`,
    `ORGANIZER;CN=${icsEscape(input.organizer.name)}:mailto:${input.organizer.email}`,
    ...input.attendeeEmails.filter(Boolean).map((email) => `ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${email}`),
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

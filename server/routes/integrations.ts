/**
 * Connections to the outside world:
 *   • /sourcing/*        — LinkedIn-compatible talent search (see server/linkedin.ts)
 *   • /integrations/email — the workspace's own mailbox (SMTP)
 *   • /integrations/calendar + /interviews — Google Calendar invitations
 *
 * Rules that hold everywhere in this file:
 *   - credentials are per workspace, encrypted, and never returned;
 *   - a connection that is not set up says so (no simulated success);
 *   - sending/billing side effects happen only on an explicit user action.
 */
import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, requireRole } from '../auth';
import { blindOn, blockedByBlind, knownNames, maskText } from '../blind';
import { h, str } from './util';
import { evaluateResume } from '../ai/screening';
import { EmailNotConfiguredError, emailStatus, friendlySmtpError, isEmailConfigured, prepareEmailSettings, sendMail, verifyEmail } from '../mailer';
import {
  LINKEDIN_DOC_PATH,
  apifyCostLine,
  SourcingNotConfiguredError,
  SourcingRequestError,
  pollApifySearch,
  profileToResumeText,
  sourcingStatus,
  startSearch,
} from '../linkedin';
import { EMAIL_HOURLY_LIMIT, noteEmailSend, withinEmailLimit } from '../email-rate';
import { friendlySmsError, isSmsConfigured, normalizeIranMobile, prepareSmsSettings, sendSms, smsStatus, verifySms } from '../sms';
import { CHAT_EVENTS, ChatError, chatStatus, prepareChatWebhook, testChat } from '../chat-webhook';
import { buildSearchBrief } from '../sourcing';
import { bookInterview, InterviewInputError } from '../interviews';
import { reminderHours, remindersEnabled, sendInterviewReminders } from '../reminders';
import { sourcingConnection } from '../platform';
import { csvSummary, profilesFromCsv } from '../csv-import';
import {
  CalendarError,
  accessTokenFor,
  authUrl,
  buildInviteIcs,
  calendarStatus,
  createEvent,
  deleteEvent,
  exchangeCode,
  googleClient,
  redirectUriFor,
  signState,
  verifyState,
} from '../gcal';
import { decryptSecret, encryptSecret } from '../secret';
import { formatJalaliDate, toPersianDigits } from '../../src/utils/jalali';
import { TEHRAN_OFFSET_MINUTES, tehranIsoFromJalali, tehranJalaliOf, tehranNow } from '../tehran-time';
import type { SourcingBrief, SourcingProfile } from '../../src/types/integrations';

const MAX_RESULTS = 50;

/**
 * «مصرف امروز» — how many provider searches ran since Tehran midnight, against
 * the cap saved with the connection. CSV imports never count: they cost nothing.
 */
function sourcingUsage(): { today: number; dailyLimit: number; remaining: number | null } {
  const conn = sourcingConnection();
  // Tehran midnight as a real instant (the host may run in any timezone).
  const wall = tehranNow().date;
  const midnight = new Date(
    Date.UTC(wall.getFullYear(), wall.getMonth(), wall.getDate()) - TEHRAN_OFFSET_MINUTES * 60_000
  );
  const today = db.countSearchesSince(midnight.toISOString());
  const limit = conn?.dailyLimit ?? 0;
  return { today, dailyLimit: limit, remaining: limit > 0 ? Math.max(0, limit - today) : null };
}

function originOf(req: express.Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function publicSearch(row: db.SourcingSearchRecord): Omit<db.SourcingSearchRecord, 'orgId'> {
  const { providerJob: _job, ...rest } = db.withoutOrg(row);
  return rest as Omit<db.SourcingSearchRecord, 'orgId'>;
}

/** «۸ پروفایل پیدا شد» — one phrasing for both provider kinds. */
function emptySearchMessage(): string {
  return 'هیچ پروفایلی با این شرایط پیدا نشد؛ شرایط را کمی بازتر کنید (مثلاً شهر یا یک مهارت را بردارید).';
}

function publicInterview(row: db.InterviewRecordRow) {
  const { orgId: _o, ...rest } = row;
  return rest;
}

function emailSettingsOrThrow(orgId: string) {
  const secrets = db.getOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) throw new EmailNotConfiguredError();
  return secrets.email!;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function candidateEmailOf(rec: { contact?: { email?: string | null } | null }): string | null {
  const email = rec.contact?.email?.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}

// ------------------------------------------------------------ public (OAuth) ----

/** Mounted WITHOUT requireAuth: Google redirects the browser here. */
export function integrationPublicRoutes(): express.Router {
  const r = express.Router();

  r.get(
    '/integrations/calendar/callback',
    h(async (req, res) => {
      const state = verifyState(str(req.query.state, 2000));
      const fail = (message: string) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(400).send(calendarResultPage(false, message, '/app/settings/integrations'));
      };
      if (!state) return fail('این پیوند اتصال منقضی یا نامعتبر است؛ از «تنظیمات ← اتصال‌ها» دوباره تلاش کنید.');
      if (str(req.query.error, 200)) {
        return fail('اجازهٔ دسترسی به Google Calendar داده نشد.');
      }
      const code = str(req.query.code, 2000);
      if (!code) return fail('کد دسترسی از گوگل دریافت نشد.');
      if (!db.getOrg(state.orgId)) return fail('این فضای کاری دیگر وجود ندارد.');

      try {
        const { tokens, email } = await exchangeCode(code, state.redirectUri);
        const previous = db.getOrgSecrets(state.orgId).calendar;
        db.patchOrgSecrets(state.orgId, {
          calendar: {
            accountEmail: email || previous?.accountEmail || 'حساب گوگل',
            refreshTokenEnc: encryptSecret(tokens.refresh_token!),
            accessTokenEnc: encryptSecret(tokens.access_token),
            expiresAt: Date.now() + Math.max(60, tokens.expires_in - 120) * 1000,
            calendarId: (process.env.GOOGLE_CALENDAR_ID || 'primary').trim() || 'primary',
            connectedAtISO: new Date().toISOString(),
            connectedByName: db.getUser(state.userId)?.name ?? null,
          },
        });
        const actor = db.getUser(state.userId);
        db.logActivity(state.orgId, actor ? { id: actor.id, name: actor.name } : null, 'settings.changed', 'Google Calendar را به فضای کاری متصل کرد');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(calendarResultPage(true, `حساب ${email || 'گوگل'} وصل شد. از این پس مصاحبه‌ها در تقویم شما ثبت و برای کارجو ارسال می‌شوند.`, '/app/settings/integrations'));
      } catch (err: any) {
        const message = err instanceof CalendarError ? err.message : 'اتصال به Google Calendar انجام نشد.';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(502).send(calendarResultPage(false, message, '/app/settings/integrations'));
      }
    })
  );

  return r;
}

/** Small self-contained result page (the SPA is not loaded in this tab). */
function calendarResultPage(ok: boolean, message: string, backTo: string): string {
  const color = ok ? '#127a51' : '#b42318';
  return `<!doctype html><html dir="rtl" lang="fa"><head><meta charset="utf-8"><title>${ok ? 'اتصال انجام شد' : 'اتصال انجام نشد'}</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f7f8;font-family:Tahoma,sans-serif">
<div style="max-width:460px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px;text-align:center">
<p style="margin:0 0 8px;font-weight:800;font-size:17px;color:${color}">${ok ? 'Google Calendar وصل شد' : 'اتصال انجام نشد'}</p>
<p style="margin:0;color:#374151;font-size:14px;line-height:1.9">${message.replace(/[<>&]/g, '')}</p>
<p style="margin:20px 0 0"><a href="${backTo}" style="display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:9px;font-size:13px">بازگشت به هویدا</a></p>
</div></body></html>`;
}

// -------------------------------------------------------------- authenticated ----

export function integrationRoutes(): express.Router {
  const r = express.Router();

  // ---- status of everything (one call for the settings page) ----
  r.get('/integrations/status', (req, res) => {
    const { org } = ctxOf(req);
    const secrets = db.getOrgSecrets(org.id);
    res.json({
      sourcing: { ...sourcingStatus(), usage: sourcingUsage() },
      email: emailStatus(secrets),
      sms: smsStatus(secrets),
      chat: chatStatus(secrets),
      calendar: {
        ...calendarStatus(secrets, redirectUriFor(originOf(req))),
        configured: Boolean(googleClient()),
        ownerEmail: org.name,
      },
    });
  });

  // ---------------------------------------------------------------- email ----

  // -------------------------------------------------- «پیامک سازمان» ----
  // In Iran e-mail alone loses candidates: the workspace brings its own gateway
  // (Kavenegar / sms.ir) and HOVIDA only ever sends from that line.
  r.put(
    '/integrations/sms',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const previous = db.getOrgSecrets(org.id).sms;
      let prepared;
      try {
        prepared = prepareSmsSettings(
          {
            provider: (str(req.body?.provider, 20) || 'kavenegar') as any,
            apiKey: typeof req.body?.apiKey === 'string' ? req.body.apiKey : '',
            sender: str(req.body?.sender, 40),
          },
          previous
        );
      } catch (err: any) {
        return res.status(400).json({ error: err?.message || 'تنظیمات پیامک معتبر نیست.' });
      }
      const check = await verifySms(prepared);
      prepared.lastTestAtISO = new Date().toISOString();
      prepared.lastTestOk = check.ok;
      prepared.lastError = check.error;
      if (!check.ok) {
        return res.status(400).json({ error: `سرویس پیامک تأیید نشد: ${check.error}` });
      }
      db.patchOrgSecrets(org.id, { sms: prepared });
      db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'پیامک سازمان را متصل کرد');
      res.json({ sms: smsStatus(db.getOrgSecrets(org.id)) });
    })
  );

  r.delete('/integrations/sms', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    db.patchOrgSecrets(org.id, { sms: undefined });
    db.logActivity(org.id, actorOf(req), 'settings.changed', 'اتصال پیامک سازمان را قطع کرد');
    res.json({ sms: smsStatus(db.getOrgSecrets(org.id)) });
  });

  r.post(
    '/integrations/sms/test',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const settings = db.getOrgSecrets(org.id).sms;
      if (!settings) return res.status(409).json({ error: 'پیامک سازمان هنوز متصل نشده است.', code: 'SMS_NOT_CONFIGURED' });
      const check = await verifySms(settings);
      db.patchOrgSecrets(org.id, {
        sms: { ...settings, lastTestAtISO: new Date().toISOString(), lastTestOk: check.ok, lastError: check.error },
      });
      res.json({ ok: check.ok, error: check.error });
    })
  );

  /** Sends one text from the candidate panel (or a free recipient). */
  r.post(
    '/integrations/sms/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      // A text to a hidden candidate is still contact: wait for the reveal.
      if (str(req.body?.resumeId, 80) && blockedByBlind(org, res)) return;
      const settings = db.getOrgSecrets(org.id).sms;
      if (!settings || !isSmsConfigured(db.getOrgSecrets(org.id))) {
        return res.status(409).json({
          error: 'پیامک سازمان متصل نیست؛ در «تنظیمات ← اتصال‌ها» سرویس پیامک را وصل کنید.',
          code: 'SMS_NOT_CONFIGURED',
        });
      }
      const resumeId = str(req.body?.resumeId, 80);
      const rec = resumeId ? db.getResume(org.id, resumeId) : null;
      if (resumeId && !rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const to = normalizeIranMobile(str(req.body?.to, 20) || rec?.contact?.phone || '');
      if (!to) return res.status(400).json({ error: 'شمارهٔ موبایل گیرنده معتبر نیست (نمونه: ۰۹۱۲۱۲۳۴۵۶۷).' });
      const text = str(req.body?.text, 900);
      if (text.length < 3) return res.status(400).json({ error: 'متن پیامک را بنویسید.' });
      if (!withinEmailLimit(org.id, EMAIL_HOURLY_LIMIT)) {
        return res.status(429).json({ error: 'سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد تلاش کنید.' });
      }
      const stamp = new Date();
      const row: db.SmsLogRow = {
        id: db.uid('sms'),
        orgId: org.id,
        to,
        text,
        status: 'sent',
        error: null,
        resumeId: rec?.id ?? null,
        candidateName: rec?.candidateName ?? null,
        sentAtISO: stamp.toISOString(),
        sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        sentByName: user.name,
      };
      try {
        await sendSms(settings, { to, text });
      } catch (err: any) {
        db.saveSms({ ...row, status: 'failed', error: friendlySmsError(err, 0) });
        const status = err?.code === 'SMS_NOT_CONFIGURED' ? 409 : 502;
        return res.status(status).json({ error: friendlySmsError(err, 0), code: err?.code || 'SMS_SEND_FAILED' });
      }
      noteEmailSend(org.id);
      db.saveSms(row);
      if (rec) db.markMessageSent(rec);
      db.logActivity(org.id, { id: user.id, name: user.name }, 'message.sent', `پیامک به «${rec?.candidateName || to}» فرستاد`, {
        jobId: rec?.jobId ?? null,
        resumeId: rec?.id ?? null,
      });
      res.json({ sms: db.withoutOrg(row) });
    })
  );

  r.get(
    '/integrations/sms',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const resumeId = str(req.query.resumeId, 80) || undefined;
      res.json({ items: db.listSms(org.id, resumeId).map(db.withoutOrg) });
    })
  );

  // ------------------------------------------------------- chat webhook ----
  /** «اطلاع‌رسانی در اسلک/تیمز» — one line in the team's own channel. */
  r.put(
    '/integrations/chat',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const previous = db.getOrgSecrets(org.id).chat;
      let prepared;
      try {
        prepared = prepareChatWebhook(
          {
            provider: str(req.body?.provider, 20) || 'slack',
            url: typeof req.body?.url === 'string' ? req.body.url : '',
            events: req.body?.events,
          },
          previous
        );
      } catch (err: any) {
        return res.status(err?.status || 400).json({ error: err?.message || 'نشانی وبهوک معتبر نیست.', code: err?.code });
      }
      const check = await (async () => {
        db.patchOrgSecrets(org.id, { chat: { ...prepared, lastTestAtISO: new Date().toISOString(), lastTestOk: null, lastError: null } });
        return testChat(org.id);
      })();
      if (!check.ok) {
        return res.status(400).json({ error: `وبهوک تأیید نشد: ${check.error}` });
      }
      db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'اطلاع‌رسانی اسلک/تیمز را وصل کرد');
      res.json({ chat: chatStatus(db.getOrgSecrets(org.id)) });
    })
  );

  r.post(
    '/integrations/chat/test',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        res.json(await testChat(org.id));
      } catch (err: any) {
        if (err instanceof ChatError) return res.status(err.status).json({ error: err.message, code: err.code });
        res.status(502).json({ error: 'ارسال آزمایشی ممکن نشد.', code: 'CHAT_FAILED' });
      }
    })
  );

  r.delete('/integrations/chat', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    db.patchOrgSecrets(org.id, { chat: undefined });
    db.logActivity(org.id, actorOf(req), 'settings.changed', 'اطلاع‌رسانی اسلک/تیمز را قطع کرد');
    res.json({ chat: chatStatus(db.getOrgSecrets(org.id)) });
  });

  /** The events a workspace can forward, so the panel never guesses. */
  r.get('/integrations/chat/events', (req, res) => res.json({ events: CHAT_EVENTS }));

  r.put(
    '/integrations/email',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const previous = db.getOrgSecrets(org.id).email;
      let prepared;
      try {
        prepared = prepareEmailSettings(
          {
            host: str(req.body?.host, 200),
            port: Number(req.body?.port) || 0,
            secure: Boolean(req.body?.secure),
            username: str(req.body?.username, 200),
            password: typeof req.body?.password === 'string' ? req.body.password : '',
            fromName: str(req.body?.fromName, 80),
            fromAddress: str(req.body?.fromAddress, 200),
            replyTo: str(req.body?.replyTo, 200) || null,
          },
          previous
        );
      } catch (err: any) {
        return res.status(400).json({ error: err?.message || 'تنظیمات ایمیل معتبر نیست.' });
      }
      // Verify before storing: a saved-but-broken connection is worse than none.
      const check = await verifyEmail(prepared);
      prepared.lastTestAtISO = new Date().toISOString();
      prepared.lastTestOk = check.ok;
      prepared.lastError = check.error;
      if (!check.ok) {
        return res.status(400).json({
          error: `اتصال به سرور ایمیل برقرار نشد: ${check.error}`,
        });
      }
      db.patchOrgSecrets(org.id, { email: prepared });
      db.logActivity(org.id, actorOf(req) || { id: user.id, name: user.name }, 'settings.changed', 'ایمیل سازمان را متصل کرد');
      res.json({ email: emailStatus(db.getOrgSecrets(org.id)) });
    })
  );

  r.delete('/integrations/email', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const secrets = db.getOrgSecrets(org.id);
    delete secrets.email;
    db.patchOrgSecrets(org.id, { email: undefined });
    db.logActivity(org.id, actorOf(req), 'settings.changed', 'اتصال ایمیل سازمان را قطع کرد');
    res.json({ email: emailStatus(db.getOrgSecrets(org.id)) });
  });

  r.post(
    '/integrations/email/test',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const settings = emailSettingsOrThrow(org.id);
      const check = await verifyEmail(settings);
      db.patchOrgSecrets(org.id, {
        email: { ...settings, lastTestAtISO: new Date().toISOString(), lastTestOk: check.ok, lastError: check.error },
      });
      res.status(check.ok ? 200 : 400).json({ ok: check.ok, error: check.error });
    })
  );

  r.get('/integrations/emails', (req, res) => {
    const { org } = ctxOf(req);
    const resumeId = str(req.query.resumeId, 80) || undefined;
    res.json({ items: db.listEmails(org.id, resumeId).map((e) => db.withoutOrg(e)) });
  });

  r.post(
    '/integrations/email/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const resumeId = str(req.body?.resumeId, 80) || null;
      const rec = resumeId ? db.getResume(org.id, resumeId) : null;
      if (resumeId && !rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      // Blind mode: writing to a person is a reveal, and it must be explicit.
      if (rec && blockedByBlind(org, res)) return;
      const subject = str(req.body?.subject, 200);
      const body = typeof req.body?.body === 'string' ? req.body.body.slice(0, 20_000) : '';
      if (!subject.trim() || !body.trim()) return res.status(400).json({ error: 'موضوع و متن ایمیل الزامی است.' });

      // Configuration first: a workspace that cannot send at all should hear
      // that (and where to fix it), not a complaint about the address.
      let settings;
      try {
        settings = emailSettingsOrThrow(org.id);
      } catch (err) {
        if (err instanceof EmailNotConfiguredError) return res.status(409).json({ error: err.message, code: err.code });
        throw err;
      }
      const to = (str(req.body?.to, 200) || candidateEmailOf(rec || {}) || '').toLowerCase();
      if (!EMAIL_RE.test(to)) {
        return res.status(400).json({ error: 'نشانی ایمیل گیرنده معتبر نیست؛ ابتدا ایمیل کارجو را در رزومه یا فیلد گیرنده وارد کنید.' });
      }
      if (!withinEmailLimit(org.id, EMAIL_HOURLY_LIMIT)) {
        return res.status(429).json({ error: 'سقف ارسال ساعتی این فضای کاری (۱۲۰ ایمیل) پر شده است؛ کمی بعد تلاش کنید.' });
      }

      const stamp = new Date();
      const row: db.SentEmailRow = {
        id: db.uid('mail'),
        orgId: org.id,
        to,
        subject,
        body,
        resumeId: rec?.id ?? null,
        candidateName: rec?.candidateName ?? null,
        jobId: rec?.jobId ?? null,
        status: 'sent',
        error: null,
        sentAtISO: stamp.toISOString(),
        sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        sentByName: user.name,
        attachments: [],
      };
      try {
        await sendMail(settings, { to, subject, text: body });
      } catch (err: any) {
        row.status = 'failed';
        row.error = friendlySmtpError(err);
        db.saveEmail(row);
        db.logActivity(org.id, actorOf(req), 'message.failed', `ارسال ایمیل به «${to}» ناموفق بود`, { resumeId: rec?.id, jobId: rec?.jobId });
        return res.status(502).json({ error: `ارسال ایمیل انجام نشد: ${row.error}`, email: db.withoutOrg(row) });
      }
      noteEmailSend(org.id);
      db.saveEmail(row);
      if (rec) db.markMessageSent(rec);
      db.logActivity(org.id, actorOf(req), 'message.sent', `ایمیل «${subject}» را از ایمیل سازمان برای «${rec?.candidateName || to}» فرستاد`, {
        resumeId: rec?.id,
        jobId: rec?.jobId,
      });
      res.json({ email: db.withoutOrg(row), record: rec ? db.toListItem(rec) : null });
    })
  );

  // ------------------------------------------------------------- calendar ----

  r.get('/integrations/calendar/connect-url', requireRole('admin'), (req, res) => {
    const { org, user } = ctxOf(req);
    if (!googleClient()) {
      return res.status(409).json({
        error: 'اتصال Google Calendar در این نصب تنظیم نشده است؛ مدیر سامانه باید در پنل مدیریت › «اتصال‌ها» کلید OAuth گوگل را ثبت کند.',
        code: 'CALENDAR_NOT_CONFIGURED',
      });
    }
    const redirectUri = redirectUriFor(originOf(req));
    const state = signState({ orgId: org.id, userId: user.id, redirectUri, exp: Date.now() + 10 * 60_000 });
    res.json({ url: authUrl({ redirectUri, state }), redirectUri });
  });

  r.delete('/integrations/calendar', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const secrets = db.getOrgSecrets(org.id);
    if (secrets.calendar) {
      delete secrets.calendar;
      db.patchOrgSecrets(org.id, { calendar: undefined });
      db.logActivity(org.id, actorOf(req), 'settings.changed', 'اتصال Google Calendar را قطع کرد');
    }
    res.json({ calendar: calendarStatus(db.getOrgSecrets(org.id), redirectUriFor(originOf(req))) });
  });

  // ------------------------------------------------------------- interviews ----

  r.get('/interviews', (req, res) => {
    const { org } = ctxOf(req);
    const jobId = str(req.query.jobId, 80) || undefined;
    const resumeId = str(req.query.resumeId, 80) || undefined;
    const items = db.listInterviews(org.id, { jobId, resumeId }).map(publicInterview);
    if (!blindOn(org)) return res.json({ items });
    const names = knownNames(db.listOrgResumes(org.id));
    res.json({ items: items.map((i) => ({ ...i, candidateName: maskText(i.candidateName, names) })) });
  });

  /**
   * «یادآوری مصاحبه» — sends the reminders that are due now and reports exactly
   * what happened. The same runner is called by a timer in server.ts; this route
   * exists so an admin (or an external cron) can run it on demand.
   */
  r.post(
    '/interviews/reminders',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      // Scoped to this workspace: a workspace admin can never send another
      // tenant's reminder.
      const result = await sendInterviewReminders(new Date(), org.id);
      res.json({ reminders: result, hours: reminderHours() });
    })
  );

  r.get('/interviews/reminders', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const dueNow = db
      .listInterviewsForReminder(new Date().toISOString(), new Date(Date.now() + reminderHours() * 3600_000).toISOString())
      .filter((row) => row.orgId === org.id).length;
    res.json({ hours: reminderHours(), enabled: remindersEnabled(), dueNow });
  });

  r.post(
    '/interviews',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      // The booking itself lives in server/interviews.ts so an approved
      // automation proposal books exactly the same interview.
      try {
        res.json(await bookInterview({ org, user, body: req.body || {} }));
      } catch (err) {
        if (err instanceof InterviewInputError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    })
  );

  r.delete(
    '/interviews/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getInterview(org.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
      let calendarError: string | null = null;
      const secrets = db.getOrgSecrets(org.id);
      if (row.calendarEventId && secrets.calendar?.refreshTokenEnc) {
        try {
          const token = await accessTokenFor(secrets, decryptSecret, encryptSecret);
          await deleteEvent(token, secrets.calendar.calendarId, row.calendarEventId);
        } catch (err: any) {
          calendarError = err instanceof CalendarError ? err.message : 'حذف رویداد از Google Calendar انجام نشد.';
        }
      }
      row.status = 'cancelled';
      row.cancelledAtISO = new Date().toISOString();
      db.saveInterview(row);
      db.logActivity(org.id, actorOf(req), 'interview.cancelled', `جلسهٔ مصاحبه با «${row.candidateName}» را لغو کرد`, { jobId: row.jobId, resumeId: row.resumeId });
      res.json({ interview: publicInterview(row), calendarError });
    })
  );

  r.get(
    '/interviews/:id/ics',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getInterview(org.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
      const secrets = db.getOrgSecrets(org.id);
      const organizer = {
        name: secrets.email?.fromName || org.name,
        email: secrets.email?.fromAddress || `no-reply@${(req.get('host') || 'hovida').split(':')[0]}`,
      };
      const attendees = [row.candidateEmail, ...db.listMembers(org.id).filter((m) => row.interviewerIds.includes(m.id)).map((m) => m.email)].filter(
        (e): e is string => Boolean(e)
      );
      const ics = buildInviteIcs({ interview: row, organizer, attendeeEmails: attendees });
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="interview.ics"');
      res.send(ics);
    })
  );

  // --------------------------------------------------------------- sourcing ----

  r.post(
    '/sourcing/brief',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const departmentId = str(req.body?.departmentId, 80);
      const department = org.departments.find((d) => d.id === departmentId);
      if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
      const job = str(req.body?.jobId, 80) ? db.getJob(org.id, str(req.body?.jobId, 80)) : null;
      if (req.body?.jobId && !job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      const brief: SourcingBrief = await buildSearchBrief({
        prompt: str(req.body?.prompt, 3000),
        department,
        roleTitle: str(req.body?.roleTitle, 120) || job?.roleTitle || '',
        openToWorkOnly: req.body?.openToWorkOnly !== false,
        job,
      });
      res.json({ brief });
    })
  );

  // ------------------------------------------------------ import a file ----

  /** Uploaded text is bounded: a Recruiter export is a few hundred KB at most. */
  const MAX_CSV_CHARS = 3_000_000;

  /** Returns the pasted/uploaded text, or answers with the reason and null. */
  function csvTextOf(req: express.Request, res: express.Response): string | null {
    const raw = req.body?.csv;
    if (typeof raw !== 'string' || !raw.trim()) {
      res.status(400).json({ error: 'محتوای فایل خالی است؛ فایل CSV یا متن جدول را بچسبانید.' });
      return null;
    }
    if (raw.length > MAX_CSV_CHARS) {
      res.status(413).json({ error: 'فایل بزرگ‌تر از حد مجاز است (۳ مگابایت)؛ آن را به چند فایل کوچک‌تر تقسیم کنید.' });
      return null;
    }
    return raw;
  }

  /**
   * Reads the file without saving anything, so the recruiter sees which columns
   * were understood *before* candidates are created.
   */
  r.post(
    '/sourcing/csv/preview',
    h(async (req, res) => {
      const text = csvTextOf(req, res);
      if (text === null) return;
      const result = profilesFromCsv(text, str(req.body?.separator, 1) || undefined);
      res.json({
        preview: {
          headers: result.headers,
          recognised: result.recognised,
          separator: result.separator === '\t' ? 'tab' : result.separator,
          totalRows: result.totalRows,
          skippedRows: result.skippedRows,
          profileCount: result.profiles.length,
          hasOpenToWorkColumn: result.hasOpenToWorkColumn,
          warnings: result.warnings,
        },
        // Enough to recognise the people; the full list comes from the import.
        profiles: result.profiles.slice(0, 5),
      });
    })
  );

  /**
   * Turns the file into a normal search result: the same profile cards, the
   * same «افزودن به فرصت» button (and therefore the same screening and
   * duplicate detection as an API result). Nothing is sent anywhere.
   */
  r.post(
    '/sourcing/csv',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const departmentId = str(req.body?.departmentId, 80);
      const department = org.departments.find((d) => d.id === departmentId);
      if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
      const jobId = str(req.body?.jobId, 80) || null;
      const job = jobId ? db.getJob(org.id, jobId) : null;
      if (jobId && !job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });

      const text = csvTextOf(req, res);
      if (text === null) return;
      const parsed = profilesFromCsv(text, str(req.body?.separator, 1) || undefined);
      if (!parsed.profiles.length) {
        return res.status(400).json({
          error: parsed.warnings.at(-1) || 'در این فایل پروفایلی پیدا نشد.',
          warnings: parsed.warnings,
        });
      }

      const openToWorkOnly = req.body?.openToWorkOnly === true && parsed.hasOpenToWorkColumn;
      const kept = (openToWorkOnly ? parsed.profiles.filter((p) => p.openToWork) : parsed.profiles).slice(0, MAX_RESULTS);
      const filteredOut = openToWorkOnly ? parsed.profiles.filter((p) => !p.openToWork).length : 0;
      const fileName = str(req.body?.fileName, 200);

      const stamp = new Date();
      const row: db.SourcingSearchRecord = {
        id: db.uid('src'),
        orgId: org.id,
        departmentId: department.id,
        departmentName: department.name,
        jobId: job?.id ?? null,
        jobTitle: job?.roleTitle ?? null,
        prompt: fileName ? `ورود از فایل: ${fileName}` : 'ورود از فایل CSV',
        brief: {
          roleTitle: job?.roleTitle || str(req.body?.roleTitle, 120) || '',
          seniority: null,
          locations: [],
          skills: [],
          mustHave: [],
          keywords: [],
          booleanQuery: '',
          openToWorkOnly,
          notes: 'این فهرست از فایلی که خودتان بارگذاری کردید ساخته شده است؛ هیچ سرویس بیرونی فراخوانی نشد.',
          engine: 'local',
        },
        status: 'done',
        message: csvSummary(parsed, kept.length, filteredOut, openToWorkOnly),
        results: kept,
        imported: {},
        source: 'csv',
        createdBy: user.id,
        createdByName: user.name,
        createdAtISO: stamp.toISOString(),
        createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
      };
      db.saveSearch(row);
      db.logActivity(
        org.id,
        actorOf(req),
        'sourcing.search',
        `فهرستی از فایل «${fileName || 'CSV'}» خوانده شد (${toPersianDigits(kept.length)} پروفایل)`,
        { jobId: job?.id }
      );
      res.json({
        search: publicSearch(row),
        summary: {
          totalRows: parsed.totalRows,
          profileCount: parsed.profiles.length,
          kept: kept.length,
          filteredOut,
          skippedRows: parsed.skippedRows,
          hasOpenToWorkColumn: parsed.hasOpenToWorkColumn,
          recognised: parsed.recognised,
          warnings: parsed.warnings,
        },
      });
    })
  );

  r.get('/sourcing/searches', (req, res) => {
    const { org } = ctxOf(req);
    const items = db.listSearches(org.id).map((s) => ({
      ...publicSearch(s),
      // The history list does not need every profile body.
      results: s.results.slice(0, 3),
      resultCount: s.results.length,
    }));
    res.json({ items });
  });

  r.get(
    '/sourcing/searches/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getSearch(org.id, req.params.id);
      if (!row) return res.status(404).json({ error: 'این جست‌وجو پیدا نشد.' });

      // An Apify run started earlier is finished here — the page polls this
      // endpoint, so no request has to stay open while the actor works.
      if (row.status === 'running' && row.providerJob?.provider === 'apify') {
        try {
          const state = await pollApifySearch(row.providerJob, MAX_RESULTS);
          if (state.state === 'done') {
            row.results = state.items;
            row.status = 'done';
            row.providerJob = null;
            row.message = state.items.length === 0 ? state.notes || emptySearchMessage() : state.notes;
            db.saveSearch(row);
            db.logActivity(org.id, actorOf(req), 'sourcing.search', `جست‌وجوی «${row.brief.roleTitle}» در سرویس تمام شد (${toPersianDigits(state.items.length)} پروفایل)`, {
              jobId: row.jobId,
            });
          }
        } catch (err: any) {
          const message = err instanceof SourcingRequestError ? err.message : 'جست‌وجو انجام نشد.';
          row.status = 'error';
          row.providerJob = null;
          row.message = message;
          db.saveSearch(row);
          return res.status(502).json({ error: message, search: publicSearch(row) });
        }
      }
      res.json({ search: publicSearch(row) });
    })
  );

  r.post(
    '/sourcing/searches',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const departmentId = str(req.body?.departmentId, 80);
      const department = org.departments.find((d) => d.id === departmentId);
      if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
      const jobId = str(req.body?.jobId, 80) || null;
      const job = jobId ? db.getJob(org.id, jobId) : null;
      if (jobId && !job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });

      const briefInput = req.body?.brief;
      const prompt = str(req.body?.prompt, 3000);
      const roleTitle = str(req.body?.roleTitle, 120) || job?.roleTitle || '';
      const openToWorkOnly = req.body?.openToWorkOnly !== false;
      const brief: SourcingBrief = briefInput && typeof briefInput === 'object'
        ? {
            roleTitle: str(briefInput.roleTitle, 120) || roleTitle,
            seniority: str(briefInput.seniority, 80) || null,
            locations: Array.isArray(briefInput.locations) ? briefInput.locations.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 8) : [],
            skills: Array.isArray(briefInput.skills) ? briefInput.skills.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 15) : [],
            mustHave: Array.isArray(briefInput.mustHave) ? briefInput.mustHave.map((x: unknown) => str(x, 120)).filter(Boolean).slice(0, 6) : [],
            keywords: Array.isArray(briefInput.keywords) ? briefInput.keywords.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 20) : [],
            booleanQuery: str(briefInput.booleanQuery, 600),
            openToWorkOnly,
            notes: str(briefInput.notes, 400),
            engine: briefInput.engine === 'ai' ? 'ai' : 'local',
          }
        : await buildSearchBrief({
            prompt,
            department,
            roleTitle,
            openToWorkOnly,
            job,
          });
      if (!brief.roleTitle && !brief.booleanQuery) {
        return res.status(400).json({ error: 'توضیح دهید دنبال چه متخصصی هستید (نقش یا مهارت‌ها).' });
      }

      // Cost guard: the Apify token is shared by the whole deployment, so the
      // cap is counted across workspaces and refuses *before* anything is spent.
      const usage = sourcingUsage();
      if (usage.remaining !== null && usage.remaining <= 0) {
        return res.status(429).json({
          error: `سقف جست‌وجوی روزانه این نصب (${toPersianDigits(usage.dailyLimit)} جست‌وجو) پر شده است؛ فردا دوباره تلاش کنید یا مدیر سامانه سقف را در «پنل مدیریت ← اتصال‌ها» بالا ببرد.`,
          code: 'SOURCING_DAILY_LIMIT',
          usage,
        });
      }

      const stamp = new Date();
      const row: db.SourcingSearchRecord = {
        id: db.uid('src'),
        orgId: org.id,
        departmentId: department.id,
        departmentName: department.name,
        jobId: job?.id ?? null,
        jobTitle: job?.roleTitle ?? null,
        prompt: prompt || brief.notes,
        brief,
        status: 'running',
        message: null,
        results: [],
        imported: {},
        createdBy: user.id,
        createdByName: user.name,
        createdAtISO: stamp.toISOString(),
        createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
      };
      db.saveSearch(row);

      try {
        const started = await startSearch(brief, { limit: Math.min(MAX_RESULTS, Math.max(1, Number(req.body?.limit) || 25)) });
        if (started.state === 'pending') {
          // Asynchronous provider (Apify): answer now, finish on the next read.
          row.providerJob = started.job;
          row.status = 'running';
          // The bill is shown up front, not after the fact.
          row.message =
            'جست‌وجو در سرویس شروع شد و در حال انجام است؛ نتیجه به‌محض آماده شدن همین‌جا می‌آید. ' +
            `${apifyCostLine(started.job.fetchLimit)}.`;
          db.saveSearch(row);
          db.logActivity(org.id, actorOf(req), 'sourcing.search', `جست‌وجوی «${brief.roleTitle}» در سرویس را شروع کرد`, { jobId: job?.id });
          return res.status(202).json({ search: publicSearch(row) });
        }
        row.results = started.items;
        row.status = 'done';
        row.providerJob = null;
        row.message =
          started.items.length === 0
            ? started.notes || emptySearchMessage()
            : started.notes;
        res.json({ search: publicSearch(row) });
      } catch (err: any) {
        if (err instanceof SourcingNotConfiguredError) {
          row.status = 'not_configured';
          row.message = err.message;
          db.saveSearch(row);
          return res.status(409).json({ error: err.message, code: err.code, search: publicSearch(row) });
        }
        const message = err instanceof SourcingRequestError ? err.message : 'جست‌وجو انجام نشد.';
        row.status = 'error';
        row.message = message;
        db.saveSearch(row);
        return res.status(502).json({ error: message, search: publicSearch(row) });
      }
      db.saveSearch(row);
      db.logActivity(org.id, actorOf(req), 'sourcing.search', `جست‌وجوی «${brief.roleTitle}» در LinkedIn را اجرا کرد (${toPersianDigits(row.results.length)} پروفایل)`, {
        jobId: job?.id,
      });
    })
  );

  r.delete('/sourcing/searches/:id', (req, res) => {
    const { org } = ctxOf(req);
    if (!db.deleteSearch(org.id, req.params.id)) return res.status(404).json({ error: 'این جست‌وجو پیدا نشد.' });
    res.json({ ok: true });
  });

  /**
   * Adds one found profile to an opening as a normal candidate: the profile is
   * converted to text, screened by the same engine as an uploaded resume, and
   * listed (with source) everywhere else.
   */
  r.post(
    '/sourcing/searches/:id/import',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const search = db.getSearch(org.id, req.params.id);
      if (!search) return res.status(404).json({ error: 'این جست‌وجو پیدا نشد.' });
      const profileId = str(req.body?.profileId, 200);
      const profile: SourcingProfile | undefined = search.results.find((p) => p.id === profileId);
      if (!profile) return res.status(404).json({ error: 'این پروفایل در نتایج این جست‌وجو نیست.' });

      const existingId = search.imported[profile.id];
      const existing = existingId ? db.getResume(org.id, existingId) : null;
      if (existing) return res.json({ record: db.toListItem(existing), alreadyImported: true });

      const jobId = str(req.body?.jobId, 80) || search.jobId || '';
      const job = db.getJob(org.id, jobId);
      if (!job) return res.status(400).json({ error: 'فرصت شغلی مقصد را انتخاب کنید.' });
      if (job.status === 'closed') return res.status(409).json({ error: 'این فرصت شغلی بسته است؛ برای افزودن کاندید آن را باز کنید.' });

      const text = profileToResumeText(profile);
      const dept = org.departments.find((d) => d.id === job.departmentId);
      let evaluation;
      let reason: string | null = null;
      try {
        evaluation = await evaluateResume({
          orgName: org.name,
          job: { ...job, departmentHint: dept?.hint },
          resumeText: text,
          fileName: `${profile.fullName}-linkedin.txt`,
          sourceLabel: 'نمایهٔ LinkedIn',
        });
        reason = db.unjudgeableReasonOf(evaluation);
      } catch (err: any) {
        console.error('[sourcing] evaluation failed:', err?.message);
      }

      let record;
      try {
        record = await db.saveEvaluation({
          job,
          uploadedBy: user.id,
          fileName: `${profile.fullName} — LinkedIn.txt`.slice(0, 200),
          extractedText: text,
          unjudgeableReason: reason,
          evaluation,
          source: {
            kind: 'linkedin',
            profileUrl: profile.profileUrl,
            headline: profile.headline,
            company: profile.currentCompany,
            location: profile.location,
            openToWork: profile.openToWork,
            searchId: search.id,
          },
          errorMessage: evaluation || reason ? undefined : 'تحلیل این پروفایل ممکن نشد؛ از دکمهٔ «تحلیل دوباره» استفاده کنید.',
        });
      } catch (err) {
        if (err instanceof db.JobGoneError) return res.status(404).json({ error: err.message });
        throw err;
      }
      search.imported[profile.id] = record.id;
      db.saveSearch(search);
      db.logActivity(org.id, actorOf(req), 'sourcing.imported', `پروفایل «${profile.fullName}» را از LinkedIn به «${job.roleTitle}» افزود`, {
        jobId: job.id,
        resumeId: record.id,
      });
      res.json({ record: db.toListItem(record), alreadyImported: false });
    })
  );

  /** One-time info for the UI: where the LinkedIn contract is documented. */
  r.get('/sourcing/status', (_req, res) => {
    res.json({ sourcing: { ...sourcingStatus(), usage: sourcingUsage() }, docPath: LINKEDIN_DOC_PATH });
  });

  return r;
}

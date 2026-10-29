import express from 'express';
import * as db from '../db';
import {
  RateLimiter,
  accessBlock,
  clientIp,
  ctxOf,
  hashPassword,
  isValidEmail,
  issueSession,
  passwordProblem,
  requireAuth,
  verifyPassword,
} from '../auth';
import { aiStatus } from '../ai/provider';
import { demoAllowed, demoTtlMs, isEnvAdmin, isPlatformAdmin, publicConfig, systemSettings } from '../platform';
import { createDemoWorkspace } from '../demo-seed';
import { orgRequiresSso } from './sso';
import { h, str } from './util';
import {
  TwoFactorError,
  beginEnrollment,
  challengeUser,
  confirmEnrollment,
  disable,
  regenerateRecovery,
  startChallenge,
  statusOf,
  verifySecondStep,
} from '../twofactor';

// Only FAILED logins count: an office behind one NAT address must be able to
// sign in all day. Per address+account, per address, and per account across
// all addresses (so rotating IPs can't brute-force one mailbox).
const loginFailByIpAccount = new RateLimiter(8, 15 * 60_000);
const loginFailByIp = new RateLimiter(40, 15 * 60_000);
const loginFailByAccount = new RateLimiter(30, 15 * 60_000);
const signupByIp = new RateLimiter(10, 60 * 60_000);
const demoByIp = new RateLimiter(15, 60 * 60_000);
// Wrong «current password» on PATCH /me — a stolen session must not be able
// to guess the real password at full speed.
const passwordCheckFailByUser = new RateLimiter(10, 15 * 60_000);
// Guessing a 6-digit code: 10 wrong answers per account per 15 minutes leaves
// room for a person who mistyped twice and is useless for a script (one in 10^6).
const secondFactorFailByUser = new RateLimiter(10, 15 * 60_000);

function tooMany(res: express.Response, retryAfterSec: number) {
  res.setHeader('Retry-After', String(retryAfterSec));
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return res
    .status(429)
    .json({ error: `تعداد تلاش‌ها زیاد بود؛ لطفاً ${minutes.toLocaleString('fa-IR')} دقیقه دیگر دوباره امتحان کنید.`, code: 'RATE_LIMITED' });
}

/** DISABLE_DEMO=1 on the server, or the switch in /admin › تنظیمات سامانه. */
export function demoEnabled(): boolean {
  return demoAllowed();
}

export function authRoutes(): express.Router {
  const r = express.Router();

  r.post(
    '/signup',
    h(async (req, res) => {
      // Closed sign-ups never lock out the operator's own ADMIN_EMAILS address.
      if (!systemSettings().signupEnabled && !isEnvAdmin({ email: str(req.body?.email, 120) })) {
        return res.status(403).json({ error: 'ثبت‌نام سازمان‌های تازه فعلاً بسته است؛ برای دریافت دسترسی با ما تماس بگیرید.', code: 'SIGNUP_CLOSED' });
      }
      const limit = signupByIp.hit(clientIp(req));
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const orgName = str(req.body?.orgName, 80);
      const name = str(req.body?.name, 80);
      const email = str(req.body?.email, 120).toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (orgName.length < 2) return res.status(400).json({ error: 'نام سازمان را وارد کنید.', field: 'orgName' });
      if (name.length < 2) return res.status(400).json({ error: 'نام و نام خانوادگی را وارد کنید.', field: 'name' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'ایمیل معتبر نیست.', field: 'email' });
      const weak = passwordProblem(password);
      if (weak) return res.status(400).json({ error: weak, field: 'password' });
      const taken = () => res.status(409).json({ error: 'با این ایمیل قبلاً حساب ساخته شده است؛ وارد شوید.', field: 'email' });
      if (db.findUserByEmail(email)) return taken();
      const passwordHash = await hashPassword(password);
      // Hashing yields the event loop: a parallel sign-up may have taken the
      // address meanwhile. Check again right before creating anything.
      if (db.findUserByEmail(email)) return taken();
      const org = db.createOrg({ name: orgName, ownerEmail: email });
      const user = db.createUser({ orgId: org.id, name, email, passwordHash, role: 'owner' });
      db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
      db.logActivity(org.id, { id: user.id, name: user.name }, 'org.created', `فضای کاری «${org.name}» را ساخت`);
      res.status(201).json({ token: issueSession(user.id), user: { ...db.publicUser(user), platformAdmin: isPlatformAdmin(user) }, org });
    })
  );

  r.post(
    '/login',
    h(async (req, res) => {
      const email = str(req.body?.email, 120).toLowerCase();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const ip = clientIp(req);
      for (const limit of [loginFailByIp.check(ip), loginFailByIpAccount.check(`${ip}|${email}`), loginFailByAccount.check(email)]) {
        if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      }
      // A workspace that asked for «فقط SSO» gets no password fallback. Answered
      // before the password is even checked, so a right password changes nothing.
      const ssoOnly = email ? orgRequiresSso(email) : null;
      if (ssoOnly) {
        return res.status(403).json({
          error: `ورود این فضای کاری («${ssoOnly.orgName}») فقط با حساب سازمانی انجام می‌شود؛ رمز عبور پذیرفته نیست.`,
          code: 'SSO_REQUIRED',
        });
      }
      const user = email ? db.findUserByEmail(email) : null;
      const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
      const org = user ? db.getOrg(user.orgId) : null;
      if (!user || !ok || !org) {
        loginFailByIp.hit(ip);
        loginFailByIpAccount.hit(`${ip}|${email}`);
        loginFailByAccount.hit(email);
        return res.status(401).json({ error: 'ایمیل یا رمز عبور درست نیست.' });
      }
      loginFailByIpAccount.reset(`${ip}|${email}`);
      loginFailByAccount.reset(email);
      const blocked = accessBlock(user, org);
      if (blocked) return res.status(blocked.status).json({ error: blocked.error, code: blocked.code });
      // «ورود دومرحله‌ای»: the password was right, but no session exists yet.
      const twoFactor = db.getTwoFactor(user.id);
      if (twoFactor?.enabledAtISO) {
        return res.json({
          twoFactorRequired: true as const,
          challenge: startChallenge(user.id),
          hint: 'کد ۶ رقمی برنامهٔ احراز هویت را وارد کنید (یا یکی از کدهای بازیابی).',
        });
      }
      db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
      res.json({ token: issueSession(user.id), user: { ...db.publicUser(user), platformAdmin: isPlatformAdmin(user) }, org });
    })
  );

  r.post(
    '/demo',
    h(async (req, res) => {
      if (!demoEnabled()) return res.status(404).json({ error: 'نسخه نمایشی روی این سرور غیرفعال است.' });
      const limit = demoByIp.hit(clientIp(req));
      if (!limit.ok) return tooMany(res, limit.retryAfterSec);
      const { org, user } = await createDemoWorkspace(demoTtlMs());
      res.status(201).json({ token: issueSession(user.id, demoTtlMs()), user: db.publicUser(user), org });
    })
  );

  /** Public switches for the landing page, sign-up form, banners and upload limits. */
  r.get('/config', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(publicConfig());
  });

  r.post('/logout', requireAuth, (req, res) => {
    db.deleteSession(ctxOf(req).tokenHash);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    const { user, org, support } = ctxOf(req);
    res.json({
      user: { ...db.publicUser(user), platformAdmin: isPlatformAdmin(user) },
      org,
      ai: aiStatus(),
      unread: db.unreadCount(user),
      support: support ? { adminName: support.adminName, expiresAt: support.expiresAt } : null,
    });
  });

  /**
   * The second step of a login. One request, one single-use challenge: the code
   * is checked against the account that started the challenge, never a body id.
   */
  r.post(
    '/2fa',
    h(async (req, res) => {
      const challenge = str(req.body?.challenge, 200);
      if (!challenge) return res.status(400).json({ error: 'درخواست ورود نامعتبر است.', code: 'CHALLENGE_REQUIRED' });
      // The service owns the challenge map; this only resolves who it belongs to.
      let user: db.UserRecord;
      try {
        user = challengeUser(challenge);
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      const budget = secondFactorFailByUser.check(user.id);
      if (!budget.ok) return tooMany(res, budget.retryAfterSec);
      try {
        verifySecondStep(user, { challenge, code: req.body?.code, recoveryCode: req.body?.recoveryCode });
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        if (err.code !== 'CHALLENGE_EXPIRED' && err.code !== 'TOO_MANY_TRIES') secondFactorFailByUser.hit(user.id);
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      secondFactorFailByUser.reset(user.id);
      const org = db.getOrg(user.orgId);
      if (!org) return res.status(401).json({ error: 'فضای کاری این حساب پیدا نشد.' });
      const blocked = accessBlock(user, org);
      if (blocked) return res.status(blocked.status).json({ error: blocked.error, code: blocked.code });
      db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
      db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'با ورود دومرحله‌ای وارد حساب خود شد');
      res.json({ token: issueSession(user.id), user: { ...db.publicUser(user), platformAdmin: isPlatformAdmin(user) }, org });
    })
  );

  // ------------------------------------------------- ورود دومرحله‌ای (TOTP) --

  r.get('/2fa', requireAuth, (req, res) => {
    const { user } = ctxOf(req);
    res.json(statusOf(user.id));
  });

  r.post(
    '/2fa/setup',
    requireAuth,
    h(async (req, res) => {
      const { user, org } = ctxOf(req);
      // A shared demo workspace has a published password: a second factor there
      // would lock the next visitor out, so it is offered on real accounts only.
      if (org.isDemo) return res.status(400).json({ error: 'در نسخه نمایشی ورود دومرحله‌ای فعال نمی‌شود؛ روی حساب واقعی سازمان خودتان روشنش کنید.', code: 'DEMO_WORKSPACE' });
      const budget = passwordCheckFailByUser.check(user.id);
      if (!budget.ok) return tooMany(res, budget.retryAfterSec);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!(await verifyPassword(password, user.passwordHash))) {
        passwordCheckFailByUser.hit(user.id);
        return res.status(400).json({ error: 'برای راه‌اندازی، رمز عبور فعلی را وارد کنید.', field: 'password' });
      }
      passwordCheckFailByUser.reset(user.id);
      try {
        const enrollment = await beginEnrollment(user.id, user.email, org.name || 'HOVIDA');
        res.status(201).json(enrollment);
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        res.status(err.status).json({ error: err.message, code: err.code });
      }
    })
  );

  r.post(
    '/2fa/enable',
    requireAuth,
    h(async (req, res) => {
      const { user, org, tokenHash } = ctxOf(req);
      try {
        const result = confirmEnrollment(user.id, str(req.body?.code, 10));
        db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'ورود دومرحله‌ای را روشن کرد');
        // Other devices must sign in again, now with a code.
        db.deleteSessionsOfUser(user.id, tokenHash);
        res.json({ ...statusOf(user.id), ...result });
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        res.status(err.status).json({ error: err.message, code: err.code });
      }
    })
  );

  r.post(
    '/2fa/disable',
    requireAuth,
    h(async (req, res) => {
      const { user, org } = ctxOf(req);
      const budget = passwordCheckFailByUser.check(user.id);
      if (!budget.ok) return tooMany(res, budget.retryAfterSec);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!(await verifyPassword(password, user.passwordHash))) {
        passwordCheckFailByUser.hit(user.id);
        return res.status(400).json({ error: 'رمز عبور درست نیست.', field: 'password' });
      }
      try {
        disable(user.id, str(req.body?.code, 10));
        passwordCheckFailByUser.reset(user.id);
        db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'ورود دومرحله‌ای را خاموش کرد');
        res.json(statusOf(user.id));
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        res.status(err.status).json({ error: err.message, code: err.code });
      }
    })
  );

  r.post(
    '/2fa/recovery',
    requireAuth,
    h(async (req, res) => {
      const { user } = ctxOf(req);
      try {
        const codes = regenerateRecovery(user.id, str(req.body?.code, 10));
        res.json({ recoveryCodes: codes, ...statusOf(user.id) });
      } catch (err) {
        if (!(err instanceof TwoFactorError)) throw err;
        res.status(err.status).json({ error: err.message, code: err.code });
      }
    })
  );

  r.patch(
    '/me',
    requireAuth,
    h(async (req, res) => {
      const { user, org, tokenHash } = ctxOf(req);
      const name = str(req.body?.name, 80);
      const title = typeof req.body?.title === 'string' ? str(req.body.title, 80) : undefined;
      const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
      if (name && name.length < 2) return res.status(400).json({ error: 'نام خیلی کوتاه است.', field: 'name' });
      if (newPassword) {
        if (org.isDemo) return res.status(400).json({ error: 'در نسخه نمایشی امکان تغییر رمز عبور وجود ندارد.' });
        const current = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const budget = passwordCheckFailByUser.check(user.id);
        if (!budget.ok) return tooMany(res, budget.retryAfterSec);
        if (!(await verifyPassword(current, user.passwordHash))) {
          passwordCheckFailByUser.hit(user.id);
          return res.status(400).json({ error: 'رمز عبور فعلی درست نیست.', field: 'currentPassword' });
        }
        passwordCheckFailByUser.reset(user.id);
        const weak = passwordProblem(newPassword);
        if (weak) return res.status(400).json({ error: weak, field: 'newPassword' });
        db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
        db.deleteSessionsOfUser(user.id, tokenHash); // sign out other devices
      }
      db.updateUser(user.id, { ...(name ? { name } : {}), ...(title !== undefined ? { title } : {}) });
      res.json({ user: { ...db.publicUser(user), platformAdmin: isPlatformAdmin(user) } });
    })
  );

  return r;
}

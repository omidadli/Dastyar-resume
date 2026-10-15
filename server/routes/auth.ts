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
import { h, str } from './util';

// Only FAILED logins count: an office behind one NAT address must be able to
// sign in all day. Per address+account, per address, and per account across
// all addresses (so rotating IPs can't brute-force one mailbox).
const loginFailByIpAccount = new RateLimiter(8, 15 * 60_000);
const loginFailByIp = new RateLimiter(40, 15 * 60_000);
const loginFailByAccount = new RateLimiter(30, 15 * 60_000);
const signupByIp = new RateLimiter(10, 60 * 60_000);
const demoByIp = new RateLimiter(15, 60 * 60_000);

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
      if (db.findUserByEmail(email)) {
        return res.status(409).json({ error: 'با این ایمیل قبلاً حساب ساخته شده است؛ وارد شوید.', field: 'email' });
      }
      const org = db.createOrg({ name: orgName, ownerEmail: email });
      const user = db.createUser({ orgId: org.id, name, email, passwordHash: await hashPassword(password), role: 'owner' });
      db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
      db.logActivity(org.id, { id: user.id, name: user.name }, 'org.created', `فضای کاری «${org.name}» را ساخت`);
      res.status(201).json({ token: issueSession(user.id), user: db.publicUser(user), org });
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
      db.updateUser(user.id, { lastLoginISO: new Date().toISOString() });
      res.json({ token: issueSession(user.id), user: db.publicUser(user), org });
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
        if (!(await verifyPassword(current, user.passwordHash))) {
          return res.status(400).json({ error: 'رمز عبور فعلی درست نیست.', field: 'currentPassword' });
        }
        const weak = passwordProblem(newPassword);
        if (weak) return res.status(400).json({ error: weak, field: 'newPassword' });
        db.updateUser(user.id, { passwordHash: await hashPassword(newPassword) });
        db.deleteSessionsOfUser(user.id, tokenHash); // sign out other devices
      }
      db.updateUser(user.id, { ...(name ? { name } : {}), ...(title !== undefined ? { title } : {}) });
      res.json({ user: db.publicUser(user) });
    })
  );

  return r;
}

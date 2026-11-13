/**
 * «ورود سازمانی (SSO)» routes.
 *
 * Public half (no session): look up whether a domain has SSO, start the flow,
 * finish the callback. Admin half: connect, check, disconnect.
 *
 * The callback is the only place a session is minted without a password, so it
 * checks in this order: single-use state → provider discovery → code exchange →
 * ID-token signature → issuer/audience/time → nonce → verified e-mail → domain →
 * membership.
 */
import express from 'express';
import * as db from '../db';
import { RateLimiter, clientIp, ctxOf, issueSession, requireRole } from '../auth';
import { isPlatformAdmin } from '../platform';
import {
  OidcError,
  authorizeUrl,
  discover,
  exchangeCode,
  newFlowSecrets,
  verifyIdToken,
} from '../oidc';
import {
  emailDomain,
  identityFromClaims,
  noteSsoError,
  normalizeDomains,
  orgForDomain,
  redirectUriFor,
  rememberFlow,
  saveSso,
  clearSso,
  signInWithIdentity,
  ssoOf,
  ssoSecret,
  statusOf,
  takeFlow,
  discoveryFor,
  ssoConfigured,
} from '../sso';
import { h, str } from './util';
import type { SsoLookup } from '../../src/types/sso';

/** Guessing which domains have SSO must not become a free directory scan. */
const lookupByIp = new RateLimiter(40, 10 * 60_000);
const startByIp = new RateLimiter(30, 10 * 60_000);

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Where the browser lands after the callback: the app, with the token in the fragment. */
function appRedirect(next: string | null): string {
  return next && next.startsWith('/app') ? next : '/app';
}

export function ssoPublicRoutes(): express.Router {
  const r = express.Router();

  /**
   * The login page asks this before showing a password box. It answers only
   * «yes, workspace X claims this domain» — never who is a member.
   */
  r.get(
    '/auth/sso/lookup',
    h(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const limit = lookupByIp.hit(clientIp(req));
      if (!limit.ok) return res.status(429).json({ error: 'تعداد درخواست‌ها زیاد بود؛ کمی بعد دوباره تلاش کنید.' });
      const email = str(req.query.email, 160).toLowerCase();
      const domain = str(req.query.domain, 120).toLowerCase() || (email ? emailDomain(email) : null);
      const body: SsoLookup = { available: false, orgName: null, passwordBlocked: false };
      if (!domain) return res.json(body);
      const found = orgForDomain(domain);
      if (found) {
        body.available = true;
        body.orgName = found.org.name;
        body.passwordBlocked = Boolean(found.row.requireSso);
      }
      res.json(body);
    })
  );

  /** Starts the flow and hands the browser to the provider. */
  r.get(
    '/auth/sso/start',
    h(async (req, res) => {
      const limit = startByIp.hit(clientIp(req));
      if (!limit.ok) return res.status(429).type('text/plain').send('تعداد تلاش‌ها زیاد بود؛ چند دقیقه دیگر دوباره امتحان کنید.');
      const email = str(req.query.email, 160).toLowerCase();
      const explicitDomain = str(req.query.domain, 120).toLowerCase();
      const domain = explicitDomain || (email ? emailDomain(email) : null) || '';
      const found = domain ? orgForDomain(domain) : null;
      if (!found) return res.redirect(302, `/login?sso=none`);
      const row = found.row;
      const secret = ssoSecret(found.org.id);
      if (!secret) return res.redirect(302, `/login?sso=misconfigured`);

      const next = str(req.query.next, 200) || null;
      const redirectUri = redirectUriFor(req);
      let doc;
      try {
        doc = await discover(row.issuer);
      } catch (err) {
        noteSsoError(found.org.id, err instanceof OidcError ? err.message : 'ارتباط با سرویس ورود برقرار نشد.');
        return res.redirect(302, `/login?sso=provider`);
      }

      const secrets = newFlowSecrets();
      rememberFlow({
        orgId: found.org.id,
        state: secrets.state,
        verifier: secrets.verifier,
        nonce: secrets.nonce,
        redirectUri,
        next: next && next.startsWith('/app') ? next : null,
        createdAt: Date.now(),
      });
      const url = authorizeUrl({
        doc,
        clientId: row.clientId,
        redirectUri,
        state: secrets.state,
        nonce: secrets.nonce,
        challenge: secrets.challenge,
        loginHint: email || null,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, url);
    })
  );

  /**
   * The provider sends the person back here. Every failure ends on the login
   * page with a Persian reason, not a raw error page.
   */
  r.get(
    '/auth/sso/callback',
    h(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const state = str(req.query.state, 200);
      const code = str(req.query.code, 4000);
      const flow = state ? takeFlow(state) : null;
      if (!flow) return res.redirect(302, '/login?sso=expired');
      const org = db.getOrg(flow.orgId);
      const row = ssoOf(flow.orgId);
      const secret = ssoSecret(flow.orgId);
      if (!org || !row?.enabled || !secret) return res.redirect(302, '/login?sso=off');
      if (str(req.query.error, 200)) {
        noteSsoError(org.id, `ورود توسط سرویس سازمانی لغو شد (${str(req.query.error, 200)}).`);
        return res.redirect(302, '/login?sso=cancelled');
      }
      if (!code) return res.redirect(302, '/login?sso=code');

      try {
        const doc = await discover(row.issuer);
        const tokens = await exchangeCode({
          doc,
          clientId: row.clientId,
          clientSecret: secret,
          code,
          redirectUri: flow.redirectUri,
          verifier: flow.verifier,
        });
        const claims = await verifyIdToken(tokens.id_token, { doc, clientId: row.clientId, nonce: flow.nonce });
        const identity = identityFromClaims(claims);
        const result = signInWithIdentity(org, row, identity);
        if (!result.ok) {
          db.logActivity(org.id, null, 'settings.changed', `ورود سازمانی رد شد: ${result.error}`);
          return res.redirect(302, `/login?sso=denied&reason=${encodeURIComponent(result.code)}`);
        }
        const token = issueSession(result.user.id);
        res.setHeader('Referrer-Policy', 'no-referrer');
        // The token travels in the fragment: it is never sent to a server and
        // never lands in an access log or an analytics referrer.
        return res.redirect(302, `${appRedirect(flow.next)}#sso=${encodeURIComponent(token)}`);
      } catch (err) {
        const message = err instanceof OidcError ? err.message : 'ورود سازمانی کامل نشد.';
        noteSsoError(org.id, message);
        // «این حساب اجازه ندارد» با «ورود نشد» فرق دارد: پیام اول برای کارمند روشن‌تر است.
        const denied = err instanceof OidcError && ['EMAIL_UNVERIFIED', 'NO_EMAIL', 'SSO_DOMAIN', 'SSO_NOT_INVITED', 'SSO_OTHER_ORG'].includes(err.code);
        db.logActivity(org.id, null, 'settings.changed', `ورود سازمانی ناموفق بود: ${message.slice(0, 160)}`);
        return res.redirect(302, denied ? '/login?sso=denied' : '/login?sso=failed');
      }
    })
  );

  return r;
}

// ------------------------------------------------------------------ admin ----

export function ssoRoutes(): express.Router {
  const r = express.Router();

  r.get('/org/sso', requireRole('admin'), (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ sso: statusOf(ctxOf(req).org.id, redirectUriFor(req)) });
  });

  /** Live check: discovery + one key from the provider. Saves nothing. */
  r.post(
    '/org/sso/check',
    requireRole('admin'),
    h(async (req, res) => {
      const issuer = str(req.body?.issuer, 300);
      if (!issuer) return res.status(400).json({ ok: false, message: 'نشانی سرویس ورود سازمانی را وارد کنید.' });
      try {
        const doc = await discover(issuer, { fresh: true });
        const keysRes = await fetch(doc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
        const keysJson: any = await keysRes.json().catch(() => null);
        const keys = Array.isArray(keysJson?.keys) ? keysJson.keys.length : 0;
        res.json({
          ok: true,
          issuer: doc.issuer,
          message: keys ? `سرویس ورود پاسخ داد؛ ${keys.toLocaleString('fa-IR')} کلید امضا در دسترس است.` : 'سرویس ورود پاسخ داد، اما کلید امضایی منتشر نکرده است.',
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          keys,
        });
      } catch (err) {
        res.status(400).json({ ok: false, issuer: null, message: err instanceof OidcError ? err.message : 'بررسی سرویس ورود ناموفق بود.' });
      }
    })
  );

  r.put(
    '/org/sso',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const issuer = str(req.body?.issuer, 300);
      const clientId = str(req.body?.clientId, 300);
      const clientSecret = typeof req.body?.clientSecret === 'string' ? req.body.clientSecret.trim().slice(0, 500) : '';
      const domains = normalizeDomains(req.body?.domains);
      const autoJoin = req.body?.autoJoin !== false;
      const defaultRole = req.body?.defaultRole === 'admin' ? 'admin' : 'member';
      const requireSso = Boolean(req.body?.requireSso);

      if (!issuer) return res.status(400).json({ error: 'نشانی سرویس ورود سازمانی (Issuer) را وارد کنید.', field: 'issuer' });
      if (!clientId) return res.status(400).json({ error: 'شناسهٔ برنامه (Client ID) را وارد کنید.', field: 'clientId' });
      if (!domains.length) return res.status(400).json({ error: 'دست‌کم یک دامنهٔ ایمیل مجاز بنویسید؛ بدون آن هیچ‌کس نمی‌تواند وارد شود.', field: 'domains' });
      const previous = ssoOf(org.id);
      if (!clientSecret && !previous?.clientSecretEnc) {
        return res.status(400).json({ error: 'رمز محرمانهٔ برنامه (Client Secret) را وارد کنید.', field: 'clientSecret' });
      }
      // Enabling an unverifiable provider would look connected while every login fails.
      try {
        await discover(issuer, { fresh: true });
      } catch (err) {
        return res.status(400).json({
          error: `پیش از ذخیره باید سرویس ورود پاسخ بدهد: ${err instanceof OidcError ? err.message : 'خطای نامشخص'}`,
          field: 'issuer',
        });
      }

      const saved = saveSso(org.id, { issuer, clientId, clientSecret: clientSecret || undefined, domains, autoJoin, defaultRole, requireSso }, user.name);
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'settings.changed',
        `«ورود سازمانی» را تنظیم کرد (${saved.domains.join('، ')}${saved.requireSso ? '، فقط SSO' : ''})`
      );
      res.json({ sso: statusOf(org.id, redirectUriFor(req)) });
    })
  );

  r.delete('/org/sso', requireRole('admin'), (req, res) => {
    const { org, user } = ctxOf(req);
    clearSso(org.id);
    db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', '«ورود سازمانی» را قطع کرد؛ ورود با رمز دوباره فعال است');
    res.json({ sso: statusOf(org.id, redirectUriFor(req)) });
  });

  return r;
}

/** True when this workspace may not fall back to a password (used by /auth/login). */
export function orgRequiresSso(email: string): { orgName: string } | null {
  const domain = emailDomain(email);
  if (!domain) return null;
  const found = orgForDomain(domain);
  return found?.row.requireSso && ssoConfigured(found.org.id) ? { orgName: found.org.name } : null;
}

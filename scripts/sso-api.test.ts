/**
 * End-to-end test of «ورود سازمانی (SSO)» against a real (mock) OIDC provider.
 *
 * The provider below speaks the same standard as Google Workspace / Entra ID:
 * discovery document, authorization endpoint, token endpoint, JWKS, RS256 ID
 * tokens. Nothing in the product is stubbed — the server does the full
 * authorization-code + PKCE flow and verifies the signature itself.
 *
 * Run with: npm run build && npx tsx scripts/sso-api.test.ts
 */
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** One RSA keypair per run; a second pair plays «an attacker's key». */
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const kid = 'test-key-1';
const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as any), kid, use: 'sig', alg: 'RS256' };

type Mode = 'ok' | 'wrongNonce' | 'unverified' | 'otherEmail' | 'foreignKey';

interface MockState {
  port: number;
  issuer: string;
  /** Set by the test before a login to make the provider behave badly on purpose. */
  mode: Mode;
  email: string;
  codes: Map<string, { nonce: string; challenge: string; redirectUri: string }>;
  lastAuthorize: URL | null;
  tokenCalls: number;
}

function signIdToken(claims: Record<string, unknown>, signingKey = key.privateKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), signingKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function startProvider(state: MockState): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${state.port}`);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        jwks_uri: `${state.issuer}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      state.lastAuthorize = url;
      const redirect = url.searchParams.get('redirect_uri') || '';
      const st = url.searchParams.get('state') || '';
      const nonce = url.searchParams.get('nonce') || '';
      const challenge = url.searchParams.get('code_challenge') || '';
      if (!redirect || !st || !nonce || !challenge) return json(400, { error: 'invalid_request' });
      const code = crypto.randomBytes(12).toString('hex');
      state.codes.set(code, { nonce, challenge, redirectUri: redirect });
      res.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(st)}` });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      state.tokenCalls++;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        const entry = state.codes.get(form.get('code') || '');
        state.codes.delete(form.get('code') || '');
        if (!entry) return json(400, { error: 'invalid_grant', error_description: 'code unknown' });
        const verifier = form.get('code_verifier') || '';
        const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
        if (expected !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE mismatch' });
        if (form.get('client_secret') !== 'secret-value-123') return json(401, { error: 'invalid_client' });
        if (form.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect mismatch' });
        const email = state.mode === 'otherEmail' ? 'someone@elsewhere.example' : state.email;
        const claims = {
          iss: state.issuer,
          aud: form.get('client_id'),
          sub: `sub-${email}`,
          exp: Math.floor(Date.now() / 1000) + 600,
          iat: Math.floor(Date.now() / 1000),
          nonce: state.mode === 'wrongNonce' ? 'not-the-nonce' : entry.nonce,
          email,
          email_verified: state.mode === 'unverified' ? false : true,
          name: 'سارا محمدی',
        };
        const idToken = signIdToken(claims, state.mode === 'foreignKey' ? otherKey.privateKey : key.privateKey);
        json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 600, id_token: idToken });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.port = (server.address() as any).port;
      state.issuer = `http://127.0.0.1:${state.port}`;
      resolve(server);
    })
  );
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');

  const mock: MockState = {
    port: 0,
    issuer: '',
    mode: 'ok',
    email: 'sara@company.ir',
    codes: new Map(),
    lastAuthorize: null,
    tokenCalls: 0,
  };
  const provider = await startProvider(mock);

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-sso-'));
  const PORT = 5100 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'sso-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'PUBLIC_URL']) delete env[k];
  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const watch = (c: typeof child) => {
    c.stdout.on('data', (d) => (log += d));
    c.stderr.on('data', (d) => (log += d));
  };
  watch(child);
  const waitReady = async () => {
    const t0 = Date.now();
    while (!/آماده است/.test(log) && Date.now() - t0 < 25_000) await new Promise((r) => setTimeout(r, 150));
  };
  await waitReady();

  /** The provider's page is a different origin: fetched directly, never via BASE. */
  const providerGet = async (url: URL): Promise<string | null> => {
    const res = await fetch(url, { redirect: 'manual' });
    return res.headers.get('location');
  };

  const call = async (method: string, url: string, token?: string | null, body?: unknown, redirect: 'manual' | 'follow' = 'manual') => {
    const res = await fetch(BASE + url, {
      method,
      redirect,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Hovida-Session': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, location: res.headers.get('location'), headers: res.headers };
  };

  try {
    const signup = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت الف', name: 'مدیر', email: 'owner@company.ir', password: 'Password12345' });
    const A = signup.json.token as string;
    const member = await call('POST', '/api/org/members', A, { name: 'حسین کاظمی', email: 'hossein@company.ir', password: 'Password12345', role: 'member' });
    const M = (await call('POST', '/api/auth/login', null, { email: 'hossein@company.ir', password: 'Password12345' })).json.token as string;
    assert(member.status === 201 && Boolean(M), 'a workspace with two members is ready');

    // ------------------------------------------------------------ baseline --
    const s0 = await call('GET', '/api/org/sso', A);
    assert(s0.status === 200 && s0.json.sso.enabled === false, 'SSO starts unconfigured');
    assert(typeof s0.json.sso.redirectUri === 'string' && s0.json.sso.redirectUri.endsWith('/api/auth/sso/callback'), 'the redirect URI is shown for the provider console');
    assert((await call('GET', '/api/org/sso', M)).status === 403, 'a plain member cannot read the SSO settings');
    assert((await call('PUT', '/api/org/sso', M, { issuer: mock.issuer, clientId: 'x', clientSecret: 'y', domains: ['company.ir'] })).status === 403, 'a plain member cannot configure SSO');

    const lookup0 = await call('GET', '/api/auth/sso/lookup?email=sara@company.ir', null);
    assert(lookup0.status === 200 && lookup0.json.available === false, 'the login page learns that nothing is configured yet');
    const start0 = await call('GET', '/api/auth/sso/start?email=sara@company.ir', null);
    assert(start0.status === 302 && (start0.location || '').includes('/login?sso=none'), 'starting a login without a provider lands back on the login page', String(start0.location));

    // -------------------------------------------------------------- checks --
    const badCheck = await call('POST', '/api/org/sso/check', A, { issuer: 'http://127.0.0.1:9' });
    assert(badCheck.status === 400 && badCheck.json.ok === false, 'an unreachable provider fails the live check', String(badCheck.status));
    const httpCheck = await call('POST', '/api/org/sso/check', A, { issuer: 'http://idp.example.com' });
    assert(httpCheck.status === 400 && /https/.test(httpCheck.json.message), 'a plain-http provider outside loopback is refused', httpCheck.json.message);
    const goodCheck = await call('POST', '/api/org/sso/check', A, { issuer: mock.issuer });
    assert(goodCheck.status === 200 && goodCheck.json.ok === true && goodCheck.json.keys === 1, 'the live check finds the provider and its key', JSON.stringify(goodCheck.json).slice(0, 120));

    // ---------------------------------------------------------------- save --
    assert((await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', clientSecret: 'secret-value-123', domains: [] })).status === 400, 'saving without a domain is refused');
    assert((await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', domains: ['company.ir'] })).status === 400, 'the first save needs a client secret');
    assert((await call('PUT', '/api/org/sso', A, { issuer: 'http://127.0.0.1:9', clientId: 'hovida', clientSecret: 'secret-value-123', domains: ['company.ir'] })).status === 400, 'saving against a dead provider is refused');

    const saved = await call('PUT', '/api/org/sso', A, {
      issuer: mock.issuer,
      clientId: 'hovida',
      clientSecret: 'secret-value-123',
      domains: ['@Company.IR', 'company.ir', 'bad domain', ''],
      defaultRole: 'member',
      autoJoin: true,
    });
    assert(saved.status === 200 && saved.json.sso.enabled === true, 'the workspace connects its provider', JSON.stringify(saved.json).slice(0, 140));
    assert(JSON.stringify(saved.json.sso.domains) === JSON.stringify(['company.ir']), 'domains are lowercased, de-duplicated and cleaned', JSON.stringify(saved.json.sso.domains));
    assert(saved.json.sso.clientSecretSet === true && !JSON.stringify(saved.json).includes('secret-value-123'), 'the client secret is stored but never returned');

    const lookup1 = await call('GET', '/api/auth/sso/lookup?email=SARA@Company.ir', null);
    assert(lookup1.json.available === true && lookup1.json.orgName === 'شرکت الف', 'the login page finds the workspace behind a domain', JSON.stringify(lookup1.json));
    assert((await call('GET', '/api/auth/sso/lookup?email=x@other.example', null)).json.available === false, 'an unrelated domain has no SSO');

    // ------------------------------------------------------------ the flow --
    const start = await call('GET', '/api/auth/sso/start?email=sara@company.ir', null);
    assert(start.status === 302 && (start.location || '').startsWith(mock.issuer), 'starting a login redirects to the provider', String(start.location));
    const authUrl = new URL(start.location!);
    assert(authUrl.searchParams.get('code_challenge_method') === 'S256' && Boolean(authUrl.searchParams.get('code_challenge')), 'PKCE (S256) is used');
    assert(authUrl.searchParams.get('scope') === 'openid profile email', 'the scope asks for a verified e-mail');
    assert(authUrl.searchParams.get('redirect_uri') === `${BASE}/api/auth/sso/callback`, 'the redirect URI matches the server', String(authUrl.searchParams.get('redirect_uri')));
    assert(authUrl.searchParams.get('login_hint') === 'sara@company.ir', 'the typed e-mail travels as a hint');

    const authorize = await providerGet(authUrl);
    const callbackUrl = new URL(authorize || '', BASE);
    const code = callbackUrl.searchParams.get('code') || '';
    const state = callbackUrl.searchParams.get('state') || '';

    const replayableState = state;
    const cb = await call('GET', `/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, null);
    assert(cb.status === 302 && (cb.location || '').startsWith('/app#sso='), 'the callback signs the person in', String(cb.location));
    assert(cb.headers.get('referrer-policy') === 'no-referrer', 'the token never leaks through a referrer');
    const token = decodeURIComponent((cb.location || '').split('#sso=')[1] || '');
    const me = await call('GET', '/api/auth/me', token);
    assert(me.status === 200 && me.json.user.email === 'sara@company.ir', 'the new session belongs to the SSO account', String(me.status));
    assert(me.json.user.role === 'member', 'auto-joined people get the configured role');
    assert(me.json.user.name === 'سارا محمدی', 'the name comes from the provider, not the e-mail');

    const replay = await call('GET', `/api/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(replayableState)}`, null);
    assert(replay.status === 302 && (replay.location || '').includes('sso=expired'), 'a replayed callback is refused (single-use state)', String(replay.location));

    const again = await call('POST', '/api/auth/login', null, { email: 'sara@company.ir', password: 'anything12345' });
    assert(again.status === 401, 'an SSO account has no password to guess', String(again.status));

    // second login: the same person is recognised, not duplicated
    mock.email = 'sara@company.ir';
    const start2 = await call('GET', '/api/auth/sso/start?email=sara@company.ir', null);
    const a2 = new URL(start2.location!);
    const auth2 = await providerGet(a2);
    const cb2Url = new URL(auth2 || '', BASE);
    const cb2 = await call('GET', `/api/auth/sso/callback?code=${cb2Url.searchParams.get('code')}&state=${cb2Url.searchParams.get('state')}`, null);
    const token2 = decodeURIComponent((cb2.location || '').split('#sso=')[1] || '');
    const me2 = await call('GET', '/api/auth/me', token2);
    assert(me2.json.user.id === me.json.user.id, 'a returning person keeps the same account');
    const members = await call('GET', '/api/org', A);
    assert(members.json.members.filter((m: any) => m.email === 'sara@company.ir').length === 1, 'no duplicate member is created');

    // --------------------------------------------------- hostile responses --
    const flowFor = async (email: string) => {
      const s = await call('GET', `/api/auth/sso/start?email=${encodeURIComponent(email)}`, null);
      const u = new URL(s.location!);
      const a = await providerGet(u);
      const back = new URL(a || '', BASE);
      return { code: back.searchParams.get('code') || '', state: back.searchParams.get('state') || '' };
    };

    mock.mode = 'wrongNonce';
    const f1 = await flowFor('sara@company.ir');
    const cbNonce = await call('GET', `/api/auth/sso/callback?code=${f1.code}&state=${f1.state}`, null);
    assert((cbNonce.location || '').includes('sso=failed'), 'a token for another login (wrong nonce) is refused', String(cbNonce.location));

    mock.mode = 'unverified';
    const f2 = await flowFor('sara@company.ir');
    const cbUnverified = await call('GET', `/api/auth/sso/callback?code=${f2.code}&state=${f2.state}`, null);
    assert((cbUnverified.location || '').includes('sso=denied'), 'an unverified e-mail address is refused', String(cbUnverified.location));

    mock.mode = 'otherEmail';
    const f3 = await flowFor('sara@company.ir');
    const cbOther = await call('GET', `/api/auth/sso/callback?code=${f3.code}&state=${f3.state}`, null);
    assert((cbOther.location || '').includes('sso=denied'), 'an e-mail outside the allowed domains is refused', String(cbOther.location));

    mock.mode = 'foreignKey';
    const f4 = await flowFor('sara@company.ir');
    const cbForged = await call('GET', `/api/auth/sso/callback?code=${f4.code}&state=${f4.state}`, null);
    assert((cbForged.location || '').includes('sso=failed'), 'a token signed with an unknown key is refused', String(cbForged.location));
    mock.mode = 'ok';

    const statusAfterErrors = await call('GET', '/api/org/sso', A);
    assert(typeof statusAfterErrors.json.sso.lastError === 'string' && statusAfterErrors.json.sso.lastError.length > 0, 'the admin sees why the last login failed');
    const feed = await call('GET', '/api/activity?limit=50', A);
    assert(feed.json.items.some((a: any) => /ورود سازمانی/.test(a.text)), 'SSO logins and refusals reach the team activity');

    // --------------------------------------------- auto-join off / other org --
    await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', domains: ['company.ir'], autoJoin: false, defaultRole: 'member' });
    mock.email = 'newcomer@company.ir';
    const f5 = await flowFor('newcomer@company.ir');
    const cbNoJoin = await call('GET', `/api/auth/sso/callback?code=${f5.code}&state=${f5.state}`, null);
    assert((cbNoJoin.location || '').includes('sso=denied'), 'with auto-join off, a stranger is not created', String(cbNoJoin.location));
    await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', domains: ['company.ir'], autoJoin: true, defaultRole: 'member' });

    const second = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت ب', name: 'مدیر ب', email: 'boss@elsewhere.example', password: 'Password12345' });
    assert(second.status === 201, 'a second workspace exists');
    mock.email = 'boss@elsewhere.example';
    const f6 = await flowFor('sara@company.ir');
    // The provider returns boss@elsewhere.example, which the first workspace does not allow:
    const cbCross = await call('GET', `/api/auth/sso/callback?code=${f6.code}&state=${f6.state}`, null);
    assert((cbCross.location || '').includes('sso=denied'), 'an account of another workspace cannot enter through SSO', String(cbCross.location));
    mock.email = 'sara@company.ir';

    // ------------------------------------------------------- SSO-only mode --
    const requireSso = await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', domains: ['company.ir'], autoJoin: true, requireSso: true });
    assert(requireSso.status === 200 && requireSso.json.sso.requireSso === true, 'the workspace can require SSO');
    const passwordTry = await call('POST', '/api/auth/login', null, { email: 'owner@company.ir', password: 'Password12345' });
    assert(passwordTry.status === 403 && passwordTry.json.code === 'SSO_REQUIRED', 'a correct password is refused while SSO is mandatory', String(passwordTry.status));
    const otherDomain = await call('POST', '/api/auth/login', null, { email: 'boss@elsewhere.example', password: 'Password12345' });
    assert(otherDomain.status === 200, 'another workspace on the same server still allows passwords');

    await call('PUT', '/api/org/sso', A, { issuer: mock.issuer, clientId: 'hovida', domains: ['company.ir'], autoJoin: true, requireSso: false });
    const passwordBack = await call('POST', '/api/auth/login', null, { email: 'owner@company.ir', password: 'Password12345' });
    assert(passwordBack.status === 200, 'turning the requirement off restores password login');

    // ------------------------------------------------------------ storage ---
    const s1 = await call('GET', '/api/org/sso', A);
    assert(s1.json.sso.lastLoginAtISO && s1.json.sso.enabled, 'the connection state is remembered');
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const raw = fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8');
    assert(!raw.includes('secret-value-123'), 'the client secret is never written in clear');
    const snap = JSON.parse(raw);
    const row = snap.orgSecrets[signup.json.org.id].sso;
    assert(row.enabled === true && row.domains.join() === 'company.ir', 'the configuration survives in the snapshot', JSON.stringify({ d: row.domains, e: row.enabled }));
    assert(String(row.clientSecretEnc).startsWith('v1:'), 'the secret is stored encrypted');

    // a restart keeps the connection working
    log = '';
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    watch(child);
    await waitReady();
    const afterRestart = await call('GET', `/api/auth/sso/lookup?email=sara@company.ir`, null);
    assert(afterRestart.json.available === true, 'after a restart the workspace is still connected');

    // --------------------------------------------------------- disconnect ---
    const A2 = (await call('POST', '/api/auth/login', null, { email: 'owner@company.ir', password: 'Password12345' })).json.token as string;
    const off = await call('DELETE', '/api/org/sso', A2);
    assert(off.status === 200 && off.json.sso.enabled === false && off.json.sso.clientSecretSet === false, 'disconnecting clears the secret');
    assert((await call('GET', '/api/auth/sso/lookup?email=sara@company.ir', null)).json.available === false, 'the login page stops offering it');
    const startOff = await call('GET', '/api/auth/sso/start?email=sara@company.ir', null);
    assert((startOff.location || '').includes('sso=none'), 'starting after disconnect lands back on the login page');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    provider.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} SSO API test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll SSO API tests passed.');
  }
}

await main();

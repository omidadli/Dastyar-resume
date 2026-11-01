/**
 * «ورود سازمانی» — a small, dependency-free OIDC client (authorization code +
 * PKCE), enough for Google Workspace, Microsoft Entra ID, Okta, Keycloak and
 * every other provider that publishes a discovery document.
 *
 * Deliberate choices:
 *  • No SDK. The whole flow is ~200 lines, reviewable, and works on the same
 *    Node runtime the rest of the server uses.
 *  • The ID token signature is verified against the provider's JWKS — an
 *    unsigned or unknown-key token is rejected, never «trusted because TLS».
 *  • The issuer must be HTTPS. Plain HTTP is accepted only for loopback (a
 *    self-hosted Keycloak on the same machine, and the test suite).
 *  • The client secret never leaves the server and is stored encrypted.
 */
import crypto from 'crypto';

export interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

export class OidcError extends Error {
  code: string;
  constructor(message: string, code = 'OIDC_ERROR') {
    super(message);
    this.code = code;
  }
}

const DISCOVERY_TTL_MS = 30 * 60_000;
const discoveryCache = new Map<string, { doc: DiscoveryDoc; at: number }>();

/** Loopback (a self-hosted IdP on the same box, and the tests) may use HTTP. */
function isLoopback(host: string): boolean {
  const h = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Rejects anything that is not a plain https URL (or http on loopback). */
export function safeEndpoint(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OidcError('نشانی سرویس ورود سازمانی معتبر نیست.', 'BAD_URL');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && (isLoopback(url.host) || process.env.OIDC_ALLOW_HTTP === '1')) return url;
  throw new OidcError('نشانی سرویس ورود سازمانی باید با https شروع شود.', 'INSECURE_URL');
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'follow', headers: { Accept: 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const detail = json?.error_description || json?.error || `HTTP ${res.status}`;
      throw new OidcError(`سرویس ورود سازمانی پاسخ درست نداد (${String(detail).slice(0, 200)}).`, 'PROVIDER_ERROR');
    }
    if (!json || typeof json !== 'object') throw new OidcError('پاسخ سرویس ورود سازمانی خوانده نشد.', 'BAD_RESPONSE');
    return json;
  } catch (err) {
    if (err instanceof OidcError) throw err;
    const aborted = (err as Error)?.name === 'AbortError';
    throw new OidcError(aborted ? 'سرویس ورود سازمانی در زمان مقرر پاسخ نداد.' : 'ارتباط با سرویس ورود سازمانی برقرار نشد.', aborted ? 'TIMEOUT' : 'UNREACHABLE');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `issuer` is the bare issuer URL (e.g. https://accounts.google.com).
 * A full discovery URL is also accepted, since some providers only document that.
 */
export async function discover(issuerOrDiscoveryUrl: string, opts: { fresh?: boolean } = {}): Promise<DiscoveryDoc> {
  const raw = issuerOrDiscoveryUrl.trim().replace(/\/$/, '');
  const url = raw.includes('/.well-known/') ? safeEndpoint(raw) : safeEndpoint(`${raw}/.well-known/openid-configuration`);
  const key = url.toString();
  const hit = discoveryCache.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.doc;

  const doc = (await fetchJson(key)) as DiscoveryDoc;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof doc[field] !== 'string' || !doc[field]) {
      throw new OidcError('سند کشف سرویس ورود سازمانی ناقص است (نشانی‌های لازم ندارد).', 'BAD_DISCOVERY');
    }
  }
  safeEndpoint(doc.authorization_endpoint);
  safeEndpoint(doc.token_endpoint);
  safeEndpoint(doc.jwks_uri);
  discoveryCache.set(key, { doc: { ...doc, issuer: doc.issuer.replace(/\/$/, '') }, at: Date.now() });
  return discoveryCache.get(key)!.doc;
}

/** PKCE (RFC 7636) and the two random values that tie the callback to the start. */
export function newFlowSecrets() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(24).toString('base64url'), nonce: crypto.randomBytes(16).toString('base64url') };
}

export function authorizeUrl(input: {
  doc: DiscoveryDoc;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  loginHint?: string | null;
  /** Microsoft needs `openid profile email`; also asks for a fresh auth. */
  prompt?: 'select_account' | 'login' | null;
}): string {
  const url = new URL(input.doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', input.state);
  url.searchParams.set('nonce', input.nonce);
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  if (input.prompt) url.searchParams.set('prompt', input.prompt);
  return url.toString();
}

const AUTH_METHODS = ['client_secret_basic', 'client_secret_post'];

export async function exchangeCode(input: {
  doc: DiscoveryDoc;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<{ id_token: string; access_token?: string }> {
  const methods = input.doc.token_endpoint_auth_methods_supported || ['client_secret_basic', 'client_secret_post'];
  const method = AUTH_METHODS.find((m) => methods.includes(m)) || 'client_secret_basic';
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.verifier,
  });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (method === 'client_secret_post') body.set('client_secret', input.clientSecret);
  else headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`;

  const json = await fetchJson(input.doc.token_endpoint, { method: 'POST', body: body.toString(), headers });
  if (typeof json.id_token !== 'string' || !json.id_token) {
    throw new OidcError('سرویس ورود سازمانی شناسهٔ کاربر (id_token) برنگرداند.', 'NO_ID_TOKEN');
  }
  return json;
}

export interface IdClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  given_name?: string;
  preferred_username?: string;
  hd?: string;
}

const jwksCache = new Map<string, { keys: any[]; at: number }>();

async function keysFor(jwksUri: string, fresh = false): Promise<any[]> {
  const hit = jwksCache.get(jwksUri);
  if (hit && !fresh && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.keys;
  const json = await fetchJson(jwksUri);
  const keys = Array.isArray(json.keys) ? json.keys : [];
  if (!keys.length) throw new OidcError('کلید عمومی سرویس ورود سازمانی در دسترس نیست.', 'NO_KEYS');
  jwksCache.set(jwksUri, { keys, at: Date.now() });
  return keys;
}

function publicKeyFromJwk(jwk: any): crypto.KeyObject | null {
  try {
    if (jwk.kty === 'RSA') return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
    if (jwk.kty === 'EC') return crypto.createPublicKey({ key: { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    return null;
  } catch {
    return null;
  }
}

function verifySignature(alg: string, signingInput: string, signature: Buffer, key: crypto.KeyObject): boolean {
  const data = Buffer.from(signingInput, 'utf-8');
  if (alg === 'RS256') return crypto.verify('sha256', data, key, signature);
  if (alg === 'RS384') return crypto.verify('sha384', data, key, signature);
  if (alg === 'RS512') return crypto.verify('sha512', data, key, signature);
  if (alg === 'PS256') return crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, signature);
  if (alg === 'ES256') return crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  return false;
}

export function decodeJwt(token: string): { header: any; payload: IdClaims; signingInput: string; signature: Buffer } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new OidcError('شناسهٔ کاربر (id_token) ساختار درستی ندارد.', 'BAD_TOKEN');
  const [h, p, s] = parts;
  let header: any;
  let payload: any;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf-8'));
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf-8'));
  } catch {
    throw new OidcError('شناسهٔ کاربر (id_token) خوانده نشد.', 'BAD_TOKEN');
  }
  return { header, payload, signingInput: `${h}.${p}`, signature: Buffer.from(s, 'base64url') };
}

/**
 * Verifies the ID token: signature against the provider's keys, then issuer,
 * audience, time window and the nonce of *this* login.
 */
export async function verifyIdToken(
  idToken: string,
  opts: { doc: DiscoveryDoc; clientId: string; nonce: string; now?: number }
): Promise<IdClaims> {
  const { header, payload, signingInput, signature } = decodeJwt(idToken);
  const alg = String(header.alg || '');
  if (!['RS256', 'RS384', 'RS512', 'PS256', 'ES256'].includes(alg)) {
    throw new OidcError('الگوریتم امضای شناسهٔ کاربر پذیرفته نمی‌شود.', 'BAD_ALG');
  }
  let keys = await keysFor(opts.doc.jwks_uri);
  const pick = () => {
    const byKid = header.kid ? keys.filter((k) => k.kid === header.kid) : keys.filter((k) => k.alg === alg || !k.alg);
    return byKid.length ? byKid : keys;
  };
  let ok = false;
  for (const jwk of pick()) {
    const key = publicKeyFromJwk(jwk);
    if (!key) continue;
    if (verifySignature(alg, signingInput, signature, key)) {
      ok = true;
      break;
    }
  }
  // A rotated key is the one legitimate reason a valid token fails here: one fresh fetch.
  if (!ok) {
    keys = await keysFor(opts.doc.jwks_uri, true);
    for (const jwk of pick()) {
      const key = publicKeyFromJwk(jwk);
      if (key && verifySignature(alg, signingInput, signature, key)) {
        ok = true;
        break;
      }
    }
  }
  if (!ok) throw new OidcError('امضای شناسهٔ کاربر معتبر نیست.', 'BAD_SIGNATURE');

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const iss = String(payload.iss || '').replace(/\/$/, '');
  if (iss !== opts.doc.issuer.replace(/\/$/, '')) throw new OidcError('صادرکنندهٔ شناسهٔ کاربر با تنظیمات نمی‌خواند.', 'BAD_ISSUER');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.clientId)) throw new OidcError('شناسهٔ کاربر برای این برنامه صادر نشده است.', 'BAD_AUDIENCE');
  if (!payload.exp || Number(payload.exp) < now - 60) throw new OidcError('شناسهٔ کاربر منقضی شده است؛ دوباره وارد شوید.', 'EXPIRED');
  if (payload.iat && Number(payload.iat) > now + 300) throw new OidcError('زمان شناسهٔ کاربر معتبر نیست.', 'BAD_IAT');
  if (typeof payload.nonce !== 'string' || payload.nonce !== opts.nonce) {
    throw new OidcError('این پاسخ به ورود همین مرورگر تعلق ندارد.', 'BAD_NONCE');
  }
  if (!payload.sub) throw new OidcError('شناسهٔ کاربر سازمانی در پاسخ نبود.', 'NO_SUB');
  return payload;
}

/** Test/QA helper: clears the discovery and key caches. */
export function clearOidcCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

/**
 * The edge in front of HOVIDA on Cloudflare.
 *
 *  - Pages and bundles come straight from Workers static assets (the `dist/`
 *    build), cached at the edge: the app shell appears instantly, even while
 *    the server container is still waking up.
 *  - /api/* goes to the HOVIDA server container. The visitor's address is
 *    passed in X-Hovida-Client-Ip, always overwritten here, so nobody can forge
 *    it to dodge the login and sign-up rate limits.
 *  - Errors raised by the container platform itself (plain text: starting,
 *    no instance yet, connection lost) become a JSON 503 the app can show.
 *  - A bundle file the current build doesn't have (a tab opened before a
 *    deploy) is a 404 — never the HTML shell, which the browser would try to
 *    run as JavaScript.
 *
 * Pure: the Worker (worker.ts) and the local test harness pass in their own
 * assets fetcher and backend.
 */

export interface EdgeDeps {
  assets: { fetch(request: Request): Promise<Response> };
  backend(request: Request): Promise<Response>;
}

export const CLIENT_IP_HEADER = 'x-hovida-client-ip';

const STARTING = 'هویدا در حال راه‌اندازی است؛ چند ثانیه دیگر دوباره تلاش کنید.';
const BUSY = 'درخواست‌ها زیاد است؛ چند لحظه دیگر دوباره تلاش کنید.';

function unavailable(message = STARTING): Response {
  return new Response(JSON.stringify({ error: message, code: 'SERVER_STARTING' }), {
    status: 503,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '5', 'cache-control': 'no-store' },
  });
}

function isApi(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

async function proxyApi(request: Request, deps: EdgeDeps): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set(CLIENT_IP_HEADER, request.headers.get('cf-connecting-ip') || '');
  let res: Response;
  try {
    res = await deps.backend(new Request(request, { headers }));
  } catch (err) {
    console.error('[edge] server unreachable:', (err as Error)?.message || err);
    return unavailable();
  }
  const type = res.headers.get('content-type') || '';
  if ((res.status >= 500 || res.status === 429) && !type.includes('application/json')) {
    const detail = await res.text().catch(() => '');
    console.warn(`[edge] platform answered ${res.status}: ${detail.slice(0, 300)}`);
    return unavailable(res.status === 429 ? BUSY : STARTING);
  }
  return res;
}

async function serveBundle(request: Request, deps: EdgeDeps): Promise<Response> {
  const res = await deps.assets.fetch(request);
  const type = res.headers.get('content-type') || '';
  if (res.status === 404 || type.includes('text/html')) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (res.status !== 200) return res;
  // Hashed file names: safe to cache for a year.
  const cached = new Response(res.body, res);
  cached.headers.set('cache-control', 'public, max-age=31536000, immutable');
  return cached;
}

export async function routeRequest(request: Request, deps: EdgeDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (isApi(pathname)) return proxyApi(request, deps);
  if (pathname.startsWith('/assets/')) return serveBundle(request, deps);
  return deps.assets.fetch(request);
}

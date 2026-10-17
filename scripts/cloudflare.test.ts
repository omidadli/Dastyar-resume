/**
 * The Cloudflare deployment, tested under the real Workers runtime (workerd,
 * through `wrangler dev`) — no Docker or Cloudflare account needed:
 *  - the edge router (cloudflare/router.ts): visitor IP, platform errors → a
 *    Persian JSON 503, bundles (404 instead of the HTML shell, year-long cache)
 *  - the R2 storage handler (cloudflare/storage-handler.ts) against the
 *    server's remote driver: conditional writes, checksums, paging, streams
 *  - the whole path: browser → edge Worker with the production assets
 *    settings (SPA, _headers, .assetsignore) → Node server in remote mode → R2
 *    handler: the API smoke test, persistence across a server restart, and a
 *    friendly answer while the server is down
 * Run with: npm run build && npx tsx scripts/cloudflare.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { CLIENT_IP_HEADER, routeRequest } from '../cloudflare/router';
import { PreconditionFailedError, RemoteStorage } from '../server/storage';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ROOT = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface Proc {
  child: ChildProcess;
  log: () => string;
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): Proc {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  return { child, log: () => log };
}

async function waitFor(p: Proc, pattern: RegExp, ms: number, what: string) {
  const t0 = Date.now();
  while (!pattern.test(p.log()) && Date.now() - t0 < ms) {
    if (p.child.exitCode !== null) break;
    await sleep(200);
  }
  if (!pattern.test(p.log())) throw new Error(`${what} did not start:\n${p.log().slice(-2000)}`);
}

async function stop(p: Proc | null) {
  if (!p || p.child.exitCode !== null) return;
  const exited = new Promise((r) => p.child.once('exit', r));
  try {
    process.kill(-p.child.pid!, 'SIGTERM');
  } catch {
    p.child.kill('SIGTERM');
  }
  await Promise.race([exited, sleep(10_000)]);
  if (p.child.exitCode === null) {
    try {
      process.kill(-p.child.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

const WRANGLER = path.join(ROOT, 'node_modules', '.bin', 'wrangler');

async function wranglerDev(config: string, port: number, extra: string[] = []): Promise<Proc> {
  const p = run(WRANGLER, ['dev', '-c', config, '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', String(await freePort()), ...extra], {
    WRANGLER_SEND_METRICS: 'false',
    CI: '1',
  });
  await waitFor(p, /Ready on http/, 60_000, `wrangler dev (${config})`);
  return p;
}

async function startNode(port: number, storageUrl: string): Promise<Proc> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    PORT: String(port),
    STORAGE_DRIVER: 'remote',
    STORAGE_URL: storageUrl,
    CLIENT_IP_HEADER,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cf-unused-')),
    APP_SECRET: 'cloudflare-test-secret-0123456789',
    ADMIN_EMAILS: 'cf-admin@example.com',
  };
  const p = run(process.execPath, [path.join(ROOT, 'dist', 'server.cjs')], env);
  await waitFor(p, /آماده است/, 30_000, 'HOVIDA server');
  return p;
}

// ------------------------------------------------------------ router unit ----

async function routerUnitTests() {
  const seen: Request[] = [];
  const assets = {
    fetch: async (req: Request) => {
      const p = new URL(req.url).pathname;
      if (p === '/assets/app-1.js') return new Response('console.log(1)', { headers: { 'content-type': 'text/javascript' } });
      if (p === '/assets/old-0.js') return new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html' } });
      if (p === '/assets/cached.js') return new Response(null, { status: 304 });
      return new Response('<!doctype html><div id="root"></div>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
  const ok = (body: unknown, init: ResponseInit = {}) => async (req: Request) => {
    seen.push(req);
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });
  };
  const api = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) => new Request('https://hovida.example' + path, { headers, ...init });

  await routeRequest(api('/api/health', { 'cf-connecting-ip': '81.12.1.9', [CLIENT_IP_HEADER]: '6.6.6.6' }), { assets, backend: ok({ ok: true }) });
  assert(seen.at(-1)!.headers.get(CLIENT_IP_HEADER) === '81.12.1.9', 'router: the visitor IP comes from Cloudflare, a forged header is overwritten');
  await routeRequest(api('/api/health', { [CLIENT_IP_HEADER]: '6.6.6.6' }), { assets, backend: ok({ ok: true }) });
  assert(seen.at(-1)!.headers.get(CLIENT_IP_HEADER) === '', 'router: without a Cloudflare address the forged value is still dropped');
  await routeRequest(api('/api/jobs/1/evaluate', { 'content-type': 'application/json', 'x-hovida-session': 'tok' }, { method: 'POST', body: '{"a":1}' }), {
    assets,
    backend: ok({ ok: true }),
  });
  const fwd = seen.at(-1)!;
  assert(fwd.method === 'POST' && (await fwd.text()) === '{"a":1}' && fwd.headers.get('x-hovida-session') === 'tok', 'router: method, body and session header reach the server');

  const thrown = await routeRequest(api('/api/health'), { assets, backend: async () => Promise.reject(new Error('network connection lost')) });
  const thrownBody = (await thrown.json()) as any;
  assert(thrown.status === 503 && thrownBody.code === 'SERVER_STARTING' && /راه‌اندازی/.test(thrownBody.error) && thrown.headers.get('retry-after') === '5', 'router: an unreachable server → JSON 503 with a Persian message');
  const platform500 = await routeRequest(api('/api/health'), { assets, backend: async () => new Response('Failed to start container: timeout', { status: 500 }) });
  assert(platform500.status === 503 && ((await platform500.json()) as any).code === 'SERVER_STARTING', 'router: a plain-text platform error (container starting) → JSON 503');
  const platform429 = await routeRequest(api('/api/health'), { assets, backend: async () => new Response('rate limited', { status: 429 }) });
  assert(platform429.status === 503 && /زیاد/.test(((await platform429.json()) as any).error), 'router: a platform 429 → JSON 503 «too many requests»');
  const appError = await routeRequest(api('/api/x'), { assets, backend: ok({ error: 'خطای داخلی سرور' }, { status: 500 }) });
  assert(appError.status === 500 && ((await appError.json()) as any).error === 'خطای داخلی سرور', 'router: the app’s own JSON errors pass through unchanged');
  const maint = await routeRequest(api('/api/x'), { assets, backend: ok({ error: 'نگهداری', code: 'MAINTENANCE' }, { status: 503 }) });
  assert(maint.status === 503 && ((await maint.json()) as any).code === 'MAINTENANCE', 'router: maintenance mode (JSON 503) is not rewritten');

  const js = await routeRequest(api('/assets/app-1.js'), { assets, backend: ok({}) });
  assert(js.status === 200 && js.headers.get('cache-control') === 'public, max-age=31536000, immutable', 'router: hashed bundles are cached for a year');
  const stale = await routeRequest(api('/assets/old-0.js'), { assets, backend: ok({}) });
  assert(stale.status === 404 && (await stale.text()) === 'Not found', 'router: a bundle of an older build → 404, never the HTML shell');
  const notModified = await routeRequest(api('/assets/cached.js'), { assets, backend: ok({}) });
  assert(notModified.status === 304, 'router: 304 revalidations pass through');
  const page = await routeRequest(api('/app/jobs'), { assets, backend: ok({}) });
  assert(page.status === 200 && (await page.text()).includes('id="root"'), 'router: pages come from static assets');
}

// ------------------------------------------------------------------ main ----

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'server.cjs'))) throw new Error('Run `npm run build` first.');
  await routerUnitTests();

  const prep = spawnSync(process.execPath, ['scripts/cloudflare/prepare-assets.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert(prep.status === 0 && fs.existsSync('dist/_headers') && fs.readFileSync('dist/.assetsignore', 'utf8').includes('server.cjs'), 'build:cloudflare adds _headers and .assetsignore to dist/');

  const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cf-r2-'));
  const sPort = await freePort();
  const nPort = await freePort();
  const ePort = await freePort();
  let storageDev: Proc | null = null;
  let node: Proc | null = null;
  let edge: Proc | null = null;
  try {
    storageDev = await wranglerDev('scripts/cloudflare/wrangler.storage-dev.jsonc', sPort, ['--persist-to', persist]);
    const S = `http://127.0.0.1:${sPort}`;

    // ------------------------------------------ R2 handler conformance ----
    const r2 = new RemoteStorage(S);
    const w1 = await r2.put('hovida-store.json', '{"v":1}', { ifNoneMatch: '*' });
    let refused = false;
    try {
      await r2.put('hovida-store.json', '{"v":"x"}', { ifNoneMatch: '*' });
    } catch (e) {
      refused = e instanceof PreconditionFailedError;
    }
    assert(Boolean(w1.etag) && refused, 'R2 handler: create-only write, then 412 for an existing key');
    await sleep(1100);
    const w2 = await r2.put('hovida-store.json', '{"v":2}', { ifMatch: w1.etag });
    let stale = false;
    try {
      await r2.put('hovida-store.json', '{"v":"old"}', { ifMatch: w1.etag });
    } catch (e) {
      stale = e instanceof PreconditionFailedError;
    }
    assert(Boolean(w2.etag) && stale && (await r2.get('hovida-store.json'))?.body.toString() === '{"v":2}', 'R2 handler: conditional write on the current version; an old version is refused');
    const head = await fetch(`${S}/v1/o/hovida-store.json`, { method: 'HEAD' });
    const md5 = crypto.createHash('md5').update('{"v":2}').digest('hex');
    assert(head.headers.get('x-hovida-md5') === md5 && head.headers.get('x-hovida-size') === '7', 'R2 handler: HEAD reports size and MD5 (lost-answer recovery)');
    for (let i = 0; i < 30; i++) await r2.put(`resumes/o1/j${i % 3}/r${i}.pdf`, Buffer.alloc(200 + i, i));
    assert((await r2.list('resumes/o1/')).length === 30 && (await r2.usage('resumes/')).objects === 30, 'R2 handler: listing and usage');
    const big = Buffer.alloc(5 * 1024 * 1024, 7);
    await r2.put('resumes/o1/big.pdf', big);
    const got = await r2.openStream('resumes/o1/big.pdf');
    let n = 0;
    for await (const c of got!.stream) n += (c as Buffer).length;
    assert(n === big.length && got!.size === big.length, 'R2 handler: a 5 MB file streams in and out');
    assert((await r2.deletePrefix('resumes/o1/')) === 31 && (await r2.list('resumes/')).length === 0, 'R2 handler: delete a whole folder');
    assert((await fetch(`${S}/v1/o/..%2Fsecret`)).status === 400, 'R2 handler: unsafe keys are refused');
    await r2.delete('hovida-store.json');

    // ---------------------------------------------------- the full path ----
    node = await startNode(nPort, S);
    edge = await wranglerDev('scripts/cloudflare/wrangler.edge-dev.jsonc', ePort, ['--var', `BACKEND_URL:http://127.0.0.1:${nPort}`]);
    const E = `http://127.0.0.1:${ePort}`;

    const home = await fetch(E + '/');
    assert(
      home.status === 200 && /text\/html/.test(home.headers.get('content-type') || '') && /must-revalidate/.test(home.headers.get('cache-control') || '') && home.headers.get('x-content-type-options') === 'nosniff',
      'edge: the app shell (never cached stale) with security headers from _headers'
    );
    const deep = await fetch(E + '/app/jobs/123', { headers: { 'sec-fetch-mode': 'navigate' } });
    assert(deep.status === 200 && (await deep.text()).includes('id="root"'), 'edge: deep links get the SPA shell');
    const bundleName = fs.readdirSync('dist/assets').find((f) => /^index-.*\.js$/.test(f))!;
    const bundle = await fetch(E + '/assets/' + bundleName);
    assert(bundle.status === 200 && /javascript/.test(bundle.headers.get('content-type') || '') && /immutable/.test(bundle.headers.get('cache-control') || ''), 'edge: bundles are served with a year-long cache');
    const gone = await fetch(E + '/assets/index-0000old.js');
    assert(gone.status === 404 && !(await gone.text()).includes('<html'), 'edge: a bundle of an older build is a 404, not HTML');
    const leak = await fetch(E + '/server.cjs');
    const leakText = await leak.text();
    assert(!leakText.includes('require(') && !leakText.includes('sourceMappingURL'), 'edge: the server bundle is never published (.assetsignore)');
    const font = await fetch(E + '/favicon.svg');
    assert(font.headers.get('cache-control') === 'public, max-age=86400', 'edge: static images get a day of cache');
    const health = await fetch(E + '/api/health', { headers: { 'sec-fetch-mode': 'navigate' } });
    const hj = (await health.json()) as any;
    assert(health.status === 200 && hj.app === 'HOVIDA' && hj.storage === 'remote', 'edge: /api reaches the server even as a page navigation (downloads)');

    const smoke = spawnSync(process.execPath, ['scripts/smoke.mjs'], { cwd: ROOT, env: { ...process.env, BASE: E }, encoding: 'utf8', timeout: 180_000 });
    const passed = (smoke.stdout.match(/^PASS/gm) || []).length;
    const failed = (smoke.stdout.match(/^FAIL/gm) || []).length;
    assert(smoke.status === 0 && failed === 0 && passed > 50, 'edge: the full API smoke test passes through Worker → server → R2', `${passed} passed, ${failed} failed`);

    // A workspace created through the edge survives a server restart (new container, empty disk).
    const call = async (method: string, url: string, body?: unknown, token?: string) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(E + url, {
            method,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-hovida-session': token } : {}) },
            body: body ? JSON.stringify(body) : undefined,
          });
          return { status: res.status, json: (await res.json().catch(() => null)) as any };
        } catch (err) {
          // A kept-alive connection the dev proxy already closed: retry on a fresh one.
          if (attempt >= 3) {
            console.error('edge log tail:\n' + edge?.log().slice(-3000));
            throw err;
          }
          await sleep(500);
        }
      }
    };
    const su = await call('POST', '/api/auth/signup', { orgName: 'آزمون ابری', name: 'مدیر ابری', email: 'cf-admin@example.com', password: 'CfAdmin12345' });
    assert(su.status === 201 && su.json.user.platformAdmin === true, 'edge: sign-up through the edge (ADMIN_EMAILS → platform admin)');
    const info = await call('GET', '/api/admin/backup', undefined, su.json.token);
    assert(info.json?.storage?.driver === 'remote', 'edge: /admin reports the remote store');
    await stop(node);
    node = null;
    const down = await fetch(E + '/api/health');
    const dj = (await down.json().catch(() => ({}))) as any;
    assert(down.status === 503 && dj.code === 'SERVER_STARTING' && /راه‌اندازی/.test(dj.error || ''), 'edge: while the server is down the app gets a Persian JSON 503');
    node = await startNode(nPort, S);
    const back = await call('POST', '/api/auth/login', { email: 'cf-admin@example.com', password: 'CfAdmin12345' });
    assert(back.status === 200 && back.json.org.name === 'آزمون ابری', 'edge: after a restart the workspace is loaded back from R2');
  } finally {
    await stop(edge);
    await stop(node);
    await stop(storageDev);
    fs.rmSync(persist, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

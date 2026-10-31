/**
 * «نصب روی دستگاه» — the installable-web-app contract, verified against a real
 * production server (not the source files):
 *
 *   • the manifest is valid JSON with the fields Android/iOS actually read;
 *   • every icon it names is served as a PNG/—and the maskable one exists;
 *   • the 180×180 apple-touch icon is a PNG, because iOS ignores SVG there;
 *   • the service worker is served with `no-cache` (a cached worker never
 *     updates) and its scope header;
 *   • the worker refuses to touch `/api` — a cached candidate list is a data
 *     leak, not a convenience;
 *   • `/offline.html` exists in Persian and never appears as a 200 for an API;
 *   • the HTML shell links the manifest and the apple icon.
 *
 * Run with: npm run build && npx tsx scripts/pwa.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-pwa-'));
  const PORT = 6700 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'pwa-test-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['PUBLIC_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];
  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  try {
    // ------------------------------------------------------------- manifest ----
    const manifestRes = await fetch(`${BASE}/manifest.webmanifest`);
    assert(manifestRes.status === 200, 'the manifest is served', `${manifestRes.status}`);
    const manifest = (await manifestRes.json()) as any;
    assert(manifest.name.includes('هویدا') && manifest.short_name === 'هویدا', 'with a Persian name and short name');
    assert(manifest.start_url === '/app' && manifest.scope === '/' && manifest.display === 'standalone', 'opening the dashboard full screen');
    assert(manifest.dir === 'rtl' && manifest.lang === 'fa', 'declared right-to-left');
    assert(/^#/.test(manifest.theme_color) && /^#/.test(manifest.background_color), 'with real colours, not placeholders');
    assert(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 3, 'and shortcuts to the busiest pages', String(manifest.shortcuts?.length));

    const icons: Array<{ src: string; sizes: string; purpose?: string; type: string }> = manifest.icons || [];
    const png192 = icons.find((i) => i.sizes === '192x192');
    const png512 = icons.find((i) => i.sizes === '512x512' && (!i.purpose || i.purpose.includes('any')));
    const maskable = icons.find((i) => (i.purpose || '').includes('maskable'));
    assert(Boolean(png192 && png512), 'a 192 and a 512 PNG icon are declared — what Android installability needs');
    assert(Boolean(maskable), 'a maskable icon exists, so the Android launcher does not crop the mark');

    for (const icon of icons) {
      const res = await fetch(`${BASE}${icon.src}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const isPng = icon.type === 'image/png';
      // PNG magic: 89 50 4E 47 — an SVG served under a .png name would fail here.
      const magic = buf.subarray(0, 4).toString('hex') === '89504e47';
      assert(res.status === 200 && (!isPng || magic), `icon ${icon.sizes} is served${isPng ? ' as a real PNG' : ''}`, `${res.status}`);
      if (isPng) {
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        const [w, h] = icon.sizes.split('x').map(Number);
        assert(width === w && height === h, `icon ${icon.sizes} really is ${w}×${h}`, `${width}×${height}`);
      }
    }

    // --------------------------------------------------------------- shell ----
    const html = await (await fetch(`${BASE}/`)).text();
    assert(/<link rel="manifest" href="\/manifest\.webmanifest"/.test(html), 'the HTML shell links the manifest');
    assert(/apple-touch-icon[^>]+href="\/brand\/apple-touch-icon\.png"/.test(html), 'and a PNG apple-touch icon (iOS ignores SVG)');
    assert(/apple-mobile-web-app-capable" content="yes"/.test(html), 'with the iOS full-screen hint');
    const touch = await fetch(`${BASE}/brand/apple-touch-icon.png`);
    const touchBuf = Buffer.from(await touch.arrayBuffer());
    assert(touch.status === 200 && touchBuf.subarray(0, 4).toString('hex') === '89504e47', 'the apple-touch icon is a PNG', `${touch.status}`);
    assert(touchBuf.readUInt32BE(16) === 180 && touchBuf.readUInt32BE(20) === 180, 'at 180×180');

    // ------------------------------------------------------- service worker ----
    const swRes = await fetch(`${BASE}/sw.js`);
    const sw = await swRes.text();
    assert(swRes.status === 200, 'the service worker is served', `${swRes.status}`);
    assert(/javascript|ecmascript/i.test(swRes.headers.get('content-type') || ''), 'as JavaScript', String(swRes.headers.get('content-type')));
    assert(/no-cache/.test(swRes.headers.get('cache-control') || ''), 'with no-cache, so a new version is never stuck in the browser', String(swRes.headers.get('cache-control')));
    assert(swRes.headers.get('service-worker-allowed') === '/', 'and a scope header');
    assert(sw.includes("startsWith('/api/')") && sw.includes("startsWith('/scim/')"), 'the worker refuses to cache API or SCIM answers');
    assert(sw.includes('skipWaiting') && sw.includes('clients.claim'), 'and takes over a new version without a second reload');
    assert(sw.includes('/offline.html'), 'and knows the offline page');

    // ------------------------------------------------------------- offline ----
    const offlineRes = await fetch(`${BASE}/offline.html`);
    const offline = await offlineRes.text();
    assert(offlineRes.status === 200 && offline.includes('اتصال اینترنت قطع است'), 'the offline page exists in Persian', `${offlineRes.status}`);
    assert(offline.includes('dir="rtl"') && offline.includes('/brand/hovida-app-icon.svg'), 'right-to-left and branded');
    assert(offline.includes('هیچ اطلاعاتی از کارجویان روی این دستگاه ذخیره نمی‌شود'), 'and says plainly that nothing is cached locally');

    // ------------------------------------------------ an API is never a page ----
    const api = await fetch(`${BASE}/api/transcripts/status`);
    assert(api.status === 401, 'an API request still answers JSON 401, never the offline page', `${api.status}`);
    assert((api.headers.get('content-type') || '').includes('application/json'), 'with the JSON content type');

    // ------------------------------------------- the app itself still works ----
    const boot = await fetch(`${BASE}/app`);
    assert(boot.status === 200 && (await boot.text()).includes('id="root"'), 'the app shell is still served for /app', `${boot.status}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * End-to-end test of «هویت سازمانی» — per-workspace branding.
 *
 * What is proven here, against the built server:
 *   • a fresh workspace is *unbranded*: no tokens, no favicon, HOVIDA's colours;
 *   • saving a logo + colour + words + hidden nav really changes the payload
 *     the panel and the public portal receive;
 *   • a brand colour that would make a white-on-button label unreadable is
 *     corrected, and the customer is told in Persian why;
 *   • the public career page and `/login?ws=` carry the company's identity while
 *     never leaking members or whether an e-mail exists;
 *   • a hostile payload (script in SVG, javascript: URI, huge file, bogus colour,
 *     unknown nav key) is refused or sanitised, never stored;
 *   • tenant isolation: company B never sees company A's identity;
 *   • reset returns the workspace to HOVIDA exactly.
 *
 * Run with: npm run build && npx tsx scripts/branding-api.test.ts
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

const PORT = 4170 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hovida-branding-'));
const dist = path.resolve('dist/server.cjs');

// A 1×1 PNG, and an SVG that carries a script — the two ends of "is this safe?".
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const EVIL_SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');

async function main() {
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'branding-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) delete env[k];

  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  const call = async (method: string, url: string, token?: string | null, body?: unknown) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Hovida-Session': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;

    const A = await signup('آوا صنعت', 'a@example.com');
    const B = await signup('برنا تجارت', 'b@example.com');

    // ------------------------------------------------------- a fresh workspace
    const fresh = await call('GET', '/api/org/branding', A);
    assert(fresh.status === 200, 'the identity endpoint answers the owner');
    assert(fresh.json.isCustom === false, 'a new workspace carries no custom identity');
    assert(Object.keys(fresh.json.tokens || {}).length === 0, 'and receives no CSS overrides');
    assert(fresh.json.branding.colors.brand === '#2DBA4E', 'it is HOVIDA green', fresh.json.branding?.colors?.brand);
    assert(fresh.json.presets.length >= 5, 'the editor offers starting points', String(fresh.json.presets?.length));

    // ------------------------------------------------------------- save a look
    const saved = await call('PUT', '/api/org/branding', A, {
      ...fresh.json.branding,
      nickname: 'سامانهٔ استخدام آوا',
      logoDataUrl: PNG,
      markDataUrl: PNG,
      logoHeight: 40,
      colors: { brand: '#2563EB', accent: '#1E3A8A' },
      sidebar: 'dark',
      sidebarWidth: 272,
      radius: 'round',
      theme: 'light',
      font: 'system',
      login: { title: 'ورود همکاران آوا', subtitle: 'با حساب سازمانی خود وارد شوید.', background: 'mesh' },
      portal: { heading: 'به تیم آوا بپیوندید', coverDataUrl: null },
      terms: { candidate: 'متقاضی', job: 'موقعیت', interview: 'جلسه', offer: 'پیشنهاد' },
      nav: { hidden: ['payroll', 'video', 'not-a-real-key'], labels: { jobs: 'آگهی‌های استخدام' } },
      landing: 'jobs',
      showHovidaCredit: false,
    });
    assert(saved.status === 200, 'the identity saves', `${saved.status} ${JSON.stringify(saved.json?.error || '')}`);
    assert(saved.json.isCustom === true, 'the workspace is now branded');
    assert(saved.json.tokens['--color-brand'] === '#2563EB', 'the brand colour reaches the CSS token', saved.json.tokens?.['--color-brand']);
    assert([...saved.json.branding.nav.hidden].sort().join(',') === 'payroll,video', 'only real navigation keys can be hidden', saved.json.branding.nav.hidden.join(','));
    assert(saved.json.branding.terms.job === 'موقعیت', 'the workspace renamed «فرصت شغلی»');
    assert(saved.json.branding.showHovidaCredit === false, 'the white-label switch stuck');

    // ---------------------------------------------------- dashboard cards
    const cards = await call('PUT', '/api/org/branding', A, {
      ...saved.json.branding,
      hiddenCards: ['activity', 'kpis', 'not-a-card'],
    });
    assert(cards.status === 200, 'dashboard choices save');
    assert(cards.json.branding.hiddenCards.join(',') === 'activity', 'unknown cards drop, «چهار عدد اصلی» cannot be hidden', cards.json.branding.hiddenCards.join(','));

    // --------------------------------------------- readability is guaranteed
    const dark = saved.json.tokens['--color-brand-strong'];
    const lum = (hex: string) => {
      const c = (i: number) => {
        const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * c(0) + 0.7152 * c(1) + 0.0722 * c(2);
    };
    const ratio = (1.05) / (lum(dark) + 0.05);
    assert(ratio >= 4.5, 'the button shade stays readable behind white text', `${ratio.toFixed(2)}:1`);

    const pale = await call('PUT', '/api/org/branding', A, {
      ...saved.json.branding,
      colors: { brand: '#FFEE00', accent: '#1E3A8A' },
    });
    assert(pale.status === 200, 'a very pale brand colour is accepted');
    const paleStrong = pale.json.tokens['--color-brand-strong'];
    const paleRatio = 1.05 / (lum(paleStrong) + 0.05);
    assert(paleRatio >= 4.5, 'but the button shade is darkened for it', `${paleStrong} ${paleRatio.toFixed(2)}:1`);
    assert(pale.json.warnings.length > 0, 'and the customer is told, in Persian', pale.json.warnings[0]?.slice(0, 40));
    assert(/[\u0600-\u06FF]/.test(pale.json.warnings[0] || ''), 'the warning is Persian');

    // ---------------------------------------------------------- hostile input
    const evil = await call('PUT', '/api/org/branding', A, { ...pale.json.branding, logoDataUrl: EVIL_SVG });
    assert(evil.status === 400, 'an SVG with a script is refused', String(evil.status));
    const js = await call('PUT', '/api/org/branding', A, { ...pale.json.branding, logoDataUrl: 'javascript:alert(1)' });
    assert(js.status === 400, 'a javascript: URI is refused', String(js.status));
    const big = await call('PUT', '/api/org/branding', A, { ...pale.json.branding, logoDataUrl: 'data:image/png;base64,' + 'A'.repeat(600 * 1024) });
    assert(big.status === 413, 'an oversized image is refused', String(big.status));
    const badColor = await call('PUT', '/api/org/branding', A, { ...pale.json.branding, colors: { brand: 'red', accent: '#1E3A8A' } });
    assert(badColor.status === 400, 'a non-hex colour is refused', String(badColor.status));
    const memberView = await call('GET', '/api/org/branding', A);
    assert(memberView.json.branding.logoDataUrl === PNG, 'a refused save left the previous logo intact');

    // ------------------------------------------------------------- public page
    const slug = (await call('GET', '/api/org', A)).json.org.careerSlug as string;
    const portal = await call('GET', `/api/careers/${slug}`);
    assert(portal.status === 200, 'the public portal opens');
    assert(portal.json.org.branding?.colors?.brand === '#FFEE00', 'the portal wears the company colour');
    assert(portal.json.org.branding?.portal?.heading === 'به تیم آوا بپیوندید', 'and its heading');
    assert(portal.json.org.branding?.tokens?.['--color-brand'] === '#FFEE00', 'with ready-made tokens');
    assert(!JSON.stringify(portal.json).includes('a@example.com'), 'the portal never lists members');
    assert(!JSON.stringify(portal.json).includes('hidden'), 'nor the internal navigation choices');

    // --------------------------------------------------------- branded sign-in
    const ws = await call('GET', `/api/auth/workspace?ws=${slug}`);
    assert(ws.status === 200 && ws.json.workspace?.name === 'آوا صنعت', 'the sign-in screen can find the workspace', `${ws.status}`);
    assert(ws.json.workspace?.branding?.login?.title === 'ورود همکاران آوا', 'and carries the login copy');
    const unknown = await call('GET', '/api/auth/workspace?ws=nope-not-here');
    assert(unknown.json.workspace === null, 'an unknown slug simply shows nothing');
    const noSlug = await call('GET', '/api/auth/workspace');
    assert(noSlug.json.workspace === null, 'and a missing slug is not an error');

    // ------------------------------------------------------------ tenant walls
    const bView = await call('GET', '/api/org/branding', B);
    assert(bView.json.isCustom === false && !bView.json.branding.nickname, 'company B never sees company A’s identity');
    const bTry = await call('PUT', '/api/org/branding', B, { ...pale.json.branding, nickname: 'B' });
    assert(bTry.status === 200 && bTry.json.branding.colors.brand === '#FFEE00', 'B saves its own copy independently');
    const aAgain = await call('GET', '/api/org/branding', A);
    assert(aAgain.json.branding.nickname === 'سامانهٔ استخدام آوا', 'and A is untouched by it');

    // non-admins may read, not write
    const memberMade = await call('POST', '/api/org/members', A, { name: 'کارشناس', email: 'm@example.com', title: 'کارشناس', role: 'member', password: 'Password12345' });
    assert(memberMade.status === 200 || memberMade.status === 201, 'a member is added', String(memberMade.status));
    const M = (await call('POST', '/api/auth/login', null, { email: 'm@example.com', password: 'Password12345' })).json.token as string;
    const read = await call('GET', '/api/org/branding', M);
    assert(read.status === 200, 'a member can read the identity');
    const write = await call('PUT', '/api/org/branding', M, { ...read.json.branding, nickname: 'hacked' });
    assert(write.status === 403, 'but a member cannot change it', String(write.status));

    // ---------------------------------------------------------------- reset
    const reset = await call('POST', '/api/org/branding/reset', A, {});
    assert(reset.status === 200, 'reset answers');
    assert(reset.json.isCustom === false && reset.json.branding.colors.brand === '#2DBA4E', 'and returns HOVIDA’s own identity');
    const portalAfter = await call('GET', `/api/careers/${slug}`);
    assert(portalAfter.json.org.branding === null, 'the portal is plain again too');
    const wsAfter = await call('GET', `/api/auth/workspace?ws=${slug}`);
    assert(wsAfter.json.workspace === null, 'and the branded sign-in falls back silently');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll branding checks passed.' : `\n${failures} branding check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

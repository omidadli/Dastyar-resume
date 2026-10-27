/**
 * Cost guard for the Apify provider: a run that never finishes must be stopped
 * at Apify, not merely reported as failed — otherwise it keeps billing after
 * everyone closed the tab.
 *
 * The server is started with a tiny APIFY_MAX_WAIT_MS (test-only override) and a
 * stand-in Apify whose run stays RUNNING forever; the test proves the abort call
 * is really made and that the recruiters see an honest message.
 *
 * Run with: npm run build && npx tsx scripts/apify-guard.test.ts
 */
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

const TOKEN = 'apify_api_guard_token';
const calls: Array<{ method: string; path: string }> = [];

/** An Apify that starts runs and never finishes them. */
function mockApify(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    calls.push({ method: req.method || '', path: url.pathname });
    if (url.searchParams.get('token') !== TOKEN) return send(401, { error: { message: 'Invalid token' } });
    req.on('data', () => undefined);
    req.on('end', () => {
      if (url.pathname === '/v2/users/me') return send(200, { data: { username: 'guard-test' } });
      if (req.method === 'POST' && /\/v2\/acts\/[^/]+\/runs$/.test(url.pathname)) {
        return send(201, { data: { id: 'run-slow', defaultDatasetId: 'ds-slow', status: 'RUNNING' } });
      }
      if (req.method === 'POST' && url.pathname === '/v2/actor-runs/run-slow/abort') {
        return send(200, { data: { id: 'run-slow', status: 'ABORTED' } });
      }
      if (req.method === 'GET' && url.pathname === '/v2/actor-runs/run-slow') {
        // Always still running: only the app's own deadline can end this.
        return send(200, { data: { id: 'run-slow', status: 'RUNNING', defaultDatasetId: 'ds-slow' } });
      }
      if (url.pathname === '/v2/datasets/ds-slow/items') return send(200, []);
      return send(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const apify = await mockApify();
  const apifyBase = `http://127.0.0.1:${(apify.address() as any).port}/v2`;

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-guard-'));
  const PORT = 4400 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'apify-guard-secret-0123456789',
    // 120 ms instead of ten minutes: the same code path, quickly.
    APIFY_MAX_WAIT_MS: '120',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'LINKEDIN_API_URL', 'LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_API_TOKEN']) delete env[k];

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
      json = text;
    }
    return { status: res.status, json };
  };

  try {
    const admin = (await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت آزما',
      name: 'مدیر',
      email: 'admin@guard-demo.ir',
      password: 'Password12345',
    })).json.token as string;
    const code = log.match(/setup code: (HV-[A-Z0-9-]+)/)?.[1] || '';
    await call('POST', '/api/admin/claim', admin, { code });
    const savedConn = await call('PUT', '/api/admin/connections/sourcing', admin, {
      kind: 'apify',
      endpointUrl: apifyBase,
      token: TOKEN,
      actorId: 'harvestapi/linkedin-profile-search',
    });
    assert(savedConn.status === 200 && savedConn.json.sourcing.async === true, 'the Apify provider is connected', String(savedConn.status));

    const org = (await call('GET', '/api/org', admin)).json;
    const dept = org.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', admin, { departmentId: dept.id, roleTitle: 'کارشناس فروش' });
    const job = (await call('POST', '/api/jobs', admin, {
      departmentId: dept.id,
      roleTitle: 'کارشناس فروش',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    })).json.job;

    const started1 = await call('POST', '/api/sourcing/searches', admin, {
      departmentId: dept.id,
      jobId: job.id,
      prompt: 'کارشناس فروش مسلط به مذاکره',
      openToWorkOnly: true,
      limit: 10,
    });
    assert(started1.status === 202 && started1.json.search.status === 'running', 'the run starts and answers at once', `${started1.status}`);
    assert(/برآورد هزینه/.test(started1.json.search.message || ''), 'the estimated cost is shown when the run starts', String(started1.json.search.message));

    // Wait past the deadline, then read: the app must abort the run.
    await new Promise((r) => setTimeout(r, 250));
    const expired = await call('GET', `/api/sourcing/searches/${started1.json.search.id}`, admin);
    assert(expired.status === 502 && expired.json.search.status === 'error', 'a run past the deadline is a stored error', `${expired.status} ${expired.json?.search?.status}`);
    assert(/متوقف شد/.test(expired.json.search.message || ''), 'the message says the run was stopped', String(expired.json.search.message));
    assert(!/پیدا نشد/.test(expired.json.search.message || ''), 'it is never reported as «no results found»');
    assert(calls.some((c) => c.method === 'POST' && c.path === '/v2/actor-runs/run-slow/abort'), 'the run is actually aborted at Apify (no silent billing)');

    // A second poll must not start another run or keep polling the aborted one.
    const after = await call('GET', `/api/sourcing/searches/${started1.json.search.id}`, admin);
    assert(after.status === 200 && after.json.search.status === 'error', 'the finished error is not re-polled');

    // The usage counter still shows what happened.
    const status = await call('GET', '/api/integrations/status', admin);
    assert(status.json.sourcing.usage.today === 1 && status.json.sourcing.usage.dailyLimit === 20, 'the attempt is counted against the daily cap', JSON.stringify(status.json.sourcing.usage));
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    apify.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} cost-guard test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nALL PASS');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

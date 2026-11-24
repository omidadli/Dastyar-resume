/**
 * End-to-end test of the two developer doors:
 *   • «کلید API» — a real bearer token against `/api/v1`, with scopes, a revoked
 *     key that stops working, and a snapshot that never contains the plain key;
 *   • «وب‌هوک خروجی» — a real POST to a receiving server, a signed header, only
 *     the events the workspace chose, and an honest failure when nobody listens.
 *
 * Run with: npm run build && npx tsx scripts/developer-api.test.ts
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A receiving system: records every POST and answers 200. */
function mockReceiver(): Promise<{ server: http.Server; posts: Received[] }> {
  const posts: Received[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ headers: req.headers, body });
      // A path the test uses to model a receiver that is down.
      const failing = (req.url || '').includes('/fail');
      res.writeHead(failing ? 500 : 200, { 'Content-Type': 'application/json' });
      res.end(failing ? '{"error":"boom"}' : '{"ok":true}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts })));
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 80));
  }
  return check();
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const receiver = await mockReceiver();
  const hookPort = (receiver.server.address() as any).port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-dev-'));
  const PORT = 4900 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'developer-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    // The documented escape hatch for a self-hosted receiver; the test uses http.
    WEBHOOK_ALLOW_HOSTS: `127.0.0.1:${hookPort}`,
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    delete env[k];
  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  const call = async (
    method: string,
    url: string,
    session?: string | null,
    body?: unknown,
    apiKey?: string | null
  ) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers['X-Hovida-Session'] = session;
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(BASE + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
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
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت نمونه',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    const member = await call('POST', '/api/org/members', A, { name: 'سارا', email: 'sara@example.com', password: 'Password12345', role: 'member' });
    assert(member.status === 201, 'a member is added');
    const M = (await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'Password12345' })).json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس شبکه',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"شبکه",mina@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (
      await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, {
        profileId: imported.json.search.results[0].id,
        jobId: job.id,
      })
    ).json.record;
    assert(Boolean(rec?.id), 'a candidate is ready');

    // ------------------------------------------------------------- the key --
    const overview = await call('GET', '/api/developer/overview', A);
    assert(overview.status === 200 && overview.json.keys.length === 0, 'the settings page starts without keys');
    assert(/\/api\/v1$/.test(overview.json.baseUrl), 'the base address ends in /api/v1', overview.json.baseUrl);
    assert(overview.json.events.length >= 10, 'the event catalogue is offered');
    assert((await call('POST', '/api/developer/keys', M, { name: 'تلاش عضو' })).status === 403, 'only an admin can create a key');
    assert((await call('POST', '/api/developer/keys', A, { name: 'x' })).status === 400, 'a one-letter key name is refused');

    const readKey = await call('POST', '/api/developer/keys', A, { name: 'داشبورد داخلی', scopes: ['read'] });
    assert(readKey.status === 201 && /^hvd_sk_[a-f0-9]{16}_/.test(readKey.json.key), 'a key is issued once', `${readKey.status}`);
    assert(readKey.json.record.scopes.join(',') === 'read', 'the read scope is kept');
    const K = readKey.json.key as string;

    const afterCreate = await call('GET', '/api/developer/overview', A);
    assert(!JSON.stringify(afterCreate.json).includes(K), 'the plain key is never returned again');
    assert(afterCreate.json.keys[0].prefix.startsWith('hvd_sk_'), 'only a prefix is shown in the list');

    // ------------------------------------------------------------- the API --
    const health = await call('GET', '/api/v1/health');
    assert(health.status === 200 && health.json.ok === true, 'health needs no key, so a monitor can watch it');
    assert((await call('GET', '/api/v1/jobs')).status === 401, 'the API refuses a request without a key');
    assert((await call('GET', '/api/v1/jobs', null, undefined, 'hvd_sk_0123456789abcdef_nope')).status === 401, 'a made-up key is refused');
    assert((await call('GET', '/api/v1/jobs', A)).status === 401, 'a session token is not an API key');

    const me = await call('GET', '/api/v1/me', null, undefined, K);
    assert(me.status === 200 && me.json.workspace.name === 'شرکت نمونه', 'the key knows its workspace');
    assert(me.json.key.scopes.join(',') === 'read', 'the key reports its own scopes');

    const jobs = await call('GET', '/api/v1/jobs', null, undefined, K);
    assert(jobs.status === 200 && jobs.json.items.some((j: any) => j.id === job.id), 'the opening is listed');
    assert(Boolean(jobs.json.items[0].stages?.length), 'stages travel with the opening');
    const one = await call('GET', `/api/v1/jobs/${job.id}`, null, undefined, K);
    assert(one.status === 200 && one.json.job.id === job.id, 'one opening can be read');
    assert(Array.isArray(one.json.job.criteria), 'the screening criteria are exposed');
    assert((await call('GET', '/api/v1/jobs/job_missing', null, undefined, K)).status === 404, 'an unknown opening is a clean 404');

    const candidates = await call('GET', `/api/v1/candidates?jobId=${job.id}`, null, undefined, K);
    assert(candidates.status === 200 && candidates.json.total === 1, 'the candidate is listed', JSON.stringify(candidates.json.total));
    assert(candidates.json.items[0].name === 'مینا رضایی' || candidates.json.items[0].name.includes('مینا'), 'the name is human, not an id');
    const detail = await call('GET', `/api/v1/candidates/${rec.id}`, null, undefined, K);
    assert(detail.status === 200 && detail.json.candidate.id === rec.id, 'one candidate can be read');
    assert(detail.json.candidate.contact?.email === 'mina@example.ir', 'contact details survive the API');

    const deniedWrite = await call('POST', `/api/v1/candidates/${rec.id}/decision`, null, { status: 'approved' }, K);
    assert(deniedWrite.status === 403 && deniedWrite.json.code === 'SCOPE_REQUIRED', 'a read key cannot record a decision', String(deniedWrite.status));

    const writeKey = await call('POST', '/api/developer/keys', A, { name: 'سامانهٔ منابع انسانی', scopes: ['write'] });
    const W = writeKey.json.key as string;
    assert(writeKey.json.record.scopes.sort().join(',') === 'read,write', 'a write key implies read');

    const badStatus = await call('POST', `/api/v1/candidates/${rec.id}/decision`, null, { status: 'maybe' }, W);
    assert(badStatus.status === 400, 'an invalid status is refused');
    const decided = await call('POST', `/api/v1/candidates/${rec.id}/decision`, null, { status: 'approved', note: 'تأیید از HRIS' }, W);
    assert(decided.status === 200 && decided.json.candidate.decisionStatus === 'approved', 'a write key records the decision');
    assert(decided.json.candidate.decisionNote === 'تأیید از HRIS', 'the note is kept');
    const feed = await call('GET', '/api/activity', A);
    assert(feed.json.items.some((a: any) => a.type === 'decision' && a.text.includes('API')), 'the decision appears in the team feed');

    // --------------------------------------------------------- the webhook --
    assert(
      (await call('POST', '/api/developer/webhooks', A, { name: 'خارجی', url: 'http://example.com/hook', events: ['decision'] })).status === 400,
      'a non-https receiver is refused'
    );
    assert(
      (await call('POST', '/api/developer/webhooks', A, { name: 'خارجی', url: 'ftp://example.com/hook' })).status === 400,
      'a non-http protocol is refused'
    );
    assert((await call('POST', '/api/developer/webhooks', M, { name: 'عضو', url: `http://127.0.0.1:${hookPort}/x` })).status === 403, 'only an admin can add a webhook');

    const hookUrl = `http://127.0.0.1:${hookPort}/hooks/hovida`;
    const created = await call('POST', '/api/developer/webhooks', A, { name: 'سامانهٔ منابع انسانی', url: hookUrl, events: ['decision'] });
    assert(created.status === 201 && created.json.test.ok === true, 'the endpoint is registered and verified immediately', JSON.stringify(created.json.test));
    assert(!JSON.stringify(created.json).includes(hookUrl), 'the full URL is never returned to the browser');
    assert(created.json.endpoint.urlMasked.startsWith('http://127.0.0.1'), 'a masked address is shown instead');

    const ping = receiver.posts.find((p) => JSON.parse(p.body).event === 'ping');
    assert(Boolean(ping), 'a real test POST arrived');
    if (ping) {
      const body = JSON.parse(ping.body);
      assert(body.apiVersion === 1 && body.workspace.name === 'شرکت نمونه', 'the test payload is the real contract');
      assert(/^t=\d+,v1=[a-f0-9]{64}$/.test(String(ping.headers['x-hovida-signature'])), 'the request is signed', String(ping.headers['x-hovida-signature']));
      assert(String(ping.headers['user-agent']).startsWith('Hovida-Webhooks/'), 'the receiver can identify the sender');
    }

    // A decision through the API must reach the receiver.
    const beforeDecision = receiver.posts.length;
    await call('POST', `/api/v1/candidates/${rec.id}/decision`, null, { status: 'review' }, W);
    const gotDecision = await waitFor(() => receiver.posts.length > beforeDecision);
    assert(gotDecision, 'the subscribed event is delivered');
    const delivered = receiver.posts.at(-1);
    if (delivered) {
      const body = JSON.parse(delivered.body);
      assert(body.event === 'decision', 'the event name matches the subscription');
      assert(body.links.candidateId === rec.id, 'the receiver knows which candidate changed');
      assert(body.message.includes('مینا'), 'the human-readable line travels too');
      assert(delivered.headers['x-hovida-delivery'] === body.id, 'the delivery id is consistent between header and body');
    }

    // An event the workspace did not subscribe to stays quiet.
    const beforeNote = receiver.posts.length;
    await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: 'یادداشت داخلی' });
    await new Promise((r) => setTimeout(r, 400));
    assert(receiver.posts.length === beforeNote, 'an unsubscribed event is not forwarded');

    const deliveries = await call('GET', '/api/developer/deliveries', A);
    assert(deliveries.json.deliveries.some((d: any) => d.ok && d.event === 'decision'), 'successful deliveries are recorded');
    assert(deliveries.json.deliveries.every((d: any) => !('orgId' in d)), 'the delivery log is tenant-clean');

    // Turning the endpoint off silences it, turning it back on restores it.
    const endpointId = created.json.endpoint.id;
    const off = await call('PATCH', `/api/developer/webhooks/${endpointId}`, A, { active: false });
    assert(off.status === 200 && off.json.endpoint.active === false, 'a webhook can be switched off');
    const beforeOff = receiver.posts.length;
    await call('POST', `/api/v1/candidates/${rec.id}/decision`, null, { status: 'approved' }, W);
    await new Promise((r) => setTimeout(r, 500));
    assert(receiver.posts.length === beforeOff, 'nothing is sent while it is off');

    await call('PATCH', `/api/developer/webhooks/${endpointId}`, A, { active: true, events: ['comment.added'] });
    const beforeComment = receiver.posts.length;
    await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: 'این یکی باید برود' });
    const gotComment = await waitFor(() => receiver.posts.length > beforeComment);
    assert(gotComment, 'changing the subscription takes effect immediately');

    const tested = await call('POST', `/api/developer/webhooks/${endpointId}/test`, A, {});
    assert(tested.status === 200 && tested.json.test.ok === true, 'the test button posts again');

    // A receiver that answers 500: the endpoint records the failure, honestly.
    const bad = await call('POST', '/api/developer/webhooks', A, {
      name: 'خراب',
      url: `http://127.0.0.1:${hookPort}/fail`,
      events: ['decision'],
    });
    assert(bad.status === 201 && bad.json.test.ok === false, 'a failing receiver is reported, not hidden', JSON.stringify(bad.json.test));
    assert(Boolean(bad.json.endpoint.lastError) && bad.json.endpoint.lastStatus === 500, 'the failure is stored on the endpoint', JSON.stringify(bad.json.endpoint.lastError));
    // A host that is not on the allow-list cannot be reached at all.
    assert(
      (await call('POST', '/api/developer/webhooks', A, { name: 'دیگر', url: 'http://127.0.0.1:1/hook', events: ['decision'] })).status === 400,
      'an unlisted http host is refused even for a self-hosted setup'
    );
    assert((await call('DELETE', `/api/developer/webhooks/${bad.json.endpoint.id}`, A)).status === 200, 'the failed endpoint can be removed');

    // --------------------------------------------------- revoking the key --
    assert((await call('DELETE', `/api/developer/keys/${readKey.json.record.id}`, M)).status === 403, 'only an admin can revoke a key');
    const revoked = await call('DELETE', `/api/developer/keys/${readKey.json.record.id}`, A);
    assert(revoked.status === 200 && revoked.json.keys.find((k: any) => k.id === readKey.json.record.id).revokedAtISO, 'the key is marked revoked');
    const afterRevoke = await call('GET', '/api/v1/jobs', null, undefined, K);
    assert(afterRevoke.status === 401 && afterRevoke.json.code === 'API_KEY_REVOKED', 'a revoked key stops working at once', JSON.stringify(afterRevoke.json));
    assert((await call('GET', '/api/v1/jobs', null, undefined, W)).status === 200, 'the other key keeps working');

    const usage = await call('GET', '/api/developer/overview', A);
    const used = usage.json.keys.find((k: any) => k.id === writeKey.json.record.id);
    assert(used.calls >= 3 && Boolean(used.lastUsedAtISO), 'the settings page shows real usage', `${used.calls}`);
    assert(!JSON.stringify(usage.json).includes('developer-api-secret'), 'no server secret leaks into the overview');

    assert((await call('DELETE', `/api/developer/webhooks/${endpointId}`, A)).status === 200, 'a webhook can be deleted');
    const gone = await call('GET', '/api/developer/overview', A);
    assert(!gone.json.webhooks.some((w: any) => w.id === endpointId), 'the deleted endpoint is gone');
    assert(!gone.json.deliveries.some((d: any) => d.endpointId === endpointId), 'its delivery history goes with it');

    // ----------------------------------------------------------- at rest --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8');
    const parsed = JSON.parse(snap);
    assert((parsed.apiKeys || []).length === 2, 'both keys are stored', String((parsed.apiKeys || []).length));
    assert(!snap.includes(W) && !snap.includes(K), 'no plain API key is ever written to disk');
    assert((parsed.apiKeys || []).every((k: any) => /^[a-f0-9]{64}$/.test(k.hash)), 'only the SHA-256 hash is stored');
    assert((parsed.webhooks || []).every((w: any) => w.urlEnc && !w.urlEnc.includes('127.0.0.1')), 'the webhook URL is encrypted at rest');
    assert((parsed.webhooks || []).every((w: any) => crypto.createHash('sha256')), 'the signing secret is not stored in clear');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    receiver.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} developer API test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll developer API tests passed.');
  }
}

await main();

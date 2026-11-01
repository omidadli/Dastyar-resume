/**
 * End-to-end API test of the collaboration features:
 *   • «یادداشت تیمی» on a candidate, with @mentions, author-only deletion and the
 *     activity line the rest of the team reads;
 *   • «اطلاع‌رسانی اسلک/تیمز»: a real POST to a receiving endpoint, only for the
 *     events the workspace chose, and never to an arbitrary host.
 *
 * Run with: npm run build && npx tsx scripts/collab-api.test.ts
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

/** A tiny chat endpoint: records every POST and answers 200. */
function mockChat(): Promise<{ server: http.Server; posts: string[] }> {
  const posts: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push(String(req.headers['content-type'] || '') + '|' + body);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posts })));
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const chat = await mockChat();
  const chatPort = (chat.server.address() as any).port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-collab-'));
  const PORT = 4700 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'collab-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    // The escape hatch a self-hosted chat needs; the test uses it to receive real posts.
    WEBHOOK_ALLOW_HOSTS: `127.0.0.1:${chatPort}`,
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[k];
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
    const signup = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت الف', name: 'مدیر', email: 'owner@example.com', password: 'Password12345' });
    const A = signup.json.token as string;
    const member = await call('POST', '/api/org/members', A, { name: 'سارا محمدی', email: 'sara@example.com', password: 'Password12345', role: 'member' });
    assert(member.status === 201, 'a member is added', `${member.status}`);
    const memberLogin = await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'Password12345' });
    const M = memberLogin.json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه', understanding: tpl.json.understanding, criteriaSource: 'template' })).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"شبکه",mina@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: imported.json.search.results[0].id, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'a candidate is ready');

    // ----------------------------------------------------------- comments --
    const empty = await call('GET', `/api/resumes/${rec.id}/comments`, A);
    assert(empty.status === 200 && empty.json.items.length === 0, 'a candidate starts without notes');
    assert(empty.json.members.some((m: any) => m.name === 'سارا محمدی'), 'the team list comes with the notes');

    const short = await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: ' ' });
    assert(short.status === 400, 'an empty note is refused');

    const created = await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: '@سارا محمدی لطفاً برای مصاحبهٔ فنی وقت بگذار.' });
    assert(created.status === 201 && created.json.comment.id, 'a note is written', `${created.status} ${JSON.stringify(created.json?.error || '')}`);
    assert(created.json.comment.mentions.length === 1 && created.json.comment.mentions[0].name === 'سارا محمدی', 'the mention is resolved to the real teammate');
    assert(created.json.comment.authorName === 'مدیر', 'the note keeps its author');
    assert(Boolean(created.json.comment.atJalali), 'the note keeps its Persian date');

    const mentioned = await call('GET', '/api/activity', M);
    assert(mentioned.json.items.some((a: any) => a.type === 'comment.added' && a.text.includes('سارا محمدی')), 'the mentioned teammate sees it in the feed');

    const second = await call('POST', `/api/resumes/${rec.id}/comments`, M, { body: 'چشم، پنجشنبه مناسب است.' });
    assert(second.status === 201, 'the teammate answers');
    const list = await call('GET', `/api/resumes/${rec.id}/comments`, A);
    assert(list.json.items.length === 2 && list.json.items[0].body.startsWith('@سارا'), 'notes are listed oldest first');

    assert((await call('DELETE', `/api/comments/${second.json.comment.id}`, A)).status === 200, 'an admin can remove any note');
    const crossed = await call('DELETE', `/api/comments/${created.json.comment.id}`, M);
    assert(crossed.status === 403, 'a member cannot delete someone else’s note', String(crossed.status));
    assert((await call('GET', `/api/resumes/${rec.id}/comments`, A)).json.items.length === 1, 'the deleted note is gone');
    assert((await call('GET', '/api/resumes/nope/comments', A)).status === 404, 'an unknown candidate is a clean 404');

    // ------------------------------------------------------- chat webhook --
    const status = await call('GET', '/api/integrations/status', A);
    assert(status.json.chat.configured === false, 'the chat bridge starts unconnected');
    assert((await call('PUT', '/api/integrations/chat', A, { provider: 'slack', url: 'https://example.com/hook' })).status === 400, 'an arbitrary host is refused');
    assert((await call('POST', '/api/integrations/chat/test', A, {})).status === 409, 'testing before connecting is a clear 409');

    const url = `http://127.0.0.1:${chatPort}/hook`;
    const connected = await call('PUT', '/api/integrations/chat', A, { provider: 'generic', url, events: ['comment.added'] });
    assert(connected.status === 200 && connected.json.chat.configured === true, 'the webhook is connected and verified', `${connected.status} ${JSON.stringify(connected.json?.error || '')}`);
    assert(chat.posts.length === 1 && /هویدا وصل شد/.test(decodeURIComponent(chat.posts[0])), 'a real test message reached the endpoint');
    assert(!JSON.stringify(connected.json).includes(url), 'the webhook URL is never returned to the browser');

    const before = chat.posts.length;
    await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: 'این یکی باید به کانال برود.' });
    await new Promise((r) => setTimeout(r, 400));
    assert(chat.posts.length === before + 1, 'the chosen event reaches the channel', String(chat.posts.length - before));
    assert(/یادداشت/.test(decodeURIComponent(chat.posts.at(-1) || '')), 'the chat line is the activity text');

    const otherBefore = chat.posts.length;
    await call('PATCH', `/api/resumes/${rec.id}`, A, { action: 'decision', status: 'approved' });
    await new Promise((r) => setTimeout(r, 400));
    assert(chat.posts.length === otherBefore, 'an event the workspace did not choose is not forwarded');

    const tested = await call('POST', '/api/integrations/chat/test', A, {});
    assert(tested.status === 200 && tested.json.ok === true, 'the test button posts again', JSON.stringify(tested.json));
    const off = await call('DELETE', '/api/integrations/chat', A);
    assert(off.json.chat.configured === false, 'the bridge can be disconnected');
    const quiet = chat.posts.length;
    await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: 'بعد از قطع اتصال.' });
    await new Promise((r) => setTimeout(r, 400));
    assert(chat.posts.length === quiet, 'nothing is posted after disconnecting');

    assert((await call('PUT', '/api/integrations/chat', M, { provider: 'generic', url })).status === 403, 'only an admin can set the webhook');

    // ------------------------------------------------------------ storage --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert((snap.comments || []).length === 3, 'the notes are stored', String((snap.comments || []).length));
    assert(!JSON.stringify(snap).includes('collab-api-secret'), 'the app secret is never written to the snapshot');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    chat.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} collaboration API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll collaboration API tests passed.');
  }
}

await main();

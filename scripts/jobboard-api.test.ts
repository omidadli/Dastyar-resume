/**
 * End-to-end API test of «انتشار در جاب‌بورد».
 *
 * What is proven here:
 *   • the catalogue names each board's real requirement and says out loud that
 *     HOVIDA does not publish there (no hidden «auto-post» promise);
 *   • the ad copy is built from the opening itself — and says which fields the
 *     board will ask for that we do not invent;
 *   • the link in the ad is the workspace's own public page (so applications
 *     land in HOVIDA, not in the board's mailbox);
 *   • a posting is recorded with a Jalali date and a name, its state can move to
 *     live/removed, and removing keeps the record's history;
 *   • a confidential opening is invisible to a member without access, another
 *     workspace sees nothing, and the record survives a restart.
 *
 * Run with: npm run build && npx tsx scripts/jobboard-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-jobboard-'));
  const PORT = 5010 + Math.floor(Math.random() * 40);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'jobboard-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS']) delete env[k];
  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  const call = async (method: string, url: string, token?: string | null, body?: unknown) => {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Hovida-Session': token } : {}),
      },
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
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' })).json
        .token as string;
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس شبکه',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
        location: 'تهران',
        employmentType: 'full_time',
        extraNotes: 'مسلط به مسیریابی و فایروال؛ کار تیمی در تیم زیرساخت.',
      })
    ).json.job;

    // ------------------------------------------------------------ catalogue ---
    const boards = await call('GET', '/api/job-boards', A);
    assert(boards.status === 200 && boards.json.items.length >= 5, 'the board catalogue is there', String(boards.json.items?.length));
    assert(
      boards.json.items.every((b: any) => b.requires && b.requires.length > 5),
      'each board names what it needs'
    );
    assert(String(boards.json.note).includes('منتشر نمی‌کند'), 'and the catalogue says we do not post there', String(boards.json.note).slice(0, 60));
    assert(!('apiKey' in boards.json.items[0]) && !('publishUrl' in boards.json.items[0]), 'no invented write API in the payload');

    // ------------------------------------------------------------------ kit ---
    const unpublished = await call('GET', `/api/jobs/${job.id}/publication-kit?board=jobinja`, A);
    assert(unpublished.status === 200, 'the ad copy is built', String(unpublished.status));
    const kit = unpublished.json.kit;
    assert(kit.title === 'کارشناس شبکه' && kit.text.includes('کارشناس شبکه'), 'from the opening’s own title');
    assert(kit.text.includes('تهران'), 'and its location');
    assert(kit.text.includes('تیم زیرساخت'), 'and the description HR wrote');
    assert(kit.portalUrl === null && kit.text.includes('منتشر نشده'), 'while the ad is not public, it says so instead of inventing a link', String(kit.portalUrl));
    assert(kit.missing.includes('لینک درخواست (آگهی عمومی نشده)'), 'and lists the missing link among what the board will ask', JSON.stringify(kit.missing));
    assert((kit.jsonLd as any)['@type'] === 'JobPosting' && (kit.jsonLd as any).title, 'the schema.org object travels with it');
    assert((await call('GET', `/api/jobs/${job.id}/publication-kit?board=nope`, A)).status === 400, 'an unknown board is refused');

    // Publish it so the ad carries the workspace's own apply link.
    assert((await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true })).status === 200, 'the opening is published on the portal');
    const published = (await call('GET', `/api/jobs/${job.id}/publication-kit?board=jobinja`, A)).json.kit;
    assert(Boolean(published.portalUrl?.includes(`/careers/${org.careerSlug}/jobs/${job.id}`)), 'now the ad carries our own apply link', String(published.portalUrl));
    assert(published.text.includes(published.portalUrl), 'inside the pasted text, not as a footnote');
    assert(!published.missing.includes('لینک درخواست (آگهی عمومی نشده)'), 'and the missing-link warning is gone');

    // ------------------------------------------------------------- recording ---
    const empty = await call('GET', `/api/jobs/${job.id}/publications`, A);
    assert(empty.status === 200 && empty.json.items.length === 0, 'nothing is recorded before a human posts');
    assert(empty.json.readyToPost === true && empty.json.isPublic === true, 'and the opening reports itself ready to post');

    const rec = await call('POST', `/api/jobs/${job.id}/publications`, A, {
      board: 'jobinja',
      url: 'https://jobinja.ir/companies/example/jobs/123',
      note: 'بستهٔ ۳۰ روزه',
    });
    assert(rec.status === 201, 'a posting is recorded', `${rec.status} ${JSON.stringify(rec.json?.error || '')}`);
    const item = rec.json.item;
    assert(item.board === 'jobinja' && item.status === 'live', 'as a live posting on the chosen board');
    assert(Boolean(item.postedAtJalali && item.postedByName), 'with a Jalali date and a name', `${item.postedAtJalali} / ${item.postedByName}`);
    assert(rec.json.view.counts.live === 1 && rec.json.view.counts.total === 1, 'and the view counts it', JSON.stringify(rec.json.view.counts));
    assert(rec.json.view.boards.find((b: any) => b.id === 'jobinja')?.live === true, 'the board row marks it live');

    assert((await call('POST', `/api/jobs/${job.id}/publications`, A, { board: 'nope' })).status === 400, 'an unknown board cannot be recorded');
    assert((await call('POST', `/api/jobs/${job.id}/publications`, A, { board: 'quera', url: 'javascript:alert(1)' })).status === 400, 'a non-http link is refused');

    const second = await call('POST', `/api/jobs/${job.id}/publications`, A, { board: 'quera' });
    assert(second.status === 201 && second.json.item.url === null, 'a posting without a link is allowed (some boards give none yet)');

    // Status changes keep the record.
    const removed = await call('PATCH', `/api/publications/${item.id}`, A, { status: 'removed' });
    assert(removed.status === 200 && removed.json.item.status === 'removed', 'the posting can be marked removed', String(removed.status));
    assert(Boolean(removed.json.item.closedAtISO), 'with the moment it was taken down');
    // The Quera row is still live; only the Jobinja one was taken down.
    assert(removed.json.view.counts.live === 1 && removed.json.view.counts.removed === 1, 'and the counts follow', JSON.stringify(removed.json.view.counts));
    assert((await call('PATCH', `/api/publications/${item.id}`, A, { status: 'weird' })).json.item.status === 'removed', 'an unknown status is ignored, not stored');
    assert((await call('PATCH', `/api/publications/${item.id}`, A, { url: 'ftp://x' })).status === 400, 'a non-http link update is refused');

    const feed = (await call('GET', '/api/activity', A)).json.items as any[];
    assert(feed.some((a) => String(a.text).includes('ثبت کرد')), 'recording a posting is in the workspace history');

    // ------------------------------------------------------------- isolation ---
    assert((await call('GET', `/api/jobs/${job.id}/publications`, B)).status === 403 || (await call('GET', `/api/jobs/${job.id}/publications`, B)).status === 404, 'another workspace has no access to this opening');
    assert((await call('PATCH', `/api/publications/${item.id}`, B, { status: 'live' })).status === 404, 'nor to our posting');

    // A confidential opening disappears for a member without access.
    await call('POST', '/api/org/members', A, { name: 'کاوه', email: 'kave@example.com', password: 'Password12345', role: 'member' });
    const K = (await call('POST', '/api/auth/login', null, { email: 'kave@example.com', password: 'Password12345' })).json.token as string;
    assert((await call('GET', `/api/jobs/${job.id}/publications`, K)).status === 200, 'a member of the workspace sees the board of an open opening');
    const lock = await call('PUT', `/api/jobs/${job.id}/access`, A, {
      accessMode: 'restricted',
      allowedUserIds: [org.createdBy || (await call('GET', '/api/org', A)).json.members.find((m: any) => m.role === 'owner').id],
    });
    assert(lock.status === 200, 'the opening can be made confidential', String(lock.status));
    assert((await call('GET', `/api/jobs/${job.id}/publications`, K)).status === 403, 'and its postings are then closed to that member');

    // --------------------------------------------------------------- restart ---
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    log = '';
    child2.stdout.on('data', (d) => (log += d));
    child2.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));
    const afterRestart = await call('GET', `/api/jobs/${job.id}/publications`, A);
    assert(afterRestart.status === 200 && afterRestart.json.items.length === 2, 'the record survives a restart', JSON.stringify(afterRestart.json?.counts));
    assert(afterRestart.json.items.some((i: any) => i.status === 'removed'), 'including what was taken down');
    child2.kill();
  } catch (err) {
    console.error('FAIL  the job-board test stopped on an error:', err);
    failures++;
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} job-board test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll job-board tests passed.');
  }
}

await main();

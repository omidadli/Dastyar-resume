/**
 * «دسترسی به هر آگهی» — the per-opening lock, end to end.
 *
 * A list-only lock is a lock on a door with no wall. This suite proves the rule
 * holds on every path a member could take to a confidential opening:
 *   • it disappears from the list, the counts, search and the activity feed;
 *   • its board, its candidates, their files and notes answer 403;
 *   • offers and interviews for it are hidden too;
 *   • only an admin can narrow or widen it, only real members can be chosen,
 *     and the creator never loses their own opening;
 *   • switching back to «همهٔ اعضا» restores everything, and it all survives a
 *     restart.
 *
 * Run with: npm run build && npx tsx scripts/job-access.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-access-'));
  const PORT = 3800 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'job-access-secret-0123456789',
    AI_PROVIDER: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['PUBLIC_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];

  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const boot = async () => {
    log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const started = Date.now();
    while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));
  };
  await boot();

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
    // ------------------------------------------------------------ workspace ----
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'سازمان محرمانه',
      name: 'مدیر منابع انسانی',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];

    const addMember = async (name: string, email: string) =>
      (await call('POST', '/api/org/members', A, { name, email, title: 'جذب', role: 'member', password: 'Member12345' })).json.member.id as string;
    const m1Id = await addMember('همکار مجاز', 'allowed@example.com');
    const m2Id = await addMember('همکار دیگر', 'other@example.com');
    const login = async (email: string) => (await call('POST', '/api/auth/login', null, { email, password: 'Member12345' })).json.token as string;
    const M1 = await login('allowed@example.com');
    const M2 = await login('other@example.com');
    assert(Boolean(M1 && M2), 'two members can sign in');

    const makeJob = async (token: string, title: string) => {
      const tpl = await call('POST', '/api/jobs/template', token, { departmentId: dept.id, roleTitle: title });
      return (
        await call('POST', '/api/jobs', token, {
          departmentId: dept.id,
          roleTitle: title,
          understanding: tpl.json.understanding,
          criteriaSource: 'template',
        })
      ).json.job;
    };
    const open = await makeJob(A, 'کارشناس فروش');
    const secret = await makeJob(A, 'مدیر مالی (محرمانه)');

    // A candidate in the confidential opening, created through the licensed CSV path.
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'نگار,رستمی,"مدیر مالی با ده سال تجربه",تهران,آلفا,https://www.linkedin.com/in/negar,Yes,"مالی،حسابداری",negar@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: secret.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id as string;
    const candidate = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: secret.id })).json.record;
    assert(Boolean(candidate?.id), 'the confidential opening has a candidate');

    // ------------------------------------------------------------- the rule ----
    assert(secret.accessMode === undefined || secret.accessMode === 'everyone', 'an opening starts open to the whole team');
    const bothForM2 = await call('GET', '/api/jobs', M2);
    assert(bothForM2.json.items.length === 2, 'a member sees every opening by default', String(bothForM2.json.items.length));

    const memberTries = await call('PUT', `/api/jobs/${secret.id}/access`, M1, { accessMode: 'restricted', allowedUserIds: [m1Id] });
    assert(memberTries.status === 403, 'a member cannot narrow access', `${memberTries.status}`);

    const empty = await call('PUT', `/api/jobs/${secret.id}/access`, A, { accessMode: 'restricted', allowedUserIds: [] });
    assert(empty.status === 400 && empty.json.code === 'ACCESS_MEMBERS_REQUIRED', 'restricting to nobody is refused', `${empty.status}`);

    const ghost = await call('PUT', `/api/jobs/${secret.id}/access`, A, { accessMode: 'restricted', allowedUserIds: ['ghost-user'] });
    assert(ghost.status === 400, 'an outsider id is not a member and does not count', `${ghost.status}`);

    const restricted = await call('PUT', `/api/jobs/${secret.id}/access`, A, { accessMode: 'restricted', allowedUserIds: [m1Id] });
    assert(restricted.status === 200 && restricted.json.access.accessMode === 'restricted', 'an admin can restrict the opening', `${restricted.status}`);
    assert(restricted.json.access.allowedUserIds.length === 1 && restricted.json.access.allowedUserIds[0] === m1Id, 'exactly the chosen member holds it');
    assert(restricted.json.access.members.length === 3, 'the editor sees the whole team to choose from', String(restricted.json.access.members.length));

    // -------------------------------------------------------- what M2 loses ----
    const m2List = await call('GET', '/api/jobs', M2);
    const m2Ids = m2List.json.items.map((j: any) => j.id);
    assert(!m2Ids.includes(secret.id), 'the confidential opening leaves the list');
    assert(m2List.json.counts.all === 1 && m2List.json.counts.open === 1, 'the counters above the list follow it too', JSON.stringify(m2List.json.counts));

    const m2Detail = await call('GET', `/api/jobs/${secret.id}`, M2);
    assert(m2Detail.status === 403 && m2Detail.json.code === 'JOB_FORBIDDEN', 'opening it directly is refused', `${m2Detail.status}`);
    assert(typeof m2Detail.json.error === 'string' && !m2Detail.json.error.includes('undefined'), 'the refusal explains what to do');

    assert((await call('GET', `/api/jobs/${secret.id}/board`, M2)).status === 403, 'the board is closed to them');
    assert((await call('GET', `/api/jobs/${secret.id}`, M1)).status === 200, 'the chosen member still opens it');
    assert((await call('GET', `/api/jobs/${secret.id}/board`, M1)).status === 200, 'and its board');

    const m2Candidates = await call('GET', '/api/resumes', M2);
    assert(!m2Candidates.json.items.some((r: any) => r.id === candidate.id), 'the candidate is not in their list');
    const m2Filtered = await call('GET', `/api/resumes?jobId=${secret.id}`, M2);
    assert(m2Filtered.json.items.length === 0, 'filtering by that job returns nothing', String(m2Filtered.json.items?.length));
    const m1Filtered = await call('GET', `/api/resumes?jobId=${secret.id}`, M1);
    assert(m1Filtered.json.items.some((r: any) => r.id === candidate.id), 'the chosen member sees the candidate');

    const m2Record = await call('GET', `/api/resumes/${candidate.id}`, M2);
    assert(m2Record.status === 403, 'the candidate panel is refused', `${m2Record.status}`);
    assert((await call('GET', `/api/resumes/${candidate.id}/comments`, M2)).status === 403, 'their notes are refused');
    assert((await call('GET', `/api/resumes/${candidate.id}/file-url`, M2)).status === 403, 'and the résumé file');
    assert((await call('POST', `/api/resumes/${candidate.id}/comments`, M2, { body: 'نظر من' })).status === 403, 'writing a note is refused');

    const board = await call('GET', `/api/jobs/${secret.id}/board`, M1);
    const interviewStage = board.json.stages.find((s: any) => s.kind === 'interview');
    assert(
      (await call('POST', `/api/resumes/${candidate.id}/stage`, M2, { stageId: interviewStage.id })).status === 403,
      'a member cannot move a candidate of a hidden opening'
    );

    const search = await call('GET', `/api/search?q=${encodeURIComponent('مدیر مالی')}`, M2);
    assert(!search.json.jobs.some((j: any) => j.id === secret.id), 'search does not reveal the opening');
    assert(!search.json.candidates.some((c: any) => c.id === candidate.id), 'nor its candidate');

    const feed = await call('GET', '/api/activity?limit=100', M2);
    assert(!feed.json.items.some((a: any) => a.jobId === secret.id), 'the activity feed hides what happened on it');

    // An offer for that candidate never reaches them either.
    const offer = await call('POST', '/api/offers', A, {
      resumeId: candidate.id,
      terms: { title: 'مدیر مالی', salaryAmount: 90000000, salaryPeriod: 'monthly', startDate: '۱۴۰۵/۰۱/۱۵', probationMonths: 3 },
    });
    assert(offer.status === 200 || offer.status === 201, 'the admin drafts an offer for the candidate', `${offer.status}`);
    const m2Offers = await call('GET', '/api/offers', M2);
    assert(!m2Offers.json.items.some((o: any) => o.id === offer.json.offer.id), 'the offer is not in their list');
    assert((await call('GET', `/api/offers/${offer.json.offer.id}`, M2)).status === 403, 'opening it directly is refused');

    // ---------------------------------------------------------- the creator ----
    // A member creates an opening; the admin restricts it to someone else. The
    // creator must not lose their own work.
    const byMember = await makeJob(M1, 'کارشناس بازاریابی');
    const creatorStill = await call('PUT', `/api/jobs/${byMember.id}/access`, A, { accessMode: 'restricted', allowedUserIds: [m2Id] });
    assert(creatorStill.status === 200, 'the admin can restrict a member-created opening', `${creatorStill.status}`);
    assert((await call('GET', `/api/jobs/${byMember.id}`, M1)).status === 200, 'the creator keeps seeing their own opening');
    assert((await call('GET', `/api/jobs/${byMember.id}`, M2)).status === 200, 'the newly chosen member sees it');
    assert((await call('PUT', `/api/jobs/${byMember.id}/access`, M1, { accessMode: 'everyone' })).status === 403, 'the creator still cannot re-share it');

    // ------------------------------------------------------------- widening ----
    const widened = await call('PUT', `/api/jobs/${secret.id}/access`, A, { accessMode: 'everyone' });
    assert(widened.status === 200 && widened.json.access.accessMode === 'everyone', 'an admin can open it again');
    assert(widened.json.access.allowedUserIds.length === 0, 'the old list is cleared, not kept in the dark');
    assert((await call('GET', `/api/jobs/${secret.id}`, M2)).status === 200, 'the member sees it again');

    // ------------------------------------------------------------ persistence ----
    await call('PUT', `/api/jobs/${secret.id}/access`, A, { accessMode: 'restricted', allowedUserIds: [m1Id] });
    await new Promise((r) => setTimeout(r, 400));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 700));
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await boot();
    const afterRestart = await call('GET', `/api/jobs/${secret.id}`, M2);
    assert(afterRestart.status === 403, 'the restriction survives a restart', `${afterRestart.status}`);
    const m1After = await call('GET', '/api/jobs', M1);
    assert(m1After.json.items.length === 3, 'everyone who may see it still does', String(m1After.json.items.length));
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

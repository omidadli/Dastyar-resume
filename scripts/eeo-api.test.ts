/**
 * «برابری فرصت‌ها» — voluntary self-identification, aggregate-only reporting.
 *
 * The rules this suite pins down:
 *   • off by default; nobody's data is collected until HR turns it on;
 *   • the answer is **never** returned in any candidate payload (list, panel,
 *     reveal, blind mode) — not to a member, not to an admin;
 *   • declining is a real answer and unknown values never become a guess;
 *   • the report suppresses small cells and says in words when data is thin;
 *   • only an admin can read the report or change the setting.
 *
 * Run with: npm run build && npx tsx scripts/eeo-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-eeo-'));
  const PORT = 4200 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'eeo-secret-0123456789',
    AI_PROVIDER: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['PUBLIC_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];
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
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'سازمان برابری',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];

    const member = await call('POST', '/api/org/members', A, { name: 'عضو', email: 'member@example.com', title: 'جذب', role: 'member', password: 'Member12345' });
    const ML = (await call('POST', '/api/auth/login', null, { email: 'member@example.com', password: 'Member12345' })).json.token as string;
    assert(member.status === 201 && Boolean(ML), 'a member exists');

    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس محصول' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس محصول',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });
    await call('PUT', '/api/careers/settings', A, { slug: 'eeo-portal' });

    const apply = async (email: string, eeo?: Record<string, string>) =>
      call('POST', `/api/careers/eeo-portal/jobs/${job.id}/apply`, null, {
        name: 'کارجو',
        email,
        phone: '09121234567',
        city: 'تهران',
        message: '',
        text: 'سابقهٔ کار در محصول، سه سال، آشنایی با تحلیل داده و گفت‌وگو با مشتری.',
        consent: true,
        eeo,
      });

    // ---------------------------------------------------------- off by default ----
    const page = await call('GET', '/api/careers/eeo-portal');
    assert(page.json.portal.eeoEnabled === false, 'the portal does not ask for self-identification by default');
    const report0 = await call('GET', '/api/reports/eeo?range=all', A);
    assert(report0.status === 200 && report0.json.enabled === false, 'the report exists and says it is off', `${report0.status}`);

    await apply('off@example.com', { gender: 'woman', ageBand: '25-34', disability: 'no' });
    const offReport = await call('GET', '/api/reports/eeo?range=all', A);
    assert(offReport.json.total === 1 && offReport.json.disclosed === 0, 'a switched-off form stores nothing', `${offReport.json.disclosed}`);

    // ------------------------------------------------------------- turning on ----
    const memberTry = await call('PATCH', '/api/org', ML, { eeo: { enabled: true, threshold: 5 } });
    assert(memberTry.status === 403, 'a member cannot enable collection', `${memberTry.status}`);
    const memberRead = await call('GET', '/api/reports/eeo?range=all', ML);
    assert(memberRead.status === 403, 'nor read the report', `${memberRead.status}`);

    const on = await call('PATCH', '/api/org', A, { eeo: { enabled: true, threshold: 5 } });
    assert(on.status === 200 && on.json.org.eeo.enabled === true, 'an admin enables it', `${on.status}`);
    assert(on.json.org.eeo.threshold === 5, 'with a suppression floor');
    const clamp = await call('PATCH', '/api/org', A, { eeo: { enabled: true, threshold: 0 } });
    assert(clamp.json.org.eeo.threshold >= 2, 'a floor below two is not accepted', String(clamp.json.org.eeo.threshold));
    // The floor stays at five for now: two women are below it.
    await call('PATCH', '/api/org', A, { eeo: { enabled: true, threshold: 5 } });

    const page2 = await call('GET', '/api/careers/eeo-portal');
    assert(page2.json.portal.eeoEnabled === true, 'the public form now offers the optional block');

    // ------------------------------------------------------- answers are stored ----
    const answers = [
      { email: 'a@example.com', eeo: { gender: 'woman', ageBand: '25-34', disability: 'no' } },
      { email: 'b@example.com', eeo: { gender: 'woman', ageBand: '35-44', disability: 'no' } },
      { email: 'c@example.com', eeo: { gender: 'man', ageBand: '25-34', disability: 'undisclosed' } },
      { email: 'd@example.com', eeo: { gender: 'undisclosed', ageBand: 'undisclosed', disability: 'undisclosed' } },
      { email: 'e@example.com' },
    ];
    for (const a of answers) {
      const r = await apply(a.email, a.eeo);
      assert(r.status === 200, `application ${a.email} accepted`, `${r.status}`);
    }

    const stored = await call('GET', '/api/reports/eeo?range=all', A);
    assert(stored.json.total === 6, 'every application counts, disclosed or not', String(stored.json.total));
    assert(stored.json.disclosed === 4, 'four people answered something', String(stored.json.disclosed));
    const gender = stored.json.dimensions.find((d: any) => d.dimension === 'gender');
    const woman = gender.cells.find((c: any) => c.key === 'woman');
    assert(woman.applied === 2, 'two women applied', String(woman.applied));
    assert(woman.hidden === true && woman.hireRate === null, 'a group below the floor has no percentage and no count', JSON.stringify(woman));
    const age = stored.json.dimensions.find((d: any) => d.dimension === 'ageBand');
    assert(age.cells.some((c: any) => c.key === 'undisclosed' && c.applied === 1), '«ترجیح می‌دهم نگویم» is its own answer');
    assert(stored.json.dimensions.every((d: any) => d.cells.every((c: any) => !c.hidden || c.hired === 0)), 'hidden cells never leak a hire count');
    assert(stored.json.note.includes('بیشتری'), 'the report says plainly that the data is thin', stored.json.note.slice(0, 40));

    // ------------------------------------------ never next to a name, blind or not ----
    const list = await call('GET', '/api/resumes?pageSize=50', A);
    assert(list.json.items.length === 6, 'six candidates in the pipeline', String(list.json.items?.length));
    assert(list.json.items.every((r: any) => !('eeo' in r)), 'no candidate in the list carries the answer');
    const oneId = list.json.items[0].id;
    const panel = await call('GET', `/api/resumes/${oneId}`, A);
    assert(!('eeo' in panel.json.record), 'the candidate panel does not carry it either');
    assert(!panel.text.includes('"eeo"'), 'and neither does the raw JSON');

    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindPanel = await call('GET', `/api/resumes/${oneId}`, A);
    assert(!('eeo' in blindPanel.json.record), 'blind mode does not reveal it either');
    const blindList = await call('GET', '/api/resumes?pageSize=50', A);
    assert(blindList.json.items.every((r: any) => !('eeo' in r)), 'nor the blind list');
    await call('PATCH', '/api/org', A, { blindScreening: false });

    await call('POST', `/api/resumes/${oneId}/reveal`, A, { reason: 'آزمون' });
    const revealed = await call('GET', `/api/resumes/${oneId}`, A);
    assert(!('eeo' in revealed.json.record), 'revealing identity does not reveal the diversity answer');

    // ------------------------------------------------------------- suppression ----
    // Lower the floor to two: the same group is now a real number.
    await call('PATCH', '/api/org', A, { eeo: { enabled: true, threshold: 2 } });
    const lowered = await call('GET', '/api/reports/eeo?range=all', A);
    const woman2 = lowered.json.dimensions.find((d: any) => d.dimension === 'gender').cells.find((c: any) => c.key === 'woman');
    assert(woman2.applied === 2 && woman2.hidden === false, 'above the floor the group is shown', JSON.stringify(woman2));
    assert(woman2.hireRate === 0, 'and its hire rate is a real number', String(woman2.hireRate));

    // Switching it off stops collecting new answers — checked after a restart, so
    // the public form's rate limit does not stand in the way.
    const off = await call('PATCH', '/api/org', A, { eeo: { enabled: false, threshold: 2 } });
    assert(off.json.org.eeo.enabled === false, 'collection can be switched off again');
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '';
    child2.stdout.on('data', (d) => (log2 += d));
    child2.stderr.on('data', (d) => (log2 += d));
    const t2 = Date.now();
    while (!/آماده است/.test(log2) && Date.now() - t2 < 25_000) await new Promise((r) => setTimeout(r, 150));
    const lateApply = await call('POST', `/api/careers/eeo-portal/jobs/${job.id}/apply`, null, {
      name: 'کارجو',
      email: 'late@example.com',
      phone: '09121234567',
      city: 'تهران',
      message: '',
      text: 'سابقهٔ کار در محصول، سه سال، آشنایی با تحلیل داده و گفت‌وگو با مشتری.',
      consent: true,
      eeo: { gender: 'woman', ageBand: '25-34', disability: 'no' },
    });
    assert(lateApply.status === 200, 'the portal still accepts applications', `${lateApply.status}`);
    const afterOff = await call('GET', '/api/reports/eeo?range=all', A);
    assert(afterOff.json.total === 7 && afterOff.json.disclosed === 4, 'a late application stores no new answer', `${afterOff.json.total}/${afterOff.json.disclosed}`);
    assert(afterOff.json.note.includes('خاموش'), 'the report explains why it is empty');
    child2.kill('SIGTERM');
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

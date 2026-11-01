/**
 * «پورتال دوزبانه» — the public career portal in Persian and English.
 *
 * The point of this suite is the honest part: the chrome follows the chosen
 * language, but the employer's words are never machine-translated behind their
 * back. A posting with an English version shows it; a Persian-only posting says
 * so, and the portal metadata tells search engines both pages are the same job.
 *
 * Run with: npm run build && npx tsx scripts/portal-langs.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-lang-'));
  const PORT = 4000 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'portal-lang-secret-0123456789',
    AI_PROVIDER: 'off',
    PUBLIC_URL: BASE,
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];
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
    return { status: res.status, json, text, headers: res.headers };
  };

  try {
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت دوزبانه',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];

    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'مهندس بک‌اند' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'مهندس بک‌اند',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });

    // ------------------------------------------------------- default: Persian ----
    await call('PUT', '/api/careers/settings', A, { slug: 'bilingual', about: 'ما یک تیم محصول هستیم.' });
    const faPage = await call('GET', '/api/careers/bilingual');
    assert(faPage.status === 200, 'the public portal answers', `${faPage.status}`);
    assert(JSON.stringify(faPage.json.portal.languages) === '["fa"]', 'Persian is the only language by default', JSON.stringify(faPage.json.portal));
    assert(faPage.json.portal.defaultLang === 'fa', 'and it is the landing language');
    assert(faPage.json.jobs[0].titleEn === null, 'a Persian-only posting has no English title');

    // ------------------------------------------------------ turning English on ----
    const member = await call('POST', '/api/org/members', A, { name: 'عضو', email: 'member@example.com', title: 'جذب', role: 'member', password: 'Member12345' });
    assert(member.status === 201, 'a member exists to test permissions', `${member.status}`);
    const ML = (await call('POST', '/api/auth/login', null, { email: 'member@example.com', password: 'Member12345' })).json.token as string;
    const memberTry = await call('PUT', '/api/careers/settings', ML, { slug: 'bilingual', about: 'x', languages: ['fa', 'en'] });
    assert(memberTry.status === 403, 'a member cannot switch the portal language', `${memberTry.status}`);

    const turnedOn = await call('PUT', '/api/careers/settings', A, { slug: 'bilingual', about: 'ما یک تیم محصول هستیم.', languages: ['fa', 'en'], defaultLang: 'en' });
    assert(turnedOn.status === 200, 'the admin enables English', `${turnedOn.status}`);
    assert(JSON.stringify(turnedOn.json.careers.languages) === '["fa","en"]', 'both languages are stored', JSON.stringify(turnedOn.json.careers.languages));
    assert(turnedOn.json.careers.defaultLang === 'en', 'and English can be the landing language');

    const publicOn = await call('GET', '/api/careers/bilingual');
    assert(publicOn.json.portal.languages.includes('en'), 'the public page knows English exists');
    assert(publicOn.json.portal.defaultLang === 'en', 'and lands on English');

    // An English default without the language enabled must not survive.
    const weird = await call('PUT', '/api/careers/settings', A, { slug: 'bilingual', about: 'x', languages: ['fa'], defaultLang: 'en' });
    assert(weird.json.careers.defaultLang === 'fa', 'an English default without English falls back to Persian');
    await call('PUT', '/api/careers/settings', A, { slug: 'bilingual', about: 'ما یک تیم محصول هستیم.', languages: ['fa', 'en'], defaultLang: 'fa' });

    // ---------------------------------------------------- the English version ----
    const english = await call('PATCH', `/api/jobs/${job.id}`, A, {
      titleEn: 'Senior Backend Engineer',
      descriptionEn: 'You will own our billing service and help the team grow.',
    });
    assert(english.status === 200, 'the recruiter writes the English version', `${english.status}`);
    const bilingualJob = (await call('GET', '/api/careers/bilingual/jobs/' + job.id)).json.job;
    assert(bilingualJob.titleEn === 'Senior Backend Engineer', 'the English title is on the public job', String(bilingualJob.titleEn));
    assert(bilingualJob.descriptionEn.includes('billing service'), 'the English body too');
    assert(bilingualJob.roleTitle === 'مهندس بک‌اند', 'the Persian original is untouched');

    // Structured data tells aggregators which language they are reading.
    const ld = await call('GET', `/careers/bilingual/jobs/${job.id}`);
    const ldMatch = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(ld.text);
    assert(Boolean(ldMatch), 'the job page carries structured data');
    if (ldMatch) {
      const data = JSON.parse(ldMatch[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
      assert(data.title === 'Senior Backend Engineer', 'JobPosting uses the employer’s English title', String(data.title));
      assert(data.inLanguage === 'en', 'and declares its language', String(data.inLanguage));
    }

    // hreflang: two languages describe the same posting, without duplicating it.
    const faHead = await call('GET', '/careers/bilingual/jobs/' + job.id);
    assert(faHead.text.includes('hreflang="en"'), 'the page announces an English alternate');
    assert(faHead.text.includes('hreflang="x-default"'), 'and a default alternate');
    assert(faHead.text.includes(`/careers/bilingual/jobs/${job.id}?lang=en`), 'pointing at this very posting');

    // ------------------------------------------------- a Persian-only posting ----
    const tpl2 = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس پشتیبانی' });
    const job2 = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس پشتیبانی',
        understanding: tpl2.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    await call('POST', `/api/jobs/${job2.id}/publish`, A, { isPublic: true });
    const page2 = await call('GET', '/api/careers/bilingual');
    const second = page2.json.jobs.find((j: any) => j.id === job2.id);
    assert(second.titleEn === null, 'the second posting has no English title, and none is invented');
    const detail2 = (await call('GET', `/api/careers/bilingual/jobs/${job2.id}`)).json.job;
    assert(detail2.titleEn === null && detail2.descriptionEn === null, 'no machine translation is served');

    // Clearing the English version restores the honest fallback.
    await call('PATCH', `/api/jobs/${job.id}`, A, { titleEn: '', descriptionEn: '' });
    const cleared = (await call('GET', `/api/careers/bilingual/jobs/${job.id}`)).json.job;
    assert(cleared.titleEn === null && cleared.descriptionEn === null, 'the English version can be withdrawn');

    // ------------------------------------------------------------- persistence ----
    await call('PATCH', `/api/jobs/${job.id}`, A, { titleEn: 'Senior Backend Engineer' });
    await new Promise((r) => setTimeout(r, 400));
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '';
    child2.stdout.on('data', (d) => (log2 += d));
    child2.stderr.on('data', (d) => (log2 += d));
    const t2 = Date.now();
    while (!/آماده است/.test(log2) && Date.now() - t2 < 25_000) await new Promise((r) => setTimeout(r, 150));
    const after = await call('GET', '/api/careers/bilingual');
    assert(after.json.portal.languages.includes('en'), 'the language setting survives a restart');
    const jobAfter = after.json.jobs.find((j: any) => j.id === job.id);
    assert(jobAfter.titleEn === 'Senior Backend Engineer', 'and so does the English title');
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

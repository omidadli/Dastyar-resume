/**
 * «گوگل برای مشاغل» — schema.org JobPosting on the public career portal.
 *
 * A job board that search engines cannot read is a page nobody finds. This
 * suite proves the markup is real (not a mock), matches the page, disappears
 * with the opening, and never advertises an expired job:
 *   • JSON-LD is in the HTML the crawler gets (server-rendered <head>);
 *   • every field comes from the workspace's own data;
 *   • a deadline becomes `validThrough` and closes the form afterwards;
 *   • the JSON endpoint and the sitemap say the same thing;
 *   • a description cannot break out of the <script> block.
 *
 * Run with: npm run build && npx tsx scripts/jobposting-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatJalaliDate } from '../src/utils/jalali';
import { gregorianToJalali } from '../src/utils/jalali';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** A Jalali date `days` from today (negative = in the past). */
function jalaliOffset(days: number): string {
  const d = new Date(Date.now() + days * 24 * 3600 * 1000);
  return formatJalaliDate(gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate()), false);
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-jp-'));
  const PORT = 3700 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'jobposting-api-secret-0123456789',
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
    return { status: res.status, json, text, type: res.headers.get('content-type') || '' };
  };

  /** Pull the JobPosting JSON out of an HTML page. */
  const ldFrom = (html: string): any[] => {
    const out: any[] = [];
    for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      try {
        const parsed = JSON.parse(m[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>'));
        out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        out.push({ __unparsable: m[1].slice(0, 80) });
      }
    }
    return out;
  };

  try {
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت نمونهٔ فناوری',
      name: 'مدیر منابع انسانی',
      email: 'hr@example.com',
      password: 'Hr12345678',
    });
    const A = signup.json.token as string;
    assert(Boolean(A), 'a workspace can sign up');

    const careers = await call('PUT', '/api/careers/settings', A, { slug: 'sample-tech', about: 'ما محصول می‌سازیم.' });
    assert(careers.status === 200 && careers.json.careers.slug === 'sample-tech', 'the portal gets a public address', `${careers.status}`);

    const org = await call('GET', '/api/org', A);
    const dept = org.json.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد فروش' });
    const created = await call('POST', '/api/jobs', A, {
      departmentId: dept.id,
      roleTitle: 'کارشناس ارشد فروش',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
      location: 'تهران',
      employmentType: 'full-time',
      extraNotes: 'فروش سازمانی B2B.\n\nشرایط:\n- آشنایی با CRM\n- سابقهٔ ۳ سال',
    });
    const job = created.json.job;
    assert(Boolean(job?.id), 'a job is created');

    // ------------------------------------------------- before publishing ----
    const hiddenJson = await call('GET', '/careers/sample-tech/job-posting.json');
    assert(hiddenJson.status === 200 && hiddenJson.json.count === 0, 'an unpublished opening is not advertised', String(hiddenJson.json?.count));
    const hiddenPage = await call('GET', '/careers/sample-tech');
    assert(!hiddenPage.text.includes('application/ld+json'), 'and the portal page carries no JobPosting markup yet');
    assert(hiddenPage.text.includes('<!doctype html>') || hiddenPage.text.toLowerCase().includes('<!doctype html>'), 'the portal still serves the app shell');

    // ------------------------------------------------------------ publish ----
    const published = await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });
    assert(published.status === 200, 'the opening can be published', `${published.status}`);

    const detailPage = await call('GET', `/careers/sample-tech/jobs/${job.id}`);
    const detailLd = ldFrom(detailPage.text);
    const posting = detailLd.find((x) => x['@type'] === 'JobPosting');
    assert(Boolean(posting), 'the job page carries JobPosting JSON-LD in the HTML (server-rendered)');
    assert(posting?.['@context'] === 'https://schema.org', 'the @context is schema.org');
    assert(posting?.title === 'کارشناس ارشد فروش', 'the title is the job title', String(posting?.title));
    assert(posting?.hiringOrganization?.name === 'شرکت نمونهٔ فناوری', 'the employer is named');
    assert(posting?.hiringOrganization?.sameAs === `${BASE}/careers/sample-tech`, 'the employer links to its own career page', String(posting?.hiringOrganization?.sameAs));
    assert(posting?.jobLocation?.address?.addressCountry === 'IR' && posting?.jobLocation?.address?.addressLocality === 'تهران', 'the location is a real IR address', JSON.stringify(posting?.jobLocation));
    assert(posting?.employmentType?.[0] === 'FULL_TIME', 'full-time maps to FULL_TIME', JSON.stringify(posting?.employmentType));
    assert(posting?.directApply === true, 'the application happens on this page (directApply)');
    assert(posting?.identifier?.value === job.id, 'the identifier is the opening id');
    assert(posting?.url === `${BASE}/careers/sample-tech/jobs/${job.id}`, 'the canonical url points at the page', String(posting?.url));
    assert(typeof posting?.description === 'string' && posting.description.includes('<ul>'), 'the description keeps the bullet list as HTML', String(posting?.description).slice(0, 60));
    assert(Boolean(posting?.datePosted), 'datePosted is stamped on publish');
    assert(detailPage.text.includes('<title>کارشناس ارشد فروش — شرکت نمونهٔ فناوری</title>'), 'the page title is the job, not «هویدا»');
  
    // -------------------------------------------------------- portal page ----
    const portalPage = await call('GET', '/careers/sample-tech');
    const portalLd = ldFrom(portalPage.text);
    const list = portalLd.find((x) => x['@type'] === 'ItemList');
    assert(Boolean(list) && list.numberOfItems === 1, 'the portal list is an ItemList (not a pile of JobPostings)', JSON.stringify(list?.numberOfItems));
    assert(list?.itemListElement?.[0]?.url?.endsWith(`/jobs/${job.id}`), 'the list points at the job page');
    assert(!portalLd.some((x) => x['@type'] === 'JobPosting'), 'a listing page does not claim to be a job posting');
    assert(portalPage.text.includes('<title>فرصت‌های شغلی شرکت نمونهٔ فناوری</title>'), 'the portal page has its own title');

    // ------------------------------------------------ the JSON endpoint ----
    const jsonFeed = await call('GET', '/careers/sample-tech/job-posting.json');
    assert(jsonFeed.status === 200 && jsonFeed.json.count === 1, 'the JSON feed lists the opening', String(jsonFeed.json?.count));
    assert(jsonFeed.json.items[0].title === posting?.title, 'the feed and the markup agree');
    assert(/application\/json/.test(jsonFeed.type), 'the feed is served as JSON');

    // ------------------------------------------------------------ sitemap ----
    const sitemap = await call('GET', '/careers/sample-tech/sitemap.xml');
    assert(sitemap.status === 200 && /application\/xml/.test(sitemap.type), 'a sitemap is served as XML', sitemap.type);
    assert(sitemap.text.includes(`${BASE}/careers/sample-tech/jobs/${job.id}`), 'the sitemap lists the opening');

    // ------------------------------------------------ escaping the script ----
    await call('PATCH', `/api/jobs/${job.id}`, A, { extraNotes: 'تست </script><script>alert(1)</script> و پایان.' });
    const escaped = await call('GET', `/careers/sample-tech/jobs/${job.id}`);
    const scripts = [...escaped.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert(scripts.length === 1, 'a </script> inside the description does not open a second block', String(scripts.length));
    assert(!escaped.text.includes('<script>alert(1)</script>'), 'and no injected script reaches the page');
    assert(ldFrom(escaped.text).some((x) => x['@type'] === 'JobPosting'), 'the markup is still valid JSON afterwards');

    // ------------------------------------------------------------- deadline ----
    const future = jalaliOffset(10);
    const withDeadline = await call('PATCH', `/api/jobs/${job.id}`, A, { applyBy: future });
    assert(withDeadline.status === 200 && withDeadline.json.job.applyByJalali === future, 'an application deadline can be set', JSON.stringify(withDeadline.json?.job?.applyByJalali));
    const deadlineInstant = new Date(withDeadline.json.job.applyByISO).toISOString();
    assert(deadlineInstant.endsWith('T20:29:00.000Z'), 'the deadline means the end of that Tehran day (23:59 +03:30)', deadlineInstant);
    const deadlinePage = await call('GET', `/careers/sample-tech/jobs/${job.id}`);
    const deadlinePosting = ldFrom(deadlinePage.text).find((x) => x['@type'] === 'JobPosting');
    assert(deadlinePosting?.validThrough === withDeadline.json.job.applyByISO, 'validThrough is the real deadline', String(deadlinePosting?.validThrough));

    const badDeadline = await call('PATCH', `/api/jobs/${job.id}`, A, { applyBy: 'نامعتبر' });
    assert(badDeadline.status === 400 && badDeadline.json.field === 'applyBy', 'a malformed deadline is refused with the field named', String(badDeadline.status));

    // An expired opening: gone from the feed, closed to applications, honestly labelled.
    const past = jalaliOffset(-2);
    const expired = await call('PATCH', `/api/jobs/${job.id}`, A, { applyBy: past });
    assert(expired.status === 200, 'the deadline can move into the past (a test of the rule)');
    const expiredFeed = await call('GET', '/careers/sample-tech/job-posting.json');
    assert(expiredFeed.json.count === 0, 'an expired opening disappears from the feed', String(expiredFeed.json?.count));
    const expiredSitemap = await call('GET', '/careers/sample-tech/sitemap.xml');
    assert(!expiredSitemap.text.includes(`/jobs/${job.id}`), 'and from the sitemap');
    const expiredPage = await call('GET', `/careers/sample-tech/jobs/${job.id}`);
    assert(!ldFrom(expiredPage.text).some((x) => x['@type'] === 'JobPosting'), 'no JobPosting is claimed for an expired opening');
    assert(expiredPage.text.includes('noindex'), 'the expired page tells crawlers not to index it as a live job');
    const expiredDetail = await call('GET', `/api/careers/sample-tech/jobs/${job.id}`);
    assert(expiredDetail.json?.job?.expired === true, 'the API says the deadline has passed', `${expiredDetail.status}`);
    const refusedApply = await call('POST', `/api/careers/sample-tech/jobs/${job.id}/apply`, null, {
      name: 'سارا محمدی',
      email: 'sara@example.com',
      phone: '09121234567',
      city: 'تهران',
      message: 'سلام',
      text: 'سابقهٔ فروش',
      consent: true,
    });
    assert(refusedApply.status === 410 && refusedApply.json.code === 'APPLICATION_CLOSED', 'the form is closed after the deadline', `${refusedApply.status}`);

    // ---------------------------------------------------------- unpublish ----
    await call('PATCH', `/api/jobs/${job.id}`, A, { applyBy: '' });
    await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: false });
    const afterUnpublish = await call('GET', `/careers/sample-tech/jobs/${job.id}`);
    assert(!ldFrom(afterUnpublish.text).some((x) => x['@type'] === 'JobPosting'), 'unpublishing removes the markup immediately');
    const landing = await call('GET', '/');
    assert(landing.text.includes('<title>هویدا — تحلیل هوشمند رزومه</title>'), 'every other page keeps the normal title');

    // The reserved addresses can never be a workspace slug.
    const reserved = await call('PUT', '/api/careers/settings', A, { slug: 'job-posting.json' });
    assert(reserved.status === 400, 'the reserved addresses cannot be taken as a slug', `${reserved.status}`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

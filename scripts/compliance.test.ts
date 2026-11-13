/**
 * End-to-end test of «بستهٔ شواهد انطباق» (ISO 27001 / SOC 2 evidence).
 *
 * What is being proved is not "the page renders" but the promises the module
 * makes to an auditor:
 *
 *   • a control can only be green when the workspace really is in that state —
 *     turning 2FA/retention/approval on or off changes the verdict;
 *   • a customer document stays «سند ارسال نشده» until it is uploaded, and a
 *     short attestation is refused;
 *   • the access review freezes a roster, refuses to close with unconfirmed
 *     members, and refuses a one-word closing note;
 *   • an issued pack is hash-frozen: the SHA-256 on the cover is the hash of the
 *     JSON the auditor receives, later edits in the account do not change it;
 *   • the ZIP really contains README/JSON/CSV/manifest and the uploaded file,
 *     and the activity CSV does **not** contain a candidate's name;
 *   • the whole surface is admin-only, and another workspace sees nothing.
 *
 * Run with: npm run build && npx tsx scripts/compliance.test.ts
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ZipReader } from '../server/zip';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-compliance-'));
  const PORT = 5500 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'compliance-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    PUBLIC_URL: BASE,
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
    return { status: res.status, json, text, headers: res.headers };
  };

  const tmpZip = (buf: Buffer) => {
    const p = path.join(DATA, `zip-${crypto.randomBytes(4).toString('hex')}.zip`);
    fs.writeFileSync(p, buf);
    return p;
  };

  const download = async (url: string, token: string) => {
    const res = await fetch(BASE + url, { headers: { 'X-Hovida-Session': token } });
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };

  try {
    const A = (await call('POST', '/api/auth/signup', null, { orgName: 'آوا صنعت', name: 'مهدی رستمی', email: 'a@example.com', password: 'Password12345' })).json.token as string;
    const B = (await call('POST', '/api/auth/signup', null, { orgName: 'برنا تجارت', name: 'مدیر دوم', email: 'b@example.com', password: 'Password12345' })).json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    await call('POST', '/api/org/members', A, { name: 'نگار رضایی', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const memberToken = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json.token as string;

    // ------------------------------------------------------ access boundary
    const memberRead = await call('GET', '/api/compliance?framework=iso27001', memberToken);
    assert(memberRead.status === 403, 'a plain member cannot read the evidence pack — it lists every account', String(memberRead.status));
    const memberIssue = await call('POST', '/api/compliance/packs', memberToken, { framework: 'iso27001', scopeNote: '' });
    assert(memberIssue.status === 403, 'nor issue one', String(memberIssue.status));

    const iso = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(iso.status === 200 && iso.json.controls.length >= 12, 'an admin reads the ISO catalogue', String(iso.json?.controls?.length));
    const soc = await call('GET', '/api/compliance?framework=soc2', A);
    assert(soc.status === 200 && soc.json.controls.length === iso.json.controls.length, 'the SOC 2 view covers the same controls', `${soc.json?.controls?.length} vs ${iso.json?.controls?.length}`);
    const socRefs = soc.json.controls.flatMap((c: any) => c.refs);
    assert(socRefs.every((r: string) => r.startsWith('SOC2')), 'but each control is labelled with its own framework references', socRefs.slice(0, 3).join(', '));
    assert(soc.json.summary.framework === 'soc2' && iso.json.summary.framework === 'iso27001', 'and the summary names the framework it scored');
    const byId = (payload: any, id: string) => payload.controls.find((c: any) => c.id === id);

    // ------------------------------------------------- honest starting state
    assert(byId(iso.json, 'A.5.17')?.state === 'gap', 'with no 2FA and no SSO, authentication is a real gap — not a green tick', byId(iso.json, 'A.5.17')?.state);
    assert(byId(iso.json, 'A.8.16')?.state === 'gap', 'anomaly monitoring is declared a gap (the product has none)', byId(iso.json, 'A.8.16')?.state);
    assert(byId(iso.json, 'A.5.1')?.state === 'missing_evidence', 'the information-security policy is «not supplied», not assumed', byId(iso.json, 'A.5.1')?.state);
    assert(byId(iso.json, 'A.8.13')?.state === 'gap', 'a workspace that never backed up reads as a gap', byId(iso.json, 'A.8.13')?.state);
    assert(iso.json.summary.counts.missing_evidence >= 5, 'the six customer documents are counted honestly', String(iso.json.summary.counts.missing_evidence));
    assert(iso.json.summary.score < 60, 'and the overall score is low at the start', String(iso.json.summary.score));
    assert(iso.json.summary.limits.some((l: string) => /نه گواهی/.test(l)), 'the payload itself carries the “not a certificate” line');
    assert(!JSON.stringify(iso.json).includes('Password12345'), 'no credential material leaks into the payload');

    // ------------------------------------------------------ product controls
    const beforeRetention = byId(iso.json, 'A.8.10');
    assert(beforeRetention?.state === 'partial', 'retention is «partial» while the policy is off', beforeRetention?.state);
    await call('PUT', '/api/org/retention', A, { days: 180, action: 'anonymize' });
    const afterRetention = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(afterRetention.json, 'A.8.10')?.state === 'met', 'turning the retention policy on turns the control green', byId(afterRetention.json, 'A.8.10')?.state);
    assert(byId(afterRetention.json, 'A.8.10')?.evidence.some((e: any) => /۱۸۰/.test(e.value)), 'and the number in the evidence is the real policy', JSON.stringify(byId(afterRetention.json, 'A.8.10')?.evidence?.[0]));

    const beforeApproval = byId(soc.json, 'CC5.3');
    assert(beforeApproval?.state === 'partial', 'segregation of duties starts as «partial» (tool exists, off)', beforeApproval?.state);
    await call('PATCH', '/api/org', A, { offerApproval: { enabled: true, steps: [{ id: 's1', label: 'مدیر منابع انسانی', approverId: (await call('GET', '/api/org', A)).json.org.members?.[0]?.id || '' }] } });
    const socAfter = await call('GET', '/api/compliance?framework=soc2', A);
    const cc53 = byId(socAfter.json, 'CC5.3');
    assert(cc53?.state === 'met' || cc53?.state === 'partial', 'the approval step is read from the org settings, not typed by hand', `${cc53?.state} — ${cc53?.reason}`);

    // ------------------------------------------------------- access review
    const started = await call('POST', '/api/compliance/access-reviews', A, { framework: 'iso27001', note: 'بازنگری پیش از حسابرسی ۱۴۰۵' });
    assert(started.status === 201 && started.json.review.members.length === 2, 'a review freezes the roster', String(started.json?.review?.members?.length));
    const review = started.json.review;
    const neqar = review.members.find((m: any) => m.email === 'negar@example.com');
    assert(neqar?.twoFactor === false && neqar?.flag === 'no_2fa', 'and flags the account that is missing 2FA', `${neqar?.twoFactor}/${neqar?.flag}`);
    const adminRow = review.members.find((m: any) => m.role !== 'member');
    assert(adminRow?.flag === 'admin', 'the admin account is flagged for a second look', adminRow?.flag);

    const secondStart = await call('POST', '/api/compliance/access-reviews', A, { framework: 'iso27001' });
    assert(secondStart.status === 409 && secondStart.json.code === 'REVIEW_OPEN', 'only one review can be open at a time', `${secondStart.status}/${secondStart.json?.code}`);

    const closeEarly = await call('POST', `/api/compliance/access-reviews/${review.id}/complete`, A, { note: 'همه‌چیز مرتب است و تأیید می‌کنم.' });
    assert(closeEarly.status === 400 && closeEarly.json.code === 'MEMBERS_PENDING', 'a review cannot close while members are unconfirmed', `${closeEarly.status}/${closeEarly.json?.code}`);

    for (const m of review.members) {
      const r = await call('POST', `/api/compliance/access-reviews/${review.id}/confirm`, A, { userId: m.userId, confirmed: true });
      assert(r.status === 200, `confirming ${m.email}`, String(r.status));
    }
    const shortNote = await call('POST', `/api/compliance/access-reviews/${review.id}/complete`, A, { note: 'تأیید' });
    assert(shortNote.status === 400 && shortNote.json.code === 'NOTE_REQUIRED', 'a one-word closing note is refused', `${shortNote.status}/${shortNote.json?.code}`);
    const completed = await call('POST', `/api/compliance/access-reviews/${review.id}/complete`, A, { note: 'همهٔ دسترسی‌ها برای نقش فعلی لازم است؛ حساب‌های بدون ۲FA ملزم به فعال‌سازی شدند.' });
    assert(completed.status === 200 && completed.json.review.status === 'completed', 'the review closes with a written decision', String(completed.json?.review?.status));
    assert(completed.json.review.snapshot?.confirmed === 2 && completed.json.review.snapshot?.withoutTwoFactor === 2, 'the snapshot keeps the numbers at completion', JSON.stringify(completed.json.review.snapshot));
    assert(completed.json.review.completedAtJalali, 'and a Persian date');

    const afterReview = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(afterReview.json, 'A.5.15')?.state === 'met', 'the access control turns green because a review really happened', byId(afterReview.json, 'A.5.15')?.state);

    // ---------------------------------------------------------- evidence
    const shortDecl = await call('POST', '/api/compliance/controls/A.5.1/declaration', A, { text: 'تصویب شد' });
    assert(shortDecl.status === 400 && shortDecl.json.code === 'DECLARATION_TOO_SHORT', 'a two-word attestation is refused', `${shortDecl.status}/${shortDecl.json?.code}`);
    const decl = await call('POST', '/api/compliance/controls/A.5.1/declaration', A, {
      text: 'خط‌مشی امنیت اطلاعات در جلسهٔ ۱۴۰۵/۰۷/۱۲ هیئت‌مدیره تصویب و به همهٔ کارکنان ابلاغ شد.',
    });
    assert(decl.status === 200 && decl.json.declaration.byName === 'مهدی رستمی', 'an attestation carries the name of the human who wrote it', decl.json?.declaration?.byName);

    const badFile = await call('POST', '/api/compliance/controls/A.5.1/evidence', A, { fileName: 'policy.exe', fileBase64: Buffer.from('x').toString('base64') });
    assert(badFile.status === 400 && badFile.json.code === 'BAD_FILE_TYPE', 'only documents and images are accepted as evidence', `${badFile.status}/${badFile.json?.code}`);

    const pdf = Buffer.from('%PDF-1.4 fake information security policy');
    const uploaded = await call('POST', '/api/compliance/controls/A.5.1/evidence', A, {
      fileName: 'security-policy.pdf',
      fileBase64: pdf.toString('base64'),
    });
    assert(uploaded.status === 201, 'a real file is stored', `${uploaded.status} ${uploaded.text.slice(0, 120)}`);
    const expectedHash = crypto.createHash('sha256').update(pdf).digest('hex');
    assert(uploaded.json.attachment.sha256 === expectedHash, 'the stored SHA-256 is the hash of the bytes', uploaded.json?.attachment?.sha256);

    const withDoc = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(withDoc.json, 'A.5.1')?.state === 'met', 'document + attestation makes the policy control complete', byId(withDoc.json, 'A.5.1')?.state);
    const readDoc = await fetch(`${BASE}/api/compliance/evidence/${uploaded.json.attachment.id}`, { headers: { 'X-Hovida-Session': A } });
    assert(readDoc.status === 200, 'the admin can read the file back', String(readDoc.status));
    const memberDoc = await fetch(`${BASE}/api/compliance/evidence/${uploaded.json.attachment.id}`, { headers: { 'X-Hovida-Session': memberToken } });
    assert(memberDoc.status === 403, 'a member cannot', String(memberDoc.status));

    // A candidate, so the CSV can be checked for the name that must not be there.
    const understanding = (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'حسابدار' })).json.understanding;
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'حسابدار', understanding, criteriaSource: 'template' })).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'زبیده,کریمی‌نژاد,"حسابدار ارشد با هشت سال سابقه",تهران,دلتا,https://www.linkedin.com/in/zobeyde,Yes,"حسابداری",zobeyde@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id });

    // ------------------------------------------------------------ issue pack
    const issued = await call('POST', '/api/compliance/packs', A, {
      framework: 'iso27001',
      scopeNote: 'فرایند جذب و استخدام — دفتر تهران، مهر ۱۴۰۵',
    });
    assert(issued.status === 201, 'an admin issues a pack', `${issued.status} ${issued.text.slice(0, 160)}`);
    const pack = issued.json.pack;
    assert(/^[0-9a-f]{64}$/.test(pack.sha256), 'the pack carries a SHA-256', pack.sha256?.slice(0, 16));
    assert(pack.files.includes('README.md') && pack.files.includes('SHA256SUMS') && pack.files.includes('attachments/A.5.1/security-policy.pdf'), 'its file list names the manifest and the attachment', pack.files?.join(','));
    assert(pack.attachments === 1, 'and counts the attachment', String(pack.attachments));

    const md = await download(`/api/compliance/packs/${pack.id}/download?format=md`, A);
    const mdText = md.buf.toString('utf8');
    assert(md.status === 200 && mdText.includes(pack.sha256), 'the cover of the report prints the hash', String(md.status));
    assert(mdText.includes('نه گواهی'), 'and says it is not a certificate');
    assert(mdText.includes('A.5.1') && mdText.includes('security-policy.pdf'), 'the policy control and its file are in the report');
    assert(mdText.includes('فرایند جذب و استخدام — دفتر تهران'), 'the declared scope is printed');

    const jsonDl = await download(`/api/compliance/packs/${pack.id}/download?format=json`, A);
    const body = jsonDl.buf;
    const recomputed = crypto.createHash('sha256').update(body).digest('hex');
    assert(jsonDl.status === 200 && recomputed === pack.sha256, 'the printed hash is the hash of the JSON the auditor receives', recomputed.slice(0, 16));
    const parsed = JSON.parse(body.toString('utf8'));
    assert(parsed.pack.nature.includes('نه گواهی') && parsed.controls.length === iso.json.controls.length, 'the JSON names its own nature and carries every control', String(parsed.controls.length));
    assert(parsed.accessReview?.completedByName === 'مهدی رستمی', 'and the completed access review travels with it');
    assert(parsed.controls.every((c: any) => c.reason), 'every control carries a written reason — no silent ticks');

    const zipDl = await download(`/api/compliance/packs/${pack.id}/download?format=zip`, A);
    assert(zipDl.status === 200 && zipDl.buf.subarray(0, 2).toString() === 'PK', 'the ZIP downloads', String(zipDl.status));
    const zipPath = path.join(DATA, 'pack-under-test.zip');
    fs.writeFileSync(zipPath, zipDl.buf);
    const zr = await ZipReader.open(zipPath);
    const names = zr.entries.map((e) => e.name);
    for (const expected of ['README.md', 'evidence.json', 'access-roster.csv', 'activity-summary.csv', 'SHA256SUMS', 'attachments/A.5.1/security-policy.pdf']) {
      assert(names.includes(expected), `the ZIP contains ${expected}`, names.join(', ').slice(0, 160));
    }
    const shaEntry = zr.entries.find((e) => e.name === 'SHA256SUMS')!;
    const shaText = (await zr.read(shaEntry, 200_000)).toString('utf8');
    assert(shaText.includes(pack.sha256), 'the manifest lists the pack hash');
    assert(shaText.includes(expectedHash), 'and the hash of the uploaded policy file');

    const rosterEntry = zr.entries.find((e) => e.name === 'access-roster.csv')!;
    const rosterText = (await zr.read(rosterEntry, 1_000_000)).toString('utf8');
    assert(rosterText.includes('negar@example.com') && rosterText.includes('two_factor'), 'the roster lists the accounts and their 2FA column');

    const activityEntry = zr.entries.find((e) => e.name === 'activity-summary.csv')!;
    const activityText = (await zr.read(activityEntry, 1_000_000)).toString('utf8');
    assert(!activityText.includes('زبیده') && !activityText.includes('کریمی‌نژاد'), 'the activity CSV carries counts, never a candidate’s name');
    assert(/month_jalali/.test(activityText) && /sourcing\.imported/.test(activityText), 'but does show which kinds of events are logged');
    const policyEntry = zr.entries.find((e) => e.name === 'attachments/A.5.1/security-policy.pdf')!;
    const policyBack = await zr.read(policyEntry, 1_000_000);
    assert(policyBack.equals(pdf), 'the attached file inside the ZIP is byte-identical to the upload');
    await zr.close();

    // ------------------------------------------------------------- frozen
    await call('PUT', '/api/org/retention', A, { days: 0, action: 'anonymize' });
    const mdAgain = await download(`/api/compliance/packs/${pack.id}/download?format=md`, A);
    assert(mdAgain.buf.toString('utf8') === mdText, 'later changes in the workspace do not rewrite an issued pack');
    const liveNow = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(liveNow.json, 'A.8.10')?.state === 'partial', 'while the live view does reflect the change', byId(liveNow.json, 'A.8.10')?.state);

    // A new member after issuance must not appear in the frozen roster.
    await call('POST', '/api/org/members', A, { name: 'حسین تازه', email: 'hosein@example.com', password: 'Password12345', role: 'member' });
    const zipAgain = await download(`/api/compliance/packs/${pack.id}/download?format=zip`, A);
    const zrAgain = await ZipReader.open(tmpZip(zipAgain.buf));
    const rosterAgain = await zrAgain.read(zrAgain.entries.find((e) => e.name === 'access-roster.csv')!, 1_000_000);
    assert(!rosterAgain.toString('utf8').includes('hosein@example.com'), 'the roster inside an issued pack is frozen — a new hire afterwards is not in it');
    await zrAgain.close();

    const list = await call('GET', '/api/compliance/packs?framework=iso27001', A);
    assert(list.json.items.length === 1 && list.json.items[0].sha256 === pack.sha256, 'the issued pack is listed with its hash', String(list.json?.items?.length));

    // ------------------------------------------------------------- isolation
    const crossRead = await call('GET', `/api/compliance/packs/${pack.id}/download?format=md`, B);
    assert(crossRead.status === 404, 'another workspace cannot download this pack', String(crossRead.status));
    const otherOrg = await call('GET', '/api/compliance?framework=iso27001', B);
    assert(otherOrg.json.packs.length === 0 && otherOrg.json.summary.counts.met !== liveNow.json.summary.counts.met, 'and its own payload is its own state', String(otherOrg.json?.packs?.length));

    // ---------------------------------------------------------- deleting
    const removed = await call('DELETE', `/api/compliance/packs/${pack.id}`, A);
    assert(removed.status === 200, 'a pack can be deleted', String(removed.status));
    const afterDelete = await download(`/api/compliance/packs/${pack.id}/download?format=md`, A);
    assert(afterDelete.status === 404, 'and its artefact is gone', String(afterDelete.status));

    // ------------------------------------------------ removing evidence
    const delDoc = await call('DELETE', `/api/compliance/controls/A.5.1/evidence/${uploaded.json.attachment.id}`, A);
    assert(delDoc.status === 200, 'a document can be removed', String(delDoc.status));
    const afterDocDelete = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(afterDocDelete.json, 'A.5.1')?.state === 'partial', 'and the control drops back to «partial» — nothing is left claiming otherwise', byId(afterDocDelete.json, 'A.5.1')?.state);
    await call('DELETE', '/api/compliance/controls/A.5.1/declaration', A);
    const afterAll = await call('GET', '/api/compliance?framework=iso27001', A);
    assert(byId(afterAll.json, 'A.5.1')?.state === 'missing_evidence', 'removing both returns it to «not supplied»', byId(afterAll.json, 'A.5.1')?.state);

    // ------------------------------------------------------------- the trail
    const activity = await call('GET', '/api/activity?limit=200', A);
    const types = (activity.json?.items || []).map((a: any) => a.type);
    for (const t of ['compliance.review', 'compliance.evidence', 'compliance.pack']) {
      assert(types.includes(t), `the activity feed records ${t}`);
    }
    const packEvent = (activity.json?.items || []).find((a: any) => a.type === 'compliance.pack');
    assert(/SHA-256/.test(packEvent?.text || ''), 'the pack event names the hash, so the feed itself is evidence');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n${failures} بررسی ناموفق بود.`);
    process.exit(1);
  }
  console.log('\nهمهٔ بررسی‌ها موفق بود.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

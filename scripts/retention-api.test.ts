/**
 * End-to-end test of the two data-protection features:
 *   • «نگه‌داری داده» — a policy, a dry run that changes nothing, an anonymising
 *     run that keeps the numbers and removes the person, and a delete run;
 *   • DSAR — one JSON download with everything we hold, and an erasure that
 *     removes the record, the file and every related row.
 *
 * Run with: npm run build && npx tsx scripts/retention-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ret-'));
  const PORT = 5300 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'retention-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    delete env[k];
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
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت نمونه',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    await call('POST', '/api/org/members', A, { name: 'سارا', email: 'sara@example.com', password: 'Password12345', role: 'member' });
    const M = (await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'Password12345' })).json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه', understanding: tpl.json.understanding, criteriaSource: 'template' })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"شبکه",mina@example.ir',
      'رضا,کاظمی,"کارشناس شبکه",تهران,بتا,https://www.linkedin.com/in/reza,Yes,"شبکه",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const ids: string[] = [];
    for (const profile of imported.json.search.results) {
      const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: profile.id, jobId: job.id })).json.record;
      ids.push(rec.id);
    }
    assert(ids.length === 2, 'two candidates are ready');

    // ------------------------------------------------------------- policy --
    const initial = await call('GET', '/api/org/retention', A);
    assert(initial.status === 200 && initial.json.policy.days === 0, 'the policy starts off');
    assert(initial.json.preview.items.length === 0, 'a policy that is off previews nothing');
    assert((await call('PUT', '/api/org/retention', M, { days: 30 })).status === 403, 'only an admin can set the policy');
    assert((await call('PUT', '/api/org/retention', A, { days: 5000 })).status === 400, 'an absurd window is refused');
    const saved = await call('PUT', '/api/org/retention', A, { days: 365, action: 'anonymize' });
    assert(saved.status === 200 && saved.json.policy.days === 365 && saved.json.policy.action === 'anonymize', 'the policy is saved');
    assert(Boolean(saved.json.policy.updatedAtJalali), 'the policy keeps its Persian date');
    assert((await call('GET', '/api/activity', A)).json.items.some((a: any) => a.text.includes('نگه‌داری داده')), 'changing the policy is logged');

    // Nothing is old enough yet.
    const fresh = await call('POST', '/api/org/retention/run', A, { dryRun: true });
    assert(fresh.status === 200 && fresh.json.result.items.length === 0, 'nothing is eligible after one day');
    const wouldRun = await call('POST', '/api/org/retention/run', A, {});
    assert(wouldRun.json.result.anonymized === 0 && wouldRun.json.result.deleted === 0, 'a run with nothing to do changes nothing');

    // ------------------------------------------------------- dry run only --
    await call('POST', `/api/resumes/${ids[0]}/comments`, A, { body: 'مینا رضایی را برای مصاحبهٔ فنی ببینید.' });
    await call('PATCH', `/api/resumes/${ids[0]}`, A, { action: 'decision', status: 'rejected', note: 'حقوق درخواستی بالا' });
    const beforeDry = (await call('GET', `/api/resumes/${ids[0]}`, A)).json.record.filePath;
    const dry = await call('POST', '/api/org/retention/run', A, { dryRun: true, days: 0 });
    assert(dry.status === 200 && dry.json.result.dryRun === true, 'a dry run is reported as one');
    assert(dry.json.result.items.length === 2, 'a dry run lists both candidates', String(dry.json.result.items.length));
    assert(dry.json.result.anonymized === 0 && dry.json.result.deleted === 0, 'a dry run counts zero changes');
    const untouched = await call('GET', `/api/resumes/${ids[0]}`, A);
    assert(untouched.json.record.candidateName === 'مینا رضایی' && Boolean(untouched.json.record.contact?.email), 'a dry run really changes nothing');
    assert(untouched.json.record.filePath === beforeDry, 'the file pointer is untouched after a dry run');

    // --------------------------------------------------------- anonymise ---
    const anon = await call('POST', '/api/org/retention/run', A, { days: 0 });
    assert(anon.status === 200 && anon.json.result.anonymized === 2 && anon.json.result.deleted === 0, 'both are anonymised', JSON.stringify(anon.json.result));
    assert(anon.json.policy.lastRunCount === 2 && Boolean(anon.json.policy.lastRunAtJalali), 'the run is stamped on the policy');

    const after = await call('GET', `/api/resumes/${ids[0]}`, A);
    const rec = after.json.record;
    assert(rec.candidateName === null, 'the name is gone');
    assert(rec.contact === null, 'the contact details are gone');
    assert(rec.filePath === null && rec.fileSize === null, 'the stored file is gone');
    assert(/^resume-[a-z0-9]+\./.test(rec.fileName), 'the file name no longer carries the person', rec.fileName);
    assert(rec.decisionNote === null, 'the free-text decision note is gone');
    assert(Boolean(rec.anonymizedAtISO), 'the record is marked as anonymised');
    assert(rec.score >= 0 && Boolean(rec.category), 'the score and category stay for the reports');
    assert((await call('GET', `/api/resumes/${ids[0]}/comments`, A)).json.items.length === 0, 'the notes are gone with it');
    const list = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    assert(list.json.items.length === 2, 'the candidate still counts in the reports');
    assert(list.json.items.every((i: any) => !i.candidateName), 'but nobody can be named from the list');
    const link = await call('GET', `/api/resumes/${ids[0]}/file-url`, A);
    assert(link.status === 200 && link.json.hasFile === false && link.json.url === null, 'no file link can be minted any more');

    // ------------------------------------------------------------- delete --
    await call('PUT', '/api/org/retention', A, { days: 365, action: 'delete' });
    // The anonymised rows were touched just now, so ask for a zero-day window.
    const dryDelete = await call('POST', '/api/org/retention/run', A, { dryRun: true, days: 0 });
    assert(dryDelete.json.result.action === 'delete', 'the action follows the policy');
    const wiped = await call('POST', '/api/org/retention/run', A, { days: 0 });
    assert(wiped.status === 200 && wiped.json.result.deleted === 2, 'the delete policy removes both', JSON.stringify(wiped.json.result));
    assert((await call('GET', `/api/resumes/${ids[0]}`, A)).status === 404, 'a deleted candidate is gone');
    const afterDelete = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    assert(afterDelete.json.items.length === 0, 'the list is empty');
    assert((await call('GET', '/api/activity', A)).json.items.some((a: any) => a.type === 'retention.applied'), 'the run is in the activity feed');

    // ---------------------------------------------------------------- DSAR --
    const csv2 = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'نیما,احمدی,"کارشناس شبکه",تهران,گاما,https://www.linkedin.com/in/nima,Yes,"شبکه",nima@example.ir',
    ].join('\r\n');
    const imported2 = await call('POST', '/api/sourcing/csv', A, { csv: csv2, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const target = (
      await call('POST', `/api/sourcing/searches/${imported2.json.search.id}/import`, A, { profileId: imported2.json.search.results[0].id, jobId: job.id })
    ).json.record;
    await call('POST', `/api/resumes/${target.id}/comments`, A, { body: 'یادداشت داخلی برای نیما' });
    const interview = await call('POST', `/api/interviews`, A, {
      jobId: job.id,
      resumeId: target.id,
      title: 'مصاحبهٔ فنی',
      date: '۱۴۰۵/۰۹/۱۲',
      time: '۱۰:۰۰',
      durationMin: 45,
      notes: '',
      withMeet: false,
      sendInvite: false,
    });
    assert(interview.status === 200 && interview.json.interview?.id, 'an interview is booked for the candidate', JSON.stringify(interview.json?.error || ''));

    assert((await call('GET', `/api/resumes/${target.id}/export`, M)).status === 403, 'only an admin can export personal data');
    const exported = await call('GET', `/api/resumes/${target.id}/export`, A);
    assert(exported.status === 200 && exported.json.workspace.name === 'شرکت نمونه', 'the export names the workspace');
    assert(exported.json.candidate?.id === target.id, 'the export contains the record');
    assert(exported.json.notes.length === 1 && exported.json.notes[0].body.includes('نیما'), 'the export contains the notes');
    assert(exported.json.interviews.length === 1, 'the export contains the interview');
    assert(exported.json.activity.length >= 1, 'the export contains the candidate’s history');
    assert(exported.json.messages && Array.isArray(exported.json.messages.emails), 'the export contains the messages section');
    assert(Boolean(exported.json.exportedAtJalali), 'the export is dated in Persian');

    assert((await call('POST', `/api/resumes/${target.id}/erase`, A, {})).status === 400, 'erasure without a confirmation is refused');
    assert((await call('POST', `/api/resumes/${target.id}/erase`, M, { confirm: 'ERASE' })).status === 403, 'a member cannot erase a candidate');
    const erased = await call('POST', `/api/resumes/${target.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && erased.json.erased.resumes === 1, 'the record is erased');
    assert(erased.json.erased.notes === 1 && erased.json.erased.interviews === 1, 'the notes and interviews go with it', JSON.stringify(erased.json.erased));
    assert((await call('GET', `/api/resumes/${target.id}`, A)).status === 404, 'nothing is left to read');
    assert((await call('GET', `/api/interviews`, A)).json.items.length === 0, 'the interview is gone from the calendar list');
    assert((await call('GET', `/api/activity`, A)).json.items.some((a: any) => a.type === 'resume.deleted' && a.text.includes('حذف دادهٔ شخصی')), 'the erasure is traceable');

    // ------------------------------------------------------------- at rest --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert(
      snap.retention && Object.values(snap.retention).some((p: any) => p.days === 365),
      'the policy is stored',
      JSON.stringify(snap.retention)
    );
    assert(!JSON.stringify(snap).includes('نیمای'), 'the erased candidate is nowhere in the snapshot');
    const resumeDir = path.join(DATA, 'resumes');
    const remaining = fs.existsSync(resumeDir) ? fs.readdirSync(resumeDir, { recursive: true }).filter((f) => String(f).match(/\.[a-z0-9]+$/i)) : [];
    assert(remaining.length === 0, 'no anonymised or erased resume file is left on disk', remaining.join(', '));
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} retention/DSAR test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll retention/DSAR tests passed.');
  }
}

await main();

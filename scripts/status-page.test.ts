/**
 * End-to-end API test of «پیگیری درخواست» — the candidate's status page.
 *
 * What is proven here:
 *   • the link works with no account and follows the pipeline live;
 *   • it carries the candidate's wording, not the board's («بسته شد»، نه «رد شد»);
 *   • nothing sensitive travels to that page — no score, note, interviewer,
 *     decision reason or e-mail address;
 *   • one live link per candidate, revocation and expiry are enforced;
 *   • per-job access, blind mode and erasure keep working.
 *
 * Run with: npm run build && npx tsx scripts/status-page.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** Why not ask the server: the test computes Tehran's Jalali date itself. */
function jalaliParts(iso: string): { date: string; time: string } {
  const shifted = new Date(new Date(iso).getTime() + 3.5 * 3600_000);
  const gy = shifted.getUTCFullYear();
  const gm = shifted.getUTCMonth() + 1;
  const gd = shifted.getUTCDate();
  const gDaysInMonth = [31, gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let jy = gy - 621;
  let days = gd;
  for (let m = 1; m < gm; m++) days += gDaysInMonth[m - 1];
  const marchDay = gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0) ? 20 : 21;
  const jyStart = days >= marchDay ? days - marchDay + 1 : days + 365 - marchDay + 1;
  if (days < marchDay) jy -= 1;
  const jMonthDays = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  let jm = 0;
  let jd = jyStart;
  while (jd > jMonthDays[jm]) {
    jd -= jMonthDays[jm];
    jm++;
  }
  const fa = (n: number) => String(n).padStart(2, '0').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const time = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
  return { date: `${fa(jy)}/${fa(jm + 1)}/${fa(jd)}`, time };
}

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-status-'));
  const PORT = 4600 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'status-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LINKEDIN_ACCESS_TOKEN']) delete env[k];

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
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;
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
      })
    ).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,محمدی,"کارشناس شبکه با شش سال تجربه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // ------------------------------------------------------------- the link ---
    const made = await call('POST', `/api/resumes/${rec.id}/status-link`, A, {});
    assert(made.status === 201, 'a status link is created', `${made.status} ${JSON.stringify(made.json?.error || '')}`);
    const link = made.json.link;
    assert(/^\/status\/[A-Za-z0-9_-]{20,}$/.test(link.url), 'the url carries an unguessable token', link.url);
    assert(/[۰-۹]/.test(link.expiresAtJalali), 'the expiry is a Persian date', link.expiresAtJalali);
    assert(link.revokedAtISO === null && link.views === 0, 'it starts live and unread');
    const token = String(link.url).split('/status/')[1];

    // ---------------------------------------------------------- public page ---
    const pub = await call('GET', `/api/status/${token}`);
    assert(pub.status === 200, 'the page opens with no session', `${pub.status}`);
    const s = pub.json.status;
    assert(s.orgName === 'شرکت الف' && s.jobTitle === 'کارشناس شبکه', 'it names the organisation and the role');
    assert(s.candidateName === 'سارا محمدی', 'and greets the candidate');
    assert(s.state === 'received' && s.message.length > 20, 'a fresh application reads «درخواست ثبت شد»', `${s.state}`);
    assert(Array.isArray(s.steps) && s.steps.length === 5, 'the path has five steps', String(s.steps?.length));
    assert(s.steps[0].state === 'current' && s.steps[1].state === 'upcoming', 'the first step is where it stands');
    assert(/[۰-۹]/.test(s.updatedAtJalali), 'the last update is a Persian date');

    // Nothing sensitive may travel to a page with no login.
    const wire = JSON.stringify(pub.json);
    for (const leak of ['score', 'matchScore', 'note', 'rejected', 'interviewer', 'sara@example.ir', 'salary']) {
      assert(!wire.toLowerCase().includes(leak.toLowerCase()), `the page never carries «${leak}»`);
    }

    // ------------------------------------------------------- it follows the pipeline
    const board = (await call('GET', `/api/jobs/${job.id}/board`, A)).json;
    const interviewStage = board.stages.find((x: any) => x.kind === 'interview');
    await call('POST', `/api/resumes/${rec.id}/stage`, A, { stageId: interviewStage.id });
    const atInterview = (await call('GET', `/api/status/${token}`)).json.status;
    assert(atInterview.state === 'interview', 'moving the candidate moves the page', atInterview.state);
    assert(atInterview.steps[2].state === 'current' && atInterview.steps[0].state === 'done', 'and the path marks what is behind them');

    const when = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const booked = await call('POST', '/api/interviews', A, {
      jobId: job.id,
      resumeId: rec.id,
      title: 'مصاحبهٔ فنی',
      date: jalaliParts(when).date,
      time: jalaliParts(when).time,
      durationMin: 45,
      interviewerIds: [],
      withMeet: false,
      location: 'آنلاین',
    });
    assert(booked.status === 200 || booked.status === 201, 'an interview can be booked', String(booked.status));
    const withInterview = (await call('GET', `/api/status/${token}`)).json.status;
    assert(Boolean(withInterview.nextInterviewJalali), 'the next interview date reaches the candidate', String(withInterview.nextInterviewJalali));
    assert(!JSON.stringify(withInterview).includes('رضا کریمی'), 'but the interviewer name does not');

    // -------------------------------------------------------- closed wording ---
    const rejectedStage = board.stages.find((x: any) => x.kind === 'rejected');
    if (rejectedStage) {
      await call('POST', `/api/resumes/${rec.id}/stage`, A, { stageId: rejectedStage.id });
      const closed = (await call('GET', `/api/status/${token}`)).json.status;
      assert(closed.state === 'closed', 'a closed application says closed', closed.state);
      assert(!/رد شد|رد شده/.test(closed.message), 'and never uses the internal words «رد شد»', closed.message.slice(0, 80));
      assert(closed.steps.every((x: any) => x.state !== 'upcoming'), 'the steps ahead are removed, not left grey');
      assert(closed.steps[closed.steps.length - 1].state === 'current', 'the closed step is where it ended');
    }

    // ------------------------------------------------------------- one live ---
    const before = (await call('GET', `/api/resumes/${rec.id}/status-links`, A)).json.items;
    assert(before.length === 1, 'the candidate has exactly one link', String(before.length));
    assert(before[0].views >= 3, 'every open is counted for HR', String(before[0].views));

    const second = await call('POST', `/api/resumes/${rec.id}/status-link`, A, {});
    assert(second.status === 201 && second.json.link.url !== link.url, 'a new link is a new secret');
    const oldGone = await call('GET', `/api/status/${token}`);
    assert(oldGone.status === 410 && oldGone.json.code === 'LINK_REVOKED', 'the old link stops working at once', `${oldGone.status}`);

    const listed = (await call('GET', `/api/resumes/${rec.id}/status-links`, A)).json.items;
    assert(listed.length === 2 && listed.filter((l: any) => !l.revokedAtISO).length === 1, 'the list keeps one live and one history row');

    const active = listed.find((l: any) => !l.revokedAtISO);
    const revoked = await call('DELETE', `/api/status-links/${active.id}`, A);
    assert(revoked.status === 200 && Boolean(revoked.json.link.revokedAtISO), 'HR can revoke the live link', String(revoked.status));
    assert((await call('GET', `/api/status/${String(active.url).split('/status/')[1]}`)).status === 410, 'and the page closes');

    // ----------------------------------------------------------- permissions ---
    assert((await call('GET', '/api/status/not-a-real-token')).status === 404, 'a wrong token is a clean 404');
    assert((await call('GET', `/api/resumes/${rec.id}/status-links`, B)).status === 404, 'another workspace cannot list them');
    assert((await call('POST', `/api/resumes/${rec.id}/status-link`, B, {})).status === 404, 'nor create one');

    const fresh = await call('POST', `/api/resumes/${rec.id}/status-link`, A, {});
    const freshToken = String(fresh.json.link.url).split('/status/')[1];

    // Blind screening: HR may not even mint the link while identity is hidden.
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindCreate = await call('POST', `/api/resumes/${rec.id}/status-link`, A, {});
    assert(blindCreate.status === 409 && blindCreate.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode refuses to create a personal link', `${blindCreate.status}`);
    assert((await call('GET', `/api/status/${freshToken}`)).status === 200, 'the candidate’s own page keeps working');
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // --------------------------------------------------------------- erasure ---
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200, 'the candidate can be erased', String(erased.status));
    assert((erased.json.erased?.statusLinks || 0) >= 1, 'the erasure counted the status links', JSON.stringify(erased.json.erased));
    const afterErase = await call('GET', `/api/status/${freshToken}`);
    assert(afterErase.status === 410 || afterErase.status === 404, 'and the page stops answering', String(afterErase.status));

    // ---------------------------------------------------------------- restart ---
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    log = '';
    child2.stdout.on('data', (d) => (log += d));
    child2.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));
    const afterRestart = await call('GET', `/api/status/${freshToken}`);
    assert([404, 410].includes(afterRestart.status), 'the erased link does not come back after a restart', String(afterRestart.status));
    child2.kill();
  } finally {
    child.kill();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * End-to-end test of «غربالگری بی‌طرف» (blind screening):
 *   • the redaction happens on the server — the identity is not in the JSON at all;
 *   • opening the original file, and every action that reaches the candidate
 *     (draft, e-mail, SMS, interview, offer, scheduling link, survey), is refused
 *     until someone reveals the identity;
 *   • a reveal is per-action and leaves a named trace in the workspace history;
 *   • with it off, everything is exactly as before.
 *
 * Run with: npm run build && npx tsx scripts/blind-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-blind-'));
  const PORT = 5900 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'blind-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
    DISABLE_DEMO: '1',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
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
    return { status: res.status, json, text };
  };

  try {
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت بی‌طرف',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    await call('POST', '/api/org/members', A, { name: 'سارا', email: 'sara@example.com', password: 'Password12345', role: 'member' });
    const M = (await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'Password12345' })).json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    assert(org.blindScreening === false, 'blind screening is off by default');
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: org.departments[0].id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: org.departments[0].id,
        roleTitle: 'کارشناس شبکه',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina-rezaei,Yes,"شبکه",mina@example.ir',
      'رضا,کاظمی,"کارشناس شبکه",تهران,بتا,https://www.linkedin.com/in/reza,Yes,"شبکه",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: org.departments[0].id, jobId: job.id, openToWorkOnly: true });
    const ids: string[] = [];
    for (const p of imported.json.search.results) {
      ids.push((await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: p.id, jobId: job.id })).json.record.id);
    }
    assert(ids.length === 2, 'two candidates are in the pipeline');

    // ------------------------------------------------------- before: no blind --
    const before = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    assert(before.json.items.some((c: any) => c.candidateName === 'مینا رضایی'), 'with it off, the name is visible');

    // ------------------------------------------------------------- turn it on --
    assert((await call('PATCH', '/api/org', M, { blindScreening: true })).status === 403, 'a plain member cannot switch it on');
    const on = await call('PATCH', '/api/org', A, { blindScreening: true });
    assert(on.status === 200 && on.json.org.blindScreening === true, 'the admin switches it on', `${on.status}`);
    const feed = await call('GET', '/api/activity?limit=10', A);
    assert(feed.json.items.some((a: any) => /غربالگری/.test(a.text) && /روشن/.test(a.text)), 'the switch itself is written to the history');

    // ------------------------------------------------------------- the list --
    const list = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    const names = list.json.items.map((c: any) => c.candidateName);
    const raw = JSON.stringify(list.json);
    assert(!raw.includes('مینا') && !raw.includes('رضایی'), 'no candidate name is in the list response');
    assert(!raw.includes('mina@example.ir') && !raw.includes('reza@example.ir'), 'no e-mail either');
    assert(!raw.includes('linkedin.com'), 'no profile link');
    assert(list.json.items.every((c: any) => c.blindHidden === true), 'each row is marked as hidden');
    assert(list.json.items.every((c: any) => c.filePath === null && c.fileHash === null), 'the file handle and hash are gone');
    assert(names.every((n: string) => /^کارجوی [۰-۹]+$/.test(n)), 'each gets a stable «کارجوی ۲۴۸۱» label', names[0]);
    const label1 = names[0];
    assert((await call('GET', `/api/resumes?jobId=${job.id}`, A)).json.items[0].candidateName === label1, 'the label is stable across requests');
    assert(list.json.items.every((c: any) => typeof c.score === 'number' && c.criterionScores.length >= 0), 'the score and criteria stay: it is the identity that goes');

    // ------------------------------------------------------------- the record --
    const one = await call('GET', `/api/resumes/${ids[0]}`, A);
    const oneRaw = JSON.stringify(one.json);
    assert(one.json.record.blindHidden === true, 'the single record is hidden too');
    assert(!oneRaw.includes('مینا') && !oneRaw.includes('mina@example.ir'), 'the record leaks neither the name nor the address');
    assert(one.json.record.contact.email === null && one.json.record.contact.phone === null, 'contact details are null, not empty strings');
    assert(one.json.record.source?.profileUrl === '', 'the sourced profile link is blank');
    assert(one.json.record.extractedText === '' || !oneRaw.includes('مینا'), 'the resume text is masked at the source');

    // --------------------------------------------------------- other surfaces --
    assert(!JSON.stringify((await call('GET', '/api/dashboard', A)).json).includes('مینا'), 'the dashboard queue is masked');
    assert(!JSON.stringify((await call('GET', '/api/activity?limit=20', A)).json).includes('مینا'), 'the activity feed is masked');
    assert(!JSON.stringify((await call('GET', `/api/search?q=${encodeURIComponent('شبکه')}`, A)).json).includes('مینا'), 'search results are masked');
    assert(!JSON.stringify((await call('GET', '/api/talent/list', A)).json).includes('مینا'), 'the talent pool is masked');

    // ------------------------------------------------- contacting is blocked --
    const blocked = [
      await call('POST', '/api/messages/draft', A, { resumeId: ids[0], kind: 'INTERVIEW_INVITE' }),
      await call('POST', '/api/offers', A, { resumeId: ids[0], terms: { salary: '5', startDate: '۱۴۰۵/۰۱/۰۱', benefits: '', probation: '' } }),
      await call('POST', '/api/scheduling', A, { resumeId: ids[0], slots: [{ date: '۱۴۰۵/۰۱/۰۱', time: '۱۰:۰۰' }] }),
      await call('POST', '/api/surveys', A, { resumeId: ids[0], stage: 'after_interview' }),
      await call('POST', '/api/interviews', A, { resumeId: ids[0], jobId: job.id, title: 'مصاحبه', startsAtISO: new Date(Date.now() + 86400_000).toISOString() }),
    ];
    assert(blocked.every((b) => b.status === 409 && b.json.code === 'BLIND_REVEAL_REQUIRED'), 'every action that reaches the person is refused', blocked.map((b) => b.status).join(','));
    // A real file, then the download door: a sourced profile has no PDF, so the
    // guard must be proved with one that does.
    const txt = Buffer.from('مینا رضایی\nتهران\nکارشناس شبکه', 'utf8').toString('base64');
    const attached = await call('POST', `/api/resumes/${ids[0]}/file`, A, { fileName: 'mina-rezaei.txt', fileBase64: txt });
    assert(attached.status === 200, 'a file can be attached to the candidate', `${attached.status}`);
    // A teammate's note that names the person is covered as well.
    await call('POST', `/api/resumes/${ids[0]}/comments`, A, { body: 'با مینا رضایی صحبت کردم، خوب بود', mentions: [] });
    const notes = await call('GET', `/api/resumes/${ids[0]}/comments`, A);
    assert(!JSON.stringify(notes.json).includes('مینا') && notes.json.items[0].body.includes('«نام»'), 'a team note is masked too', notes.json.items[0]?.body);

    const file = await call('GET', `/api/resumes/${ids[0]}/file-url`, A);
    assert(file.status === 409 && file.json.code === 'BLIND_REVEAL_REQUIRED', 'the original file is not downloadable', `${file.status}`);

    // ------------------------------------------------------------- the reveal --
    const reveal = await call('POST', `/api/resumes/${ids[0]}/reveal`, A, { reason: 'هماهنگی مصاحبهٔ نهایی' });
    assert(reveal.status === 200 && reveal.json.record.candidateName === 'مینا رضایی', 'a reveal returns the real identity', `${reveal.status}`);
    const feed2 = await call('GET', '/api/activity?limit=10', A);
    const trace = feed2.json.items.find((a: any) => a.type === 'candidate.revealed');
    assert(Boolean(trace), 'the reveal is in the history with its own type');
    assert(/مینا/.test(trace.text) || /آشکار/.test(trace.text), 'the trace says what happened', trace?.text);
    // The feed itself is still masked for everyone else — the reveal is one person's action.
    assert(!/مینا/.test(trace.text) || /آشکار/.test(trace.text), 'the note is understandable without depending on the name');
    const stillHidden = await call('GET', `/api/resumes/${ids[1]}`, A);
    assert(stillHidden.json.record.blindHidden === true, 'the other candidate stays hidden');
    const backToList = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    assert(backToList.json.items.every((c: any) => c.blindHidden === true), 'the list stays blind after one reveal');

    // ------------------------------------------------------- decision still works --
    const decided = await call('PATCH', `/api/resumes/${ids[0]}`, A, { action: 'decision', status: 'approved', note: 'قوی در مسیریابی' });
    assert(decided.status === 200, 'deciding on a blind candidate works — it is keyed by id', `${decided.status}`);
    const board = await call('POST', `/api/resumes/${ids[0]}/stage`, A, { stageId: (await call('GET', `/api/jobs/${job.id}`, A)).json.job.stages[1].id });
    assert(board.status === 200, 'and so does moving them on the board');

    // --------------------------------------------------------------- turn it off --
    const off = await call('PATCH', '/api/org', A, { blindScreening: false });
    assert(off.status === 200 && off.json.org.blindScreening === false, 'it can be switched off again');
    const after = await call('GET', `/api/resumes/${ids[0]}`, A);
    assert(after.json.record.candidateName === 'مینا رضایی' && after.json.record.blindHidden === undefined, 'names are back, with no leftover flag');
    assert((await call('POST', '/api/resumes/' + ids[0] + '/reveal', A, { reason: 'x' })).status === 409, 'revealing while it is off is a clean 409');
    assert((await call('POST', '/api/surveys', A, { resumeId: ids[0], stage: 'after_interview' })).status === 201, 'contact works again once it is off');
  } finally {
    child.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

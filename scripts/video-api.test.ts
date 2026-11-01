/**
 * End-to-end test of «مصاحبهٔ ویدئویی» (one-way recorded answers):
 *   • per-job questions, admin-owned, off until switched on;
 *   • creating a link sends nothing; a missing mailbox is said plainly;
 *   • the public page knows the questions, the seconds and the take limit —
 *     and nothing about the workspace;
 *   • takes are limited by the server, not by the browser's storage;
 *   • all answers must exist before submitting, and submitting is final;
 *   • playback needs a signature; the signature expires and is per answer;
 *   • rating is a human act between 1 and 5, and blind screening blocks video;
 *   • cancel and delete behave differently, and everything survives a restart.
 *
 * Run with: npm run build && npx tsx scripts/video-api.test.ts
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

/** A few kilobytes that look like a webm to the server (it checks size, not codecs). */
const FAKE_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(6000, 7)]).toString('base64');

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-video-'));
  const PORT = 5900 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'video-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    delete env[k];
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
      json = text;
    }
    return { status: res.status, json, text, headers: res.headers };
  };

  try {
    // ------------------------------------------------------------- fixture ----
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت نمونه',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    await call('POST', '/api/org/members', A, { name: 'مریم', email: 'maryam@example.com', role: 'member', password: 'Password12345' });
    const M = (await call('POST', '/api/auth/login', null, { email: 'maryam@example.com', password: 'Password12345' })).json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tplJob = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس فروش' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس فروش',
        understanding: tplJob.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس فروش",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"فروش",mina@example.ir',
      'رضا,کاظمی,"کارشناس فروش",تهران,بتا,https://www.linkedin.com/in/reza,Yes,"فروش",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const ids: string[] = [];
    for (const p of imported.json.search.results) {
      ids.push((await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: p.id, jobId: job.id })).json.record.id);
    }
    assert(ids.length === 2, 'two candidates are ready');

    // ------------------------------------------------------------ settings ----
    const defaults = await call('GET', `/api/video/settings?jobId=${job.id}`, A);
    assert(defaults.status === 200 && defaults.json.settings.enabled === false, 'video is off for a new opening');
    assert(defaults.json.settings.questions.length === 3, 'but three role-appropriate questions are suggested', String(defaults.json.settings.questions.length));
    assert(/فروش/.test(defaults.json.settings.questions[0].text), 'the suggestion fits a sales role');

    const blockedCreate = await call('POST', '/api/video/invites', A, { resumeId: ids[0] });
    assert(blockedCreate.status === 409 && blockedCreate.json.code === 'VIDEO_DISABLED', 'a link cannot be made while the questions are off');

    const memberSave = await call('PUT', '/api/video/settings', M, { jobId: job.id, enabled: true });
    assert(memberSave.status === 403, 'a member cannot change the questions', `${memberSave.status}`);

    const saved = await call('PUT', '/api/video/settings', A, {
      jobId: job.id,
      enabled: true,
      retakes: 1,
      ttlDays: 7,
      intro: 'خودتان باشید؛ این جای تماس تلفنی اولیه است.',
      questions: [
        { id: 'q1', text: 'یک محصول را در ۶۰ ثانیه معرفی کنید.', seconds: 60 },
        { id: 'q2', text: 'سخت‌ترین «نه» کاری‌تان چه بود؟', seconds: 120 },
      ],
    });
    assert(saved.status === 200 && saved.json.settings.enabled === true && saved.json.settings.questions.length === 2, 'the admin saves two questions', `${saved.status}`);
    const tooMany = await call('PUT', '/api/video/settings', A, {
      jobId: job.id,
      questions: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, text: `پرسش ${i}`, seconds: 60 })),
    });
    assert(tooMany.status === 400, 'more than five questions is refused', `${tooMany.status}`);
    assert((await call('PUT', '/api/video/settings', A, { jobId: job.id, questions: [] })).status === 400, 'an empty question list is refused');

    // -------------------------------------------------------------- create ----
    const created = await call('POST', '/api/video/invites', A, { resumeId: ids[0] });
    assert(created.status === 201 && created.json.invite.status === 'invited', 'the invitation is created', `${created.status}`);
    assert(created.json.invite.sentAtISO === null, 'creating it sends nothing');
    assert(/\/video\/[A-Za-z0-9_-]+$/.test(created.json.invite.url), 'the link is a public /video/<token> address', created.json.invite.url);
    assert(!JSON.stringify(created.json).includes('"token"'), 'the raw token is not exposed as a field');
    const token = created.json.invite.url.split('/video/')[1];
    const inviteId = created.json.invite.id as string;
    assert((await call('POST', '/api/video/invites', A, { resumeId: ids[0] })).status === 409, 'a second open invitation is refused');

    const send = await call('POST', `/api/video/invites/${inviteId}/send`, A);
    assert(send.status === 409 && send.json.code === 'EMAIL_NOT_CONFIGURED', 'without a mailbox the send says so plainly', `${send.status}`);

    // -------------------------------------------------------------- public ----
    assert((await call('GET', '/api/video/public/nope-nope')).status === 404, 'an unknown token is a clean 404');
    const page = await call('GET', `/api/video/public/${token}`);
    assert(page.status === 200 && page.json.invite.orgName === 'شرکت نمونه', 'the page names the workspace');
    assert(page.json.invite.questions.length === 2 && page.json.invite.questions[0].seconds === 60, 'the questions and seconds are shown before recording');
    assert(page.json.invite.retakes === 1 && page.json.invite.canRecord === true, 'the take limit and the open state are shown');
    assert(!/example\.com|جذب|مریم/.test(JSON.stringify(page.json.invite)), 'nothing about the team leaks to the candidate page');

    const first = await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q1', dataBase64: FAKE_WEBM, mimeType: 'video/webm', durationMs: 41_000 });
    assert(first.status === 200 && first.json.invite.recorded.length === 1, 'the first take is stored', `${first.status}`);
    assert(first.json.invite.recorded[0].takesLeft === 1, 'one take is left for that question');
    const second = await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q1', dataBase64: FAKE_WEBM, mimeType: 'video/webm', durationMs: 33_000 });
    assert(second.status === 200 && second.json.invite.recorded[0].takesLeft === 0, 'the retake is accepted');
    const third = await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q1', dataBase64: FAKE_WEBM, mimeType: 'video/webm', durationMs: 20_000 });
    assert(third.status === 409 && third.json.code === 'NO_TAKES_LEFT', 'a third take is refused by the server, not the browser', `${third.status}`);
    assert(
      (await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q1', dataBase64: FAKE_WEBM, mimeType: 'application/pdf' })).status === 400,
      'a non-video upload is refused'
    );
    assert(
      (await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'nope', dataBase64: FAKE_WEBM, mimeType: 'video/webm' })).status === 400,
      'an unknown question id is refused'
    );

    const early = await call('POST', `/api/video/public/${token}/submit`);
    assert(early.status === 400 && early.json.code === 'ANSWERS_INCOMPLETE', 'submitting with a missing answer is refused', `${early.status}`);

    const rest = await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q2', dataBase64: FAKE_WEBM, mimeType: 'video/webm', durationMs: 70_000 });
    assert(rest.status === 200, 'the second answer is stored');
    const submitted = await call('POST', `/api/video/public/${token}/submit`);
    assert(submitted.status === 200 && submitted.json.invite.status === 'submitted', 'the submission is final', `${submitted.status}`);
    assert(submitted.json.invite.canRecord === false, 'the page closes the recorder');
    assert((await call('POST', `/api/video/public/${token}/submit`)).status === 409, 'a second submission is refused');
    assert(
      (await call('POST', `/api/video/public/${token}/answer`, null, { questionId: 'q1', dataBase64: FAKE_WEBM, mimeType: 'video/webm' })).status === 409,
      'nothing can be recorded after submitting'
    );

    // --------------------------------------------------------------- watch ----
    const list = await call('GET', '/api/video', A);
    assert(list.status === 200 && list.json.invites.length === 1, 'the workspace lists the invitation');
    assert(list.json.stats.submitted === 1 && list.json.stats.waiting === 0, 'and counts it as submitted');
    assert(list.json.jobs.find((j: any) => j.id === job.id)?.enabled === true, 'the job shows its questions are on');
    assert(list.json.mailbox === false, 'and says the mailbox is not connected');
    assert(!JSON.stringify(list.json).includes('"token"'), 'the token never appears in the workspace payload');

    assert((await call('GET', `/api/video/invites/${inviteId}/answer/q1`)).status === 401, 'playback needs a session first');
    const signed = await call('GET', `/api/video/invites/${inviteId}/answer/q1`, M);
    assert(signed.status === 200 && /\/api\/video\/watch\//.test(signed.json.url), 'a member gets a short-lived playback link', String(signed.json.url));
    const playUrl = signed.json.url as string;
    const playback = await fetch(BASE + playUrl);
    assert(playback.status === 200 && playback.headers.get('content-type') === 'video/webm', 'the link plays the recording', `${playback.status}`);
    assert((await playback.arrayBuffer()).byteLength > 5000, 'with the real bytes');
    const ranged = await fetch(BASE + playUrl, { headers: { Range: 'bytes=0-99' } });
    assert(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100, 'a Range request is served (Safari needs it)', `${ranged.status}`);
    const tampered = playUrl.replace(/sig=[^&]+/, 'sig=deadbeef');
    assert((await fetch(BASE + tampered)).status === 403, 'a tampered signature is refused');
    assert((await fetch(BASE + playUrl.replace(/exp=\d+/, 'exp=1'))).status === 403, 'an expired one is refused too');

    // -------------------------------------------------------------- review ----
    const badRating = await call('POST', `/api/video/invites/${inviteId}/review`, A, { rating: 9 });
    assert(badRating.status === 400, 'a rating outside 1–5 is refused', `${badRating.status}`);
    const reviewed = await call('POST', `/api/video/invites/${inviteId}/review`, A, { rating: 4, note: 'پاسخ دوم با مثال بود.' });
    assert(reviewed.status === 200 && reviewed.json.invite.status === 'reviewed' && reviewed.json.invite.rating === 4, 'a human rates it 4/5', `${reviewed.status}`);
    const viewed = await call('POST', `/api/video/invites/${inviteId}/viewed`, M);
    assert(viewed.status === 200 && viewed.json.invite.views >= 1, 'opening it is counted as a view');

    // --------------------------------------------------------------- blind ----
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindTry = await call('POST', '/api/video/invites', A, { resumeId: ids[1] });
    assert(blindTry.status === 409 && blindTry.json.code === 'BLIND_REVEAL_REQUIRED', 'blind screening refuses a video request — a face identifies a person', `${blindTry.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // -------------------------------------------------- cancel vs. delete ----
    const second2 = await call('POST', '/api/video/invites', A, { resumeId: ids[1] });
    assert(second2.status === 201, 'a second candidate can be invited');
    const cancel = await call('POST', `/api/video/invites/${second2.json.invite.id}/cancel`, A);
    assert(cancel.status === 200 && cancel.json.invite.status === 'cancelled', 'an unanswered invitation can be cancelled');
    assert((await call('POST', `/api/video/invites/${inviteId}/cancel`, A)).status === 409, 'a submitted one cannot be cancelled — only archived');
    const removed = await call('DELETE', `/api/video/invites/${second2.json.invite.id}`, A);
    assert(removed.status === 204, 'deleting an invitation removes it', `${removed.status}`);
    assert((await call('GET', '/api/video', A)).json.invites.length === 1, 'and it disappears from the list');

    // --------------------------------------------------------- other tenant ----
    const other = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت دوم',
      name: 'مدیر دوم',
      email: 'owner2@example.com',
      password: 'Password12345',
    });
    const B = other.json.token as string;
    assert((await call('GET', '/api/video', B)).json.invites.length === 0, 'another workspace sees none of it');
    assert((await call('GET', `/api/video/invites/${inviteId}/answer/q1`, B)).status === 404, 'and cannot ask for a playback link');

    // ------------------------------------------------------------ restart ----
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 700));
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await boot();
    const afterRestart = await call('GET', '/api/video', A);
    assert(afterRestart.status === 200 && afterRestart.json.invites.length === 1, 'the invitation survives a restart', `${afterRestart.status}`);
    assert(afterRestart.json.invites[0].status === 'reviewed' && afterRestart.json.invites[0].rating === 4, 'with its rating and note');
    const replay = await call('GET', `/api/video/invites/${inviteId}/answer/q2`, A);
    const replayed = await fetch(BASE + replay.json.url);
    assert(replayed.status === 200 && (await replayed.arrayBuffer()).byteLength > 5000, 'and its recording is still playable');
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

/**
 * End-to-end test of «چالش کد» — running a candidate's own code.
 *
 * Running someone's code on our machine is the one feature here that can hurt
 * us, so the guarantees are proved rather than described:
 *
 *   • **the candidate's page leaks nothing** — no reference solution, no hidden
 *     inputs or expected values, and hidden failures say only «پنهان»;
 *   • **practice is free and does not grade** — visible tests only, the counter
 *     moves, nothing is written as a result;
 *   • **a submission is graded once and is final** — a second one is a 409;
 *   • **the sandbox holds** — `require`, `process`, `fs`, network and an endless
 *     loop all fail or are killed instead of scoring;
 *   • **the runner isolates the host** — a submission cannot read a file outside
 *     its temp directory even if the permission model is bypassed;
 *   • **links are closed when they should be** — declined, cancelled and expired
 *     links answer with a code, not with a working editor;
 *   • **sending needs a mailbox** — a real 409 with a code, then a real letter
 *     through SMTP carrying the token link;
 *   • **tenant walls** — another workspace sees nothing and gets 404s;
 *   • **erasure** removes the invitation with the candidate.
 *
 * Run with: npm run build && npx tsx scripts/coding.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { CHALLENGE_BANK } from '../server/code-challenges';
import { runCode } from '../server/code-runner';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** A throwaway SMTP server: the only way to prove a letter really left. */
function mockSmtp(): Promise<{ server: net.Server; messages: string[] }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 mock.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 2.0.0 queued\r\n');
          } else data += line + '\r\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd === 'HELO') socket.write('250 mock.local\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 accepted\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages })));
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }

  // ------------------------------------------------------ runner isolation --
  // These run in-process, before the server starts: they are about the harness
  // itself, not about HTTP.
  const easy = CHALLENGE_BANK.find((c) => c.id === 'normalize-phones')!;
  const visible = easy.tests.filter((t) => !t.hidden);

  const escapeAttempts: [string, string][] = [
    ['require', `function solution(){ return require('fs').readFileSync('/etc/passwd','utf8').length; }`],
    ['process', `function solution(){ return process.env.APP_SECRET || 'leaked'; }`],
    ['network', `function solution(){ const s = require('net').connect(80,'1.1.1.1'); return s ? 1 : 0; }`],
    ['import', `function solution(){ return eval("typeof import('fs')"); }`],
  ];
  for (const [name, code] of escapeAttempts) {
    const run = await runCode(code, visible, { timeLimitMs: 4000 });
    assert(run.passed === 0, `the sandbox blocks \`${name}\` — nothing passes`, `${run.passed}/${run.total}`);
  }

  const loop = await runCode('function solution(){ while (true) {} }', visible, { timeLimitMs: 1500 });
  assert(loop.timedOut && loop.passed === 0, 'an endless loop is killed, not waited on', `${loop.durationMs}ms`);

  const bomb = await runCode("function solution(){ const a=[]; for(;;){ a.push(new Array(1e6).fill('x')); } }", visible, { timeLimitMs: 6000 });
  assert(bomb.passed === 0 && !/GC|heap/i.test(bomb.error || ''), 'a memory bomb fails without V8 noise on the page', String(bomb.error));

  const noFn = await runCode('const x = 1;', visible, { timeLimitMs: 3000 });
  assert(noFn.passed === 0 && /solution/.test(noFn.error || ''), 'a submission without `solution` says so, in Persian', String(noFn.error));

  // A file the submission must not be able to read.
  const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-secret-'));
  const secret = path.join(secretDir, 'id_rsa');
  fs.writeFileSync(secret, 'TOPSECRET');
  const read = await runCode(
    `function solution(){ try { return require('fs').readFileSync(${JSON.stringify(secret)},'utf8'); } catch(e) { return 'blocked'; } }`,
    visible,
    { timeLimitMs: 4000 }
  );
  const sawSecret = JSON.stringify(read.outcomes).includes('TOPSECRET');
  assert(!sawSecret, 'a submission cannot read a file outside its sandbox', sawSecret ? 'LEAKED' : 'blocked');
  fs.rmSync(secretDir, { recursive: true, force: true });

  // Reference solutions must actually pass — otherwise the test grades typing.
  for (const c of CHALLENGE_BANK) {
    const full = await runCode(c.referenceSolution, c.tests, { timeLimitMs: 8000 });
    assert(full.passed === full.total && full.total > 0, `reference solution passes every test for «${c.title}»`, `${full.passed}/${full.total}`);
    const starter = await runCode(c.starterCode, c.tests, { timeLimitMs: 8000 });
    assert(starter.passed < starter.total, `the starter code does not accidentally pass «${c.title}»`, `${starter.passed}/${starter.total}`);
  }

  // ------------------------------------------------------------- the server --
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-coding-'));
  const PORT = 4900 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'coding-secret-0123456789',
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
    return { status: res.status, json, text };
  };

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;

    const A = await signup('آوا صنعت', 'a@example.com');
    const B = await signup('برنا تجارت', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'توسعه‌دهندهٔ بک‌اند' });
    const job = (
      await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'توسعه‌دهندهٔ بک‌اند', understanding: tpl.json.understanding, criteriaSource: 'template' })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email,Phone',
      'سارا,محمدی,"برنامه‌نویس بک‌اند",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"Node.js",sara@example.ir,09121234567',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // ------------------------------------------------------------- the bank
    const bank = await call('GET', '/api/code/challenges', A);
    assert(bank.status === 200 && bank.json.challenges.length >= 3, 'the challenge bank is listed', String(bank.json?.challenges?.length));
    assert(!bank.text.includes('referenceSolution'), 'the bank never ships reference solutions to the client');
    assert(bank.json.challenges.every((c: any) => c.rubric && c.testCount > 0 && c.visibleCount <= c.testCount), 'every challenge carries a rubric and test counts');

    const challengeId = 'normalize-phones';
    const challenge = CHALLENGE_BANK.find((c) => c.id === challengeId)!;

    // ------------------------------------------------- create, then send
    const created = await call('POST', '/api/code/invites', A, { resumeId: rec.id, challengeId });
    assert(created.status === 201, 'an invitation is created', String(created.status));
    const inv = created.json.invite;
    assert(inv.status === 'sent' && inv.sentAtISO === null, 'creating an invitation sends nothing');
    assert(typeof inv.url === 'string' && /\/code\/[A-Za-z0-9_-]+$/.test(inv.url), 'it carries a shareable link', inv.url);
    const token = String(inv.url).split('/code/')[1];

    const dup = await call('POST', '/api/code/invites', A, { resumeId: rec.id, challengeId });
    assert(dup.status === 409 && dup.json?.code === 'INVITE_OPEN', 'a second open invitation for the same challenge is refused', `${dup.status} ${dup.json?.code}`);

    const badChallenge = await call('POST', '/api/code/invites', A, { resumeId: rec.id, challengeId: 'nope' });
    assert(badChallenge.status === 400 && badChallenge.json?.code === 'CHALLENGE_NOT_FOUND', 'an unknown challenge is a 400', String(badChallenge.status));

    const noMailbox = await call('POST', `/api/code/invites/${inv.id}/send`, A, {});
    assert(noMailbox.status === 409 && noMailbox.json?.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox is refused, with a code', `${noMailbox.status} ${noMailbox.json?.code}`);
    assert(smtp.messages.length === 0, 'and no letter left');

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-code-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });
    const sent = await call('POST', `/api/code/invites/${inv.id}/send`, A, {});
    assert(sent.status === 200 && Boolean(sent.json.invite.sentAtISO), 'sending works once a mailbox is configured', String(sent.status));
    assert(smtp.messages.length === 1, 'exactly one letter left', String(smtp.messages.length));
    assert(smtp.messages[0].includes(`/code/${token}`), 'the letter carries the candidate link');

    // -------------------------------------------------- candidate's page
    const pub = await call('GET', `/api/code/public/${token}`);
    assert(pub.status === 200, 'the candidate page opens by token', String(pub.status));
    assert(pub.json.challenge.challenge.starterCode && pub.json.challenge.challenge.prompt, 'with the task and starter code');
    assert(pub.json.challenge.challenge.examples.length === challenge.tests.filter((t) => !t.hidden).length, 'showing exactly the visible examples');
    assert(!pub.text.includes('referenceSolution'), 'no reference solution on the page');
    assert(!pub.text.includes('hidden":true'), 'no hidden test objects on the page');
    for (const hiddenTest of challenge.tests.filter((t) => t.hidden)) {
      assert(!pub.text.includes(JSON.stringify(hiddenTest.args)), `hidden input of «${hiddenTest.name}» is not exposed`);
    }
    assert(pub.json.challenge.result === null && pub.json.challenge.status === 'sent', 'and no result yet');

    const badToken = await call('GET', '/api/code/public/not-a-real-token');
    assert(badToken.status === 404, 'an unknown token is a 404', String(badToken.status));

    // ------------------------------------------------ practice runs (free)
    const starterRun = await call('POST', `/api/code/public/${token}/run`, null, { code: challenge.starterCode });
    assert(starterRun.status === 200, 'the starter code can be run', String(starterRun.status));
    assert(starterRun.json.run.passed < starterRun.json.run.total, 'and it does not pass everything', `${starterRun.json.run.passed}/${starterRun.json.run.total}`);
    assert(starterRun.json.run.outcomes.every((o: any) => o.hidden === false), 'a practice run only ever shows visible cases');
    assert(starterRun.json.runsLeft === 19, 'the free-run counter moves', String(starterRun.json.runsLeft));
    assert(starterRun.json.challenge.status === 'started' && starterRun.json.challenge.result === null, 'practising marks the invite started, never submits it');

    const escapeRun = await call('POST', `/api/code/public/${token}/run`, null, { code: escapeAttempts[0][1] });
    assert(escapeRun.status === 200 && escapeRun.json.run.passed === 0, 'an escape attempt scores zero over HTTP too');

    const tooShort = await call('POST', `/api/code/public/${token}/submit`, null, { code: 'x' });
    assert(tooShort.status === 400 && tooShort.json?.code === 'CODE_TOO_SHORT', 'an empty submission is refused', String(tooShort.status));

    // ------------------------------------------------------------ submit
    const sub = await call('POST', `/api/code/public/${token}/submit`, null, { code: challenge.referenceSolution });
    assert(sub.status === 200, 'the correct solution is accepted', String(sub.status));
    const result = sub.json.challenge.result;
    assert(result && result.passed === result.total && result.score === 100, 'it scores every test', `${result?.passed}/${result?.total} (${result?.score})`);
    assert(result.cases.filter((c: any) => c.hidden).every((c: any) => c.expected === undefined && c.actual === undefined), 'hidden cases show no expected/actual values');
    assert(sub.json.challenge.status === 'submitted', 'the invitation is now submitted');

    const twice = await call('POST', `/api/code/public/${token}/submit`, null, { code: challenge.referenceSolution });
    assert(twice.status === 409 && twice.json?.code === 'ALREADY_SUBMITTED', 'a second submission is refused', String(twice.status));
    const runAfter = await call('POST', `/api/code/public/${token}/run`, null, { code: challenge.referenceSolution });
    assert(runAfter.status === 409, 'and so is running after submitting', String(runAfter.status));

    // ------------------------------------------------------- workspace view
    const list = await call('GET', `/api/code/invites?resumeId=${rec.id}`, A);
    assert(list.status === 200 && list.json.items.length === 1, 'HR sees the invitation', String(list.json?.items?.length));
    assert(list.json.items[0].result?.score === 100, 'with the score attached');
    assert(list.json.items[0].url.endsWith(`/code/${token}`) && list.json.items[0].token === undefined, 'the HR list shares the link, not a separate token field');

    const detail = await call('GET', `/api/code/invites/${inv.id}`, A);
    assert(detail.status === 200 && detail.json.rubric.length > 20, 'the rubric is available for reading the result');
    assert(detail.json.tests.filter((t: any) => t.hidden).length === challenge.tests.filter((t) => t.hidden).length, 'the test list names hidden cases without inputs');

    // The result must not touch the candidate's stage.
    const resumeAfter = await call('GET', `/api/resumes/${rec.id}`, A);
    const stageAfter = resumeAfter.json?.record?.stageId;
    assert(Boolean(stageAfter) && stageAfter === rec.stageId, 'a code result never moves the candidate stage', `${rec.stageId} → ${stageAfter}`);

    // ------------------------------------------------- decline, cancel, closed
    const second = await call('POST', '/api/code/invites', A, { resumeId: rec.id, challengeId: 'group-by-department' });
    const secondInv = second.json.invite;
    const secondToken = String(secondInv.url).split('/code/')[1];
    const declined = await call('POST', `/api/code/public/${secondToken}/decline`);
    assert(declined.status === 200 && declined.json.challenge.status === 'declined', 'a candidate can decline, and it is recorded', String(declined.json?.challenge?.status));
    const submitDeclined = await call('POST', `/api/code/public/${secondToken}/submit`, null, { code: challenge.referenceSolution });
    assert(submitDeclined.status === 409 && submitDeclined.json?.code === 'INVITE_CLOSED', 'a declined link cannot be answered later', `${submitDeclined.status} ${submitDeclined.json?.code}`);
    const sendDeclined = await call('POST', `/api/code/invites/${secondInv.id}/send`, A, {});
    assert(sendDeclined.status === 409 && sendDeclined.json?.code === 'INVITE_CLOSED', 'and cannot be re-sent', String(sendDeclined.status));

    const third = await call('POST', '/api/code/invites', A, { resumeId: rec.id, challengeId: 'pipeline-duration' });
    const thirdToken = String(third.json.invite.url).split('/code/')[1];
    const cancelled = await call('POST', `/api/code/invites/${third.json.invite.id}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.invite.status === 'cancelled', 'HR can cancel an invitation');
    const submitCancelled = await call('POST', `/api/code/public/${thirdToken}/submit`, null, { code: challenge.referenceSolution });
    assert(submitCancelled.status === 409 && submitCancelled.json?.code === 'INVITE_CLOSED', 'a cancelled link is closed for the candidate too', String(submitCancelled.status));

    // --------------------------------------------------------- tenant walls
    const listB = await call('GET', '/api/code/invites', B);
    assert(listB.status === 200 && listB.json.items.length === 0, 'another workspace sees no invitations', String(listB.json?.items?.length));
    const stealB = await call('GET', `/api/code/invites/${inv.id}`, B);
    assert(stealB.status === 404, 'and cannot read one by id', String(stealB.status));
    const sendB = await call('POST', `/api/code/invites/${inv.id}/send`, B, {});
    assert(sendB.status === 404, 'nor send it', String(sendB.status));
    const createB = await call('POST', '/api/code/invites', B, { resumeId: rec.id, challengeId });
    assert(createB.status === 404, 'nor attach it to a candidate outside their workspace', String(createB.status));

    // ------------------------------------------------------------- erasure
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && (erased.json.erased?.codeInvites || 0) >= 1, 'the candidate can be erased', JSON.stringify(erased.json.erased));
    const afterErase = await call('GET', '/api/code/invites', A);
    assert(afterErase.json.items.length === 0, 'and the invitation goes with them', String(afterErase.json?.items?.length));
    const pubAfterErase = await call('GET', `/api/code/public/${token}`);
    assert(pubAfterErase.status === 404, 'the old candidate link stops working', String(pubAfterErase.status));

    // --------------------------------------------------------------- audit
    const activity = await call('GET', '/api/activity', A);
    const types = (activity.json?.items || []).map((i: any) => i.type);
    assert(types.includes('code.sent') || types.includes('code.submitted'), 'the send/submit are on the activity trail', types.filter((t: string) => t.startsWith('code.')).join(','));
  } finally {
    smtp.server.close();
    child.kill('SIGKILL');
  }

  console.log(failures === 0 ? '\nهمهٔ بررسی‌ها موفق بود.' : `\n${failures} بررسی ناموفق بود.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

/**
 * End-to-end test of «تجربهٔ کارجو» (candidate-experience survey):
 *   • the link is only created on an explicit action and nothing is e-mailed
 *     until the send button — with a real SMTP receiver to prove which is which;
 *   • the public page is token-only, registers the first open, accepts exactly
 *     one answer, and refuses a second one;
 *   • the NPS maths follow the textbook definition, and the report is honest
 *     about response rate and unanswered invitations.
 *
 * Run with: npm run build && npx tsx scripts/survey-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/**
 * The body as the candidate would read it: nodemailer encodes non-Latin text
 * as quoted-printable (sometimes inside a multipart/alternative), so a raw
 * `includes('رضا')` check would lie. This walks every MIME part.
 */
function decodePart(headers: string, body: string): string {
  if (/content-transfer-encoding:\s*base64/i.test(headers)) {
    return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf-8');
  }
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    const joined = body.replace(/=\r\n/g, '');
    return Buffer.from(joined.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary').toString('utf-8');
  }
  return body;
}

function decodeMail(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(raw);
  if (!boundary) {
    const [headers, ...rest] = raw.split(/\r\n\r\n/);
    return decodePart(headers || '', rest.join('\r\n\r\n'));
  }
  const parts = raw.split(new RegExp(`--${boundary[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  return parts
    .slice(1)
    .map((part) => {
      const [headers, ...rest] = part.split(/\r\n\r\n/);
      return decodePart(headers || '', rest.join('\r\n\r\n'));
    })
    .join('\n');
}

/** A tiny SMTP server: records every message it accepts. */
function mockSmtp(): Promise<{ server: net.Server; messages: string[]; port: number }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let data = '';
    let inData = false;
    socket.write('220 mock ESMTP\r\n');
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (inData) {
        if (data.includes('\r\n.\r\n')) {
          messages.push(data);
          data = '';
          inData = false;
          socket.write('250 OK\r\n');
        }
        return;
      }
      const lines = data.split('\r\n').filter(Boolean);
      data = '';
      for (const line of lines) {
        if (/^EHLO|^HELO/i.test(line)) socket.write('250-mock\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) socket.write('235 ok\r\n');
        else if (/^MAIL FROM/i.test(line)) socket.write('250 ok\r\n');
        else if (/^RCPT TO/i.test(line)) socket.write('250 ok\r\n');
        else if (/^DATA/i.test(line)) {
          inData = true;
          data = '';
          socket.write('354 go ahead\r\n');
          return;
        } else if (/^QUIT/i.test(line)) {
          socket.write('221 bye\r\n');
          socket.end();
        } else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: (server.address() as any).port }))
  );
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const smtp = await mockSmtp();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-survey-'));
  const PORT = 5500 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'survey-api-secret-0123456789',
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
    for (const p of imported.json.search.results) {
      ids.push((await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: p.id, jobId: job.id })).json.record.id);
    }
    assert(ids.length === 2, 'two candidates are ready');

    // ------------------------------------------------------------ creation --
    assert((await call('GET', '/api/surveys', A)).json.report.sent === 0, 'no survey has been sent yet');
    const created = await call('POST', '/api/surveys', A, { resumeId: ids[0], stage: 'after_interview' });
    assert(created.status === 201 && created.json.survey.status === 'sent', 'the invitation is created', `${created.status}`);
    assert(created.json.survey.sentAtISO === null, 'creating it does not send anything');
    assert(/\/survey\/[A-Za-z0-9_-]+$/.test(created.json.survey.url), 'the link is a public /survey/<token> address', created.json.survey.url);
    assert(!JSON.stringify(created.json).includes('"token"'), 'the raw token is not exposed as a field');
    assert(created.json.survey.candidateEmail === 'mina@example.ir', 'the e-mail comes from the candidate record');
    const token = created.json.survey.url.split('/survey/')[1];

    const duplicate = await call('POST', '/api/surveys', A, { resumeId: ids[0], stage: 'after_hire' });
    assert(duplicate.status === 409 && duplicate.json.code === 'SURVEY_OPEN', 'a second open survey for the same person is refused');
    assert((await call('POST', '/api/surveys', A, { resumeId: 'res_nope', stage: 'after_interview' })).status === 404, 'an unknown candidate is a clean 404');
    assert((await call('GET', '/api/surveys', A)).json.items[0].status === 'sent', 'it is listed as sent');
    assert((await call('GET', '/api/surveys', M)).status === 200, 'a member may read the list');

    // -------------------------------------------------------------- public --
    const missing = await call('GET', '/api/survey/public/nope-nope');
    assert(missing.status === 404, 'an unknown token is a clean 404');
    const view = await call('GET', `/api/survey/public/${token}`);
    assert(view.status === 200 && view.json.survey.org.name === 'شرکت نمونه', 'the page names the workspace');
    assert(view.json.survey.dimensions.length === 3, 'the three experience questions are offered');
    assert(view.json.survey.prompt.includes('معرفی'), 'the NPS question is the classic one');
    assert(!JSON.stringify(view.json).includes('mina@example.ir'), 'the public page never leaks the candidate’s e-mail');
    assert(!JSON.stringify(view.json).includes('orgId'), 'no internal ids on the public page');

    const opened = await call('POST', `/api/survey/public/${token}/open`);
    assert(opened.status === 200 && opened.json.survey.status === 'opened', 'opening the page is recorded');
    assert((await call('GET', '/api/surveys', A)).json.report.opened === 1, 'the report distinguishes opened from sent');

    // Nothing was e-mailed by merely creating or opening it.
    assert(smtp.messages.length === 0, 'no e-mail left the server so far', String(smtp.messages.length));

    // ---------------------------------------------------------- answering ---
    assert((await call('POST', `/api/survey/public/${token}/answer`, null, { score: 11 })).status === 400, 'an out-of-range score is refused');
    assert((await call('POST', `/api/survey/public/${token}/answer`, null, {})).status === 400, 'a missing score is refused');

    const answered = await call('POST', `/api/survey/public/${token}/answer`, null, {
      score: 9,
      comment: 'مصاحبه‌گر خیلی حرفه‌ای بود.',
      answers: { clarity: 5, speed: 4, respect: 5 },
    });
    assert(answered.status === 200 && answered.json.survey.status === 'answered', 'the answer is accepted');
    assert(answered.json.survey.answeredAtJalali, 'the answer keeps its Persian date');
    assert(Boolean(answered.json.thanks), 'the candidate is thanked');

    const again = await call('POST', `/api/survey/public/${token}/answer`, null, { score: 2 });
    assert(again.status === 409 && again.json.code === 'ALREADY_ANSWERED', 'a second answer is refused', String(again.status));
    const reread = await call('GET', `/api/survey/public/${token}`);
    assert(reread.json.survey.status === 'answered', 'the link shows thanks on a second visit');

    const stored = (await call('GET', `/api/surveys?resumeId=${ids[0]}`, A)).json.items[0];
    assert(stored.score === 9 && stored.comment.includes('حرفه‌ای'), 'the score and the comment are kept');
    assert(stored.answers.clarity === 5 && stored.answers.speed === 4, 'the dimension answers are kept');
    assert(stored.status === 'answered', 'the workspace sees it as answered');

    // ------------------------------------------------------------- sending --
    const second = await call('POST', '/api/surveys', A, { resumeId: ids[1], stage: 'after_rejection' });
    const secondId = second.json.survey.id;
    const unsent = await call('POST', `/api/surveys/${secondId}/send`, A, {});
    assert(unsent.status === 409 && unsent.json.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox says so plainly', String(unsent.status));

    const connected = await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      username: 'hr@hovida-demo.ir',
      password: 'test-password',
      fromName: 'منابع انسانی',
      fromAddress: 'hr@hovida-demo.ir',
    });
    assert(connected.status === 200, 'a mailbox is connected', JSON.stringify(connected.json?.error || ''));

    const sent = await call('POST', `/api/surveys/${secondId}/send`, A, {});
    assert(sent.status === 200 && sent.json.emailed === true, 'the invitation is e-mailed', JSON.stringify(sent.json?.error || ''));
    assert(Boolean(sent.json.survey.sentAtISO) && Boolean(sent.json.survey.sentAtJalali), 'the send time is stamped');
    const mail = smtp.messages.at(-1) || '';
    const mailBody = decodeMail(mail);
    assert(/To: reza@example\.ir/i.test(mail), 'the mail goes to the candidate');
    assert(mailBody.includes('/survey/'), 'the mail carries the real link');
    assert(mailBody.includes('رضا'), 'the mail is written to this person, not a generic blast', mailBody.slice(0, 120));
    assert(mailBody.includes('کارشناس شبکه'), 'the mail names the opening they applied for');
    assert((await call('GET', '/api/activity', A)).json.items.some((a: any) => a.type === 'survey.sent'), 'the send is in the activity feed');

    const answeredOne = (await call('GET', `/api/surveys/${secondId}`, A)).json.survey;
    const answeredSend = await call('POST', `/api/surveys/${created.json.survey.id}/send`, A, {});
    assert(answeredSend.status === 409 && answeredSend.json.code === 'ALREADY_ANSWERED', 'an answered survey is not re-sent');
    assert(Boolean(answeredOne), 'the survey can still be read');

    // ------------------------------------------------------------- report ---
    // The second link (already e-mailed) gets a detractor answer, so the NPS is
    // not a lucky 100 and the maths actually has to be right.
    const secondToken = second.json.survey.url.split('/survey/')[1];
    const detractor = await call('POST', `/api/survey/public/${secondToken}/answer`, null, {
      score: 3,
      comment: 'هیچ‌وقت خبر ندادید.',
      answers: { clarity: 2, speed: 1, respect: 3 },
    });
    assert(detractor.status === 200, 'the e-mailed link accepts its answer');

    const report = (await call('GET', '/api/surveys/report?range=365', A)).json.report;
    assert(report.sent === 2, 'two invitations in total', String(report.sent));
    assert(report.answered === 2, 'both answered', String(report.answered));
    assert(report.promoters === 1 && report.detractors === 1 && report.passives === 0, 'promoters and detractors are counted the textbook way', JSON.stringify([report.promoters, report.passives, report.detractors]));
    assert(report.nps === 0, 'NPS = %promoters − %detractors = 0', String(report.nps));
    assert(report.responseRate === 100, 'response rate is 100%', String(report.responseRate));
    assert(report.average.clarity === 3.5, 'the dimensions are averaged', String(report.average.clarity));
    assert(report.byStage.find((s: any) => s.stage === 'after_interview').answered === 1, 'answers are grouped by the moment');
    assert(report.comments.length === 2 && report.comments[0].comment.length > 0, 'the free-text comments come with the report');
    assert((await call('GET', '/api/surveys/report?range=all', A)).status === 200, 'the all-time range works');

    // A cancelled link stops answering.
    const fourth = (await call('POST', '/api/surveys', A, { resumeId: ids[0], stage: 'after_hire' })).json.survey;
    assert((await call('POST', `/api/surveys/${fourth.id}/cancel`, A, {})).status === 200, 'a link can be cancelled');
    const fourthToken = fourth.url.split('/survey/')[1];
    const afterCancel = await call('POST', `/api/survey/public/${fourthToken}/answer`, null, { score: 10 });
    assert(afterCancel.status === 409 && afterCancel.json.code === 'EXPIRED', 'a cancelled link cannot be answered', String(afterCancel.status));
    assert((await call('GET', `/api/surveys`, A)).json.report.sent === 3, 'the cancelled one is still counted as sent', String((await call('GET', `/api/surveys`, A)).json.report.sent));

    // -------------------------------------------------------------- DSAR ----
    const exported = await call('GET', `/api/resumes/${ids[0]}/export`, A);
    assert(exported.status === 200, 'the candidate export still works');
    const erased = await call('POST', `/api/resumes/${ids[0]}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && erased.json.erased.surveys >= 1, 'erasing a candidate takes the survey answers too', JSON.stringify(erased.json.erased));
    assert((await call('GET', `/api/surveys?resumeId=${ids[0]}`, A)).json.items.length === 0, 'nothing of that candidate’s surveys is left');

    // ------------------------------------------------------------- at rest --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    // One candidate was erased on purpose, so only the surviving invitation is left.
    assert(Array.isArray(snap.surveys) && snap.surveys.length === 1, 'the surviving survey is stored', String((snap.surveys || []).length));
    assert(snap.surveys[0].status === 'answered' && snap.surveys[0].score === 3, 'its answer survives a restart');
    assert(snap.surveys.every((s: any) => typeof s.token === 'string' && s.token.length >= 20), 'each stored survey keeps a long random token');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} survey test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll candidate-experience survey tests passed.');
  }
}

await main();

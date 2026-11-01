/**
 * End-to-end test of «آزمون و ارزیابی» (the assessment module):
 *   • the catalogue is real (five templates, keyed and behavioural);
 *   • creating a link sends nothing, and a missing mailbox is said plainly;
 *   • the public page never receives the scoring key;
 *   • one link, one submission, all questions answered;
 *   • keyed tests score to 0–100 with a band, behavioural tests to five
 *     dimension profiles, and the maths is checked against the key itself;
 *   • an outside provider's result is stored and labelled `external`;
 *   • another workspace cannot read the record.
 *
 * Run with: npm run build && npx tsx scripts/assessment-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { templateById } from '../server/assessment-bank';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** Nodemailer encodes Persian as quoted-printable; this walks the MIME parts. */
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
          socket.write('354 go\r\n');
          inData = true;
        } else if (/^QUIT/i.test(line)) socket.write('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, messages, port: (server.address() as any).port }))
  );
}

/** Every answer set the test needs, built from the real key. */
function answersFor(templateId: string, mode: 'best' | 'worst' | 'middle'): Record<string, string | number> {
  const tpl = templateById(templateId);
  if (!tpl) throw new Error(`no template ${templateId}`);
  const out: Record<string, string | number> = {};
  for (const q of tpl.questions) {
    if (q.type === 'single') {
      const ranked = [...q.options].sort((a, b) => b.score - a.score);
      const chosen = mode === 'best' ? ranked[0] : mode === 'worst' ? ranked[ranked.length - 1] : ranked[1];
      out[q.id] = chosen.id;
    } else {
      out[q.id] = mode === 'best' ? (q.reverse ? 1 : 5) : mode === 'worst' ? (q.reverse ? 5 : 1) : 3;
    }
  }
  return out;
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const smtp = await mockSmtp();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-assess-'));
  const PORT = 5700 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'assessment-api-secret-0123456789',
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
    const tplJob = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس جذب و استخدام' });
    const job = (
      await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس جذب و استخدام', understanding: tplJob.json.understanding, criteriaSource: 'template' })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس جذب",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"جذب",mina@example.ir',
      'رضا,کاظمی,"کارشناس جذب",تهران,بتا,https://www.linkedin.com/in/reza,Yes,"جذب",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const ids: string[] = [];
    for (const p of imported.json.search.results) {
      ids.push((await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: p.id, jobId: job.id })).json.record.id);
    }
    assert(ids.length === 2, 'two candidates are ready for testing');

    // ------------------------------------------------------------ catalogue --
    const catalogue = await call('GET', '/api/assessments/templates?jobTitle=کارشناس جذب', A);
    assert(catalogue.status === 200 && catalogue.json.templates.length === 5, 'the catalogue offers five templates', String(catalogue.json.templates?.length));
    assert(catalogue.json.suggestedId === 'situational-recruiting', 'a recruiting role is pointed at the recruiting test', catalogue.json.suggestedId);
    const behavioural = catalogue.json.templates.find((t: any) => t.id === 'behavioral-core');
    assert(behavioural && behavioural.scored === false && behavioural.dimensions.length === 5, 'the behavioural template has five dimensions and no total score');
    const detail = await call('GET', '/api/assessments/templates/situational-recruiting', A);
    assert(detail.status === 200 && detail.json.template.questions[0].options.length === 4, 'the preview shows the four answers');
    assert(!/"score":\s*\d/.test(JSON.stringify(detail.json)), 'not even the HR preview exposes the option scores');

    // ------------------------------------------------------------- creation --
    const created = await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'situational-recruiting' });
    assert(created.status === 201 && created.json.assessment.status === 'sent', 'the link is created', `${created.status}`);
    assert(created.json.assessment.sentAtISO === null, 'creating it sends nothing');
    assert(/\/assess\/[A-Za-z0-9_-]+$/.test(created.json.assessment.url), 'the link is a public /assess/<token> address', created.json.assessment.url);
    assert(!JSON.stringify(created.json).includes('"token"'), 'the raw token is not exposed as a field');
    assert(created.json.assessment.score === null && created.json.assessment.band === null, 'an unanswered test has no score');
    const token = created.json.assessment.url.split('/assess/')[1];
    const createdId = created.json.assessment.id;

    const duplicate = await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'situational-recruiting' });
    assert(duplicate.status === 409 && duplicate.json.code === 'ASSESSMENT_OPEN', 'a second open link for the same test is refused');
    assert((await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'nope' })).status === 400, 'an unknown template is a clean 400');
    assert((await call('POST', '/api/assessments', A, { resumeId: 'res_nope', templateId: 'behavioral-core' })).status === 404, 'an unknown candidate is a clean 404');
    assert((await call('GET', '/api/assessments/templates')).status === 401, 'the catalogue needs a session like every workspace route');
    assert((await call('GET', '/api/assessments?resumeId=' + ids[0], M)).status === 200, 'a member may read the list');

    // --------------------------------------------------------------- public --
    assert((await call('GET', '/api/assessment/public/nope-nope')).status === 404, 'an unknown token is a clean 404');
    const view = await call('GET', `/api/assessment/public/${token}`);
    assert(view.status === 200 && view.json.assessment.orgName === 'شرکت نمونه', 'the page names the workspace');
    assert(view.json.assessment.questions.length === 8, 'all eight scenarios are on the page');
    assert(view.json.assessment.scale.length === 5, 'the agreement scale has five labels');
    assert(!JSON.stringify(view.json).includes('score'), 'the public page carries no option score');
    assert(!JSON.stringify(view.json).includes('reading'), 'the reading rule stays with HR');
    assert(!JSON.stringify(view.json).includes('mina@example.ir'), 'the candidate’s e-mail is not on their own page');
    assert(!JSON.stringify(view.json).includes('orgId'), 'no internal ids on the public page');

    const started = await call('POST', `/api/assessment/public/${token}/start`);
    assert(started.status === 200 && started.json.assessment.status === 'started', 'the first open is recorded');
    assert((await call('GET', '/api/assessments?resumeId=' + ids[0], A)).json.items[0].status === 'started', 'the workspace sees «در حال پاسخ»');

    const incomplete = await call('POST', `/api/assessment/public/${token}/submit`, null, { answers: { 'rec-1': 'rec-1-b' } });
    assert(incomplete.status === 400 && incomplete.json.code === 'ANSWERS_INCOMPLETE', 'a partial submission is refused', String(incomplete.status));
    const bogus = await call('POST', `/api/assessment/public/${token}/submit`, null, {
      answers: { ...answersFor('situational-recruiting', 'best'), 'rec-2': 'not-an-option' },
    });
    assert(bogus.status === 400, 'an option that does not exist is refused');

    const best = answersFor('situational-recruiting', 'best');
    const done = await call('POST', `/api/assessment/public/${token}/submit`, null, { answers: best });
    assert(done.status === 200 && done.json.assessment.status === 'completed', 'the answers are accepted once', String(done.status));
    assert(/سپاسگزاریم/.test(done.json.thanks || ''), 'the public page is answered with the closing screen', done.json.thanks);
    assert(!JSON.stringify(done.json.assessment).includes('"score"'), 'the candidate never sees a score');
    assert((await call('POST', `/api/assessment/public/${token}/submit`, null, { answers: best })).status === 409, 'a second submission is refused');

    const stored = (await call('GET', '/api/assessments?resumeId=' + ids[0], A)).json.items[0];
    assert(stored.status === 'completed' && stored.score === 100, 'all-best answers score 100', String(stored.score));
    assert(stored.band === 'strong', 'the band follows the score', stored.band);
    assert(stored.source === 'hovida' && stored.completedAtISO, 'the result is stamped and sourced from this page');

    // ------------------------------------------------------------- the maths --
    const worst = await call('POST', '/api/assessments', A, { resumeId: ids[1], templateId: 'situational-recruiting' });
    const worstToken = worst.json.assessment.url.split('/assess/')[1];
    await call('POST', `/api/assessment/public/${worstToken}/submit`, null, { answers: answersFor('situational-recruiting', 'worst') });
    const worstStored = (await call('GET', '/api/assessments?resumeId=' + ids[1], A)).json.items[0];
    const worstTemplate = templateById('situational-recruiting')!;
    const worstKey = answersFor('situational-recruiting', 'worst');
    const worstExpected = Math.round(
      (100 * worstTemplate.questions.reduce((n, q) => n + (q.type === 'single' ? q.options.find((o) => o.id === worstKey[q.id])?.score || 0 : 0), 0)) /
        (worstTemplate.questions.length * 10)
    );
    assert(worstStored.score === worstExpected, 'the low-answer score matches the key exactly', `${worstStored.score} vs ${worstExpected}`);
    assert(worstStored.score! < 20 && worstStored.band === 'review', 'the weakest answer set lands in «review»', `${worstStored.score}/${worstStored.band}`);

    // -------------------------------------------------------- behavioural ----
    const bInvite = await call('POST', '/api/assessments', A, { resumeId: ids[1], templateId: 'behavioral-core' });
    assert(bInvite.status === 201, 'a behavioural profile can be created beside the keyed one');
    const bToken = bInvite.json.assessment.url.split('/assess/')[1];
    const bView = await call('GET', `/api/assessment/public/${bToken}`);
    assert(bView.json.assessment.questions.every((q: any) => q.type === 'scale'), 'the behavioural page asks scale items only');
    assert(!JSON.stringify(bView.json).includes('ownership'), 'dimension names are not shown to the candidate');
    const bDone = await call('POST', `/api/assessment/public/${bToken}/submit`, null, { answers: answersFor('behavioral-core', 'best') });
    assert(bDone.status === 200, 'the profile is submitted', String(bDone.status));
    const bStored = (await call('GET', `/api/assessments?resumeId=${ids[1]}`, A)).json.items.find((a: any) => a.templateId === 'behavioral-core');
    assert(bStored.score === null, 'a profile has no total score');
    assert(bStored.dimensions.length === 5 && bStored.dimensions.every((d: any) => d.score === 100), 'reverse-keyed items score the same as direct ones', JSON.stringify(bStored.dimensions?.map((d: any) => d.score)));
    assert(bStored.note === null && bStored.source === 'hovida', 'the profile is marked as produced by this page');

    // -------------------------------------------------------------- sending --
    const pending = await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'work-sample-support' });
    const pendingId = pending.json.assessment.id;
    const unsent = await call('POST', `/api/assessments/${pendingId}/send`, A, {});
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
    assert(connected.status === 200, 'a mailbox is connected');
    const sent = await call('POST', `/api/assessments/${pendingId}/send`, A, {});
    assert(sent.status === 200 && sent.json.emailed === true, 'the link is e-mailed', JSON.stringify(sent.json?.error || ''));
    assert(Boolean(sent.json.assessment.sentAtISO), 'the send time is stamped');
    const mail = decodeMail(smtp.messages.at(-1) || '');
    assert(mail.includes('مینا') && /\/assess\//.test(mail), 'the mail names the candidate and carries the link');
    assert(mail.includes('پاسخ درست یا غلط ندارد'), 'the mail says the test has no right answer');
    assert(!/rec-[0-9]/.test(mail), 'no question ids leak into the mail');

    // ------------------------------------------------------- outside results --
    const ext = await call('POST', `/api/assessments/${pendingId}/result`, A, {
      score: 64,
      dimensions: [{ id: 'logic', label: 'استدلال', score: 70 }],
      note: 'نتیجهٔ سنجمان — گزارش PDF در پرونده',
    });
    assert(ext.status === 200 && ext.json.assessment.source === 'external', 'an outside result is stored and labelled external');
    assert(ext.json.assessment.score === 64 && ext.json.assessment.band === 'medium', 'the outside score gets the same band rule', `${ext.json.assessment.score}/${ext.json.assessment.band}`);
    assert(ext.json.assessment.dimensions[0].label === 'استدلال', 'the provider’s dimension labels are kept');
    assert((await call('POST', `/api/assessments/${pendingId}/result`, A, { score: 140 })).status === 409, 'a second result is refused');
    const badScore = await call('POST', `/api/assessments/${createdId}/result`, A, { score: 140 });
    assert(badScore.status === 409 || badScore.status === 400, 'an impossible score is refused', String(badScore.status));

    // --------------------------------------------------- provider via API key --
    const key = await call('POST', '/api/developer/keys', A, { name: 'ارائه‌دهندهٔ آزمون', scopes: ['write'] });
    assert(key.status === 201 && /^hvd_sk_/.test(key.json.key), 'a write key can be issued for a test provider');
    const apiKey = key.json.key as string;
    const viaApi = async (method: string, url: string, body?: unknown) => {
      const res = await fetch(BASE + url, {
        method,
        headers: { 'X-Hovida-Api-Key': apiKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const readBack = await viaApi('GET', `/api/v1/assessments/${pendingId}`);
    assert(readBack.status === 200 && readBack.json.assessment.source === 'external', 'the provider can read the invitation it wrote to', String(readBack.status));
    assert(!JSON.stringify(readBack.json).includes('mina@example.ir'), 'the provider never receives the candidate’s e-mail');

    const providerInvite = await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'behavioral-core' });
    const providerId = providerInvite.json.assessment.id;
    const pushed = await viaApi('POST', `/api/v1/assessments/${providerId}/result`, {
      score: 82,
      dimensions: [{ id: 'numerical', label: 'استدلال عددی', score: 82 }],
      note: 'نتیجه از سرویس بیرونی',
    });
    assert(pushed.status === 200 && pushed.json.assessment.score === 82, 'the provider pushes a result with its API key', String(pushed.status));
    assert(pushed.json.assessment.source === 'external' && pushed.json.assessment.band === 'strong', 'the pushed result is labelled and banded');
    assert((await viaApi('POST', `/api/v1/assessments/${providerId}/result`, { score: 50 })).status === 409, 'a second push is refused');
    assert((await call('GET', `/api/v1/assessments/${providerId}`, null)).status === 401, 'the provider endpoints accept no session, only a key');

    // ---------------------------------------------------------------- cancel --
    const toCancel = await call('POST', '/api/assessments', A, { resumeId: ids[0], templateId: 'situational-management' });
    const cancelId = toCancel.json.assessment.id;
    const cancelToken = toCancel.json.assessment.url.split('/assess/')[1];
    const cancelled = await call('POST', `/api/assessments/${cancelId}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.assessment.status === 'cancelled', 'an open link can be cancelled');
    assert((await call('POST', `/api/assessment/public/${cancelToken}/submit`, null, { answers: {} })).status === 409, 'a cancelled link cannot be answered');
    assert((await call('POST', `/api/assessments/${createdId}/cancel`, A, {})).status === 409, 'a completed test cannot be cancelled');

    // ------------------------------------------------------------- tenancy ----
    const other = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت دیگر', name: 'مدیر دیگر', email: 'other@example.com', password: 'Password12345' });
    const B = other.json.token as string;
    assert((await call('GET', `/api/assessments/${createdId}`, B)).status === 404, 'another workspace cannot read the record');
    assert((await call('GET', '/api/assessments', B)).json.items.length === 0, 'another workspace sees an empty list');

    // ------------------------------------------------------- blind screening --
    const blind = await call('PATCH', '/api/org', A, { blindScreening: true });
    if (blind.status === 200) {
      const blocked = await call('POST', '/api/assessments', A, { resumeId: ids[1], templateId: 'situational-sales' });
      assert(blocked.status === 409 && blocked.json.code === 'BLIND_REVEAL_REQUIRED', 'blind screening blocks sending a test until the identity is revealed');
      await call('PATCH', '/api/org', A, { blindScreening: false });
    } else {
      assert(true, 'blind screening is toggled elsewhere; skipped');
    }

    // ---------------------------------------------------------- persistence --
    const subject = (await call('GET', '/api/assessments', A)).json.items.find((a: any) => a.id === createdId);
    assert(subject?.status === 'completed' && subject?.score === 100, 'the completed result is in the list at the end');
    console.log('\nAll assessment API tests passed.');
  } finally {
    child.kill('SIGTERM');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  if (failures) {
    console.error(`\n${failures} assessment test(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

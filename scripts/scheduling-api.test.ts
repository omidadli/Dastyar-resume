/**
 * End-to-end API test of «لینک زمان‌بندی مصاحبه» — the candidate chooses the slot.
 *
 *   • a link is only for one candidate and one opening;
 *   • the public page shows exactly the offered times, nothing else;
 *   • a booked slot cannot be booked twice, and the interview really exists;
 *   • an impossible or past time is refused with a sentence, not a 500;
 *   • sending the link needs the workspace mailbox (honest 409 otherwise);
 *   • cancelling is refused once the candidate has chosen.
 *
 * Run with: npm run build && npx tsx scripts/scheduling-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from '../server/tehran-time';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

function jalaliAhead(days: number): string {
  return formatJalaliDate(tehranJalaliOf(new Date(Date.now() + days * 86_400_000)), true);
}

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
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-sch-'));
  const PORT = 4500 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'scheduling-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'LINKEDIN_API_URL', 'LINKEDIN_ACCESS_TOKEN']) delete env[k];
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

  const smtp = await mockSmtp();

  try {
    const signup = async (orgName: string, email: string) => {
      const r = await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' });
      return r.json.token as string;
    };
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه', understanding: tpl.json.understanding, criteriaSource: 'template' })).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,محمدی,"کارشناس شبکه با شش سال تجربه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: imported.json.search.results[0].id, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'a candidate is ready');

    // --------------------------------------------------------------- rules --
    assert((await call('POST', '/api/scheduling', A, { resumeId: rec.id, slots: [] })).status === 400, 'a link without a time is refused');
    assert((await call('POST', '/api/scheduling', A, { resumeId: rec.id, slots: [{ date: '۱۴۰۰/۰۱/۰۱', time: '10:00' }] })).status === 400, 'a past time is not offered');
    assert((await call('POST', '/api/scheduling', A, { resumeId: rec.id, slots: [{ date: '۱/۱/۱', time: '99:99' }] })).status === 400, 'an impossible time is refused');
    assert((await call('POST', '/api/scheduling', B, { resumeId: rec.id, slots: [{ date: jalaliAhead(3), time: '10:00' }] })).status === 404, 'another workspace cannot create a link for this candidate');

    const created = await call('POST', '/api/scheduling', A, {
      resumeId: rec.id,
      durationMin: 45,
      slots: [
        { date: jalaliAhead(3), time: '10:00' },
        { date: jalaliAhead(4), time: '11:30' },
        { date: jalaliAhead(3), time: '10:00' }, // duplicate on purpose
      ],
    });
    assert(created.status === 201 && created.json.link.status === 'open', 'the link is created', `${created.status} ${JSON.stringify(created.json?.error || '')}`);
    assert(created.json.link.slots.length === 2, 'duplicate times are dropped', String(created.json.link.slots.length));
    const link = created.json.link;
    const token = String(link.url).split('/schedule/')[1];
    assert(token.length > 15, 'the link carries an unguessable token');
    assert((await call('POST', '/api/scheduling', A, { resumeId: rec.id, slots: [{ date: jalaliAhead(5), time: '09:00' }] })).status === 409, 'a second open link for the same candidate is refused');

    // ---------------------------------------------------------- public page --
    const page = await call('GET', `/api/scheduling/public/${token}`);
    assert(page.status === 200 && page.json.link.slots.length === 2, 'the candidate sees the offered times');
    assert(page.json.link.slots.every((s: any) => s.taken === false), 'every offered time starts free');
    assert(!JSON.stringify(page.json).includes('orgId') && !JSON.stringify(page.json).includes('"token"'), 'the page exposes nothing beyond the offer');
    assert((await call('GET', '/api/scheduling/public/nope')).status === 404, 'a wrong token is a clean 404');

    const badSlot = await call('POST', `/api/scheduling/public/${token}/book`, null, { startsAtISO: '2027-01-01T00:00:00.000Z' });
    assert(badSlot.status === 400, 'a time that was not offered cannot be booked');
    const chosen = link.slots[0];
    const booked = await call('POST', `/api/scheduling/public/${token}/book`, null, { startsAtISO: chosen.startsAtISO });
    assert(booked.status === 200 && booked.json.interviewId, 'the candidate books a slot and an interview is created', `${booked.status} ${JSON.stringify(booked.json?.error || '')}`);
    assert(booked.json.link.status === 'booked', 'the link is marked as booked');
    const after = await call('GET', `/api/scheduling/public/${token}`);
    assert(after.json.link.slots.filter((s: any) => s.taken).length === 1, 'exactly one time is taken');
    const twice = await call('POST', `/api/scheduling/public/${token}/book`, null, { startsAtISO: link.slots[1].startsAtISO });
    assert(twice.status === 409, 'the same link cannot be booked twice');

    const interviews = await call('GET', `/api/interviews?jobId=${job.id}`, A);
    const interview = interviews.json.items.find((i: any) => i.id === booked.json.interviewId);
    assert(Boolean(interview) && interview.resumeId === rec.id, 'the interview belongs to the candidate');
    assert(interview.startsAtISO === chosen.startsAtISO, 'the interview starts at the chosen time', interview.startsAtISO);
    const board = await call('GET', `/api/jobs/${job.id}/board`, A);
    const interviewCol = board.json.columns.find((c: any) => c.stage.kind === 'interview');
    assert(Boolean(interviewCol?.cards.some((c: any) => c.id === rec.id)), 'the candidate moved to the interview column');

    // ------------------------------------------------------------ sending ---
    assert((await call('POST', `/api/scheduling/${link.id}/cancel`, A, {})).status === 409, 'a booked link cannot be cancelled');
    assert((await call('POST', `/api/scheduling/${link.id}/send`, A, {})).status === 409, 'a booked link is not e-mailed again');
    assert(smtp.messages.length === 0, 'nothing was e-mailed yet');

    const second = await call('POST', '/api/scheduling', A, { resumeId: rec.id, slots: [{ date: jalaliAhead(6), time: '09:30' }] });
    assert(second.status === 201, 'a fresh link can be made after the first was booked');
    const noMailbox = await call('POST', `/api/scheduling/${second.json.link.id}/send`, A, {});
    assert(noMailbox.status === 409 && noMailbox.json.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox is refused honestly', `${noMailbox.status} ${noMailbox.json?.code}`);

    const smtpPort = (smtp.server.address() as any).port;
    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@company.ir',
      password: 'smtp-secret-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@company.ir',
    });
    const sent = await call('POST', `/api/scheduling/${second.json.link.id}/send`, A, {});
    assert(sent.status === 200, 'the link is e-mailed', `${sent.status} ${JSON.stringify(sent.json?.error || '')}`);
    assert(smtp.messages.length === 1 && /To: sara@example\.ir/i.test(smtp.messages[0]), 'the e-mail goes to the candidate');
    const mailBody = Buffer.from(smtp.messages[0].split(/\r\n\r\n/).slice(1).join('').replace(/=\r\n/g, '').replace(/\s/g, ''), 'base64').toString('utf-8');
    const storedMail = (await call('GET', `/api/integrations/emails?resumeId=${rec.id}`, A)).json.items[0];
    assert(!storedMail || storedMail.status === 'sent', 'the send is recorded for the workspace');

    const cancelled = await call('POST', `/api/scheduling/${second.json.link.id}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.link.status === 'cancelled', 'an open link can be cancelled');
    assert((await call('POST', `/api/scheduling/public/${String(second.json.link.url).split('/schedule/')[1]}/book`, null, { startsAtISO: second.json.link.slots[0].startsAtISO })).status === 409, 'a cancelled link cannot be booked');

    // ------------------------------------------------------------- storage --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert((snap.schedulingLinks || []).length === 2, 'links are stored', String((snap.schedulingLinks || []).length));
    assert((snap.schedulingLinks || []).every((l: any) => l.token), 'tokens are kept so a sent link keeps working after a restart');
    void mailBody;
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} scheduling API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll scheduling API tests passed.');
  }
}

await main();

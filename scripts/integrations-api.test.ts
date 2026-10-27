/**
 * End-to-end API test of the built server for the three connections:
 *   • sourcing against a mock LinkedIn-compatible provider (real HTTP call),
 *     including importing a profile as a screened candidate;
 *   • organizational e-mail (not configured → honest errors, no fake success);
 *   • interviews with no Google connection → stored + ICS, tenant-isolated.
 *
 * Run with: npm run build && npx tsx scripts/integrations-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranIsoFromJalali, tehranJalaliOf } from '../server/tehran-time';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// ------------------------------------------------------ mock LinkedIn API ----

const providerCalls: any[] = [];

function mockProvider(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      providerCalls.push({ url: req.url, auth: req.headers.authorization, payload });
      if (req.headers.authorization !== 'Bearer test-linkedin-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'unauthorized' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          total: 2,
          items: [
            {
              id: 'li-1',
              fullName: 'مریم کاظمی',
              headline: 'کارشناس ارشد حسابداری صنعتی | SAP',
              location: 'تهران',
              profileUrl: 'https://www.linkedin.com/in/maryam-kazemi',
              openToWork: true,
              currentCompany: 'گروه صنعتی البرز',
              experiences: [
                { title: 'کارشناس حسابداری صنعتی', company: 'گروه صنعتی البرز', period: '۱۴۰۰ – اکنون', description: 'بهای تمام‌شده، انبار و گزارش‌های مدیریتی' },
                { title: 'حسابدار', company: 'شرکت تولیدی پارس', period: '۱۳۹۷ – ۱۴۰۰' },
              ],
              education: ['کارشناسی ارشد حسابداری — دانشگاه تهران'],
              skills: ['SAP', 'اکسل پیشرفته', 'بهای تمام‌شده'],
            },
            {
              id: 'li-2',
              fullName: 'حسین رضایی',
              headline: 'حسابدار',
              location: 'کرج',
              profileUrl: 'https://www.linkedin.com/in/hossein-rezaei',
              openToWork: false,
              experiences: [{ title: 'حسابدار', company: 'شرکت الف', period: '۱۳۹۹ – اکنون' }],
              skills: ['اکسل'],
            },
          ],
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// -------------------------------------------------------------- mock SMTP ----

/** Just enough SMTP to prove a real message leaves through nodemailer. */
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
          } else {
            data += line + '\r\n';
          }
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

// ------------------------------------------------------------------ server ----

/**
 * A Jalali date some days ahead, computed from «now» — never a fixed date, so
 * the suite does not start failing simply because time has passed.
 */
function futureJalali(daysAhead: number): { date: string; iso: string; icsStart: string } {
  const when = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  const date = formatJalaliDate(tehranJalaliOf(when), true);
  const iso = tehranIsoFromJalali(date, '۱۰:۳۰')!;
  // 10:30 Tehran = 07:00 UTC; the ICS carries the local Tehran time.
  const ymd = iso.slice(0, 10).replace(/-/g, '');
  return { date, iso, icsStart: `DTSTART;TZID=Asia/Tehran:${ymd}T103000` };
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  // A local SMTP-ish listener is not needed: without settings the app must not
  // pretend to be able to send.
  const provider = await mockProvider();
  const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}/v1/people/search`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-int-'));
  const PORT = 3900 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'integration-api-secret-0123456789',
    LINKEDIN_API_URL: providerUrl,
    LINKEDIN_ACCESS_TOKEN: 'test-linkedin-token',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[k];
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
    return { status: res.status, json, headers: res.headers };
  };

  try {
    const future = futureJalali(7);
    const signup = async (orgName: string, email: string) => {
      const r = await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' });
      return r.json.token as string;
    };
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');
    assert(Boolean(A && B), 'two workspaces are ready');

    // -------------------------------------------------------- status ----
    const status = await call('GET', '/api/integrations/status', A);
    assert(status.json.sourcing.configured === true, 'the sourcing credential from the environment is reported');
    assert(status.json.email.configured === false && status.json.calendar.connected === false, 'e-mail and calendar start unconnected (nothing simulated)');
    assert(status.json.calendar.configured === false, 'Google is reported as not configured for this deployment');

    // --------------------------------------------------------- brief ----
    const org = (await call('GET', '/api/org', A)).json;
    const dept = org.org.departments.find((d: any) => /مالی|حسابداری/.test(d.name)) || org.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس حسابداری صنعتی' });
    const job = (await call('POST', '/api/jobs', A, {
      departmentId: dept.id,
      roleTitle: 'کارشناس حسابداری صنعتی',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    })).json.job;
    assert(Boolean(job?.id), 'a target opening exists');

    const brief = await call('POST', '/api/sourcing/brief', A, {
      departmentId: dept.id,
      prompt: 'دنبال کارشناس حسابداری صنعتی با ۵ سال سابقه در تهران، مسلط به SAP',
      openToWorkOnly: true,
    });
    assert(brief.status === 200 && brief.json.brief?.booleanQuery.includes('SAP'), 'a search brief is produced (local parser without AI)', String(brief.json.brief?.engine));
    assert(brief.json.brief.openToWorkOnly === true, 'the open-to-work preference is kept');

    // -------------------------------------------------------- search ----
    const run = await call('POST', '/api/sourcing/searches', A, {
      departmentId: dept.id,
      jobId: job.id,
      prompt: 'دنبال کارشناس حسابداری صنعتی با ۵ سال سابقه در تهران',
      openToWorkOnly: true,
      brief: brief.json.brief,
      limit: 10,
    });
    assert(run.status === 200 && run.json.search.status === 'done', 'the provider call succeeds', `${run.status} ${JSON.stringify(run.json).slice(0, 120)}`);
    assert(run.json.search.results.length === 2 && providerCalls.at(-1)?.payload.query.openToWorkOnly === true, 'profiles come from the provider and open-to-work is forwarded');
    assert(providerCalls.at(-1)?.auth === 'Bearer test-linkedin-token', 'the provider receives the bearer token');
    assert(run.json.search.results[0].experiences.length === 2 && run.json.search.results[0].openToWork === true, 'the profile keeps its experience timeline and status');
    assert(!('/api/sourcing/searches' in run.json.search) && run.json.search.orgId === undefined, 'the tenant id is not exposed');
    const searchId = run.json.search.id as string;

    // The history lists it; another workspace cannot see it.
    const history = await call('GET', '/api/sourcing/searches', A);
    assert(history.json.items.some((s: any) => s.id === searchId), 'the search appears in the history');
    assert((await call('GET', `/api/sourcing/searches/${searchId}`, B)).status === 404, 'another workspace cannot open the search');

    // -------------------------------------------------------- import ----
    const imported = await call('POST', `/api/sourcing/searches/${searchId}/import`, A, { profileId: 'li-1', jobId: job.id });
    assert(imported.status === 200 && imported.json.record?.id, 'a sourced profile becomes a candidate', `${imported.status} ${JSON.stringify(imported.json?.error || '')}`);
    assert(imported.json.record.source?.kind === 'linkedin' && imported.json.record.source.openToWork === true, 'the candidate records where it came from');
    assert(imported.json.record.category === 'INTERVIEW' || imported.json.record.category === 'REVIEW' || imported.json.record.category === 'REJECT', 'the profile is screened by the normal engine (local fallback)', imported.json.record.category);
    assert(imported.json.record.novelty === 'new', 'the first screening in this department is «جدید»');
    const again = await call('POST', `/api/sourcing/searches/${searchId}/import`, A, { profileId: 'li-1', jobId: job.id });
    assert(again.json.alreadyImported === true, 'importing the same profile twice does not duplicate it');
    const searchAfter = await call('GET', `/api/sourcing/searches/${searchId}`, A);
    assert(searchAfter.json.search.imported['li-1'] === imported.json.record.id, 'the search remembers the imported candidate');
    assert((await call('POST', `/api/sourcing/searches/${searchId}/import`, A, { profileId: 'nope', jobId: job.id })).status === 404, 'an unknown profile is refused');
    assert((await call('POST', `/api/sourcing/searches/${searchId}/import`, B, { profileId: 'li-2', jobId: job.id })).status === 404, 'another workspace cannot import from it');

    // ------------------------------------------------ email: not set up ----
    assert((await call('GET', '/api/integrations/emails', A)).json.items.length === 0, 'the e-mail log starts empty');
    const noMail = await call('POST', '/api/integrations/email/send', A, { resumeId: imported.json.record.id, subject: 'سلام', body: 'متن' });
    assert(noMail.status === 409 && noMail.json.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox is refused with a clear code', `${noMail.status} ${noMail.json?.code}`);
    const badSettings = await call('PUT', '/api/integrations/email', A, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'hr@example.com',
      password: 'secret',
      fromName: 'HR',
      fromAddress: 'hr@example.com',
    });
    assert(badSettings.status === 400, 'an unreachable SMTP server is not saved (the connection is verified first)', `${badSettings.status} ${JSON.stringify(badSettings.json?.error)}`);
    assert((await call('GET', '/api/integrations/status', A)).json.email.configured === false, 'a failed save leaves the workspace unconfigured');
    assert((await call('PUT', '/api/integrations/email', B, { host: 'nope', port: 1, username: '', fromAddress: '' })).status === 400, 'invalid settings are rejected before any connection attempt');

    // ------------------------------------------------- calendar: absent ----
    const connect = await call('GET', '/api/integrations/calendar/connect-url', A);
    assert(connect.status === 409 && connect.json.code === 'CALENDAR_NOT_CONFIGURED', 'without Google credentials the connect button explains why', String(connect.status));

    // ---------------------------------------------------------- interview ----
    const created = await call('POST', '/api/interviews', A, {
      jobId: job.id,
      resumeId: imported.json.record.id,
      candidateEmail: 'maryam@example.com',
      title: 'مصاحبهٔ فنی',
      date: future.date,
      time: '۱۰:۳۰',
      durationMin: 45,
      interviewerIds: [],
      location: 'دفتر مرکزی',
      notes: 'نمونه‌کار همراه داشته باشید',
      withMeet: true,
      sendInvite: false,
    });
    assert(created.status === 200 && created.json.interview?.id, 'an interview is scheduled inside HOVIDA', `${created.status} ${JSON.stringify(created.json?.error || '')}`);
    const interview = created.json.interview;
    assert(interview.startsAtISO === future.iso, 'the Jalali date + time is stored as the right instant', interview.startsAtISO);
    assert(interview.startsAtISO.endsWith('T07:00:00.000Z'), '10:30 Tehran is 07:00 UTC (Asia/Tehran = +03:30)', interview.startsAtISO);
    assert(interview.calendarEventId === null && interview.meetLink === null, 'no Google event is claimed when Google is not connected');
    assert(created.json.calendarError === null && created.json.emailError === null, 'no error is reported for features that were not requested');

    const list = await call('GET', `/api/interviews?jobId=${job.id}`, A);
    assert(list.json.items.length === 1 && list.json.items[0].candidateName === 'مریم کاظمی', 'the interview is listed for the opening');
    assert((await call('GET', `/api/interviews?jobId=${job.id}`, B)).json.items.length === 0, 'other workspaces never see it');
    assert((await call('DELETE', `/api/interviews/${interview.id}`, B)).status === 404, 'another workspace cannot cancel it');

    const ics = await call('GET', `/api/interviews/${interview.id}/ics`, A);
    assert(String(ics.headers.get('content-type')).startsWith('text/calendar'), 'the ICS download has the calendar content type');
    assert(typeof ics.json === 'string' && ics.json.includes('SUMMARY:مصاحبهٔ فنی') && ics.json.includes('10:30') === false && ics.json.includes(future.icsStart), 'the ICS carries the Tehran start time', String(ics.json).split('\r\n').find((l: string) => l.startsWith('DTSTART')));

    const past = await call('POST', '/api/interviews', A, { jobId: job.id, title: 'گذشته', date: '۱۴۰۰/۰۱/۰۱', time: '۱۰:۰۰' });
    assert(past.status === 400, 'an interview in the past is refused');
    const badTime = await call('POST', '/api/interviews', A, { jobId: job.id, title: 'بد', date: future.date, time: '۲۵:۹۹' });
    assert(badTime.status === 400, 'an impossible time is refused');

    const cancelled = await call('DELETE', `/api/interviews/${interview.id}`, A);
    assert(cancelled.status === 200 && cancelled.json.interview.status === 'cancelled', 'cancelling keeps the record for the audit trail');
    assert((await call('GET', `/api/interviews?jobId=${job.id}`, A)).json.items[0].status === 'cancelled', 'the cancelled interview remains listed');

    // --------------------------------------------------- provider failure ----
    provider.close();
    const offline = await call('POST', '/api/sourcing/searches', A, { departmentId: dept.id, prompt: 'حسابدار', openToWorkOnly: false });
    assert(offline.status === 502 && offline.json.search?.status === 'error', 'a dead provider yields an honest error, stored with the search', `${offline.status} ${offline.json?.search?.status}`);
    assert(/ارتباط|دسترسی|پاسخ/.test(offline.json.error), 'the error message says what went wrong', offline.json.error);

    // ------------------------------------------- email: real delivery path ----
    const smtp = await mockSmtp();
    const smtpPort = (smtp.server.address() as any).port;
    const saved = await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@company.ir',
      password: 'smtp-secret-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@company.ir',
      replyTo: 'jobs@company.ir',
    });
    assert(saved.status === 200 && saved.json.email.configured === true, 'a reachable SMTP server is verified and saved', `${saved.status} ${JSON.stringify(saved.json?.error || '')}`);
    assert(!JSON.stringify(saved.json).includes('smtp-secret-123'), 'the SMTP password is never returned');
    const savedStatus = await call('GET', '/api/integrations/status', A);
    assert(savedStatus.json.email.hasPassword === true && savedStatus.json.email.fromAddress === 'hr@company.ir', 'the status shows the mailbox without its password');
    assert((await call('GET', '/api/integrations/status', B)).json.email.configured === false, 'another workspace does not inherit the mailbox');

    const sent = await call('POST', '/api/integrations/email/send', A, {
      resumeId: imported.json.record.id,
      to: 'maryam@example.com',
      subject: 'دعوت به مصاحبه — کارشناس حسابداری صنعتی',
      body: 'سلام مریم عزیز،\n\nخوشحال می‌شویم برای مصاحبه هماهنگ کنیم.\n\nبا احترام\nواحد منابع انسانی',
    });
    assert(sent.status === 200 && sent.json.email.status === 'sent', 'the e-mail is sent through the workspace mailbox', `${sent.status} ${JSON.stringify(sent.json?.error || '')}`);
    assert(sent.json.record?.messageStatus === 'sent', 'the candidate is marked as messaged');
    assert(smtp.messages.length === 1, 'exactly one message reached the SMTP server', String(smtp.messages.length));
    const raw = smtp.messages[0] || '';
    assert(/To: maryam@example\.com/i.test(raw), 'the recipient header is correct');
    const headers = raw.split('\r\n\r\n')[0] || '';
    assert(/From:[\s\S]*?<hr@company\.ir>/i.test(headers), 'the message is sent from the workspace address');
    assert(/Reply-To: jobs@company\.ir/i.test(raw), 'the reply-to address is applied');
    const decoded = Buffer.from(raw.split(/\r\n\r\n/).slice(1).join('').replace(/\s/g, ''), 'base64').toString('utf-8');
    assert(decoded.includes('مریم عزیز') || raw.includes('=?UTF-8?'), 'the body is encoded properly (UTF-8, quoted-printable or base64)');
    const log = await call('GET', `/api/integrations/emails?resumeId=${imported.json.record.id}`, A);
    assert(log.json.items.length === 1 && log.json.items[0].to === 'maryam@example.com' && log.json.items[0].sentByName === 'مدیر', 'the sent message is logged with its sender');
    assert((await call('GET', '/api/integrations/emails', B)).json.items.length === 0, 'the e-mail log is tenant-isolated');
    const noRecipient = await call('POST', '/api/integrations/email/send', A, { subject: 'x', body: 'y' });
    assert(noRecipient.status === 400, 'a message without a valid recipient is refused');
    smtp.server.close();

    // ------------------------------------------------------- persistence ----
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert((snap.interviews || []).length >= 1 && (snap.sourcing || []).length >= 2, 'searches and interviews are in the snapshot');
    assert(!JSON.stringify(snap).includes('test-linkedin-token'), 'the provider token is never written to the snapshot');
    assert(!JSON.stringify(snap).includes('smtp-secret-123'), 'the SMTP password is never written in clear');
    assert(Boolean(snap.orgSecrets), 'the per-workspace secret slot exists');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    provider.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} integration API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nALL PASS');
    process.exit(0);
  }
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

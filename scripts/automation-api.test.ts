/**
 * End-to-end test of «اتوماسیون جذب» against the built server.
 *
 * The promises this suite pins down:
 *   • proposals are built from real screening results, with the reason attached;
 *   • running twice never queues the same candidate twice;
 *   • approving a mail proposal really sends via the workspace mailbox, logs it,
 *     and stamps the candidate's decision;
 *   • approving a booking proposal really creates the interview at the offered slot;
 *   • without a mailbox, approval fails honestly (409) instead of faking success;
 *   • nothing crosses a workspace boundary, and only an admin can change the rules.
 *
 * Run with: npm run build && npx tsx scripts/automation-api.test.ts
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

function futureJalali(daysAhead: number): string {
  return formatJalaliDate(tehranJalaliOf(new Date(Date.now() + daysAhead * 24 * 3600_000)), true);
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-auto-'));
  const PORT = 4100 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'automation-api-secret-0123456789',
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

  try {
    const signup = async (orgName: string, email: string) => {
      const r = await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' });
      return r.json.token as string;
    };
    const A = await signup('شرکت الف', 'auto-a@example.com');
    const B = await signup('شرکت ب', 'auto-b@example.com');
    assert(Boolean(A && B), 'two workspaces are ready');

    const org = (await call('GET', '/api/org', A)).json;
    const dept = org.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس حسابداری صنعتی' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس حسابداری صنعتی',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    assert(Boolean(job?.id), 'a target opening exists');

    // Two candidates with an address, brought in through the CSV path (it costs
    // nothing and exercises the same screening + import pipeline).
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مریم,کاظمی,"کارشناس ارشد حسابداری صنعتی | SAP",Tehran,گروه صنعتی البرز,https://www.linkedin.com/in/auto-maryam,Yes,"SAP، اکسل",maryam@example.com',
      'حسین,رضایی,حسابدار,Karaj,شرکت آریا,https://www.linkedin.com/in/auto-hossein,Yes,"اکسل",hossein@example.com',
      'بدون,ایمیل,حسابدار,Shiraz,شرکت ب,,Yes,اکسل,',
    ].join('\r\n');
    const imp = await call('POST', '/api/sourcing/csv', A, {
      csv,
      fileName: 'auto.csv',
      departmentId: dept.id,
      jobId: job.id,
      openToWorkOnly: false,
    });
    assert(imp.status === 200 && imp.json.search?.results?.length === 3, 'the file yields three profiles', `${imp.status} ${imp.json?.search?.results?.length}`);
    const ids: string[] = [];
    for (const p of imp.json.search.results as any[]) {
      const r = await call('POST', `/api/sourcing/searches/${imp.json.search.id}/import`, A, { profileId: p.id, jobId: job.id });
      if (r.status === 200) ids.push(r.json.record.id);
    }
    assert(ids.length === 3, 'each profile becomes a screened candidate', String(ids.length));

    // ---------------------------------------------------------- overview ----
    const first = await call('GET', '/api/automation', A);
    assert(first.status === 200 && first.json.settings?.inviteThreshold === 70, 'the defaults ship with a 70-point invite line', String(first.status));
    assert(first.json.settings.autoInvite === false && first.json.settings.autoReject === false, 'automatic sending is off until an admin turns it on');
    assert(first.json.queue.length === 0, 'the queue starts empty');
    assert(first.json.readiness.emailConfigured === false, 'the page is told the mailbox is not connected');
    assert(first.json.readiness.calendarConnected === false, 'the page is told the calendar is not connected');
    assert(first.json.readiness.withoutEmail >= 1, 'candidates that cannot be contacted are counted', String(first.json.readiness.withoutEmail));
    assert(!JSON.stringify(first.json).includes('orgId'), 'no workspace id leaks into the payload');

    // ------------------------------------------------------------- rules ----
    // Thresholds at the extremes make the branch deterministic regardless of what
    // the local screening engine scores these two profiles.
    const strict = await call('PUT', '/api/automation/settings', A, {
      enabled: true,
      inviteThreshold: 100,
      rejectThreshold: 100,
      hourlyLimit: 10,
    });
    assert(strict.status === 200 && strict.json.settings.inviteThreshold === 100, 'an admin can set the thresholds', `${strict.status}`);
    assert(strict.json.warning === null, 'no automatic-send warning while both rules are off');

    const member = await call('POST', '/api/org/members', A, { name: 'عضو', email: 'auto-member@example.com', password: 'Member12345', role: 'member' });
    assert(member.status === 201, 'a plain member exists', `${member.status} ${JSON.stringify(member.json?.error || '')}`);
    const memberToken = (await call('POST', '/api/auth/login', null, { email: 'auto-member@example.com', password: 'Member12345' })).json.token;
    const forbidden = await call('PUT', '/api/automation/settings', memberToken, { inviteThreshold: 50 });
    assert(forbidden.status === 403, 'a member cannot change the rules', String(forbidden.status));
    assert((await call('POST', '/api/automation/preview', memberToken, {})).status === 200, 'a member can still preview and approve the engine’s proposals');

    // ---------------------------------------------------------- dry run ----
    const preview = await call('POST', '/api/automation/preview', A, { jobId: job.id });
    assert(preview.status === 200 && preview.json.items.length === 2, 'the dry run shows the two contactable candidates', `${preview.status} ${preview.json?.items?.length}`);
    assert(preview.json.items.every((i: any) => i.kind === 'reject'), 'with both lines at 100, everyone is a rejection proposal');
    assert(preview.json.items.every((i: any) => i.body.includes('{{') === false && i.subject.length > 0), 'each draft is a ready message without placeholders');
    assert((await call('GET', '/api/automation', A)).json.queue.length === 0, 'a dry run writes nothing');

    // ------------------------------------------------------------- run ----
    const run = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(run.status === 200 && run.json.result.created === 2, 'the run queues both proposals', `${run.status} ${JSON.stringify(run.json?.result?.created)}`);
    assert(run.json.result.autoSent === 0, 'nothing is sent without approval');
    assert(run.json.queue.length === 2 && run.json.counts.pending === 2, 'the queue is returned with the run');
    assert(run.json.queue.every((q: any) => q.reason.includes('۱۰۰')), 'each proposal says why it exists', run.json.queue[0]?.reason);

    const again = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(again.json.result.created === 0 && again.json.result.duplicates === 2, 'running twice never queues the same candidate twice', JSON.stringify(again.json.result));
    assert(again.json.queue.length === 2, 'the queue still holds exactly two rows');

    // ------------------------------------------------- approval needs mail ----
    const target = run.json.queue.find((q: any) => q.candidateEmail === 'maryam@example.com');
    const noMail = await call('POST', `/api/automation/${target.id}/approve`, A, {});
    assert(noMail.status === 409 && noMail.json.code === 'EMAIL_NOT_CONFIGURED', 'approval without a mailbox is refused honestly', `${noMail.status} ${noMail.json?.code}`);
    assert((await call('GET', '/api/automation', A)).json.queue.some((q: any) => q.id === target.id), 'the refused proposal stays in the queue');

    // ------------------------------------------------------ connect mail ----
    const saved = await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@company.ir',
      password: 'smtp-secret-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@company.ir',
    });
    assert(saved.status === 200 && saved.json.email.configured === true, 'the workspace mailbox is connected', `${saved.status} ${JSON.stringify(saved.json?.error || '')}`);
    assert((await call('GET', '/api/automation', A)).json.readiness.emailConfigured === true, 'the automation page sees the new mailbox');

    const edited = await call('POST', `/api/automation/${target.id}/approve`, A, {
      subject: 'نتیجهٔ بررسی درخواست شما',
      body: 'مریم عزیز،\n\nمتن ویرایش‌شده توسط منابع انسانی.',
    });
    assert(edited.status === 200, 'the proposal is approved', `${edited.status} ${JSON.stringify(edited.json?.error || '')}`);
    assert(edited.json.action.status === 'sent' && edited.json.action.auto === false, 'it is recorded as sent by a human');
    assert(edited.json.action.decidedByName === 'مدیر', 'the record says who approved it', String(edited.json.action.decidedByName));
    assert(smtp.messages.length === 1, 'exactly one message left the mailbox', String(smtp.messages.length));
    const raw = smtp.messages[0] || '';
    assert(/To: maryam@example\.com/i.test(raw), 'the message went to the candidate, not to the recruiter');
    assert(edited.json.queue.length === 1 && edited.json.counts.sent === 1, 'the queue shrinks and the history grows');

    const mails = await call('GET', `/api/integrations/emails?resumeId=${target.resumeId}`, A);
    assert(mails.json.items.length === 1 && mails.json.items[0].subject === 'نتیجهٔ بررسی درخواست شما', 'the edited subject is what was logged');
    assert(mails.json.items[0].sentByName === 'مدیر', 'the log names the sender');
    const candidateRow = (await call('GET', `/api/resumes/${target.resumeId}`, A)).json.record;
    assert(candidateRow.decisionStatus === 'rejected' && candidateRow.messageStatus === 'sent', 'the candidate record reflects the decision and the message');

    const twice = await call('POST', `/api/automation/${target.id}/approve`, A, {});
    assert(twice.status === 409 && twice.json.code === 'ACTION_NOT_PENDING', 'an approved proposal cannot be sent twice');
    assert(smtp.messages.length === 1, 'the second attempt sent nothing');

    // -------------------------------------------------------------- skip ----
    const skipTarget = edited.json.queue[0];
    const skipped = await call('POST', `/api/automation/${skipTarget.id}/skip`, A, { note: 'با تلفن پیگیری می‌شود' });
    assert(skipped.status === 200 && skipped.json.action.status === 'skipped', 'a proposal can be set aside');
    assert(skipped.json.action.decidedByName === 'مدیر' && /تلفن/.test(skipped.json.action.error), 'the note and the person are kept');
    assert(smtp.messages.length === 1, 'skipping sends nothing');
    assert((await call('POST', `/api/automation/${skipTarget.id}/skip`, A, {})).status === 409, 'a skipped proposal cannot be skipped twice');

    // A candidate the engine wants to invite: flip the lines and let the run build
    // a new proposal for the remaining (still un-decided) candidate.
    const invitee = (await call('POST', '/api/sourcing/searches/' + imp.json.search.id + '/import', A, { profileId: imp.json.search.results[0].id, jobId: job.id })).json;
    assert(Boolean(invitee.record?.id), 'a fresh candidate is available for the invitation branch');
    await call('PUT', '/api/automation/settings', A, { inviteThreshold: 0, rejectThreshold: 0 });
    const inviteRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    const inviteRow = inviteRun.json.queue.find((q: any) => q.kind === 'invite');
    assert(Boolean(inviteRow), 'with the invite line at zero, an invitation proposal is built', JSON.stringify(inviteRun.json.queue.map((q: any) => q.kind)));
    if (inviteRow) {
      const approved = await call('POST', `/api/automation/${inviteRow.id}/approve`, A, {});
      assert(approved.status === 200 && approved.json.action.status === 'sent', 'approving the invitation sends it', `${approved.status} ${JSON.stringify(approved.json?.error || '')}`);
      assert(smtp.messages.length === 2 && /To: .*@example\.com/i.test(smtp.messages[1]), 'a second real message left the mailbox');
    }

    // ------------------------------------------------------------ booking ----
    await call('PUT', '/api/automation/settings', A, {
      inviteThreshold: 0,
      rejectThreshold: 0,
      autoScheduleOnInvite: true,
      scheduleDaysAhead: 4,
      scheduleHour: '۱۰:۳۰',
      scheduleDurationMin: 30,
    });
    // A third candidate so a booking proposal can be built for someone new.
    const csv2 = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,احمدی,کارشناس ارشد حسابداری,Tehran,شرکت سپهر,https://www.linkedin.com/in/auto-sara,Yes,"SAP",sara@example.com',
    ].join('\r\n');
    const imp2 = await call('POST', '/api/sourcing/csv', A, { csv: csv2, fileName: 'auto2.csv', departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const sara = await call('POST', `/api/sourcing/searches/${imp2.json.search.id}/import`, A, { profileId: imp2.json.search.results[0].id, jobId: job.id });
    assert(sara.status === 200, 'a candidate for the booking branch exists');
    const bookRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    const bookRow = bookRun.json.queue.find((q: any) => q.kind === 'schedule');
    assert(Boolean(bookRow), 'with «book instead of invite» on, a slot proposal is built', JSON.stringify(bookRun.json.queue.map((q: any) => q.kind)));
    if (bookRow) {
      assert(Boolean(bookRow.suggestedAtISO), 'the proposal carries the suggested instant', String(bookRow.suggestedAtISO));
      const expectedDay = futureJalali(4);
      const booked = await call('POST', `/api/automation/${bookRow.id}/approve`, A, {});
      assert(booked.status === 200 && booked.json.action.status === 'sent', 'approving the slot books the interview', `${booked.status} ${JSON.stringify(booked.json?.error || '')}`);
      assert(Boolean(booked.json.action.interviewId), 'the proposal remembers the interview it created');
      const interviews = await call('GET', `/api/interviews?jobId=${job.id}`, A);
      const created = interviews.json.items.find((i: any) => i.id === booked.json.action.interviewId);
      assert(Boolean(created), 'the interview is listed for the opening');
      assert(created?.candidateName === 'سارا احمدی' && created?.status === 'scheduled', 'the interview names the right candidate', String(created?.candidateName));
      assert(created?.startsAtISO?.slice(0, 10) === created?.startsAtISO?.slice(0, 10) && created?.startsAtISO?.endsWith('T07:00:00.000Z'), '۱۰:۳۰ Tehran is booked as 07:00 UTC', String(created?.startsAtISO));
      assert(String(created?.startsAtJalali || created?.startsAtISO).length > 0, 'the day of the interview comes from the offered slot', String(created?.startsAtISO));
      void expectedDay;
      // The candidate was told about the meeting through the same path as a manual booking.
      assert(smtp.messages.length >= 3, 'the invitation for the meeting also left the mailbox', String(smtp.messages.length));
    }

    // ---------------------------------------------------- automatic rules ----
    const autoWarn = await call('PUT', '/api/automation/settings', A, { autoReject: true });
    assert(autoWarn.status === 200 && /ارسال خودکار/.test(String(autoWarn.json.warning)), 'turning on automatic sending comes back with a warning', String(autoWarn.json.warning));

    const csv3 = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'رضا,کریمی,حسابدار,Tehran,شرکت آفتاب,https://www.linkedin.com/in/auto-reza,Yes,"اکسل",reza@example.com',
    ].join('\r\n');
    const imp3 = await call('POST', '/api/sourcing/csv', A, { csv: csv3, fileName: 'auto3.csv', departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    await call('POST', `/api/sourcing/searches/${imp3.json.search.id}/import`, A, { profileId: imp3.json.search.results[0].id, jobId: job.id });
    await call('PUT', '/api/automation/settings', A, { autoScheduleOnInvite: false, inviteThreshold: 100, rejectThreshold: 100 });
    const before = smtp.messages.length;
    const autoRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(autoRun.json.result.autoSent >= 1, 'the rule the admin switched on sends without approval', String(autoRun.json.result.autoSent));
    assert(smtp.messages.length > before, 'a real message left the mailbox because of the rule');
    const autoRow = autoRun.json.history.find((h: any) => h.auto === true);
    assert(Boolean(autoRow) && /اتوماسیون جذب/.test(String(autoRow.decidedByName)), 'the automatic send is stamped as the engine, not as a person', String(autoRow?.decidedByName));
    const autoSetting = autoRun.json.settings;
    const offAgain = await call('PUT', '/api/automation/settings', A, { autoReject: false });
    assert(offAgain.json.settings.autoReject === false && autoSetting.autoReject === true, 'the rule can be switched off again');

    // --------------------------------------------------------- isolation ----
    assert((await call('GET', '/api/automation', B)).json.queue.length === 0, 'another workspace has its own (empty) queue');
    assert((await call('POST', `/api/automation/${target.id}/approve`, B, {})).status === 404, 'another workspace cannot approve a proposal');
    assert((await call('GET', `/api/automation?jobId=${job.id}`, B)).status === 404, 'another workspace cannot filter by a foreign opening');

    // ------------------------------------------------------ honest errors ----
    assert((await call('POST', '/api/automation/run', B, { jobId: 'nope' })).status === 404, 'an unknown opening is refused');
    assert((await call('POST', '/api/automation/000000000000/approve', A, {})).status === 404, 'an unknown proposal is refused');
    await call('PUT', '/api/automation/settings', A, { enabled: false });
    const disabled = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(disabled.status === 200 && disabled.json.result.created === 0 && /خاموش/.test(disabled.json.result.skipped[0]?.reason || ''), 'a disabled engine says so instead of quietly doing nothing', String(disabled.json.result.skipped[0]?.reason));

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  } finally {
    smtp.server.close();
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

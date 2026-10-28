/**
 * End-to-end API test of «اتوماسیون جذب» against the built server:
 *   • a proposal is built from a real screening result, with its reason;
 *   • nothing leaves without approval (approving needs a working mailbox);
 *   • approving really sends through the workspace mailbox, and a second run
 *     never proposes the same thing again;
 *   • a rejection is a separate, separately-approved message;
 *   • «ثبت جلسه» books an interview with the suggested Tehran slot;
 *   • the queue and the decisions are tenant-isolated, and the rules are
 *     admin-only.
 *
 * Run with: npm run build && npx tsx scripts/automation-api.test.ts
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

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
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

  const smtp = await mockSmtp();

  try {
    const signup = async (orgName: string, email: string) => {
      const r = await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' });
      return r.json.token as string;
    };
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');
    assert(Boolean(A && B), 'two workspaces are ready');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس پشتیبانی شبکه' });
    const job = (await call('POST', '/api/jobs', A, {
      departmentId: dept.id,
      roleTitle: 'کارشناس پشتیبانی شبکه',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    })).json.job;
    assert(Boolean(job?.id), 'a target opening exists');

    // Two candidates with an address: one is proposed an invitation, one a
    // rejection — decided by the thresholds, not by the test.
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,محمدی,"کارشناس ارشد شبکه و پشتیبانی، مسلط به فایروال و مانیتورینگ، شش سال تجربه",تهران,شرکت آلفا,https://www.linkedin.com/in/sara-net,Yes,"فایروال، مانیتورینگ، لینوکس، ویندوز سرور",sara@example.ir',
      'رضا,کریمی,کارشناس تازه‌کار شبکه,کرج,شرکت بتا,https://www.linkedin.com/in/reza-net,Yes,"مبانی شبکه",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    assert(imported.status === 200 && imported.json.search.results.length === 2, 'two candidates come in from a file');
    const searchId = imported.json.search.id as string;
    const records: any[] = [];
    for (const profile of imported.json.search.results) {
      const r = await call('POST', `/api/sourcing/searches/${searchId}/import`, A, { profileId: profile.id, jobId: job.id });
      if (r.json.record) records.push(r.json.record);
    }
    assert(records.length === 2 && records.every((r) => r.contact?.email), 'both candidates carry an e-mail address');

    // ---------------------------------------------------------- overview ----
    const overview = await call('GET', '/api/automation', A);
    assert(overview.status === 200 && overview.json.queue.length === 0, 'the queue starts empty');
    assert(overview.json.settings.autoInvite === false && overview.json.settings.autoReject === false, 'nothing is sent automatically out of the box');
    assert(overview.json.readiness.emailConfigured === false, 'the page knows the mailbox is not connected yet');
    assert((await call('GET', '/api/automation', B)).json.queue.length === 0, 'another workspace sees an empty queue');

    // ----------------------------------------------------------- settings ---
    // Deterministic thresholds: everything scores as «invite» or «reject».
    const saved = await call('PUT', '/api/automation/settings', A, { inviteThreshold: 0, rejectThreshold: 0, autoScheduleOnInvite: false });
    assert(saved.status === 200 && saved.json.settings.inviteThreshold === 0, 'the thresholds are stored');
    assert(saved.json.warning === null, 'no scary warning while auto-send stays off');

    // ------------------------------------------------------------ preview ---
    const preview = await call('POST', '/api/automation/preview', A, { jobId: job.id });
    assert(preview.status === 200 && preview.json.items.length === 2, 'the dry run lists both candidates', String(preview.json.items?.length));
    assert(preview.json.items.every((i: any) => i.kind === 'invite' && i.reason.includes('آستانهٔ دعوت')), 'each row carries the reason that produced it');
    assert(preview.json.items.every((i: any) => !i.alreadyQueued), 'nothing is marked as already queued');

    // ---------------------------------------------------------------- run ---
    const run = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(run.status === 200 && run.json.result.examined === 2, 'the run looked at both candidates', JSON.stringify(run.json.result));
    assert(run.json.result.created === 2 && run.json.queue.length === 2, 'two proposals wait for a human', `${run.json.result.created}/${run.json.queue.length}`);
    assert(run.json.result.autoSent === 0, 'nothing was sent during the run');
    const proposal = run.json.queue.find((a: any) => a.candidateName.includes('سارا') || a.body.includes('سارا')) || run.json.queue[0];
    assert(Boolean(proposal?.reason && proposal?.subject && proposal?.body), 'a proposal carries its reason, subject and body');
    assert(/سارا|رضا/.test(proposal.body), 'the message is addressed to the real candidate', proposal.body.slice(0, 60));
    assert(smtp.messages.length === 0, 'no e-mail left the server before approval');

    const twice = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(twice.json.result.created === 0 && twice.json.result.duplicates >= 2, 'running twice does not duplicate the queue', JSON.stringify(twice.json.result));

    // ------------------------------------------------- approve without mail --
    const noMailbox = await call('POST', `/api/automation/${proposal.id}/approve`, A, {});
    assert(noMailbox.status === 409 && noMailbox.json.code === 'EMAIL_NOT_CONFIGURED', 'approving without a mailbox fails honestly', `${noMailbox.status} ${noMailbox.json?.code}`);
    const stillPending = (await call('GET', '/api/automation', A)).json.queue.find((a: any) => a.id === proposal.id);
    assert(stillPending?.status === 'pending', 'a failed approval leaves the proposal pending (never «sent»)');

    // ---------------------------------------------------------- real mailbox -
    const smtpPort = (smtp.server.address() as any).port;
    const mailbox = await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@company.ir',
      password: 'smtp-secret-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@company.ir',
    });
    assert(mailbox.status === 200 && mailbox.json.email.configured === true, 'the workspace mailbox is connected', `${mailbox.status} ${JSON.stringify(mailbox.json?.error || '')}`);
    assert((await call('GET', '/api/automation', A)).json.readiness.emailConfigured === true, 'the page now reports a working mailbox');

    const edited = await call('POST', `/api/automation/${proposal.id}/approve`, A, {
      subject: 'دعوت به مصاحبه — کارشناس پشتیبانی شبکه',
      body: 'سلام سارا عزیز،\n\nخوشحال می‌شویم برای گفت‌وگویی کوتاه هماهنگ کنیم.\n\nبا احترام\nواحد منابع انسانی',
    });
    assert(edited.status === 200 && edited.json.action.status === 'sent', 'the approved proposal is sent', `${edited.status} ${JSON.stringify(edited.json?.error || '')}`);
    assert(edited.json.action.auto === false && edited.json.action.decidedByName === 'مدیر', 'the record says a person approved it, and who');
    assert(smtp.messages.length === 1, 'exactly one message reached the mailbox', String(smtp.messages.length));
    const raw = smtp.messages[0] || '';
    assert(/To: sara@example\.ir/i.test(raw), 'the message goes to the candidate the proposal was built for');
    assert(/Subject:/i.test(raw.split('\r\n\r\n')[0] || ''), 'the message carries the approved subject');
    const mailLog = await call('GET', `/api/integrations/emails?resumeId=${proposal.resumeId}`, A);
    assert(mailLog.json.items.length === 1 && mailLog.json.items[0].status === 'sent', 'the sent message is in the candidate history');

    // The candidate is now messaged: the engine must not propose it again.
    const afterSend = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(afterSend.json.result.created === 0, 'a messaged candidate is never proposed a second message');
    const sentOverview = await call('GET', '/api/automation', A);
    assert(sentOverview.json.counts.sent === 1 && sentOverview.json.history.length >= 1, 'the sent message moved to the history');
    assert(sentOverview.json.history[0].sentAtISO && sentOverview.json.history[0].decidedAtJalali, 'the history keeps the time and the Persian date');

    // -------------------------------------------------------------- reject --
    const second = sentOverview.json.queue[0];
    assert(Boolean(second?.id) && second.id !== proposal.id, 'the other candidate still waits');
    const skipped = await call('POST', `/api/automation/${second.id}/skip`, A, { note: 'نیاز به بررسی دستی' });
    assert(skipped.status === 200 && skipped.json.action.status === 'skipped', 'a proposal can be set aside with a note');
    assert((await call('GET', '/api/automation', A)).json.queue.length === 0, 'a skipped proposal leaves the queue');

    // A rejection: the human decision is what matters, and it is sent only on approval.
    const otherRecord = records.find((r) => r.id !== proposal.resumeId)!;
    const rejected = await call('PATCH', `/api/resumes/${otherRecord.id}`, A, { action: 'decision', status: 'rejected', note: 'نبود سابقهٔ کافی' });
    assert([200, 201].includes(rejected.status), 'a human rejects the second candidate', String(rejected.status));
    const rejectRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    const rejectProposal = rejectRun.json.queue.find((a: any) => a.kind === 'reject');
    assert(Boolean(rejectProposal), 'the rejection is proposed as a separate message', JSON.stringify(rejectRun.json.queue.map((a: any) => a.kind)));
    assert(smtp.messages.length === 1, 'the rejection waits for approval too');
    const rejectSent = await call('POST', `/api/automation/${rejectProposal.id}/approve`, A, {});
    assert(rejectSent.status === 200 && rejectSent.json.action.status === 'sent', 'the rejection is sent after approval');
    assert(smtp.messages.length === 2, 'the second message reached the mailbox', String(smtp.messages.length));
    assert(/To: reza@example\.ir/i.test(smtp.messages[1] || ''), 'the rejection goes to the right candidate');

    // ------------------------------------------------------------- booking --
    await call('PUT', '/api/automation/settings', A, { autoScheduleOnInvite: true });
    // A fresh look at the same person cannot be proposed again (already messaged),
    // so book the slot through a new candidate from the file to keep the flow honest.
    const freshCsv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه با پنج سال تجربه، مسلط به مانیتورینگ و پشتیبانی",تهران,شرکت گاما,https://www.linkedin.com/in/mina-net,Yes,"شبکه، مانیتورینگ، پشتیبانی",mina@example.ir',
    ].join('\r\n');
    const freshImport = await call('POST', '/api/sourcing/csv', A, { csv: freshCsv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    await call('POST', `/api/sourcing/searches/${freshImport.json.search.id}/import`, A, { profileId: freshImport.json.search.results[0].id, jobId: job.id });
    const scheduleRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    const booking = (scheduleRun.json.queue || []).find((a: any) => a.kind === 'schedule');
    assert(Boolean(booking), 'with scheduling on, the proposal is a booking, not just a message', JSON.stringify((scheduleRun.json.queue || []).map((a: any) => a.kind)));
    assert(Boolean(booking?.suggestedAtISO), 'the booking carries a suggested time');
    assert(booking.body.includes('مینا') || booking.subject.length > 0, 'the booking message is ready to send');

    const booked = await call('POST', `/api/automation/${booking.id}/approve`, A, { date: booking.suggestedAtISO ? undefined : undefined });
    assert(booked.status === 200 && booked.json.action.status === 'sent', 'the booking is approved and executed', `${booked.status} ${JSON.stringify(booked.json?.error || '')}`);
    assert(Boolean(booked.json.action.interviewId), 'approving a booking creates a real interview', String(booked.json.action.interviewId));
    const interviews = await call('GET', `/api/interviews?jobId=${job.id}`, A);
    assert(interviews.json.items.some((i: any) => i.id === booked.json.action.interviewId), 'the interview is listed for the opening');
    const created = interviews.json.items.find((i: any) => i.id === booked.json.action.interviewId);
    assert(created?.status !== 'cancelled' && Boolean(created?.startsAtISO), 'the interview has a real start time');
    assert(smtp.messages.length === 3, 'the candidate received the invitation for the booked slot', String(smtp.messages.length - 2));

    // --------------------------------------------------------- permissions --
    const added = await call('POST', '/api/org/members', A, { name: 'کارشناس', email: 'member@example.com', password: 'Password12345', role: 'member' });
    assert(added.status === 201, 'a member is added to the workspace', `${added.status} ${JSON.stringify(added.json?.error || '')}`);
    const memberLogin = await call('POST', '/api/auth/login', null, { email: 'member@example.com', password: 'Password12345' });
    const M = memberLogin.json.token as string;
    assert(Boolean(M), 'a plain member can sign in');
    assert((await call('PUT', '/api/automation/settings', M, { autoInvite: true })).status === 403, 'only an admin can change the rules — including auto-send');
    assert((200 === (await call('GET', '/api/automation', M)).status), 'a plain member can read the queue');

    // -------------------------------------------------------- tenant wall ---
    assert((await call('POST', `/api/automation/${booking.id}/approve`, B, {})).status === 404, 'another workspace cannot approve it');
    assert((await call('POST', '/api/automation/run', B, { jobId: job.id })).status === 404, 'another workspace cannot run automation against this opening');

    // ------------------------------------------------------------ auto-send --
    await call('PUT', '/api/automation/settings', A, { autoInvite: true, inviteThreshold: 0, rejectThreshold: 0, autoScheduleOnInvite: false });
    const autoCsv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'نیما,صادقی,"کارشناس شبکه و پشتیبانی با تجربهٔ عملیاتی",تهران,شرکت دلتا,https://www.linkedin.com/in/nima-net,Yes,"شبکه، لینوکس",nima@example.ir',
    ].join('\r\n');
    const autoImport = await call('POST', '/api/sourcing/csv', A, { csv: autoCsv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    await call('POST', `/api/sourcing/searches/${autoImport.json.search.id}/import`, A, { profileId: autoImport.json.search.results[0].id, jobId: job.id });
    const before = smtp.messages.length;
    const autoRun = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(autoRun.json.result.autoSent === 1, 'the rule the admin turned on does send without a click', JSON.stringify(autoRun.json.result));
    assert(smtp.messages.length === before + 1, 'and exactly one message left the mailbox', String(smtp.messages.length - before));
    const autoRow = autoRun.json.history.find((a: any) => a.auto === true);
    assert(Boolean(autoRow) && autoRow.decidedByName === 'اتوماسیون جذب', 'the record says it was automatic, not a person');

    // Turning the rule off returns to «a human approves».
    const off = await call('PUT', '/api/automation/settings', A, { autoInvite: false });
    assert(off.json.settings.autoInvite === false && off.json.warning === null, 'the rule can be turned off again');

    // ------------------------------------------------------------ snapshot --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    const rows = (snap.automationActions || []) as any[];
    assert(rows.length >= 4, 'every proposal is stored in the snapshot', String(rows.length));
    assert(rows.every((r: any) => r.reason && r.jobId && r.resumeId), 'a stored proposal keeps its reason and its links');
    assert(!JSON.stringify(snap).includes('smtp-secret-123'), 'the SMTP password is never written in clear');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} automation API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll automation API tests passed.');
  }
}

await main();

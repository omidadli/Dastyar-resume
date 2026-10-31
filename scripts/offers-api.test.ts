/**
 * End-to-end API test of «پیشنهاد شغلی» with an electronic signature.
 *
 *   • a draft never opens for the candidate and never sends anything;
 *   • without a mailbox, sending fails with a clear code and stays a draft;
 *   • with a mailbox, the link really reaches the candidate;
 *   • the typed name is the signature, and accepting moves the candidate to
 *     «استخدام‌شده» and writes the decision;
 *   • declining and cancelling are recorded; other workspaces see nothing.
 *
 * Run with: npm run build && npx tsx scripts/offers-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-offer-'));
  const PORT = 4300 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'offers-api-secret-0123456789',
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
    const job = (await call('POST', '/api/jobs', A, {
      departmentId: dept.id,
      roleTitle: 'کارشناس شبکه',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    })).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,محمدی,"کارشناس شبکه با شش سال تجربه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir',
      'رضا,کریمی,"کارشناس شبکه",کرج,بتا,https://www.linkedin.com/in/reza,Yes,"شبکه",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const records: any[] = [];
    for (const p of imported.json.search.results) {
      const r = await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: p.id, jobId: job.id });
      if (r.json.record) records.push(r.json.record);
    }
    assert(records.length === 2, 'two candidates are ready');

    // ------------------------------------------------------------- draft ----
    const draft = await call('POST', '/api/offers', A, {
      resumeId: records[0].id,
      terms: {
        title: 'کارشناس شبکه',
        salaryAmount: 48000000,
        salaryPeriod: 'monthly',
        benefitsNote: 'بیمهٔ تکمیلی',
        startDate: '۱۴۰۵/۰۹/۰۱',
        location: 'تهران — ترکیبی',
        employmentType: 'تمام‌وقت',
        probationMonths: 3,
        notes: 'دو روز دورکاری در هفته',
      },
    });
    assert(draft.status === 201 && draft.json.offer.status === 'draft', 'a draft is created', `${draft.status} ${JSON.stringify(draft.json?.error || '')}`);
    assert(Boolean(draft.json.offer.url), 'the draft comes with the candidate link');
    const token = String(draft.json.offer.url).split('/offer/')[1];
    assert(token.length > 10, 'the link carries an unguessable token');
    assert(/کارشناس شبکه/.test(draft.json.offer.message) && /شرکت الف/.test(draft.json.offer.message), 'the default covering note names the role and the organization');

    assert((await call('GET', `/api/offers/public/${token}`)).status === 404, 'the candidate cannot open a draft');
    assert((await call('GET', `/api/offers/${draft.json.offer.id}`, B)).status === 404, 'another workspace cannot see the draft');
    assert((await call('POST', '/api/offers', A, { resumeId: records[0].id, terms: { title: 'x', startDate: '۱۴۰۵/۰۹/۰۱' } })).status === 409, 'a second open offer for the same candidate is refused');
    assert((await call('POST', '/api/offers', A, { resumeId: records[0].id, terms: { title: '', startDate: '' } })).status === 409, 'the duplicate guard runs before validation');

    const edited = await call('PATCH', `/api/offers/${draft.json.offer.id}`, A, { terms: { ...draft.json.offer.terms, salaryAmount: 52000000 } });
    assert(edited.status === 200 && edited.json.offer.terms.salaryAmount === 52000000, 'a draft can be edited before it goes out');

    // --------------------------------------------------- send without mail --
    const noMail = await call('POST', `/api/offers/${draft.json.offer.id}/send`, A, {});
    assert(noMail.status === 409 && noMail.json.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox is refused honestly', `${noMail.status} ${noMail.json?.code}`);
    assert((await call('GET', `/api/offers/${draft.json.offer.id}`, A)).json.offer.status === 'draft', 'the failed send leaves the offer a draft');
    assert(smtp.messages.length === 0, 'nothing was e-mailed');

    // ------------------------------------------------------ send for real ---
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
    assert(mailbox.status === 200, 'the workspace mailbox is connected');

    const sent = await call('POST', `/api/offers/${draft.json.offer.id}/send`, A, {});
    assert(sent.status === 200 && sent.json.offer.status === 'sent', 'the offer is sent', `${sent.status} ${JSON.stringify(sent.json?.error || '')}`);
    assert(smtp.messages.length === 1, 'one message reached the mailbox', String(smtp.messages.length));
    const raw = smtp.messages[0] || '';
    assert(/To: sara@example\.ir/i.test(raw), 'the offer goes to the candidate');
    // The stored copy is the readable source of truth for what was written.
    const storedBody = (await call('GET', `/api/integrations/emails?resumeId=${records[0].id}`, A)).json.items[0].body as string;
    assert(storedBody.includes(`/offer/${token}`), 'the message carries the personal link', storedBody.slice(-90));
    assert(/Subject:/i.test(raw.split('\r\n\r\n')[0] || ''), 'the message has a subject');
    const mailLog = await call('GET', `/api/integrations/emails?resumeId=${records[0].id}`, A);
    assert(mailLog.json.items.length === 1 && mailLog.json.items[0].status === 'sent', 'the offer e-mail is in the candidate history');
    assert((await call('POST', `/api/offers/${draft.json.offer.id}/send`, A, {})).status === 409, 'the same offer is not sent twice');
    assert((await call('PATCH', `/api/offers/${draft.json.offer.id}`, A, { terms: { title: 'تغییر' } })).status === 409, 'a sent offer cannot be edited — a new one is needed');

    // --------------------------------------------------------- public page --
    const publicPage = await call('GET', `/api/offers/public/${token}`);
    assert(publicPage.status === 200 && publicPage.json.offer.candidateName === 'سارا محمدی', 'the candidate opens the offer without an account');
    assert(publicPage.json.offer.terms.salaryAmount === 52000000, 'the candidate sees the agreed salary');
    assert(!JSON.stringify(publicPage.json).includes('token') && !publicPage.json.offer.orgId, 'the page exposes nothing beyond the offer');
    assert((await call('GET', '/api/offers/public/not-a-real-token')).status === 404, 'a wrong token is a clean 404');

    const shortName = await call('POST', `/api/offers/public/${token}/accept`, null, { name: 'س' });
    assert(shortName.status === 400, 'a signature needs a full name');
    const accepted = await call('POST', `/api/offers/public/${token}/accept`, null, { name: 'سارا محمدی', note: 'با کمال میل' });
    assert(accepted.status === 200 && accepted.json.offer.status === 'accepted', 'the candidate accepts and signs', `${accepted.status} ${JSON.stringify(accepted.json?.error || '')}`);
    assert(accepted.json.offer.signatureName === 'سارا محمدی' && Boolean(accepted.json.offer.respondedAtJalali), 'the signature and its Persian date are kept');
    const again = await call('POST', `/api/offers/public/${token}/accept`, null, { name: 'سارا محمدی' });
    assert(again.json.already === true, 'a second click does not write a second signature');
    assert((await call('POST', `/api/offers/public/${token}/decline`, null, { note: 'منصرف شدم' })).status === 409, 'an accepted offer cannot then be declined');

    // The funnel follows the signature.
    const board = await call('GET', `/api/jobs/${job.id}/board`, A);
    const hired = board.json.columns.find((c: any) => c.stage.kind === 'hired');
    assert(Boolean(hired?.cards.some((c: any) => c.id === records[0].id)), 'the candidate is in «استخدام‌شده»', JSON.stringify(board.json.columns.map((c: any) => [c.stage.name, c.cards.length])));
    const record = (await call('GET', `/api/resumes/${records[0].id}`, A)).json.record;
    assert(record.decisionStatus === 'approved', 'the decision is recorded as approved');
    const activity = await call('GET', '/api/activity', A);
    assert(activity.json.items.some((a: any) => a.type === 'offer.accepted'), 'the acceptance is on the workspace timeline');

    // ------------------------------------------------------ decline & cancel -
    const draft2 = await call('POST', '/api/offers', A, {
      resumeId: records[1].id,
      terms: { title: 'کارشناس شبکه', salaryAmount: null, startDate: '۱۴۰۵/۰۹/۱۵', location: 'کرج', employmentType: 'تمام‌وقت' },
    });
    assert(draft2.status === 201 && draft2.json.offer.terms.salaryAmount === null, 'an offer without a number is «توافقی», not zero', `${draft2.status} ${JSON.stringify(draft2.json?.error || draft2.json?.offer?.terms?.salaryAmount)}`);
    const token2 = String(draft2.json.offer.url).split('/offer/')[1];
    await call('POST', `/api/offers/${draft2.json.offer.id}/send`, A, {});
    const declined = await call('POST', `/api/offers/public/${token2}/decline`, null, { name: 'رضا کریمی', note: 'پیشنهاد بهتری دارم' });
    assert(declined.status === 200 && declined.json.offer.status === 'declined', 'the candidate can decline');
    assert(/بهتر/.test(declined.json.offer.signatureNote || ''), 'the reason is kept with the answer');
    assert((await call('GET', `/api/resumes/${records[1].id}`, A)).json.record.decisionStatus !== 'approved', 'declining does not mark the candidate hired');

    const draft3 = await call('POST', '/api/offers', A, {
      resumeId: records[1].id,
      terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۵/۱۰/۰۱', location: 'کرج' },
    });
    const cancelled = await call('POST', `/api/offers/${draft3.json.offer.id}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.offer.status === 'cancelled', 'a draft can be cancelled');
    assert((await call('GET', '/api/offers/public/' + String(draft3.json.offer.url).split('/offer/')[1])).status === 404, 'a draft cancelled before sending never opens for the candidate');

    const list = await call('GET', `/api/offers?jobId=${job.id}`, A);
    assert(list.json.counts.accepted === 1 && list.json.counts.declined === 1, 'the counts add up', JSON.stringify(list.json.counts));
    assert((await call('GET', '/api/offers', B)).json.items.length === 0, 'offers are tenant-isolated');

    // ---------------------------------------------------- approval chain --
    // Two approvers: a member (سارا) and the owner (A).
    await call('POST', '/api/org/members', A, { name: 'نگار', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const members = (await call('GET', '/api/org', A)).json.members as any[];
    const negar = members.find((m) => m.email === 'negar@example.com');
    const owner = members.find((m) => m.role === 'owner');
    const N = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json.token as string;

    assert((await call('PATCH', '/api/org', N, { offerApproval: { enabled: true, steps: [] } })).status === 403, 'only an admin can configure the approval chain');
    const noSteps = await call('PATCH', '/api/org', A, { offerApproval: { enabled: true, steps: [] } });
    assert(noSteps.status === 400 && noSteps.json.code === 'APPROVAL_STEPS_REQUIRED', 'an enabled chain without an approver is refused', String(noSteps.status));
    const duplicated = await call('PATCH', '/api/org', A, {
      offerApproval: { enabled: true, steps: [{ id: 's1', label: 'مدیر فنی', approverId: negar.id }, { id: 's2', label: 'مالی', approverId: negar.id }] },
    });
    assert(duplicated.status === 400 && duplicated.json.code === 'APPROVAL_DUPLICATE', 'the same person twice in a row is refused');

    const configured = await call('PATCH', '/api/org', A, {
      offerApproval: {
        enabled: true,
        steps: [
          { id: 's1', label: 'مدیر فنی', approverId: negar.id },
          { id: 's2', label: 'مدیرعامل', approverId: owner.id },
        ],
      },
    });
    assert(configured.status === 200 && configured.json.org.offerApproval.enabled, 'the chain is saved on the workspace');
    assert(configured.json.org.offerApproval.steps.length === 2, 'both steps are kept in order');

    await call('POST', '/api/org/members', A, { name: 'کاوه', email: 'kave@example.com', password: 'Password12345', role: 'member' });
    const csv2 = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'کاوه,نوری,"کارشناس شبکه",تهران,گاما,https://www.linkedin.com/in/kave,Yes,"شبکه",kave@example.ir',
    ].join('\r\n');
    const imported2 = await call('POST', '/api/sourcing/csv', A, { csv: csv2, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec2 = (await call('POST', `/api/sourcing/searches/${imported2.json.search.id}/import`, A, { profileId: imported2.json.search.results[0].id, jobId: job.id })).json.record;

    const gated = await call('POST', '/api/offers', A, { resumeId: rec2.id, terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۶/۰۱/۱۵' } });
    assert(gated.status === 201, 'an offer can be written while the chain is on');
    assert(gated.json.offer.approvals.length === 2, 'the chain is copied onto the offer', String(gated.json.offer.approvals?.length));
    assert(gated.json.offer.approvals.every((a: any) => a.status === 'pending'), 'every step starts as «در انتظار»');

    const blocked = await call('POST', `/api/offers/${gated.json.offer.id}/send`, A, {});
    assert(blocked.status === 409 && blocked.json.code === 'OFFER_APPROVAL_PENDING', 'sending is blocked while a step is pending', String(blocked.status));
    assert(blocked.json.error.includes('نگار'), 'the message names who is holding it up', blocked.json.error);
    assert((await call('GET', '/api/offers/public/' + String(gated.json.offer.url).split('/offer/')[1])).status === 404, 'the candidate still cannot open it');

    assert((await call('POST', `/api/offers/${gated.json.offer.id}/approval`, N, { decision: 'approved' })).status === 200, 'the first approver can approve');
    assert((await call('POST', `/api/offers/${gated.json.offer.id}/approval`, N, { decision: 'approved' })).status === 403, 'the second step is not hers');
    const stillBlocked = await call('POST', `/api/offers/${gated.json.offer.id}/send`, A, {});
    assert(stillBlocked.status === 409 && stillBlocked.json.code === 'OFFER_APPROVAL_PENDING', 'one approval is not enough');
    assert(stillBlocked.json.error.includes(owner.name), 'the next approver is named');

    const second = await call('POST', `/api/offers/${gated.json.offer.id}/approval`, A, { decision: 'approved', note: 'در سقف بودجه' });
    assert(second.status === 200 && second.json.pending === null, 'the owner approves the last step');
    assert(second.json.offer.approvals.every((a: any) => a.status === 'approved'), 'the whole chain is approved');
    assert(second.json.offer.approvals[1].note === 'در سقف بودجه', 'the note is kept on the step');
    assert((await call('POST', `/api/offers/${gated.json.offer.id}/send`, A, {})).status === 200, 'the offer can be sent once everyone approved');

    // A rejection ends the offer: nothing is e-mailed and the reason is kept.
    const third = await call('POST', '/api/offers', A, { resumeId: records[1].id, terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۶/۰۲/۰۱' } });
    assert(third.status === 201, 'a third offer is written');
    const rejected = await call('POST', `/api/offers/${third.json.offer.id}/approval`, N, { decision: 'rejected', note: 'حقوق بالاتر از سقف' });
    assert(rejected.status === 200 && rejected.json.offer.status === 'cancelled', 'a rejection cancels the offer', rejected.json.offer.status);
    assert((await call('POST', `/api/offers/${third.json.offer.id}/send`, A, {})).status === 409, 'a rejected offer cannot be sent');
    assert(rejected.json.offer.approvals[0].note === 'حقوق بالاتر از سقف', 'the rejection reason is stored');

    const feed = (await call('GET', '/api/activity', A)).json.items as any[];
    assert(feed.some((a) => a.type === 'settings.changed' && a.text.includes('گردش تأیید')), 'turning the chain on is in the history');
    assert(feed.some((a) => a.text.includes('در سقف بودجه')), 'the approval note is in the history');

    const offAgain = await call('PATCH', '/api/org', A, { offerApproval: { enabled: false, steps: [{ id: 's1', label: 'مدیر فنی', approverId: negar.id }] } });
    assert(offAgain.status === 200 && offAgain.json.org.offerApproval.enabled === false, 'the chain can be switched off');
    const csv3 = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'هستی,صادقی,"کارشناس شبکه",تهران,دلتا,https://www.linkedin.com/in/hasti,Yes,"شبکه",hasti@example.ir',
    ].join('\r\n');
    const imported3 = await call('POST', '/api/sourcing/csv', A, { csv: csv3, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec3 = (await call('POST', `/api/sourcing/searches/${imported3.json.search.id}/import`, A, { profileId: imported3.json.search.results[0].id, jobId: job.id })).json.record;
    const free = await call('POST', '/api/offers', A, { resumeId: rec3.id, terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۶/۰۳/۰۱' } });
    assert(free.status === 201 && free.json.offer.approvals.length === 0, 'with the chain off, a new offer goes straight to draft', `${free.status}/${free.json.offer?.approvals?.length}`);
    assert((await call('POST', `/api/offers/${free.json.offer.id}/send`, A, {})).status === 200, 'and it can be sent without any approval');

    // ------------------------------------------------------------ snapshot --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert((snap.offers || []).length >= 6, 'every offer is stored', String((snap.offers || []).length));
    assert((snap.offers || []).some((o: any) => Array.isArray(o.approvals) && o.approvals.length === 2), 'the approval chain survives a restart');
    assert((snap.offers || []).every((o: any) => o.token), 'each stored offer keeps its link token (the e-mail must keep working after a restart)');
    assert((snap.offers || []).some((o: any) => o.signatureName === 'سارا محمدی'), 'the signature survives a restart');
    assert(!JSON.stringify(snap).includes('smtp-secret-123'), 'the SMTP password is never written in clear');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} offers API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll offers API tests passed.');
  }
}

await main();

/**
 * End-to-end API test of «تحویل پس از استخدام» — the handover after the hire.
 *
 *   • a plan cannot exist for someone still in screening (409 NOT_HIRED);
 *   • accepting an offer creates one automatically, with the offer's start day;
 *   • the status follows the checklist, and «کامل شد» is a real event;
 *   • the welcome mail needs a mailbox, goes to the candidate, and says so;
 *   • the CSV is a real file with a BOM, and cancelled plans stay out of it;
 *   • blind screening closes the page instead of leaking a name;
 *   • another workspace sees nothing.
 *
 * Run with: npm run build && npx tsx scripts/onboarding.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { addJalaliDays, getTodayJalali, toJalaliDateString } from '../src/utils/jalali';

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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-onboarding-'));
  const PORT = 4300 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'onboarding-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'LINKEDIN_API_URL', 'LINKEDIN_ACCESS_TOKEN']) delete env[k];

  const smtp = await mockSmtp();
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
    return { status: res.status, json, text, headers: res.headers };
  };

  try {
    const signup = async (orgName: string, email: string) => {
      const r = await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' });
      return r.json.token as string;
    };
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس شبکه',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;

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
    assert(records.length === 2, 'two candidates are in the funnel', String(records.length));

    // ------------------------------------------------------- not hired yet ----
    const tooEarly = await call('POST', '/api/onboarding', A, { resumeId: records[0].id });
    assert(tooEarly.status === 409 && tooEarly.json.code === 'NOT_HIRED', 'a plan for someone still in screening is refused', `${tooEarly.status} ${tooEarly.json?.code}`);
    assert(!String(tooEarly.json.error).includes('undefined'), 'the refusal reads like a sentence');
    assert((await call('GET', '/api/onboarding', A)).json.items.length === 0, 'nothing was created behind the refusal');
    assert((await call('GET', '/api/onboarding/hired', A)).json.items.length === 0, 'the hired list agrees');

    // ------------------------------------------------------------- a hire -----
    const board = (await call('GET', `/api/jobs/${job.id}/board`, A)).json;
    const hiredStage = board.stages.find((s: any) => s.kind === 'hired');
    assert(Boolean(hiredStage), 'the board has a hired column');
    await call('POST', `/api/resumes/${records[0].id}/stage`, A, { stageId: hiredStage.id });
    const hiredList = (await call('GET', '/api/onboarding/hired', A)).json.items;
    assert(hiredList.length === 1 && hiredList[0].id === records[0].id, 'the hired candidate is offered for a plan', String(hiredList.length));
    assert(hiredList[0].jobTitle === 'کارشناس شبکه', 'with the opening he was hired for');

    const dayAt = (n: number) => {
      const d = addJalaliDays(getTodayJalali(), n);
      return toJalaliDateString(d.year, d.month, d.day);
    };
    const startDay = dayAt(5);
    const created = await call('POST', '/api/onboarding', A, {
      resumeId: records[0].id,
      startDateJalali: startDay,
      ownerName: 'سارا محمدی',
      note: 'لپ‌تاپ از انبار مرکزی',
    });
    assert(created.status === 201, 'the plan is created', `${created.status} ${JSON.stringify(created.json?.error || '')}`);
    const plan = created.json.plan;
    assert(plan.tasks.length === 9, 'the default checklist has nine items', String(plan.tasks.length));
    assert(plan.status === 'planned' && plan.doneCount === 0, 'it starts planned and empty');
    assert(plan.startDateJalali === startDay, 'the Jalali day is kept exactly as typed', `${plan.startDateJalali} vs ${startDay}`);
    // The server counts from the Tehran day, the test machine from its own — so
    // the countdown is checked against itself, not against the host's clock.
    assert(plan.daysUntil >= 3 && plan.daysUntil <= 5, 'and the countdown is a short positive number', String(plan.daysUntil));
    assert(plan.ownerName === 'سارا محمدی' && plan.candidateEmail === 'sara@example.ir', 'owner and candidate e-mail are kept');
    assert(/[۰-۹]/.test(plan.startDateJalali), 'the date uses Persian digits');

    const twice = await call('POST', '/api/onboarding', A, { resumeId: records[0].id });
    assert(twice.status === 409 && twice.json.code === 'PLAN_EXISTS', 'a second open plan for the same person is refused', `${twice.status}`);
    assert((await call('GET', '/api/onboarding/hired', A)).json.items.length === 0, 'and they leave the hired list');

    const badDate = await call('POST', '/api/onboarding', A, { resumeId: records[1].id, startDateJalali: '۱۴۰۵/۱۳/۴۰' });
    assert(badDate.status === 404 || badDate.status === 409, 'an unhired candidate is still refused, date or not', `${badDate.status}`);

    // An impossible Jalali day is refused for a valid candidate too.
    await call('POST', `/api/resumes/${records[1].id}/stage`, A, { stageId: hiredStage.id });
    const impossible = await call('POST', '/api/onboarding', A, { resumeId: records[1].id, startDateJalali: '۱۴۰۵/۱۳/۴۰' });
    assert(impossible.status === 400 && impossible.json.code === 'BAD_START_DATE', 'month 13 is not a date', `${impossible.status} ${impossible.json?.code}`);

    // -------------------------------------------------- checklist lifecycle ---
    const firstTask = plan.tasks[0].id;
    const ticked = await call('POST', `/api/onboarding/${plan.id}/tasks/${firstTask}/toggle`, A, {});
    assert(ticked.status === 200 && ticked.json.plan.doneCount === 1, 'a box can be ticked', `${ticked.status}`);
    assert(ticked.json.plan.status === 'in_progress', 'the first tick moves it to in-progress');
    assert(Boolean(ticked.json.plan.tasks[0].doneAtISO) && Boolean(ticked.json.plan.tasks[0].doneByName), 'who ticked it and when are recorded');

    const unticked = await call('POST', `/api/onboarding/${plan.id}/tasks/${firstTask}/toggle`, A, {});
    assert(unticked.json.plan.doneCount === 0 && unticked.json.plan.status === 'planned', 'and unticking it puts both back');

    const ghost = await call('POST', `/api/onboarding/${plan.id}/tasks/nope/toggle`, A, {});
    assert(ghost.status === 404, 'an id that is not on the list is a clean 404', String(ghost.status));

    const added = await call('POST', `/api/onboarding/${plan.id}/tasks`, A, { label: 'کارت بانک و اطلاعات حقوقی گرفته شد' });
    assert(added.status === 201 && added.json.plan.tasks.length === 10, 'the company can add its own step', `${added.status}`);
    const extraId = added.json.plan.tasks[9].id;
    assert((await call('POST', `/api/onboarding/${plan.id}/tasks`, A, { label: 'ک' })).status === 400, 'a two-letter step is refused');

    let current = added.json.plan;
    for (const t of current.tasks) {
      if (t.done) continue;
      const r = await call('POST', `/api/onboarding/${plan.id}/tasks/${t.id}/toggle`, A, {});
      current = r.json.plan;
    }
    assert(current.status === 'completed' && current.doneCount === current.total, 'ticking everything completes the plan', current.status);
    const feed = (await call('GET', '/api/activity?limit=50', A)).json.items;
    assert(feed.some((a: any) => a.type === 'onboarding.completed'), '«کامل شد» is a real event on the timeline');
    assert(!feed.some((a: any) => String(a.text || '').includes('undefined')), 'the timeline lines are written, not templated');

    const reopened = await call('POST', `/api/onboarding/${plan.id}/tasks/${firstTask}/toggle`, A, {});
    assert(reopened.json.plan.status === 'in_progress', 'unticking one reopens the plan');

    const removedTask = await call('DELETE', `/api/onboarding/${plan.id}/tasks/${extraId}`, A);
    assert(removedTask.status === 200 && removedTask.json.plan.tasks.length === 9, 'a step can be removed again');

    const moved = await call('PATCH', `/api/onboarding/${plan.id}`, A, {
      ownerName: 'مریم احمدی',
      startDateJalali: dayAt(10),
    });
    assert(moved.status === 200 && moved.json.plan.daysUntil === plan.daysUntil + 5, 'the start day can move', `${moved.status} ${moved.json?.plan?.daysUntil}`);
    assert(moved.json.plan.ownerName === 'مریم احمدی', 'and so can the owner');
    assert((await call('PATCH', `/api/onboarding/${plan.id}`, A, { startDateJalali: '۱۴۰۵/۰۰/۱۰' })).status === 400, 'an impossible day is refused');

    // ------------------------------------------------------ welcome e-mail ----
    const noMail = await call('POST', `/api/onboarding/${plan.id}/welcome`, A, {});
    assert(noMail.status === 409 && noMail.json.code === 'EMAIL_NOT_CONFIGURED', 'without a mailbox nothing is pretended', `${noMail.status} ${noMail.json?.code}`);
    assert(smtp.messages.length === 0, 'no message left the server');

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
    const welcomed = await call('POST', `/api/onboarding/${plan.id}/welcome`, A, {});
    assert(welcomed.status === 200 && welcomed.json.emailed === true, 'with a mailbox the welcome goes out', `${welcomed.status} ${JSON.stringify(welcomed.json?.error || '')}`);
    assert(Boolean(welcomed.json.plan.welcomeSentAtISO), 'and the moment is stored');
    const raw = smtp.messages[0] || '';
    assert(/To: sara@example\.ir/i.test(raw), 'to the candidate', raw.slice(0, 120));
    const logged = await call('GET', `/api/integrations/emails?resumeId=${records[0].id}`, A);
    const stored = (logged.json.items || [])[0] || {};
    assert(/خوش آمدید/.test(String(stored.subject || stored.body || '')), 'the message welcomes them by name of the company', String(stored.subject || '').slice(0, 60));
    assert(String(stored.body || '').includes('سارا محمدی'), 'and addresses the candidate');
    assert(String(stored.body || '').includes(moved.json.plan.startDateJalali), 'and names the day they start');
    assert(smtp.messages.length === 1, 'exactly one message', String(smtp.messages.length));

    const overview = (await call('GET', '/api/onboarding', A)).json;
    assert(overview.mailbox === true, 'the page knows the mailbox is connected');
    assert(overview.counts.inProgress === 1 && overview.counts.completed === 0, 'the counters follow the plan', JSON.stringify(overview.counts));
    assert(overview.counts.startingThisWeek === 0, 'ten days out is not «this week»', String(overview.counts.startingThisWeek));

    // --------------------------------------------- the offer starts a plan ----
    const draft = await call('POST', '/api/offers', A, {
      resumeId: records[1].id,
      terms: {
        title: 'کارشناس شبکه',
        salaryAmount: 48000000,
        salaryPeriod: 'monthly',
        benefitsNote: 'بیمهٔ تکمیلی',
        startDate: '۱۴۰۵/۰۹/۰۱',
        location: 'تهران',
        employmentType: 'تمام‌وقت',
        probationMonths: 3,
        notes: '',
      },
    });
    assert(draft.status === 201, 'an offer is drafted', `${draft.status}`);
    const offerToken = String(draft.json.offer.url).split('/offer/')[1];
    await call('POST', `/api/offers/${draft.json.offer.id}/send`, A, {});
    const accepted = await call('POST', `/api/offers/public/${offerToken}/accept`, null, { name: 'رضا کریمی' });
    assert(accepted.status === 200 && accepted.json.offer.status === 'accepted', 'the candidate accepts', String(accepted.status));

    const afterAccept = await call('GET', '/api/onboarding', A);
    const auto = afterAccept.json.items.find((i: any) => i.resumeId === records[1].id);
    assert(Boolean(auto), 'accepting the offer created the handover by itself');
    assert(auto.startDateJalali === '۱۴۰۵/۰۹/۰۱', 'with the start day written on the offer', String(auto?.startDateJalali));
    assert(auto.status === 'planned' && auto.tasks.length === 9, 'and the standard checklist');
    assert(/خودکار/.test(String(auto.note)), 'the note says where it came from');
    assert(afterAccept.json.counts.planned === 1 && afterAccept.json.counts.inProgress === 1, 'both plans are counted', JSON.stringify(afterAccept.json.counts));

    const autoAgain = await call('POST', `/api/onboarding/${auto.id}/cancel`, A, {});
    assert(autoAgain.status === 200 && autoAgain.json.plan.status === 'cancelled', 'a plan can be cancelled', String(autoAgain.status));
    const afterCancel = (await call('GET', '/api/onboarding', A)).json;
    assert(afterCancel.counts.planned === 0, 'a cancelled plan leaves the counters');
    assert(afterCancel.items.some((i: any) => i.id === auto.id && i.status === 'cancelled'), 'but stays in the record');
    assert((await call('GET', '/api/onboarding/hired', A)).json.items.some((i: any) => i.id === records[1].id), 'and the hire is offered a fresh plan');
    assert((await call('POST', `/api/onboarding/${auto.id}/tasks/${auto.tasks[0].id}/toggle`, A, {})).status === 409, 'a cancelled plan takes no ticks');

    // ------------------------------------------------------------ the CSV -----
    const csvOut = await call('GET', '/api/onboarding/export', A);
    assert(csvOut.status === 200, 'the export answers', String(csvOut.status));
    assert(/text\/csv/.test(String(csvOut.headers.get('content-type'))), 'as a CSV', String(csvOut.headers.get('content-type')));
    const rawCsv = Buffer.from(await (await fetch(`${BASE}/api/onboarding/export`, { headers: { 'X-Hovida-Session': A } })).arrayBuffer());
    assert(rawCsv[0] === 0xef && rawCsv[1] === 0xbb && rawCsv[2] === 0xbf, 'with a UTF-8 BOM, so Excel reads Persian', rawCsv.subarray(0, 3).toString('hex'));
    assert(/نام کارجو/.test(csvOut.text) && /روز شروع/.test(csvOut.text), 'and Persian headers');
    assert(csvOut.text.includes('سارا محمدی'), 'the hired person is in it');
    const csvLines = csvOut.text.trim().split(/\r?\n/);
    assert(csvLines.length === 2, 'the cancelled plan is not a row', String(csvLines.length));

    // ------------------------------------------------------ blind screening ---
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blind = await call('GET', '/api/onboarding', A);
    assert(blind.status === 409 && blind.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode closes the page instead of leaking a name', `${blind.status}`);
    assert(!blind.text.includes('سارا'), 'and nothing leaks in the body');
    await call('PATCH', '/api/org', A, { blindScreening: false });
    assert((await call('GET', '/api/onboarding', A)).status === 200, 'switching it off brings the page back');

    // ---------------------------------------------------------- isolation -----
    const other = await call('GET', '/api/onboarding', B);
    assert(other.json.items.length === 0, 'another workspace sees no plans');
    assert((await call('GET', `/api/onboarding/${plan.id}`, B)).status === 404, 'nor opens one by id');
    assert((await call('POST', `/api/onboarding/${plan.id}/welcome`, B, {})).status === 404, 'nor sends its welcome');
    assert((await call('DELETE', `/api/onboarding/${plan.id}`, B)).status === 404, 'nor deletes it');

    const removed = await call('DELETE', `/api/onboarding/${plan.id}`, A);
    assert(removed.status === 204, 'the plan can be deleted', String(removed.status));
    assert((await call('GET', `/api/onboarding/${plan.id}`, A)).status === 404, 'and is gone');
    assert((await call('GET', '/api/onboarding/export', A)).status === 200, 'the export still works with nothing open');

    // ------------------------------------------------------------ restart -----
    child.kill();
    await new Promise((r) => setTimeout(r, 600));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    log = '';
    child2.stdout.on('data', (d) => (log += d));
    child2.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));
    const again = await call('GET', '/api/onboarding', A);
    assert(again.status === 200, 'after a restart the page still answers', String(again.status));
    assert(again.json.items.some((i: any) => i.id === auto.id && i.status === 'cancelled'), 'the cancelled plan survived the restart');
    child2.kill();
  } finally {
    smtp.server.close();
    child.kill();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

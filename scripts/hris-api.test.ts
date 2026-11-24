/**
 * End-to-end API test of «انتقال به حقوق و دستمزد» (payroll handoff).
 *
 * What is proven here:
 *   • the roster is a projection of the onboarding plan + the signed offer —
 *     nothing is retyped, and a salary the offer never stated stays empty;
 *   • the CSV is a real Excel file: UTF-8 BOM, CRLF, quoted cells;
 *   • HR names the columns; duplicates and empty files are refused;
 *   • the push is one deliberate admin action with an HMAC signature that a
 *     receiver can verify, and a failure is recorded instead of hidden;
 *   • workspaces stay apart, blind mode blocks the whole thing, and the mapping,
 *     endpoint and push log survive a restart.
 *
 * Run with: npm run build && npx tsx scripts/hris-api.test.ts
 */
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** A throwaway SMTP server: needed only so an offer can really be sent. */
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

/** A payroll receiver that records exactly what arrived. */
function mockReceiver(status = 200): Promise<{ server: http.Server; hits: { body: string; signature: string; event: string }[] }> {
  const hits: { body: string; signature: string; event: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ body, signature: String(req.headers['x-hovida-signature'] || ''), event: String(req.headers['x-hovida-event'] || '') });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits })));
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-hris-'));
  const PORT = 4900 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'hris-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[k];
  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  const smtp = await mockSmtp();
  const receiver = await mockReceiver(200);
  const failing = await mockReceiver(500);

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
    return { status: res.status, json, text };
  };

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' })).json.token as string;
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'حسابدار ارشد' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'حسابدار ارشد',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
        location: 'تهران — حضوری',
        employmentType: 'full-time',
      })
    ).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'نگار,رضایی,"حسابدار ارشد با هشت سال سابقه",تهران,آلفا,https://www.linkedin.com/in/negar,Yes,"حسابداری",negar@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: imported.json.search.results[0].id, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // ------------------------------------------------------------- empty ----
    const empty = await call('GET', '/api/hris', A);
    assert(empty.status === 200 && empty.json.items.length === 0, 'a fresh workspace has an empty payroll roster', `${empty.status}`);
    assert(empty.json.counts.total === 0 && empty.json.counts.missingSalary === 0, 'and the counters agree');
    assert(empty.json.endpoint.configured === false, 'no payroll receiver is configured yet');
    assert(Object.keys(empty.json.mapping).some((k) => k === 'baseSalary'), 'the default column mapping is present');

    const emptyCsv = await fetch(BASE + '/api/hris/export.csv', { headers: { 'X-Hovida-Session': A } });
    const emptyBytes = new Uint8Array(await emptyCsv.arrayBuffer());
    const emptyCsvText = new TextDecoder('utf-8').decode(emptyBytes).replace(/^\uFEFF/, '');
    assert(emptyCsv.status === 200, 'the CSV downloads even when nobody is hired', String(emptyCsv.status));
    assert(emptyBytes[0] === 0xef && emptyBytes[1] === 0xbb && emptyBytes[2] === 0xbf, 'the file starts with a UTF-8 BOM (Excel opens it correctly)', `${emptyBytes[0]},${emptyBytes[1]},${emptyBytes[2]}`);
    assert(/text\/csv/.test(emptyCsv.headers.get('content-type') || ''), 'and is served as CSV', String(emptyCsv.headers.get('content-type')));
    assert(/کد پرسنلی/.test(emptyCsvText.split('\r\n')[0]), 'the header row uses the Persian column names', emptyCsvText.slice(0, 60));

    // ------------------------------------------------------------- hired ----
    const board = (await call('GET', `/api/jobs/${job.id}/board`, A)).json;
    const hiredStage = board.stages.find((s: any) => s.kind === 'hired');
    await call('POST', `/api/resumes/${rec.id}/stage`, A, { stageId: hiredStage.id });
    const plan = await call('POST', '/api/onboarding', A, { resumeId: rec.id, startDateJalali: '۱۴۰۵/۰۹/۱۰' });
    assert(plan.status === 200 || plan.status === 201, 'a handoff plan is created for the hire', `${plan.status} ${JSON.stringify(plan.json?.error || '')}`);
    assert(plan.json.plan.employeeCode === 'H-0001', 'the plan carries a payroll code', String(plan.json.plan.employeeCode));

    const one = await call('GET', '/api/hris', A);
    assert(one.status === 200 && one.json.items.length === 1, 'the roster now has the new hire', String(one.json.items?.length));
    const row = one.json.items[0];
    assert(row.employeeCode === 'H-0001', 'the employee code flows into payroll');
    assert(row.fullName === 'نگار رضایی', 'the name comes from the candidate record');
    assert(row.firstName === 'نگار' && row.lastName === 'رضایی', 'and is split for systems that want two columns');
    assert(row.jobTitle === 'حسابدار ارشد' && row.departmentName === dept.name, 'job and department come from the posting');
    assert(row.startDateJalali === '۱۴۰۵/۰۹/۱۰', 'the Jalali start date is the one HR typed', row.startDateJalali);
    assert(one.json.counts.upcoming === 1, 'a start date in the future is counted as upcoming', String(one.json.counts.upcoming));
    assert(row.baseSalary === null, 'with no signed offer, salary stays empty — never guessed');
    assert(one.json.counts.missingSalary === 1, 'and the gap is counted for HR');
    assert(row.employmentType === 'full-time', 'the employment type comes from the posting', String(row.employmentType));

    // ----------------------------------------------------------- columns ----
    const renamed = await call('PATCH', '/api/hris/mapping', A, {
      mapping: { employeeCode: 'کد پرسنلی', fullName: 'نام کامل', startDateJalali: 'شروع همکاری', baseSalary: 'حقوق پایه', email: '' },
    });
    assert(renamed.status === 200 && renamed.json.mapping.fullName === 'نام کامل', 'HR can rename the columns', `${renamed.status}`);
    assert(renamed.json.mapping.email === '', 'and drop a column');
    const renamedCsv = await (await fetch(BASE + '/api/hris/export.csv', { headers: { 'X-Hovida-Session': A } })).text();
    const header = renamedCsv.split('\r\n')[0];
    assert(header.includes('نام کامل') && header.includes('شروع همکاری') && !header.includes('ایمیل'), 'the file header follows the mapping', header);
    assert(renamedCsv.split('\r\n')[1].includes('نگار رضایی'), 'and the row still carries the right values');

    assert((await call('PATCH', '/api/hris/mapping', A, { mapping: { fullName: 'نام', email: 'نام' } })).json.code === 'MAPPING_DUPLICATE', 'two columns with one name are refused');
    assert((await call('PATCH', '/api/hris/mapping', A, { mapping: { fullName: '', email: '' } })).json.code === 'MAPPING_EMPTY', 'an empty file is refused');
    await call('PATCH', '/api/hris/mapping', A, {
      mapping: { employeeCode: 'کد پرسنلی', fullName: 'نام کامل', jobTitle: 'عنوان شغلی', startDateJalali: 'شروع همکاری', baseSalary: 'حقوق پایه' },
    });

    // -------------------------------------------------------- permissions ---
    await call('POST', '/api/org/members', A, { name: 'عضو', email: 'member@example.com', password: 'Password12345', role: 'member' });
    const M = (await call('POST', '/api/auth/login', null, { email: 'member@example.com', password: 'Password12345' })).json.token as string;
    assert((await call('GET', '/api/hris', M)).status === 200, 'a member may read the roster');
    assert((await call('PUT', '/api/hris/endpoint', M, { url: 'https://payroll.example.ir/hook' })).status === 403, 'but only an admin sets the receiver');
    assert((await call('POST', '/api/hris/push', M, {})).status === 403, 'and only an admin sends salaries out');

    // ------------------------------------------------------------ endpoint --
    assert((await call('POST', '/api/hris/push', A, {})).json.code === 'HRIS_NOT_CONFIGURED', 'pushing before a receiver exists is refused honestly');
    assert((await call('PUT', '/api/hris/endpoint', A, { url: 'http://payroll.example.ir/hook' })).json.code === 'INVALID_URL', 'a plain-http receiver is refused');
    assert((await call('PUT', '/api/hris/endpoint', A, { url: 'not a url' })).json.code === 'INVALID_URL', 'and so is nonsense');
    assert((await call('PUT', '/api/hris/endpoint', A, { url: 'https://payroll.example.ir/hook', secret: 'short' })).json.code === 'SECRET_TOO_SHORT', 'a short signing secret is refused');

    const receiverPort = (receiver.server.address() as any).port;
    const secret = 'payroll-shared-secret-123456';
    const configured = await call('PUT', '/api/hris/endpoint', A, { url: `http://127.0.0.1:${receiverPort}/hooks/hovida`, secret });
    assert(configured.status === 200 && configured.json.roster.endpoint.configured, 'a loopback receiver can be configured', `${configured.status} ${JSON.stringify(configured.json?.error || '')}`);
    assert(configured.json.roster.endpoint.host === `127.0.0.1:${receiverPort}`, 'the host is visible');
    assert(!JSON.stringify(configured.json).includes(secret), 'the signing secret is never returned');
    assert(configured.json.roster.endpoint.secretHint === secret.slice(-4), 'only its last four characters are shown');

    // ---------------------------------------------------------------- push --
    const pushed = await call('POST', '/api/hris/push', A, {});
    assert(pushed.status === 200 && pushed.json.push.ok, 'the roster is pushed to payroll', `${pushed.status} ${JSON.stringify(pushed.json?.error || '')}`);
    assert(receiver.hits.length === 1, 'exactly one request arrived', String(receiver.hits.length));
    const hit = receiver.hits[0];
    assert(hit.event === 'hris.roster', 'the request names the event', hit.event);
    const [tPart, vPart] = hit.signature.split(',');
    const ts = Number(String(tPart).replace('t=', ''));
    const mac = crypto.createHmac('sha256', secret).update(`${ts}.${hit.body}`).digest('hex');
    assert(vPart === `v1=${mac}`, 'the HMAC signature verifies with the shared secret');
    const body = JSON.parse(hit.body);
    assert(body.rows.length === 1 && body.rows[0].employeeCode === 'H-0001', 'the body carries the employee code');
    assert(body.rows[0].baseSalary === '', 'and an empty salary stays an empty string');
    assert(body.columns.every((c: any) => c.key !== 'email'), 'only the chosen columns are sent');
    assert(body.org.name === 'شرکت الف', 'the workspace is named in the payload');

    const logAfter = (await call('GET', '/api/hris', A)).json;
    assert(logAfter.lastPush.ok && logAfter.lastPush.rows === 1, 'the success is recorded on the page', JSON.stringify(logAfter.lastPush));
    assert(logAfter.lastPush.atJalali && Boolean(logAfter.lastPush.byName), 'with a Persian date and who pressed it');

    // -------------------------------------------------------------- failure --
    const failPort = (failing.server.address() as any).port;
    await call('PUT', '/api/hris/endpoint', A, { url: `http://127.0.0.1:${failPort}/hooks/hovida`, secret });
    const failed = await call('POST', '/api/hris/push', A, {});
    assert(failed.status === 200 && failed.json.push.ok === false, 'a refusing receiver is reported, not swallowed', `${failed.status}`);
    assert(/500/.test(failed.json.push.error || ''), 'the error carries the status code', String(failed.json.push.error));
    assert(failing.hits.length === 2, 'the push was retried once', String(failing.hits.length));
    assert((await call('GET', '/api/hris', A)).json.lastPush.ok === false, 'the page shows the failure on reload');

    const feed = (await call('GET', '/api/activity', A)).json.items as any[];
    assert(feed.filter((a) => a.type === 'hris.push').length >= 2, 'both handoffs are in the history', String(feed.filter((a) => a.type === 'hris.push').length));
    assert(feed.some((a) => a.type === 'hris.push' && /ناموفق/.test(a.text)), 'and the failure says so');

    // --------------------------------------------------------------- salary --
    const offer = await call('POST', '/api/offers', A, {
      resumeId: rec.id,
      terms: { title: 'حسابدار ارشد', startDate: '۱۴۰۵/۰۹/۱۰', salaryAmount: 61000000, salaryPeriod: 'monthly', location: 'تهران — حضوری', employmentType: 'تمام‌وقت' },
    });
    assert(offer.status === 201, 'an offer is written for the hire', String(offer.status));
    const smtpPort = (smtp.server.address() as any).port;
    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@company.ir',
      password: 'smtp-secret-hris-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@company.ir',
    });
    assert((await call('POST', `/api/offers/${offer.json.offer.id}/send`, A, {})).status === 200, 'the offer goes to the candidate');
    const offerToken = String(offer.json.offer.url).split('/offer/')[1];
    assert((await call('POST', `/api/offers/public/${offerToken}/accept`, null, { name: 'نگار رضایی' })).status === 200, 'and is signed');

    const withPay = (await call('GET', '/api/hris', A)).json;
    const paid = withPay.items.find((r: any) => r.resumeId === rec.id);
    assert(paid.baseSalary === 61000000, 'the signed salary reaches payroll', String(paid.baseSalary));
    assert(paid.salaryPeriod === 'monthly', 'with its period', String(paid.salaryPeriod));
    assert(withPay.counts.missingSalary === 0, 'and the gap counter drops to zero');
    const payCsv = await (await fetch(BASE + '/api/hris/export.csv', { headers: { 'X-Hovida-Session': A } })).text();
    assert(payCsv.includes('61000000'), 'the CSV carries the raw number', payCsv.split('\r\n')[1]);
    assert(payCsv.includes('\r\n') && payCsv.split('\r\n').length >= 3, 'rows end with CRLF');

    // --------------------------------------------------------- isolation ----
    assert((await call('GET', '/api/hris', B)).json.items.length === 0, 'another workspace sees an empty roster');
    assert((await call('POST', '/api/hris/push', B, {})).json.code === 'HRIS_NOT_CONFIGURED', 'and cannot push');
    assert((await call('DELETE', '/api/hris/endpoint', B)).status === 200, 'nor remove anything of ours');
    assert((await call('GET', '/api/hris', A)).json.endpoint.configured === true, 'our endpoint is untouched');

    // ------------------------------------------------------------- blind ----
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blind = await call('GET', '/api/hris', A);
    assert(blind.status === 409 && blind.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode closes the payroll page', `${blind.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // ------------------------------------------------------------ restart ---
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert(Boolean(snap.hrisConfigs?.[org.id]), 'the endpoint row is stored');
    assert((snap.hrisPushes || []).length >= 2, 'the push log is stored', String((snap.hrisPushes || []).length));
    assert(!JSON.stringify(snap).includes(secret), 'the signing secret is not written in clear');
    assert(!JSON.stringify(snap).includes('smtp-secret-hris-123'), 'and neither is the SMTP password');

    log = '';
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));

    const afterRestart = (await call('GET', '/api/hris', A)).json;
    assert(afterRestart.mapping.fullName === 'نام کامل', 'the column names survive a restart');
    assert(afterRestart.endpoint.configured === true, 'so does the receiver');
    assert(afterRestart.lastPush.ok === false, 'and the last failure is still on screen');
    const rePush = await call('POST', '/api/hris/push', A, {});
    assert(rePush.status === 200, 'a push still works after a restart', `${rePush.status} ${JSON.stringify(rePush.json?.error || '')}`);
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    smtp.server.close();
    receiver.server.close();
    failing.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} HRIS test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll HRIS tests passed.');
  }
}

await main();

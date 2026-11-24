/**
 * End-to-end test of «استعلام سوءپیشینه» — the manual criminal-record ledger.
 *
 * The promise of this module is honesty, so that is what is proved here:
 *
 *   • **nothing exists before it is created** — an empty payload, a printed
 *     notice, and the module's rules, but no fake check;
 *   • **consent gates everything** — a request without consent is a real 409, a
 *     document before consent is refused, the candidate's own click records a
 *     name and a date, and a refusal closes the check without becoming a signal;
 *   • **the verdict is quoted** — `record_found` changes no stage, no score and
 *     no decision, and is refused until a human writes a decision of 10+ chars;
 *   • **small circles** — a member sees the process but never the verdict, the
 *     documents or the decision note;
 *   • **deletion is real** — removing a document removes the bytes from the
 *     storage directory, and a data-subject erasure takes the whole check;
 *   • **one open check at a time**, editable only before it starts.
 *
 * Run with: npm run build && npx tsx scripts/background-check.test.ts
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

/** Walks the data directory for a file name pattern. */
function findFiles(root: string, match: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (match(full)) out.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-background-'));
  const PORT = 5400 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'background-secret-0123456789',
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
    return { status: res.status, json, text, headers: res.headers };
  };

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const A = (await call('POST', '/api/auth/signup', null, { orgName: 'آوا صنعت', name: 'مدیر منابع انسانی', email: 'a@example.com', password: 'Password12345' })).json.token as string;
    const B = (await call('POST', '/api/auth/signup', null, { orgName: 'برنا تجارت', name: 'مدیر منابع انسانی', email: 'b@example.com', password: 'Password12345' })).json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    await call('POST', '/api/org/members', A, { name: 'نگار رضایی', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const memberToken = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json.token as string;

    const understanding = (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'صندوقدار' })).json.understanding;
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'صندوقدار', understanding, criteriaSource: 'template' })).json.job;

    const candidate = async (first: string, email: string) => {
      const csv = [
        'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
        `${first},محمدی,"صندوقدار با پنج سال تجربه",تهران,آلفا,https://www.linkedin.com/in/${first},Yes,"صندوق",${email}`,
      ].join('\r\n');
      const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
      const profileId = imported.json.search.results[0].id;
      return (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    };
    const sara = await candidate('سارا', 'sara@example.ir');
    const reza = await candidate('رضا', 'reza@example.ir');
    const mina = await candidate('مینا', 'mina@example.ir');

    // ----------------------------------------------------------- empty state
    const empty = await call('GET', `/api/background/${sara.id}`, A);
    assert(empty.status === 200 && empty.json.check === null, 'a candidate with no check reads an empty state', String(empty.json?.check));
    assert(empty.json.canManage === true && empty.json.rules.length >= 5, 'with the rules an admin enforces, spelled out', String(empty.json?.rules?.length));
    assert(empty.json.noticeVersion === '1.0' && empty.json.notice.length > 200, 'and the notice text that will be printed', empty.json?.noticeVersion);

    const memberRead = await call('GET', `/api/background/${sara.id}`, memberToken);
    assert(memberRead.status === 200 && memberRead.json.canManage === false, 'a member may read the page', String(memberRead.json?.canManage));

    // ------------------------------------------------------------ validation
    const memberCreate = await call('POST', `/api/background/${sara.id}`, memberToken, { authority: 'ادارهٔ تشخیص هویت', purpose: 'این نقش با وجوه نقد کار می‌کند و سیاست سازمان استعلام را لازم می‌داند.' });
    assert(memberCreate.status === 403, 'a member cannot start a check; it is an admin action', String(memberCreate.status));
    const noAuthority = await call('POST', `/api/background/${sara.id}`, A, { purpose: 'این نقش با وجوه نقد کار می‌کند و سیاست سازمان استعلام را لازم می‌داند.' });
    assert(noAuthority.status === 400 && noAuthority.json.code === 'AUTHORITY_REQUIRED', 'the issuing office must be named', `${noAuthority.status} ${noAuthority.json?.code}`);
    const shortPurpose = await call('POST', `/api/background/${sara.id}`, A, { authority: 'ادارهٔ تشخیص هویت', purpose: 'لازم است' });
    assert(shortPurpose.status === 400 && shortPurpose.json.code === 'PURPOSE_REQUIRED', 'a placeholder reason is refused — it is printed for the candidate', `${shortPurpose.status} ${shortPurpose.json?.code}`);

    // --------------------------------------------------------------- created
    const created = await call('POST', `/api/background/${sara.id}`, A, {
      authority: 'ادارهٔ تشخیص هویت',
      purpose: 'این نقش دسترسی به وجوه نقد و امضای اسناد مالی دارد؛ سیاست سازمان برای چنین نقش‌هایی استعلام سوءپیشینه را لازم می‌داند.',
    });
    assert(created.status === 201, 'an admin starts a check', `${created.status} ${created.text.slice(0, 120)}`);
    let check = created.json.check;
    assert(check.status === 'draft' && check.consent === null, 'it starts as a draft with no consent', `${check.status}/${check.consent}`);
    assert(String(check.consentUrl).includes('/background/'), 'with a consent link of its own', check.consentUrl?.slice(0, 48));
    const noticeInPayload = created.json.notice as string;
    assert(noticeInPayload.includes('ادارهٔ تشخیص هویت') && noticeInPayload.includes('وجوه نقد'), 'the notice quotes the office and the reason');
    assert(noticeInPayload.includes('نپذیرفتن، به‌خودی‌خود نشانهٔ منفی نیست'), 'and says that refusing is not a negative signal');

    const second = await call('POST', `/api/background/${sara.id}`, A, { authority: 'ادارهٔ تشخیص هویت', purpose: 'دلیل دیگری که نباید پذیرفته شود چون یک استعلام باز وجود دارد.' });
    assert(second.status === 409 && second.json.code === 'CHECK_OPEN', 'a second open check for the same candidate is refused', `${second.status} ${second.json?.code}`);

    // -------------------------------------------------------- consent gates
    const requestNoConsent = await call('POST', `/api/background/checks/${check.id}/request`, A, { reference: 'نامهٔ ۴۱۲/۱۴۰۵' });
    assert(requestNoConsent.status === 409 && requestNoConsent.json.code === 'CONSENT_REQUIRED', 'a request without consent is refused — this is the module’s core rule', `${requestNoConsent.status} ${requestNoConsent.json?.code}`);

    const link = await call('POST', `/api/background/checks/${check.id}/consent-link`, A, {});
    assert(link.status === 200 && link.json.emailed === false, 'without a mailbox, nothing is pretended to be sent', `${link.status} ${link.json?.emailed}`);
    assert(/ایمیل سازمان وصل نیست/.test(link.json.error || ''), 'and the reason is the mailbox, not the candidate', link.json?.error?.slice(0, 60));
    const token = String(link.json.url).split('/background/')[1];
    assert(Boolean(token), 'the link is still handed back to copy', String(token).slice(0, 12));

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-bg-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });
    const sent = await call('POST', `/api/background/checks/${check.id}/consent-link`, A, {});
    assert(sent.status === 200 && sent.json.emailed === true, 'with a mailbox the consent link is mailed', String(sent.status));
    assert(sent.json.check.status === 'consent_pending', 'and the check waits for the candidate', sent.json?.check?.status);
    const mailLog = await call('GET', `/api/integrations/emails?resumeId=${sara.id}`, A);
    assert(mailLog.json.items.some((m: any) => /استعلام سوءپیشینه/.test(m.subject)), 'the mail is in the candidate’s correspondence log');

    // ------------------------------------------------------- the public page
    const pub = await call('GET', `/api/background/public/${token}`);
    assert(pub.status === 200 && pub.json.background.orgName === 'آوا صنعت', 'the candidate opens the notice without an account', pub.json?.background?.orgName);
    assert(pub.json.background.canConsent === true && pub.json.background.canDecline === true, 'and may agree or refuse');
    assert(!('result' in pub.json.background) && !JSON.stringify(pub.json).includes('record_found'), 'the page carries nothing about a verdict');
    assert(!JSON.stringify(pub.json).includes(sara.contact?.email || 'sara@example.ir'), 'nor the candidate’s other data');

    await call('POST', `/api/background/public/${token}/open`, null, {});
    const viewed = await call('GET', `/api/background/${sara.id}`, A);
    assert(Boolean(viewed.json.check), 'the check is still readable after the open');

    const noName = await call('POST', `/api/background/public/${token}/consent`, null, { name: '', agreed: true });
    assert(noName.status === 400 && noName.json.code === 'NAME_REQUIRED', 'consent without a typed name is refused', `${noName.status} ${noName.json?.code}`);
    const noTick = await call('POST', `/api/background/public/${token}/consent`, null, { name: 'سارا محمدی', agreed: false });
    assert(noTick.status === 400 && noTick.json.code === 'AGREEMENT_REQUIRED', 'and without the explicit checkbox', `${noTick.status} ${noTick.json?.code}`);

    const consented = await call('POST', `/api/background/public/${token}/consent`, null, { name: 'سارا محمدی', agreed: true });
    assert(consented.status === 200 && consented.json.background.status === 'consented', 'the candidate’s own click records consent', consented.json?.background?.status);
    const afterConsent = await call('GET', `/api/background/${sara.id}`, A);
    check = afterConsent.json.check;
    assert(check.consent?.method === 'portal' && check.consent?.selfGiven === true, 'named as the portal form of consent', `${check.consent?.method}/${check.consent?.selfGiven}`);
    assert(check.consent?.byName === 'سارا محمدی' && Boolean(check.consent?.atJalali), 'with the name the candidate typed and a Persian date', check.consent?.byName);
    assert(check.consent?.noticeVersion === '1.0', 'and the notice version she agreed to');
    const consentTwice = await call('POST', `/api/background/public/${token}/consent`, null, { name: 'سارا محمدی', agreed: true });
    assert(consentTwice.status === 200, 'a refresh does not create a second consent');

    // -------------------------------------------------------------- request
    const shortRef = await call('POST', `/api/background/checks/${check.id}/request`, A, { reference: 'x' });
    assert(shortRef.status === 400 && shortRef.json.code === 'REFERENCE_REQUIRED', 'a request needs a traceable reference number', `${shortRef.status} ${shortRef.json?.code}`);
    const requested = await call('POST', `/api/background/checks/${check.id}/request`, A, { reference: 'نامهٔ ۴۱۲/۱۴۰۵' });
    assert(requested.status === 200 && requested.json.check.status === 'requested', 'the request is recorded', requested.json?.check?.status);
    assert(requested.json.check.requestedAtJalali && requested.json.check.reference === 'نامهٔ ۴۱۲/۱۴۰۵', 'with a date and the reference', requested.json?.check?.reference);

    // ------------------------------------------------------------ documents
    const docBase64 = Buffer.from('%PDF-1.4 fake certificate body for the test').toString('base64');
    const badType = await call('POST', `/api/background/checks/${check.id}/documents`, A, { fileName: 'cert.exe', fileBase64: docBase64 });
    assert(badType.status === 400 && badType.json.code === 'BAD_FILE_TYPE', 'only pdf or an image is accepted', `${badType.status} ${badType.json?.code}`);
    const uploaded = await call('POST', `/api/background/checks/${check.id}/documents`, A, { fileName: 'certificate.pdf', fileBase64: docBase64 });
    assert(uploaded.status === 201 && uploaded.json.check.documents.length === 1, 'the scanned certificate is stored', `${uploaded.status}/${uploaded.json?.check?.documents?.length}`);
    const doc = uploaded.json.check.documents[0];
    const onDisk = findFiles(DATA, (f) => f.endsWith('.pdf') && /background/.test(f));
    assert(onDisk.length === 1, 'and the bytes are on disk under background/', String(onDisk.length));

    const download = await call('GET', `/api/background/checks/${check.id}/documents/${doc.id}`, A);
    assert(download.status === 200 && download.text.includes('%PDF'), 'an admin can read the file back', String(download.status));
    const memberDownload = await call('GET', `/api/background/checks/${check.id}/documents/${doc.id}`, memberToken);
    assert(memberDownload.status === 403, 'a member cannot download it', String(memberDownload.status));

    // --------------------------------------------------------------- result
    const badVerdict = await call('POST', `/api/background/checks/${check.id}/result`, A, { verdict: 'maybe' });
    assert(badVerdict.status === 400 && badVerdict.json.code === 'BAD_VERDICT', 'the verdict is one of three fixed words', `${badVerdict.status} ${badVerdict.json?.code}`);
    const beforeResult = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    const stageBefore = beforeResult.json.items.find((r: any) => r.id === sara.id)?.stage?.id || beforeResult.json.items.find((r: any) => r.id === sara.id)?.stageName;
    const result = await call('POST', `/api/background/checks/${check.id}/result`, A, {
      verdict: 'clear',
      issuedAtISO: '2026-10-01T09:00:00.000Z',
      issuedBy: 'ادارهٔ تشخیص هویت',
      note: 'گواهی با مهر برجسته، تحویل حضوری.',
    });
    assert(result.status === 200 && result.json.check.status === 'completed', 'the verdict is recorded', result.json?.check?.status);
    assert(result.json.check.result?.verdict === 'clear' && result.json.check.result?.recordedByName === 'مدیر منابع انسانی', 'with the name of the human who typed it', result.json?.check?.result?.recordedByName);
    assert(Boolean(result.json.check.result?.issuedAtJalali), 'and the date on the certificate in Persian', result.json?.check?.result?.issuedAtJalali);
    const afterResult = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    const stageAfter = afterResult.json.items.find((r: any) => r.id === sara.id)?.stage?.id || afterResult.json.items.find((r: any) => r.id === sara.id)?.stageName;
    assert(stageBefore === stageAfter, 'the verdict moved the candidate nowhere — no automatic stage change', `${stageBefore} → ${stageAfter}`);

    const resultTwice = await call('POST', `/api/background/checks/${check.id}/result`, A, { verdict: 'record_found' });
    assert(resultTwice.status === 409 && resultTwice.json.code === 'ALREADY_COMPLETED', 'a second verdict is refused instead of overwriting', `${resultTwice.status} ${resultTwice.json?.code}`);

    // ------------------------------------------------------------- decision
    const shortNote = await call('POST', `/api/background/checks/${check.id}/decision`, A, { outcome: 'proceed', note: 'باشه' });
    assert(shortNote.status === 400 && shortNote.json.code === 'NOTE_REQUIRED', 'a decision needs a written reason', `${shortNote.status} ${shortNote.json?.code}`);
    const decided = await call('POST', `/api/background/checks/${check.id}/decision`, A, {
      outcome: 'proceed',
      note: 'گواهی پاک است؛ فرایند استخدام ادامه می‌یابد و نتیجه در پرونده می‌ماند.',
    });
    assert(decided.status === 200 && decided.json.check.decision?.outcome === 'proceed', 'the human decision is stored', decided.json?.check?.decision?.outcome);
    const cancelCompleted = await call('POST', `/api/background/checks/${check.id}/cancel`, A, {});
    assert(cancelCompleted.status === 409, 'a completed check cannot be cancelled afterwards', String(cancelCompleted.status));

    // ------------------------------------------------ member: process, not paper
    const memberView = await call('GET', `/api/background/${sara.id}`, memberToken);
    assert(memberView.status === 200 && memberView.json.check.status === 'completed', 'a member still sees that the check is complete', memberView.json?.check?.status);
    assert(memberView.json.check.result === null && memberView.json.check.restricted === true, 'but not the verdict', JSON.stringify(memberView.json?.check?.result));
    assert(memberView.json.check.documents.length === 0 && memberView.json.check.consentUrl === undefined, 'nor the certificate or the consent link');
    assert(memberView.json.check.decision === null, 'nor the decision note');
    assert(memberView.json.check.consent?.byName === 'سارا محمدی', 'the consent fact itself is visible — it is the candidate’s own act');
    assert(!memberView.text.includes('سارا محمدی') || memberView.json.check.consent?.note === '', 'the consent note stays with admins');

    // ------------------------------------------------ a record found, no verdict
    const rezaConsent = await call('POST', `/api/background/${reza.id}`, A, {
      authority: 'ادارهٔ تشخیص هویت',
      purpose: 'این نقش امضای اسناد مالی دارد و سیاست سازمان برای آن استعلام سوءپیشینه را لازم می‌داند.',
    });
    let rezaCheck = rezaConsent.json.check;
    const hrConsent = await call('POST', `/api/background/checks/${rezaCheck.id}/consent`, A, { method: 'signed_form', note: 'فرم ۱۴۰۵/۰۸/۱۲، بایگانی ۴۱۲' });
    assert(hrConsent.status === 200 && hrConsent.json.check.consent?.method === 'signed_form', 'a signed form can be filed by HR instead', hrConsent.json?.check?.consent?.method);
    assert(hrConsent.json.check.consent?.selfGiven === false, 'and is marked as filed by HR, not clicked by the candidate');
    const consentShort = await call('POST', `/api/background/checks/${rezaCheck.id}/consent`, A, { method: 'signed_form', note: '' });
    assert(consentShort.status === 409, 'consent cannot be filed twice', String(consentShort.status));

    const decisionTooEarly = await call('POST', `/api/background/checks/${rezaCheck.id}/decision`, A, { outcome: 'hold', note: 'دلیل کافی برای این تصمیم نوشته شده است.' });
    assert(decisionTooEarly.status === 409 && decisionTooEarly.json.code === 'NO_RESULT', 'a decision before the result is refused', `${decisionTooEarly.status} ${decisionTooEarly.json?.code}`);
    await call('POST', `/api/background/checks/${rezaCheck.id}/request`, A, { reference: 'نامهٔ ۵۰۱/۱۴۰۵' });
    const found = await call('POST', `/api/background/checks/${rezaCheck.id}/result`, A, { verdict: 'record_found', note: 'برگه فقط بند دارد؛ جزئیات در مرجع.' });
    assert(found.status === 200 && found.json.check.result?.verdict === 'record_found', 'a finding is recorded as the paper says', found.json?.check?.result?.verdict);
    assert(found.json.check.status === 'completed' && found.json.check.decision === null, 'and waits for a human — no decision is invented', String(found.json?.check?.decision));
    const rezaAfter = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    const rezaStage = rezaAfter.json.items.find((r: any) => r.id === reza.id);
    assert(rezaStage?.decision !== 'rejected', 'the finding did not reject the candidate', String(rezaStage?.decision));

    // ------------------------------------------------------------- declining
    const minaCreate = await call('POST', `/api/background/${mina.id}`, A, {
      authority: 'ادارهٔ تشخیص هویت',
      purpose: 'این نقش با وجوه نقد کار می‌کند و سیاست سازمان استعلام را لازم می‌داند.',
    });
    const minaCheck = minaCreate.json.check;
    const minaToken = String(minaCheck.consentUrl).split('/background/')[1];
    const declined = await call('POST', `/api/background/public/${minaToken}/decline`, null, { reason: 'ترجیح می‌دهم این استعلام انجام نشود.' });
    assert(declined.status === 200 && declined.json.background.status === 'declined', 'a candidate may refuse', declined.json?.background?.status);
    const minaView = await call('GET', `/api/background/${mina.id}`, A);
    assert(minaView.json.check.status === 'declined' && /نشانهٔ منفی نیست/.test(minaView.json.check.declinedReason || '') === false, 'the refusal is recorded with its reason', minaView.json?.check?.declinedReason?.slice(0, 40));
    const requestAfterDecline = await call('POST', `/api/background/checks/${minaCheck.id}/request`, A, { reference: 'نامهٔ ۶۰۰/۱۴۰۵' });
    assert(requestAfterDecline.status === 409, 'and no request can follow it', `${requestAfterDecline.status} ${requestAfterDecline.json?.code}`);
    assert(/نشانهٔ منفی نیست/.test(requestAfterDecline.json.error || ''), 'the refusal error repeats that refusing is not a signal', requestAfterDecline.json?.error?.slice(0, 60));

    const minaNew = await call('POST', `/api/background/${mina.id}`, A, {
      authority: 'ادارهٔ تشخیص هویت',
      purpose: 'استعلام تازه پس از بسته‌شدن پروندهٔ قبلی، با همان دلیل سازمانی.',
    });
    assert(minaNew.status === 201, 'a closed check does not block a new one', String(minaNew.status));

    // ------------------------------------------------------- editing rules
    const minaFresh = minaNew.json.check;
    const editDraft = await call('PATCH', `/api/background/checks/${minaFresh.id}`, A, { authority: 'مرجع تازه', purpose: 'دلیل اصلاح‌شده و کامل برای همین استعلام در سازمان.' });
    assert(editDraft.status === 200 && editDraft.json.check.authority === 'مرجع تازه', 'a draft can be corrected', editDraft.json?.check?.authority);
    const cancelled = await call('POST', `/api/background/checks/${minaFresh.id}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.check.status === 'cancelled', 'and cancelled before it starts', cancelled.json?.check?.status);

    // ----------------------------------------------------- document deletion
    const removed = await call('DELETE', `/api/background/checks/${check.id}/documents/${doc.id}`, A);
    assert(removed.status === 200 && removed.json.check.documents.length === 0, 'the document is removed from the record', String(removed.json?.check?.documents?.length));
    const goneFromDisk = findFiles(DATA, (f) => f.endsWith('.pdf') && /background/.test(f));
    assert(goneFromDisk.length === 0, 'and its bytes are gone from disk', String(goneFromDisk.length));

    // ------------------------------------------------------------- isolation
    const crossRead = await call('GET', `/api/background/${sara.id}`, B);
    assert(crossRead.status === 404, 'another workspace cannot read this candidate’s check', String(crossRead.status));
    const crossEdit = await call('PATCH', `/api/background/checks/${check.id}`, B, { authority: 'x', purpose: 'این جمله نباید هیچ‌جا نوشته شود.' });
    assert(crossEdit.status === 404, 'nor edit it', String(crossEdit.status));

    // ------------------------------------------------------------- blind mode
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindCreate = await call('POST', `/api/background/${reza.id}`, A, { authority: 'ادارهٔ تشخیص هویت', purpose: 'این نقش امضای اسناد مالی دارد و سیاست سازمان آن را لازم می‌داند.' });
    assert(blindCreate.status === 409 || blindCreate.status === 403, 'blind screening blocks starting a check by name', `${blindCreate.status} ${blindCreate.json?.code}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // ------------------------------------------------------------- DSAR path
    const exported = await call('GET', `/api/resumes/${reza.id}/export`, A);
    assert(exported.status === 200 && Array.isArray(exported.json.backgroundChecks), 'the data-subject export contains the checks', String(exported.json?.backgroundChecks?.length));
    const exportedCheck = exported.json.backgroundChecks[0];
    assert(exportedCheck?.result?.verdict === 'record_found' && exportedCheck?.consent?.method, 'with the verdict and how consent was given');

    // ----------------------------------------------------------- activity log
    const activity = await call('GET', '/api/activity?limit=200', A);
    const types = (activity.json?.items || []).map((a: any) => a.type);
    for (const t of ['background.created', 'background.consent', 'background.requested', 'background.result', 'background.decision', 'background.declined']) {
      assert(types.includes(t), `the trail records ${t}`, '');
    }

    // --------------------------------------------------------------- erasure
    const eraseNoConfirm = await call('POST', `/api/resumes/${mina.id}/erase`, A, {});
    assert(eraseNoConfirm.status === 400, 'erasure still needs its explicit confirmation', String(eraseNoConfirm.status));
    const erased = await call('POST', `/api/resumes/${mina.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200, 'a data-subject erasure completes', String(erased.status));
    assert(erased.json.erased?.backgroundChecks >= 1, 'and counts the background checks it removed', String(erased.json?.erased?.backgroundChecks));
  } finally {
    child.kill('SIGTERM');
    smtp.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  if (failures) {
    console.log(`\n${failures} بررسی ناموفق بود.`);
    process.exit(1);
  }
  console.log('\nهمهٔ بررسی‌ها موفق بود.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

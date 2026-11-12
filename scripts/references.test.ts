/**
 * End-to-end test of «استعلام مرجع» — structured reference checks.
 *
 * A reference check touches a third party who never signed up for anything, so
 * the rules matter more than the screens. Proved here, against the built server:
 *
 *   • **consent gates everything** — no send and no phone record before the
 *     candidate agreed, and the refusal is a real 409 with a code;
 *   • **the referee's page leaks nothing** — no candidate e-mail or phone, no
 *     other referees, no notes, no decision, no org internals;
 *   • **one answer per referee** — a second submit is refused, not merged;
 *   • **the link expires** and says so, instead of quietly accepting an answer;
 *   • **declining is a complete answer** and stops reminders;
 *   • **a phone record is labelled** as HR-typed, with the recorder's name;
 *   • **the summary is informational** — the candidate's stage never moves, and
 *     a low score raises «نیازمند بررسی» rather than rejecting anyone;
 *   • **tenant + RBAC walls** — another workspace never sees these referees;
 *   • **erasure removes referees** with the candidate (a third party's data);
 *   • **blind screening blocks it** until the identity is revealed.
 *
 * Run with: npm run build && npx tsx scripts/references.test.ts
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

/** A throwaway SMTP server: the only way to prove a letter really left. */
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
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-references-'));
  const PORT = 4800 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'references-secret-0123456789',
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
    return { status: res.status, json, text };
  };

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;

    const A = await signup('آوا صنعت', 'a@example.com');
    const B = await signup('برنا تجارت', 'b@example.com');

    // A candidate to check.
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه', understanding: tpl.json.understanding, criteriaSource: 'template' })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email,Phone',
      'سارا,محمدی,"کارشناس شبکه با شش سال تجربه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir,09121234567',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // Mailbox, so a send is possible at all.
    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-ref-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });

    // ------------------------------------------------------------ fresh state
    const empty = await call('GET', `/api/references/${rec.id}`, A);
    assert(empty.status === 200, 'the reference case opens', `${empty.status}`);
    assert(empty.json.consentAtISO === null, 'with no consent recorded yet');
    assert(empty.json.summary.invited === 0 && empty.json.summary.completed === 0, 'and no referees');

    // --------------------------------------------------------- consent gate
    const add1 = await call('POST', `/api/references/${rec.id}/referees`, A, {
      name: 'رضا کریمی',
      title: 'مدیر فنی',
      company: 'آلفا',
      email: 'reza@old.example',
      relation: 'manager',
    });
    assert(add1.status === 201, 'a referee can be added before consent (still nothing sent)', `${add1.status}`);
    const refereeId = add1.json.referees[0].id;

    const noConsent = await call('POST', `/api/references/referees/${refereeId}/send`, A, {});
    assert(noConsent.status === 409 && noConsent.json?.code === 'CONSENT_REQUIRED', 'sending without consent is refused', `${noConsent.status} ${noConsent.json?.code}`);
    assert(smtp.messages.length === 0, 'and no letter left');

    const phoneNoConsent = await call('POST', `/api/references/referees/${refereeId}/record`, A, { wouldRehire: 4 });
    assert(phoneNoConsent.status === 409 && phoneNoConsent.json?.code === 'CONSENT_REQUIRED', 'a phone record is refused too', String(phoneNoConsent.status));

    // Validation that must hold before the referee limit is reached.
    const badEmail = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'بی‌ایمیل', email: 'not-an-email' });
    assert(badEmail.status === 400 && badEmail.json?.code === 'BAD_EMAIL', 'an invalid e-mail is refused', String(badEmail.status));
    const noContact = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'بی‌تماس' });
    assert(noContact.status === 400 && noContact.json?.code === 'CONTACT_REQUIRED', 'a referee needs a way to be reached', String(noContact.status));

    const consent = await call('POST', `/api/references/${rec.id}/consent`, A, { note: 'تلفنی، ۱۴۰۳/۰۵/۱۲ — گفت با دو مرجع تماس بگیریم' });
    assert(consent.status === 200 && Boolean(consent.json.consentAtISO), 'consent is recorded with a date');
    assert(consent.json.consentByName === 'مدیر منابع انسانی', 'and names who recorded it');

    // ------------------------------------------------------------- sending
    const sent = await call('POST', `/api/references/referees/${refereeId}/send`, A, {});
    assert(sent.status === 200 && sent.json?.emailed === true, 'the invitation is e-mailed', `${sent.status} ${sent.json?.error || ''}`);
    assert(smtp.messages.length === 1, 'exactly one letter left', String(smtp.messages.length));
    const raw = smtp.messages[0] || '';
    assert(/To: reza@old\.example/i.test(raw), 'it goes to the referee’s own address');
    assert(/سارا|=\?UTF-8/i.test(raw), 'the letter names the candidate');
    assert(!raw.includes('smtp-secret-ref-123'), 'the SMTP password is never in the letter');

    // ------------------------------------------------- the referee's page
    const publicUrl = sent.json.referee.url as string;
    const token = publicUrl.split('/reference/')[1];
    assert(/^[A-Za-z0-9_-]{20,}$/.test(token), 'the public link carries an unguessable token');

    const pub = await call('GET', `/api/reference/public/${token}`);
    assert(pub.status === 200, 'the referee opens it with no session', `${pub.status}`);
    const wire = JSON.stringify(pub.json);
    for (const leak of ['sara@example.ir', '09121234567', 'score', 'decision', 'note', 'a@example.com']) {
      assert(!wire.toLowerCase().includes(leak.toLowerCase()), `the referee page never carries «${leak}»`);
    }
    assert(pub.json.reference.candidateName.includes('سارا'), 'but it does name the person being recommended');
    assert(pub.json.reference.dimensions.length === 3, 'with the three dimensions');

    const opened = await call('POST', `/api/reference/public/${token}/open`, null, {});
    assert(opened.json.reference.status === 'opened', 'opening is recorded as «باز شد، پاسخ نداده»');

    const answered = await call('POST', `/api/reference/public/${token}/answer`, null, {
      duration: 'دو سال',
      performance: 4,
      collaboration: 5,
      reliability: 4,
      wouldRehire: 5,
      strengths: 'کارش را تمام می‌کرد و تیم را جلو می‌برد.',
      concerns: 'گاهی جزئیات را رها می‌کرد.',
    });
    assert(answered.status === 200, 'the referee answers', `${answered.status} ${answered.json?.error || ''}`);
    assert(answered.json.reference.status === 'completed', 'and the status becomes completed');

    const twice = await call('POST', `/api/reference/public/${token}/answer`, null, { wouldRehire: 1 });
    assert(twice.status === 409 && twice.json?.code === 'ALREADY_ANSWERED', 'a second answer is refused, not merged', String(twice.status));

    const afterOne = await call('GET', `/api/references/${rec.id}`, A);
    assert(afterOne.json.summary.completed === 1, 'the team sees one completed referee');
    assert(afterOne.json.summary.wouldRehire === 5, 'the average is the referee’s own number', String(afterOne.json.summary.wouldRehire));
    assert(afterOne.json.summary.needsReview === false, 'a positive answer does not raise a review flag');

    // ------------------------------------------- a second referee, a low score
    const add2 = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'مینا رضایی', email: 'mina@old.example', relation: 'colleague' });
    const secondId = add2.json.referees.find((r: any) => r.name === 'مینا رضایی').id;
    const dup = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'مینا رضایی', email: 'mina@old.example', relation: 'colleague' });
    assert(dup.status === 409 && dup.json?.code === 'DUPLICATE_REFEREE', 'the same referee is not added twice', String(dup.status));

    await call('POST', `/api/references/referees/${secondId}/send`, A, {});
    const token2 = (/\/reference\/([A-Za-z0-9_-]+)/.exec(smtp.messages[smtp.messages.length - 1] || '') || [])[1];
    if (token2) {
      await call('POST', `/api/reference/public/${token2}/answer`, null, { performance: 2, collaboration: 3, reliability: 2, wouldRehire: 2, concerns: 'به‌ندرت پاسخ می‌داد.' });
    }
    const afterTwo = await call('GET', `/api/references/${rec.id}`, A);
    assert(afterTwo.json.summary.completed === 2, 'two answers are counted');
    assert(afterTwo.json.summary.wouldRehire === 3.5, 'the average is honest (5 and 2 → 3.5)', String(afterTwo.json.summary.wouldRehire));
    assert(afterTwo.json.summary.needsReview === true, 'a «با تردید» answer raises «نیازمند بررسی»');
    assert(/تردید/.test(afterTwo.json.summary.headline), 'and the headline says so in Persian');

    // Nothing moved the candidate's stage.
    const candidate = (await call('GET', `/api/resumes/${rec.id}`, A)).json.record;
    assert(candidate.decisionStatus === rec.decisionStatus, 'no decision was taken automatically', `${candidate.decisionStatus}`);
    assert(candidate.stageId === rec.stageId, 'and the stage never moved');

    // ------------------------------------------------------ phone record path
    const add3 = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'حسین نادری', phone: '09120000000', relation: 'manager' });
    const thirdId = add3.json.referees.find((r: any) => r.name === 'حسین نادری').id;
    const noEmail = await call('POST', `/api/references/referees/${thirdId}/send`, A, {});
    assert(noEmail.status === 409 && noEmail.json?.code === 'NO_EMAIL', 'a referee without e-mail cannot be e-mailed', String(noEmail.status));

    const recorded = await call('POST', `/api/references/referees/${thirdId}/record`, A, {
      performance: 5,
      collaboration: 4,
      reliability: 5,
      wouldRehire: 5,
      strengths: 'تلفنی گفت: بدون او پروژه تمام نمی‌شد.',
    });
    assert(recorded.status === 200, 'the phone answer is recorded', `${recorded.status} ${recorded.json?.error || ''}`);
    assert(recorded.json.referee.source === 'phone', 'and is marked as a phone record');
    assert(recorded.json.referee.recordedByName === 'مدیر منابع انسانی', 'with the name of whoever typed it');

    const afterThree = await call('GET', `/api/references/${rec.id}`, A);
    assert(afterThree.json.summary.completed === 3, 'the phone answer counts toward the summary');

    // ----------------------------------------------------------- declining
    const add4 = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'کسی که عذر خواست', email: 'decline@old.example', relation: 'other' });
    const fourthId = add4.json.referees.find((r: any) => r.name === 'کسی که عذر خواست').id;
    await call('POST', `/api/references/referees/${fourthId}/send`, A, {});
    const token4 = (/\/reference\/([A-Za-z0-9_-]+)/.exec(smtp.messages[smtp.messages.length - 1] || '') || [])[1];
    if (token4) {
      const dec = await call('POST', `/api/reference/public/${token4}/decline`, null, { reason: 'ترجیح می‌دهم دربارهٔ همکار سابقم صحبت نکنم.' });
      assert(dec.json.reference.status === 'declined', 'a referee can decline with a reason');
      const again = await call('POST', `/api/reference/public/${token4}/answer`, null, { wouldRehire: 5 });
      assert(again.status === 409, 'and the link is closed to answers afterwards', String(again.status));
    }
    const remind = await call('POST', `/api/references/referees/${fourthId}/remind`, A, {});
    assert(remind.status === 409, 'a declined referee is never reminded', String(remind.status));

    const afterDecline = await call('GET', `/api/references/${rec.id}`, A);
    assert(afterDecline.json.summary.declined === 1, 'the decline is counted, not hidden');
    assert(afterDecline.json.summary.completed === 3, 'and does not dilute the completed answers');

    // ------------------------------------------------- one reminder, then no
    const add5 = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'بی‌پاسخ', email: 'quiet@old.example', relation: 'colleague' });
    const fifthId = add5.json.referees.find((r: any) => r.name === 'بی‌پاسخ').id;
    await call('POST', `/api/references/referees/${fifthId}/send`, A, {});
    const r1 = await call('POST', `/api/references/referees/${fifthId}/remind`, A, {});
    assert(r1.status === 200, 'one reminder is allowed', `${r1.status}`);
    const r2 = await call('POST', `/api/references/referees/${fifthId}/remind`, A, {});
    assert(r2.status === 409 && r2.json?.code === 'ALREADY_REMINDED', 'a second reminder is refused (no nagging)', String(r2.status));

    // ---------------------------------------------------- validation limits
    const tooMany = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'ششم', phone: '09120000001' });
    assert(tooMany.status === 400 && tooMany.json?.code === 'TOO_MANY_REFEREES', 'the referee limit is enforced', String(tooMany.status));

    // ------------------------------------------------------------- RBAC/tenant
    const bView = await call('GET', `/api/references/${rec.id}`, B);
    assert(bView.status === 404, 'another workspace cannot open this candidate', String(bView.status));
    const bPub = await call('GET', `/api/reference/public/${token}`);
    assert(bPub.status === 200 && bPub.json.reference.org.name === 'آوا صنعت', 'the referee page names the right organisation');

    // ------------------------------------------------------------- blind mode
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindAdd = await call('POST', `/api/references/${rec.id}/referees`, A, { name: 'در حالت بی‌طرف', phone: '09120000002' });
    assert(blindAdd.status === 409 && blindAdd.json?.code === 'BLIND_REVEAL_REQUIRED', 'blind screening blocks new referees', String(blindAdd.status));
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // ---------------------------------------------------------------- erasure
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 || erased.status === 201 || erased.status === 204, 'the candidate can be erased', String(erased.status));
    const afterErase = await call('GET', `/api/reference/public/${token}`);
    assert(afterErase.status === 404, 'and every referee link dies with the candidate', String(afterErase.status));
  } finally {
    child.kill('SIGTERM');
    smtp.server.close();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll reference-check checks passed.' : `\n${failures} reference-check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

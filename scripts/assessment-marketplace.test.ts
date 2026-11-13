/**
 * End-to-end test of «بازارچهٔ آزمون» — an outside test service, wired for real.
 *
 * A mock provider is a real HTTP server in this process, so nothing is stubbed
 * on our side: HOVIDA genuinely dials it, and every failure mode below is the
 * provider genuinely misbehaving.
 *
 * What is proved:
 *   • **nothing is pre-installed** — an empty workspace reads an empty list;
 *   • **«آماده» requires a real check** — a URL and a key on file read
 *     `unchecked`, a 500 reads `degraded` with the status text, and a provider
 *     that was never checked cannot send anything (`PROVIDER_NOT_READY`);
 *   • **the key is a secret** — never in a response, never in the snapshot on
 *     disk (AES-GCM), only its last four characters are shown;
 *   • **sending is the only outbound act** — creating an invitation dials
 *     nothing; a refused session mails nothing; a retried send reuses the same
 *     session instead of opening a second one;
 *   • **the return path is narrow** — `POST /api/v1/results` with an
 *     `assessments`-scoped key, by `externalRef`, one workspace only, once;
 *   • **a manual provider still works** — `link` mode mails the pasted URL and a
 *     human records the result, labelled «نتیجهٔ بیرونی»;
 *   • **the candidate's page** names the provider and links out — it never shows
 *     a score or pretends the test happens inside HOVIDA.
 *
 * Run with: npm run build && npx tsx scripts/assessment-marketplace.test.ts
 */
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

type ProviderBehaviour = {
  health: number;
  sessionStatus: number;
  sessionBody: string;
  sessions: any[];
  calls: number;
  lastAuth: string;
  hits: number;
};

function mockProvider(): Promise<{ server: http.Server; port: number; state: ProviderBehaviour }> {
  const state: ProviderBehaviour = { health: 200, sessionStatus: 201, sessionBody: '', sessions: [], calls: 0, lastAuth: '', hits: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.hits += 1;
      state.lastAuth = String(req.headers.authorization || '');
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(state.health, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: state.health === 200 }));
        return;
      }
      if (req.method === 'POST' && req.url === '/sessions') {
        let parsed: any = null;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
        state.calls += 1;
        if (parsed) state.sessions.push(parsed);
        if (state.sessionBody) {
          res.writeHead(state.sessionStatus, { 'Content-Type': 'application/json' });
          res.end(state.sessionBody);
          return;
        }
        const port = (server.address() as any).port;
        res.writeHead(state.sessionStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `sess_${state.sessions.length}`, url: `http://127.0.0.1:${port}/t/${state.sessions.length}` }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as any).port, state }))
  );
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-marketplace-'));
  const PORT = 5300 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'marketplace-secret-0123456789',
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
  const provider = await mockProvider();
  const deadPort = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as any).port;
      s.close(() => resolve(p));
    });
  });

  try {
    const A = (await call('POST', '/api/auth/signup', null, { orgName: 'آوا صنعت', name: 'مدیر منابع انسانی', email: 'a@example.com', password: 'Password12345' })).json.token as string;
    const B = (await call('POST', '/api/auth/signup', null, { orgName: 'برنا تجارت', name: 'مدیر منابع انسانی', email: 'b@example.com', password: 'Password12345' })).json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const understanding = (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد بک‌اند' })).json.understanding;
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد بک‌اند', understanding, criteriaSource: 'template' })).json.job;

    const member = await call('POST', '/api/org/members', A, { name: 'نگار رضایی', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const memberToken = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json.token as string;

    const candidate = async (first: string, email: string) => {
      const csv = [
        'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
        `${first},محمدی,"برنامه‌نویس بک‌اند",تهران,آلفا,https://www.linkedin.com/in/${first},Yes,"Node.js",${email}`,
      ].join('\r\n');
      const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
      const profileId = imported.json.search.results[0].id;
      return (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    };
    const sara = await candidate('سارا', 'sara@example.ir');
    const reza = await candidate('رضا', 'reza@example.ir');
    const mina = await candidate('مینا', 'mina@example.ir');
    const hamed = await candidate('حامد', 'hamed@example.ir');

    // ------------------------------------------------------------ empty state
    const empty = await call('GET', '/api/assessment-providers', A);
    assert(empty.status === 200 && empty.json.items.length === 0, 'a new workspace has no provider pre-installed', String(empty.json?.items?.length));
    assert(empty.json.summary.total === 0 && empty.json.summary.ready === 0, 'and the summary is honestly zero');
    assert(empty.json.contract?.scope === 'assessments', 'the contract names the scope a vendor needs', empty.json.contract?.scope);

    const memberCreate = await call('POST', '/api/assessment-providers', memberToken, { name: 'سرویس من', mode: 'api', baseUrl: `http://127.0.0.1:${provider.port}`, apiKey: 'sk_member_1' });
    assert(memberCreate.status === 403, 'a member cannot connect a provider; it needs an admin', String(memberCreate.status));

    // ------------------------------------------------------------ validation
    const insecure = await call('POST', '/api/assessment-providers', A, { name: 'ناامن', mode: 'api', baseUrl: 'http://tests.example.com', apiKey: 'sk_live_123456' });
    assert(insecure.status === 400 && insecure.json.code === 'HTTPS_REQUIRED', 'a non-loopback endpoint must be https — the key is sent with it', `${insecure.status} ${insecure.json?.code}`);
    const noKey = await call('POST', '/api/assessment-providers', A, { name: 'بی‌کلید', mode: 'api', baseUrl: `http://127.0.0.1:${provider.port}` });
    assert(noKey.status === 400 && noKey.json.code === 'KEY_REQUIRED', 'api mode without a key is refused', `${noKey.status} ${noKey.json?.code}`);

    // -------------------------------------------------------------- created
    const created = await call('POST', '/api/assessment-providers', A, {
      name: 'آزمون زبان نمونه',
      mode: 'api',
      baseUrl: `http://127.0.0.1:${provider.port}`,
      apiKey: 'sk_test_abcd',
      tests: [{ name: 'زبان سازمانی', externalId: 'lang-1', kind: 'situational', durationMinutes: 25, dimensions: 'خواندن، نوشتن' }],
    });
    assert(created.status === 201, 'an admin connects a provider', `${created.status} ${created.text.slice(0, 120)}`);
    const prv = created.json.provider;
    assert(prv.hasKey === true && prv.keyHint === 'abcd', 'the screen learns only the last four characters of the key', `${prv.hasKey}/${prv.keyHint}`);
    assert(prv.state === 'unchecked', 'a URL and a key are not «ready» — nothing has answered yet', prv.state);
    assert(!created.text.includes('sk_test_abcd'), 'the key is never echoed back');
    assert(prv.tests[0].dimensions.length === 2 && prv.tests[0].externalId === 'lang-1', 'the test list keeps its dimensions and the vendor id');

    // ------------------------------------------------------------- key at rest
    // The store writes on a debounce; wait for the snapshot that carries the row.
    const readSnapshot = () =>
      fs
        .readdirSync(DATA)
        .map((f) => {
          try {
            const p = path.join(DATA, f);
            return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8') : '';
          } catch {
            return '';
          }
        })
        .join('\n');
    let snapshotText = readSnapshot();
    for (let i = 0; i < 40 && !/apiKeyEnc/.test(snapshotText); i++) {
      await new Promise((r) => setTimeout(r, 100));
      snapshotText = readSnapshot();
    }
    assert(!snapshotText.includes('sk_test_abcd'), 'the key is not in the snapshot on disk (encrypted at rest)');
    assert(snapshotText.includes('apiKeyEnc'), 'only the ciphertext field is stored');

    // -------------------------------------------------------- sending blocked
    const notReady = await call('POST', '/api/assessments/provider', A, { resumeId: sara.id, providerId: prv.id, testId: prv.tests[0].id });
    assert(notReady.status === 409 && notReady.json.code === 'PROVIDER_NOT_READY', 'an unchecked provider cannot send anything', `${notReady.status} ${notReady.json?.code}`);
    assert(provider.state.calls === 0, 'and it was not dialled while refusing');

    // --------------------------------------------------------------- check ok
    const checked = await call('POST', `/api/assessment-providers/${prv.id}/check`, A);
    assert(checked.status === 200 && checked.json.provider.lastCheck.ok === true, 'a real check makes it «آماده»', checked.json?.provider?.lastCheck?.status);
    assert(Number.isFinite(checked.json.provider.lastCheck.latencyMs), 'with the latency it actually took', String(checked.json?.provider?.lastCheck?.latencyMs));
    assert(checked.json.provider.state === 'ready', 'and the state says exactly that');
    assert(provider.state.lastAuth === 'Bearer sk_test_abcd', 'the check carried the decrypted key as a bearer token', provider.state.lastAuth);

    // ---------------------------------------------------------- check failed
    provider.state.health = 503;
    const degraded = await call('POST', `/api/assessment-providers/${prv.id}/check`, A);
    assert(degraded.status === 200 && degraded.json.provider.lastCheck.ok === false, 'a 503 on the health path is recorded as a failure', String(degraded.json?.provider?.lastCheck?.status));
    assert(degraded.json.provider.state === 'degraded' && /503/.test(degraded.json.provider.lastCheck.error || ''), 'the state degrades and the error keeps the status', degraded.json?.provider?.lastCheck?.error);
    const blockedAfterDegrade = await call('POST', '/api/assessments/provider', A, { resumeId: sara.id, providerId: prv.id, testId: prv.tests[0].id });
    assert(blockedAfterDegrade.status === 409, 'and sending stops again while it is degraded', String(blockedAfterDegrade.status));
    provider.state.health = 200;
    await call('POST', `/api/assessment-providers/${prv.id}/check`, A);

    // ------------------------------------------------------- catalog + invite
    const catalog = await call('GET', '/api/assessments/catalog', A);
    assert(catalog.status === 200 && catalog.json.providers[0].tests[0].ready === true, 'the send dialog sees the provider test as usable', String(catalog.json?.providers?.[0]?.tests?.[0]?.ready));
    assert(Array.isArray(catalog.json.templates) && catalog.json.templates.length > 0, 'next to the built-in tests, not instead of them');

    const invite = await call('POST', '/api/assessments/provider', A, { resumeId: sara.id, providerId: prv.id, testId: prv.tests[0].id });
    assert(invite.status === 201, 'an invitation is created', `${invite.status} ${invite.text.slice(0, 120)}`);
    const inv = invite.json.assessment;
    assert(inv.driver === 'provider' && inv.source === 'external', 'labelled as a provider test', `${inv.driver}/${inv.source}`);
    assert(Boolean(inv.externalRef) && inv.externalUrl === null, 'with its own referee, and no session opened yet', String(inv.externalRef));
    assert(provider.state.calls === 0, 'creating an invitation dials nothing');

    // --------------------------------------------------- send without mailbox
    const noMailbox = await call('POST', `/api/assessments/${inv.id}/send`, A, {});
    assert(noMailbox.status === 409 && noMailbox.json.code === 'EMAIL_NOT_CONFIGURED', 'without a mailbox nothing is sent', `${noMailbox.status} ${noMailbox.json?.code}`);
    assert(provider.state.calls === 0, 'and no session is opened before the mail is even possible');

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-market-1',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });

    // -------------------------------------------------------------- send ok
    const before = smtp.messages.length;
    const sent = await call('POST', `/api/assessments/${inv.id}/send`, A, {});
    assert(sent.status === 200 && sent.json.emailed === true, 'sending opens the session and mails the link', `${sent.status} ${sent.text.slice(0, 140)}`);
    assert(provider.state.calls === 1, 'exactly one session was opened', String(provider.state.calls));
    const sessionBody = provider.state.sessions[0];
    assert(sessionBody?.testId === 'lang-1', 'with the vendor test id', String(sessionBody?.testId));
    assert(sessionBody?.candidate?.email === 'sara@example.ir' && sessionBody?.externalRef === inv.externalRef, 'and the candidate only gets name + e-mail + referee');
    assert(sessionBody?.candidate?.resume === undefined && sessionBody?.candidate?.phone === undefined, 'nothing else about the candidate is sent');
    assert(smtp.messages.length === before + 1, 'exactly one mail left the workspace', String(smtp.messages.length - before));
    const storedMail = await call('GET', `/api/integrations/emails?resumeId=${sara.id}`, A);
    const mailBody = String(storedMail.json.items[0]?.body || '');
    assert(/\/t\/1/.test(mailBody), 'the mail carries the provider URL', mailBody.slice(0, 80));
    assert(/آزمون زبان نمونه/.test(mailBody), 'and names the service the candidate will use');
    assert(Boolean(sent.json.assessment.externalUrl), 'the invitation remembers where it went');

    // ------------------------------------------------ a retried send reuses it
    const again = await call('POST', `/api/assessments/${inv.id}/send`, A, {});
    assert(again.status === 200 && provider.state.calls === 1, 're-sending the mail does not open a second session', String(provider.state.calls));

    // ------------------------------------------------------- provider failures
    provider.state.sessionStatus = 500;
    provider.state.sessionBody = '{"error":"boom"}';
    const invite2 = await call('POST', '/api/assessments/provider', A, { resumeId: reza.id, providerId: prv.id, testId: prv.tests[0].id });
    const before2 = smtp.messages.length;
    const failed = await call('POST', `/api/assessments/${invite2.json.assessment.id}/send`, A, {});
    assert(failed.status === 502 && failed.json.code === 'PROVIDER_FAILED', 'a 500 from the provider fails the send, honestly', `${failed.status} ${failed.json?.code}`);
    assert(/500/.test(failed.json.error || ''), 'the message keeps the status the provider returned', failed.json?.error?.slice(0, 90));
    assert(smtp.messages.length === before2, 'and nothing was mailed');
    const afterFailure = await call('GET', `/api/assessments/${invite2.json.assessment.id}`, A);
    assert(afterFailure.json.assessment.externalUrl === null && afterFailure.json.assessment.sentAtISO === null, 'the invitation is still unsent');

    provider.state.sessionBody = 'definitely not json';
    provider.state.sessionStatus = 201;
    const badJson = await call('POST', `/api/assessments/${invite2.json.assessment.id}/send`, A, {});
    assert(badJson.status === 502 && badJson.json.code === 'PROVIDER_BAD_RESPONSE', 'an unreadable body is not parsed into a guess', `${badJson.status} ${badJson.json?.code}`);

    provider.state.sessionBody = '{"url":"http://evil.example/t/1"}';
    const insecureUrl = await call('POST', `/api/assessments/${invite2.json.assessment.id}/send`, A, {});
    assert(insecureUrl.status === 502 && insecureUrl.json.code === 'PROVIDER_BAD_URL', 'a non-https link from the provider is never mailed', `${insecureUrl.status} ${insecureUrl.json?.code}`);

    provider.state.sessionBody = '{"nope":true}';
    const noUrl = await call('POST', `/api/assessments/${invite2.json.assessment.id}/send`, A, {});
    assert(noUrl.status === 502 && noUrl.json.code === 'PROVIDER_NO_URL', 'a body without a url is a failure, not an empty mail', `${noUrl.status} ${noUrl.json?.code}`);

    // ------------------------------------------------------- unreachable host
    const dead = await call('POST', '/api/assessment-providers', A, {
      name: 'سرویس خاموش',
      mode: 'api',
      baseUrl: `http://127.0.0.1:${deadPort}`,
      apiKey: 'sk_dead_9876',
      tests: [{ name: 'آزمون خاموش', kind: 'situational' }],
    });
    const deadCheck = await call('POST', `/api/assessment-providers/${dead.json.provider.id}/check`, A);
    assert(deadCheck.status === 200 && deadCheck.json.provider.lastCheck.ok === false, 'a closed port is recorded as a failure', String(deadCheck.json?.provider?.lastCheck?.status));
    assert(deadCheck.json.provider.lastCheck.status === null && Boolean(deadCheck.json.provider.lastCheck.error), 'with no HTTP status and a readable reason', deadCheck.json?.provider?.lastCheck?.error);
    assert(deadCheck.json.provider.state === 'degraded', 'the state says «نیازمند بررسی»');

    // ---------------------------------------------------- link mode (manual)
    const linkProvider = await call('POST', '/api/assessment-providers', A, {
      name: 'آزمون کتبی مرکز سنجش',
      mode: 'link',
      tests: [{ name: 'آزمون کتبی تحلیلی', kind: 'work-sample', scoring: 'profile', dimensions: 'تحلیل، نگارش' }],
    });
    assert(linkProvider.status === 201 && linkProvider.json.provider.state === 'ready', 'a link-mode provider needs no endpoint and is ready at once', linkProvider.json?.provider?.state);
    const linkTestId = linkProvider.json.provider.tests[0].id;
    const noUrlInvite = await call('POST', '/api/assessments/provider', A, { resumeId: mina.id, providerId: linkProvider.json.provider.id, testId: linkTestId });
    assert(noUrlInvite.status === 400 && noUrlInvite.json.code === 'EXTERNAL_URL_REQUIRED', 'link mode needs the provider URL up front', `${noUrlInvite.status} ${noUrlInvite.json?.code}`);
    const httpUrl = await call('POST', '/api/assessments/provider', A, { resumeId: mina.id, providerId: linkProvider.json.provider.id, testId: linkTestId, externalUrl: 'http://center.example/exam/1' });
    assert(httpUrl.status === 400 && httpUrl.json.code === 'EXTERNAL_URL_HTTPS', 'and it must be https', `${httpUrl.status} ${httpUrl.json?.code}`);
    const linkInvite = await call('POST', '/api/assessments/provider', A, { resumeId: mina.id, providerId: linkProvider.json.provider.id, testId: linkTestId, externalUrl: 'https://center.example/exam/1' });
    assert(linkInvite.status === 201 && linkInvite.json.assessment.externalUrl === 'https://center.example/exam/1', 'a pasted https URL is stored', String(linkInvite.json?.assessment?.externalUrl));
    const callsBeforeLink = provider.state.calls;
    const linkBefore = smtp.messages.length;
    const linkSent = await call('POST', `/api/assessments/${linkInvite.json.assessment.id}/send`, A, {});
    assert(linkSent.status === 200 && linkSent.json.emailed === true, 'the pasted link is mailed from the workspace mailbox', String(linkSent.status));
    assert(smtp.messages.slice(linkBefore).join('\n').includes('https://center.example/exam/1'), 'the mail carries exactly that URL');
    assert(provider.state.calls === callsBeforeLink, 'and the api provider was not involved at all');

    // ------------------------------------------------------- candidate's page
    const token = String(linkSent.json.assessment.url).split('/assess/')[1];
    const publicView = await call('GET', `/api/assessment/public/${token}`);
    assert(publicView.status === 200 && publicView.json.assessment.provider?.name === 'آزمون کتبی مرکز سنجش', 'the public page names the provider', publicView.json?.assessment?.provider?.name);
    assert(publicView.json.assessment.provider.url === 'https://center.example/exam/1' && publicView.json.canAnswer === false, 'links out, and offers no in-page test');
    assert(publicView.json.assessment.questions.length === 0, 'no questions are leaked for a test it does not host');
    const submitProvider = await call('POST', `/api/assessment/public/${token}/submit`, null, { answers: {} });
    assert(submitProvider.status === 409 && submitProvider.json.code === 'PROVIDER_HOSTED', 'and submitting on our page is refused', `${submitProvider.status} ${submitProvider.json?.code}`);

    // ------------------------------------------------------------ v1 results
    const resultKey = (await call('POST', '/api/developer/keys', A, { name: 'سرویس آزمون زبان', scopes: ['assessments'] })).json;
    assert(Boolean(String(resultKey.key).startsWith('hvd_sk_')), 'an assessments-scoped key is issued', resultKey.record?.scopes?.join(','));
    const readKey = (await call('POST', '/api/developer/keys', A, { name: 'داشبورد خواندنی', scopes: ['read'] })).json.key as string;

    const postResult = async (key: string, body: unknown) => {
      const res = await fetch(`${BASE}/api/v1/results`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
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

    const denied = await postResult(readKey, { externalRef: inv.externalRef, score: 70 });
    assert(denied.status === 403 && denied.json.code === 'SCOPE_REQUIRED', 'a read-only key cannot write a result', `${denied.status} ${denied.json?.code}`);
    const unknown = await postResult(resultKey.key, { externalRef: 'ext_does_not_exist', score: 70 });
    assert(unknown.status === 404, 'an unknown referee matches nothing', String(unknown.status));

    const recorded = await postResult(resultKey.key, {
      externalRef: inv.externalRef,
      score: 82,
      dimensions: [
        { id: 'reading', label: 'خواندن', score: 88 },
        { id: 'writing', label: 'نوشتن', score: 74 },
      ],
      note: 'گزارش کامل در سرویس ارائه‌دهنده.',
    });
    assert(recorded.status === 200 && recorded.json.assessment.status === 'completed', 'the provider writes its result by referee', `${recorded.status} ${recorded.json?.assessment?.status}`);
    assert(recorded.json.assessment.score === 82 && recorded.json.assessment.band === 'strong', 'the score and band land on the record', `${recorded.json?.assessment?.score}/${recorded.json?.assessment?.band}`);
    assert(recorded.json.assessment.providerName === 'آزمون زبان نمونه', 'and the provider is named', recorded.json?.assessment?.providerName);
    assert(recorded.json.assessment.dimensions.length === 2, 'its dimensions are kept as given');
    const twice = await postResult(resultKey.key, { externalRef: inv.externalRef, score: 99 });
    assert(twice.status === 409, 'a second result is refused instead of overwriting the first', `${twice.status} ${twice.json?.code}`);

    const listed = await call('GET', `/api/assessments?resumeId=${sara.id}`, A);
    const completedRow = listed.json.items.find((a: any) => a.id === inv.id);
    assert(completedRow?.status === 'completed' && completedRow?.score === 82, 'the candidate panel shows the provider result', `${completedRow?.status}/${completedRow?.score}`);
    assert(listed.json.summary.external >= 1, 'and the summary counts external results apart', String(listed.json.summary.external));

    // ------------------------------------------------------- note-only result
    const sina = await candidate('سینا', 'sina@example.ir');
    const manualInvite = await call('POST', '/api/assessments/provider', A, { resumeId: sina.id, providerId: linkProvider.json.provider.id, testId: linkTestId, externalUrl: 'https://center.example/exam/2' });
    const noteOnly = await call('POST', `/api/assessments/${manualInvite.json.assessment.id}/result`, A, { note: 'سطح B۲ — قبول' });
    assert(noteOnly.status === 200 && noteOnly.json.assessment.status === 'completed', 'a result that is only words is still recorded', `${noteOnly.status} ${noteOnly.json?.assessment?.status}`);
    assert(noteOnly.json.assessment.score === null && noteOnly.json.assessment.band === null, 'with no score invented', String(noteOnly.json?.assessment?.score));
    assert(noteOnly.json.assessment.note === 'سطح B۲ — قبول', 'and the words kept as typed');

    // ------------------------------------------------ not for HOVIDA's own tests
    const bankInvite = await call('POST', '/api/assessments', A, { resumeId: hamed.id, templateId: 'behavioral-core', jobId: job.id });
    assert(bankInvite.status === 201 && bankInvite.json.assessment.driver === 'hovida', 'a bank test still reads `hovida`', bankInvite.json?.assessment?.driver);
    const byId = await postResult(resultKey.key, { assessmentId: bankInvite.json.assessment.id, score: 50 });
    assert(byId.status === 409 && byId.json.code === 'NOT_PROVIDER_TEST', 'and cannot be completed through the provider door', `${byId.status} ${byId.json?.code}`);
    const missingNumbers = await postResult(resultKey.key, { externalRef: invite2.json.assessment.externalRef });
    assert(missingNumbers.status === 400 && missingNumbers.json.code === 'NO_RESULT', 'a result with nothing in it is refused', `${missingNumbers.status} ${missingNumbers.json?.code}`);

    // ----------------------------------------------------- cross-workspace
    const orgBList = await call('GET', '/api/assessment-providers', B);
    assert(orgBList.json.items.length === 0, 'another workspace sees none of these providers', String(orgBList.json?.items?.length));
    const bKey = (await call('POST', '/api/developer/keys', B, { name: 'کلید ب', scopes: ['assessments'] })).json.key as string;
    const crossOrg = await postResult(bKey, { externalRef: invite2.json.assessment.externalRef, score: 40 });
    assert(crossOrg.status === 404, "another workspace's key cannot finish this result", String(crossOrg.status));
    const crossGet = await call('GET', `/api/assessment-providers/${prv.id}`, B);
    assert(crossGet.status === 404, 'and cannot read the provider row either', String(crossGet.status));

    // --------------------------------------------------------- webhook events
    const hook = await call('POST', '/api/developer/webhooks', A, {
      name: 'سامانهٔ منابع انسانی',
      url: 'https://example.com/hooks/hovida',
      events: ['assessment.completed', 'nonsense.event'],
    });
    assert(hook.status === 201 && hook.json.endpoint.events.includes('assessment.completed'), 'a workspace can subscribe to the assessment lifecycle', JSON.stringify(hook.json?.endpoint?.events));
    assert(!hook.json.endpoint.events.includes('nonsense.event'), 'and unknown events are dropped, not stored');

    // ---------------------------------------------------------- activity trail
    const activity = await call('GET', '/api/activity?limit=200', A);
    const types = (activity.json?.items || []).map((a: any) => a.type);
    assert(types.includes('assessment.completed') && types.includes('assessment.sent'), 'the trail records both the invitation and the result', types.filter((t: string) => t.startsWith('assessment.')).join(','));

    // -------------------------------------------------------------- deletion
    const removed = await call('DELETE', `/api/assessment-providers/${prv.id}`, A);
    assert(removed.status === 200 && removed.json.keptInvites >= 2, 'removing a provider keeps the results it produced', JSON.stringify(removed.json));
    const afterDelete = await call('GET', `/api/assessment-providers/${prv.id}`, A);
    assert(afterDelete.status === 404, 'the row is gone', String(afterDelete.status));
    const stillThere = await call('GET', `/api/assessments?resumeId=${sara.id}`, A);
    assert(stillThere.json.items.some((a: any) => a.id === inv.id && a.status === 'completed'), 'and the recorded result is still in the candidate file');
    const sendAfterDelete = await call('POST', `/api/assessments/${invite2.json.assessment.id}/send`, A, {});
    assert(sendAfterDelete.status === 409 && sendAfterDelete.json.code === 'PROVIDER_GONE', 'an unsent invitation whose provider was removed says so clearly', `${sendAfterDelete.status} ${sendAfterDelete.json?.code}`);
  } finally {
    child.kill('SIGTERM');
    smtp.server.close();
    provider.server.close();
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

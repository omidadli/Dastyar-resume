/**
 * End-to-end test of «کلیدها و اتصال‌ها» — the deployment-wide fallback for the
 * mailbox and the SMS line, entered in /admin.
 *
 * What it proves:
 *   • a shared mailbox/line is verified before it is stored and never echoed;
 *   • a workspace with no credentials of its own really sends through them;
 *   • the workspace's own account always wins, and removing it falls back again;
 *   • the settings page says which account sends (`active` / `source`), so a
 *     tenant never believes it owns somebody else's mailbox;
 *   • with nothing configured the answer is an honest «not configured», and
 *     the health page shows every credential — not just four.
 *
 * Run with: npm run build && npx tsx scripts/credentials-api.test.ts
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

// -------------------------------------------------------------- mock SMTP ----

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

// --------------------------------------------------------- mock Kavenegar ----

const smsSends: Array<{ key: string; to: string; text: string }> = [];

function mockKavenegar(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const m = /^\/v1\/([^/]+)\/(.*)$/.exec(req.url || '');
      if (!m) return send(404, { return: { status: 404, message: 'not found' } });
      const key = decodeURIComponent(m[1]);
      if (key !== 'kavenegar-valid-key') return send(200, { return: { status: 418, message: 'invalid api key' } });
      if (m[2] === 'account/info.json') return send(200, { return: { status: 200, message: 'ok' }, entries: { remainingcredit: 1200 } });
      if (m[2] === 'sms/send.json') {
        const params = new URLSearchParams(body);
        smsSends.push({ key, to: params.get('receptor') || '', text: params.get('message') || '' });
        return send(200, { return: { status: 200, message: 'ok' }, entries: [{ messageid: 1001 }] });
      }
      send(404, { return: { status: 404, message: 'unknown path' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const sharedSmtp = await mockSmtp();
  const ownSmtp = await mockSmtp();
  const sms = await mockKavenegar();
  const smsBase = `http://127.0.0.1:${(sms.address() as any).port}`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cred-'));
  const PORT = 3800 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'credentials-api-secret-0123456789',
    ADMIN_EMAILS: 'owner@example.com',
    KAVENEGAR_API_BASE: smsBase,
    SMSIR_API_BASE: smsBase,
  } as NodeJS.ProcessEnv;
  // Nothing may arrive through the environment: the panel is the only source.
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMS_API_KEY', 'SMS_SENDER', 'KAVENEGAR_API_KEY', 'SMSIR_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER']) delete env[k];
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
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'سازمان آزمون کلیدها',
      name: 'مدیر سامانه',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    assert(Boolean(A) && owner.json.user?.platformAdmin === true, 'the ADMIN_EMAILS owner is platform admin');

    // ---------------------------------------------------------- registry ----
    const initial = await call('GET', '/api/admin/connections', A);
    assert(
      initial.status === 200 && initial.json.email?.configured === false && initial.json.sms?.configured === false,
      'with nothing entered the shared mailbox and line report «not configured»',
      `${initial.status}`
    );

    // ------------------------------------------------------- shared e-mail ----
    const unreachable = await call('PUT', '/api/admin/connections/email', A, {
      host: '127.0.0.1',
      port: 1,
      secure: false,
      username: 'hr@example.com',
      password: 'shared-secret-1',
      fromName: 'منابع انسانی',
      fromAddress: 'hr@example.com',
    });
    assert(unreachable.status === 400 && unreachable.json.code === 'SHARED_EMAIL_PROBE_FAILED', 'an unreachable mailbox is not stored', `${unreachable.status}`);

    const smtpPort = (sharedSmtp.server.address() as any).port;
    const saved = await call('PUT', '/api/admin/connections/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@example.com',
      password: 'shared-secret-1',
      fromName: 'منابع انسانی',
      fromAddress: 'hr@example.com',
      replyTo: 'jobs@example.com',
    });
    assert(saved.status === 200 && saved.json.email.configured === true && saved.json.email.source === 'admin', 'a real mailbox is verified and stored', `${saved.status} ${JSON.stringify(saved.json?.error || '')}`);
    assert(!JSON.stringify(saved.json).includes('shared-secret-1'), 'the shared SMTP password is never returned');
    assert(saved.json.email.fromAddress === 'hr@example.com' && saved.json.email.hasPassword === true, 'the panel shows the address and that a password is stored');

    // ---------------------------------------- the workspace sends through it ----
    const status = await call('GET', '/api/integrations/status', A);
    assert(status.json.email?.configured === false && status.json.email?.active === true, 'a workspace without its own mailbox can still send');
    assert(status.json.email?.source === 'shared' && status.json.email?.effectiveFromAddress === 'hr@example.com', 'the settings page says the platform mailbox sends', JSON.stringify(status.json.email?.source));

    const sent = await call('POST', '/api/integrations/email/send', A, { to: 'candidate@example.com', subject: 'دعوت به مصاحبه', body: 'سلام، برای مصاحبه دعوتید.' });
    assert(sent.status === 200, 'the e-mail goes out through the shared mailbox', `${sent.status} ${JSON.stringify(sent.json?.error || '')}`);
    assert(sharedSmtp.messages.length === 1 && /candidate@example\.com/.test(sharedSmtp.messages[0]), 'the message really reached the shared SMTP server', String(sharedSmtp.messages.length));

    // ---------------------------------------------- the workspace's own wins ----
    const ownPort = (ownSmtp.server.address() as any).port;
    const own = await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: ownPort,
      secure: false,
      username: 'own@example.com',
      password: 'own-secret-1',
      fromName: 'شرکت ما',
      fromAddress: 'own@example.com',
    });
    assert(own.status === 200 && own.json.email.configured === true, 'the workspace can still connect its own mailbox', `${own.status}`);
    const afterOwn = await call('GET', '/api/integrations/status', A);
    assert(afterOwn.json.email?.source === 'workspace' && afterOwn.json.email?.effectiveFromAddress === 'own@example.com', 'its own mailbox takes over from the shared one', JSON.stringify(afterOwn.json.email?.source));

    await call('POST', '/api/integrations/email/send', A, { to: 'second@example.com', subject: 'سلام', body: 'از حساب خودمان.' });
    assert(ownSmtp.messages.length === 1 && sharedSmtp.messages.length === 1, 'the second message left through the workspace mailbox only', `${ownSmtp.messages.length}/${sharedSmtp.messages.length}`);

    // ------------------------------------------------ removing the fallback ----
    const removedOwn = await call('DELETE', '/api/integrations/email', A);
    assert(removedOwn.status === 200 && removedOwn.json.email.configured === false && removedOwn.json.email.active === true, 'after disconnecting its own mailbox the workspace falls back to the shared one again', JSON.stringify(removedOwn.json.email?.source));

    const removedShared = await call('DELETE', '/api/admin/connections/email', A);
    assert(removedShared.status === 200 && removedShared.json.email.configured === false, 'the shared mailbox can be removed from the panel');
    const afterRemoval = await call('GET', '/api/integrations/status', A);
    assert(afterRemoval.json.email?.active === false && afterRemoval.json.email?.source === null, 'with no mailbox anywhere the workspace is honestly «not configured»', JSON.stringify(afterRemoval.json.email?.source));
    const refused = await call('POST', '/api/integrations/email/send', A, { to: 'x@example.com', subject: 'سلام', body: 'این نباید برود.' });
    assert(refused.status === 409 && refused.json.code === 'EMAIL_NOT_CONFIGURED', 'sending without any mailbox is refused, not faked', `${refused.status}`);

    // ------------------------------------------------------------- SMS line ----
    const badSms = await call('PUT', '/api/admin/connections/sms', A, { provider: 'kavenegar', apiKey: 'kavenegar-wrong-key', sender: '10004346' });
    assert(badSms.status === 400 && badSms.json.code === 'SHARED_SMS_PROBE_FAILED', 'an SMS key the provider rejects is not stored', `${badSms.status}`);

    const goodSms = await call('PUT', '/api/admin/connections/sms', A, { provider: 'kavenegar', apiKey: 'kavenegar-valid-key', sender: '10004346' });
    assert(goodSms.status === 200 && goodSms.json.sms.configured === true && goodSms.json.sms.sender === '10004346', 'a working SMS line is stored after the provider confirms it', `${goodSms.status} ${JSON.stringify(goodSms.json?.error || '')}`);
    assert(!JSON.stringify(goodSms.json).includes('kavenegar-valid-key'), 'the SMS API key is never returned');

    const smsStatus = await call('GET', '/api/integrations/status', A);
    assert(smsStatus.json.sms?.configured === false && smsStatus.json.sms?.active === true && smsStatus.json.sms?.source === 'shared', 'the workspace can text through the shared line');
    const smsSend = await call('POST', '/api/integrations/sms/send', A, { to: '۰۹۱۲۱۲۳۴۵۶۷', text: 'برای مصاحبه دعوتید.' });
    assert(smsSend.status === 200 && smsSends.length === 1 && smsSends[0].to === '09121234567', 'the text really reached the gateway', `${smsSend.status} ${JSON.stringify(smsSend.json?.error || '')}`);

    // ------------------------------------------------------------ health ----
    // Put the shared mailbox back so the health page has something to probe.
    await call('PUT', '/api/admin/connections/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@example.com',
      password: 'shared-secret-1',
      fromName: 'منابع انسانی',
      fromAddress: 'hr@example.com',
    });
    const health = await call('POST', '/api/admin/connections/health', A, {});
    const keys = (health.json.checks || []).map((c: any) => c.key);
    assert(
      health.status === 200 && ['sourcing', 'google', 'email', 'sms', 'calendar', 'chat', 'sso', 'ai'].every((k) => keys.includes(k)),
      'the health page covers every credential, not just four',
      keys.join(',')
    );
    const byKey = new Map<string, any>((health.json.checks || []).map((c: any) => [c.key, c]));
    assert(byKey.get('email')?.ok === true && byKey.get('sms')?.ok === true, 'the shared mailbox and line are reported as answering', `${byKey.get('email')?.ok}/${byKey.get('sms')?.ok}`);
    assert(byKey.get('ai')?.ok === null && byKey.get('ai')?.configured === false, 'without AI keys the row says «not configured», not «healthy»');
    assert(health.json.adoption.sms >= 0 && health.json.adoption.chat >= 0 && health.json.adoption.sso >= 0, 'adoption counts the new channels');

    // --------------------------------------------------- nothing leaks on disk ----
    const files = fs
      .readdirSync(DATA)
      .map((f) => path.join(DATA, f))
      .filter((f) => fs.statSync(f).isFile());
    const snap = files.map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
    assert(!snap.includes('kavenegar-valid-key') && !snap.includes('shared-secret-1'), 'no shared credential is stored in clear text');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    sharedSmtp.server.close();
    ownSmtp.server.close();
    sms.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

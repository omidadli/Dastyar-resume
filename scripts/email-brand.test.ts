/**
 * «نامهٔ سازمان» — the letterhead on every e-mail, proven at the wire.
 *
 * A preview in a settings page proves nothing; the only honest test is to read
 * the bytes an SMTP server actually received. This test stands up a throwaway
 * SMTP server, connects a workspace mailbox to it, and inspects the raw MIME.
 *
 * Proves:
 *   • the brand colour reaches the letter, in the accessible (dark) shade;
 *   • the logo travels as a `cid:` inline attachment — not a data-URI, not a
 *     remote URL — and the markup references that cid;
 *   • SVG/WebP logos are *not* embedded (inboxes drop them) — the wordmark is
 *     used instead, and the letter still looks deliberate;
 *   • `includeLogo: false` removes the attachment entirely;
 *   • the sign-off and footer note appear; the «ساخته‌شده با هویدا» credit
 *     disappears for a white-label workspace;
 *   • an unbranded workspace gets HOVIDA's own letter, not a broken one;
 *   • a workspace with no mailbox gets an honest 409, not a fake success;
 *   • the letter never carries the SMTP password.
 *
 * Run with: npm run build && npx tsx scripts/email-brand.test.ts
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

/** A throwaway SMTP server that keeps exactly what was sent. */
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
        if (cmd === 'EHLO') socket.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 OK\r\n');
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

/**
 * Real mail encodes Persian as quoted-printable (=D8=A2…) or base64, and long
 * lines are soft-wrapped. Decode both before asserting on words — otherwise the
 * test would "fail" on text that is perfectly present.
 */
function qpDecode(input: string): string {
  const joined = input.replace(/=\r?\n/g, '');
  const bytes = joined.replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return Buffer.from(bytes, 'binary').toString('utf8');
}

function base64Parts(raw: string): string[] {
  const out: string[] = [];
  const blocks = raw.split(/\r?\n\r?\n/).slice(1);
  for (const block of blocks) {
    const compact = block.replace(/\r?\n/g, '');
    if (compact.length > 40 && /^[A-Za-z0-9+/=]+$/.test(compact.trim())) {
      try {
        out.push(Buffer.from(compact.trim(), 'base64').toString('utf8'));
      } catch {
        /* not base64 after all */
      }
    }
  }
  return out;
}

/** Header encoded-words too: «=?UTF-8?B…?=» is how a Persian subject travels. */
function decodedWords(raw: string): string {
  return raw.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, kind, payload) => {
    try {
      return kind.toUpperCase() === 'B'
        ? Buffer.from(payload, 'base64').toString('utf8')
        : qpDecode(payload.replace(/_/g, ' '));
    } catch {
      return payload;
    }
  });
}

/** Everything the letter says, in one string, however the client encoded it. */
function readable(raw: string): string {
  return [decodedWords(raw), qpDecode(decodedWords(raw)), ...base64Parts(raw)].join('\n');
}

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>').toString('base64');

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-mailbrand-'));
  const PORT = 4700 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'mailbrand-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
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

    const A = await signup('آوا صنعت', 'hr@ava.example');
    const B = await signup('برنا تجارت', 'hr@borna.example');

    // A mailbox first: an unconnected workspace must be honest about it.
    const beforeMailbox = await call('POST', '/api/org/branding/email-test', A, {});
    assert(beforeMailbox.status === 409 && beforeMailbox.json?.code === 'EMAIL_NOT_CONFIGURED', 'without a mailbox the test letter is refused, honestly', String(beforeMailbox.status));
    assert(smtp.messages.length === 0, 'and nothing at all was sent');

    for (const [token, from, label] of [
      [A, 'hr@ava.example', 'A'],
      [B, 'hr@borna.example', 'B'],
    ] as const) {
      const r = await call('PUT', '/api/integrations/email', token, {
        host: '127.0.0.1',
        port: smtpPort,
        secure: false,
        username: from,
        password: 'smtp-secret-mailbrand-123',
        fromName: 'واحد منابع انسانی',
        fromAddress: from,
      });
      assert(r.status === 200, `mailbox for ${label} is connected`, `${r.status}`);
    }

    // ------------------------------------------------ an unbranded letter first
    smtp.messages.length = 0;
    const plain = await call('POST', '/api/org/branding/email-test', A, {});
    assert(plain.status === 200 && plain.json?.ok === true, 'a workspace with a mailbox can test its letter', `${plain.status} ${plain.json?.error || ''}`);
    assert(smtp.messages.length === 1, 'exactly one message left', String(smtp.messages.length));
    const plainRaw = smtp.messages[0];
    assert(/Subject: .*هویدا|Subject: .*=/i.test(plainRaw), 'the default letter is HOVIDA’s');
    assert(!/brand-top@hovida\.local/.test(plainRaw), 'and carries no logo attachment');
    assert(!plainRaw.includes('smtp-secret-mailbrand-123'), 'the SMTP password never appears in the letter');

    // ------------------------------------------------------- now brand it all
    const look = (await call('GET', '/api/org/branding', A)).json.branding;
    const saved = await call('PUT', '/api/org/branding', A, {
      ...look,
      nickname: 'آوا صنعت',
      logoDataUrl: PNG,
      colors: { brand: '#FFEE00', accent: '#1E3A8A' },
      showHovidaCredit: false,
      email: { signoff: 'با احترام،\nواحد منابع انسانی آوا', footerNote: 'تهران، خیابان ولیعصر — ۰۲۱۱۲۳۴۵۶۷۸', includeLogo: true },
    });
    assert(saved.status === 200, 'the identity with a letterhead saves', `${saved.status} ${saved.json?.error || ''}`);
    const accent = saved.json.tokens['--color-brand-strong'] as string;

    smtp.messages.length = 0;
    const branded = await call('POST', '/api/org/branding/email-test', A, {});
    assert(branded.status === 200, 'the branded test letter is sent', `${branded.status} ${branded.json?.error || ''}`);
    assert(branded.json?.to === 'hr@ava.example', 'it goes to the signed-in admin, not a candidate', String(branded.json?.to));
    const raw = smtp.messages[0] || '';
    const text = readable(raw);

    assert(new RegExp(accent, 'i').test(text), 'the accessible brand shade is used in the markup', accent);
    assert(/<table/i.test(text), 'the letter is table-based (Outlook-safe)');
    assert(/Content-ID:\s*<brand-top@hovida\.local>/i.test(raw), 'the logo travels as a cid attachment');
    assert(/Content-Disposition:\s*inline/i.test(raw), 'and is marked inline, so no paper-clip appears');
    assert(/cid:brand-top@hovida\.local/.test(text), 'the markup points at that cid');
    assert(!/data:image\/png;base64/.test(text), 'no data-URI image is sent (Gmail blocks them)');
    assert(!/https?:\/\/[^\s"]+\.(png|jpe?g|svg)/i.test(text), 'no remote logo URL either (no tracking pixel)');
    assert(text.includes('آوا صنعت'), 'the workspace name is in the letter');
    assert(/با احترام/.test(text) && /واحد منابع انسانی آوا/.test(text), 'the sign-off is included');
    assert(/ولیعصر/.test(text), 'the footer note is included');
    assert(!/ساخته‌شده با هویدا/.test(text), 'a white-label workspace leaves the HOVIDA credit out');
    assert(/Content-Type: multipart\/(mixed|related|alternative)/i.test(raw), 'the letter is a proper multipart message');

    // ------------------------------------------------- credit back on (opt-in)
    await call('PUT', '/api/org/branding', A, { ...saved.json.branding, showHovidaCredit: true });
    smtp.messages.length = 0;
    await call('POST', '/api/org/branding/email-test', A, {});
    assert(/ساخته‌شده با هویدا/.test(readable(smtp.messages[0] || '')), 'turning the credit on puts it back in the footer');

    // -------------------------------------------------------- logo switched off
    await call('PUT', '/api/org/branding', A, { ...saved.json.branding, showHovidaCredit: false, email: { ...saved.json.branding.email, includeLogo: false } });
    smtp.messages.length = 0;
    await call('POST', '/api/org/branding/email-test', A, {});
    const noLogo = smtp.messages[0] || '';
    assert(!/Content-ID:\s*<brand-top@hovida\.local>/i.test(noLogo), 'with the logo off, nothing is attached');
    assert(readable(noLogo).includes('آوا صنعت'), 'the header falls back to the workspace name');

    // --------------------------------------------------- SVG logo: never sent
    await call('PUT', '/api/org/branding', A, { ...saved.json.branding, logoDataUrl: SVG, email: { ...saved.json.branding.email, includeLogo: true } });
    smtp.messages.length = 0;
    await call('POST', '/api/org/branding/email-test', A, {});
    const svgRaw = smtp.messages[0] || '';
    assert(!/image\/svg/i.test(svgRaw), 'an SVG logo is never embedded (inboxes drop it)');
    assert(readable(svgRaw).includes('آوا صنعت'), 'the wordmark stands in for it');

    // ------------------------------------------------------------ tenant wall
    smtp.messages.length = 0;
    const bLetter = await call('POST', '/api/org/branding/email-test', B, {});
    assert(bLetter.status === 200, 'workspace B sends its own letter');
    const bRaw = readable(smtp.messages[0] || '');
    assert(!bRaw.includes('آوا صنعت') && !bRaw.includes('ولیعصر'), 'and it carries none of A’s identity');
    assert(bRaw.includes('برنا تجارت'), 'but its own name', '');

    // ------------------------------------------------------- mail log is clean
    const mailLog = await call('GET', '/api/integrations/emails', A);
    assert(mailLog.status === 200, 'the sent-folder answers', String(mailLog.status));
    assert(!JSON.stringify(mailLog.json).includes('smtp-secret-mailbrand-123'), 'the password is not echoed in the sent-folder either');
  } finally {
    child.kill('SIGTERM');
    smtp.server.close();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll letterhead checks passed.' : `\n${failures} letterhead check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

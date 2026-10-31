/**
 * End-to-end test of «ورود دومرحله‌ای» (two-factor login with an authenticator
 * app): the password alone opens nothing, the code is verified with an
 * independent TOTP implementation (so we test interop, not our own maths), a
 * used code or recovery code cannot be replayed, other devices are signed out
 * when it is switched on, and the secret never lands in the store in the clear.
 *
 * Run with: npm run build && npx tsx scripts/twofactor-api.test.ts
 */
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// ---------------------------------------------------------------- the oracle --
// A deliberately separate implementation of RFC 6238: if the server and this
// file agree, the server speaks the same language as Google Authenticator.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function fromBase32(input: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function codeAt(secret: string, atMs = Date.now(), digits = 6): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', fromBase32(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const num = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(num % 10 ** digits).padStart(digits, '0');
}

/**
 * Waits for the *next* 30-second window. A code belongs to the window it was
 * generated in, and the server refuses a step it has already accepted, so a test
 * that wants a fresh code has to wait for the clock — exactly like a person who
 * types the next code their phone shows.
 */
async function nextWindow(): Promise<void> {
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  await new Promise((r) => setTimeout(r, (left + 0.2) * 1000));
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-2fa-'));
  const PORT = 5700 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'two-factor-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
    DISABLE_DEMO: '1',
    // The operator account that can unlock a workspace owner (see the last block).
    ADMIN_EMAILS: 'ops@example.com',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    delete env[k];
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

  const login = (email: string, password: string) => call('POST', '/api/auth/login', null, { email, password });

  try {
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت آزمون',
      name: 'مدیر آزمون',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    assert(signup.status === 201 && Boolean(A), 'the workspace owner signs in normally at first', `${signup.status}`);
    assert((await call('GET', '/api/auth/me', A)).json.user.twoFactorEnabled === false, '/auth/me reports 2FA off');

    // ------------------------------------------------------------- enrolment --
    assert((await call('GET', '/api/auth/2fa', A)).json.enabled === false, 'the status endpoint says it is off');
    const weakPw = await call('POST', '/api/auth/2fa/setup', A, { password: 'wrong-password' });
    assert(weakPw.status === 400 && weakPw.json.field === 'password', 'enrolment needs the current password', `${weakPw.status}`);
    assert((await call('POST', '/api/auth/2fa/enable', A, { code: '123456' })).status === 409, 'a code without a started enrolment is refused');

    const setup = await call('POST', '/api/auth/2fa/setup', A, { password: 'Password12345' });
    assert(setup.status === 201, 'a correct password starts the enrolment', `${setup.status}`);
    let secret = setup.json.secret as string;
    assert(/^[A-Z2-7]{16,}$/.test(secret), 'the secret is base32 as authenticator apps expect');
    assert(setup.json.otpauth.startsWith('otpauth://totp/') && setup.json.otpauth.includes('secret=' + secret), 'the otpauth URI carries the secret and issuer');
    assert(String(setup.json.qr).startsWith('data:image/png;base64,'), 'a QR image is rendered server-side (no third party sees the secret)');
    let codes = setup.json.recoveryCodes as string[];
    assert(Array.isArray(codes) && codes.length === 8, 'eight recovery codes come with it', String(codes?.length));
    assert(codes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), 'they are typed-friendly «XXXX-XXXX» codes', codes[0]);
    // Closing the tab mid-enrolment must not lock anyone out: a fresh attempt
    // simply replaces the unconfirmed secret, and the abandoned one stops working.
    const abandoned = secret;
    const restart = await call('POST', '/api/auth/2fa/setup', A, { password: 'Password12345' });
    assert(restart.status === 201 && restart.json.secret !== abandoned, 'an unconfirmed enrolment can be restarted');
    secret = restart.json.secret;
    codes = restart.json.recoveryCodes;
    assert((await call('POST', '/api/auth/2fa/enable', A, { code: codeAt(abandoned) })).status === 400, 'the abandoned secret no longer works');

    // Nothing is enforced yet: the password still opens the door by itself.
    const beforeEnable = await login('owner@example.com', 'Password12345');
    assert(beforeEnable.status === 200 && typeof beforeEnable.json.token === 'string', 'before confirming a code, login is unchanged');
    const OTHER = beforeEnable.json.token as string;

    assert((await call('POST', '/api/auth/2fa/enable', A, { code: '000000' })).status === 400, 'a wrong code cannot turn it on');
    const good = codeAt(secret);
    const enabled = await call('POST', '/api/auth/2fa/enable', A, { code: good });
    assert(enabled.status === 200 && enabled.json.enabled === true, 'the first valid code turns it on', `${enabled.status}`);
    assert(enabled.json.recoveryLeft === 8, 'all eight recovery codes are still unused');
    assert((await call('GET', '/api/auth/me', A)).status === 200, 'the session that enabled it stays signed in');
    assert((await call('GET', '/api/auth/me', OTHER)).status === 401, 'other devices of the same account are signed out');
    assert((await call('GET', '/api/auth/me', A)).json.user.twoFactorEnabled === true, '/auth/me now reports 2FA on');

    // The store holds no usable secret and no recovery code in the clear.
    await new Promise((r) => setTimeout(r, 700)); // the save is debounced
    const store = fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf8');
    assert(!store.includes(secret), 'the secret is encrypted at rest, never stored in the clear');
    assert(!store.includes(codes[0]), 'recovery codes are stored only as hashes');
    assert(store.includes('lastStep'), 'the last accepted step is remembered (replay protection)');

    // --------------------------------------------------------------- signing in --
    await nextWindow();
    const first = await login('owner@example.com', 'Password12345');
    assert(first.status === 200 && first.json.twoFactorRequired === true, 'a correct password now returns a challenge, not a session');
    assert(typeof first.json.token === 'undefined', 'no session token is issued at that point');
    const challenge = first.json.challenge as string;
    assert(typeof challenge === 'string' && challenge.length >= 20, 'the challenge is an unguessable string');

    const wrong = await call('POST', '/api/auth/2fa', null, { challenge, code: '000000' });
    assert(wrong.status === 401 && wrong.json.code === 'INVALID_CODE', 'a wrong code is refused', `${wrong.status}`);
    assert((await call('POST', '/api/auth/2fa', null, { challenge: 'nope' })).status === 401, 'an unknown challenge is refused');
    assert((await call('POST', '/api/auth/2fa', null, {})).status === 400, 'a request without a challenge is a clean 400');

    // A fresh window: the code that switched it on has been spent already.
    await nextWindow();
    const step = codeAt(secret);
    const second = await call('POST', '/api/auth/2fa', null, { challenge, code: step });
    assert(second.status === 200 && typeof second.json.token === 'string', 'the right code completes the login', `${second.status}`);
    assert((await call('GET', '/api/auth/me', second.json.token)).status === 200, 'the new session works');
    assert((await call('POST', '/api/auth/2fa', null, { challenge, code: step })).status === 401, 'the same challenge cannot be used twice');

    // Replaying the same 6 digits inside their own 30 seconds.
    const again = await login('owner@example.com', 'Password12345');
    const replay = await call('POST', '/api/auth/2fa', null, { challenge: again.json.challenge, code: step });
    assert(replay.status === 401 && replay.json.code === 'CODE_REUSED', 'a code that was already used cannot be replayed', replay.json.code);

    // ------------------------------------------------------------ recovery codes --
    const third = await login('owner@example.com', 'Password12345');
    const viaRecovery = await call('POST', '/api/auth/2fa', null, { challenge: third.json.challenge, recoveryCode: codes[0] });
    assert(viaRecovery.status === 200 && typeof viaRecovery.json.token === 'string', 'a recovery code signs you in without the phone');
    assert((await call('GET', '/api/auth/2fa', A)).json.recoveryLeft === 7, 'that recovery code is now spent');
    const fourth = await login('owner@example.com', 'Password12345');
    const reused = await call('POST', '/api/auth/2fa', null, { challenge: fourth.json.challenge, recoveryCode: codes[0] });
    assert(reused.status === 401 && reused.json.code === 'INVALID_RECOVERY', 'the same recovery code cannot be used twice', reused.json.code);

    // ------------------------------------------------------------- brute force --
    const fifth = await login('owner@example.com', 'Password12345');
    const tries: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      tries.push((await call('POST', '/api/auth/2fa', null, { challenge: fifth.json.challenge, code: '111111' })).status);
    }
    assert(tries.every((s) => s === 401), 'wrong codes are simply refused', tries.join(','));
    const spent = await call('POST', '/api/auth/2fa', null, { challenge: fifth.json.challenge, code: '111111' });
    assert(spent.status === 429 && spent.json.code === 'TOO_MANY_TRIES', 'one challenge dies after five wrong attempts', `${spent.status} ${spent.json.code}`);

    // ------------------------------------------------------------- housekeeping --
    const fresh = await login('owner@example.com', 'Password12345');
    // Rotation is allowed with the same live code: nothing about it is a login.
    const rotated = await call('POST', '/api/auth/2fa/recovery', A, { code: codeAt(secret) });
    assert(rotated.status === 200 && rotated.json.recoveryCodes.length === 8, 'fresh recovery codes can be minted with a live code', `${rotated.status}`);
    assert(rotated.json.recoveryLeft === 8, 'the counter starts again from eight');
    const retired = await login('owner@example.com', 'Password12345');
    const oldCode = await call('POST', '/api/auth/2fa', null, { challenge: retired.json.challenge, recoveryCode: codes[1] });
    assert(oldCode.status === 401 && oldCode.json.code === 'INVALID_RECOVERY', 'the previous set stops working at once', oldCode.json.code);
    // The login above already spent this window's step, so ask the clock for the next one.
    await nextWindow();
    const codeNow = codeAt(secret);
    const withNew = await call('POST', '/api/auth/2fa', null, { challenge: fresh.json.challenge, code: codeNow });
    assert(withNew.status === 200, 'and the ordinary code still signs in', `${withNew.status}`);

    // ------------------------------------------------------------ turning it off --
    const halfOff = await call('POST', '/api/auth/2fa/disable', A, { password: 'wrong', code: codeNow });
    assert(halfOff.status === 400, 'turning it off needs the password');
    assert((await call('POST', '/api/auth/2fa/disable', A, { password: 'Password12345', code: '000000' })).status === 400, 'and a live code');
    const off = await call('POST', '/api/auth/2fa/disable', A, { password: 'Password12345', code: codeAt(secret) });
    assert(off.status === 200 && off.json.enabled === false, 'password plus code turns it off', `${off.status}`);
    const plain = await login('owner@example.com', 'Password12345');
    assert(plain.status === 200 && typeof plain.json.token === 'string', 'login is back to the password alone');
    assert((await call('GET', '/api/auth/2fa')).status === 401, 'the status endpoint is for signed-in users only');

    // ----------------------------------------------------- the operator account --
    const member = await call('POST', '/api/org/members', plain.json.token, {
      name: 'کارشناس',
      email: 'member@example.com',
      password: 'Password12345',
      role: 'member',
    });
    assert(member.status === 201, 'a second member exists', `${member.status}`);
    const M = (await login('member@example.com', 'Password12345')).json.token as string;
    const memberSetup = await call('POST', '/api/auth/2fa/setup', M, { password: 'Password12345' });
    assert(memberSetup.status === 201, 'every member can protect their own account');
    assert((await call('POST', '/api/auth/2fa/enable', M, { code: codeAt(memberSetup.json.secret) })).status === 200, 'the member confirms it with their phone');
    assert((await call('GET', '/api/org', A)).json.members.find((m: any) => m.email === 'member@example.com').twoFactorEnabled === true, 'the team table shows who has it on');

    // --------------------------------------------- the locked-out colleague --
    const memberId = (await call('GET', '/api/org', A)).json.members.find((m: any) => m.email === 'member@example.com').id;
    assert(
      (await call('POST', `/api/org/members/${memberId}/2fa-reset`, M, {})).status === 403,
      'a plain member cannot reset anyone'
    );
    const ownerId = (await call('GET', '/api/auth/me', A)).json.user.id;
    assert((await call('POST', `/api/org/members/${ownerId}/2fa-reset`, A, {})).status === 403, 'the owner’s own second factor is not removable from inside the workspace');
    const reset = await call('POST', `/api/org/members/${memberId}/2fa-reset`, A, {});
    assert(reset.status === 200 && reset.json.members.find((m: any) => m.id === memberId).twoFactorEnabled === false, 'an admin clears it after a lost phone', `${reset.status}`);
    assert((await call('GET', '/api/auth/me', M)).status === 401, 'the locked-out member’s old sessions are gone');
    const memberAgain = await login('member@example.com', 'Password12345');
    assert(memberAgain.status === 200 && typeof memberAgain.json.token === 'string', 'the member signs in with the password again');
    assert((await call('POST', `/api/org/members/${memberId}/2fa-reset`, A, {})).status === 409, 'resetting an account without 2FA is a clean 409');
    assert((await call('GET', '/api/auth/2fa', A)).json.enabled === false, 'the owner keeps their own setting');

    // ------------------------------------------- the platform admin's unlock --
    const ops = await call('POST', '/api/auth/signup', null, {
      orgName: 'اپراتور',
      name: 'اپراتور سامانه',
      email: 'ops@example.com',
      password: 'Password12345',
    });
    const OPS = ops.json.token as string;
    assert(ops.status === 201 && ops.json.user.platformAdmin === true, 'an address in ADMIN_EMAILS is a platform admin');
    const opsSetup = await call('POST', '/api/auth/2fa/setup', OPS, { password: 'Password12345' });
    assert((await call('POST', '/api/auth/2fa/enable', OPS, { code: codeAt(opsSetup.json.secret) })).status === 200, 'the operator protects their own account too');
    const listed = await call('GET', '/api/admin/users?q=ops@example.com', OPS);
    assert(listed.json.items?.[0]?.twoFactorEnabled === true, 'the admin panel shows who has 2FA on');
    const unlocked = await call('POST', `/api/admin/users/${ops.json.user.id}/reset-2fa`, OPS, {});
    assert(unlocked.status === 200 && unlocked.json.user.twoFactorEnabled === false, 'the platform admin can unlock a lost owner', `${unlocked.status}`);
    assert((await call('POST', `/api/admin/users/${ops.json.user.id}/reset-2fa`, OPS, {})).status === 409, 'unlocking twice is a clean 409');
    const opsPlain = await login('ops@example.com', 'Password12345');
    assert(opsPlain.status === 200 && typeof opsPlain.json.token === 'string', 'that account signs in with the password again');
  } finally {
    child.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

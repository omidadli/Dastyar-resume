/**
 * «ورود دومرحله‌ای» — TOTP (RFC 6238) with the authenticator app the team
 * already has on their phones. No vendor, no SMS cost, no extra dependency:
 * 20 random bytes, HMAC-SHA1, 30-second steps, 6 digits.
 *
 * Two deliberate choices:
 *   - a code is accepted only once (the step number is remembered), so a
 *     shoulder-surfed code cannot be replayed inside its own window;
 *   - recovery codes are single-use and stored as SHA-256 hashes, never in clear.
 */
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SEC = 30;
export const TOTP_DIGITS = 6;

/** RFC 4648 base32 without padding — what every authenticator app expects. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = B32.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(bytes = 20): string {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP for a given counter — the primitive TOTP is built on. */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code =
    ((mac[offset] & 0x7f) << 24) | ((mac[offset + 1] & 0xff) << 16) | ((mac[offset + 2] & 0xff) << 8) | (mac[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function stepAt(at: number = Date.now()): number {
  return Math.floor(at / 1000 / TOTP_STEP_SEC);
}

export function totp(secret: string, at: number = Date.now()): string {
  return hotp(secret, stepAt(at));
}

/**
 * Returns the accepted step number, or null. `window` allows one step of clock
 * drift in each direction — two minutes total — and nothing more.
 */
export function verifyTotp(secret: string, token: string, opts: { at?: number; window?: number } = {}): number | null {
  const code = String(token || '').replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const step = stepAt(opts.at);
  const window = Math.max(0, Math.min(2, opts.window ?? 1));
  for (let delta = -window; delta <= window; delta += 1) {
    if (hotp(secret, step + delta) === code) return step + delta;
  }
  return null;
}

/** The `otpauth://` address an authenticator app reads from a QR code or a link. */
export function otpauthUrl(input: { secret: string; account: string; issuer: string }): string {
  const issuer = input.issuer || 'HOVIDA';
  const label = encodeURIComponent(`${issuer}:${input.account}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** `XXXX-XXXX` — readable on paper, 40 bits of randomness each. */
export function generateRecoveryCodes(count = 8): string[] {
  const codes: string[] = [];
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1: unambiguous when typed
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(8);
    let out = '';
    for (const byte of raw) out += alphabet[byte % alphabet.length];
    codes.push(`${out.slice(0, 4)}-${out.slice(4, 8)}`);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(`hovida-2fa|${code.toUpperCase().replace(/[\s-]/g, '')}`).digest('hex');
}

/** Seconds left in the current step — shown so the user knows a code is fresh. */
export function secondsLeft(at: number = Date.now()): number {
  return TOTP_STEP_SEC - (Math.floor(at / 1000) % TOTP_STEP_SEC);
}

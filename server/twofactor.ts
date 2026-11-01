/**
 * «ورود دومرحله‌ای» — the service layer around ./totp.
 *
 * The login flow is deliberately two requests:
 *   `POST /auth/login` returns `{ twoFactorRequired: true, challenge }` and no
 *   session; `POST /auth/2fa` exchanges that challenge plus a code for a session.
 * The challenge lives in memory for five minutes, is single-use, and dies after
 * five wrong codes — so a stolen password alone opens nothing.
 */
import crypto from 'crypto';
import QRCode from 'qrcode';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, otpauthUrl, verifyTotp } from './totp';

export class TwoFactorError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'TWO_FACTOR_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_CHALLENGE_TRIES = 5;

interface Challenge {
  userId: string;
  expiresAt: number;
  tries: number;
}

const challenges = new Map<string, Challenge>();

/** Housekeeping, called from the periodic purge. */
export function purgeChallenges(now = Date.now()): void {
  for (const [token, c] of challenges) if (c.expiresAt < now) challenges.delete(token);
}

export function startChallenge(userId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  challenges.set(token, { userId, expiresAt: Date.now() + CHALLENGE_TTL_MS, tries: 0 });
  // A signed-in browser that never finishes must not leave a live challenge behind.
  purgeChallenges();
  return token;
}

/** Who started this challenge — without consuming it (the verifier does that). */
export function challengeUser(token: string): db.UserRecord {
  const c = takeChallenge(token);
  const user = db.getUser(c.userId);
  if (!user) throw new TwoFactorError('این درخواست ورود معتبر نیست.', 401, 'CHALLENGE_MISMATCH');
  return user;
}

function takeChallenge(token: string): Challenge {
  const c = token ? challenges.get(token) : null;
  if (!c) throw new TwoFactorError('این درخواست ورود منقضی شده است؛ دوباره وارد شوید.', 401, 'CHALLENGE_EXPIRED');
  if (c.expiresAt < Date.now()) {
    challenges.delete(token);
    throw new TwoFactorError('این درخواست ورود منقضی شده است؛ دوباره وارد شوید.', 401, 'CHALLENGE_EXPIRED');
  }
  return c;
}

export interface Enrollment {
  secret: string;
  otpauth: string;
  /** A ready-to-show PNG the phone scans — rendered here, so no third party sees the secret. */
  qr: string;
  recoveryCodes: string[];
}

/** Step 1: the browser asks for a new secret (the password is checked by the route). */
export async function beginEnrollment(userId: string, account: string, issuer: string): Promise<Enrollment> {
  const user = db.getUser(userId);
  if (!user) throw new TwoFactorError('کاربر پیدا نشد.', 404, 'USER_NOT_FOUND');
  const existing = db.getTwoFactor(userId);
  if (existing?.enabledAtISO) {
    throw new TwoFactorError('ورود دومرحله‌ای از قبل روشن است؛ برای تغییر، اول خاموشش کنید.', 409, 'ALREADY_ENABLED');
  }
  const secret = generateSecret();
  const recoveryCodes = generateRecoveryCodes();
  const otpauth = otpauthUrl({ secret, account, issuer });
  db.setTwoFactor(userId, {
    secretEnc: encryptSecret(secret),
    enabledAtISO: null,
    recovery: recoveryCodes.map((code) => ({ hash: hashRecoveryCode(code), usedAtISO: null })),
    lastStep: null,
  });
  const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
  return { secret, otpauth, qr, recoveryCodes };
}

/** Step 2: one valid code turns it on — and only then is it enforced at login. */
export function confirmEnrollment(userId: string, code: string): { recoveryLeft: number } {
  const record = db.getTwoFactor(userId);
  if (!record?.secretEnc) throw new TwoFactorError('اول مرحلهٔ راه‌اندازی را شروع کنید.', 409, 'NOT_STARTED');
  if (record.enabledAtISO) throw new TwoFactorError('ورود دومرحله‌ای از قبل روشن است.', 409, 'ALREADY_ENABLED');
  const secret = decryptSecret(record.secretEnc);
  if (!secret) throw new TwoFactorError('کلید این حساب در دسترس نیست؛ دوباره راه‌اندازی کنید.', 409, 'SECRET_UNAVAILABLE');
  const step = verifyTotp(secret, code);
  if (step === null) throw new TwoFactorError('کد درست نیست یا از زمان گذشته است؛ کد تازهٔ برنامه را وارد کنید.', 400, 'INVALID_CODE');
  db.setTwoFactor(userId, { ...record, enabledAtISO: new Date().toISOString(), lastStep: step });
  return { recoveryLeft: record.recovery.filter((r) => !r.usedAtISO).length };
}

/** Turning it off needs both the password (checked by the route) and a live code. */
export function disable(userId: string, code: string): void {
  const record = db.getTwoFactor(userId);
  if (!record?.enabledAtISO) throw new TwoFactorError('ورود دومرحله‌ای روشن نیست.', 409, 'NOT_ENABLED');
  const secret = decryptSecret(record.secretEnc);
  if (!secret || verifyTotp(secret, code) === null) throw new TwoFactorError('کد درست نیست.', 400, 'INVALID_CODE');
  db.setTwoFactor(userId, null);
}

export function regenerateRecovery(userId: string, code: string): string[] {
  const record = db.getTwoFactor(userId);
  if (!record?.enabledAtISO) throw new TwoFactorError('ورود دومرحله‌ای روشن نیست.', 409, 'NOT_ENABLED');
  const secret = decryptSecret(record.secretEnc);
  if (!secret || verifyTotp(secret, code) === null) throw new TwoFactorError('کد درست نیست.', 400, 'INVALID_CODE');
  const codes = generateRecoveryCodes();
  db.setTwoFactor(userId, {
    ...record,
    recovery: codes.map((c) => ({ hash: hashRecoveryCode(c), usedAtISO: null })),
  });
  // The old codes stop working immediately; the new set is shown once.
  return codes;
}

export type SecondFactor = { kind: 'totp'; step: number } | { kind: 'recovery'; left: number };

/**
 * Verifies the second step of a login. A TOTP code must be newer than the last
 * accepted step; a recovery code is spent as soon as it is used.
 */
export function verifySecondStep(user: db.UserRecord, input: { code?: unknown; recoveryCode?: unknown; challenge: string }): SecondFactor {
  const record = db.getTwoFactor(user.id);
  if (!record?.enabledAtISO) throw new TwoFactorError('ورود دومرحله‌ای برای این حساب روشن نیست.', 409, 'NOT_ENABLED');

  const challenge = takeChallenge(input.challenge);
  if (challenge.userId !== user.id) throw new TwoFactorError('این درخواست ورود معتبر نیست.', 401, 'CHALLENGE_MISMATCH');
  challenge.tries += 1;
  if (challenge.tries > MAX_CHALLENGE_TRIES) {
    challenges.delete(input.challenge);
    throw new TwoFactorError('تعداد تلاش‌ها زیاد شد؛ دوباره وارد شوید.', 429, 'TOO_MANY_TRIES');
  }

  const recoveryRaw = typeof input.recoveryCode === 'string' ? input.recoveryCode.trim() : '';
  if (recoveryRaw) {
    const hash = hashRecoveryCode(recoveryRaw);
    const entry = record.recovery.find((r) => r.hash === hash && !r.usedAtISO);
    if (!entry) {
      // A used code is refused with the same message: an attacker learns nothing.
      throw new TwoFactorError('این کد بازیابی معتبر نیست یا قبلاً استفاده شده است.', 401, 'INVALID_RECOVERY');
    }
    entry.usedAtISO = new Date().toISOString();
    db.setTwoFactor(user.id, record);
    challenges.delete(input.challenge);
    return { kind: 'recovery', left: record.recovery.filter((r) => !r.usedAtISO).length };
  }

  const secret = decryptSecret(record.secretEnc);
  if (!secret) throw new TwoFactorError('کلید این حساب در دسترس نیست؛ با مدیر سامانه تماس بگیرید.', 500, 'SECRET_UNAVAILABLE');
  const step = verifyTotp(secret, String(input.code || ''));
  if (step === null) throw new TwoFactorError('کد درست نیست یا از زمان گذشته است.', 401, 'INVALID_CODE');
  if (record.lastStep !== null && step <= record.lastStep) {
    throw new TwoFactorError('این کد قبلاً استفاده شده است؛ کد تازه را وارد کنید.', 401, 'CODE_REUSED');
  }
  db.setTwoFactor(user.id, { ...record, lastStep: step });
  challenges.delete(input.challenge);
  return { kind: 'totp', step };
}

export function statusOf(userId: string) {
  const record = db.getTwoFactor(userId);
  return {
    enabled: Boolean(record?.enabledAtISO),
    enabledAtISO: record?.enabledAtISO ?? null,
    recoveryLeft: record ? record.recovery.filter((r) => !r.usedAtISO).length : 0,
    /** An enrolment was started but never confirmed. */
    pending: Boolean(record?.secretEnc && !record?.enabledAtISO),
  };
}

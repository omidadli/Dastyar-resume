/**
 * Server secret material.
 *
 * APP_SECRET (env) or a random secret persisted next to the data signs file
 * URLs and — through a separate derived key — encrypts the AI provider keys
 * that platform admins store in /admin (AES-256-GCM). Keep APP_SECRET stable:
 * changing it invalidates signed links and makes stored AI keys unreadable
 * (the admin panel then asks for them again).
 *
 * The persisted secret lives in the storage driver (`.app-secret`): a file in
 * DATA_DIR, or an object in R2 on Cloudflare — where the container disk is
 * wiped on every restart, so a file next to the app would not survive.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR, PreconditionFailedError, storage } from './storage';

const SECRET_KEY = '.app-secret';
let cachedSecret: Buffer | null = null;

function fromEnv(): Buffer | null {
  const env = process.env.APP_SECRET?.trim();
  return env && env.length >= 16 ? Buffer.from(env, 'utf-8') : null;
}

function parseStored(raw: string | Buffer | undefined | null): Buffer | null {
  if (!raw) return null;
  const buf = Buffer.from(String(raw).trim(), 'hex');
  return buf.length >= 32 ? buf : null;
}

/**
 * Loads (or creates) the secret before the server takes requests. Needed for
 * the remote store, which cannot be read synchronously.
 */
export async function initAppSecret(): Promise<void> {
  if (cachedSecret) return;
  const env = fromEnv();
  if (env) {
    cachedSecret = env;
    return;
  }
  const st = storage();
  const existing = await st.get(SECRET_KEY, { patienceMs: Number(process.env.STORAGE_PATIENCE_MS) || 60_000 });
  const stored = parseStored(existing?.body.toString('utf-8'));
  if (stored) {
    cachedSecret = stored;
    return;
  }
  const fresh = crypto.randomBytes(32);
  try {
    await st.put(SECRET_KEY, fresh.toString('hex'), existing ? {} : { ifNoneMatch: '*' });
    cachedSecret = fresh;
  } catch (err) {
    if (err instanceof PreconditionFailedError) {
      // Another instance created it a moment ago: use that one.
      cachedSecret = parseStored((await st.get(SECRET_KEY, { patienceMs: Number(process.env.STORAGE_PATIENCE_MS) || 30_000 }))?.body.toString('utf-8'));
      if (cachedSecret) return;
    }
    console.warn('[secret] could not persist app secret; signed links reset on restart.', (err as any)?.message || err);
    cachedSecret = fresh;
  }
}

export function appSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = fromEnv();
  if (env) {
    cachedSecret = env;
    return cachedSecret;
  }
  if (storage().driver !== 'fs') throw new Error('APP_SECRET is not loaded yet — call initAppSecret() at start-up.');
  const file = path.join(DATA_DIR, SECRET_KEY);
  try {
    const stored = parseStored(fs.readFileSync(file, 'utf-8'));
    if (stored) {
      cachedSecret = stored;
      return cachedSecret;
    }
  } catch {
    /* create below */
  }
  cachedSecret = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, cachedSecret.toString('hex'), { mode: 0o600 });
  } catch (err) {
    console.warn('[secret] could not persist app secret; signed links reset on restart.', err);
  }
  return cachedSecret;
}

/** Independent 32-byte key per purpose (HKDF-SHA256). */
export function deriveKey(purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', appSecret(), Buffer.from('hovida'), Buffer.from(purpose), 32));
}

const VAULT_PREFIX = 'v1:';

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey('ai-key-vault'), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  return VAULT_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

/** Null when the value was encrypted with another APP_SECRET (or is corrupt). */
export function decryptSecret(stored: string): string | null {
  if (!stored || !stored.startsWith(VAULT_PREFIX)) return null;
  try {
    const raw = Buffer.from(stored.slice(VAULT_PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey('ai-key-vault'), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

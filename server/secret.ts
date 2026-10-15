/**
 * Server secret material.
 *
 * APP_SECRET (env) or a random secret persisted next to the data signs file
 * URLs and — through a separate derived key — encrypts the AI provider keys
 * that platform admins store in /admin (AES-256-GCM). Keep APP_SECRET stable:
 * changing it invalidates signed links and makes stored AI keys unreadable
 * (the admin panel then asks for them again).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './db';

let cachedSecret: Buffer | null = null;

export function appSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const env = process.env.APP_SECRET?.trim();
  if (env && env.length >= 16) {
    cachedSecret = Buffer.from(env, 'utf-8');
    return cachedSecret;
  }
  const file = path.join(DATA_DIR, '.app-secret');
  try {
    cachedSecret = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'hex');
    if (cachedSecret.length >= 32) return cachedSecret;
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

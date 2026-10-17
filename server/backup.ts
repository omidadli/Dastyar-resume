/**
 * Full backup & restore — /admin › «پشتیبان‌گیری و انتقال».
 *
 * A backup is one ZIP: README.txt, manifest.json, hovida-store.json (every
 * workspace, user, job, candidate, decision, setting and the audit log —
 * without sign-in sessions) and resumes/… (the original files). It moves a
 * whole installation between servers, e.g. from Render to Cloudflare.
 *
 * Restore: the file is uploaded in chunks (Cloudflare limits one request to
 * 100 MB), inspected (format, checksum, counts) and only then applied. Applying
 * uploads the original files first and swaps the data in one step at the end;
 * a safety copy of the replaced data is kept under backups/pre-restore/.
 * AI keys are encrypted with APP_SECRET: on a server with another secret they
 * stay listed as «unreadable» until re-entered, and this server's own keys are
 * kept next to them.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Writable } from 'stream';
import * as db from './db';
import { decryptSecret } from './secret';
import { storage } from './storage';
import { tehranNow } from './tehran-time';
import { MAX_AI_KEYS, adminEmails, initPlatform } from './platform';
import { ZipFormatError, ZipReader, ZipWriter } from './zip';
import type { BackupSummary, RestoreResult } from '../src/types/admin';

export type { BackupSummary, RestoreResult };

export const BACKUP_FORMAT = 'hovida-backup';
export const BACKUP_FORMAT_VERSION = 1;
const MANIFEST_ENTRY = 'manifest.json';
const STORE_ENTRY = 'hovida-store.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_STORE_BYTES = 768 * 1024 * 1024;
const MAX_FILE_BYTES = 40 * 1024 * 1024;
/** Plain ZIP (no ZIP64) stays under 4 GB. */
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024 * 1024 - 1;
/** Restore uploads are sent in pieces of at most this size. */
export const RESTORE_CHUNK_BYTES = 8 * 1024 * 1024;
const UPLOAD_TTL_MS = 3 * 3600_000;
const PRE_RESTORE_KEEP = 3;

export class BackupError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'BackupError';
    this.status = status;
  }
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  app: 'HOVIDA';
  appVersion: string;
  createdAtISO: string;
  createdAtJalali: string;
  createdBy: string;
  store: { file: string; bytes: number; sha256: string };
  counts: { orgs: number; users: number; jobs: number; resumes: number; files: number; missingFiles: number };
  fileBytes: number;
}

const sha256 = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

const README = `هویدا — فایل پشتیبان کامل
================================

این فایل همه داده‌های یک سامانه هویدا را دارد: فضاهای کاری، کاربران، فرصت‌های شغلی،
رزومه‌ها و فایل‌های اصلی آن‌ها، تصمیم‌ها و تنظیمات.
برای انتقال یا بازگردانی: پنل مدیریت › پشتیبان‌گیری و انتقال › بازیابی از فایل پشتیبان.

این فایل اطلاعات شخصی متقاضیان و رمزهای عبور (به‌صورت درهم‌سازی‌شده) را دارد؛
آن را مثل یک سند محرمانه نگه دارید و پس از انتقال، نسخه‌های اضافی را پاک کنید.

HOVIDA full backup — workspaces, users, jobs, resumes with their original files,
decisions and settings. Restore it in /admin › Backup & transfer. It contains
personal data: store it like a confidential document.
`;

// =============================================================== download ====

let backupsRunning = 0;

/** Streams a full backup as a ZIP into `out` (an HTTP response with headers already set). */
export async function writeBackup(out: Writable, meta: { createdBy: string; appVersion: string }) {
  if (backupsRunning >= 2) throw new BackupError('دو پشتیبان‌گیری هم‌زمان در حال انجام است؛ چند دقیقه دیگر دوباره تلاش کنید.', 429);
  backupsRunning++;
  try {
    const snap = db.exportSnapshotForBackup();
    const storeJson = Buffer.from(JSON.stringify(snap), 'utf-8');
    const zip = new ZipWriter(out);
    await zip.add('README.txt', Buffer.from(README, 'utf-8'), { compress: true });
    await zip.add(STORE_ENTRY, storeJson, { compress: true });
    const st = storage();
    let files = 0;
    let missing = 0;
    let fileBytes = 0;
    const seen = new Set<string>();
    for (const { key } of db.resumeFileEntries()) {
      if (seen.has(key)) continue;
      seen.add(key);
      const obj = await st.get(key).catch(() => null);
      if (!obj) {
        missing++;
        continue;
      }
      await zip.add(key, obj.body);
      files++;
      fileBytes += obj.body.length;
    }
    const now = tehranNow();
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      app: 'HOVIDA',
      appVersion: meta.appVersion,
      createdAtISO: new Date().toISOString(),
      createdAtJalali: `${now.jalaliString} ${now.timeStr}`,
      createdBy: meta.createdBy,
      store: { file: STORE_ENTRY, bytes: storeJson.length, sha256: sha256(storeJson) },
      counts: { orgs: snap.orgs.length, users: snap.users.length, jobs: snap.jobs.length, resumes: snap.resumes.length, files, missingFiles: missing },
      fileBytes,
    };
    await zip.add(MANIFEST_ENTRY, Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8'));
    await zip.finish();
    return { files, missing, bytes: zip.bytesWritten };
  } finally {
    backupsRunning--;
  }
}

/** File name for a download, e.g. hovida-backup-1405-07-25.zip (Tehran date). */
export function backupFileName(): string {
  const j = tehranNow().jalali;
  return `hovida-backup-${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}.zip`;
}

// ================================================================ reading ====

interface OpenedBackup {
  zip: ZipReader;
  prefix: string;
  manifest: BackupManifest;
  snap: db.StoreSnapshot;
}

async function openBackup(file: string): Promise<OpenedBackup> {
  let zip: ZipReader;
  try {
    zip = await ZipReader.open(file);
  } catch {
    throw new BackupError('این فایل، فایل ZIP سالمی نیست؛ همان فایلی را انتخاب کنید که از «دریافت پشتیبان کامل» گرفته‌اید.');
  }
  try {
    // Re-zipped by hand, the content often sits inside one folder.
    let entry = zip.find(MANIFEST_ENTRY);
    let prefix = '';
    if (!entry) {
      const nested = zip.entries.filter((e) => /^[^/]+\/manifest\.json$/.test(e.name));
      if (nested.length === 1) {
        entry = nested[0];
        prefix = entry.name.slice(0, -MANIFEST_ENTRY.length);
      }
    }
    if (!entry) throw new BackupError('در این فایل، مشخصات پشتیبان (manifest.json) پیدا نشد؛ این فایل پشتیبان هویدا نیست.');
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse((await zip.read(entry, MAX_MANIFEST_BYTES)).toString('utf-8'));
    } catch {
      throw new BackupError('مشخصات پشتیبان (manifest.json) خوانا نیست.');
    }
    if (manifest?.format !== BACKUP_FORMAT) throw new BackupError('این فایل پشتیبان هویدا نیست.');
    if (!(Number(manifest.formatVersion) >= 1)) throw new BackupError('نسخه قالب این پشتیبان شناخته نشد.');
    if (Number(manifest.formatVersion) > BACKUP_FORMAT_VERSION) {
      throw new BackupError('این پشتیبان با نسخه تازه‌تری از هویدا ساخته شده است؛ اول هویدا را روی این سرور به‌روز کنید.');
    }
    const storeName = prefix + (typeof manifest.store?.file === 'string' && !manifest.store.file.includes('/') ? manifest.store.file : STORE_ENTRY);
    const storeEntry = zip.find(storeName);
    if (!storeEntry) throw new BackupError('داده‌های اصلی (hovida-store.json) در فایل پشتیبان نیست.');
    let raw: Buffer;
    try {
      raw = await zip.read(storeEntry, MAX_STORE_BYTES);
    } catch (err) {
      throw new BackupError(err instanceof ZipFormatError && /too large/.test(err.message) ? 'داده‌های این پشتیبان بزرگ‌تر از حد قابل بازیابی است.' : 'فایل پشتیبان آسیب دیده است و داده‌های اصلی خوانده نشد.');
    }
    if (manifest.store?.sha256 && sha256(raw) !== manifest.store.sha256) throw new BackupError('فایل پشتیبان آسیب دیده است (مقدار کنترلی داده‌ها نمی‌خواند).');
    let snap: db.StoreSnapshot;
    try {
      snap = db.validateSnapshot(JSON.parse(raw.toString('utf-8')));
    } catch (err) {
      throw new BackupError((err as Error)?.message && /[\u0600-\u06FF]/.test((err as Error).message) ? (err as Error).message : 'داده‌های فایل پشتیبان خوانا نیست.');
    }
    return { zip, prefix, manifest, snap };
  } catch (err) {
    await zip.close();
    throw err;
  }
}

function countAdmins(snap: db.StoreSnapshot): number {
  const envAdmins = new Set(adminEmails());
  return snap.users.filter((u: any) => !u.disabled && (u.platformAdmin === true || envAdmins.has(String(u.email).toLowerCase()))).length;
}

function aiKeysOf(snap: db.StoreSnapshot): Array<{ id: string; keyEnc: string }> {
  const keys = (snap.platform as any)?.ai?.keys;
  return Array.isArray(keys) ? keys.filter((k: any) => k && typeof k.id === 'string' && typeof k.keyEnc === 'string') : [];
}

function summarize(opened: OpenedBackup, fileName: string, bytes: number): BackupSummary {
  const { zip, prefix, manifest, snap } = opened;
  const names = new Set(zip.entries.map((e) => e.name));
  let files = 0;
  let missing = 0;
  for (const r of snap.resumes) {
    if (!r.filePath) continue;
    const key = db.resumeFileKey(r.filePath);
    if (key && names.has(prefix + key)) files++;
    else missing++;
  }
  const keys = aiKeysOf(snap);
  return {
    fileName,
    bytes,
    createdAtISO: String(manifest.createdAtISO || ''),
    createdAtJalali: String(manifest.createdAtJalali || ''),
    createdBy: String(manifest.createdBy || '').slice(0, 200),
    appVersion: String(manifest.appVersion || '—').slice(0, 40),
    counts: {
      orgs: snap.orgs.length,
      demoOrgs: snap.orgs.filter((o) => o.isDemo).length,
      users: snap.users.length,
      jobs: snap.jobs.length,
      resumes: snap.resumes.length,
      files,
      missingFiles: missing,
    },
    admins: countAdmins(snap),
    aiKeys: { total: keys.length, readable: keys.filter((k) => decryptSecret(k.keyEnc) !== null).length },
  };
}

// ================================================================ uploads ====

type UploadState = 'uploading' | 'ready' | 'applying' | 'done' | 'failed';

interface Upload {
  id: string;
  userId: string;
  fileName: string;
  file: string;
  size: number;
  received: number;
  createdAt: number;
  state: UploadState;
  summary: BackupSummary | null;
  progress: { done: number; total: number };
  result: RestoreResult | null;
  error: string | null;
}

const uploads = new Map<string, Upload>();
const RESTORE_DIR = path.join(os.tmpdir(), 'hovida-restore');
let applying = false;

function sweepUploads() {
  const now = Date.now();
  for (const u of uploads.values()) {
    if (u.state !== 'applying' && now - u.createdAt > UPLOAD_TTL_MS) {
      fs.promises.rm(u.file, { force: true }).catch(() => {});
      uploads.delete(u.id);
    }
  }
}
setInterval(sweepUploads, 10 * 60_000).unref();

function own(id: string, userId: string): Upload {
  const u = uploads.get(id);
  if (!u || u.userId !== userId) throw new BackupError('این بارگذاری پیدا نشد یا منقضی شده است؛ فایل را دوباره انتخاب کنید.', 404);
  return u;
}

export async function startUpload(userId: string, fileName: string, size: number) {
  sweepUploads();
  if (!Number.isFinite(size) || size < 22) throw new BackupError('فایل انتخاب‌شده خالی یا ناقص است.');
  if (size > MAX_BACKUP_BYTES) throw new BackupError('فایل پشتیبان بزرگ‌تر از ۴ گیگابایت است.');
  if (!/\.zip$/i.test(fileName)) throw new BackupError('فایل پشتیبان باید با پسوند ‎.zip باشد.');
  if (Array.from(uploads.values()).filter((u) => u.state === 'uploading' || u.state === 'ready').length >= 3) {
    throw new BackupError('چند بارگذاری نیمه‌کاره باز است؛ کمی بعد دوباره تلاش کنید.', 429);
  }
  await fs.promises.mkdir(RESTORE_DIR, { recursive: true, mode: 0o700 });
  try {
    const fsStat = await fs.promises.statfs(RESTORE_DIR);
    const free = Number(fsStat.bavail) * Number(fsStat.bsize);
    if (Number.isFinite(free) && free < size + 64 * 1024 * 1024) {
      throw new BackupError('فضای موقت این سرور برای این فایل پشتیبان کافی نیست.', 507);
    }
  } catch (err) {
    if (err instanceof BackupError) throw err;
  }
  const id = crypto.randomBytes(16).toString('hex');
  const file = path.join(RESTORE_DIR, `${id}.zip`);
  await fs.promises.writeFile(file, Buffer.alloc(0), { mode: 0o600 });
  const upload: Upload = {
    id,
    userId,
    fileName: fileName.slice(0, 200),
    file,
    size,
    received: 0,
    createdAt: Date.now(),
    state: 'uploading',
    summary: null,
    progress: { done: 0, total: 0 },
    result: null,
    error: null,
  };
  uploads.set(id, upload);
  return { id, chunkBytes: RESTORE_CHUNK_BYTES };
}

/** Appends one piece. Re-sending a piece that already arrived is harmless (retries). */
export async function appendChunk(id: string, userId: string, offset: number, data: Buffer): Promise<number> {
  const u = own(id, userId);
  if (u.state !== 'uploading') throw new BackupError('بارگذاری این فایل تمام شده است.', 409);
  if (!Number.isInteger(offset) || offset < 0) throw new BackupError('بخش نامعتبر.', 400);
  if (offset + data.length <= u.received) return u.received; // duplicate of a piece we have
  if (offset !== u.received) throw new BackupError('ترتیب بخش‌های فایل به هم خورد؛ دوباره تلاش کنید.', 409);
  if (u.received + data.length > u.size) throw new BackupError('حجم فایل با اندازه اعلام‌شده نمی‌خواند.', 400);
  await fs.promises.appendFile(u.file, data);
  u.received += data.length;
  if (u.received === u.size) u.state = 'ready';
  return u.received;
}

export async function inspectUpload(id: string, userId: string): Promise<BackupSummary> {
  const u = own(id, userId);
  if (u.state === 'uploading') throw new BackupError('فایل هنوز کامل بارگذاری نشده است.', 409);
  if (u.summary) return u.summary;
  const opened = await openBackup(u.file);
  try {
    u.summary = summarize(opened, u.fileName, u.size);
    return u.summary;
  } finally {
    await opened.zip.close();
  }
}

export function cancelUpload(id: string, userId: string) {
  const u = own(id, userId);
  if (u.state === 'applying') throw new BackupError('بازیابی در حال انجام است و نمی‌توان آن را لغو کرد.', 409);
  fs.promises.rm(u.file, { force: true }).catch(() => {});
  uploads.delete(id);
}

/** Progress of an apply; looked up by its unguessable id (sessions end with the restore). */
export function restoreStatus(id: string) {
  const u = uploads.get(id);
  if (!u || (u.state !== 'applying' && u.state !== 'done' && u.state !== 'failed')) return null;
  return { state: u.state, progress: u.progress, result: u.result, error: u.error };
}

// ================================================================ applying ====

/** Restored keys first (re-enter the unreadable ones), then this server's own keys. */
function mergeAiKeys(snap: db.StoreSnapshot): RestoreResult['aiKeys'] {
  const restored = aiKeysOf(snap);
  const unreadable = restored.filter((k) => decryptSecret(k.keyEnc) === null).length;
  if (!unreadable) return { restored: restored.length, unreadable: 0, keptFromThisServer: 0 };
  const current = ((db.getPlatformBlob() as any)?.ai?.keys || []).filter(
    (k: any) => k && typeof k.keyEnc === 'string' && decryptSecret(k.keyEnc) !== null && !restored.some((r) => r.id === k.id)
  );
  const room = Math.max(0, MAX_AI_KEYS - restored.length);
  const kept = current.slice(0, room);
  if (kept.length) {
    const platform = { ...(snap.platform as any) };
    platform.ai = { ...(platform.ai || {}), keys: [...(platform.ai?.keys || []), ...kept] };
    snap.platform = platform;
  }
  return { restored: restored.length, unreadable, keptFromThisServer: kept.length };
}

async function keepSafetyCopy() {
  const st = storage();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await st.put(`backups/pre-restore/${stamp}.json`, db.currentSnapshotJson());
  const copies = (await st.list('backups/pre-restore/').catch(() => [])).map((x) => x.key).sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - PRE_RESTORE_KEEP))) await st.delete(old).catch(() => {});
}

async function runApply(u: Upload, onDone: (result: RestoreResult) => void) {
  let opened: OpenedBackup | null = null;
  try {
    opened = await openBackup(u.file);
    const { zip, prefix, snap } = opened;
    const summary = summarize(opened, u.fileName, u.size);
    await keepSafetyCopy();
    const st = storage();
    const withFiles = snap.resumes.filter((r) => r.filePath);
    u.progress = { done: 0, total: withFiles.length };
    let restored = 0;
    let missing = 0;
    for (const r of withFiles) {
      const key = db.resumeFileKey(r.filePath);
      const entry = key ? zip.find(prefix + key) : undefined;
      if (!key || !entry) {
        r.filePath = null;
        r.fileSize = null;
        missing++;
      } else {
        const data = await zip.read(entry, MAX_FILE_BYTES);
        await st.put(key, data);
        restored++;
      }
      u.progress = { done: u.progress.done + 1, total: withFiles.length };
    }
    const aiKeys = mergeAiKeys(snap);
    db.replaceAllData(snap);
    const saved = await db.flushSave(120_000);
    initPlatform();
    const result: RestoreResult = { counts: summary.counts, filesRestored: restored, filesMissing: missing, aiKeys, admins: summary.admins, saved };
    u.result = result;
    u.state = 'done';
    onDone(result);
  } catch (err) {
    u.state = 'failed';
    u.error =
      err instanceof BackupError
        ? err.message
        : err instanceof ZipFormatError
          ? 'فایل پشتیبان آسیب دیده است و بازیابی متوقف شد؛ داده‌های فعلی دست نخورده است.'
          : 'بازیابی به خطا خورد و متوقف شد؛ داده‌های فعلی دست نخورده است. دوباره تلاش کنید.';
    console.error('[backup] restore failed:', err);
  } finally {
    await opened?.zip.close();
    fs.promises.rm(u.file, { force: true }).catch(() => {});
    applying = false;
  }
}

/** Starts applying an inspected upload; progress via restoreStatus(id). */
export function applyUpload(id: string, userId: string, onDone: (result: RestoreResult) => void) {
  const u = own(id, userId);
  if (!u.summary) throw new BackupError('اول فایل را بررسی کنید.', 409);
  if (u.state !== 'ready') throw new BackupError('این فایل قبلاً بازیابی شده یا در حال بازیابی است.', 409);
  if (applying) throw new BackupError('یک بازیابی دیگر در حال انجام است.', 409);
  applying = true;
  u.state = 'applying';
  void runApply(u, onDone);
  return { state: u.state };
}

/** Tests only. */
export function _uploadsForTests() {
  return uploads;
}

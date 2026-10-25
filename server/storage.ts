/**
 * Where HOVIDA keeps its data — the store snapshot, original resume files and
 * the app secret.
 *
 *  - fs (default): files under DATA_DIR (a Render disk, a Docker volume, …).
 *  - remote: an HTTP object store at STORAGE_URL. On Cloudflare the container
 *    calls http://storage.hovida and the Worker's outbound handler maps those
 *    requests onto Cloudflare D1 (cloudflare/d1-storage-handler.ts). The same
 *    small protocol is served by scripts/mock-storage-server.mjs for local runs.
 *
 * Keys are relative POSIX paths: `hovida-store.json`, `.app-secret`,
 * `resumes/<org>/<job>/<id>.<ext>`, `backups/…`.
 *
 * Remote protocol (v1):
 *   GET|HEAD /v1/o/<key>        200 (+ ETag, X-Hovida-Md5) | 404
 *   PUT      /v1/o/<key>        If-Match / If-None-Match: * → 200 {etag} | 412
 *   DELETE   /v1/o/<key>        204
 *   POST     /v1/delete-prefix  {prefix} → {deleted}
 *   GET      /v1/list?prefix=&cursor=  → {objects:[{key,size}], cursor}
 *   GET      /v1/usage?prefix=  → {bytes, objects}
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';

export type StorageDriver = 'fs' | 'remote';

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');

export interface StoredObject {
  body: Buffer;
  /** Remote stores only: the version tag used for conditional writes. */
  etag: string | null;
}

export interface PutOptions {
  /** Write only if the stored object still has this etag (remote). */
  ifMatch?: string | null;
  /** Write only if no object exists under the key yet. */
  ifNoneMatch?: '*';
}

export interface GetOptions {
  /** Keep retrying on network errors for about this long (start-up reads). */
  patienceMs?: number;
}

/** A conditional write lost: someone else changed (or created) the object first. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`storage precondition failed for ${key}`);
    this.name = 'PreconditionFailedError';
  }
}

export class StorageError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
  }
}

export interface Storage {
  readonly driver: StorageDriver;
  /** Human-readable location for /admin. */
  readonly location: string;
  init(): Promise<void>;
  get(key: string, opts?: GetOptions): Promise<StoredObject | null>;
  put(key: string, body: Buffer | string, opts?: PutOptions): Promise<{ etag: string | null }>;
  delete(key: string): Promise<void>;
  /** Removes every object whose key starts with `prefix` (which ends with '/'). */
  deletePrefix(prefix: string): Promise<number>;
  head(key: string): Promise<{ size: number; etag: string | null } | null>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
  usage(prefix: string): Promise<{ bytes: number; objects: number }>;
  openStream(key: string): Promise<{ stream: Readable; size: number } | null>;
}

/** Relative POSIX path without empty, `.` or `..` segments. */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 600) return false;
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A key prefix: like a key, but it must end with '/'. */
export function isSafePrefix(prefix: string): boolean {
  return typeof prefix === 'string' && prefix.endsWith('/') && isSafeKey(prefix.slice(0, -1));
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// ===================================================================== fs ====

export class FsStorage implements Storage {
  readonly driver = 'fs' as const;
  private tmpCounter = 0;
  constructor(readonly root: string) {}

  get location(): string {
    return this.root;
  }

  private pathOf(key: string): string {
    if (!isSafeKey(key)) throw new StorageError(`unsafe storage key: ${key}`);
    const base = path.resolve(this.root);
    const full = path.resolve(base, ...key.split('/'));
    if (!full.startsWith(base + path.sep)) throw new StorageError(`unsafe storage key: ${key}`);
    return full;
  }

  private tmpOf(full: string): string {
    this.tmpCounter = (this.tmpCounter + 1) % 1_000_000;
    return `${full}.${process.pid}.${this.tmpCounter}.tmp`;
  }

  async init() {
    await fs.promises.mkdir(path.join(this.root, 'resumes'), { recursive: true });
    // Temp files left by a crash mid-save (the real files are renamed atomically).
    for (const f of await fs.promises.readdir(this.root).catch(() => [] as string[])) {
      if (f.endsWith('.tmp') && /\.\d+\.\d+\.tmp$/.test(f)) await fs.promises.unlink(path.join(this.root, f)).catch(() => {});
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    try {
      return { body: await fs.promises.readFile(this.pathOf(key)), etag: null };
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'EISDIR' || err?.code === 'ENOTDIR') return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer | string, opts: PutOptions = {}): Promise<{ etag: string | null }> {
    const full = this.pathOf(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    const mode = path.basename(full).startsWith('.') ? 0o600 : undefined;
    if (opts.ifNoneMatch === '*') {
      try {
        await fs.promises.writeFile(full, body, { flag: 'wx', mode });
      } catch (err: any) {
        if (err?.code === 'EEXIST') throw new PreconditionFailedError(key);
        throw err;
      }
      return { etag: null };
    }
    // Own temp file per write + atomic rename: two quick writes can never
    // interleave into one corrupt file.
    const tmp = this.tmpOf(full);
    try {
      await fs.promises.writeFile(tmp, body, { mode });
      await fs.promises.rename(tmp, full);
    } catch (err) {
      fs.promises.unlink(tmp).catch(() => {});
      throw err;
    }
    return { etag: null };
  }

  /** Synchronous atomic write — only for the last flush in an exiting process. */
  putSync(key: string, body: Buffer | string) {
    const full = this.pathOf(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = this.tmpOf(full);
    try {
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, full);
    } catch (err) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw err;
    }
  }

  async delete(key: string) {
    await fs.promises.unlink(this.pathOf(key)).catch(() => {});
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!isSafePrefix(prefix)) throw new StorageError(`unsafe storage prefix: ${prefix}`);
    const items = await this.list(prefix);
    await fs.promises.rm(this.pathOf(prefix.slice(0, -1)), { recursive: true, force: true }).catch(() => {});
    return items.length;
  }

  async head(key: string) {
    try {
      const st = await fs.promises.stat(this.pathOf(key));
      return st.isFile() ? { size: st.size, etag: null } : null;
    } catch {
      return null;
    }
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
    if (prefix !== '' && !isSafePrefix(prefix)) throw new StorageError(`unsafe storage prefix: ${prefix}`);
    const out: Array<{ key: string; size: number }> = [];
    const walk = async (dir: string, rel: string) => {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const key = rel + e.name;
        if (e.isDirectory()) await walk(full, key + '/');
        else if (e.isFile() && !e.name.endsWith('.tmp')) out.push({ key, size: (await fs.promises.stat(full).catch(() => null))?.size || 0 });
      }
    };
    await walk(prefix ? this.pathOf(prefix.slice(0, -1)) : path.resolve(this.root), prefix);
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async usage(prefix: string) {
    const items = await this.list(prefix);
    return { bytes: items.reduce((s, x) => s + x.size, 0), objects: items.length };
  }

  async openStream(key: string) {
    const url = this.objUrl(key);
    const first = await this.readWindow(key, url, 0, 8_000, 10 * 60_000);
    if (first.status === 404) return null;
    const size = first.status === 206 ? first.total : first.buf.length;
    const etag = first.etag;
    const self = this;
    async function* pieces() {
      yield first.buf;
      if (first.status !== 206) return;
      const starts: number[] = [];
      for (let p = first.buf.length; p < size; p += READ_BYTES) starts.push(p);
      for (let i = 0; i < starts.length; i += READ_PARALLEL) {
        const group = await Promise.all(starts.slice(i, i + READ_PARALLEL).map((p) => self.readWindow(key, url, p, 8_000, 10 * 60_000)));
        for (const w of group) {
          if (w.status === 404) throw new StorageError(`storage GET ${key}: the object was deleted while it was being read`, 404);
          if (w.etag !== etag) throw new StorageError(`storage GET ${key}: the object changed while it was being read`, 409);
          yield w.buf;
        }
      }
    }
    return { stream: Readable.from(pieces()), size };
  }
}

// ============================================================== singleton ====

let instance: Storage | null = null;

/** The configured driver (STORAGE_DRIVER=fs|remote, STORAGE_URL, STORAGE_TOKEN). */
export function storage(): Storage {
  if (instance) return instance;
  const driver = (process.env.STORAGE_DRIVER || 'fs').trim().toLowerCase();
  if (driver === 'remote') {
    const url = (process.env.STORAGE_URL || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('STORAGE_DRIVER=remote needs STORAGE_URL (for example http://storage.hovida).');
    instance = new RemoteStorage(url, process.env.STORAGE_TOKEN?.trim() || null);
  } else {
    if (driver !== 'fs') console.warn(`[storage] unknown STORAGE_DRIVER "${driver}" — using the local disk.`);
    instance = new FsStorage(DATA_DIR);
  }
  return instance;
}

/** Tests only: swap the driver. */
export function setStorageForTests(next: Storage | null) {
  instance = next;
}

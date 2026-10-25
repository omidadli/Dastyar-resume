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
    const full = this.pathOf(key);
    const st = await fs.promises.stat(full).catch(() => null);
    if (!st || !st.isFile()) return null;
    return { stream: fs.createReadStream(full), size: st.size };
  }
}

// ================================================================= remote ====

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
/** Objects above INLINE_MAX are uploaded in PART_BYTES pieces and read with Range requests of the same size. */
const INLINE_MAX = 1_000_000;
const PART_BYTES = 8_000_000;

export class RemoteStorage implements Storage {
  readonly driver = 'remote' as const;
  private base: string;
  constructor(
    baseUrl: string,
    private token: string | null = null
  ) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  get location(): string {
    return process.env.HOVIDA_PLATFORM === 'cloudflare' ? 'Cloudflare D1' : this.base;
  }

  async init() {
    /* nothing to prepare */
  }

  private objUrl(key: string): string {
    if (!isSafeKey(key)) throw new StorageError(`unsafe storage key: ${key}`);
    return `${this.base}/v1/o/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...(this.token ? { 'x-hovida-storage-token': this.token } : {}), ...extra };
  }

  /**
   * Idempotent request with retries: network errors, 429 and 5xx are retried with backoff.
   */
  private async call(url: string, init: RequestInit & { timeoutMs?: number }, patienceMs = 8_000): Promise<Response> {
    const started = Date.now();
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      let failure: unknown = null;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
      } catch (err) {
        failure = err;
      }
      if (res && !RETRYABLE.has(res.status)) return res;
      const waited = Date.now() - started;
      if (waited >= patienceMs) {
        if (res) return res;
        throw new StorageError(`storage unreachable (${init.method || 'GET'} ${url}): ${(failure as any)?.message || failure}`);
      }
      if (res) await res.body?.cancel().catch(() => {});
      await sleep(Math.min(5_000, 300 * 2 ** attempt, Math.max(50, patienceMs - waited)));
    }
  }

  async get(key: string, opts: GetOptions = {}): Promise<StoredObject | null> {
    const url = this.objUrl(key);
    const parts: Buffer[] = [];
    let etag: string | null = null;
    let pos = 0;
    for (let n = 0; ; n++) {
      const res = await this.call(url, { method: 'GET', headers: this.headers({ range: `bytes=${pos}-${pos + PART_BYTES - 1}` }) }, opts.patienceMs ?? 8_000);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        if (n === 0) return null;
        throw new StorageError(`storage GET ${key}: the object was deleted while it was being read`, 404);
      }
      if (!res.ok) throw new StorageError(`storage GET ${key} → ${res.status}`, res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      const tag = res.headers.get('etag');
      if (n === 0) etag = tag;
      else if (tag !== etag) throw new StorageError(`storage GET ${key}: the object changed while it was being read`, 409);
      parts.push(buf);
      if (res.status !== 206) break;
      pos += buf.length;
      const total = Number(res.headers.get('x-hovida-size') || 0);
      if (!buf.length || pos >= total) break;
    }
    return { body: parts.length === 1 ? parts[0] : Buffer.concat(parts), etag };
  }

  private async headRaw(key: string): Promise<{ size: number; etag: string | null; md5: string | null } | null> {
    const res = await this.call(this.objUrl(key), { method: 'HEAD', headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError(`storage HEAD ${key} → ${res.status}`, res.status);
    return {
      size: Number(res.headers.get('x-hovida-size') || res.headers.get('content-length') || 0),
      etag: res.headers.get('etag'),
      md5: res.headers.get('x-hovida-md5'),
    };
  }

  async head(key: string) {
    const h = await this.headRaw(key);
    return h ? { size: h.size, etag: h.etag } : null;
  }

  async put(key: string, body: Buffer | string, opts: PutOptions = {}): Promise<{ etag: string | null }> {
    const buf = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (buf.length > INLINE_MAX) return this.putMultipart(key, buf, md5, opts);
    const headers = this.headers({ 'content-type': 'application/octet-stream', 'x-hovida-md5': md5 });
    if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    else if (opts.ifNoneMatch === '*') headers['if-none-match'] = '*';
    const url = this.objUrl(key);
    // Did an earlier attempt whose answer got lost actually land?
    const landed = async () => {
      const h = await this.headRaw(key).catch(() => null);
      return h && h.md5 && h.md5 === md5 ? { etag: h.etag } : null;
    };
    let ambiguous = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'PUT', body: buf, headers, signal: AbortSignal.timeout(120_000) });
      } catch (err) {
        ambiguous = true;
        if (attempt >= 5) throw new StorageError(`storage PUT ${key} failed: ${(err as any)?.message || err}`);
        await sleep(Math.min(5_000, 400 * 2 ** attempt));
        const done = await landed();
        if (done) return done;
        continue;
      }
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { etag?: string };
        return { etag: data.etag ?? res.headers.get('etag') };
      }
      await res.body?.cancel().catch(() => {});
      if (res.status === 412) {
        if (ambiguous) {
          const done = await landed();
          if (done) return done;
        }
        throw new PreconditionFailedError(key);
      }
      if (RETRYABLE.has(res.status) && attempt < 5) {
        await sleep(Math.min(5_000, (res.status === 429 ? 1_100 : 400) * 2 ** attempt));
        continue;
      }
      throw new StorageError(`storage PUT ${key} → ${res.status}`, res.status);
    }
  }

  /** Large object: upload it in parts (each its own request), then publish it with one "complete" call. */
  private async putMultipart(key: string, buf: Buffer, md5: string, opts: PutOptions): Promise<{ etag: string | null }> {
    const id = crypto.randomBytes(16).toString('hex');
    const base = this.objUrl(key);
    const parts = Math.ceil(buf.length / PART_BYTES);
    for (let n = 0; n < parts; n++) {
      const slice = buf.subarray(n * PART_BYTES, Math.min(buf.length, (n + 1) * PART_BYTES));
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(`${base}?upload=${id}&part=${n}`, {
            method: 'PUT',
            body: slice,
            headers: this.headers({ 'content-type': 'application/octet-stream' }),
            signal: AbortSignal.timeout(120_000),
          });
        } catch (err) {
          if (attempt >= 5) throw new StorageError(`storage PUT ${key} (part ${n + 1}/${parts}) failed: ${(err as any)?.message || err}`);
          await sleep(Math.min(5_000, 400 * 2 ** attempt));
          continue;
        }
        await res.body?.cancel().catch(() => {});
        if (res.ok) break;
        if (RETRYABLE.has(res.status) && attempt < 5) {
          await sleep(Math.min(5_000, (res.status === 429 ? 1_100 : 400) * 2 ** attempt));
          continue;
        }
        throw new StorageError(`storage PUT ${key} (part ${n + 1}/${parts}) → ${res.status}`, res.status);
      }
    }
    const headers = this.headers({ 'content-type': 'application/json' });
    if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
    else if (opts.ifNoneMatch === '*') headers['if-none-match'] = '*';
    const landed = async () => {
      const h = await this.headRaw(key).catch(() => null);
      return h && h.etag === id ? { etag: h.etag } : null;
    };
    let ambiguous = false;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${base}?upload=${id}&complete=1`, { method: 'POST', headers, body: JSON.stringify({ size: buf.length, md5 }), signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        ambiguous = true;
        if (attempt >= 5) throw new StorageError(`storage PUT ${key} failed to complete: ${(err as any)?.message || err}`);
        await sleep(Math.min(5_000, 400 * 2 ** attempt));
        const done = await landed();
        if (done) return done;
        continue;
      }
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { etag?: string };
        return { etag: data.etag ?? res.headers.get('etag') };
      }
      await res.body?.cancel().catch(() => {});
      if (res.status === 412) {
        if (ambiguous) {
          const done = await landed();
          if (done) return done;
        }
        throw new PreconditionFailedError(key);
      }
      if (RETRYABLE.has(res.status) && attempt < 5) {
        ambiguous = true;
        await sleep(Math.min(5_000, (res.status === 429 ? 1_100 : 400) * 2 ** attempt));
        continue;
      }
      throw new StorageError(`storage PUT ${key} (complete) → ${res.status}`, res.status);
    }
  }

  async delete(key: string) {
    const res = await this.call(this.objUrl(key), { method: 'DELETE', headers: this.headers() });
    await res.body?.cancel().catch(() => {});
    if (!res.ok && res.status !== 404) throw new StorageError(`storage DELETE ${key} → ${res.status}`, res.status);
  }

  async deletePrefix(prefix: string): Promise<number> {
    if (!isSafePrefix(prefix)) throw new StorageError(`unsafe storage prefix: ${prefix}`);
    const res = await this.call(`${this.base}/v1/delete-prefix`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ prefix }),
    });
    if (!res.ok) throw new StorageError(`storage delete-prefix ${prefix} → ${res.status}`, res.status);
    const data = (await res.json().catch(() => ({}))) as { deleted?: number };
    return Number(data.deleted) || 0;
  }

  async list(prefix: string): Promise<Array<{ key: string; size: number }>> {
    if (prefix !== '' && !isSafePrefix(prefix)) throw new StorageError(`unsafe storage prefix: ${prefix}`);
    const out: Array<{ key: string; size: number }> = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ prefix });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.call(`${this.base}/v1/list?${qs}`, { method: 'GET', headers: this.headers() });
      if (!res.ok) throw new StorageError(`storage list ${prefix} → ${res.status}`, res.status);
      const data = (await res.json()) as { objects?: Array<{ key: string; size: number }>; cursor?: string | null };
      for (const o of data.objects || []) if (typeof o?.key === 'string') out.push({ key: o.key, size: Number(o.size) || 0 });
      cursor = data.cursor || null;
    } while (cursor);
    return out;
  }

  async usage(prefix: string) {
    const res = await this.call(`${this.base}/v1/usage?${new URLSearchParams({ prefix })}`, { method: 'GET', headers: this.headers() });
    if (!res.ok) throw new StorageError(`storage usage → ${res.status}`, res.status);
    const data = (await res.json()) as { bytes?: number; objects?: number };
    return { bytes: Number(data.bytes) || 0, objects: Number(data.objects) || 0 };
  }

  async openStream(key: string) {
    const url = this.objUrl(key);
    const first = await this.call(url, { method: 'GET', headers: this.headers({ range: `bytes=0-${PART_BYTES - 1}` }), timeoutMs: 10 * 60_000 });
    if (first.status === 404) {
      await first.body?.cancel().catch(() => {});
      return null;
    }
    if (!first.ok || !first.body) throw new StorageError(`storage GET ${key} → ${first.status}`, first.status);
    const size = Number(first.headers.get('x-hovida-size') || first.headers.get('content-length') || 0);
    const etag = first.headers.get('etag');
    const self = this;
    async function* pieces() {
      let res = first;
      let pos = 0;
      for (;;) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) return;
        yield buf;
        pos += buf.length;
        if (res.status !== 206 || pos >= size) return;
        res = await self.call(url, { method: 'GET', headers: self.headers({ range: `bytes=${pos}-${pos + PART_BYTES - 1}` }), timeoutMs: 10 * 60_000 });
        if (!res.ok) throw new StorageError(`storage GET ${key} → ${res.status}`, res.status);
        if (res.headers.get('etag') !== etag) throw new StorageError(`storage GET ${key}: the object changed while it was being read`, 409);
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

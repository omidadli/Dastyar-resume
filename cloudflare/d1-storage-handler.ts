/**
 * D1 implementation of HOVIDA's remote object-storage protocol.
 *
 * Small objects (<= 1 MB) live in one row of storage_objects. Larger ones (up to
 * MAX_OBJECT) are written as 1 MB chunks in storage_chunks through several small
 * requests (so every Worker invocation stays inside the free-plan limits):
 *
 *   PUT  /v1/o/<key>?upload=<id>&part=<n>     one part (<= 8 MB = 8 chunks)
 *   POST /v1/o/<key>?upload=<id>&complete=1   {size, md5}: publish the object (honours If-Match / If-None-Match)
 *   GET  /v1/o/<key>  with  Range: bytes=a-b  answers at most 2 MB per request (206: the client continues)
 */
export interface D1StorageHandlerOptions { prefix: string }
const DEFAULT_OPTIONS: D1StorageHandlerOptions = { prefix: 'data/' };

const CHUNK = 1_000_000;
const PART = 8_000_000;
const CHUNKS_PER_PART = PART / CHUNK;
const INLINE_MAX = 1_000_000;
/** One read answers at most this much (the client loops): keeps each free-plan invocation small. */
const READ_MAX = 2_000_000;
const MAX_OBJECT = 100_000_000;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 600 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
function safePrefix(prefix: string) { return prefix === '' || (prefix.endsWith('/') && isSafeKey(prefix.slice(0, -1))); }
async function sha256(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
/** D1 hands BLOBs back as ArrayBuffer or as number[] depending on the runtime: accept both. */
function bytes(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}
type Row = { object_key: string; body: unknown; size_bytes: number; etag: string; md5: string | null; updated_at: string; chunk_version: string | null };

interface Commit { body: ArrayBuffer; size: number; etag: string; md5: string | null; chunkVersion: string | null }

/** Write the object row, honouring If-Match / If-None-Match atomically. Returns false on a failed precondition. */
async function commitRow(db: D1Database, objectKey: string, c: Commit, ifMatch: string | null, ifNoneMatch: string | null): Promise<boolean> {
  const now = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  let result: D1Result;
  if (ifMatch) {
    const expected = ifMatch.split(',').map((v) => v.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
    if (expected.includes('*')) {
      result = await db.prepare(`UPDATE storage_objects SET body=?, size_bytes=?, etag=?, md5=?, chunk_version=?, updated_at=${now} WHERE object_key=?`)
        .bind(c.body, c.size, c.etag, c.md5, c.chunkVersion, objectKey).run();
    } else {
      result = await db.prepare(`UPDATE storage_objects SET body=?, size_bytes=?, etag=?, md5=?, chunk_version=?, updated_at=${now} WHERE object_key=? AND etag IN (${expected.map(() => '?').join(',')})`)
        .bind(c.body, c.size, c.etag, c.md5, c.chunkVersion, objectKey, ...expected).run();
    }
    return !!result.meta.changes;
  }
  if (ifNoneMatch?.trim() === '*') {
    result = await db.prepare(`INSERT OR IGNORE INTO storage_objects (object_key, body, size_bytes, etag, md5, chunk_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${now})`)
      .bind(objectKey, c.body, c.size, c.etag, c.md5, c.chunkVersion).run();
    return !!result.meta.changes;
  }
  await db.prepare(`INSERT INTO storage_objects (object_key, body, size_bytes, etag, md5, chunk_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ${now})
    ON CONFLICT(object_key) DO UPDATE SET body=excluded.body, size_bytes=excluded.size_bytes, etag=excluded.etag, md5=excluded.md5, chunk_version=excluded.chunk_version, updated_at=excluded.updated_at`)
    .bind(objectKey, c.body, c.size, c.etag, c.md5, c.chunkVersion).run();
  return true;
}

/** Remove the chunks of an object except those of `keepVersion` (null: remove them all). */
function dropOtherChunks(db: D1Database, objectKey: string, keepVersion: string | null) {
  return db.prepare('DELETE FROM storage_chunks WHERE object_key = ? AND version IS NOT ?').bind(objectKey, keepVersion).run();
}

export async function handleD1StorageRequest(request: Request, db: D1Database, options: D1StorageHandlerOptions = DEFAULT_OPTIONS): Promise<Response> {
  const root = options.prefix;
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path.startsWith('/v1/o/')) {
      let key: string;
      try { key = path.slice('/v1/o/'.length).split('/').map(decodeURIComponent).join('/'); }
      catch { return json({ error: 'bad key' }, 400); }
      if (!isSafeKey(key)) return json({ error: 'bad key' }, 400);
      const objectKey = root + key;
      const upload = url.searchParams.get('upload');

      // ---- multipart upload of a large object --------------------------------
      if (upload !== null) {
        if (!/^[0-9a-f]{16,64}$/.test(upload)) return json({ error: 'bad upload id' }, 400);
        if (request.method === 'PUT') {
          const n = Number(url.searchParams.get('part'));
          if (!Number.isInteger(n) || n < 0 || n >= MAX_OBJECT / PART) return json({ error: 'bad part' }, 400);
          const data = await request.arrayBuffer();
          if (!data.byteLength) return json({ error: 'empty part' }, 400);
          if (data.byteLength > PART) return json({ error: `part too large (maximum ${PART} bytes)` }, 413);
          const stmts: D1PreparedStatement[] = [];
          for (let i = 0; i * CHUNK < data.byteLength; i++) {
            stmts.push(db.prepare('INSERT OR REPLACE INTO storage_chunks (object_key, version, idx, body) VALUES (?, ?, ?, ?)')
              .bind(objectKey, upload, n * CHUNKS_PER_PART + i, data.slice(i * CHUNK, Math.min(data.byteLength, (i + 1) * CHUNK))));
          }
          for (let i = 0; i < stmts.length; i += 4) await db.batch(stmts.slice(i, i + 4));
          return json({ ok: true, bytes: data.byteLength });
        }
        if (request.method === 'POST' && url.searchParams.get('complete')) {
          const meta = await request.json().catch(() => ({})) as { size?: number; md5?: string };
          const size = Number(meta.size);
          if (!Number.isInteger(size) || size < 1 || size > MAX_OBJECT) return json({ error: 'bad size' }, 400);
          const want = Math.ceil(size / CHUNK);
          const have = await db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(body)),0) AS b FROM storage_chunks WHERE object_key = ? AND version = ?')
            .bind(objectKey, upload).first<{ c: number; b: number }>();
          if (!have || have.c !== want || have.b !== size) return json({ error: 'missing parts', have: have?.c ?? 0, want }, 409);
          const ok = await commitRow(db, objectKey,
            { body: new ArrayBuffer(0), size, etag: upload, md5: typeof meta.md5 === 'string' ? meta.md5 : null, chunkVersion: upload },
            request.headers.get('if-match'), request.headers.get('if-none-match'));
          if (!ok) {
            await db.prepare('DELETE FROM storage_chunks WHERE object_key = ? AND version = ?').bind(objectKey, upload).run();
            return json({ error: 'precondition failed' }, 412);
          }
          await dropOtherChunks(db, objectKey, upload);
          return json({ etag: upload, size }, 200, { etag: upload });
        }
        return json({ error: 'method not allowed' }, 405);
      }

      // ---- read ----------------------------------------------------------------
      if (request.method === 'GET' || request.method === 'HEAD') {
        const row = await db.prepare('SELECT object_key, body, size_bytes, etag, md5, updated_at, chunk_version FROM storage_objects WHERE object_key = ?').bind(objectKey).first<Row>();
        if (!row) return json({ error: 'not found' }, 404);
        const total = row.size_bytes;
        const headers = new Headers({ etag: row.etag, 'x-hovida-size': String(total), 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' });
        if (row.md5) headers.set('x-hovida-md5', row.md5);
        if (request.method === 'HEAD') { headers.set('content-length', String(total)); return new Response(null, { headers }); }
        if (total === 0) return new Response(new Uint8Array(0), { headers });
        let start = 0;
        let end = total - 1;
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
          if (!m) return json({ error: 'bad range' }, 416);
          start = Number(m[1]);
          end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
          if (start >= total || start > end) { headers.set('content-range', `bytes */${total}`); return new Response(null, { status: 416, headers }); }
        } else if (total > READ_MAX) {
          return json({ error: `object is large: read it with Range requests (at most ${READ_MAX} bytes each)` }, 413);
        }
        if (end - start + 1 > READ_MAX) end = start + READ_MAX - 1;
        let out: Uint8Array;
        if (row.chunk_version) {
          const first = Math.floor(start / CHUNK);
          const last = Math.floor(end / CHUNK);
          const rows = await db.prepare('SELECT idx, body FROM storage_chunks WHERE object_key = ? AND version = ? AND idx BETWEEN ? AND ? ORDER BY idx')
            .bind(objectKey, row.chunk_version, first, last).all<{ idx: number; body: unknown }>();
          if (rows.results.length !== last - first + 1) return json({ error: 'object is incomplete' }, 500);
          out = new Uint8Array(end - start + 1);
          for (const r of rows.results) {
            const b = bytes(r.body);
            const from = r.idx * CHUNK;
            const s = Math.max(start, from);
            const e = Math.min(end + 1, from + b.length);
            if (e > s) out.set(b.subarray(s - from, e - from), s - start);
          }
        } else {
          out = bytes(row.body).slice(start, end + 1);
        }
        headers.set('content-length', String(out.byteLength));
        if (rangeHeader) { headers.set('content-range', `bytes ${start}-${end}/${total}`); return new Response(out, { status: 206, headers }); }
        return new Response(out, { headers });
      }

      // ---- small object write -------------------------------------------------
      if (request.method === 'PUT') {
        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (declaredLength > INLINE_MAX) return json({ error: `object too large for a single request (maximum ${INLINE_MAX} bytes): use a multipart upload` }, 413);
        const body = await request.arrayBuffer();
        if (body.byteLength > INLINE_MAX) return json({ error: `object too large for a single request (maximum ${INLINE_MAX} bytes): use a multipart upload` }, 413);
        const etag = await sha256(body);
        const md5 = request.headers.get('x-hovida-md5');
        const ok = await commitRow(db, objectKey, { body, size: body.byteLength, etag, md5, chunkVersion: null },
          request.headers.get('if-match'), request.headers.get('if-none-match'));
        if (!ok) return json({ error: 'precondition failed' }, 412);
        await dropOtherChunks(db, objectKey, null);
        return json({ etag, size: body.byteLength }, 200, { etag });
      }
      if (request.method === 'DELETE') {
        await db.batch([
          db.prepare('DELETE FROM storage_chunks WHERE object_key = ?').bind(objectKey),
          db.prepare('DELETE FROM storage_objects WHERE object_key = ?').bind(objectKey),
        ]);
        return new Response(null, { status: 204 });
      }
      return json({ error: 'method not allowed' }, 405);
    }
    if (path === '/v1/delete-prefix' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({})) as { prefix?: string };
      const prefix = payload.prefix;
      if (typeof prefix !== 'string' || !prefix || !safePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      const fullPrefix = root + prefix;
      const [, result] = await db.batch([
        db.prepare('DELETE FROM storage_chunks WHERE substr(object_key, 1, length(?)) = ?').bind(fullPrefix, fullPrefix),
        db.prepare('DELETE FROM storage_objects WHERE substr(object_key, 1, length(?)) = ?').bind(fullPrefix, fullPrefix),
      ]);
      return json({ deleted: result.meta.changes || 0 });
    }
    if (path === '/v1/list' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      if (!safePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      const cursor = url.searchParams.get('cursor') || '';
      const fullPrefix = root + prefix;
      const rows = await db.prepare('SELECT object_key, size_bytes FROM storage_objects WHERE substr(object_key, 1, length(?)) = ? AND object_key > ? ORDER BY object_key LIMIT 1000')
        .bind(fullPrefix, fullPrefix, cursor).all<{ object_key: string; size_bytes: number }>();
      const objects = rows.results.map((r) => ({ key: r.object_key.slice(root.length), size: r.size_bytes }));
      return json({ objects, cursor: rows.results.length === 1000 ? rows.results[rows.results.length - 1].object_key : null });
    }
    if (path === '/v1/usage' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      if (!safePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      const fullPrefix = root + prefix;
      const row = await db.prepare('SELECT COALESCE(SUM(size_bytes),0) AS bytes, COUNT(*) AS objects FROM storage_objects WHERE substr(object_key, 1, length(?)) = ?')
        .bind(fullPrefix, fullPrefix).first<{ bytes: number; objects: number }>();
      return json({ bytes: row?.bytes || 0, objects: row?.objects || 0 });
    }
    return json({ error: 'unknown endpoint' }, 404);
  } catch (err) {
    const message = String((err as Error)?.message || err);
    console.error('[d1-storage]', request.method, path, message);
    return json({ error: message }, /too large|limit|size/i.test(message) ? 413 : 500);
  }
}

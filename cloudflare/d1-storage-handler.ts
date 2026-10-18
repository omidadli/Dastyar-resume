/**
 * D1 implementation of HOVIDA's remote object-storage protocol.
 * This intentionally stores all objects (including resume files) in D1; no R2 binding.
 * Keep uploads within Cloudflare D1's per-value/query limits and load-test before production.
 */
export interface D1StorageHandlerOptions { prefix: string }
const DEFAULT_OPTIONS: D1StorageHandlerOptions = { prefix: 'data/' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 600 || key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
function safePrefix(prefix: string) { return prefix === '' || (prefix.endsWith('/') && isSafeKey(prefix.slice(0, -1))); }
function etagMatches(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(',').some((v) => v.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1') === etag || v.trim() === '*');
}
async function digest(buf: ArrayBuffer): Promise<{ etag: string; md5: string }> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const etag = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  // MD5 is optional compatibility metadata; SHA-256 is used for ETag.
  return { etag, md5: '' };
}
type Row = { object_key: string; body: ArrayBuffer; size_bytes: number; etag: string; md5: string | null; updated_at: string };

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
      if (request.method === 'GET' || request.method === 'HEAD') {
        const row = await db.prepare('SELECT object_key, body, size_bytes, etag, md5, updated_at FROM storage_objects WHERE object_key = ?').bind(objectKey).first<Row>();
        if (!row) return json({ error: 'not found' }, 404);
        const headers = new Headers({ etag: row.etag, 'x-hovida-size': String(row.size_bytes), 'content-length': String(row.size_bytes), 'content-type': 'application/octet-stream' });
        if (row.md5) headers.set('x-hovida-md5', row.md5);
        return request.method === 'HEAD' ? new Response(null, { headers }) : new Response(row.body, { headers });
      }
      if (request.method === 'PUT') {
        const declaredLength = Number(request.headers.get('content-length') || 0);
        if (declaredLength > 1_000_000) return json({ error: 'object too large for D1 preview (maximum 1000000 bytes)' }, 413);
        const body = await request.arrayBuffer();
        // Preserve the MD5 supplied by RemoteStorage: it is used to recognize
        // successful-but-ambiguous retries after a network timeout.
        const { etag } = await digest(body);
        const ifMatch = request.headers.get('if-match');
        const ifNoneMatch = request.headers.get('if-none-match');
        const md5 = request.headers.get('x-hovida-md5');
        // D1 values and query payloads have strict size ceilings. Keep a conservative
        // ceiling below the per-value limit; larger resumes need another storage backend.
        if (body.byteLength > 1_000_000) return json({ error: 'object too large for D1 preview (maximum 1000000 bytes)' }, 413);
        let result: D1Result;
        if (ifMatch) {
          // Atomic compare-and-swap; avoid a read-then-write race between concurrent requests.
          const expected = ifMatch.split(',').map((v) => v.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'));
          if (expected.includes('*')) {
            result = await db.prepare(`UPDATE storage_objects SET body=?, size_bytes=?, etag=?, md5=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE object_key=?`)
              .bind(body, body.byteLength, etag, md5, objectKey).run();
          } else {
            result = await db.prepare(`UPDATE storage_objects SET body=?, size_bytes=?, etag=?, md5=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE object_key=? AND etag IN (${expected.map(() => '?').join(',')})`)
              .bind(body, body.byteLength, etag, md5, objectKey, ...expected).run();
          }
          if (!result.meta.changes) return json({ error: 'precondition failed' }, 412);
        } else if (ifNoneMatch?.trim() === '*') {
          result = await db.prepare(`INSERT OR IGNORE INTO storage_objects (object_key, body, size_bytes, etag, md5, updated_at)
            VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .bind(objectKey, body, body.byteLength, etag, md5).run();
          if (!result.meta.changes) return json({ error: 'precondition failed' }, 412);
        } else {
          await db.prepare(`INSERT INTO storage_objects (object_key, body, size_bytes, etag, md5, updated_at)
            VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            ON CONFLICT(object_key) DO UPDATE SET body=excluded.body, size_bytes=excluded.size_bytes, etag=excluded.etag, md5=excluded.md5, updated_at=excluded.updated_at`)
            .bind(objectKey, body, body.byteLength, etag, md5).run();
        }
        return json({ etag, size: body.byteLength }, 200, { etag });
      }
      if (request.method === 'DELETE') {
        await db.prepare('DELETE FROM storage_objects WHERE object_key = ?').bind(objectKey).run();
        return new Response(null, { status: 204 });
      }
      return json({ error: 'method not allowed' }, 405);
    }
    if (path === '/v1/delete-prefix' && request.method === 'POST') {
      const payload = await request.json().catch(() => ({})) as { prefix?: string };
      const prefix = payload.prefix;
      if (typeof prefix !== 'string' || !prefix || !safePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      const fullPrefix = root + prefix;
      const result = await db.prepare('DELETE FROM storage_objects WHERE substr(object_key, 1, length(?)) = ?').bind(fullPrefix, fullPrefix).run();
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

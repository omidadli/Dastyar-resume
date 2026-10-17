/**
 * HOVIDA's storage protocol (server/storage.ts → RemoteStorage) served from
 * an R2 bucket.
 *
 * On Cloudflare this runs as the container's outbound handler for
 * http://storage.hovida: the Node server in the container makes plain HTTP
 * calls, this code answers them inside the Workers runtime with the R2
 * binding. The container never holds R2 credentials, and nothing outside the
 * container can reach these endpoints.
 *
 *   GET|HEAD /v1/o/<key>        200 (+ ETag, X-Hovida-Md5, X-Hovida-Size) | 404
 *   PUT      /v1/o/<key>        If-Match / If-None-Match: * → 200 {etag} | 412
 *   DELETE   /v1/o/<key>        204
 *   POST     /v1/delete-prefix  {prefix} → {deleted}
 *   GET      /v1/list?prefix=&cursor=  → {objects:[{key,size}], cursor}
 *   GET      /v1/usage?prefix=  → {bytes, objects}
 *
 * Every key lives under `prefix` (default "data/") inside the bucket, next to
 * the daily copies under "backups/" (see daily-backup.ts).
 */

export interface StorageHandlerOptions {
  /** Folder of the bucket that holds HOVIDA's data. */
  prefix: string;
}

const DEFAULT_OPTIONS: StorageHandlerOptions = { prefix: 'data/' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** Same rule as the server: relative POSIX path, no empty / "." / ".." segments. */
export function isSafeKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 600) return false;
  if (key.startsWith('/') || key.includes('\\') || key.includes('\0')) return false;
  return key.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function isSafePrefix(prefix: string): boolean {
  return prefix === '' || (prefix.endsWith('/') && isSafeKey(prefix.slice(0, -1)));
}

const stripTag = (v: string) =>
  v
    .trim()
    .replace(/^W\//, '')
    .replace(/^"(.*)"$/, '$1');

function hex(buf: ArrayBuffer | undefined | null): string | null {
  if (!buf || !buf.byteLength) return null;
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function objectHeaders(obj: R2Object): Headers {
  const h = new Headers({
    'content-type': 'application/octet-stream',
    etag: obj.etag,
    'x-hovida-size': String(obj.size),
  });
  const md5 = hex(obj.checksums?.md5) || obj.customMetadata?.md5;
  if (md5) h.set('x-hovida-md5', md5);
  return h;
}

async function listAll(bucket: R2Bucket, prefix: string, each: (objects: R2Object[]) => Promise<void> | void) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    await each(page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function handleStorageRequest(request: Request, bucket: R2Bucket, options: StorageHandlerOptions = DEFAULT_OPTIONS): Promise<Response> {
  const root = options.prefix;
  const url = new URL(request.url);
  const path = url.pathname;
  try {
    if (path.startsWith('/v1/o/')) {
      let key: string;
      try {
        key = path.slice('/v1/o/'.length).split('/').map(decodeURIComponent).join('/');
      } catch {
        return json({ error: 'bad key' }, 400);
      }
      if (!isSafeKey(key)) return json({ error: 'bad key' }, 400);
      const objectKey = root + key;

      if (request.method === 'GET') {
        const obj = await bucket.get(objectKey);
        if (!obj) return json({ error: 'not found' }, 404);
        const headers = objectHeaders(obj);
        headers.set('content-length', String(obj.size));
        return new Response(obj.body, { headers });
      }
      if (request.method === 'HEAD') {
        const obj = await bucket.head(objectKey);
        if (!obj) return new Response(null, { status: 404 });
        return new Response(null, { headers: objectHeaders(obj) });
      }
      if (request.method === 'PUT') {
        const md5 = request.headers.get('x-hovida-md5') || undefined;
        const ifMatch = request.headers.get('if-match');
        const ifNoneMatch = request.headers.get('if-none-match');
        const onlyIf: R2Conditional | Headers | undefined = ifMatch
          ? { etagMatches: stripTag(ifMatch) }
          : ifNoneMatch?.trim() === '*'
            ? new Headers({ 'if-none-match': '*' })
            : undefined;
        // A body of known length streams straight into R2 (the snapshot can be
        // larger than a Worker's memory); otherwise it is buffered first.
        const body: ReadableStream | ArrayBuffer =
          request.body && request.headers.get('content-length') ? request.body : await request.arrayBuffer();
        const put = await bucket.put(objectKey, body, {
          onlyIf,
          md5,
          customMetadata: md5 ? { md5 } : undefined,
          httpMetadata: { contentType: 'application/octet-stream' },
        });
        if (put === null) return json({ error: 'precondition failed' }, 412);
        return json({ etag: put.etag, size: put.size }, 200, { etag: put.etag });
      }
      if (request.method === 'DELETE') {
        await bucket.delete(objectKey);
        return new Response(null, { status: 204 });
      }
      return json({ error: 'method not allowed' }, 405);
    }

    if (path === '/v1/delete-prefix' && request.method === 'POST') {
      const { prefix } = (await request.json().catch(() => ({}))) as { prefix?: string };
      if (typeof prefix !== 'string' || !prefix || !isSafePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      let deleted = 0;
      // Re-list from the start after every batch: deleting while paging with a cursor can skip keys.
      for (;;) {
        const page = await bucket.list({ prefix: root + prefix, limit: 1000 });
        if (!page.objects.length) break;
        await bucket.delete(page.objects.map((o) => o.key));
        deleted += page.objects.length;
      }
      return json({ deleted });
    }

    if (path === '/v1/list' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      if (!isSafePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      const page = await bucket.list({ prefix: root + prefix, cursor: url.searchParams.get('cursor') || undefined, limit: 1000 });
      return json({
        objects: page.objects.map((o) => ({ key: o.key.slice(root.length), size: o.size })),
        cursor: page.truncated ? page.cursor : null,
      });
    }

    if (path === '/v1/usage' && request.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      if (!isSafePrefix(prefix)) return json({ error: 'bad prefix' }, 400);
      let bytes = 0;
      let objects = 0;
      await listAll(bucket, root + prefix, (page) => {
        for (const o of page) {
          bytes += o.size;
          objects++;
        }
      });
      return json({ bytes, objects });
    }

    return json({ error: 'unknown endpoint' }, 404);
  } catch (err) {
    const message = String((err as Error)?.message || err);
    console.error('[storage]', request.method, path, message);
    // R2 accepts one write per key per second: tell the client to back off and retry.
    if (/10058|rate|too many/i.test(message)) return json({ error: message }, 429);
    return json({ error: message }, 500);
  }
}

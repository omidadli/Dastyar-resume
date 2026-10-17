#!/usr/bin/env node
/**
 * Local stand-in for the remote storage protocol (server/storage.ts) — the
 * same API the Cloudflare Worker serves from R2 (cloudflare/storage-handler.ts).
 * Lets you run HOVIDA exactly as on Cloudflare, without Cloudflare:
 *
 *   node scripts/mock-storage-server.mjs --port 8790 [--dir /tmp/hv-objects]
 *   STORAGE_DRIVER=remote STORAGE_URL=http://127.0.0.1:8790 npm run dev
 *
 * Like R2: strong consistency, ETag = MD5 of the content, conditional PUT
 * (If-Match / If-None-Match: *), and — with --r2-rate — at most one write per
 * key per second (429 otherwise). Test hooks: POST /__fault {"next":"drop-after-write"|"drop-before-write"|"status:503"}.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const PORT = Number(arg('port', process.env.PORT || 8790));
const DIR = arg('dir', '');
const R2_RATE = args.includes('--r2-rate');
const TOKEN = arg('token', process.env.STORAGE_TOKEN || '');

/** key -> { body: Buffer, etag: string, uploaded: number } */
const objects = new Map();
const lastWrite = new Map();
let fault = null;

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

if (DIR) {
  fs.mkdirSync(DIR, { recursive: true });
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, rel + e.name + '/');
      else {
        const body = fs.readFileSync(full);
        objects.set(rel + e.name, { body, etag: md5(body), uploaded: Date.now() });
      }
    }
  };
  walk(DIR, '');
}

function persist(key, body) {
  if (!DIR) return;
  const full = path.join(DIR, ...key.split('/'));
  if (body === null) return fs.rmSync(full, { force: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function safeKey(key) {
  return typeof key === 'string' && key && !key.startsWith('/') && !key.includes('\\') && key.split('/').every((s) => s && s !== '.' && s !== '..');
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-length': Buffer.byteLength(payload), ...(Buffer.isBuffer(body) ? {} : { 'content-type': 'application/json' }), ...headers });
  res.end(payload);
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const stripTag = (v) => String(v || '').trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://storage');
    if (url.pathname === '/__fault' && req.method === 'POST') {
      fault = JSON.parse((await readBody(req)).toString() || '{}').next || null;
      return send(res, 200, { ok: true, fault });
    }
    if (url.pathname === '/__stats') return send(res, 200, { objects: objects.size, keys: [...objects.keys()].sort() });
    if (TOKEN && req.headers['x-hovida-storage-token'] !== TOKEN) return send(res, 401, { error: 'bad token' });

    if (url.pathname.startsWith('/v1/o/')) {
      const key = url.pathname.slice('/v1/o/'.length).split('/').map(decodeURIComponent).join('/');
      if (!safeKey(key)) return send(res, 400, { error: 'bad key' });
      const obj = objects.get(key);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!obj) return send(res, 404, req.method === 'HEAD' ? null : { error: 'not found' });
        const headers = { etag: obj.etag, 'x-hovida-md5': md5(obj.body), 'x-hovida-size': obj.body.length, 'content-type': 'application/octet-stream', 'content-length': obj.body.length };
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : obj.body);
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (fault === 'drop-before-write') {
          fault = null;
          return req.socket.destroy();
        }
        if (fault?.startsWith('status:')) {
          const code = Number(fault.slice(7));
          fault = null;
          return send(res, code, { error: 'injected' });
        }
        const declared = req.headers['x-hovida-md5'];
        if (declared && declared !== md5(body)) return send(res, 400, { error: 'md5 mismatch' });
        if (R2_RATE && Date.now() - (lastWrite.get(key) || 0) < 1000) return send(res, 429, { error: 'Reduce your rate of writes to the same object' });
        const ifMatch = req.headers['if-match'];
        const ifNoneMatch = req.headers['if-none-match'];
        if (ifMatch && (!obj || stripTag(ifMatch) !== obj.etag)) return send(res, 412, { error: 'precondition failed' });
        if (ifNoneMatch === '*' && obj) return send(res, 412, { error: 'precondition failed' });
        const next = { body, etag: md5(body), uploaded: Date.now() };
        objects.set(key, next);
        lastWrite.set(key, Date.now());
        persist(key, body);
        if (fault === 'drop-after-write') {
          fault = null;
          return req.socket.destroy();
        }
        return send(res, 200, { etag: next.etag, size: body.length }, { etag: next.etag });
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        persist(key, null);
        res.writeHead(204);
        return res.end();
      }
      return send(res, 405, { error: 'method' });
    }
    if (url.pathname === '/v1/delete-prefix' && req.method === 'POST') {
      const { prefix } = JSON.parse((await readBody(req)).toString() || '{}');
      if (typeof prefix !== 'string' || !prefix.endsWith('/') || !safeKey(prefix.slice(0, -1))) return send(res, 400, { error: 'bad prefix' });
      let deleted = 0;
      for (const k of [...objects.keys()]) {
        if (k.startsWith(prefix)) {
          objects.delete(k);
          persist(k, null);
          deleted++;
        }
      }
      return send(res, 200, { deleted });
    }
    if (url.pathname === '/v1/list' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      const start = Number(url.searchParams.get('cursor') || 0);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      // Small pages on purpose, so clients exercise the cursor.
      const page = keys.slice(start, start + 50);
      const cursor = start + 50 < keys.length ? String(start + 50) : null;
      return send(res, 200, { objects: page.map((k) => ({ key: k, size: objects.get(k).body.length })), cursor });
    }
    if (url.pathname === '/v1/usage' && req.method === 'GET') {
      const prefix = url.searchParams.get('prefix') || '';
      let bytes = 0;
      let count = 0;
      for (const [k, v] of objects) if (k.startsWith(prefix)) (bytes += v.body.length), count++;
      return send(res, 200, { bytes, objects: count });
    }
    return send(res, 404, { error: 'unknown endpoint' });
  } catch (err) {
    send(res, 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-storage] listening on http://127.0.0.1:${PORT}${DIR ? ` (dir ${DIR})` : ''}${R2_RATE ? ' (R2 write rate)' : ''}`));

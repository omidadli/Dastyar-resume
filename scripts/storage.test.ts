/**
 * Storage drivers (server/storage.ts) and the store on a remote object store:
 *  - the disk driver: atomic writes, create-only writes, listing, prefixes, traversal guard
 *  - the remote driver against scripts/mock-storage-server.mjs (R2 semantics):
 *    conditional writes, R2's one-write-per-second limit, lost answers, retries, paging
 *  - the store in remote mode (child processes): data survives a restart, the
 *    app secret is shared, a second instance can never overwrite newer data,
 *    and an unreachable store stops the start-up instead of starting empty
 * Run with: npx tsx scripts/storage.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { FsStorage, PreconditionFailedError, RemoteStorage, StorageError, isSafeKey, isSafePrefix } from '../server/storage';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
async function rejects(fn: () => Promise<unknown>, check: (e: unknown) => boolean): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return check(e);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function startMock(port: number, extra: string[] = []): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.resolve('scripts/mock-storage-server.mjs'), '--port', String(port), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock storage did not start')), 10_000);
    child.stdout!.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  return child;
}

async function fault(base: string, next: string) {
  await fetch(`${base}/__fault`, { method: 'POST', body: JSON.stringify({ next }) });
}

/** Runs a module snippet in a fresh process (own store singleton) and returns its last JSON line. */
function probe(code: string, env: Record<string, string>): any {
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop();
  return line ? JSON.parse(line) : null;
}

const DB = JSON.stringify(path.resolve('server/db.ts'));
const SECRET = JSON.stringify(path.resolve('server/secret.ts'));

async function main() {
  // ------------------------------------------------------------ helpers ----
  assert(isSafeKey('resumes/org_1/job_2/res_3.pdf') && isSafeKey('.app-secret'), 'normal keys are safe');
  assert(!isSafeKey('../etc/passwd') && !isSafeKey('/abs') && !isSafeKey('a//b') && !isSafeKey('a/./b') && !isSafeKey('a\\b') && !isSafeKey(''), 'traversal, absolute, empty and backslash keys are refused');
  assert(isSafePrefix('resumes/org_1/') && !isSafePrefix('resumes/org_1') && !isSafePrefix('../'), 'prefixes must be safe and end with a slash');

  // ----------------------------------------------------------- disk driver ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hovida-storage-'));
  const disk = new FsStorage(dir);
  await disk.init();
  await disk.put('hovida-store.json', '{"a":1}');
  assert((await disk.get('hovida-store.json'))?.body.toString() === '{"a":1}', 'disk: write then read');
  await disk.put('hovida-store.json', '{"a":2}');
  assert((await disk.get('hovida-store.json'))?.body.toString() === '{"a":2}', 'disk: overwrite is atomic and visible');
  assert(fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), 'disk: no temp files are left behind');
  assert((await disk.get('missing.json')) === null, 'disk: a missing key reads as null');
  await disk.put('.app-secret', 'abc', { ifNoneMatch: '*' });
  assert(await rejects(() => disk.put('.app-secret', 'xyz', { ifNoneMatch: '*' }), (e) => e instanceof PreconditionFailedError), 'disk: create-only write refuses an existing key');
  assert((fs.statSync(path.join(dir, '.app-secret')).mode & 0o777) === 0o600, 'disk: dot-files (the app secret) are private (0600)');
  await disk.put('resumes/o1/j1/r1.pdf', Buffer.from('PDF-1'));
  await disk.put('resumes/o1/j1/r2.pdf', Buffer.from('PDF-22'));
  await disk.put('resumes/o1/j2/r3.pdf', Buffer.from('PDF-333'));
  await disk.put('resumes/o2/j9/r4.pdf', Buffer.from('X'));
  const listed = await disk.list('resumes/o1/');
  assert(listed.map((x) => x.key).join(',') === 'resumes/o1/j1/r1.pdf,resumes/o1/j1/r2.pdf,resumes/o1/j2/r3.pdf', 'disk: list by prefix, sorted');
  assert((await disk.usage('resumes/')).bytes === 5 + 6 + 7 + 1, 'disk: usage sums the sizes');
  const head = await disk.head('resumes/o1/j1/r2.pdf');
  assert(head?.size === 6, 'disk: head gives the size');
  const s = await disk.openStream('resumes/o1/j2/r3.pdf');
  const chunks: Buffer[] = [];
  for await (const c of s!.stream) chunks.push(c as Buffer);
  assert(Buffer.concat(chunks).toString() === 'PDF-333' && s!.size === 7, 'disk: stream a file');
  assert((await disk.deletePrefix('resumes/o1/j1/')) === 2 && (await disk.list('resumes/o1/')).length === 1, 'disk: delete a whole job folder');
  await disk.delete('resumes/o2/j9/r4.pdf');
  assert((await disk.head('resumes/o2/j9/r4.pdf')) === null, 'disk: delete a file');
  assert(await rejects(() => disk.get('../outside.txt'), (e) => e instanceof StorageError), 'disk: traversal keys throw');
  fs.writeFileSync(path.join(dir, 'hovida-store.json.123.4.tmp'), 'half');
  await new FsStorage(dir).init();
  assert(!fs.existsSync(path.join(dir, 'hovida-store.json.123.4.tmp')), 'disk: start-up removes temp files of a crashed save');
  fs.rmSync(dir, { recursive: true, force: true });

  // --------------------------------------------------------- remote driver ----
  const port = await freePort();
  const mock = await startMock(port, ['--r2-rate']);
  const base = `http://127.0.0.1:${port}`;
  try {
    const remote = new RemoteStorage(base);
    const w1 = await remote.put('hovida-store.json', '{"v":1}', { ifNoneMatch: '*' });
    assert(Boolean(w1.etag), 'remote: create-only write returns an etag');
    assert(
      await rejects(() => remote.put('hovida-store.json', '{"v":"x"}', { ifNoneMatch: '*' }), (e) => e instanceof PreconditionFailedError),
      'remote: create-only write refuses an existing key (412)'
    );
    const r1 = await remote.get('hovida-store.json');
    assert(r1?.body.toString() === '{"v":1}' && r1.etag === w1.etag, 'remote: read returns the body and the same etag');
    // R2 allows one write per key per second: a second quick write gets 429 and is retried until it fits.
    await remote.put('rate/probe.json', '1');
    const t0 = Date.now();
    await remote.put('rate/probe.json', '2');
    const took = Date.now() - t0;
    assert((await remote.get('rate/probe.json'))?.body.toString() === '2' && took >= 900, 'remote: a 429 (one write per key per second) is waited out and retried', `${took}ms`);
    const w2 = await remote.put('hovida-store.json', '{"v":2}', { ifMatch: w1.etag });
    assert(Boolean(w2.etag) && w2.etag !== w1.etag, 'remote: conditional write with the current etag succeeds');
    assert(
      await rejects(() => remote.put('hovida-store.json', '{"v":"stale"}', { ifMatch: w1.etag }), (e) => e instanceof PreconditionFailedError),
      'remote: a write based on an old version is refused — no lost update'
    );
    assert((await remote.get('hovida-store.json'))?.body.toString() === '{"v":2}', 'remote: the newer data is still there');

    // The answer of a successful write gets lost: the client checks what landed.
    await sleep(1100);
    await fault(base, 'drop-after-write');
    const w3 = await remote.put('hovida-store.json', '{"v":3}', { ifMatch: w2.etag });
    const r3 = await remote.get('hovida-store.json');
    assert(r3?.body.toString() === '{"v":3}' && w3.etag === r3.etag, 'remote: a write whose answer was lost is recognised as done (not as a conflict)');
    // The connection breaks before the write: retried.
    await sleep(1100);
    await fault(base, 'drop-before-write');
    const w4 = await remote.put('hovida-store.json', '{"v":4}', { ifMatch: w3.etag });
    assert((await remote.get('hovida-store.json'))?.body.toString() === '{"v":4}' && Boolean(w4.etag), 'remote: a write that never arrived is retried');
    await sleep(1100);
    await fault(base, 'status:503');
    await remote.put('hovida-store.json', '{"v":5}', { ifMatch: w4.etag });
    assert((await remote.get('hovida-store.json'))?.body.toString() === '{"v":5}', 'remote: a 503 from the store is retried');

    for (let i = 0; i < 60; i++) await remote.put(`resumes/org_a/job_${i % 3}/res_${String(i).padStart(2, '0')}.pdf`, Buffer.alloc(10 + i));
    const all = await remote.list('resumes/org_a/');
    assert(all.length === 60, 'remote: listing follows the cursor across pages', String(all.length));
    const usage = await remote.usage('resumes/');
    assert(usage.objects === 60 && usage.bytes === all.reduce((x, o) => x + o.size, 0), 'remote: usage');
    assert((await remote.head('resumes/org_a/job_1/res_01.pdf'))?.size === 11, 'remote: head gives the size');
    const st = await remote.openStream('resumes/org_a/job_2/res_02.pdf');
    let n = 0;
    for await (const c of st!.stream) n += (c as Buffer).length;
    assert(n === 12, 'remote: stream a file');
    assert((await remote.deletePrefix('resumes/org_a/job_0/')) === 20 && (await remote.list('resumes/org_a/')).length === 40, 'remote: delete a whole job folder');
    await remote.delete('resumes/org_a/job_1/res_01.pdf');
    assert((await remote.get('resumes/org_a/job_1/res_01.pdf')) === null, 'remote: delete a file');
    assert((await remote.openStream('nope/none.pdf')) === null, 'remote: streaming a missing file gives null');
    assert(await rejects(() => remote.get('a/../b'), (e) => e instanceof StorageError), 'remote: traversal keys never leave the process');

    // ----------------------------------------------- the store, remote mode ----
    const env = { STORAGE_DRIVER: 'remote', STORAGE_URL: base, STORAGE_PATIENCE_MS: '1500', DATA_DIR: path.join(os.tmpdir(), 'hovida-unused-' + process.pid) };
    delete process.env.APP_SECRET;
    // Start empty (a new bucket), create a workspace, stop.
    await remote.delete('hovida-store.json');
    const first = probe(
      `const db = await import(${DB}); const sec = await import(${SECRET});
       await db.initStore(); await sec.initAppSecret();
       const org = db.createOrg({ name: 'سازمان ابری', ownerEmail: 'cloud@hovida.ir' });
       db.createUser({ orgId: org.id, name: 'مدیر', email: 'cloud@hovida.ir', passwordHash: 'x', role: 'owner' });
       const ok = await db.flushSave(10000);
       console.log(JSON.stringify({ ok, secret: sec.appSecret().toString('hex'), status: db.storeStatus() }));`,
      env
    );
    assert(first?.ok === true && first.status.driver === 'remote', 'store (remote): a fresh bucket starts empty and saves', JSON.stringify(first?.status));
    // A restart (new container, empty disk) finds everything again.
    const second = probe(
      `const db = await import(${DB}); const sec = await import(${SECRET});
       await db.initStore(); await sec.initAppSecret();
       const u = db.findUserByEmail('cloud@hovida.ir');
       console.log(JSON.stringify({ org: u ? db.getOrg(u.orgId)?.name : null, secret: sec.appSecret().toString('hex') }));`,
      env
    );
    assert(second?.org === 'سازمان ابری', 'store (remote): data survives a restart with a wiped disk');
    assert(Boolean(first?.secret) && second?.secret === first.secret, 'store (remote): the app secret is kept in the bucket and shared across restarts');

    // Another instance saved newer data meanwhile: this one must stop, not overwrite.
    const fenced = probe(
      `const db = await import(${DB});
       await db.initStore();
       let fencedHit = false; db.onStoreFenced(() => { fencedHit = true; });
       // someone else writes a newer snapshot
       const cur = await fetch(${JSON.stringify(base)} + '/v1/o/hovida-store.json').then((r) => r.json());
       cur.orgs[0].name = 'نوشته نمونه دیگر';
       await new Promise((r) => setTimeout(r, 1100));
       await fetch(${JSON.stringify(base)} + '/v1/o/hovida-store.json', { method: 'PUT', body: JSON.stringify(cur) });
       const u = db.findUserByEmail('cloud@hovida.ir');
       db.updateOrg(u.orgId, { name: 'تغییر کهنه' });
       const ok = await db.flushSave(8000);
       db.updateOrg(u.orgId, { name: 'تغییر بعدی' });
       await new Promise((r) => setTimeout(r, 1500));
       console.log(JSON.stringify({ ok, fencedHit, status: db.storeStatus() }));`,
      env
    );
    const after = JSON.parse((await remote.get('hovida-store.json'))!.body.toString());
    assert(fenced?.fencedHit === true && fenced.ok === false && fenced.status.fenced === true, 'store (remote): a conditional save that loses stops this instance (fenced)');
    assert(after.orgs[0].name === 'نوشته نمونه دیگر', 'store (remote): the newer data written by the other instance is kept', after.orgs[0].name);

    // Unreachable store at start-up: fail, never start empty.
    const unreachable = probe(
      `const db = await import(${DB});
       try { await db.initStore(); console.log(JSON.stringify({ started: true })); }
       catch (e) { console.log(JSON.stringify({ started: false, msg: String(e.message).slice(0, 80) })); }`,
      { ...env, STORAGE_URL: 'http://127.0.0.1:1' }
    );
    assert(unreachable?.started === false, 'store (remote): an unreachable store stops the start-up (never starts empty)', unreachable?.msg);

    // Saves keep R2's pace: many quick changes, one valid snapshot, no 429 errors.
    const burst = probe(
      `const db = await import(${DB});
       await db.initStore();
       const u = db.findUserByEmail('cloud@hovida.ir');
       for (let i = 0; i < 200; i++) { db.updateOrg(u.orgId, { messageSignature: 'امضا ' + i }); if (i % 40 === 0) await new Promise((r) => setTimeout(r, 300)); }
       const ok = await db.flushSave(20000);
       console.log(JSON.stringify({ ok }));`,
      env
    );
    const burstState = JSON.parse((await remote.get('hovida-store.json'))!.body.toString());
    assert(burst?.ok === true && burstState.orgs[0].messageSignature === 'امضا 199', 'store (remote): a burst of changes ends in one snapshot with the latest state');
  } finally {
    mock.kill();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

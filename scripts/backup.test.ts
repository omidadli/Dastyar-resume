/**
 * Full backup & restore, end to end on the production bundle:
 *  - the ZIP writer/reader (round trip, checksums, damaged archives)
 *  - server A (disk storage): a workspace with jobs, resumes + original files
 *    and an AI key → full backup through the signed download link
 *  - server B (remote storage = R2 semantics, another APP_SECRET): chunked
 *    upload with a retried piece, inspection, confirmation, restore progress,
 *    then: everyone signs in again, the data and files are identical, the AI
 *    key of A is listed as unreadable next to B's own key, the audit log shows
 *    the restore, and everything survives a restart of B
 *  - refusals: non-admins, forged links, broken/foreign/tampered files
 * Run with: npm run build && npx tsx scripts/backup.test.ts
 */
import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { ZipReader, ZipWriter } from '../server/zip';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
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

async function zipToBuffer(entries: Array<[string, Buffer, boolean?]>): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c) => chunks.push(c));
  const zip = new ZipWriter(out);
  for (const [name, data, compress] of entries) await zip.add(name, data, { compress });
  await zip.finish();
  out.end();
  return Buffer.concat(chunks);
}

function tmpFile(buf: Buffer, name = 'f.zip'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-bk-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

interface Server {
  child: ChildProcess;
  base: string;
  log: () => string;
}

async function startServer(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const fullEnv = { ...process.env, NODE_ENV: 'production', PORT: String(port), ...env } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'DISABLE_DEMO', 'LEGACY_OWNER_EMAIL']) delete fullEnv[k];
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'server.cjs')], { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  const t0 = Date.now();
  while (!/آماده است/.test(log) && Date.now() - t0 < 30_000) {
    if (child.exitCode !== null) break;
    await sleep(150);
  }
  if (!/آماده است/.test(log)) throw new Error('server did not start:\n' + log);
  return { child, base: `http://127.0.0.1:${port}`, log: () => log };
}

async function stopServer(s: Server) {
  if (s.child.exitCode !== null) return;
  const done = new Promise((r) => s.child.once('exit', r));
  s.child.kill('SIGTERM');
  await Promise.race([done, sleep(15_000)]);
  if (s.child.exitCode === null) s.child.kill('SIGKILL');
}

function client(base: string) {
  return async (method: string, url: string, token?: string | null, body?: unknown, raw?: Buffer) => {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Hovida-Session': token } : {}),
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    try {
      json = JSON.parse(buf.toString('utf-8'));
    } catch {
      json = null;
    }
    return { status: res.status, json, buf, headers: res.headers };
  };
}

async function main() {
  if (!fs.existsSync(path.join(process.cwd(), 'dist', 'server.cjs'))) throw new Error('Run `npm run build` first.');

  // ---------------------------------------------------------------- zip ----
  const big = Buffer.from('هویدا '.repeat(5000), 'utf-8');
  const bin = crypto.randomBytes(70_000);
  const zbuf = await zipToBuffer([
    ['a.json', big, true],
    ['dir/b.bin', bin],
    ['empty.txt', Buffer.alloc(0)],
  ]);
  const zr = await ZipReader.open(tmpFile(zbuf));
  assert(zr.entries.length === 3, 'zip: three entries');
  assert((await zr.read(zr.find('a.json')!, 10_000_000)).equals(big), 'zip: deflated entry round-trips');
  assert(zr.find('a.json')!.csize < big.length / 5, 'zip: the JSON snapshot is compressed');
  assert((await zr.read(zr.find('dir/b.bin')!, 10_000_000)).equals(bin), 'zip: stored entry round-trips');
  assert((await zr.read(zr.find('empty.txt')!, 10)).length === 0, 'zip: empty entry');
  let tooBig = false;
  try {
    await zr.read(zr.find('dir/b.bin')!, 1000);
  } catch {
    tooBig = true;
  }
  assert(tooBig, 'zip: an entry larger than allowed is refused');
  await zr.close();
  const damaged = Buffer.from(zbuf);
  const at = damaged.indexOf(bin.subarray(100, 120));
  damaged[at + 5] ^= 0xff;
  const dr = await ZipReader.open(tmpFile(damaged));
  let crcCaught = false;
  try {
    await dr.read(dr.find('dir/b.bin')!, 10_000_000);
  } catch (e) {
    crcCaught = /checksum/.test(String(e));
  }
  assert(crcCaught, 'zip: a damaged byte is caught by the checksum');
  await dr.close();

  // ------------------------------------------------------------ servers ----
  const mockPort = await freePort();
  const mock = spawn(process.execPath, [path.resolve('scripts/mock-storage-server.mjs'), '--port', String(mockPort), '--r2-rate'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => mock.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
  const storageUrl = `http://127.0.0.1:${mockPort}`;

  const dataA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-backup-a-'));
  let A = await startServer({ DATA_DIR: dataA, APP_SECRET: 'secret-of-server-A-0123456789', ADMIN_EMAILS: 'boss@example.com' });
  let B: Server | null = null;
  try {
    const a = client(A.base);
    const boss = await a('POST', '/api/auth/signup', null, { orgName: 'شرکت مبدأ', name: 'مدیر مبدأ', email: 'boss@example.com', password: 'Boss123456' });
    const TA = boss.json.token as string;
    assert(boss.status === 201 && boss.json.user.platformAdmin === true, 'A: the ADMIN_EMAILS account is platform admin');
    const tpl = await a('POST', '/api/jobs/template', TA, { departmentId: 'sales', roleTitle: 'کارشناس فروش' });
    const job = await a('POST', '/api/jobs', TA, { departmentId: 'sales', roleTitle: 'کارشناس فروش', understanding: tpl.json.understanding, answers: {}, criteriaSource: 'template' });
    const J = job.json.job.id;
    const txt = 'رزومه رضا کرمی\nکارشناس فروش با ۴ سال سابقه فروش میدانی\nتلفن: ۰۹۱۲۱۲۳۴۵۶۷';
    const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%binary '), crypto.randomBytes(3000), Buffer.from('\n%%EOF\n')]);
    const e1 = await a('POST', `/api/jobs/${J}/evaluate`, TA, { fileName: 'reza.txt', extractedText: txt, fileBase64: Buffer.from(txt).toString('base64') });
    const e2 = await a('POST', `/api/jobs/${J}/evaluate`, TA, { fileName: 'cv.pdf', extractedText: 'سارا محمدی کارشناس فروش ۶ سال سابقه', fileBase64: pdf.toString('base64') });
    assert(e1.status === 200 && e2.status === 200, 'A: two resumes with original files');
    await a('PATCH', `/api/resumes/${e1.json.record.id}`, TA, { action: 'decision', status: 'approved', note: 'دعوت به مصاحبه' });
    const keyA = await a('POST', '/api/admin/ai/keys', TA, { label: 'کلید سرور A', provider: 'openai', apiKey: 'sk-test-server-A-1234567890', baseUrl: 'https://gw.example/v1', model: 'gpt-4o-mini' });
    assert(keyA.status === 201, 'A: an AI key is stored (encrypted with A’s secret)', String(keyA.status));
    const member = await a('POST', '/api/org/members', TA, { name: 'عضو', email: 'member@example.com', password: 'Member12345', role: 'member' });
    const TM = (await a('POST', '/api/auth/login', null, { email: 'member@example.com', password: 'Member12345' })).json.token;
    assert(member.status === 201 && Boolean(TM), 'A: a regular member exists');

    // ---------------------------------------------------- download ----
    assert((await a('GET', '/api/admin/backup', TM)).status === 403, 'a non-admin cannot see the backup page data');
    assert((await a('POST', '/api/admin/backup/link', TM)).status === 403, 'a non-admin cannot get a download link');
    const info = await a('GET', '/api/admin/backup', TA);
    assert(info.status === 200 && info.json.storage.driver === 'fs' && info.json.counts.resumes === 2 && info.json.counts.files === 2 && info.json.lastBackup === null, 'A: backup info (disk, 2 resumes, 2 files, no backup yet)');
    const link = await a('POST', '/api/admin/backup/link', TA);
    assert(link.status === 200 && link.json.url.startsWith('/api/backup/download?'), 'A: a signed download link');
    const forged = await a('GET', link.json.url.replace(/sig=[^&]+/, 'sig=forged'));
    assert(forged.status === 403, 'a forged download link is refused');
    const other = await a('GET', link.json.url.replace(/uid=[^&]+/, `uid=${encodeURIComponent(member.json.member?.id || 'x')}`));
    assert(other.status === 403, 'a link cannot be re-used for another user');
    const dl = await a('GET', link.json.url);
    assert(dl.status === 200 && dl.headers.get('content-type') === 'application/zip' && /hovida-backup-\d{4}-\d{2}-\d{2}\.zip/.test(dl.headers.get('content-disposition') || ''), 'A: the backup downloads as a dated ZIP', dl.headers.get('content-disposition') || '');
    const backupPath = tmpFile(dl.buf, 'hovida-backup.zip');
    const br = await ZipReader.open(backupPath);
    const names = br.entries.map((e) => e.name).sort();
    assert(names.includes('manifest.json') && names.includes('hovida-store.json') && names.includes('README.txt') && names.filter((n) => n.startsWith('resumes/')).length === 2, 'backup: manifest, data, readme and both original files', names.join(', '));
    const manifest = JSON.parse((await br.read(br.find('manifest.json')!, 1e6)).toString());
    const store = JSON.parse((await br.read(br.find('hovida-store.json')!, 1e8)).toString());
    assert(manifest.format === 'hovida-backup' && manifest.counts.resumes === 2 && manifest.counts.files === 2 && manifest.counts.missingFiles === 0, 'backup: manifest counts');
    assert(store.sessions.length === 0 && store.users.every((u: any) => typeof u.passwordHash === 'string'), 'backup: no sign-in sessions; accounts keep their password hashes');
    const pdfEntry = br.entries.find((e) => e.name.endsWith('.pdf'))!;
    assert((await br.read(pdfEntry, 1e8)).equals(pdf), 'backup: the original PDF is byte-identical');
    await br.close();
    await sleep(300);
    const audited = await a('GET', '/api/admin/audit', TA);
    assert(audited.json.items?.[0]?.action === 'backup.download', 'A: the download is in the audit log');
    assert((await a('GET', '/api/admin/backup', TA)).json.lastBackup?.actorName.includes('boss@example.com'), 'A: «last backup» shows who took it');

    // ------------------------------------------------------- restore ----
    B = await startServer({
      STORAGE_DRIVER: 'remote',
      STORAGE_URL: storageUrl,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hv-backup-b-unused-')),
      APP_SECRET: 'secret-of-server-B-9876543210',
      ADMIN_EMAILS: 'admin2@example.com,boss@example.com',
    });
    const b = client(B.base);
    const adm = await b('POST', '/api/auth/signup', null, { orgName: 'سرور تازه', name: 'مدیر تازه', email: 'admin2@example.com', password: 'Admin212345' });
    const TB = adm.json.token as string;
    assert(adm.status === 201 && adm.json.user.platformAdmin === true, 'B (remote storage): a fresh admin');
    assert((await b('GET', '/api/admin/backup', TB)).json.storage.driver === 'remote', 'B: backup info reports the remote store');
    await b('POST', '/api/admin/ai/keys', TB, { label: 'کلید سرور B', provider: 'gemini', apiKey: 'AIza-test-server-B-1234567890' });

    const size = dl.buf.length;
    const start = await b('POST', '/api/admin/restore', TB, { fileName: 'hovida-backup.zip', size });
    assert(start.status === 200 && /^[0-9a-f]{32}$/.test(start.json.id) && start.json.chunkBytes === 8 * 1024 * 1024, 'B: restore upload started');
    const id = start.json.id as string;
    assert((await b('POST', '/api/admin/restore', TB, { fileName: 'notes.txt', size: 100 })).status === 400, 'only .zip files are accepted');
    const cut1 = Math.floor(size / 3);
    const cut2 = Math.floor((2 * size) / 3);
    const p1 = await b('PUT', `/api/admin/restore/${id}/chunk?offset=0`, TB, undefined, dl.buf.subarray(0, cut1));
    const dup = await b('PUT', `/api/admin/restore/${id}/chunk?offset=0`, TB, undefined, dl.buf.subarray(0, cut1));
    assert(p1.json.received === cut1 && dup.json.received === cut1, 'a re-sent piece (retry) is harmless');
    const skip = await b('PUT', `/api/admin/restore/${id}/chunk?offset=${cut2}`, TB, undefined, dl.buf.subarray(cut2));
    assert(skip.status === 409, 'a piece out of order is refused');
    assert((await b('POST', `/api/admin/restore/${id}/inspect`, TB)).status === 409, 'cannot inspect before the upload is complete');
    await b('PUT', `/api/admin/restore/${id}/chunk?offset=${cut1}`, TB, undefined, dl.buf.subarray(cut1, cut2));
    const p3 = await b('PUT', `/api/admin/restore/${id}/chunk?offset=${cut2}`, TB, undefined, dl.buf.subarray(cut2));
    assert(p3.json.received === size, 'B: all pieces arrived');
    const sum = await b('POST', `/api/admin/restore/${id}/inspect`, TB);
    assert(
      sum.status === 200 && sum.json.counts.orgs === 1 && sum.json.counts.users === 2 && sum.json.counts.resumes === 2 && sum.json.counts.files === 2 && sum.json.counts.missingFiles === 0,
      'B: inspection shows what the file holds',
      JSON.stringify(sum.json.counts)
    );
    assert(sum.json.admins === 1 && sum.json.aiKeys.total === 1 && sum.json.aiKeys.readable === 0, 'B: inspection flags the admin and the AI key encrypted with another secret', JSON.stringify({ admins: sum.json.admins, ai: sum.json.aiKeys }));
    assert((await b('POST', `/api/admin/restore/${id}/apply`, TB, { confirm: 'بله' })).status === 400, 'applying needs the exact confirmation word');
    const applied = await b('POST', `/api/admin/restore/${id}/apply`, TB, { confirm: 'بازیابی' });
    assert(applied.status === 200 && applied.json.state === 'applying', 'B: restore started');
    let st: any = null;
    for (let i = 0; i < 120; i++) {
      st = (await b('GET', `/api/restore-status/${id}`)).json;
      if (st?.state === 'done' || st?.state === 'failed') break;
      await sleep(250);
    }
    assert(st?.state === 'done' && st.result.filesRestored === 2 && st.result.filesMissing === 0 && st.result.saved === true, 'B: restore finished (progress followed without a session)', JSON.stringify(st?.result || st));
    assert(st?.result.aiKeys.restored === 1 && st.result.aiKeys.unreadable === 1 && st.result.aiKeys.keptFromThisServer === 1, 'B: A’s key restored (needs re-entry), B’s own key kept', JSON.stringify(st?.result.aiKeys));
    assert((await b('GET', '/api/restore-status/' + 'f'.repeat(32))).status === 404, 'unknown restore id → 404');

    assert((await b('GET', '/api/auth/me', TB)).status === 401, 'B: every session ended — the restoring admin signs in again');
    const relogin = await b('POST', '/api/auth/login', null, { email: 'boss@example.com', password: 'Boss123456' });
    const TB2 = relogin.json.token as string;
    assert(relogin.status === 200 && relogin.json.org.name === 'شرکت مبدأ', 'B: A’s owner signs in with A’s password');
    const jobsB = await b('GET', '/api/jobs', TB2);
    assert(jobsB.json.items?.length === 1 && jobsB.json.items[0].id === J, 'B: the job came over with its id');
    const listB = await b('GET', `/api/resumes?jobId=${J}`, TB2);
    assert(listB.json.total === 2, 'B: both resumes came over');
    const decided = listB.json.items.find((r: any) => r.id === e1.json.record.id);
    assert(decided?.decisionStatus === 'approved', 'B: decisions came over');
    const fileUrl = await b('GET', `/api/resumes/${e2.json.record.id}/file-url`, TB2);
    const fileB = await b('GET', fileUrl.json.url);
    assert(fileB.status === 200 && fileB.buf.equals(pdf), 'B: the original PDF downloads byte-identical from the remote store');
    const aiB = await b('GET', '/api/admin/ai', TB2);
    const adminKeys = (aiB.json.keys || []).filter((k: any) => k.source === 'admin');
    assert(adminKeys.length === 2 && adminKeys.some((k: any) => k.label === 'کلید سرور A' && k.unreadable) && adminKeys.some((k: any) => k.label === 'کلید سرور B' && !k.unreadable), 'B: key list = A’s (unreadable, re-enter) + B’s (works)');
    const auditB = await b('GET', '/api/admin/audit', TB2);
    assert(
      auditB.json.items?.[0]?.action === 'backup.restore' && auditB.json.items.some((x: any) => x.action === 'ai.key_add' && x.target === 'کلید سرور A'),
      'B: the audit log carries A’s history plus the restore',
      (auditB.json.items || []).map((x: any) => x.action).join(',')
    );
    assert((await b('POST', '/api/auth/login', null, { email: 'admin2@example.com', password: 'Admin212345' })).status === 401, 'B: accounts that were not in the backup are gone');

    // Restart B: everything is read back from the remote store.
    await stopServer(B);
    B = await startServer({
      STORAGE_DRIVER: 'remote',
      STORAGE_URL: storageUrl,
      DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'hv-backup-b2-unused-')),
      APP_SECRET: 'secret-of-server-B-9876543210',
      ADMIN_EMAILS: 'admin2@example.com,boss@example.com',
    });
    const b2 = client(B.base);
    const again = await b2('POST', '/api/auth/login', null, { email: 'boss@example.com', password: 'Boss123456' });
    assert(again.status === 200, 'B after a restart (new container, wiped disk): the restored data is still there');
    const fileAgain = await b2('GET', (await b2('GET', `/api/resumes/${e1.json.record.id}/file-url`, again.json.token)).json.url);
    assert(fileAgain.buf.toString('utf-8') === txt, 'B after a restart: original files are still served');

    // ------------------------------------------------------ refusals ----
    const T3 = again.json.token as string;
    const tryRestore = async (buf: Buffer) => {
      const s = await b2('POST', '/api/admin/restore', T3, { fileName: 'x.zip', size: buf.length });
      if (s.status !== 200) return s;
      await b2('PUT', `/api/admin/restore/${s.json.id}/chunk?offset=0`, T3, undefined, buf);
      const r = await b2('POST', `/api/admin/restore/${s.json.id}/inspect`, T3);
      await b2('DELETE', `/api/admin/restore/${s.json.id}`, T3);
      return r;
    };
    const junk = await tryRestore(crypto.randomBytes(5000));
    assert(junk.status === 400 && /ZIP/.test(junk.json.error), 'a file that is not a ZIP is refused clearly', junk.json?.error);
    const foreign = await tryRestore(await zipToBuffer([['photos/a.jpg', crypto.randomBytes(100)]]));
    assert(foreign.status === 400 && /manifest/.test(foreign.json.error), 'a ZIP that is not a HOVIDA backup is refused', foreign.json?.error);
    const tampered = await tryRestore(
      await zipToBuffer([
        ['manifest.json', Buffer.from(JSON.stringify({ ...manifest }))],
        ['hovida-store.json', Buffer.from(JSON.stringify({ ...store, orgs: [] })), true],
      ])
    );
    assert(tampered.status === 400 && /آسیب/.test(tampered.json.error), 'edited data (checksum mismatch) is refused', tampered.json?.error);
    const nested = await tryRestore(
      await zipToBuffer([
        ['my-backup/manifest.json', Buffer.from(JSON.stringify(manifest))],
        ['my-backup/hovida-store.json', Buffer.from(JSON.stringify(store)), true],
      ])
    );
    assert(nested.status === 200 && nested.json.counts.resumes === 2 && nested.json.counts.missingFiles === 2, 'a backup re-zipped inside a folder is still recognised (files reported missing)');
    const future = await tryRestore(
      await zipToBuffer([
        ['manifest.json', Buffer.from(JSON.stringify({ ...manifest, formatVersion: 99 }))],
        ['hovida-store.json', Buffer.from(JSON.stringify(store)), true],
      ])
    );
    assert(future.status === 400 && /تازه‌تر/.test(future.json.error), 'a backup from a newer HOVIDA asks to update first', future.json?.error);
  } finally {
    if (B) await stopServer(B);
    await stopServer(A);
    mock.kill();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

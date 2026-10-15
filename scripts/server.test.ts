/**
 * Store & server-helper tests on a throw-away DATA_DIR:
 *  - legacy (single-tenant) data is never handed to whoever signs up first,
 *    and is claimed by LEGACY_OWNER_EMAIL at signup or on the next start
 *  - an analysis whose tab went away does not stay "processing" forever
 *  - rapid saves never leave a corrupt or stale snapshot
 *  - clientIp ignores client-supplied X-Forwarded-For entries
 * Run with: npx tsx scripts/server.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hovida-test-'));
process.env.DATA_DIR = dir;
delete process.env.LEGACY_OWNER_EMAIL;

// A snapshot from the previous single-workspace version.
const understanding = {
  department: 'فروش', departmentId: 'sales', roleTitle: 'کارشناس فروش', seniority: 'کارشناسی', plainExplanation: 'x',
  thresholds: { interview: 75, review: 50 },
  criteria: [{ id: 'c1', title: 'سابقه فروش', weight: 100, mustHave: false }],
  questions: [],
};
fs.writeFileSync(
  path.join(dir, 'screening-store.json'),
  JSON.stringify({
    batches: [{ id: 'bat_legacy1', departmentId: 'sales', departmentName: 'فروش', roleTitle: 'کارشناس فروش', understanding, createdAtISO: '2025-01-01T08:00:00.000Z' }],
    resumes: [{ id: 'res_legacy1', batchId: 'bat_legacy1', fileName: 'a.pdf', category: 'REVIEW', score: 60, candidateName: 'رزومه قدیمی', createdAtISO: '2025-01-01T08:00:00.000Z' }],
  })
);

async function main() {
  const db = await import('../server/db');
  const { clientIp } = await import('../server/auth');
  await db.initStore();

  // ---- legacy data ----
  const stranger = db.createOrg({ name: 'شرکت غریبه', ownerEmail: 'first@signup.ir' });
  db.createUser({ orgId: stranger.id, name: 'غریبه', email: 'first@signup.ir', passwordHash: 'x', role: 'owner' });
  assert(db.listJobs(stranger.id).length === 0, 'the first signup does NOT receive legacy candidates without LEGACY_OWNER_EMAIL');

  const boss = db.createOrg({ name: 'سیلانه', ownerEmail: 'boss@company.ir' });
  db.createUser({ orgId: boss.id, name: 'مدیر', email: 'boss@company.ir', passwordHash: 'x', role: 'owner' });
  assert(db.listJobs(boss.id).length === 0, 'legacy data stays unclaimed until the owner is configured');
  db.flushSaveSync();

  // Setting LEGACY_OWNER_EMAIL after signing up: the next start attaches the data.
  const probe = `
    const db = await import(${JSON.stringify(path.resolve('server/db.ts'))});
    await db.initStore();
    const org = db.findUserByEmail('boss@company.ir').orgId;
    const other = db.findUserByEmail('first@signup.ir').orgId;
    console.log(JSON.stringify({ mine: db.listJobs(org).length, other: db.listJobs(other).length }));
    db.flushSaveSync();
  `;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], {
    env: { ...process.env, DATA_DIR: dir, LEGACY_OWNER_EMAIL: 'Boss@Company.ir' },
    encoding: 'utf8',
  });
  const counts = JSON.parse(out.trim().split('\n').pop() || '{}');
  assert(counts.mine === 1 && counts.other === 0, 'on restart, LEGACY_OWNER_EMAIL claims the data for that existing account only', out.trim().split('\n').pop());

  // ---- stale "processing" ----
  const job = db.createJob(boss.id, null, {
    departmentId: 'sales', departmentName: 'فروش', roleTitle: 'تست', extraNotes: '', location: '', employmentType: null,
    understanding: understanding as any, answers: {}, criteriaSource: 'template',
  });
  db.updateJob(boss.id, job.id, { analysisStatus: 'processing' });
  assert(db.getJob(boss.id, job.id)?.analysisStatus === 'processing', 'a live analysis shows as processing');
  job.updatedAtISO = new Date(Date.now() - 7 * 60_000).toISOString(); // no heartbeat for 7 minutes
  assert(db.getJob(boss.id, job.id)?.analysisStatus === 'done', 'a silent analysis (tab closed) stops showing as processing');

  // ---- save serialization ----
  for (let i = 0; i < 300; i++) {
    db.updateOrg(boss.id, { messageSignature: `امضا ${i}` });
    if (i % 50 === 0) await sleep(5);
  }
  await sleep(1500);
  const file = path.join(dir, 'hovida-store.json');
  let parsed: any = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* corrupt */
  }
  const saved = parsed?.orgs?.find((o: any) => o.id === boss.id)?.messageSignature;
  assert(saved === 'امضا 299', 'rapid changes end in one valid snapshot holding the latest state', String(saved));
  assert(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')).length === 0, 'no temp files are left behind');

  // ---- clientIp ----
  const req = (xff: string | undefined, remote = '10.0.0.9') => ({ headers: xff ? { 'x-forwarded-for': xff } : {}, socket: { remoteAddress: remote } }) as any;
  delete process.env.TRUST_PROXY_HOPS;
  assert(clientIp(req('6.6.6.6, 203.0.113.7')) === '203.0.113.7', 'clientIp uses the hop our proxy appended, not the spoofable first entry');
  assert(clientIp(req('203.0.113.7')) === '203.0.113.7', 'clientIp with a single proxy hop');
  assert(clientIp(req(undefined)) === '10.0.0.9', 'clientIp without a proxy header falls back to the socket');
  process.env.TRUST_PROXY_HOPS = '0';
  assert(clientIp(req('6.6.6.6')) === '10.0.0.9', 'TRUST_PROXY_HOPS=0 ignores X-Forwarded-For entirely');
  process.env.TRUST_PROXY_HOPS = '2';
  assert(clientIp(req('6.6.6.6, 198.51.100.1, 172.16.0.2')) === '198.51.100.1', 'TRUST_PROXY_HOPS=2 (CDN + load balancer)');
  delete process.env.TRUST_PROXY_HOPS;
  // Render: XFF = [spoofed…, visitor, Cloudflare edge, 10.x] — the last hop is shared by everyone.
  const renderReq = { headers: { 'x-forwarded-for': '6.6.6.6, 81.107.0.110, 172.71.1.2, 10.1.2.3', 'cf-connecting-ip': '81.107.0.110' }, socket: { remoteAddress: '10.1.2.3' } } as any;
  process.env.RENDER = 'true';
  assert(clientIp(renderReq) === '81.107.0.110', 'on Render the visitor comes from cf-connecting-ip, not a shared proxy hop');
  delete process.env.RENDER;
  assert(clientIp(renderReq) === '10.1.2.3', 'elsewhere cf-connecting-ip is not trusted unless configured');
  process.env.CLIENT_IP_HEADER = 'cf-connecting-ip';
  assert(clientIp(renderReq) === '81.107.0.110', 'CLIENT_IP_HEADER opts in explicitly');
  delete process.env.CLIENT_IP_HEADER;

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

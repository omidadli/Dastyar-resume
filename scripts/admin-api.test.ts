/**
 * End-to-end API test of the production bundle (dist/server.cjs) with a mock
 * OpenAI-compatible gateway: setup-code claim, AI keys + automatic failover
 * during real resume evaluations in many formats, system switches (sign-up,
 * demo, maintenance), suspension, disabled users, password reset, support
 * sessions, behaviour versions + test lab, audit log and safe file serving.
 * Run with: npm run build && npx tsx scripts/admin-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function lib(name: string): Promise<any> {
  const mod: any = await import(name);
  return mod.default && (typeof mod.default === 'object' || typeof mod.default === 'function') ? mod.default : mod;
}

// ------------------------------------------------------------ mock gateway ----

interface Seen {
  key: string;
  fileTypes: string[];
  system: string;
  prompt: string;
}
const seen: Seen[] = [];

function mockGateway(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const parsed = JSON.parse(body || '{}');
      const user = parsed.messages?.[1]?.content;
      const parts: any[] = Array.isArray(user) ? user : [{ type: 'text', text: String(user || '') }];
      const prompt = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      const fileTypes = parts
        .filter((p) => p.type !== 'text')
        .map((p) => (p.type === 'file' ? 'application/pdf' : String(p.image_url?.url || '').slice(5, String(p.image_url?.url || '').indexOf(';'))));
      seen.push({ key, fileTypes, system: String(parsed.messages?.[0]?.content || ''), prompt });
      const reply = (content: unknown, status = 200, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(status === 200 ? { choices: [{ message: { content: JSON.stringify(content) } }] } : content));
      };
      if (key === 'sk-limit-0001') return reply({ error: { message: 'Rate limit reached' } }, 429, { 'retry-after': '120' });
      if (/Return exactly this JSON/.test(prompt)) return reply({ ok: true, message: 'سلام' });
      const ids = Array.from(prompt.matchAll(/^(c\d+)\. /gm)).map((m) => m[1]);
      const notResume = /گواهی‌نامه شرکت در دوره/.test(prompt);
      reply({
        document: { isResume: !notResume, type: notResume ? 'certificate' : 'resume', language: 'fa' },
        candidateName: notResume ? null : 'نیما سلطانی',
        contact: { phone: '09120000000', email: 'nima@example.com', city: 'تهران' },
        facts: { yearsExperience: 6, education: 'کارشناسی مدیریت بازرگانی', lastRole: 'سرپرست فروش', skills: ['مذاکره', 'CRM'], expectedSalary: null },
        criterionScores: ids.map((id) => ({ criterionId: id, score: 84, rationale: 'شاهد روشن در رزومه.', evidence: 'سرپرست فروش با ۶ سال سابقه' })),
        score: notResume ? 0 : 84,
        confidence: 'high',
        recommendation: notResume ? 'REJECT' : 'INTERVIEW',
        summary: notResume ? 'این سند گواهی‌نامه دوره است، نه رزومه.' : 'سابقه فروش مرتبط و قوی.',
        whyCategory: 'تطابق خوب با شاخص‌ها',
        strengths: [{ point: 'سابقه فروش', evidence: 'سرپرست فروش با ۶ سال سابقه', severity: 'minor' }],
        weaknesses: [],
        knockoutMisses: [],
        tags: ['فروش'],
        bankSuggested: false,
        flags: { irrelevant: false, insufficientInfo: false, scannedNoText: false, notResume, multipleCandidates: false, partiallyReadable: false },
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// --------------------------------------------------------------- fixtures ----

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const wp = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

async function docx(body: string[], header: string): Promise<Buffer> {
  const zip = new (await lib('jszip'))();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<w:document ${W}><w:body>${body.map(wp).join('')}</w:body></w:document>`);
  zip.file('word/header1.xml', `<w:hdr ${W}>${wp(header)}</w:hdr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function pptx(slides: string[]): Promise<Buffer> {
  const zip = new (await lib('jszip'))();
  zip.file('ppt/presentation.xml', '<p:presentation/>');
  slides.forEach((t, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function blankPdf(): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>'];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const x = out.length;
  out += `xref\n0 4\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const RESUME_LINES = ['نیما سلطانی', 'سرپرست فروش با ۶ سال سابقه در شرکت‌های پخش مواد غذایی', 'مدیریت تیم ۸ نفره فروش و تحقق ۱۲۰٪ سهمیه سالانه', 'کارشناسی مدیریت بازرگانی — دانشگاه تهران'];

// ------------------------------------------------------------------ server ----

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const gateway = await mockGateway();
  const gatewayUrl = `http://127.0.0.1:${(gateway.address() as any).port}/v1`;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-api-'));
  const PORT = 3400 + Math.floor(Math.random() * 400);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(PORT), DATA_DIR: DATA, APP_SECRET: 'api-test-secret-0123456789abcdef' } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'DISABLE_DEMO']) delete env[k];
  env.ADMIN_EMAILS = 'boss@example.com'; // reserved, nobody has signed up with it yet
  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 20_000) await new Promise((r) => setTimeout(r, 150));
  const code = log.match(/setup code: (HV-[A-Z0-9-]+)/)?.[1] || '';
  assert(Boolean(code), 'startup prints a one-time setup code when no admin exists', code);
  assert(/ADMIN_EMAILS: no account yet for boss@example\.com/.test(log), 'an unclaimed ADMIN_EMAILS address does not count as an admin; startup warns about it');

  const call = async (method: string, url: string, token?: string | null, body?: unknown) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Hovida-Session': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };

  try {
    // --------------------------------------------------------- claim ----
    const a = await call('POST', '/api/auth/signup', null, { orgName: 'سازمان مدیر', name: 'مدیر اصلی', email: 'admin@example.com', password: 'Admin12345' });
    const A = a.json.token as string;
    let me = await call('GET', '/api/admin/me', A);
    assert(me.json.isAdmin === false && me.json.setupPending === true, 'before claiming: not admin, setup pending');
    assert((await call('POST', '/api/admin/claim', A, { code: 'HV-WRONG-CODE-0000' })).status === 400, 'wrong setup code refused');
    assert((await call('POST', '/api/admin/claim', A, { code })).json.ok === true, 'setup code grants platform admin');
    me = await call('GET', '/api/admin/me', A);
    assert(me.json.isAdmin === true && me.json.setupPending === false, 'admin afterwards; setup no longer pending');
    assert((await call('POST', '/api/admin/claim', A, { code })).status === 400, 'setup code is single-use');
    assert((await call('GET', '/api/auth/me', A)).json.user.platformAdmin === true, '/me reports platformAdmin');

    // A workspace admin cannot create the reserved platform-admin account (and know its password).
    const reserved = await call('POST', '/api/org/members', A, { name: 'رئیس', email: 'Boss@Example.com', role: 'member', password: 'Boss123456' });
    assert(reserved.status === 409 && /رزرو/.test(reserved.json.error), 'members: ADMIN_EMAILS address refused (no privilege escalation)', `${reserved.status} ${reserved.json.error}`);

    // ---------------------------------------------------------- keys ----
    assert(!(await call('GET', '/api/auth/me', A)).json.ai.available, 'no keys yet → AI unavailable');
    await call('POST', '/api/admin/ai/keys', A, { label: 'محدود', provider: 'openai', apiKey: 'sk-limit-0001', baseUrl: gatewayUrl, model: 'mock-1' });
    const k2 = await call('POST', '/api/admin/ai/keys', A, { label: 'سالم', provider: 'openai', apiKey: 'sk-good-0002', baseUrl: `${gatewayUrl}/chat/completions`, model: 'mock-1' });
    assert(k2.status === 201 && k2.json.keys.length === 2, 'two keys added');
    assert(!JSON.stringify(k2.json).includes('sk-good-0002') && k2.json.keys[1].baseUrl === gatewayUrl, 'keys never returned in full; pasted endpoint cleaned to the base URL', k2.json.keys[1].baseUrl);
    const test = await call('POST', `/api/admin/ai/keys/${k2.json.keys[1].id}/test`, A);
    assert(test.json.result.ok === true, 'key test round-trip OK');
    assert((await call('POST', '/api/admin/ai/keys', A, { provider: 'openai', apiKey: 'short' })).status === 400, 'invalid key input → 400');

    // ------------------------------------------------- job + intake ----
    const org = await call('GET', '/api/org', A);
    const dept = org.json.org.departments.find((d: any) => /فروش/.test(d.name)) || org.json.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'سرپرست فروش' });
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'سرپرست فروش', understanding: tpl.json.understanding, criteriaSource: 'template' })).json.job;
    assert(Boolean(job?.id), 'job created');

    const evaluate = async (fileName: string, buf: Buffer, extractedText = '') =>
      (await call('POST', `/api/jobs/${job.id}/evaluate`, A, { fileName, fileBase64: buf.toString('base64'), extractedText, unjudgeableReason: null })).json.record;

    seen.length = 0;
    const r1 = await evaluate('nima.docx', await docx(RESUME_LINES.slice(1), 'نیما سلطانی — 09120000000 — nima@example.com'));
    assert(r1.engine === 'ai' && r1.category === 'INTERVIEW' && r1.analysisMeta?.format === 'Word (DOCX)', 'DOCX (server intake) → AI evaluation, format recorded', `${r1.engine}/${r1.category}/${r1.analysisMeta?.format}`);
    assert(seen[0]?.key === 'sk-limit-0001' && seen[1]?.key === 'sk-good-0002', 'first key 429 → same evaluation answered by key 2', seen.map((s) => s.key).join(','));
    assert(seen[1].prompt.includes('nima@example.com') && seen[1].system.includes('## انصاف و منع تبعیض'), 'prompt carries header text; system prompt carries the behaviour');
    assert(r1.analysisMeta?.industry === 'فروش، بازاریابی و توسعه بازار' && r1.analysisMeta?.behaviorVersion === 1, 'industry guide + behaviour version recorded', String(r1.analysisMeta?.industry));
    const calls = await call('GET', '/api/admin/ai/calls?limit=10', A);
    assert(calls.json.items.some((c: any) => c.switchedFrom === 'محدود' && c.ok), 'AI call log shows the automatic switch');
    seen.length = 0;
    await evaluate('second.docx', await docx(RESUME_LINES, 'x'));
    assert(seen.length === 1 && seen[0].key === 'sk-good-0002', 'benched key is not retried on the next resume', seen.map((s) => s.key).join(','));

    const r2 = await evaluate('portfolio.pptx', await pptx(RESUME_LINES));
    assert(r2.engine === 'ai' && r2.analysisMeta?.format === 'پاورپوینت (PPTX)', 'PowerPoint résumé read and evaluated', r2.analysisMeta?.format);

    seen.length = 0;
    const r3 = await evaluate('scan.pdf', blankPdf());
    assert(r3.engine === 'ai' && seen[0]?.fileTypes.includes('application/pdf') && r3.analysisMeta?.format === 'PDF اسکن‌شده', 'scanned PDF goes to the AI as a file (vision)', `${seen[0]?.fileTypes} / ${r3.analysisMeta?.format}`);

    const jpegLib = await lib('jpeg-js');
    const photo = Buffer.from(jpegLib.encode({ data: Buffer.alloc(32 * 32 * 4, 230), width: 32, height: 32 }, 80).data);
    seen.length = 0;
    const r4 = await evaluate('photo-of-cv.jpg', photo);
    assert(r4.engine === 'ai' && seen[0]?.fileTypes.includes('image/jpeg'), 'photographed résumé → image to the AI');

    const XLSX = await (async () => {
      const m: any = await import('xlsx');
      return m.default?.read ? m.default : m;
    })();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(RESUME_LINES.map((l) => [l])), 'cv');
    const r5 = await evaluate('cv.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
    assert(r5.engine === 'ai' && r5.analysisMeta?.format === 'اکسل (XLSX)', 'Excel résumé read');

    const attachment = await docx(RESUME_LINES, 'nima@example.com');
    const eml = Buffer.from(
      [
        'From: nima@example.com',
        'To: hr@example.com',
        'Subject: Resume',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B"',
        '',
        '--B',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'سلام؛ رزومه پیوست است.',
        '--B',
        'Content-Type: application/octet-stream; name="cv.docx"',
        'Content-Disposition: attachment; filename="cv.docx"',
        'Content-Transfer-Encoding: base64',
        '',
        attachment.toString('base64'),
        '--B--',
        '',
      ].join('\r\n')
    );
    seen.length = 0;
    const r6 = await evaluate('mail.eml', eml);
    assert(r6.engine === 'ai' && seen[0]?.prompt.includes('— پیوست: cv.docx'), 'e-mail with an attached DOCX: both read', r6.analysisMeta?.format);

    const r7 = await evaluate('cv.rar', Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(64)]));
    assert(r7.category === 'UNJUDGEABLE' && /ZIP/.test(r7.unjudgeableReason || ''), 'RAR → «اطلاعات ناکافی» with advice', r7.unjudgeableReason);

    const r8 = await evaluate('cert.txt', Buffer.from('گواهی‌نامه شرکت در دوره آموزشی فروش حرفه‌ای به مدت ۲۰ ساعت برای آقای نیما سلطانی صادر می‌شود.'));
    assert(r8.category === 'UNJUDGEABLE' && /رزومه نیست/.test(r8.unjudgeableReason || '') && /گواهی‌نامه/.test(r8.unjudgeableReason || ''), 'certificate (not a resume) → clear reason', r8.unjudgeableReason);

    const htmlCv = await evaluate('cv.html', Buffer.from(`<html><body><h1>نیما سلطانی</h1><p>${RESUME_LINES.join('</p><p>')}</p><script>alert(1)</script></body></html>`));
    assert(htmlCv.engine === 'ai', 'HTML résumé evaluated');
    await new Promise((r) => setTimeout(r, 300));
    const fileUrl = await call('GET', `/api/resumes/${htmlCv.id}/file-url?inline=1`, A);
    assert(fileUrl.json.previewable === false, 'HTML is never previewable inline');
    const served = await fetch(BASE + fileUrl.json.url);
    assert(
      /attachment/.test(served.headers.get('content-disposition') || '') && served.headers.get('content-type') === 'application/octet-stream' && /sandbox/.test(served.headers.get('content-security-policy') || ''),
      'uploaded HTML served as a sandboxed download (no stored XSS)',
      `${served.headers.get('content-type')} | ${served.headers.get('content-disposition')}`
    );

    // ------------------------------------------------------ switches ----
    await call('PATCH', '/api/admin/system', A, { signupEnabled: false, demoEnabled: false, maxFileMb: 5, announcement: { enabled: true, text: 'اطلاعیه آزمایشی', tone: 'success' } });
    let cfg = await call('GET', '/api/auth/config');
    assert(cfg.json.signup === false && cfg.json.demo === false && cfg.json.maxFileMb === 5 && cfg.json.announcement?.text === 'اطلاعیه آزمایشی', 'public config reflects the admin switches');
    const closed = await call('POST', '/api/auth/signup', null, { orgName: 'بسته', name: 'کاربر', email: 'closed@example.com', password: 'Closed12345' });
    assert(closed.status === 403 && closed.json.code === 'SIGNUP_CLOSED', 'sign-up closed → 403');
    assert((await call('POST', '/api/auth/demo')).status === 404, 'demo disabled → 404');
    const big = await call('POST', `/api/jobs/${job.id}/evaluate`, A, { fileName: 'big.pdf', fileBase64: Buffer.alloc(6 * 1024 * 1024).toString('base64'), extractedText: '' });
    assert(big.status === 413 && /۵/.test(big.json.error), 'file over the admin size limit → 413', big.json.error);
    const bigAttach = await call('POST', `/api/resumes/${r1.id}/file`, A, { fileName: 'big.pdf', fileBase64: Buffer.alloc(6 * 1024 * 1024).toString('base64') });
    assert(bigAttach.status === 413, 'background file upload honours the same limit', String(bigAttach.status));
    await call('PATCH', '/api/admin/system', A, { signupEnabled: true, demoEnabled: true, maxFileMb: 20 });

    const b = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت دوم', name: 'کاربر دوم', email: 'second@example.com', password: 'Second12345' });
    const B = b.json.token as string;
    assert((await call('GET', '/api/admin/overview', B)).status === 403, 'non-admin cannot open the admin API');

    await call('PATCH', '/api/admin/system', A, { maintenance: { enabled: true, message: 'در حال به‌روزرسانی' } });
    const m1 = await call('GET', '/api/jobs', B);
    assert(m1.status === 503 && m1.json.code === 'MAINTENANCE' && m1.json.error === 'در حال به‌روزرسانی', 'maintenance → 503 with the message for users');
    assert((await call('GET', '/api/jobs', A)).status === 200, 'platform admin keeps working during maintenance');
    await call('PATCH', '/api/admin/system', A, { maintenance: { enabled: false } });

    // ---------------------------------------------- suspend / disable ----
    const orgB = (await call('GET', '/api/admin/orgs?q=' + encodeURIComponent('شرکت دوم'), A)).json.items[0];
    await call('PATCH', `/api/admin/orgs/${orgB.id}`, A, { suspended: true, suspendedReason: 'پایان قرارداد' });
    const sus = await call('GET', '/api/jobs', B);
    assert(sus.status === 401 && sus.json.code === 'ORG_SUSPENDED' && /پایان قرارداد/.test(sus.json.error), 'suspension signs members out with the reason');
    const susLogin = await call('POST', '/api/auth/login', null, { email: 'second@example.com', password: 'Second12345' });
    assert(susLogin.status === 403 && susLogin.json.code === 'ORG_SUSPENDED', 'suspended workspace cannot sign in');
    await call('PATCH', `/api/admin/orgs/${orgB.id}`, A, { suspended: false });
    const userB = (await call('GET', '/api/admin/users?q=second@example.com', A)).json.items[0];
    await call('PATCH', `/api/admin/users/${userB.id}`, A, { disabled: true });
    assert((await call('POST', '/api/auth/login', null, { email: 'second@example.com', password: 'Second12345' })).json.code === 'ACCOUNT_DISABLED', 'disabled user cannot sign in');
    await call('PATCH', `/api/admin/users/${userB.id}`, A, { disabled: false });
    assert((await call('PATCH', `/api/admin/users/${(await call('GET', '/api/auth/me', A)).json.user.id}`, A, { disabled: true })).status === 400, 'admin cannot disable themself');

    const reset = await call('POST', `/api/admin/users/${userB.id}/reset-password`, A);
    const temp = reset.json.tempPassword as string;
    assert(/^Hv-[A-Za-z]{8}-\d\d$/.test(temp), 'temporary password generated', temp);
    assert((await call('POST', '/api/auth/login', null, { email: 'second@example.com', password: 'Second12345' })).status === 401, 'old password no longer works');
    assert((await call('POST', '/api/auth/login', null, { email: 'second@example.com', password: temp })).status === 200, 'temporary password signs in');

    // ---------------------------------------------------- support ----
    const sup = await call('POST', `/api/admin/orgs/${orgB.id}/support`, A);
    const S = sup.json.token as string;
    const smee = await call('GET', '/api/auth/me', S);
    assert(smee.json.user.email === 'second@example.com' && smee.json.support?.adminName === 'مدیر اصلی', 'support session acts as the owner and is labelled');
    assert((await call('GET', '/api/admin/overview', S)).status === 403 && (await call('GET', '/api/admin/me', S)).json.isAdmin === false, 'support session cannot reach the admin API');
    const deptB = (await call('GET', '/api/org', S)).json.org.departments[0];
    const tplB = await call('POST', '/api/jobs/template', S, { departmentId: deptB.id, roleTitle: 'حسابدار' });
    const jobB = await call('POST', '/api/jobs', S, { departmentId: deptB.id, roleTitle: 'حسابدار', understanding: tplB.json.understanding, criteriaSource: 'template' });
    const actB = await call('GET', '/api/activity?limit=5', S);
    assert(jobB.json.job?.createdByName?.includes('پشتیبانی هویدا') && actB.json.items[0]?.userName?.includes('پشتیبانی هویدا (مدیر اصلی)'), 'actions in a support session are attributed to «پشتیبانی هویدا», not the owner', `${jobB.json.job?.createdByName} / ${actB.json.items[0]?.userName}`);
    await call('PATCH', `/api/admin/orgs/${orgB.id}`, A, { suspended: true, suspendedReason: 'بررسی پشتیبانی' });
    assert((await call('GET', '/api/jobs', S)).status === 200, 'support session can still enter the suspended workspace');
    assert((await call('POST', '/api/auth/login', null, { email: 'second@example.com', password: temp })).json.code === 'ORG_SUSPENDED', '… while its members stay locked out');
    await call('PATCH', `/api/admin/orgs/${orgB.id}`, A, { suspended: false });

    // --------------------------------------------------- behaviour ----
    const beh = await call('GET', '/api/admin/behavior', A);
    assert(beh.json.config.version === 1 && beh.json.config.industries.length >= 25, 'behaviour defaults served (v1, 25+ industries)');
    const edited = { ...beh.json.config, strictness: 'strict', sections: { ...beh.json.config.sections, custom: 'نشانگر-رفتار-مدیر' } };
    const saved = await call('PUT', '/api/admin/behavior', A, { config: edited, note: 'سخت‌گیرانه‌تر' });
    assert(saved.json.config.version === 2 && saved.json.history[0].note === 'سخت‌گیرانه‌تر', 'behaviour saved as version 2 with a note');
    seen.length = 0;
    const r9 = await evaluate('after.docx', await docx(RESUME_LINES, 'x'));
    assert(seen[0]?.system.includes('نشانگر-رفتار-مدیر') && seen[0]?.system.includes('«سخت‌گیرانه»') && r9.analysisMeta?.behaviorVersion === 2, 'next evaluation uses the saved behaviour immediately');
    const lab = await call('POST', '/api/admin/behavior/lab', A, { roleTitle: 'حسابدار ارشد', departmentName: 'مالی', resumeText: RESUME_LINES.join('\n'), config: { ...edited, sections: { ...edited.sections, custom: 'پیش‌نویس-آزمایشگاه' } } });
    assert(lab.json.engine === 'ai' && lab.json.systemPrompt.includes('پیش‌نویس-آزمایشگاه') && lab.json.industry?.id === 'finance-accounting', 'test lab runs an unsaved draft and shows prompts + industry', lab.json.industry?.id);
    const restored = await call('POST', '/api/admin/behavior/restore', A, { version: 1 });
    assert(restored.json.config.version === 3 && restored.json.config.strictness === 'balanced', 'restore v1 → new version 3');

    // ------------------------------------------------- overview/audit ----
    const ov = await call('GET', '/api/admin/overview', A);
    assert(ov.json.orgs.total === 2 && ov.json.resumes.total >= 9 && ov.json.ai.keys === 2 && ov.json.formats.length >= 5, 'overview totals and formats', JSON.stringify(ov.json.formats.slice(0, 4)));
    const audit = await call('GET', '/api/admin/audit?limit=200', A);
    const actions = new Set(audit.json.items.map((x: any) => x.action));
    for (const act of ['admin.claim', 'ai.key_add', 'ai.key_test', 'system.update', 'org.suspend', 'user.update', 'user.reset_password', 'org.support', 'behavior.save', 'behavior.restore']) {
      assert(actions.has(act), `audit log has «${act}»`);
    }

    // ------------------------------------------- ADMIN_EMAILS sign-up ----
    await call('PATCH', '/api/admin/system', A, { signupEnabled: false });
    const boss = await call('POST', '/api/auth/signup', null, { orgName: 'دفتر مدیریت', name: 'مدیر سامانه', email: 'boss@example.com', password: 'Boss123456' });
    assert(Boolean(boss.json.token) && (await call('GET', '/api/admin/me', boss.json.token)).json.isAdmin === true, 'the ADMIN_EMAILS owner can sign up while sign-ups are closed and is platform admin', String(boss.status));
    assert((await call('POST', '/api/auth/signup', null, { orgName: 'دیگر', name: 'دیگری', email: 'other@example.com', password: 'Other12345' })).status === 403, 'everyone else still sees sign-up closed');
    await call('PATCH', '/api/admin/system', A, { signupEnabled: true });

    // ------------------------------------------------------- delete ----
    assert((await call('DELETE', `/api/admin/orgs/${orgB.id}`, A, { confirm: 'اشتباه' })).status === 400, 'delete needs the exact workspace name');
    assert((await call('DELETE', `/api/admin/orgs/${orgB.id}`, A, { confirm: 'شرکت دوم' })).json.ok === true, 'workspace deleted');
    assert((await call('GET', '/api/auth/me', S)).status === 401, 'its sessions are gone too');
  } finally {
    child.kill('SIGTERM');
    gateway.close();
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  if (failures) console.log(log.split('\n').slice(-30).join('\n'));
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

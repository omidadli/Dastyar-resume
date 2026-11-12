/**
 * End-to-end test of «سنجش نرم‌شده» — normed psychometrics.
 *
 * This module can do real harm if it lies, so the test is about honesty:
 *
 *   • **no unnamed percentile** — with no norms the result carries raw bands and
 *     percentile `null`; after HR enters a table, percentiles appear and name the
 *     group; removing the table takes them away again;
 *   • **the norm reaches the score, not the UI** — the same answers score
 *     differently against two different norm tables, and an internal norm is only
 *     built once the workspace has enough completed results;
 *   • **bad data is flagged, not averaged** — a straight-line, too-fast or
 *     attention-failing run is marked unusable and carries no percentile;
 *   • **the candidate page leaks nothing** — no scale names, no keying direction,
 *     no scores, no answer key; and the closing screen never shows a result;
 *   • **nothing is sent without a click**, and a missing mailbox is a real 409;
 *   • **the answer sheet stays on the server** — the workspace API returns scores
 *     and never raw answers;
 *   • **group averages are suppressed** below five people;
 *   • **tenant walls, erasure, and closed links** behave like everywhere else.
 *
 * Run with: npm run build && npx tsx scripts/psychometrics.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { PSYCH_BANK, qualityOf, rawScores } from '../server/psychometrics';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

function mockSmtp(): Promise<{ server: net.Server; messages: string[] }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 mock.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 2.0.0 queued\r\n');
          } else data += line + '\r\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd === 'HELO') socket.write('250 mock.local\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 accepted\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages })));
}

/** A believable answer sheet: mostly towards one side, with variation. */
function sheet(high: boolean, overrides: Record<string, number> = {}): Record<string, number> {
  const out: Record<string, number> = {};
  let i = 0;
  for (const item of PSYCH_BANK) {
    if (item.attention) {
      out[item.id] = item.attention;
      continue;
    }
    // A consistent person: agree with positively-keyed items, disagree with reverse ones.
    // Two neighbouring values so the straight-line check stays quiet.
    const pos = high ? (i % 2 === 0 ? 5 : 4) : i % 2 === 0 ? 2 : 1;
    out[item.id] = item.reverse ? 6 - pos : pos;
    i++;
  }
  return { ...out, ...overrides };
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }

  // ------------------------------------------------------- scoring, in-process
  const good = sheet(true);
  const q = qualityOf(good as any, 400, 2);
  assert(q.usable && q.flags.length === 0, 'a normal, careful sheet is usable');
  const highRaw = rawScores(good as any);
  const lowRaw = rawScores(sheet(false) as any);
  const mean = (rows: typeof highRaw) => rows.reduce((a, r) => a + r.percent, 0) / rows.length;
  assert(mean(highRaw) > mean(lowRaw) + 40, 'a positive sheet scores far above a negative one', `${Math.round(mean(highRaw))} vs ${Math.round(mean(lowRaw))}`);

  const reversed = rawScores(sheet(true, { c4: 5, c5: 5 }) as any);
  const conscientiousness = (rows: typeof reversed) => rows.find((r) => r.id === 'conscientiousness')!.raw;
  assert(conscientiousness(reversed) < conscientiousness(highRaw), 'reverse-keyed items move the score the other way', `${conscientiousness(reversed)} < ${conscientiousness(highRaw)}`);

  // Same answer everywhere, but the two attention checks answered correctly: only
  // the pattern should be flagged, which proves the check is not a proxy.
  const straight: Record<string, number> = {};
  for (const item of PSYCH_BANK) straight[item.id] = item.attention ? item.attention : 4;
  const straightQ = qualityOf(straight as any, 400, 2);
  assert(!straightQ.usable && straightQ.flags.some((f) => f.code === 'STRAIGHT_LINE'), 'a straight-line sheet is flagged', straightQ.flags.map((f) => f.code).join(','));
  assert(!straightQ.flags.some((f) => f.code === 'ATTENTION'), 'and that flag is about the pattern, not the check items', straightQ.flags.map((f) => f.code).join(','));

  const fastQ = qualityOf(good as any, 40, 2);
  assert(!fastQ.usable && fastQ.flags.some((f) => f.code === 'TOO_FAST'), 'a 40-second run is flagged as too fast', fastQ.flags.map((f) => f.code).join(','));

  const wrongAttention = qualityOf(sheet(true, { x1: 5 }) as any, 400, 2);
  assert(!wrongAttention.usable && wrongAttention.flags.some((f) => f.code === 'ATTENTION'), 'a failed attention check is flagged', wrongAttention.flags.map((f) => f.code).join(','));

  // -------------------------------------------------------------- the server
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-psych-'));
  const PORT = 5000 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'psych-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    PUBLIC_URL: BASE,
    // The speed check is asserted in-process against the real default; over HTTP the
    // test cannot spend 27 × 2 seconds, so that one threshold is switched off here.
    PSYCH_MIN_SECONDS_PER_ITEM: '0',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) delete env[k];

  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

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
      json = null;
    }
    return { status: res.status, json, text };
  };

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;

    const A = await signup('آوا صنعت', 'a@example.com');
    const B = await signup('برنا تجارت', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس ارشد محصول',
        understanding: (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد محصول' })).json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;

    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email,Phone',
      'سارا,محمدی,"کارشناس محصول",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"محصول",sara@example.ir,09121234567',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // ------------------------------------------------------------- the scales
    const scales = await call('GET', '/api/psych/scales', A);
    assert(scales.status === 200 && scales.json.scales.length === 5, 'five scales are described', String(scales.json?.scales?.length));
    assert(scales.json.scales.every((s: any) => s.high && s.low && s.itemCount === 5), 'each names what high and low look like at work');
    assert(scales.json.minNormN >= 20 && scales.json.smallGroup === 5, 'the norm and small-group thresholds are published', `${scales.json.minNormN}/${scales.json.smallGroup}`);

    // ---------------------------------------------------- create, send, open
    const created = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    assert(created.status === 201, 'an invitation is created', String(created.status));
    const inv = created.json.invite;
    assert(inv.sentAtISO === null, 'creating sends nothing');
    const token = String(inv.url).split('/psych/')[1];
    assert(/\/psych\/[A-Za-z0-9_-]+$/.test(inv.url), 'with a shareable token link', inv.url);

    const dup = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    assert(dup.status === 409 && dup.json?.code === 'INVITE_OPEN', 'a second open invitation is refused', `${dup.status} ${dup.json?.code}`);

    const noMailbox = await call('POST', `/api/psych/invites/${inv.id}/send`, A, {});
    assert(noMailbox.status === 409 && noMailbox.json?.code === 'EMAIL_NOT_CONFIGURED', 'sending without a mailbox is refused with a code', `${noMailbox.status} ${noMailbox.json?.code}`);
    assert(smtp.messages.length === 0, 'and no letter left');

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-psych-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });
    const sent = await call('POST', `/api/psych/invites/${inv.id}/send`, A, {});
    assert(sent.status === 200 && Boolean(sent.json.invite.sentAtISO), 'sending works once a mailbox exists', String(sent.status));
    assert(smtp.messages.length === 1 && smtp.messages[0].includes(`/psych/${token}`), 'the letter carries the link');

    const page = await call('GET', `/api/psych/public/${token}`);
    assert(page.status === 200, 'the candidate page opens by token', String(page.status));
    assert(page.json.test.items.length === PSYCH_BANK.length, 'with every item', String(page.json.test?.items?.length));
    assert(page.json.test.scale.length === 5, 'and the five-point scale');
    for (const scale of ['conscientiousness', 'agreeableness', 'stability', 'openness', 'extraversion']) {
      assert(!page.text.includes(scale), `the page never names the scale «${scale}»`);
    }
    assert(!page.text.includes('reverse') && !page.text.includes('keyed'), 'nor says which items are reverse-keyed');
    assert(page.json.test.submittedAtISO === null, 'and no result before answering');
    assert(!JSON.stringify(page.json).includes('percentile'), 'no scoring data on the page at all');

    const startedTest = await call('GET', `/api/psych/invites/${inv.id}`, A);
    assert(startedTest.json.invite.status === 'started', 'opening the page marks the test started', startedTest.json.invite.status);

    // ------------------------------------------------------ answers and submit
    const partial = await call('POST', `/api/psych/public/${token}/answers`, null, { answers: { c1: 5, c2: 4, c3: 9, nope: 3 } });
    assert(partial.status === 200 && partial.json.answered === 2, 'answers are saved progressively, and junk is dropped', JSON.stringify(partial.json));

    const tooEarly = await call('POST', `/api/psych/public/${token}/submit`, null, { answers: {} });
    assert(tooEarly.status === 400, 'submitting an empty sheet is refused', `${tooEarly.status} ${tooEarly.json?.code}`);

    const submitted = await call('POST', `/api/psych/public/${token}/submit`, null, { answers: good });
    assert(submitted.status === 200, 'a full sheet is accepted', String(submitted.status));
    assert(submitted.json.test.status === 'submitted', 'the invitation is submitted');
    assert(submitted.json.test.items.length === 0 && submitted.json.test.scale.length === 0, 'the closing screen carries no items');
    assert(!JSON.stringify(submitted.json).includes('percentile'), 'and no score');

    const twice = await call('POST', `/api/psych/public/${token}/submit`, null, { answers: good });
    assert(twice.status === 409 && twice.json?.code === 'ALREADY_SUBMITTED', 'a second submission is refused', String(twice.status));

    // ------------------------------------------------------------ reading it
    const detail = await call('GET', `/api/psych/invites/${inv.id}`, A);
    assert(detail.status === 200 && detail.json.invite.result, 'HR can read the result');
    const result = detail.json.invite.result;
    assert(result.quality.usable, 'the careful sheet is usable', JSON.stringify(result.quality.flags));
    assert(result.scales.length === 5 && result.scales.every((s: any) => s.percent === 0 || s.percent > 0 || s.percent === 0), 'five scales are scored');
    assert(result.scales.every((s: any) => s.percentile === null), 'with NO percentile while no norm exists');
    assert(result.norm.source === null && /بدون هنجار/.test(result.norm.label), 'and the reading says «بدون هنجار»', result.norm.label);
    assert(!JSON.stringify(detail.json).includes('"answers"'), 'the answer sheet is never returned to the workspace');
    assert(detail.json.reading.length === 5 && detail.json.reading.every((r: any) => r.high && r.low), 'the reading text travels with the result');

    // ---------------------------------------------------------------- a norm
    const normSave = await call('PUT', '/api/psych/norms', A, {
      source: 'نمونهٔ کارکنان ۱۴۰۳',
      n: 120,
      scales: {
        conscientiousness: { mean: 17, sd: 3 },
        stability: { mean: 16, sd: 3.5 },
      },
    });
    assert(normSave.status === 200 && normSave.json.norms.n === 120, 'HR can enter a norm table', String(normSave.status));

    const badNorm = await call('PUT', '/api/psych/norms', A, { source: 'بدون n', n: 0, scales: { stability: { mean: 16, sd: 3 } } });
    assert(badNorm.status === 400 && badNorm.json?.code === 'BAD_N', 'a norm without a group size is refused', String(badNorm.status));
    const noSd = await call('PUT', '/api/psych/norms', A, { source: 'x', n: 40, scales: { stability: { mean: 16, sd: 0 } } });
    assert(noSd.status === 400 && noSd.json?.code === 'BAD_STATS', 'a norm with zero spread is refused', String(noSd.status));

    // The next submission is read against the new table.
    const created2 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token2 = String(created2.json.invite.url).split('/psych/')[1];
    const sub2 = await call('POST', `/api/psych/public/${token2}/submit`, null, { answers: sheet(true) });
    assert(sub2.status === 200, 'a second invitation can be completed', String(sub2.status));
    const detail2 = await call('GET', `/api/psych/invites/${created2.json.invite.id}`, A);
    const withNorm = detail2.json.invite.result;
    const consc = withNorm.scales.find((s: any) => s.id === 'conscientiousness');
    assert(consc.percentile !== null, 'a percentile appears once a norm exists', String(consc.percentile));
    assert(withNorm.norm.source === 'external' && /نمونهٔ کارکنان/.test(withNorm.norm.label) && /120/.test(withNorm.norm.label), 'and it names the group and its size', withNorm.norm.label);
    const noStatScale = withNorm.scales.find((s: any) => s.id === 'openness');
    assert(noStatScale.percentile === null, 'a scale without a table row stays «بدون هنجار» instead of inventing one');

    // Two different tables → two different percentiles for the same answers.
    await call('PUT', '/api/psych/norms', A, { source: 'تیم فروش', n: 30, scales: { conscientiousness: { mean: 22, sd: 2 } } });
    const created3 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token3 = String(created3.json.invite.url).split('/psych/')[1];
    await call('POST', `/api/psych/public/${token3}/submit`, null, { answers: sheet(true) });
    const detail3 = await call('GET', `/api/psych/invites/${created3.json.invite.id}`, A);
    const consc3 = detail3.json.invite.result.scales.find((s: any) => s.id === 'conscientiousness');
    assert(consc3.percentile < consc.percentile, 'a harder comparison group lowers the same person’s percentile', `${consc.percentile} → ${consc3.percentile}`);

    // Clearing the table takes the percentiles away again, honestly.
    const cleared = await call('DELETE', '/api/psych/norms', A);
    assert(cleared.status === 200 && cleared.json.norms === null, 'the norm can be removed');
    const created4 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token4 = String(created4.json.invite.url).split('/psych/')[1];
    await call('POST', `/api/psych/public/${token4}/submit`, null, { answers: good });
    const detail4 = await call('GET', `/api/psych/invites/${created4.json.invite.id}`, A);
    assert(detail4.json.invite.result.scales.every((s: any) => s.percentile === null), 'with no norm, no percentile is shown');
    assert(/بدون هنجار/.test(detail4.json.invite.result.norm.label), 'and the label goes back to «بدون هنجار»', detail4.json.invite.result.norm.label);

    // ------------------------------------------------------- a bad-data case
    const created5 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token5 = String(created5.json.invite.url).split('/psych/')[1];
    await call('PUT', '/api/psych/norms', A, { source: 'نمونه', n: 50, scales: { stability: { mean: 16, sd: 3 } } });
    const straightSheet: Record<string, number> = {};
    for (const item of PSYCH_BANK) straightSheet[item.id] = item.attention ? item.attention : 4;
    await call('POST', `/api/psych/public/${token5}/submit`, null, { answers: straightSheet });
    const detail5 = await call('GET', `/api/psych/invites/${created5.json.invite.id}`, A);
    const bad = detail5.json.invite.result;
    assert(!bad.quality.usable && bad.quality.flags.some((f: any) => f.code === 'STRAIGHT_LINE'), 'a straight-line submission is marked unusable', bad.quality.flags.map((f: any) => f.code).join(','));
    assert(bad.scales.every((s: any) => s.percentile === null), 'and is given no percentile at all — a bad sheet is not scored against a norm');
    assert(/قابل اتکا نیست/.test(bad.norm.label), 'the label says the result is not reliable', bad.norm.label);

    // -------------------------------------------------------- group report
    const report = await call('GET', `/api/psych/report?jobId=${job.id}`, A);
    assert(report.status === 200, 'the group report loads', String(report.status));
    assert(report.json.report.rows.length >= 5, 'with every submitted candidate', String(report.json.report?.rows?.length));
    const usableRows = report.json.report.rows.filter((r: any) => r.usable).length;
    assert(report.json.report.n === usableRows, 'counting only usable results', `${report.json.report.n}/${usableRows}`);
    assert(report.json.report.suppressed === usableRows < 5, 'suppression follows the small-group rule', `${usableRows} → suppressed=${report.json.report.suppressed}`);
    if (!report.json.report.suppressed) {
      assert(report.json.report.scales.every((s: any) => s.suppressed === false), 'averages are shown only when the group is large enough');
    } else {
      assert(report.json.report.scales.every((s: any) => s.meanPercentile === null), 'small group → no averages at all');
    }
    assert(!report.text.includes('answers'), 'the report never carries answers');

    // --------------------------------------------------------- decline, cancel
    const created6 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token6 = String(created6.json.invite.url).split('/psych/')[1];
    const declined = await call('POST', `/api/psych/public/${token6}/decline`);
    assert(declined.status === 200 && declined.json.test.status === 'declined', 'a candidate can decline', String(declined.json?.test?.status));
    const submitAfterDecline = await call('POST', `/api/psych/public/${token6}/submit`, null, { answers: good });
    assert(submitAfterDecline.status === 409 && submitAfterDecline.json?.code === 'INVITE_CLOSED', 'a declined link cannot be answered', `${submitAfterDecline.status} ${submitAfterDecline.json?.code}`);

    const created7 = await call('POST', '/api/psych/invites', A, { resumeId: rec.id });
    const token7 = String(created7.json.invite.url).split('/psych/')[1];
    const cancelled = await call('POST', `/api/psych/invites/${created7.json.invite.id}/cancel`, A, {});
    assert(cancelled.status === 200 && cancelled.json.invite.status === 'cancelled', 'HR can cancel an invitation');
    const openCancelled = await call('GET', `/api/psych/public/${token7}`);
    assert(openCancelled.status === 409, 'a cancelled link refuses to open the test', String(openCancelled.status));

    // ------------------------------------------------------------- tenant walls
    const listB = await call('GET', '/api/psych/invites', B);
    assert(listB.status === 200 && listB.json.items.length === 0, 'another workspace sees nothing', String(listB.json?.items?.length));
    const stealB = await call('GET', `/api/psych/invites/${inv.id}`, B);
    assert(stealB.status === 404, 'and cannot read one by id', String(stealB.status));
    const createB = await call('POST', '/api/psych/invites', B, { resumeId: rec.id });
    assert(createB.status === 404, 'nor attach it to a candidate outside their workspace', String(createB.status));
    const normsB = await call('GET', '/api/psych/norms', B);
    assert(normsB.json.norms === null, 'and has no norm table of their own');

    // ---------------------------------------------------------------- erasure
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && (erased.json.erased?.psychInvites || 0) >= 1, 'erasing the candidate counts the tests', JSON.stringify(erased.json.erased));
    const afterErase = await call('GET', '/api/psych/invites', A);
    assert(afterErase.json.items.length === 0, 'and they are gone', String(afterErase.json?.items?.length));
    const pageAfterErase = await call('GET', `/api/psych/public/${token2}`);
    assert(pageAfterErase.status === 404, 'the old candidate link stops working', String(pageAfterErase.status));

    // ------------------------------------------------------------------ audit
    const activity = await call('GET', '/api/activity', A);
    const types = (activity.json?.items || []).map((i: any) => i.type);
    assert(types.some((t: string) => t.startsWith('psych.')), 'the events are on the activity trail', types.filter((t: string) => t.startsWith('psych.')).join(','));
  } finally {
    smtp.server.close();
    child.kill('SIGKILL');
  }

  console.log(failures === 0 ? '\nهمهٔ بررسی‌ها موفق بود.' : `\n${failures} بررسی ناموفق بود.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

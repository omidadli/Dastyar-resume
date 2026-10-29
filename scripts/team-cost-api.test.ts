/**
 * End-to-end API test of «عملکرد تیم» and «هزینهٔ هر استخدام»:
 *   • the team report counts real recorded work (decisions, scorecards, notes)
 *     and is readable by every member;
 *   • the cost report is admin-only, its numbers add up, and «هزینهٔ هر استخدام»
 *     stays empty (not zero) until somebody is actually hired;
 *   • the time estimate only exists when a human entered an hourly rate;
 *   • cost rows survive a restart and never leak into the shared activity text.
 *
 * Run with: npm run build && npx tsx scripts/team-cost-api.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-teamcost-'));
  const PORT = 4900 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'team-cost-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[k];
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
      json = text;
    }
    return { status: res.status, json };
  };

  try {
    const signup = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت الف', name: 'مدیر', email: 'owner@example.com', password: 'Password12345' });
    const A = signup.json.token as string;
    const member = await call('POST', '/api/org/members', A, { name: 'سارا محمدی', email: 'sara@example.com', password: 'Password12345', role: 'member' });
    assert(member.status === 201, 'a member is added', `${member.status}`);
    const M = (await call('POST', '/api/auth/login', null, { email: 'sara@example.com', password: 'Password12345' })).json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const understanding = tpl.json.understanding;
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه', understanding, criteriaSource: 'template' })).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"شبکه",mina@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: imported.json.search.results[0].id, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'a candidate is ready');

    // --------------------------------------------------------- team report --
    const team0 = await call('GET', '/api/reports/team?range=90', M);
    assert(team0.status === 200, 'a member can read the team report', String(team0.status));
    assert(Array.isArray(team0.json.members) && team0.json.members.length === 2, 'every teammate is listed, even with zero work');
    assert(team0.json.totals.decisions === 0 && team0.json.totals.activeMembers === 0, 'a fresh workspace shows zero, not an invented average');
    assert(team0.json.fastShare === null && team0.json.concentration === null, 'no decisions ⇒ no percentage');

    await call('PATCH', `/api/resumes/${rec.id}`, A, { action: 'decision', status: 'approved' });
    const scored = await call('POST', `/api/resumes/${rec.id}/feedback`, M, {
      recommendation: 'yes',
      criteria: [{ criterionId: understanding.criteria[0].id, score: 4 }],
    });
    assert(scored.status === 200, 'the teammate writes a scorecard', `${scored.status}`);
    assert((await call('POST', `/api/resumes/${rec.id}/comments`, A, { body: 'برای مصاحبهٔ فنی هماهنگ شود.' })).status === 201, 'a note is written');

    const team = await call('GET', '/api/reports/team?range=90', M);
    assert(team.json.totals.decisions === 1 && team.json.totals.approved === 1 && team.json.totals.rejected === 0, 'the decision is counted once, as approved');
    assert(team.json.totals.scorecards === 1, 'the scorecard is counted for its author');
    assert(team.json.totals.comments === 1, 'the note is counted for its author');
    assert(team.json.totals.activeMembers === 2, 'both teammates show work');
    const ownerRow = team.json.members.find((m: any) => m.name === 'مدیر');
    const memberRow = team.json.members.find((m: any) => m.name === 'سارا محمدی');
    assert(ownerRow?.decisions === 1 && ownerRow?.comments === 1, 'the owner carries the decision and the note');
    assert(memberRow?.scorecards === 1 && memberRow?.decisions === 0, 'the teammate carries only what they did');
    assert(ownerRow?.medianDecideHours !== null, 'time to decision is measured', String(ownerRow?.medianDecideHours));
    assert(team.json.fastShare === 100, 'a decision made the same minute counts as fast', String(team.json.fastShare));
    assert(team.json.concentration === 100, 'one decider ⇒ 100% concentration', String(team.json.concentration));
    assert(!JSON.stringify(team.json).includes('مینا'), 'the team report never carries a candidate name');

    // --------------------------------------------------------- cost report --
    assert((await call('GET', '/api/reports/cost?range=365', M)).status === 403, 'a member cannot read the money report');
    assert((await call('POST', '/api/costs', M, { kind: 'advertising', amount: 1_000_000 })).status === 403, 'a member cannot add a cost row');

    const cost0 = await call('GET', '/api/reports/cost?range=365', A);
    assert(cost0.status === 200, 'an admin reads the cost report', String(cost0.status));
    assert(cost0.json.assumption.hourlyRate === 0, 'the hourly rate starts at zero — no guessed salary');
    assert(cost0.json.totals.total === 0 && cost0.json.entries.length === 0, 'a fresh workspace has no invented costs');
    assert(cost0.json.perHire === null && cost0.json.hires === 0, 'no hire ⇒ cost per hire is empty, not zero');

    assert((await call('POST', '/api/costs', A, { kind: 'bribe', amount: 5 })).status === 400, 'an unknown cost kind is refused');
    assert((await call('POST', '/api/costs', A, { kind: 'advertising', amount: 0 })).status === 400, 'a zero amount is refused');
    assert((await call('POST', '/api/costs', A, { kind: 'advertising', amount: 5_000_000, atISO: new Date(Date.now() + 5 * 86400_000).toISOString() })).status === 400, 'a cost dated in the future is refused');
    assert((await call('POST', '/api/costs', A, { kind: 'advertising', amount: 5_000_000, jobId: 'job_nope' })).status === 400, 'an unknown opening is refused');

    const ad = await call('POST', '/api/costs', A, { kind: 'advertising', amount: 5_000_000, note: 'آگهی جاب‌ویژن' });
    assert(ad.status === 201 && ad.json.entry.id, 'a cost row is stored', `${ad.status} ${JSON.stringify(ad.json?.error || '')}`);
    assert(Boolean(ad.json.entry.atJalali), 'the row keeps a Persian date');
    assert(ad.json.entry.jobId === null && ad.json.entry.jobTitle === null, 'a general cost stays unattributed');
    const agency = await call('POST', '/api/costs', A, { kind: 'agency', amount: 7_500_000, jobId: job.id, note: 'ریکروتر' });
    assert(agency.json.entry.jobTitle === 'کارشناس شبکه', 'a cost pinned to an opening keeps its title');
    const old = await call('POST', '/api/costs', A, { kind: 'tools', amount: 1_000_000, atISO: new Date(Date.now() - 200 * 86400_000).toISOString() });
    assert(old.status === 201, 'an older cost can be recorded');

    const cost1 = await call('GET', '/api/reports/cost?range=365', A);
    assert(cost1.json.totals.direct === 13_500_000, 'direct cost adds up', String(cost1.json.totals.direct));
    assert(cost1.json.totals.time === 0, 'time cost is zero while no rate is set');
    assert(cost1.json.totals.unattributed === 6_000_000, 'general costs are reported separately', String(cost1.json.totals.unattributed));
    assert(cost1.json.byKind[0].kind === 'agency' && cost1.json.byKind[0].amount === 7_500_000, 'the biggest kind comes first');
    assert(cost1.json.byKind.reduce((n: number, k: any) => n + k.amount, 0) === 13_500_000, 'kinds add up to the direct total');

    const cost30 = await call('GET', '/api/reports/cost?range=30', A);
    assert(cost30.json.totals.direct === 12_500_000, 'the range filters on the cost date', String(cost30.json.totals.direct));
    assert(!cost30.json.entries.some((e: any) => e.kind === 'tools'), 'the 200-day-old cost is outside a 30-day report');

    // ------------------------------------------------------------ the hire --
    const hired = await call('POST', `/api/resumes/${rec.id}/stage`, A, { stageId: 'stage_hired' });
    assert(hired.status === 200, 'the candidate is moved to «استخدام‌شده»', `${hired.status}`);
    const cost2 = await call('GET', '/api/reports/cost?range=365', A);
    assert(cost2.json.hires === 1, 'the hire is counted', String(cost2.json.hires));
    assert(cost2.json.perHire === 13_500_000, 'cost per hire = total ÷ hires', String(cost2.json.perHire));
    assert(cost2.json.byJob.length === 1 && cost2.json.byJob[0].hires === 1, 'the opening shows its own hire');
    assert(cost2.json.byJob[0].perHire === 7_500_000, 'per-opening cost only uses the costs pinned to it', String(cost2.json.byJob[0].perHire));

    // ----------------------------------------------------- time estimate ----
    const noRate = await call('PUT', '/api/costs/assumption', M, { hourlyRate: 1000 });
    assert(noRate.status === 403, 'a member cannot set the hourly rate');
    const rate = await call('PUT', '/api/costs/assumption', A, { hourlyRate: 1_000_000, minutesPerScorecard: 60, minutesPerComment: 60, minutesPerDecision: 60 });
    assert(rate.status === 200 && rate.json.assumption.hourlyRate === 1_000_000, 'the admin sets the hourly rate', `${rate.status}`);
    const cost3 = await call('GET', '/api/reports/cost?range=365', A);
    assert(cost3.json.hours.total === 3, 'one scorecard, one note, one decision = three hours', String(cost3.json.hours.total));
    assert(cost3.json.totals.time === 3_000_000, 'time cost = hours × the entered rate', String(cost3.json.totals.time));
    assert(cost3.json.totals.total === 16_500_000, 'total = direct + time', String(cost3.json.totals.total));
    assert(cost3.json.perHire === 16_500_000, 'cost per hire includes the time estimate', String(cost3.json.perHire));

    // ---------------------------------------------------------- edit/delete --
    const patched = await call('PATCH', `/api/costs/${ad.json.entry.id}`, A, { amount: 6_000_000 });
    assert(patched.status === 200 && patched.json.entry.amount === 6_000_000, 'a cost row can be corrected', `${patched.status}`);
    assert((await call('GET', '/api/reports/cost?range=365', A)).json.totals.direct === 14_500_000, 'the correction changes the total');
    assert((await call('PATCH', '/api/costs/nope', A, { amount: 1 })).status === 404, 'an unknown cost row is a clean 404');
    assert((await call('DELETE', `/api/costs/${agency.json.entry.id}`, A)).status === 200, 'a cost row can be deleted');
    assert((await call('GET', '/api/reports/cost?range=365', A)).json.totals.direct === 7_000_000, 'the deletion changes the total');
    assert((await call('DELETE', `/api/costs/${agency.json.entry.id}`, A)).status === 404, 'deleting it twice is a 404');

    // ------------------------------------------------------------- privacy --
    const feed = await call('GET', '/api/activity?limit=100', M);
    const costLines = feed.json.items.filter((a: any) => a.text.includes('هزینهٔ استخدام'));
    assert(costLines.length >= 2, 'cost changes are logged for the team', String(costLines.length));
    assert(!costLines.some((a: any) => /\d{6,}/.test(a.text.replace(/[۰-۹]/g, '9'))), 'the shared feed never carries an amount');

    assert((await call('PATCH', '/api/org', A, { blindScreening: true })).status === 200, 'blind screening is switched on');
    const blindTeam = await call('GET', '/api/reports/team?range=90', M);
    const blindCost = await call('GET', '/api/reports/cost?range=365', A);
    assert(blindTeam.status === 200 && blindCost.status === 200, 'both reports still work with blind screening on');
    assert(!JSON.stringify(blindTeam.json).includes('مینا') && !JSON.stringify(blindCost.json).includes('مینا'), 'no candidate name leaks into either report');

    // ------------------------------------------------------- tenant border --
    const other = await call('POST', '/api/auth/signup', null, { orgName: 'شرکت ب', name: 'مدیر ب', email: 'b@example.com', password: 'Password12345' });
    const B = other.json.token as string;
    assert((await call('GET', '/api/reports/cost?range=365', B)).json.entries.length === 0, 'another workspace sees only its own costs');
    assert((await call('DELETE', `/api/costs/${ad.json.entry.id}`, B)).status === 404, 'another workspace cannot delete a cost row');
    assert((await call('GET', '/api/reports/team?range=90', B)).json.totals.members === 1, 'another workspace sees only its own team');

    // ------------------------------------------------------------ storage --
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert((snap.costs || []).length === 2, 'the cost rows are stored', String((snap.costs || []).length));
    assert(snap.costAssumptions?.[org.id]?.hourlyRate === 1_000_000, 'the hourly rate is stored per workspace');
    assert((snap.resumes || []).some((r: any) => r.stageId === 'stage_hired'), 'the hire survives the restart');
    assert(!JSON.stringify(snap).includes('team-cost-secret'), 'the app secret is never written to the snapshot');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} team / cost API test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll team & cost API tests passed.');
  }
}

await main();

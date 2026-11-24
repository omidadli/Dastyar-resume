/**
 * End-to-end test of «کیت مصاحبه» (the interview kit):
 *   • the kit is composed from the job's own criteria and the role, not a static list;
 *   • every question carries «بشنوید» and «علامت هشدار» — an interviewer knows what
 *     to listen for, and a thin answer is recognisable;
 *   • a chosen candidate adds questions built from their résumé, and blind mode
 *     keeps their name out of it;
 *   • an unknown role still gets a usable kit, never an error or an empty page.
 *
 * Run with: npm run build && npx tsx scripts/interview-kit-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-kit-'));
  const PORT = 6100 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'interview-kit-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
    DISABLE_DEMO: '1',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'])
    delete env[k];
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

  const makeJob = async (token: string, departmentId: string, roleTitle: string) => {
    const tpl = await call('POST', '/api/jobs/template', token, { departmentId, roleTitle });
    const job = await call('POST', '/api/jobs', token, {
      departmentId,
      roleTitle,
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    });
    return job.json.job;
  };

  const allQuestions = (kit: any) => kit.sections.flatMap((s: any) => s.questions);
  /** Every section except the fixed first/last ones. */
  const middle = (kit: any) => kit.sections.slice(1, -1);

  try {
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت آزمون کیت',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = (id: string) => org.departments.find((d: any) => d.id === id) || org.departments[0];

    // ------------------------------------------------------------- the bank --
    const bank = await call('GET', '/api/interview-kit/bank', A);
    assert(bank.status === 200, 'the bank is readable', `${bank.status}`);
    assert(bank.json.packCount >= 25, 'at least 25 competency packs', String(bank.json.packCount));
    assert(bank.json.roleCount === 30, 'exactly thirty roles are mapped', String(bank.json.roleCount));
    assert(bank.json.questionCount >= 70, 'the bank holds at least 70 questions', String(bank.json.questionCount));

    // ------------------------------------------------------------ a job kit --
    const job = await makeJob(A, dept('it').id, 'کارشناس شبکه');
    const kit = await call('GET', `/api/jobs/${job.id}/interview-kit`, A);
    assert(kit.status === 200 && Boolean(kit.json.kit), 'a kit is built for the job', `${kit.status}`);
    const k = kit.json.kit;
    assert(k.jobId === job.id && k.roleTitle === 'کارشناس شبکه', 'the kit names its job');
    assert(k.sections.length >= 4, 'it has the fixed opening, the work itself and a close', String(k.sections.length));
    assert(k.sections[0].id === 's-motivation', 'it opens with motivation, not a quiz');
    assert(k.sections[k.sections.length - 1].id === 's-close', 'and ends with a close');
    assert(k.durationMin >= 20 && k.durationMin <= 90, 'the suggested time is realistic', String(k.durationMin));
    assert(k.howTo.length === 4, 'four lines on how to use it');
    assert(k.howTo.some((h: string) => h.includes('کارت ارزیابی')), 'it points at the scorecard');
    assert(k.closing.length === 3, 'the closing guidance is there');
    assert(allQuestions(k).length >= 8, 'enough questions to fill the time', String(allQuestions(k).length));
    assert(
      allQuestions(k).every((q: any) => Boolean(q.text) && Boolean(q.listen) && Boolean(q.red)),
      'every question has what to listen for and what to worry about'
    );
    assert(
      allQuestions(k).every((q: any) => q.listen.length > 10 && q.red.length > 10),
      'neither line is a placeholder'
    );
    assert(k.matched.length >= 2, 'the kit says which packs it used', k.matched.join(' | '));
    assert(k.matched.some((m: string) => /شبکه|زیرساخت/.test(m)), 'the networking pack was chosen for a network role', k.matched.join(' | '));
    assert(!JSON.stringify(k).includes('undefined'), 'no empty placeholder leaked into the payload');
    assert(k.criteria.length >= 2 && k.criteria.every((c: any) => c.title && typeof c.weight === 'number'), 'the job criteria are repeated in their own words');
    assert(
      allQuestions(k).some((q: any) => q.criterionId),
      'at least one question is tied to a named criterion'
    );
    const linked = allQuestions(k).filter((q: any) => q.criterionId);
    assert(
      linked.every((q: any) => k.criteria.some((c: any) => c.id === q.criterionId)),
      'every criterion id on a question exists in the criteria list'
    );
    assert(k.candidate === null, 'without a candidate, there is no candidate block');

    // ---------------------------------------------------- a different role --
    const sales = await makeJob(A, dept('sales').id, 'کارشناس فروش');
    const salesKit = (await call('GET', `/api/jobs/${sales.id}/interview-kit`, A)).json.kit;
    assert(salesKit.matched.some((m: string) => /مذاکره/.test(m)), 'a sales role pulls the negotiation pack', salesKit.matched.join(' | '));
    assert(
      allQuestions(salesKit).some((q: any) => /تارگت|رقیب|معامله/.test(q.text)),
      'and its questions are about targets and deals, not networks'
    );
    assert(
      !allQuestions(salesKit).some((q: any) => /قطعی|مسیریابی/.test(q.text)),
      'the network questions do not follow a sales job'
    );

    // -------------------------------------------------- an unknown role --
    const other = await makeJob(A, dept('other').id, 'هماهنگ‌کنندهٔ رویداد');
    const otherKit = (await call('GET', `/api/jobs/${other.id}/interview-kit`, A)).json.kit;
    assert(otherKit.sections.length >= 3, 'an unmatched role still gets a usable kit', String(otherKit.sections.length));
    assert(allQuestions(otherKit).length >= 5, 'and it is not empty');
    assert(otherKit.matched.some((m: string) => /انگیزه/.test(m)), 'the universal opening is always there');

    // ------------------------------------------------- a candidate's kit --
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"شبکه",mina@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept('it').id, jobId: job.id, openToWorkOnly: true });
    const profile = imported.json.search.results[0];
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: profile.id, jobId: job.id })).json.record;

    const personal = (await call('GET', `/api/jobs/${job.id}/interview-kit?resumeId=${rec.id}`, A)).json.kit;
    assert(personal.candidate?.resumeId === rec.id, 'the kit is marked for this candidate');
    assert(personal.candidate.label === 'مینا رضایی' || /کارجوی/.test(personal.candidate.label), 'the candidate is named or blinded', personal.candidate.label);
    const resumeSection = personal.sections.find((s: any) => s.id === 's-candidate');
    assert(Boolean(resumeSection), 'a section asks about this résumé');
    assert(resumeSection.questions.length >= 1, 'with at least one question', String(resumeSection.questions.length));
    assert(resumeSection.questions.every((q: any) => q.source === 'resume'), 'marked as coming from the résumé');
    assert(personal.sections.some((s: any) => s.id === 's-verify'), 'and a «verify before the offer» section');
    assert(personal.durationMin > k.durationMin, 'a personal kit is longer than the generic one', `${personal.durationMin} vs ${k.durationMin}`);

    // The kit is composed from the criteria, not stored: a job whose criteria
    // talk about negotiation gets the negotiation pack even in another field.
    const customUnderstanding = {
      ...job.understanding,
      criteria: [
        { id: 'c1', title: 'مذاکره با تأمین‌کننده و بستن قرارداد خرید', weight: 60, mustHave: true },
        { id: 'c2', title: 'کنترل موجودی انبار', weight: 40, mustHave: false },
      ],
    };
    const custom = await call('POST', '/api/jobs', A, {
      departmentId: dept('other').id,
      roleTitle: 'هماهنگ‌کنندهٔ تأمین',
      understanding: customUnderstanding,
      criteriaSource: 'manual',
    });
    assert(custom.status === 201, 'a job with hand-written criteria can be created', `${custom.status}`);
    const customKit = (await call('GET', `/api/jobs/${custom.json.job.id}/interview-kit`, A)).json.kit;
    assert(
      customKit.matched.some((m: string) => /مذاکره/.test(m)),
      'the composed kit follows the job’s own criteria',
      customKit.matched.join(' | ')
    );
    assert(
      customKit.sections.some((s: any) => s.questions.some((q: any) => q.criterionId === 'c1')),
      'and ties those questions to criterion c1'
    );

    // --------------------------------------------------- the honest errors --
    assert((await call('GET', '/api/jobs/job_nope/interview-kit', A)).status === 404, 'an unknown job is a clean 404');
    assert((await call('GET', `/api/jobs/${job.id}/interview-kit?resumeId=res_nope`, A)).status === 404, 'an unknown candidate is a clean 404');
    const foreign = await call('GET', `/api/jobs/${sales.id}/interview-kit?resumeId=${rec.id}`, A);
    assert(foreign.status === 400 && /مربوط نیست/.test(foreign.json.error), 'a candidate from another opening is refused, with the reason', `${foreign.status}`);
    assert((await call('GET', `/api/jobs/${job.id}/interview-kit`)).status === 401, 'the kit is for signed-in users only');

    // -------------------------------------------------------- blind mode --
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindKit = (await call('GET', `/api/jobs/${job.id}/interview-kit?resumeId=${rec.id}`, A)).json.kit;
    assert(/^کارجوی [۰-۹]+$/.test(blindKit.candidate.label), 'in blind mode the kit shows the label, not the name', blindKit.candidate.label);
    assert(!JSON.stringify(blindKit).includes('مینا'), 'and the name is not in the payload at all');
    await call('PATCH', '/api/org', A, { blindScreening: false });
  } finally {
    child.kill('SIGTERM');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

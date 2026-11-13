/**
 * «نیازمندسنجی» from the *opening's* side.
 *
 * The requisition page could already attach an opening; what is tested here is
 * that the same rules hold when you come from the job — and that nothing is left
 * half-written when a link is refused:
 *
 *   • create-with-requisition validates first (a draft, a wrong department or an
 *     unknown id never leaves an opening behind);
 *   • attach / switch / detach from the job page behaves like the other door;
 *   • the job payload lists every requisition of the department — the unusable
 *     ones with the server's own reason, never a silent grey row;
 *   • the publish gate: with the rule on, an opening without a requisition is
 *     refused with a code, and the same opening passes once it is attached;
 *   • one requisition, one opening; another workspace sees nothing.
 *
 * Run with: npm run build && npx tsx scripts/job-requisition.test.ts
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
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-jobreq-'));
  const PORT = 5600 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'job-requisition-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    PUBLIC_URL: BASE,
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

  try {
    const A = (await call('POST', '/api/auth/signup', null, { orgName: 'آوا صنعت', name: 'مهدی رستمی', email: 'a@example.com', password: 'Password12345' })).json.token as string;
    const B = (await call('POST', '/api/auth/signup', null, { orgName: 'برنا تجارت', name: 'مدیر دوم', email: 'b@example.com', password: 'Password12345' })).json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const otherDept = org.departments[1];
    const me = (await call('GET', '/api/auth/me', A)).json.user;
    await call('POST', '/api/org/members', A, { name: 'نگار رضایی', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const memberToken = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json.token as string;

    const understandingFor = async (departmentId: string, roleTitle: string) =>
      (await call('POST', '/api/jobs/template', A, { departmentId, roleTitle })).json.understanding;

    const makeJob = async (roleTitle: string, departmentId = dept.id, requisitionId?: string) => {
      const understanding = await understandingFor(departmentId, roleTitle);
      return call('POST', '/api/jobs', A, {
        departmentId,
        roleTitle,
        understanding,
        criteriaSource: 'template',
        ...(requisitionId ? { requisitionId } : {}),
      });
    };

    const makeReq = async (title: string, departmentId = dept.id, slots = 2) => {
      const created = await call('POST', '/api/requisitions', A, {
        title,
        departmentId,
        slots,
        justification: 'بار کاری تیم در فصل اوج بالا رفته و بدون این نیرو، تحویل به مشتری عقب می‌افتد.',
      });
      return created;
    };

    // ------------------------------------------------------- a draft is refused
    const draft = await makeReq('کارشناس فروش (پیش‌نویس)');
    assert(draft.status === 201, 'a requisition starts as a draft', `${draft.status} ${draft.text.slice(0, 100)}`);

    const jobsBefore = (await call('GET', '/api/jobs', A)).json.items.length;
    const draftJob = await makeJob('کارشناس فروش', dept.id, draft.json.requisition.id);
    assert(draftJob.status === 409 && draftJob.json.code === 'REQUISITION_NOT_OPEN', 'an opening cannot be created against a draft requisition', `${draftJob.status}/${draftJob.json?.code}`);
    const jobsAfter = (await call('GET', '/api/jobs', A)).json.items.length;
    assert(jobsAfter === jobsBefore, 'and the refused creation left no half-made opening behind', `${jobsBefore} → ${jobsAfter}`);

    // ------------------------------------------------------------- approve it
    const submitted = await call('POST', `/api/requisitions/${draft.json.requisition.id}/submit`, A, {});
    assert(submitted.status === 200, 'the draft is submitted for approval', String(submitted.status));
    const decided = await call('POST', `/api/requisitions/${draft.json.requisition.id}/decision`, A, {
      decision: 'approved',
      approvedSlots: 1,
      note: 'یک نفر کافی است؛ بقیهٔ ظرفیت با اضافه‌کاری پوشش داده می‌شود.',
    });
    assert(decided.status === 200 && decided.json.requisition.approvedSlots === 1, 'an approver grants fewer seats than asked', `${decided.status}/${decided.json?.requisition?.approvedSlots}`);

    // ------------------------------------------- create with the approved one
    const approvedId = draft.json.requisition.id;
    const linked = await makeJob('کارشناس فروش', dept.id, approvedId);
    assert(linked.status === 201, 'an opening is created against the approved requisition', `${linked.status} ${linked.text.slice(0, 120)}`);
    assert(linked.json.job.requisitionId === approvedId, 'and carries the link on the job itself', String(linked.json.job.requisitionId));
    assert(linked.json.requisition?.requisition?.code === draft.json.requisition.code, 'the create response already includes the requisition block', linked.json?.requisition?.requisition?.code);
    assert(linked.json.requisition.requisition.remaining === 1, 'with the remaining seats counted', String(linked.json?.requisition?.requisition?.remaining));

    const reqAfter = await call('GET', `/api/requisitions/${approvedId}`, A);
    assert(reqAfter.json.requisition.jobIds.includes(linked.json.job.id), 'the requisition now lists the opening');
    assert(reqAfter.json.requisition.history.some((h: any) => h.action === 'job_attached'), 'and its history records the attachment');

    // --------------------------------------------------------- wrong department
    const second = await makeReq('کارشناس فروش (دپارتمان دوم)', otherDept.id);
    await call('POST', `/api/requisitions/${second.json.requisition.id}/submit`, A, {});
    await call('POST', `/api/requisitions/${second.json.requisition.id}/decision`, A, { decision: 'approved', note: 'تأیید برای دپارتمان دوم با ظرفیت کامل.' });
    const wrongDept = await makeJob('کارشناس فروش دوم', dept.id, second.json.requisition.id);
    assert(wrongDept.status === 400 && wrongDept.json.code === 'DEPARTMENT_MISMATCH', 'a requisition of another department is refused', `${wrongDept.status}/${wrongDept.json?.code}`);
    assert((await call('GET', '/api/jobs', A)).json.items.length === jobsBefore + 1, 'and again nothing was created');

    const unknown = await makeJob('کارشناس ناشناخته', dept.id, 'req_does_not_exist');
    assert(unknown.status === 404 && unknown.json.code === 'REQUISITION_NOT_FOUND', 'an unknown requisition is a 404, not a silent skip', `${unknown.status}/${unknown.json?.code}`);

    // -------------------------------------------------- the job page payload
    const jobId = linked.json.job.id;
    const jobView = await call('GET', `/api/jobs/${jobId}`, A);
    assert(jobView.json.requisition?.requisition?.id === approvedId, 'the job page shows its requisition');
    const options = jobView.json.requisition.options as any[];
    assert(options.every((o) => o.departmentId === dept.id), 'options are limited to this department', String(options.length));
    const ownOption = options.find((o) => o.id === approvedId);
    assert(ownOption?.selectable === true, 'the attached requisition is still shown as the current choice');
    assert(jobView.json.requisition.gate.required === false, 'the publishing rule is stated even when it is off');
    assert(jobView.json.requisition.gate.blocked === null, 'and nothing is blocked');

    // The second department's requisition must not appear in this job's options.
    assert(!options.some((o) => o.id === second.json.requisition.id), 'another department’s requisition is not offered');

    // ------------------------------------------------------------- the gate
    const draftOnly = await makeReq('نیروی بدون تأیید');
    const unlinked = await makeJob('کارشناس پشتیبانی');
    assert(unlinked.status === 201 && !unlinked.json.job.requisitionId, 'an opening can be created with no requisition at all', String(unlinked.status));
    const unlinkedId = unlinked.json.job.id;

    const publishFree = await call('POST', `/api/jobs/${unlinkedId}/publish`, A, { isPublic: true });
    assert(publishFree.status === 200, 'with the rule off, it publishes anyway', String(publishFree.status));
    await call('POST', `/api/jobs/${unlinkedId}/publish`, A, { isPublic: false });

    await call('PUT', '/api/requisitions/settings', A, { requireApprovedForPublish: true });
    const gateOn = await call('GET', `/api/jobs/${unlinkedId}`, A);
    assert(gateOn.json.requisition.gate.required === true, 'turning the rule on is visible on the job page');
    assert(gateOn.json.requisition.gate.blocked?.code === 'REQUISITION_REQUIRED', 'and the exact refusal is already named', gateOn.json?.requisition?.gate?.blocked?.code);

    const publishBlocked = await call('POST', `/api/jobs/${unlinkedId}/publish`, A, { isPublic: true });
    assert(publishBlocked.status === 409 && publishBlocked.json.code === 'REQUISITION_REQUIRED', 'publishing is refused with a code', `${publishBlocked.status}/${publishBlocked.json?.code}`);
    assert(/نیازمندسنجی/.test(publishBlocked.json.error), 'and the sentence says what to do');

    const linkedPublish = await call('POST', `/api/jobs/${jobId}/publish`, A, { isPublic: true });
    assert(linkedPublish.status === 200, 'the opening with a requisition publishes fine', String(linkedPublish.status));
    await call('POST', `/api/jobs/${jobId}/publish`, A, { isPublic: false });

    // -------------------------------------------- one requisition, many openings
    // A requisition is a pool of seats: two openings may spend it, and the seats
    // are closed by accepted offers, not by the number of job records.
    const shared = await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: approvedId });
    assert(shared.status === 200, 'a second opening may spend the same requisition', `${shared.status}/${shared.json?.code}`);
    const sharedPool = await call('GET', `/api/requisitions/${approvedId}`, A);
    assert(sharedPool.json.requisition.jobIds.length === 2, 'and the requisition lists both openings', String(sharedPool.json?.requisition?.jobIds?.length));
    const duplicate = await call('POST', `/api/requisitions/${approvedId}/jobs`, A, { jobId });
    assert(duplicate.status === 200, 'attaching the same opening twice is idempotent', String(duplicate.status));
    const otherDoor = await call('POST', `/api/requisitions/${approvedId}/jobs`, A, { jobId: 'job_missing' });
    assert(otherDoor.status === 404, 'the requisition page still validates the opening it is given', String(otherDoor.status));
    await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: null });

    const third = await makeReq('کارشناس پشتیبانی');
    await call('POST', `/api/requisitions/${third.json.requisition.id}/submit`, A, {});
    await call('POST', `/api/requisitions/${third.json.requisition.id}/decision`, A, { decision: 'approved', note: 'برای شیفت عصر تأیید شد.' });
    const attached = await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: third.json.requisition.id });
    assert(attached.status === 200 && attached.json.job.requisitionId === third.json.requisition.id, 'an opening is attached from its own page', `${attached.status}`);
    assert(attached.json.requisition.gate.blocked === null, 'and the publish gate clears immediately', JSON.stringify(attached.json?.requisition?.gate?.blocked));
    const publishNow = await call('POST', `/api/jobs/${unlinkedId}/publish`, A, { isPublic: true });
    assert(publishNow.status === 200, 'publishing then works', String(publishNow.status));
    await call('POST', `/api/jobs/${unlinkedId}/publish`, A, { isPublic: false });

    // Switching: preflight before letting go — a refused target keeps the old link.
    const attachDraft = await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: draftOnly.json.requisition.id });
    assert(attachDraft.status === 409 && attachDraft.json.code === 'REQUISITION_NOT_OPEN', 'switching to an unapproved requisition is refused', `${attachDraft.status}/${attachDraft.json?.code}`);
    const afterRefusedSwitch = await call('GET', `/api/jobs/${unlinkedId}`, A);
    assert(afterRefusedSwitch.json.job.requisitionId === third.json.requisition.id, 'and the opening stays attached where it was', String(afterRefusedSwitch.json?.job?.requisitionId));

    const detached = await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: null });
    assert(detached.status === 200 && detached.json.job.requisitionId === null, 'the link can be cleared', `${detached.status}/${detached.json?.job?.requisitionId}`);
    const historyDetached = await call('GET', `/api/requisitions/${third.json.requisition.id}`, A);
    assert(historyDetached.json.requisition.history.some((h: any) => h.action === 'job_detached'), 'the requisition history records the detach');
    assert(historyDetached.json.requisition.jobIds.length === 0, 'and it lists no opening any more');
    const gateBack = await call('GET', `/api/jobs/${unlinkedId}`, A);
    assert(gateBack.json.requisition.gate.blocked?.code === 'REQUISITION_REQUIRED', 'the gate closes again', gateBack.json?.requisition?.gate?.blocked?.code);

    // --------------------------------------------------- member may link too
    const byMember = await call('PUT', `/api/jobs/${unlinkedId}/requisition`, memberToken, { requisitionId: third.json.requisition.id });
    assert(byMember.status === 200, 'a member may link an opening (it is hiring work, not an admin action)', String(byMember.status));
    await call('PUT', `/api/jobs/${unlinkedId}/requisition`, A, { requisitionId: null });

    // --------------------------------------------------------- isolation
    const cross = await call('PUT', `/api/jobs/${jobId}/requisition`, B, { requisitionId: approvedId });
    assert(cross.status === 404, 'another workspace cannot touch this opening', String(cross.status));
    const crossReq = await makeJob('کارشناس بیرونی');
    assert(crossReq.status === 201, 'the other workspace makes its own job');
    const crossLink = await call('PUT', `/api/jobs/${crossReq.json.job.id}/requisition`, B, { requisitionId: approvedId });
    assert(crossLink.status === 404, 'and cannot spend a requisition of another workspace', `${crossLink.status}/${crossLink.json?.code}`);

    // ------------------------------------------------------- activity trail
    const activity = await call('GET', '/api/activity?limit=200', A);
    const texts = (activity.json?.items || []).map((a: any) => a.text).join(' | ');
    assert(/نیازمندسنجی/.test(texts), 'the attach/detach is in the activity feed');
    assert(texts.includes(draft.json.requisition.code) || texts.includes('کارشناس فروش'), 'with the opening or requisition named');

    // The gate setting round-trips, so the UI can trust the flag.
    const settingsNow = await call('GET', '/api/requisitions/settings', A);
    assert(settingsNow.json.settings?.requireApprovedForPublish === true, 'the setting is readable back by the job page');
    assert(me?.role === 'owner', 'the approver was a different human than the requester', String(me?.role));
  } finally {
    child.kill('SIGTERM');
    // Wait for the server to finish its shutdown write before removing the data
    // directory — otherwise the snapshot lands in a half-deleted folder and the
    // cleanup itself fails the run.
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 4000);
    });
    fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  if (failures) {
    console.log(`\n${failures} بررسی ناموفق بود.`);
    process.exit(1);
  }
  console.log('\nهمهٔ بررسی‌ها موفق بود.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * End-to-end API test of «کارتابل تأیید» — the inbox of human decisions.
 *
 * What is proven here:
 *   • a fresh workspace has an empty inbox, and it says which queues even exist;
 *   • a draft offer with an approval chain appears once, for the person whose
 *     turn it is, and only that person (or an admin) can decide it;
 *   • deciding from the inbox follows the same rules as the offer page and
 *     sends nothing to the candidate;
 *   • a referral reward appears in the admin's inbox only;
 *   • automation proposals appear while the engine is on, and the row points at
 *     the page that shows the letter instead of sending it from here;
 *   • job access hides a confidential opening's rows, blind mode masks names,
 *     and another workspace sees nothing of ours;
 *   • the queues are derived, so they survive a restart.
 *
 * Run with: npm run build && npx tsx scripts/inbox-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-inbox-'));
  const PORT = 4950 + Math.floor(Math.random() * 40);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'inbox-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of [
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'AI_PROVIDER',
    'ADMIN_EMAILS',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GOOGLE_REDIRECT_URI',
  ])
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
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Hovida-Session': token } : {}),
      },
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
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' })).json
        .token as string;
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];

    // ------------------------------------------------------------- empty ----
    const empty = await call('GET', '/api/inbox', A);
    assert(empty.status === 200, 'the inbox opens', String(empty.status));
    assert(empty.json.items.length === 0 && empty.json.counts.total === 0, 'a fresh workspace has nothing waiting');
    // The automation engine is on by default (it proposes, a human approves);
    // the approval chain and the referral program are not.
    assert(
      empty.json.enabled.offers === false && empty.json.enabled.referrals === false,
      'and it says the offer chain and the referral program are off, rather than pretending to be empty',
      JSON.stringify(empty.json.enabled)
    );
    assert(empty.json.enabled.automation === true, 'while the automation queue reports its real state (on by default)');

    // A job and one candidate to hang decisions on.
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس شبکه' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس شبکه',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'سارا,محمدی,"کارشناس شبکه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir',
      'رضا,کاظمی,"کارشناس شبکه",تهران,بتا,https://www.linkedin.com/in/reza,Yes,"شبکه",reza@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, {
      csv,
      departmentId: dept.id,
      jobId: job.id,
      openToWorkOnly: true,
    });
    const importOne = async (i: number) =>
      (
        await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, {
          profileId: imported.json.search.results[i].id,
          jobId: job.id,
        })
      ).json.record;
    const rec = await importOne(0);
    const rec2 = await importOne(1);

    // ------------------------------------------------------------ members ----
    const addMember = async (name: string, email: string) =>
      (await call('POST', '/api/org/members', A, { name, email, password: 'Password12345', role: 'member' })).status;
    assert((await addMember('نگار رضایی', 'negar@example.com')) < 400, 'a member can be added');
    assert((await addMember('کاوه احمدی', 'kave@example.com')) < 400, 'and another one');
    const members = (await call('GET', '/api/org', A)).json.members as any[];
    const negar = members.find((m) => m.email === 'negar@example.com');
    const owner = members.find((m) => m.role === 'owner');
    const N = (await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' })).json
      .token as string;
    const K = (await call('POST', '/api/auth/login', null, { email: 'kave@example.com', password: 'Password12345' })).json
      .token as string;

    // ------------------------------------------------------ offer approvals ----
    const savedOrg = await call('PATCH', '/api/org', A, {
      offerApproval: {
        enabled: true,
        steps: [
          { id: 's1', label: 'مدیر فنی', approverId: negar.id },
          { id: 's2', label: 'مدیرعامل', approverId: owner.id },
        ],
      },
    });
    assert(savedOrg.status === 200, 'the approval chain is switched on', String(savedOrg.status));

    const offer = await call('POST', '/api/offers', A, {
      resumeId: rec.id,
      terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۶/۰۱/۱۵' },
    });
    assert(offer.status === 201, 'a draft offer is written', `${offer.status} ${JSON.stringify(offer.json?.error || '')}`);
    const offerId = offer.json.offer.id;

    const ownerInbox = await call('GET', '/api/inbox', A);
    assert(ownerInbox.json.counts.offers === 1, 'the offer appears in the inbox', JSON.stringify(ownerInbox.json.counts));
    const row = ownerInbox.json.items[0];
    assert(row.kind === 'offer' && row.id === `offer:${offerId}`, 'with a stable row id', String(row.id));
    assert(row.mine === false && row.canAct === true, 'the owner is not the approver but may act in their place');
    assert(row.waitingOn === 'نگار رضایی', 'and the row names who it waits on', String(row.waitingOn));
    assert(row.detail.includes('مدیر فنی'), 'the detail names the stage', String(row.detail));
    assert(Boolean(row.href?.startsWith('/app/candidates/')), 'and links to the candidate file', String(row.href));
    assert(row.waitingSinceJalali.length > 0, 'the Persian date of waiting is there', String(row.waitingSinceJalali));

    const negarInbox = await call('GET', '/api/inbox', N);
    const negarRow = negarInbox.json.items.find((i: any) => i.kind === 'offer');
    assert(negarRow?.mine === true, 'for Negar the same row is «mine»');
    assert(negarInbox.json.counts.mine === 1, 'and it is counted as hers');
    assert(negarInbox.json.items[0].id === `offer:${offerId}`, 'with her rows first');

    // Someone else may not decide it — the same 403 as the offer page.
    const stranger = await call('POST', `/api/inbox/offers/${offerId}/decision`, K, { decision: 'approved' });
    assert(stranger.status === 403, 'a bystander cannot approve someone else’s stage', String(stranger.status));
    assert(String(stranger.json.error).includes('نگار'), 'and is told whose turn it is', String(stranger.json.error));

    const firstYes = await call('POST', `/api/inbox/offers/${offerId}/decision`, N, {
      decision: 'approved',
      note: 'از نظر فنی تأیید',
    });
    assert(firstYes.status === 200, 'the approver approves from the inbox', `${firstYes.status} ${JSON.stringify(firstYes.json?.error || '')}`);
    const afterOne = firstYes.json.inbox.items.find((i: any) => i.kind === 'offer');
    assert(afterOne?.waitingOn === owner.name, 'the next step now waits on the owner', String(afterOne?.waitingOn));
    assert((await call('GET', '/api/inbox', N)).json.counts.mine === 0, 'and it left Negar’s «mine» count');
    assert((await call('GET', '/api/inbox', A)).json.counts.mine === 1, 'and entered the owner’s');

    const secondYes = await call('POST', `/api/inbox/offers/${offerId}/decision`, A, { decision: 'approved' });
    assert(
      secondYes.status === 200 && secondYes.json.inbox.counts.offers === 0,
      'the last approval empties the queue',
      JSON.stringify(secondYes.json?.inbox?.counts || secondYes.json)
    );
    const decided = (await call('GET', `/api/offers/${offerId}`, A)).json.offer;
    assert(decided.approvals.every((a: any) => a.status === 'approved'), 'both stages are approved');
    assert(decided.approvals[0].note === 'از نظر فنی تأیید', 'the note from the inbox is kept', String(decided.approvals[0].note));
    assert(decided.status === 'draft', 'and the offer is still a draft — approving sent nothing');
    assert(
      (await call('POST', `/api/inbox/offers/${offerId}/decision`, A, { decision: 'approved' })).status === 409,
      'a finished chain cannot be approved again'
    );

    const feed = (await call('GET', '/api/activity', A)).json.items as any[];
    assert(feed.some((a) => String(a.text).includes('از کارتابل')), 'the log says the decision came from the inbox');

    // Rejection closes the offer and sends nothing.
    const second = await call('POST', '/api/offers', A, {
      resumeId: rec2.id,
      terms: { title: 'کارشناس شبکه', startDate: '۱۴۰۶/۰۲/۰۱' },
    });
    assert(second.status === 201, 'a second offer is written for the rejection path', String(second.status));
    const rejected = await call('POST', `/api/inbox/offers/${second.json.offer.id}/decision`, N, {
      decision: 'rejected',
      note: 'خارج از سقف بودجه',
    });
    assert(rejected.status === 200, 'the approver can reject from the inbox', String(rejected.status));
    assert(
      (await call('GET', `/api/offers/${second.json.offer.id}`, A)).json.offer.status === 'cancelled',
      'rejecting cancels the offer'
    );
    assert((await call('GET', '/api/inbox', A)).json.counts.offers === 0, 'and it leaves the queue');

    // ---------------------------------------------------- automation queue ----
    await call('PUT', '/api/automation/settings', A, { enabled: true, inviteThreshold: 0, rejectThreshold: 0 });
    const run = await call('POST', '/api/automation/run', A, { jobId: job.id });
    assert(run.status === 200, 'the automation engine runs', String(run.status));
    const overview = (await call('GET', '/api/automation', A)).json;
    const pendingCount = overview.counts?.pending ?? 0;
    assert(pendingCount > 0, 'and produces proposals to decide', String(pendingCount));

    const withAutomation = await call('GET', '/api/inbox', A);
    assert(
      withAutomation.json.counts.automation === pendingCount,
      'every pending proposal is in the inbox',
      `${withAutomation.json.counts.automation}/${pendingCount}`
    );
    const auto = withAutomation.json.items.find((i: any) => i.kind === 'automation');
    assert(auto.href === '/app/automation', 'the automation row points at the page that shows the letter', String(auto.href));
    assert(auto.detail.includes('تأیید'), 'and says plainly that approving sends it', String(auto.detail));
    assert(
      withAutomation.json.items.filter((i: any) => i.kind === 'automation').every((i: any) => i.mine),
      'proposals wait on the team, so they count as «mine»'
    );
    assert(
      auto.waitingSinceJalali.length > 0 && auto.candidateName.length > 0,
      'with a date and a candidate name',
      `${auto.waitingSinceJalali} / ${auto.candidateName}`
    );

    // Approving in the inbox is impossible by design; and with no mailbox the
    // automation page honestly refuses to send rather than pretending.
    const noMailbox = await call('POST', `/api/automation/${overview.queue[0].id}/approve`, A, {});
    assert(noMailbox.status === 409, 'without a mailbox, approving a proposal is refused (never silently sent)', `${noMailbox.status} ${JSON.stringify(noMailbox.json?.code || noMailbox.json?.error || '')}`);
    assert(String(noMailbox.json?.code) === 'EMAIL_NOT_CONFIGURED', 'and the reason is the missing mailbox');
    assert((await call('GET', '/api/inbox', A)).json.counts.automation === pendingCount, 'the proposal stays in the inbox');

    // Deciding elsewhere removes it from here — one source of truth per queue.
    const decidedAuto = await call('POST', `/api/automation/${overview.queue[0].id}/skip`, A, { note: 'این کارجو را دستی بررسی می‌کنم' });
    assert(decidedAuto.status < 400, 'a proposal is skipped on the automation page', `${decidedAuto.status} ${JSON.stringify(decidedAuto.json?.error || '')}`);
    assert(
      (await call('GET', '/api/inbox', A)).json.counts.automation === pendingCount - 1,
      'and disappears from the inbox',
      String((await call('GET', '/api/inbox', A)).json.counts.automation)
    );

    // ---------------------------------------------------------- referrals ----
    await call('PUT', '/api/referrals/program', A, { enabled: true, rewardAmount: 5_000_000, trigger: 'hire' });
    const program = (await call('GET', '/api/referrals', A)).json;
    assert(program.program.enabled === true, 'the referral program is on');
    assert((await call('GET', '/api/inbox', A)).json.counts.referrals === 0, 'a program alone puts no reward in the inbox');
    const negarCode = (program.members as any[]).find((m) => m.userId === negar.id)?.code;
    assert(Boolean(negarCode), 'Negar has a share code', String(negarCode));

    assert((await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true })).status === 200, 'the opening is published');
    const applied = await call('POST', `/api/careers/${org.careerSlug}/jobs/${job.id}/apply`, null, {
      name: 'مینا شریفی',
      email: 'mina@example.ir',
      text: 'کارشناس شبکه با هفت سال تجربه در پشتیبانی زیرساخت، مسیریابی و امنیت شبکه. مسلط به لینوکس و فایروال.',
      consent: true,
      ref: negarCode,
    });
    assert(applied.status === 200, 'a referred candidate applies through the portal', `${applied.status} ${JSON.stringify(applied.json?.error || '')}`);

    const boardRes = await call('GET', `/api/jobs/${job.id}/board`, A);
    assert(boardRes.status === 200, 'the board answers', `${boardRes.status} ${JSON.stringify(boardRes.json).slice(0, 200)}`);
    const board = boardRes.json;
    const hiredStage = (board.stages as any[]).find((s) => s.kind === 'hired');
    const allCards = (board.columns as any[]).flatMap((c) => c.cards);
    // The portal stores the typed name on the record; the card may still show the
    // upload file name, so the application id is the honest handle.
    const referred = allCards.find((c) => c.id === applied.json.applicationId);
    assert(Boolean(referred && hiredStage), 'the referred candidate is on the board');
    const movedHired = await call('POST', `/api/resumes/${referred.id}/stage`, A, { stageId: hiredStage.id });
    assert(movedHired.status < 400, 'and is marked hired', String(movedHired.status));

    const adminInbox = await call('GET', '/api/inbox', A);
    assert(adminInbox.json.counts.referrals === 1, 'the owed reward lands in the admin’s inbox', JSON.stringify(adminInbox.json.counts));
    const reward = adminInbox.json.items.find((i: any) => i.kind === 'referral');
    assert(reward.mine === true && reward.canAct === true, 'and the admin may act on it');
    assert(String(reward.detail).includes('نگار'), 'the detail names the referrer', String(reward.detail));
    assert(
      adminInbox.json.enabled.referrals === true,
      'the referral queue is reported as live'
    );

    const memberInbox = await call('GET', '/api/inbox', K);
    const memberReward = memberInbox.json.items.find((i: any) => i.kind === 'referral');
    assert(memberReward?.canAct === false, 'a member sees the reward but may not approve it');
    assert(String(memberReward?.blockedReason).includes('مدیر'), 'and is told why', String(memberReward?.blockedReason));
    assert(
      (await call('POST', `/api/inbox/referrals/${reward.id.replace('referral:', '')}/approve`, K)).status === 403,
      'approving it as a member is refused'
    );

    const approved = await call('POST', `/api/inbox/referrals/${reward.id.replace('referral:', '')}/approve`, A, { note: 'پس از استخدام' });
    assert(approved.status === 200 && approved.json.inbox.counts.referrals === 0, 'the admin approves it from the inbox', String(approved.status));
    const referralRow = (await call('GET', '/api/referrals', A)).json.items.find((r: any) => r.rewardStatus === 'approved');
    assert(Boolean(referralRow), 'and the program records it as approved');
    assert(
      (await call('POST', `/api/inbox/referrals/${reward.id.replace('referral:', '')}/approve`, A)).status === 409,
      'a second approval is refused'
    );

    // ----------------------------------------------- job access & blind mode ----
    const kaveItems = (await call('GET', '/api/inbox', K)).json.items.length;
    assert(kaveItems >= 1, 'a member sees the queue of a job they can see', String(kaveItems));
    // Confidential: only Negar may open it, so Kave must lose the rows.
    const lock = await call('PUT', `/api/jobs/${job.id}/access`, A, {
      accessMode: 'restricted',
      allowedUserIds: [negar.id],
    });
    assert(lock.status === 200, 'the opening is made confidential', `${lock.status} ${JSON.stringify(lock.json?.error || '')}`);
    const restricted = await call('GET', '/api/inbox', K);
    assert(restricted.status === 200, 'the inbox still opens for a member without access', String(restricted.status));
    assert(restricted.json.items.length === 0, 'but a confidential opening’s rows are gone', String(restricted.json.items.length));
    assert((await call('GET', '/api/inbox', A)).json.items.length >= 1, 'while the owner still sees them');
    await call('PUT', `/api/jobs/${job.id}/access`, A, { accessMode: 'everyone', allowedUserIds: [] });

    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blind = await call('GET', '/api/inbox', A);
    assert(blind.status === 200, 'the inbox opens in blind mode');
    assert(!JSON.stringify(blind.json).includes('سارا محمدی'), 'and no candidate name is in it', JSON.stringify(blind.json.items.map((i: any) => i.candidateName)));
    // The blind guards are scoped to their own sections: onboarding is closed
    // (a plan is a person's name and first day), while the rest of the API —
    // referrals, the payroll hand-off, live rooms — keeps answering.
    assert((await call('GET', '/api/onboarding', A)).status === 409, 'onboarding is closed while blind mode is on');
    assert((await call('GET', '/api/referrals', A)).status === 200, 'but blind mode no longer closes unrelated endpoints', 'referrals');
    assert((await call('GET', '/api/automation', A)).status === 200, 'nor the automation queue', 'automation');
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // ------------------------------------------------------------ isolation ---
    const otherInbox = await call('GET', '/api/inbox', B);
    assert(otherInbox.status === 200 && otherInbox.json.items.length === 0, 'another workspace sees an empty inbox');
    assert(
      (await call('POST', `/api/inbox/offers/${offerId}/decision`, B, { decision: 'approved' })).status === 404,
      'and cannot decide our offer'
    );
    assert(
      (await call('POST', `/api/inbox/referrals/${reward.id.replace('referral:', '')}/approve`, B)).status === 404,
      'nor approve our reward'
    );

    // --------------------------------------------------------------- restart ---
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const child2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    log = '';
    child2.stdout.on('data', (d) => (log += d));
    child2.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));
    const afterRestart = await call('GET', '/api/inbox', A);
    assert(afterRestart.status === 200, 'the inbox comes back after a restart', String(afterRestart.status));
    assert(
      afterRestart.json.counts.automation === pendingCount - 1,
      'with the same derived queue',
      JSON.stringify(afterRestart.json.counts)
    );
    assert(afterRestart.json.counts.referrals === 0, 'and the settled reward stays settled');
    child2.kill();
  } catch (err) {
    console.error('FAIL  the inbox test stopped on an error:', err);
    failures++;
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} inbox test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nAll inbox tests passed.');
  }
}

await main();

/**
 * «معرفی همکار» — the referral program end to end.
 *
 * A referral that only stores a name is a spreadsheet. This suite proves the
 * product actually closes the loop:
 *   • a colleague's link is tied to *that* member, inside *that* workspace;
 *   • a candidate arriving with the code is recorded as their referral;
 *   • the funnel (hired / rejected) moves the referral and the money;
 *   • pending → approved → paid never happens without a human, and a rejected
 *     candidate leaves nothing owed;
 *   • an unknown code, a switched-off program or another tenant's code creates
 *     no referral at all.
 *
 * Run with: npm run build && npx tsx scripts/referrals-api.test.ts
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
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-ref-'));
  const PORT = 3600 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'referral-api-secret-0123456789',
    AI_PROVIDER: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['PUBLIC_URL', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS']) delete env[k];
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
    // ------------------------------------------------------------ workspace ----
    const owner = await call('POST', '/api/auth/signup', null, {
      orgName: 'سازمان معرفی',
      name: 'مدیر منابع انسانی',
      email: 'owner@example.com',
      password: 'Owner12345',
    });
    const A = owner.json.token as string;
    const org = await call('GET', '/api/org', A);
    const dept = org.json.org.departments[0];

    // A second member: the colleague who will refer people.
    const member = await call('POST', '/api/org/members', A, {
      name: 'همکار معرف',
      email: 'friend@example.com',
      role: 'member',
      password: 'Member12345',
    });
    assert(member.status === 201, 'a second member can be added', `${member.status}`);
    const memberId = member.json.member.id as string;

    const portal = await call('PUT', '/api/careers/settings', A, { slug: 'ref-portal' });
    assert(portal.status === 200, 'the portal has an address', `${portal.status}`);

    // ------------------------------------------------------------- the job ----
    const tpl = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس پشتیبانی' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس پشتیبانی',
        understanding: tpl.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });

    // --------------------------------------------------------- the program ----
    const before = await call('GET', '/api/referrals', A);
    assert(before.status === 200 && before.json.program.enabled === false, 'the program starts switched off');
    assert(before.json.members.length === 2, 'every member gets a link', String(before.json.members.length));
    const apLink = before.json.members.find((m: any) => m.userId === memberId);
    assert(Boolean(apLink?.link) && /^r[a-z0-9]{6,16}$/.test(apLink.code), 'the link carries a member code', String(apLink?.code));
    assert(apLink.link === `${before.json.portalUrl}?ref=${apLink.code}`, 'the link points at the workspace portal');

    const apply = async (email: string, ref?: string) =>
      call('POST', `/api/careers/ref-portal/jobs/${job.id}/apply`, null, {
        name: 'کارجوی آزمایشی',
        email,
        phone: '09121234567',
        city: 'تهران',
        message: '',
        text: 'سابقهٔ پشتیبانی مشتری، دو سال، مسلط به تیکتینگ و پاسخ‌گویی تلفنی.',
        consent: true,
        heardFrom: 'همکارم معرفی کرد',
        ref,
      });

    // Program off → no tracking, even with a valid code.
    await apply('off@example.com', apLink.code);
    const stillEmpty = await call('GET', '/api/referrals', A);
    assert(stillEmpty.json.items.length === 0, 'a switched-off program records nothing', String(stillEmpty.json.items.length));

    const saved = await call('PUT', '/api/referrals/program', A, { enabled: true, rewardAmount: 3_000_000, trigger: 'hire', terms: 'پس از سه ماه.' });
    assert(saved.status === 200 && saved.json.program.enabled === true && saved.json.program.rewardAmount === 3_000_000, 'the program can be turned on with a reward', `${saved.status}`);
    const negative = await call('PUT', '/api/referrals/program', A, { rewardAmount: -5 });
    assert(negative.json.program.rewardAmount === 0, 'a negative reward is not accepted');
    await call('PUT', '/api/referrals/program', A, { rewardAmount: 3_000_000 });

    // ------------------------------------------------------- a real referral ----
    const applied = await apply('referred@example.com', apLink.code);
    assert(applied.status === 200, 'the candidate applies through the referral link', `${applied.status}`);
    const afterApply = await call('GET', '/api/referrals', A);
    assert(afterApply.json.items.length === 1, 'the referral is recorded', String(afterApply.json.items.length));
    const referral = afterApply.json.items[0];
    assert(referral.referrerUserId === memberId && referral.referrerName === 'همکار معرف', 'the referral belongs to the colleague, not to free text', referral.referrerName);
    assert(referral.rewardAmount === 3_000_000 && referral.rewardStatus === 'none', 'the reward is only «owed» once the program says so', referral.rewardStatus);
    assert(referral.heardFrom === 'همکارم معرفی کرد', 'the candidate’s own answer is kept');
    assert(afterApply.json.members.find((m: any) => m.userId === memberId).total === 1, 'it is counted on that member’s link');

    // An unknown code creates nothing.
    await apply('unknown@example.com', 'rnotarealcode');
    const afterUnknown = await call('GET', '/api/referrals', A);
    assert(afterUnknown.json.items.length === 1, 'an unknown code is ignored');

    // ------------------------------------------------ the funnel moves it ----
    // The referral itself names the candidate record — no guessing by name.
    const resume = { id: referral.resumeId as string };
    const list = await call('GET', `/api/resumes?jobId=${job.id}`, A);
    assert(
      list.json.items.some((r: any) => r.id === resume.id),
      'the referred candidate is in the pipeline',
      `${list.json.items?.length} candidates`
    );

    const board = await call('GET', `/api/jobs/${job.id}/board`, A);
    const stages = board.json.stages as Array<{ id: string; kind: string }>;
    const interview = stages.find((s) => s.kind === 'interview')!;
    await call('POST', `/api/resumes/${resume.id}/stage`, A, { stageId: interview.id });
    const midFunnel = await call('GET', '/api/referrals', A);
    assert(midFunnel.json.items[0].rewardStatus === 'none', 'moving to interview owes nothing yet');

    const hired = stages.find((s) => s.kind === 'hired')!;
    const moved = await call('POST', `/api/resumes/${resume.id}/stage`, A, { stageId: hired.id });
    assert(moved.status === 200, 'the candidate is moved to «استخدام‌شده»', `${moved.status}`);
    const afterHire = await call('GET', '/api/referrals', A);
    const hiredRow = afterHire.json.items[0];
    assert(hiredRow.outcome === 'hired', 'the referral follows the funnel', hiredRow.outcome);
    assert(hiredRow.rewardStatus === 'pending', 'the reward waits for HR, it is not paid by the machine', hiredRow.rewardStatus);
    assert(afterHire.json.summary.pendingAmount === 3_000_000, 'the summary shows what is owed', String(afterHire.json.summary.pendingAmount));

    // ------------------------------------------------------ payout approval ----
    const early = await call('POST', `/api/referrals/${referral.id}/pay`, A, {});
    assert(early.status === 409, 'paying before approval is refused', `${early.status}`);

    const approved = await call('POST', `/api/referrals/${referral.id}/approve`, A, { note: 'تأیید مدیر' });
    assert(approved.status === 200 && approved.json.items[0].rewardStatus === 'approved', 'HR approves the reward', `${approved.status}`);
    const again = await call('POST', `/api/referrals/${referral.id}/approve`, A, {});
    assert(again.status === 409, 'the same reward is not approved twice', `${again.status}`);

    const paid = await call('POST', `/api/referrals/${referral.id}/pay`, A, {});
    assert(paid.status === 200 && paid.json.items[0].rewardStatus === 'paid', 'paying is recorded by a person', `${paid.status}`);
    assert(Boolean(paid.json.items[0].paidAtISO) && paid.json.items[0].paidByName === 'مدیر منابع انسانی', 'who paid and when is stored');
    assert(paid.json.summary.paidAmount === 3_000_000 && paid.json.summary.pendingAmount === 0, 'the summary moves the money to «paid»');
    // The payout becomes spend in «هزینهٔ هر استخدام» the moment it is paid —
    // HR never retypes the number, and the per-hire cost stays honest.
    const cost = await call('GET', '/api/reports/cost?range=365', A);
    const bonus = (cost.json.entries || []).filter((e: any) => e.kind === 'referral');
    assert(bonus.length === 1 && bonus[0].amount === 3_000_000, 'the paid bonus lands in the cost report', String(bonus.length));
    assert(bonus[0].jobId === job.id, 'and is pinned to the opening it filled', String(bonus[0].jobId));
    assert(cost.json.totals.direct >= 3_000_000, 'direct cost includes the bonus');
    const voidPaid = await call('POST', `/api/referrals/${referral.id}/void`, A, { note: 'اشتباه' });
    assert(voidPaid.status === 409, 'a paid reward cannot be silently voided', `${voidPaid.status}`);

    // ------------------------------------------- a rejected candidate owes 0 ----
    await apply('rejected@example.com', apLink.code);
    const two = await call('GET', '/api/referrals', A);
    const rejectedRow = two.json.items.find((r: any) => r.candidateName === 'کارجوی آزمایشی' && r.rewardStatus === 'none');
    assert(Boolean(rejectedRow), 'the second referral is pending its own outcome');
    const rejected = stages.find((s) => s.kind === 'rejected')!;
    await call('POST', `/api/resumes/${rejectedRow.resumeId}/stage`, A, { stageId: rejected.id });
    const afterReject = await call('GET', '/api/referrals', A);
    const row2 = afterReject.json.items.find((r: any) => r.id === rejectedRow.id)!;
    assert(row2.outcome === 'rejected' && row2.rewardStatus === 'none', 'a rejected candidate leaves no reward behind', `${row2.outcome}/${row2.rewardStatus}`);

    // ------------------------------------------------ probation trigger is manual ----
    await call('PUT', '/api/referrals/program', A, { trigger: 'probation' });
    await apply('probation@example.com', apLink.code);
    const probationState0 = await call('GET', '/api/referrals', A);
    const fresh = probationState0.json.items.find((r: any) => r.outcome === 'submitted' && r.rewardStatus === 'none')!;
    assert(Boolean(fresh), 'the third referral is waiting for its outcome');
    await call('POST', `/api/resumes/${fresh.resumeId}/stage`, A, { stageId: hired.id });
    const probationState = await call('GET', '/api/referrals', A);
    const row3 = probationState.json.items.find((r: any) => r.id === fresh.id)!;
    assert(row3.outcome === 'hired' && row3.rewardStatus === 'none', 'with «پس از دورهٔ آزمایشی» being hired owes nothing yet', `${row3.rewardStatus}`);
    const confirmed = await call('POST', `/api/referrals/${row3.id}/confirm`, A, {});
    assert(confirmed.status === 200 && confirmed.json.items.find((r: any) => r.id === row3.id).rewardStatus === 'pending', 'a person confirms the probation ended');

    // ------------------------------------------------------ tenant isolation ----
    const other = await call('POST', '/api/auth/signup', null, {
      orgName: 'سازمان دیگر',
      name: 'مدیر دیگر',
      email: 'other@example.com',
      password: 'Other12345',
    });
    const B = other.json.token as string;
    const otherList = await call('GET', '/api/referrals', B);
    assert(otherList.status === 200 && otherList.json.items.length === 0, 'another workspace sees none of it', String(otherList.json.items.length));
    const crossApprove = await call('POST', `/api/referrals/${row3.id}/approve`, B, {});
    assert(crossApprove.status === 409 || crossApprove.status === 404, 'and cannot approve it', `${crossApprove.status}`);
    const otherMembers = await call('GET', '/api/referrals', B);
    const otherLink = otherMembers.json.members[0];
    await apply('cross@example.com', otherLink.code);
    const afterCross = await call('GET', '/api/referrals', A);
    assert(afterCross.json.items.length === 3, 'a code from another workspace creates nothing', String(afterCross.json.items.length));

    // ------------------------------------------------------ member permissions ----
    const memberLogin = await call('POST', '/api/auth/login', null, { email: 'friend@example.com', password: 'Member12345' });
    const M = memberLogin.json.token as string;
    const memberSave = await call('PUT', '/api/referrals/program', M, { rewardAmount: 99_000_000 });
    assert(memberSave.status === 403, 'only an admin can change the program', `${memberSave.status}`);
    const memberList = await call('GET', '/api/referrals', M);
    assert(memberList.status === 200, 'a member can still see their own link', `${memberList.status}`);

    // ------------------------------------------------------------ persistence ----
    const beforeRestart = (await call('GET', '/api/referrals', A)).json;
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 1500));
    const again2 = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log2 = '';
    again2.stdout.on('data', (d) => (log2 += d));
    again2.stderr.on('data', (d) => (log2 += d));
    const t0 = Date.now();
    while (!/آماده است/.test(log2) && Date.now() - t0 < 25_000) await new Promise((r) => setTimeout(r, 150));
    const afterRestart = (await call('GET', '/api/referrals', A)).json;
    assert(afterRestart.items.length === beforeRestart.items.length, 'the referrals survive a restart', `${afterRestart.items.length}/${beforeRestart.items.length}`);
    assert(afterRestart.program.rewardAmount === 3_000_000 && afterRestart.program.trigger === 'probation', 'so does the program');
    assert(afterRestart.members.find((m: any) => m.userId === memberId)?.code === apLink.code, 'and every share link keeps working');
    again2.kill('SIGTERM');
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

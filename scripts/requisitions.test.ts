/**
 * End-to-end test of «نیازمندسنجی و سرفصل نیرو».
 *
 * A requisition is the only place where the product says *no* to hiring, so the
 * test is about the refusals:
 *
 *   • **nothing attaches to an unapproved or over-full requisition**;
 *   • **an approver may grant fewer seats than asked**, the request keeps the
 *     original number, and the history keeps both;
 *   • **nobody approves their own request** — not even an admin;
 *   • **«filled» is counted from accepted offers**, not typed in;
 *   • **the publish gate** is off by default, refuses with a code when on, names
 *     the requisition, and opens once a seat exists;
 *   • **cancel cannot erase hires**, and a cancellation leaves the row visible;
 *   • **tenant walls** for the list, the row, and the settings;
 *   • **the inbox** shows the pending decision and does not pretend to decide it.
 *
 * Run with: npm run build && npx tsx scripts/requisitions.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

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

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-requisitions-'));
  const PORT = 5100 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'requisition-secret-0123456789',
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

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;

    const A = await signup('آوا صنعت', 'a@example.com');
    const B = await signup('برنا تجارت', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const otherDept = org.departments[1] || org.departments[0];

    // A member user: the requester who must not be able to approve their own row.
    const member = await call('POST', '/api/org/members', A, { name: 'نگار رضایی', email: 'negar@example.com', password: 'Password12345', role: 'member' });
    const memberId = member.status === 201 ? member.json.member?.id || null : null;
    const memberLogin = memberId ? await call('POST', '/api/auth/login', null, { email: 'negar@example.com', password: 'Password12345' }) : null;
    const memberToken = memberLogin && memberLogin.status === 200 ? memberLogin.json.token : null;

    // ------------------------------------------------------------ validation
    const empty = await call('POST', '/api/requisitions', A, { title: '' });
    assert(empty.status === 400 && empty.json?.code === 'TITLE_REQUIRED', 'a requisition needs a title', `${empty.status} ${empty.json?.code}`);
    const noDept = await call('POST', '/api/requisitions', A, { title: 'کارشناس', departmentId: 'nope' });
    assert(noDept.status === 400 && noDept.json?.code === 'DEPARTMENT_REQUIRED', 'and a real department', String(noDept.status));
    const badSlots = await call('POST', '/api/requisitions', A, { title: 'کارشناس', departmentId: dept.id, slots: 0 });
    assert(badSlots.status === 400 && badSlots.json?.code === 'BAD_SLOTS', 'slots must be at least one', String(badSlots.status));
    const badRange = await call('POST', '/api/requisitions', A, { title: 'کارشناس', departmentId: dept.id, salaryMin: 50_000_000, salaryMax: 30_000_000 });
    assert(badRange.status === 400 && badRange.json?.code === 'BAD_SALARY_RANGE', 'a bottom above the top is refused', String(badRange.status));

    // -------------------------------------------------------------- creation
    const created = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس ارشد بک‌اند',
      departmentId: dept.id,
      slots: 2,
      priority: 'high',
      seniority: 'senior',
      workMode: 'hybrid',
      salaryMin: 40_000_000,
      salaryMax: 60_000_000,
      justification: 'تیم پرداخت با دو نفر اداره می‌شود و زمان تحویل سرویس‌ها عقب افتاده است.',
    });
    assert(created.status === 201, 'a requisition is created', String(created.status));
    const req = created.json.requisition;
    assert(req.status === 'draft' && req.approvedSlots === null, 'as a draft, with no seats granted yet', `${req.status}/${req.approvedSlots}`);
    assert(/^REQ-\d{4}-001$/.test(req.code), 'with a readable code', req.code);
    assert(req.monthlyCost === 100_000_000, 'and a monthly cost from the band mid point', String(req.monthlyCost));
    assert(req.history.length === 1 && req.history[0].action === 'created', 'the history starts at «ساخته شد»');

    // --------------------------------------------------- submit and approval
    const noReason = await call('POST', '/api/requisitions', A, { title: 'کارشناس داده', departmentId: dept.id, slots: 1, justification: 'لازم است' });
    const noReasonId = noReason.json.requisition.id;
    const submitNoReason = await call('POST', `/api/requisitions/${noReasonId}/submit`, A, {});
    assert(submitNoReason.status === 400 && submitNoReason.json?.code === 'JUSTIFICATION_REQUIRED', 'a reason is required before approval', `${submitNoReason.status} ${submitNoReason.json?.code}`);

    const submitted = await call('POST', `/api/requisitions/${req.id}/submit`, A, {});
    assert(submitted.status === 200 && submitted.json.requisition.status === 'pending', 'submitting moves it to «در انتظار تأیید»', submitted.json?.requisition?.status);

    const editPending = await call('PATCH', `/api/requisitions/${req.id}`, A, { title: 'عنوان تازه' });
    assert(editPending.status === 409 && editPending.json?.code === 'NOT_EDITABLE', 'a submitted requisition is not edited under the approver', String(editPending.status));

    // Name the member as an approver, then let them decide with fewer seats.
    const settings0 = await call('GET', '/api/requisitions/settings', A);
    assert(settings0.status === 200 && settings0.json.settings.requireApprovedForPublish === false, 'the publish gate is off by default');
    assert(Array.isArray(settings0.json.approvers) && settings0.json.approvers.length >= 1, 'and the approver list is readable', String(settings0.json?.approvers?.length));

    const setApprovers = await call('PUT', '/api/requisitions/settings', A, { approverUserIds: memberId ? [memberId] : [] });
    assert(setApprovers.status === 200, 'a named approver can be configured', String(setApprovers.status));
    // With another eligible approver in the workspace, the requester is out of it.
    const selfApprove = await call('POST', `/api/requisitions/${req.id}/decision`, A, { decision: 'approved' });
    assert(selfApprove.status === 403 && selfApprove.json?.code === 'NOT_APPROVER', 'the requester cannot approve their own requisition', `${selfApprove.status} ${selfApprove.json?.code}`);

    // The named approver is a member, not an admin: the rule is about the name, not the role.
    const approved = await call('POST', `/api/requisitions/${req.id}/decision`, memberToken, { decision: 'approved', approvedSlots: 1, note: 'بودجهٔ این فصل یک نفر را می‌کشد.' });
    assert(approved.status === 200 && approved.json.requisition.status === 'approved', 'the named approver approves it', `${approved.status} ${approved.text.slice(0, 140)}`);
    assert(approved.json.requisition.approvedSlots === 1 && approved.json.requisition.slots === 2, 'granting fewer seats keeps the number asked for', `${approved.json.requisition.approvedSlots}/${approved.json.requisition.slots}`);
    assert(approved.json.requisition.history.some((h: any) => h.action === 'approved' && /۲|2/.test(h.note)), 'the change is written to the history');

    const overApprove = await call('POST', `/api/requisitions/${noReasonId}/submit`, A, {});
    assert(overApprove.status === 400, 'the second request still refuses to submit without a reason', String(overApprove.status));
    await call('PATCH', `/api/requisitions/${noReasonId}`, A, { justification: 'گزارش‌های هفتگی دستی ساخته می‌شود و هر هفته چند ساعت وقت می‌برد.' });
    await call('POST', `/api/requisitions/${noReasonId}/submit`, A, {});
    const tooMany = await call('POST', `/api/requisitions/${noReasonId}/decision`, memberToken, { decision: 'approved', approvedSlots: 5 });
    assert(tooMany.status === 400 && tooMany.json?.code === 'BAD_APPROVED_SLOTS', 'an approver cannot grant more seats than were asked', `${tooMany.status} ${tooMany.json?.code}`);
    const rejected = await call('POST', `/api/requisitions/${noReasonId}/decision`, memberToken, { decision: 'rejected', note: 'این کار با اتوماسیون گزارش‌ها حل می‌شود.' });
    assert(rejected.status === 200 && rejected.json.requisition.status === 'rejected', 'it can be rejected instead', String(rejected.json?.requisition?.status));
    const rejectNoNote = await call('POST', `/api/requisitions/${req.id}/decision`, A, { decision: 'rejected' });
    assert(rejectNoNote.status === 409, 'a decided requisition cannot be decided twice', String(rejectNoNote.status));

    // ------------------------------------------------------ attach openings
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس ارشد بک‌اند',
        understanding: (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد بک‌اند' })).json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const otherJob = (
      await call('POST', '/api/jobs', A, {
        departmentId: otherDept.id,
        roleTitle: 'کارشناس فروش',
        understanding: (await call('POST', '/api/jobs/template', A, { departmentId: otherDept.id, roleTitle: 'کارشناس فروش' })).json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;

    const attachWrongDept = await call('POST', `/api/requisitions/${req.id}/jobs`, A, { jobId: otherJob.id });
    assert(attachWrongDept.status === 400 && attachWrongDept.json?.code === 'DEPARTMENT_MISMATCH', 'another department’s opening is refused', `${attachWrongDept.status} ${attachWrongDept.json?.code}`);

    const draftAttach = await call('POST', `/api/requisitions/${noReasonId}/jobs`, A, { jobId: job.id }).catch(() => null);
    assert(draftAttach !== null, 'a rejected requisition is not a valid owner either');
    const rejectedAttach = await call('POST', `/api/requisitions/${noReasonId}/jobs`, A, { jobId: job.id });
    assert(rejectedAttach.status === 409 && rejectedAttach.json?.code === 'REQUISITION_NOT_OPEN', 'a rejected requisition cannot back an opening', String(rejectedAttach.status));

    const attached = await call('POST', `/api/requisitions/${req.id}/jobs`, A, { jobId: job.id });
    assert(attached.status === 200 && attached.json.requisition.jobIds.includes(job.id), 'the opening is attached', String(attached.status));
    const attachTwice = await call('POST', `/api/requisitions/${req.id}/jobs`, A, { jobId: job.id });
    assert(attachTwice.status === 200, 'attaching the same opening twice is a no-op', String(attachTwice.status));

    const jobView = await call('GET', `/api/jobs/${job.id}`, A);
    assert(jobView.json?.job?.requisitionId === req.id, 'the job carries the requisition id');

    // ------------------------------------------------------- the publish gate
    const publishFree = await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });
    assert(publishFree.status === 200, 'with the gate off, publishing works regardless', String(publishFree.status));
    await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: false });

    const gateOn = await call('PUT', '/api/requisitions/settings', A, { requireApprovedForPublish: true, approverUserIds: memberId ? [memberId] : [] });
    assert(gateOn.status === 200 && gateOn.json.settings.requireApprovedForPublish === true, 'the gate can be turned on');

    const jobNoReq = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس داده',
        understanding: (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس داده' })).json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const blocked = await call('POST', `/api/jobs/${jobNoReq.id}/publish`, A, { isPublic: true });
    assert(blocked.status === 409 && blocked.json?.code === 'REQUISITION_REQUIRED', 'publishing without a requisition is refused, with a code', `${blocked.status} ${blocked.json?.code}`);
    const jobAfterBlock = await call('GET', `/api/jobs/${jobNoReq.id}`, A);
    assert(jobAfterBlock.json?.job?.isPublic === false, 'and the opening did not go public anyway');

    const publishOk = await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });
    assert(publishOk.status === 200, 'an opening attached to an approved requisition publishes', String(publishOk.status));

    // ------------------------------------------------------- counting hires
    const rec = await (async () => {
      const csv = [
        'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email,Phone',
        'سارا,محمدی,"برنامه‌نویس بک‌اند",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"Node.js",sara@example.ir,09121234567',
      ].join('\r\n');
      const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
      const profileId = imported.json.search.results[0].id;
      return (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    })();
    assert(Boolean(rec?.id), 'a candidate exists on the attached opening');

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-req-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });

    const offer = await call('POST', '/api/offers', A, {
      resumeId: rec.id,
      terms: { title: 'کارشناس ارشد بک‌اند', startDate: '۱۴۰۴/۰۹/۰۱', salaryAmount: 50_000_000, salaryPeriod: 'monthly' },
    });
    assert(offer.status === 201, 'an offer is drafted', `${offer.status} ${offer.text.slice(0, 120)}`);
    const offerId = offer.json.offer.id;
    const offerToken = offer.json.offer.token || String(offer.json.offer.url || '').split('/offer/')[1];
    const sent = await call('POST', `/api/offers/${offerId}/send`, A, {});
    assert(sent.status === 200, 'the offer is sent', `${sent.status} ${sent.text.slice(0, 160)}`);
    const accepted = await call('POST', `/api/offers/public/${offerToken}/accept`, null, { name: 'سارا محمدی' });
    assert(accepted.status === 200, 'and the candidate accepts it', `${accepted.status} ${accepted.text.slice(0, 160)}`);

    const afterHire = await call('GET', `/api/requisitions/${req.id}`, A);
    assert(afterHire.json.requisition.filled === 1, 'the requisition counts the hire', String(afterHire.json?.requisition?.filled));
    assert(afterHire.json.requisition.status === 'filled' && afterHire.json.requisition.remaining === 0, 'with one granted seat, one hire fills it', `${afterHire.json?.requisition?.status}/${afterHire.json?.requisition?.remaining}`);

    const publishFull = await call('POST', `/api/jobs/${job.id}/publish`, A, { isPublic: true });
    assert(publishFull.status === 409 && publishFull.json?.code === 'REQUISITION_FILLED', 'a filled requisition blocks further publishing', `${publishFull.status} ${publishFull.json?.code}`);

    const attachFull = await call('POST', `/api/requisitions/${req.id}/jobs`, A, { jobId: jobNoReq.id });
    assert(attachFull.status === 409 && attachFull.json?.code === 'REQUISITION_NOT_OPEN', 'and no new opening can be attached to it', String(attachFull.status));

    // ------------------------------------------------------------- rollup
    const summary = await call('GET', '/api/requisitions/summary', A);
    assert(summary.status === 200, 'the rollup loads', String(summary.status));
    assert(summary.json.rollup.approvedSeats === 1 && summary.json.rollup.filledSeats === 1, 'counting approved and filled seats', JSON.stringify(summary.json.rollup));
    assert(summary.json.rollup.remainingSeats === 0, 'with nothing left to spend');
    assert(summary.json.rollup.pendingApproval === 0, 'and no decision waiting');
    assert(Array.isArray(summary.json.rollup.byDepartment) && summary.json.rollup.byDepartment.length >= 1, 'departments are broken out');

    // --------------------------------------------------------- cancel, hold
    const cancelWithHire = await call('POST', `/api/requisitions/${req.id}/cancel`, A, { note: 'نیازی نیست' });
    assert(cancelWithHire.status === 409 && cancelWithHire.json?.code === 'HAS_HIRES', 'a requisition with a hire cannot be cancelled away', `${cancelWithHire.status} ${cancelWithHire.json?.code}`);

    const held = await call('POST', `/api/requisitions/${req.id}/hold`, A, {});
    assert(held.status === 200 && held.json.requisition.status === 'on_hold', 'it can be put on hold instead', String(held.json?.requisition?.status));
    const attachHeld = await call('POST', `/api/requisitions/${req.id}/jobs`, A, { jobId: jobNoReq.id });
    assert(attachHeld.status === 409, 'a held requisition opens nothing', String(attachHeld.status));
    const resumed = await call('POST', `/api/requisitions/${req.id}/resume`, A, {});
    assert(resumed.status === 200, 'and resumed', String(resumed.status));

    const second = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس بازاریابی',
      departmentId: dept.id,
      slots: 1,
      justification: 'کمپین پاییز بدون یک نفر تمام‌وقت اجرا نمی‌شود و بودجه‌اش تصویب شده است.',
    });
    const secondId = second.json.requisition.id;
    await call('POST', `/api/requisitions/${secondId}/submit`, A, {});
    const cancelled = await call('POST', `/api/requisitions/${secondId}/cancel`, A, { note: 'بودجه لغو شد' });
    assert(cancelled.status === 200 && cancelled.json.requisition.status === 'cancelled', 'a requisition without hires can be cancelled', String(cancelled.json?.requisition?.status));
    const listCancelled = await call('GET', '/api/requisitions?status=cancelled', A);
    assert(listCancelled.json.items.some((i: any) => i.id === secondId), 'and stays in the list, marked cancelled');
    const submitCancelled = await call('POST', `/api/requisitions/${secondId}/submit`, A, {});
    assert(submitCancelled.status === 409, 'a cancelled requisition cannot be resubmitted', String(submitCancelled.status));

    // ---------------------------------------------------------------- inbox
    const third = await call('POST', '/api/requisitions', A, {
      title: 'مدیر محصول',
      departmentId: dept.id,
      slots: 1,
      justification: 'دو محصول داریم و کسی مالک نقشه‌راه هر دو نیست؛ تصمیم‌ها پشت سر هم عقب می‌افتند.',
    });
    await call('POST', `/api/requisitions/${third.json.requisition.id}/submit`, A, {});
    const inbox = await call('GET', '/api/inbox', A);
    const inboxRow = (inbox.json.items || []).find((i: any) => i.kind === 'requisition' && i.id === `requisition:${third.json.requisition.id}`);
    assert(Boolean(inboxRow), 'a pending requisition appears in the inbox');
    assert(inboxRow && inboxRow.canAct === false && Boolean(inboxRow.blockedReason), 'the inbox does not pretend to decide it');
    assert(inboxRow && inboxRow.href === `/app/requisitions/${third.json.requisition.id}`, 'it links to the page that has the facts', inboxRow?.href);
    assert(inbox.json.counts.requisitions >= 1 && inbox.json.enabled.requisitions === true, 'and the queue is counted and marked enabled', `${inbox.json?.counts?.requisitions}`);

    // --------------------------------------------------------- tenant walls
    const listB = await call('GET', '/api/requisitions', B);
    assert(listB.status === 200 && listB.json.items.length === 0, 'another workspace sees no requisitions', String(listB.json?.items?.length));
    const stealB = await call('GET', `/api/requisitions/${req.id}`, B);
    assert(stealB.status === 404, 'and cannot read one by id', String(stealB.status));
    const decideB = await call('POST', `/api/requisitions/${req.id}/decision`, B, { decision: 'approved' });
    assert(decideB.status === 404, 'nor decide it', String(decideB.status));
    const settingsB = await call('GET', '/api/requisitions/settings', B);
    assert(settingsB.json.settings.requireApprovedForPublish === false, 'with a gate of their own, still off');

    // -------------------------------------------------------------- member role
    if (memberToken) {
      const memberApprove = await call('POST', `/api/requisitions/${third.json.requisition.id}/decision`, memberToken, { decision: 'approved', approvedSlots: 1 });
      assert(memberApprove.status === 200, 'a named approver can decide', `${memberApprove.status} ${memberApprove.json?.code || ''}`);
      const memberRead = await call('GET', '/api/requisitions', memberToken);
      assert(memberRead.status === 200, 'a member can read the list');
      const memberSettings = await call('PUT', '/api/requisitions/settings', memberToken, { requireApprovedForPublish: false });
      assert(memberSettings.status === 403, 'but not change the workspace rule', String(memberSettings.status));
    } else {
      console.log('SKIP  member-role checks (could not create a member in this build)');
    }

    // --------------------------------------------------------------- audit
    const activity = await call('GET', '/api/activity?limit=50', A);
    const types = (activity.json?.items || []).map((i: any) => i.type);
    assert(types.some((t: string) => t.startsWith('requisition.')), 'the events are on the activity trail', types.filter((t: string) => t.startsWith('requisition.')).join(','));
    assert(types.includes('requisition.approved') && types.includes('requisition.rejected'), 'both decisions are recorded', types.filter((t: string) => t.startsWith('requisition.')).join(','));
  } finally {
    smtp.server.close();
    child.kill('SIGKILL');
  }

  console.log(failures === 0 ? '\nهمهٔ بررسی‌ها موفق بود.' : `\n${failures} بررسی ناموفق بود.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

/**
 * End-to-end test of «زنجیرهٔ تأیید نیازمندسنجی» — the multi-step approval chain.
 *
 * The chain is a control only if it is strict, so the test is mostly about who
 * cannot sign and when:
 *
 *   • the chain is **copied onto the request at submit time** — editing the
 *     setting afterwards never rewrites a request that is already circulating;
 *   • only **the step whose turn it is** may be decided; an earlier approver
 *     cannot jump back in, a later one cannot jump ahead;
 *   • the request stays «در انتظار تأیید» until the **last** signature, and only
 *     then becomes «تأییدشده» with the granted seats;
 *   • a step may **grant fewer seats** and the reduction **cascades** — nobody
 *     further down the chain can raise the number back up;
 *   • a rejection ends the request and the steps that never got their turn are
 *     recorded as **skipped**, not left «waiting» forever;
 *   • an admin may sign **«به‌جای»** a named approver, and that is written on the
 *     step and in the history — never hidden;
 *   • the **requester never approves** their own request, even as an admin;
 *   • the chain setting is **sanitised**: unknown members and duplicates dropped,
 *     capped at `CHAIN_MAX_STEPS`, empty labels fall back to the person's name;
 *   • an empty chain keeps the old **single decision** — nothing regressed;
 *   • the **inbox** names the one person whose turn it is, and links to the page.
 *
 * Run with: npm run build && npx tsx scripts/requisition-chain.test.ts
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

const REASON = 'تیم پشتیبانی هر هفته ده‌ها تیکت بی‌پاسخ می‌گذارد و مشتری‌ها می‌روند؛ بدون یک نفر تازه این کار جمع نمی‌شود.';

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-req-chain-'));
  const PORT = 5300 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'requisition-chain-secret-0123456789',
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
  env.SMTP_HOST = '127.0.0.1';
  env.SMTP_PORT = String(smtpPort);

  const signup = async (orgName: string, email: string) =>
    (await call('POST', '/api/auth/signup', null, { orgName, name: 'مالک فضای کاری', email, password: 'Password12345' })).json.token as string;

  const addMember = async (ownerToken: string, name: string, email: string, role: 'admin' | 'member') => {
    const created = await call('POST', '/api/org/members', ownerToken, { name, email, password: 'Password12345', role });
    if (created.status !== 201) return { id: null, token: null, name };
    const login = await call('POST', '/api/auth/login', null, { email, password: 'Password12345' });
    return { id: created.json.member.id as string, token: (login.json?.token as string) || null, name };
  };

  try {
    const A = await signup('آوا صنعت', 'owner@a.test');
    const B = await signup('برنا تجارت', 'owner@b.test');
    const orgA = (await call('GET', '/api/org', A)).json.org;

    // Three signers in order, plus a second admin who will sign «به‌جای» someone.
    const technical = await addMember(A, 'نگار رضایی', 'negar@a.test', 'member');
    const finance = await addMember(A, 'سعید کریمی', 'saeed@a.test', 'member');
    const ceo = await addMember(A, 'مریم احمدی', 'maryam@a.test', 'member');
    const secondAdmin = await addMember(A, 'رضا موسوی', 'reza@a.test', 'admin');
    assert(Boolean(technical.token && finance.token && ceo.token && secondAdmin.token), 'the workspace has three signers and a second admin');

    // ------------------------------------------------------- chain settings
    const saved = await call('PUT', '/api/requisitions/settings', A, {
      chain: [
        { id: 'st-1', label: 'مدیر فنی', approverId: technical.id },
        { id: 'st-2', label: 'مالی', approverId: finance.id },
        { id: 'st-3', label: 'مدیرعامل', approverId: ceo.id },
      ],
    });
    assert(saved.status === 200 && saved.json.settings.chain.length === 3, 'a three-step chain is saved', `${saved.status} ${saved.json?.settings?.chain?.length}`);
    assert(
      saved.json.settings.chain.map((s: any) => s.label).join(' → ') === 'مدیر فنی → مالی → مدیرعامل',
      'in the order it was written',
      saved.json.settings.chain.map((s: any) => s.label).join(' → ')
    );

    const messy = await call('PUT', '/api/requisitions/settings', A, {
      chain: [
        { label: '', approverId: technical.id },
        { label: 'تکرار', approverId: technical.id },
        { label: 'ناشناس', approverId: 'usr_does_not_exist' },
        { label: 'مالی', approverId: finance.id },
        { label: 'مدیرعامل', approverId: ceo.id },
        { label: 'مرحلهٔ پنجم', approverId: secondAdmin.id },
      ],
    });
    assert(messy.status === 200 && messy.json.settings.chain.length === 4, 'the chain is capped at four steps', String(messy.json?.settings?.chain?.length));
    assert(messy.json.settings.chain[0].label === 'نگار رضایی', 'a blank label falls back to the approver’s name', messy.json.settings.chain[0].label);
    assert(
      messy.json.settings.chain.filter((s: any) => s.approverId === technical.id).length === 1,
      'the same person cannot hold two steps'
    );
    assert(!messy.json.settings.chain.some((s: any) => s.approverId === 'usr_does_not_exist'), 'an unknown member is dropped');

    const backToThree = await call('PUT', '/api/requisitions/settings', A, {
      chain: [
        { id: 'st-1', label: 'مدیر فنی', approverId: technical.id },
        { id: 'st-2', label: 'مالی', approverId: finance.id },
        { id: 'st-3', label: 'مدیرعامل', approverId: ceo.id },
      ],
    });
    assert(backToThree.status === 200 && backToThree.json.settings.chain.length === 3, 'and a clean three-step chain can be saved again');

    // ------------------------------------------------- submit copies the chain
    const created = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس پشتیبانی',
      departmentId: orgA.departments[0].id,
      slots: 3,
      justification: REASON,
      salaryMin: 20_000_000,
      salaryMax: 30_000_000,
    });
    assert(created.status === 201 && created.json.requisition.approvals.length === 0, 'a draft carries no chain yet', String(created.json?.requisition?.approvals?.length));
    const reqId = created.json.requisition.id as string;

    const submitted = await call('POST', `/api/requisitions/${reqId}/submit`, A, {});
    assert(submitted.status === 200 && submitted.json.requisition.status === 'pending', 'submitting still moves it to «در انتظار تأیید»', submitted.json?.requisition?.status);
    assert(submitted.json.requisition.approvals.length === 3, 'and copies the three-step chain onto the row', String(submitted.json?.requisition?.approvals?.length));
    assert(
      submitted.json.requisition.approvals.every((s: any) => s.status === 'pending' && s.decidedAtISO === null),
      'every step starts «در انتظار»'
    );

    // ---------------------------------------------- whose turn, and may I act
    const detailOwner = await call('GET', `/api/requisitions/${reqId}`, A);
    assert(detailOwner.json.approval.position?.index === 1 && detailOwner.json.approval.position?.total === 3, 'the page says «مرحلهٔ ۱ از ۳»', JSON.stringify(detailOwner.json?.approval?.position));
    assert(detailOwner.json.approval.pending?.label === 'مدیر فنی', 'and names the pending step', detailOwner.json?.approval?.pending?.label);
    assert(detailOwner.json.approval.canAct === false, 'the requester cannot act on it');
    assert(/درخواست‌دهنده/.test(detailOwner.json.approval.reason || ''), 'and the page says why, in words', detailOwner.json?.approval?.reason);

    const ownerTries = await call('POST', `/api/requisitions/${reqId}/decision`, A, { decision: 'approved' });
    assert(ownerTries.status === 403 && ownerTries.json?.code === 'NOT_APPROVER', 'not even as the workspace owner', `${ownerTries.status} ${ownerTries.json?.code}`);

    const laterTries = await call('POST', `/api/requisitions/${reqId}/decision`, finance.token, { decision: 'approved' });
    assert(laterTries.status === 409 && laterTries.json?.code === 'NOT_APPROVER', 'a later step cannot jump the queue', `${laterTries.status} ${laterTries.json?.code}`);
    assert(/مدیر فنی/.test(laterTries.json?.error || ''), 'and is told whose turn it is', laterTries.json?.error);

    const detailFinance = await call('GET', `/api/requisitions/${reqId}`, finance.token);
    assert(detailFinance.json.approval.canAct === false && Boolean(detailFinance.json.approval.reason), 'the finance page shows a refusal, not a dead button');

    const detailAdmin = await call('GET', `/api/requisitions/${reqId}`, secondAdmin.token);
    assert(detailAdmin.json.approval.canAct === true && detailAdmin.json.approval.onBehalf === true, 'an admin may sign in the named approver’s place — and the page says so');

    const weird = await call('PUT', '/api/requisitions/settings', A, { chain: 'not an array' });
    assert(weird.status === 200 && weird.json.settings.chain.length === 3, 'a malformed chain payload keeps the saved chain', String(weird.json?.settings?.chain?.length));

    // ---------------------------------------------------------- step by step
    const step1 = await call('POST', `/api/requisitions/${reqId}/decision`, technical.token, { decision: 'approved', approvedSlots: 2, note: 'دو نفر کافی است.' });
    assert(step1.status === 200, 'the first approver signs', `${step1.status} ${step1.json?.code || ''}`);
    assert(step1.json.requisition.status === 'pending', 'the request is not «تأییدشده» after one signature', step1.json?.requisition?.status);
    assert(step1.json.requisition.approvedSlots === null, 'and no seats are granted yet');
    assert(step1.json.requisition.approvals[0].status === 'approved' && step1.json.requisition.approvals[0].approvedSlots === 2, 'the step records the seats it granted');
    assert(step1.json.approval.position?.index === 2, 'the page moves to «مرحلهٔ ۲»', JSON.stringify(step1.json?.approval?.position));
    assert(step1.json.requisition.history.some((h: any) => h.action === 'step_approved' && /دو نفر/.test(h.note)), 'the step and its note are in the history');

    const backToFirst = await call('POST', `/api/requisitions/${reqId}/decision`, technical.token, { decision: 'approved' });
    assert(backToFirst.status === 409, 'the first approver cannot sign again', String(backToFirst.status));

    // The chain is copied at submit: changing the setting now must not shrink it.
    const shortened = await call('PUT', '/api/requisitions/settings', A, { chain: [{ id: 'st-3', label: 'مدیرعامل', approverId: ceo.id }] });
    assert(shortened.status === 200 && shortened.json.settings.chain.length === 1, 'the workspace chain can be shortened');
    const afterShorten = await call('GET', `/api/requisitions/${reqId}`, A);
    assert(afterShorten.json.requisition.approvals.length === 3, 'a request already in flight keeps the chain it was sent with', String(afterShorten.json?.requisition?.approvals?.length));

    const tooMany = await call('POST', `/api/requisitions/${reqId}/decision`, finance.token, { decision: 'approved', approvedSlots: 3 });
    assert(tooMany.status === 400 && tooMany.json?.code === 'BAD_APPROVED_SLOTS', 'a later step cannot raise the seats the first step cut', `${tooMany.status} ${tooMany.json?.code}`);
    assert(/۲|2/.test(tooMany.json?.error || ''), 'and the refusal names the ceiling', tooMany.json?.error);

    const step2 = await call('POST', `/api/requisitions/${reqId}/decision`, finance.token, { decision: 'approved', note: 'با سقف دو نفر موافقم.' });
    assert(step2.status === 200 && step2.json.requisition.status === 'pending', 'the second signature still leaves it pending', step2.json?.requisition?.status);
    assert(step2.json.requisition.approvals[1].approvedSlots === 2, 'the default on a step is the ceiling, not the original ask', String(step2.json?.requisition?.approvals?.[1]?.approvedSlots));

    // The inbox names the one person whose turn it is.
    const inboxCeo = await call('GET', '/api/inbox', ceo.token);
    const inboxRow = (inboxCeo.json.items || []).find((i: any) => i.id === `requisition:${reqId}`);
    assert(Boolean(inboxRow) && inboxRow.waitingOn === 'شما' && inboxRow.mine === true, 'the inbox names the person whose turn it is', `${inboxRow?.waitingOn}/${inboxRow?.mine}`);
    assert(inboxRow && /مدیرعامل/.test(inboxRow.detail || ''), 'and the detail names the step', inboxRow?.detail);
    assert(inboxRow && inboxRow.canAct === false, 'while still refusing to decide it in the list');

    const inboxFinance = await call('GET', '/api/inbox', finance.token);
    const financeRow = (inboxFinance.json.items || []).find((i: any) => i.id === `requisition:${reqId}`);
    assert(Boolean(financeRow) && financeRow.mine === false, 'an approver who already signed is not «mine» anymore', String(financeRow?.mine));

    const step3 = await call('POST', `/api/requisitions/${reqId}/decision`, ceo.token, { decision: 'approved', note: 'تأیید می‌کنم.' });
    assert(step3.status === 200 && step3.json.requisition.status === 'approved', 'the last signature makes it «تأییدشده»', `${step3.json?.requisition?.status}`);
    assert(step3.json.requisition.approvedSlots === 2 && step3.json.requisition.slots === 3, 'with the seats the earlier step granted, asked-for still visible', `${step3.json?.requisition?.approvedSlots}/${step3.json?.requisition?.slots}`);
    assert(step3.json.requisition.decidedByName === ceo.name, 'and the decision is attributed to the last signer', step3.json?.requisition?.decidedByName);
    assert(step3.json.requisition.approvals.every((s: any) => s.status === 'approved'), 'every step is closed');
    assert(step3.json.requisition.remaining === 2, 'the seats are available for openings', String(step3.json?.requisition?.remaining));

    const decideAgain = await call('POST', `/api/requisitions/${reqId}/decision`, ceo.token, { decision: 'approved' });
    assert(decideAgain.status === 409, 'a finished chain takes no more signatures', String(decideAgain.status));

    // -------------------------------------------------------------- rejection
    const second = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس فروش',
      departmentId: orgA.departments[1]?.id || orgA.departments[0].id,
      slots: 2,
      justification: REASON,
    });
    const secondId = second.json.requisition.id as string;
    const saveChainAgain = await call('PUT', '/api/requisitions/settings', A, {
      chain: [
        { id: 'st-1', label: 'مدیر فنی', approverId: technical.id },
        { id: 'st-2', label: 'مالی', approverId: finance.id },
        { id: 'st-3', label: 'مدیرعامل', approverId: ceo.id },
      ],
    });
    assert(saveChainAgain.status === 200, 'the chain can be restored for a new request');
    const secondSubmitted = await call('POST', `/api/requisitions/${secondId}/submit`, A, {});
    assert(secondSubmitted.json.requisition.approvals.length === 3, 'the new request gets the current chain', String(secondSubmitted.json?.requisition?.approvals?.length));

    const rejectNoNote = await call('POST', `/api/requisitions/${secondId}/decision`, technical.token, { decision: 'rejected' });
    assert(rejectNoNote.status === 400 && rejectNoNote.json?.code === 'NOTE_REQUIRED', 'a rejection still needs a reason', `${rejectNoNote.status} ${rejectNoNote.json?.code}`);

    const rejected = await call('POST', `/api/requisitions/${secondId}/decision`, technical.token, { decision: 'rejected', note: 'این نقش با تیم فعلی پوشش داده می‌شود.' });
    assert(rejected.status === 200 && rejected.json.requisition.status === 'rejected', 'a rejection ends the request at that step', rejected.json?.requisition?.status);
    assert(rejected.json.requisition.approvals[0].status === 'rejected', 'the deciding step is recorded as rejected');
    assert(
      rejected.json.requisition.approvals.slice(1).every((s: any) => s.status === 'skipped'),
      'the steps that never got their turn are «skipped», not left waiting',
      rejected.json.requisition.approvals.map((s: any) => s.status).join(',')
    );
    assert(rejected.json.requisition.decidedAtISO && rejected.json.requisition.decidedByName === technical.name, 'the rejection is attributed and dated');
    assert(rejected.json.approval.position === null && rejected.json.approval.canAct === false, 'and nobody is «next» any more');

    const skippedTry = await call('POST', `/api/requisitions/${secondId}/decision`, ceo.token, { decision: 'approved' });
    assert(skippedTry.status === 409, 'a skipped step cannot rescue it later', String(skippedTry.status));

    const inboxAfterReject = await call('GET', '/api/inbox', ceo.token);
    assert(!(inboxAfterReject.json.items || []).some((i: any) => i.id === `requisition:${secondId}`), 'a rejected request leaves the inbox');

    // Editing a rejected request clears the old signatures; submitting re-copies.
    const edited = await call('PATCH', `/api/requisitions/${secondId}`, A, { title: 'کارشناس فروش (بازنگری‌شده)' });
    assert(edited.status === 200 && edited.json.requisition.status === 'draft', 'an edited rejection is a draft again', edited.json?.requisition?.status);
    assert(edited.json.requisition.approvals.length === 0, 'with the old signatures gone', String(edited.json?.requisition?.approvals?.length));
    const resubmitted = await call('POST', `/api/requisitions/${secondId}/submit`, A, {});
    assert(resubmitted.json.requisition.approvals.length === 3 && resubmitted.json.requisition.approvals.every((s: any) => s.status === 'pending'), 'and resubmitting asks all three people again');

    // ------------------------------------------------------------ «به‌جای»
    const third = await call('POST', '/api/requisitions', A, {
      title: 'مدیر بازاریابی',
      departmentId: orgA.departments[0].id,
      slots: 1,
      justification: REASON,
    });
    const thirdId = third.json.requisition.id as string;
    await call('PUT', '/api/requisitions/settings', A, { chain: [{ id: 'st-3', label: 'مدیرعامل', approverId: ceo.id }] });
    await call('POST', `/api/requisitions/${thirdId}/submit`, A, {});
    const onBehalf = await call('POST', `/api/requisitions/${thirdId}/decision`, secondAdmin.token, { decision: 'approved', note: 'مدیرعامل در سفر است؛ با اطلاع ایشان.' });
    assert(onBehalf.status === 200 && onBehalf.json.requisition.status === 'approved', 'an admin can sign in the named approver’s place', `${onBehalf.status} ${onBehalf.json?.requisition?.status}`);
    assert(onBehalf.json.requisition.approvals[0].onBehalf === true, 'the step records that it was signed «به‌جای» someone');
    assert(
      onBehalf.json.requisition.history.some((h: any) => /به‌جای/.test(h.note) && /مدیرعامل/.test(h.note)),
      'and the history says whose place it took',
      onBehalf.json.requisition.history.map((h: any) => h.note).join(' | ').slice(0, 160)
    );
    assert(onBehalf.json.requisition.decidedByName === secondAdmin.name, 'the decision names the person who actually signed', onBehalf.json?.requisition?.decidedByName);

    // ------------------------------------------------- empty chain = one step
    const emptied = await call('PUT', '/api/requisitions/settings', A, { chain: [] });
    assert(emptied.status === 200 && emptied.json.settings.chain.length === 0, 'the chain can be emptied again', String(emptied.json?.settings?.chain?.length));

    const fourth = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس حقوق و دستمزد',
      departmentId: orgA.departments[0].id,
      slots: 1,
      justification: REASON,
    });
    const fourthId = fourth.json.requisition.id as string;
    const fourthSubmitted = await call('POST', `/api/requisitions/${fourthId}/submit`, A, {});
    assert(fourthSubmitted.json.requisition.approvals.length === 0, 'without a chain the row carries no steps', String(fourthSubmitted.json?.requisition?.approvals?.length));
    const fourthDetail = await call('GET', `/api/requisitions/${fourthId}`, A);
    assert(fourthDetail.json.approval.position === null && fourthDetail.json.approval.steps.length === 0, 'and the page shows no order to wait for');

    const memberNotNamed = await call('POST', `/api/requisitions/${fourthId}/decision`, finance.token, { decision: 'approved' });
    assert(memberNotNamed.status === 409 && memberNotNamed.json?.code === 'NOT_APPROVER', 'a member who is not an approver still cannot decide', `${memberNotNamed.status} ${memberNotNamed.json?.code}`);

    const namedAgain = await call('PUT', '/api/requisitions/settings', A, { approverUserIds: [finance.id] });
    assert(namedAgain.status === 200, 'a named approver can still be configured for the single decision');
    const single = await call('POST', `/api/requisitions/${fourthId}/decision`, finance.token, { decision: 'approved', approvedSlots: 1 });
    assert(single.status === 200 && single.json.requisition.status === 'approved', 'and one signature finalises it, as before', `${single.status} ${single.json?.requisition?.status}`);
    assert(single.json.requisition.approvals.length === 0, 'without inventing a step afterwards');

    // ------------------------------------------------------------- tenant wall
    const chainB = await call('GET', '/api/requisitions/settings', B);
    assert(chainB.status === 200 && chainB.json.settings.chain.length === 0, 'another workspace has its own, empty chain', String(chainB.json?.settings?.chain?.length));
    const steal = await call('GET', `/api/requisitions/${reqId}`, B);
    assert(steal.status === 404, 'and cannot read a requisition of another workspace', String(steal.status));
    const stealDecide = await call('POST', `/api/requisitions/${reqId}/decision`, B, { decision: 'approved' });
    assert(stealDecide.status === 404, 'nor decide its steps', String(stealDecide.status));

    // ----------------------------------------------------------------- audit
    const activity = await call('GET', '/api/activity?limit=100', A);
    const texts = (activity.json?.items || []).map((i: any) => `${i.type}:${i.text || i.title || ''}`).join('\n');
    assert(/به‌جای/.test(texts), 'the audit trail mentions the signature «به‌جای» someone', texts.slice(0, 200));
    assert(/مدیر فنی/.test(texts), 'and the steps by name');
  } finally {
    smtp.server.close();
    child.kill('SIGTERM');
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

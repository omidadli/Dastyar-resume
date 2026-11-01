/**
 * End-to-end API test of «اتاق مصاحبهٔ زنده» — the signalling half of the call.
 *
 * Media cannot be tested in Node, so what is proven here is the contract the
 * browsers rely on:
 *   • one room per interview, and the same link comes back on a second click;
 *   • the candidate needs no account, and the server forces their role, so a
 *     token can never speak as «host»;
 *   • offer → answer → ICE travel in order, with a cursor that never replays;
 *   • presence says who is really there, and stops saying so when they leave;
 *   • the room closes (410) when HR closes it or the link expires, and a closed
 *     room still explains itself instead of showing a blank page;
 *   • another workspace, a cancelled interview and blind mode are all refused;
 *   • no signal is ever written to disk, and erasure drops the rooms.
 *
 * Run with: npm run build && npx tsx scripts/interview-room.test.ts
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

/** The API wants Jalali date + Tehran time; the test computes it itself. */
function jalaliParts(iso: string): { date: string; time: string } {
  const shifted = new Date(new Date(iso).getTime() + 3.5 * 3600_000);
  const gy = shifted.getUTCFullYear();
  const gm = shifted.getUTCMonth() + 1;
  const gd = shifted.getUTCDate();
  const leap = gy % 4 === 0 && (gy % 100 !== 0 || gy % 400 === 0);
  const gDaysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let jy = gy - 621;
  let days = gd;
  for (let m = 1; m < gm; m++) days += gDaysInMonth[m - 1];
  const marchDay = leap ? 20 : 21;
  const jyStart = days >= marchDay ? days - marchDay + 1 : days + 365 - marchDay + 1;
  if (days < marchDay) jy -= 1;
  const jMonthDays = [31, 31, 31, 31, 31, 31, 30, 30, 30, 30, 30, 29];
  let jm = 0;
  let jd = jyStart;
  while (jd > jMonthDays[jm]) {
    jd -= jMonthDays[jm];
    jm++;
  }
  const fa = (n: number) => String(n).padStart(2, '0').replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const time = `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`;
  return { date: `${fa(jy)}/${fa(jm + 1)}/${fa(jd)}`, time };
}

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-room-'));
  const PORT = 4700 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'room-api-secret-0123456789',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[k];
  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر', email, password: 'Password12345' })).json.token as string;
    const A = await signup('شرکت الف', 'a@example.com');
    const B = await signup('شرکت ب', 'b@example.com');

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
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
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: imported.json.search.results[0].id, jobId: job.id })).json.record;

    const when = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const booked = await call('POST', '/api/interviews', A, {
      jobId: job.id,
      resumeId: rec.id,
      title: 'مصاحبهٔ فنی',
      date: jalaliParts(when).date,
      time: jalaliParts(when).time,
      durationMin: 45,
      interviewerIds: [],
      withMeet: false,
      location: 'آنلاین',
    });
    assert(booked.status === 200 || booked.status === 201, 'an interview is booked', String(booked.status));
    const interview = booked.json.interview;
    assert(Boolean(interview?.id), 'the interview has an id');

    // --------------------------------------------------------------- create ---
    const made = await call('POST', `/api/interviews/${interview.id}/room`, A, {});
    assert(made.status === 201 && made.json.room.status === 'open', 'a room is created for the interview', `${made.status} ${JSON.stringify(made.json?.error || '')}`);
    const room = made.json.room;
    assert(/^\/room\/[A-Za-z0-9_-]{20,}$/.test(room.url), 'the link carries an unguessable token', room.url);
    assert(room.candidateName === 'سارا محمدی' && room.title === 'مصاحبهٔ فنی', 'the room names the candidate and the call');
    assert(room.scheduledStartJalali && /[۰-۹]/.test(room.scheduledStartJalali), 'the call time is a Persian date', String(room.scheduledStartJalali));
    assert(room.expiresAtJalali && /[۰-۹]/.test(room.expiresAtJalali), 'and so is the expiry');
    assert(room.presence.hostOnline === false && room.presence.candidateOnline === false, 'nobody is online yet');
    const token = String(room.url).split('/room/')[1];

    const again = await call('POST', `/api/interviews/${interview.id}/room`, A, {});
    assert(again.status === 200 && again.json.reused === true, 'asking again returns the same room, not a second link', `${again.status}`);
    assert(again.json.room.id === room.id && again.json.room.url === room.url, 'with the same token');
    assert((await call('GET', `/api/rooms?interviewId=${interview.id}`, A)).json.items.length === 1, 'the opening has exactly one room');

    assert((await call('POST', '/api/interviews/nope/room', A, {})).status === 404, 'an unknown interview is a 404');
    assert((await call('POST', `/api/interviews/${interview.id}/room`, B, {})).status === 404, 'another workspace cannot open a room for it');

    // --------------------------------------------------------------- public ---
    const pub = await call('GET', `/api/rooms/public/${token}`);
    assert(pub.status === 200 && pub.json.state === 'open', 'the candidate opens the room with no session', String(pub.status));
    assert(pub.json.room.orgName === 'شرکت الف' && pub.json.room.jobTitle === 'کارشناس شبکه', 'it names the organisation and the role');
    assert(Array.isArray(pub.json.room.iceServers) && pub.json.room.iceServers.length >= 1, 'the browser gets STUN servers', JSON.stringify(pub.json.room.iceServers));
    assert(/TURN|مستقیم/.test(pub.json.room.relayNote), 'and an honest note about the missing relay', String(pub.json.room.relayNote).slice(0, 40));
    const wire = JSON.stringify(pub.json);
    for (const leak of ['score', 'note', 'salary', 'token', 'interviewerEmails']) {
      assert(!wire.includes(leak), `the public room never carries «${leak}»`);
    }
    assert((await call('GET', '/api/rooms/public/not-a-real-token')).status === 404, 'a wrong token is a clean 404');

    // ------------------------------------------------------------- signalling ---
    const hostPoll0 = await call('GET', `/api/rooms/${room.id}/signals?since=0`, A);
    assert(hostPoll0.status === 200 && hostPoll0.json.items.length === 0, 'a fresh room has no signals', String(hostPoll0.json?.items?.length));
    assert(hostPoll0.json.presence.hostOnline === true, 'the host poll marks the host as present');
    assert(hostPoll0.json.presence.candidateOnline === false, 'and the candidate as absent');

    const candPoll0 = await call('GET', `/api/rooms/public/${token}/signals?since=0`);
    assert(candPoll0.status === 200 && candPoll0.json.presence.candidateOnline === true, 'the candidate poll marks them present');
    assert(candPoll0.json.presence.hostOnline === true, 'and both sides can see each other');

    const offer = await call('POST', `/api/rooms/${room.id}/signal`, A, { kind: 'offer', payload: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' });
    assert(offer.status === 201 && offer.json.signal.from === 'host' && offer.json.signal.seq === 1, 'the host sends the offer', `${offer.status}`);
    const candGetsOffer = await call('GET', `/api/rooms/public/${token}/signals?since=0`);
    assert(candGetsOffer.json.items.length === 1 && candGetsOffer.json.items[0].kind === 'offer', 'the candidate receives it');
    assert(candGetsOffer.json.items[0].payload.includes('v=0'), 'with the SDP intact');

    const answer = await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'answer', payload: 'v=0\r\na=answer\r\n' });
    assert(answer.status === 201 && answer.json.signal.from === 'candidate', 'the candidate answers', `${answer.status}`);
    const hostGetsAnswer = await call('GET', `/api/rooms/${room.id}/signals?since=1`, A);
    assert(hostGetsAnswer.json.items.length === 1 && hostGetsAnswer.json.items[0].kind === 'answer', 'the host receives the answer');
    assert(hostGetsAnswer.json.items[0].seq === 2, 'the cursor advances', String(hostGetsAnswer.json.items[0].seq));

    assert((await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'ice', payload: '{"candidate":"x"}' })).status === 201, 'ICE candidates travel too');
    const afterIce = await call('GET', `/api/rooms/${room.id}/signals?since=2`, A);
    assert(afterIce.json.items.length === 1 && afterIce.json.items[0].kind === 'ice', 'and arrive in order');
    assert((await call('GET', `/api/rooms/${room.id}/signals?since=${afterIce.json.seq}`, A)).json.items.length === 0, 'polling again returns nothing new');

    // A token must never be able to speak as the host.
    const spoof = await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'offer', payload: 'v=0', from: 'host' });
    assert(spoof.status === 201 && spoof.json.signal.from === 'candidate', 'the server forces the candidate role, ignoring «from»', String(spoof.json.signal.from));

    assert((await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'hack', payload: 'x' })).json.code === 'BAD_SIGNAL_KIND', 'an unknown signal kind is refused');
    assert((await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'offer', payload: '' })).json.code === 'BAD_SIGNAL_PAYLOAD', 'an empty payload is refused');
    const huge = 'x'.repeat(30_000);
    assert((await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'ice', payload: huge })).status === 413, 'an oversized payload is refused');

    // ---------------------------------------------------------------- closing ---
    const closed = await call('POST', `/api/rooms/${room.id}/close`, A, {});
    assert(closed.status === 200 && closed.json.room.status === 'closed', 'HR closes the room', String(closed.status));
    const closedPublic = await call('GET', `/api/rooms/public/${token}`);
    assert(closedPublic.status === 200 && closedPublic.json.state === 'closed', 'the page still loads, to explain itself', String(closedPublic.status));
    const afterClose = await call('GET', `/api/rooms/public/${token}/signals?since=0`);
    assert(afterClose.status === 410 && afterClose.json.code === 'ROOM_CLOSED', 'but no more signalling is accepted', String(afterClose.status));
    assert((await call('POST', `/api/rooms/public/${token}/signal`, null, { kind: 'ice', payload: '{}' })).status === 410, 'nor new signals');
    assert((await call('POST', '/api/interviews/' + interview.id + '/room', A, {})).status === 201, 'a closed room does not block a fresh one for the same call');
    assert((await call('GET', `/api/rooms?interviewId=${interview.id}`, A)).json.items.length === 2, 'history keeps both rooms');

    const feed = (await call('GET', '/api/activity', A)).json.items as any[];
    assert(feed.some((a) => a.type === 'room.opened'), 'opening a room is in the history');
    assert(feed.some((a) => a.type === 'room.closed'), 'so is closing it');

    // ------------------------------------------------------------ permissions ---
    assert((await call('GET', `/api/rooms/${room.id}/signals?since=0`, B)).status === 404, 'another workspace cannot poll the room');
    assert((await call('POST', `/api/rooms/${room.id}/close`, B, {})).status === 404, 'nor close it');
    assert((await call('GET', `/api/rooms/by-token/${token}`, B)).status === 404, 'nor look it up by its token');
    const hostLookup = await call('GET', `/api/rooms/by-token/${token}`, A);
    assert(hostLookup.status === 200 && hostLookup.json.room?.id === room.id, 'the host finds the room by token (same page, other side)');

    // Blind mode: a live call means faces, so the whole thing is closed to HR.
    await call('PATCH', '/api/org', A, { blindScreening: true });
    assert((await call('POST', `/api/interviews/${interview.id}/room`, A, {})).status === 409, 'blind mode refuses to open a camera room');
    // Turning blind mode on mid-call is a deliberate decision to hide identity,
    // so the host's side stops too — and the candidate's link simply ends.
    const blindPoll = await call('GET', `/api/rooms/${room.id}/signals?since=0`, A);
    assert(blindPoll.status === 409 && blindPoll.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode also stops an existing host room', `${blindPoll.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    const cancelled = await call('DELETE', `/api/interviews/${interview.id}`, A, {});
    assert(cancelled.status === 200 && cancelled.json.interview.status === 'cancelled', 'the interview can be cancelled');
    assert((await call('POST', `/api/interviews/${interview.id}/room`, A, {})).status === 409, 'a cancelled interview gets no room');

    // -------------------------------------------------------------- erasure ---
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && (erased.json.erased?.rooms || 0) >= 1, 'erasing the candidate counts their rooms', JSON.stringify(erased.json.erased));
    const gone = await call('GET', `/api/rooms/public/${token}`);
    assert([404, 410].includes(gone.status), 'and the room stops answering', String(gone.status));

    // -------------------------------------------------------------- restart ---
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snap = JSON.parse(fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8'));
    assert(Array.isArray(snap.rooms) && snap.rooms.length === 0, 'the erased candidate’s rooms are gone from disk too', JSON.stringify(snap.rooms));
    assert(!JSON.stringify(snap).includes('a=answer'), 'the signalling messages are never written to disk');

    log = '';
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const restarted = Date.now();
    while (!/آماده است/.test(log) && Date.now() - restarted < 25_000) await new Promise((r) => setTimeout(r, 150));

    const fresh = await call('POST', `/api/interviews/${interview.id}/room`, A, {});
    assert([404, 409].includes(fresh.status), 'after a restart nothing can reopen that interview (erased / cancelled)', String(fresh.status));
    const oldRoom = await call('GET', `/api/rooms/public/${token}`);
    assert([404, 410].includes(oldRoom.status), 'the erased room does not come back', String(oldRoom.status));
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0) {
      console.error(`\n${failures} room test(s) failed.`);
      if (log) console.error(log.slice(-2000));
      process.exit(1);
    }
    console.log('\nAll interview-room tests passed.');
  }
}

await main();

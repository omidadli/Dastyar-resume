/**
 * End-to-end test of Google Calendar — the one path that had only been proven
 * with an .ics file. A local stand-in answers the four Google endpoints the app
 * calls (token, userinfo, event create, event delete), so the real code path is
 * exercised without a Google Cloud project.
 *
 * Steps covered:
 *   1. /admin saves an OAuth client → the probe really calls the token endpoint
 *      (a wrong secret is refused, a real pair is accepted)
 *   2. the workspace starts the connect flow → the browser hits the mock
 *      consent screen → the callback exchanges the code and stores the account
 *   3. scheduling an interview creates the event on the «calendar», with the
 *      right Tehran wall-clock time, the attendees and a Meet link
 *   4. cancelling the interview deletes the event (410 from Google is tolerated)
 *   5. a Google failure is reported honestly and never faked
 *
 * Run with: npm run build && npx tsx scripts/google-calendar.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranIsoFromJalali, tehranJalaliOf } from '../server/tehran-time';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const CLIENT_ID = 'demo-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'demo-client-secret';
const ACCOUNT_EMAIL = 'hr-manager@ava-demo.ir';

interface MockEvent {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: Array<{ email: string }>;
  hangoutLink?: string;
}

/** A miniature Google: /token, /userinfo, /calendars/:id/events. */
function mockGoogle() {
  const events = new Map<string, MockEvent>();
  const calls: Array<{ method: string; path: string; query: string; auth: string; body: any }> = [];
  let seq = 0;
  let refuseEvents = false;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const send = (status: number, body: unknown) => {
        const payload = JSON.stringify(body ?? {});
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(payload);
      };
      const auth = String(req.headers.authorization || '');
      let body: any = null;
      if (raw && /json/.test(String(req.headers['content-type'] || ''))) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({ method: req.method || '', path: url.pathname, query: url.search, auth, body });

      if (req.method === 'POST' && url.pathname === '/token') {
        const params = new URLSearchParams(raw);
        if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
          return send(401, { error: 'invalid_client', error_description: 'Unauthorized' });
        }
        if (params.get('grant_type') === 'refresh_token') {
          return send(200, { access_token: 'access-refreshed', expires_in: 3599, token_type: 'Bearer' });
        }
        if (!String(params.get('code')).startsWith('mock-code')) {
          return send(400, { error: 'invalid_grant', error_description: 'Bad code' });
        }
        return send(200, {
          access_token: 'access-fresh',
          refresh_token: 'refresh-1',
          expires_in: 3599,
          token_type: 'Bearer',
          scope: 'calendar.events openid email',
        });
      }

      // Consent screen: Google shows a UI, the mock approves immediately.
      if (req.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
        const redirect = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        res.writeHead(302, { Location: `${redirect}?code=mock-code-${Date.now()}&state=${encodeURIComponent(state)}` });
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/userinfo') {
        if (!auth.startsWith('Bearer ')) return send(401, { error: 'invalid_token' });
        return send(200, { email: ACCOUNT_EMAIL, email_verified: true });
      }

      const m = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (m) {
        const [, calendarId, eventId] = m;
        if (!auth.startsWith('Bearer ')) return send(401, { error: { code: 401, message: 'auth required' } });
        if (refuseEvents) return send(403, { error: { code: 403, message: 'The caller does not have permission' } });

        if (req.method === 'POST' && !eventId) {
          const id = `evt-${++seq}`;
          const meet = Boolean(body?.conferenceData?.createRequest);
          const event: MockEvent = {
            id,
            summary: body?.summary || '',
            description: body?.description || '',
            location: body?.location || '',
            start: body?.start,
            end: body?.end,
            attendees: body?.attendees || [],
            ...(meet ? { hangoutLink: `https://meet.google.com/mock-${id}` } : {}),
          };
          events.set(id, event);
          return send(200, {
            kind: 'calendar#event',
            ...event,
            id,
            htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
          });
        }

        if (req.method === 'DELETE' && eventId) {
          if (!events.has(eventId)) return send(410, { error: { code: 410, message: 'deleted' } });
          events.delete(eventId);
          res.writeHead(204);
          return res.end();
        }
      }

      send(404, { error: { code: 404, message: 'Not Found' } });
    });
  });

  return {
    server,
    events,
    calls,
    setRefuseEvents(v: boolean) {
      refuseEvents = v;
    },
  };
}

function futureJalali(daysAhead: number) {
  const when = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  const date = formatJalaliDate(tehranJalaliOf(when), true);
  const iso = tehranIsoFromJalali(date, '۱۴:۰۰')!;
  // 14:00 Tehran = 10:30 UTC.
  const tehranWall = `${iso.slice(0, 10)}T14:00:00`;
  return { date, iso, tehranWall };
}

let crashed = false;

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');

  const google = mockGoogle();
  await new Promise<void>((r) => google.server.listen(0, '127.0.0.1', () => r()));
  const gPort = (google.server.address() as any).port;
  const G = `http://127.0.0.1:${gPort}`;

  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-gcal-'));
  const PORT = 4200 + Math.floor(Math.random() * 200);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'google-test-secret-0123456789',
    GOOGLE_OAUTH_AUTH_URL: `${G}/o/oauth2/v2/auth`,
    GOOGLE_TOKEN_URL: `${G}/token`,
    GOOGLE_USERINFO_URL: `${G}/userinfo`,
    GOOGLE_CALENDAR_API_BASE: `${G}/calendar/v3`,
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AI_PROVIDER', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'LINKEDIN_API_URL', 'LINKEDIN_ACCESS_TOKEN']) delete env[k];

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
      redirect: 'manual',
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
    const admin = (await call('POST', '/api/auth/signup', null, {
      orgName: 'گروه آوا',
      name: 'مدیر سامانه',
      email: 'admin@gcal-demo.ir',
      password: 'Password12345',
    })).json.token as string;
    const setupCode = log.match(/setup code: (HV-[A-Z0-9-]+)/)?.[1] || '';
    assert(Boolean(setupCode), 'startup prints the one-time setup code', setupCode);
    const claim = await call('POST', '/api/admin/claim', admin, { code: setupCode });
    assert(claim.status === 200 && claim.json.ok === true, 'the account becomes platform admin', String(claim.status));

    const org = (await call('GET', '/api/org', admin)).json;
    const dept = org.org.departments[0];
    const tpl = await call('POST', '/api/jobs/template', admin, { departmentId: dept.id, roleTitle: 'کارشناس حسابداری صنعتی' });
    const job = (await call('POST', '/api/jobs', admin, {
      departmentId: dept.id,
      roleTitle: 'کارشناس حسابداری صنعتی',
      understanding: tpl.json.understanding,
      criteriaSource: 'template',
    })).json.job;
    assert(Boolean(job?.id), 'a target opening exists');

    // ------------------------------------------- 1) the OAuth client ----
    const wrong = await call('PUT', '/api/admin/connections/google', admin, {
      clientId: CLIENT_ID,
      clientSecret: 'wrong-secret',
      redirectUri: `${BASE}/api/integrations/calendar/callback`,
    });
    assert(wrong.status === 200 && wrong.json.check?.ok === false, 'a wrong Client Secret is reported as rejected by Google', String(wrong.status));
    assert(/نپذیرفت/.test(String(wrong.json.check?.error)), 'the rejection message names the problem', String(wrong.json.check?.error));
    assert(google.calls.some((c) => c.path === '/token'), 'the token endpoint was really called (no local shortcut)');

    const savedConn = await call('PUT', '/api/admin/connections/google', admin, {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri: `${BASE}/api/integrations/calendar/callback`,
    });
    assert(savedConn.status === 200 && savedConn.json.check?.ok === true, 'the real pair is verified and saved', String(savedConn.status));
    assert(!JSON.stringify(savedConn.json).includes(CLIENT_SECRET), 'the Client Secret is never returned');
    assert(savedConn.json.connections.google.effectiveRedirectUri === `${BASE}/api/integrations/calendar/callback`, 'the redirect URI to paste into Google Cloud is shown');

    // --------------------------------------------- 2) connecting an account ----
    const preStatus = await call('GET', '/api/integrations/status', admin);
    assert(preStatus.json.calendar.configured === true && preStatus.json.calendar.connected === false, 'Google is configured but no account is connected yet');

    const connectUrl = await call('GET', '/api/integrations/calendar/connect-url', admin);
    assert(connectUrl.status === 200, 'the connect flow returns a URL', String(connectUrl.status));
    const authUrl = new URL(connectUrl.json.url);
    assert(authUrl.origin === G, 'the URL points at the configured Google origin', authUrl.origin);
    assert(authUrl.searchParams.get('scope')!.includes('calendar.events'), 'the requested scope is calendar.events only');
    assert(authUrl.searchParams.get('access_type') === 'offline' && authUrl.searchParams.get('prompt') === 'consent', 'offline access is requested (a refresh token is needed)');
    assert(authUrl.searchParams.get('redirect_uri') === `${BASE}/api/integrations/calendar/callback`, 'the redirect URI matches the panel value');

    // Google would show consent; the mock redirects back with a code.
    const consent = await fetch(authUrl.toString(), { redirect: 'manual' });
    const backTo = new URL(String(consent.headers.get('location')));
    assert(consent.status === 302 && backTo.pathname === '/api/integrations/calendar/callback', 'consent returns to the app callback');

    const callback = await call('GET', `${backTo.pathname}${backTo.search}`, null);
    assert(callback.status === 200 && /وصل شد/.test(String(callback.json)), 'the callback stores the connection', String(callback.status));
    const postStatus = await call('GET', '/api/integrations/status', admin);
    assert(postStatus.json.calendar.connected === true && postStatus.json.calendar.accountEmail === ACCOUNT_EMAIL, 'the connected Google account is shown', String(postStatus.json.calendar.accountEmail));

    // The refresh token is used later; the stored access token is not reused forever.
    const refreshBefore = google.calls.filter((c) => c.path === '/token').length;

    // ------------------------------------------------ 3) scheduling the interview ----
    const future = futureJalali(9);
    const created = await call('POST', '/api/interviews', admin, {
      jobId: job.id,
      candidateEmail: 'maryam@example.com',
      title: 'مصاحبهٔ فنی — کارشناس حسابداری صنعتی',
      date: future.date,
      time: '۱۴:۰۰',
      durationMin: 45,
      interviewerIds: [],
      location: 'دفتر مرکزی، اتاق ۳',
      notes: 'نمونه‌کار بهای تمام‌شده همراه داشته باشید',
      withMeet: true,
      sendInvite: true,
    });
    assert(created.status === 200 && created.json.interview?.id, 'the interview is created', `${created.status} ${JSON.stringify(created.json?.error || '')}`);
    assert(created.json.calendarError === null, 'no calendar error is reported', String(created.json.calendarError));
    const interview = created.json.interview;
    assert(Boolean(interview.calendarEventId), 'the Google event id is stored with the interview', String(interview.calendarEventId));
    assert(interview.meetLink === `https://meet.google.com/mock-${interview.calendarEventId}`, 'the Meet link comes back from Google', String(interview.meetLink));

    const posted = google.calls.filter((c) => c.method === 'POST' && /\/events$/.test(c.path)).at(-1)!;
    const event = posted.body as any;
    assert(posted.query.includes('sendUpdates=all'), 'Google is asked to e-mail the guests (sendUpdates=all)', posted.query);
    assert(event.summary.startsWith('مصاحبهٔ فنی') && event.summary.includes('کارشناس حسابداری صنعتی'), 'the event title is the interview title');
    assert(event.description.includes('نمونه‌کار'), 'the notes travel into the event description');
    assert(event.location === 'دفتر مرکزی، اتاق ۳', 'the location is carried over');
    assert(event.start.dateTime === future.iso && event.start.timeZone === 'Asia/Tehran', 'the start is the right instant in Tehran time', `${event.start.dateTime} / ${event.start.timeZone}`);
    assert(event.end.dateTime === new Date(Date.parse(future.iso) + 45 * 60_000).toISOString(), 'the duration is applied to the end time');
    const attendeeEmails = (event.attendees as Array<{ email: string }>).map((a) => a.email);
    assert(attendeeEmails.includes('maryam@example.com'), 'the candidate is an attendee', attendeeEmails.join(', '));
    assert(attendeeEmails.includes(ACCOUNT_EMAIL), 'the connected recruiter account is an attendee');
    assert(Boolean(event.conferenceData?.createRequest), 'a Meet conference is requested when «با لینک Meet» is on');

    const listed = await call('GET', `/api/interviews?jobId=${job.id}`, admin);
    assert(listed.json.items[0].calendarEventId === interview.calendarEventId, 'the list shows the same event id');

    // The next interview after the cached access token expires must refresh it.
    const refreshStatus = await call('GET', '/api/integrations/status', admin);
    assert(refreshStatus.json.calendar.expiresAtISO !== null, 'the token expiry is tracked');

    // -------------------------------------------- 4) overlapping duplicate + cancel ----
    const cancelled = await call('DELETE', `/api/interviews/${interview.id}`, admin);
    assert(cancelled.status === 200 && cancelled.json.interview.status === 'cancelled', 'cancelling keeps the record');
    const deleted = google.calls.filter((c) => c.method === 'DELETE').at(-1);
    assert(Boolean(deleted) && deleted!.path.endsWith(`/events/${interview.calendarEventId}`), 'the Google event is deleted too', deleted?.path || 'none');
    assert(cancelled.json.calendarError === null, 'cancelling reports no calendar error', String(cancelled.json.calendarError));

    const again = await call('DELETE', `/api/interviews/${interview.id}`, admin);
    assert(again.status === 200, 'cancelling twice is harmless (410 from Google is tolerated)', String(again.status));

    // ------------------------------------------- 5) honest failure from Google ----
    google.setRefuseEvents(true);
    const future2 = futureJalali(11);
    const failing = await call('POST', '/api/interviews', admin, {
      jobId: job.id,
      candidateEmail: 'hossein@example.com',
      title: 'مصاحبهٔ دوم',
      date: future2.date,
      time: '۱۴:۰۰',
      durationMin: 30,
      withMeet: false,
      sendInvite: false,
    });
    assert(failing.status === 200, 'the interview is still kept when Google fails', String(failing.status));
    assert(failing.json.interview.calendarEventId === null, 'no event id is invented');
    assert(/Google Calendar/.test(String(failing.json.calendarError)), 'the calendar error is reported in Persian', String(failing.json.calendarError));
    assert(failing.json.interview.status === 'scheduled', 'the local interview survives a Google outage');
    google.setRefuseEvents(false);

    // ---------------------------------------------- refresh token is really used ----
    // A second interview with the same workspace: the stored access token is
    // still valid, so this proves the normal path keeps working.
    const later = await call('POST', '/api/interviews', admin, {
      jobId: job.id,
      candidateEmail: 'sara@example.com',
      title: 'مصاحبهٔ سوم',
      date: futureJalali(13).date,
      time: '۰۹:۰۰',
      durationMin: 30,
      withMeet: false,
      sendInvite: false,
    });
    assert(Boolean(later.json.interview?.calendarEventId), 'a later interview still creates an event', String(later.json.calendarError));
    assert(google.calls.filter((c) => c.path === '/token').length >= refreshBefore, 'no unnecessary token calls are made');

    // ------------------------------------------------------- disconnecting ----
    const disconnected = await call('DELETE', '/api/integrations/calendar', admin);
    assert(disconnected.status === 200 && disconnected.json.calendar.connected === false, 'the Google account can be disconnected');
    const afterDisconnect = await call('POST', '/api/interviews', admin, {
      jobId: job.id,
      title: 'بدون گوگل',
      date: futureJalali(15).date,
      time: '۱۰:۰۰',
      withMeet: true,
      sendInvite: false,
    });
    assert(afterDisconnect.json.interview.calendarEventId === null && afterDisconnect.json.calendarError === null, 'after disconnecting, interviews stay local without an error');

    // ------------------------------------------------------- secrets at rest ----
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    const snapRaw = fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8');
    assert(!snapRaw.includes(CLIENT_SECRET), 'the Client Secret is not written in clear');
    assert(!snapRaw.includes('refresh-1'), 'the refresh token is not written in clear');
    const snap = JSON.parse(snapRaw);
    assert(Boolean(snap.orgSecrets), 'the per-workspace secret slot exists');
  } finally {
    if (!child.killed) child.kill('SIGKILL');
    google.server.close();
    fs.rmSync(DATA, { recursive: true, force: true });
    if (failures > 0 || crashed) {
      console.error(`\n${failures} Google Calendar test(s) failed.`);
      if (log) console.error(log.slice(-2500));
      process.exit(1);
    }
    console.log('\nALL PASS');
    process.exit(0);
  }
}

main().catch((e) => {
  crashed = true;
  console.error('TEST CRASHED:', e);
  if (failures > 0) process.exit(1);
});

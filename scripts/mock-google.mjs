#!/usr/bin/env node
/**
 * A local stand-in for the four Google endpoints HOVIDA talks to, so the whole
 * «اتصال Google Calendar → ثبت مصاحبه → دعوتنامه» flow can be demonstrated and
 * tested without a Google Cloud project, a real account or any e-mail.
 *
 *   node scripts/mock-google.mjs --port 9933
 *
 * Server environment for pointing HOVIDA at it (see docs/CONNECT-GOOGLE-CALENDAR.md):
 *   GOOGLE_OAUTH_AUTH_URL=http://127.0.0.1:9933/o/oauth2/v2/auth
 *   GOOGLE_TOKEN_URL=http://127.0.0.1:9933/token
 *   GOOGLE_USERINFO_URL=http://127.0.0.1:9933/userinfo
 *   GOOGLE_CALENDAR_API_BASE=http://127.0.0.1:9933/calendar/v3
 *
 * Endpoints:
 *   POST /token                                     → authorization_code + refresh_token grants
 *   GET  /userinfo                                  → { email } of the connected account
 *   POST /calendar/v3/calendars/<id>/events         → creates the event, returns Meet link
 *   DELETE /calendar/v3/calendars/<id>/events/<id>  → removes it (410 when already gone)
 *   GET  /_events                                   → what was created (inspection only)
 *
 * Everything is fictional and stays on this machine. This is NOT a Google
 * emulator: it only answers the shapes the app's code depends on.
 */
import http from 'http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT) || 9933;

const CLIENT_ID = process.env.GOOGLE_MOCK_CLIENT_ID || 'demo-client.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_MOCK_CLIENT_SECRET || 'demo-client-secret';
const ACCOUNT_EMAIL = process.env.GOOGLE_MOCK_EMAIL || 'hr-manager@ava-demo.ir';

/** The candidate/organizer consent happens on Google; here a code is just a string. */
const ACCESS_TOKEN = 'mock-access-token';
const REFRESH_TOKEN = 'mock-refresh-token';

const events = new Map();
let seq = 0;

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) });
  res.end(raw);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c.toString('utf-8');
      if (raw.length > 200_000) req.destroy();
    });
    req.on('end', () => resolve(raw));
  });
}

function tokenGrant(params) {
  if (params.get('client_id') !== CLIENT_ID || params.get('client_secret') !== CLIENT_SECRET) {
    return { status: 401, body: { error: 'invalid_client', error_description: 'The OAuth client was not found.' } };
  }
  const grant = params.get('grant_type');
  if (grant === 'refresh_token') {
    if (params.get('refresh_token') !== REFRESH_TOKEN) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
    }
    return { status: 200, body: { access_token: `${ACCESS_TOKEN}-refreshed`, expires_in: 3599, scope: 'calendar.events', token_type: 'Bearer' } };
  }
  if (grant === 'authorization_code') {
    const code = params.get('code') || '';
    // The connectivity probe uses a deliberate non-code value and must look like
    // a real client (invalid_grant), exactly what Google answers.
    if (!code.startsWith('mock-code')) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'Malformed auth code.' } };
    }
    return {
      status: 200,
      body: { access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 3599, scope: 'calendar.events openid email', token_type: 'Bearer' },
    };
  }
  return { status: 400, body: { error: 'unsupported_grant_type' } };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const auth = String(req.headers.authorization || '');

  if (req.method === 'POST' && path === '/token') {
    const params = new URLSearchParams(await readBody(req));
    const result = tokenGrant(params);
    console.log(`[mock-google] token ${params.get('grant_type')} → ${result.status}${result.body?.error ? ` (${result.body.error})` : ''}`);
    return json(res, result.status, result.body);
  }

  if (req.method === 'GET' && path === '/userinfo') {
    if (!auth.startsWith('Bearer ')) return json(res, 401, { error: 'invalid_token' });
    return json(res, 200, { email: ACCOUNT_EMAIL, email_verified: true });
  }

  // OAuth consent screen: Google would show a UI; the mock approves immediately.
  if (req.method === 'GET' && path === '/o/oauth2/v2/auth') {
    const redirect = url.searchParams.get('redirect_uri') || '';
    const state = url.searchParams.get('state') || '';
    console.log(`[mock-google] consent → redirect ${redirect}`);
    res.writeHead(302, { Location: `${redirect}?code=mock-code-${Date.now()}&state=${encodeURIComponent(state)}` });
    return res.end();
  }

  const eventsMatch = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  if (eventsMatch) {
    const [, calendarId, eventId] = eventsMatch;
    if (!auth.startsWith('Bearer ')) return json(res, 401, { error: { code: 401, message: 'Request is missing required authentication credential.' } });

    if (req.method === 'POST' && !eventId) {
      const raw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json(res, 400, { error: { code: 400, message: 'Parse Error' } });
      }
      if (!body.start || !body.start.dateTime || !body.end || !body.end.dateTime) {
        return json(res, 400, { error: { code: 400, message: 'Missing start/end dateTime.' } });
      }
      const id = `mock-evt-${++seq}`;
      const meet = Boolean(body.conferenceData?.createRequest);
      const event = {
        kind: 'calendar#event',
        id,
        status: 'confirmed',
        summary: body.summary || '',
        description: body.description || '',
        location: body.location || '',
        start: body.start,
        end: body.end,
        attendees: body.attendees || [],
        htmlLink: `https://calendar.google.com/calendar/event?eid=${id}`,
        ...(meet
          ? {
              hangoutLink: `https://meet.google.com/mock-${id}`,
              conferenceData: {
                entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/mock-${id}` }],
              },
            }
          : {}),
        created: new Date().toISOString(),
        calendarId,
      };
      events.set(id, event);
      console.log(
        `[mock-google] event created ${id} | ${event.summary} | ${event.start.dateTime} (${event.start.timeZone}) | attendees: ${
          event.attendees.map((a) => a.email).join(', ') || '—'
        }${meet ? ' | Meet link' : ''}`
      );
      return json(res, 200, event);
    }

    if (req.method === 'DELETE' && eventId) {
      if (!events.has(eventId)) return json(res, 410, { error: { code: 410, message: 'Resource has been deleted' } });
      events.delete(eventId);
      console.log(`[mock-google] event deleted ${eventId}`);
      return json(res, 204, {});
    }

    if (req.method === 'GET' && !eventId) {
      return json(res, 200, { items: [...events.values()] });
    }
  }

  if (req.method === 'GET' && path === '/_events') {
    return json(res, 200, { count: events.size, items: [...events.values()] });
  }

  console.log(`[mock-google] 404 ${req.method} ${path}`);
  return json(res, 404, { error: { code: 404, message: 'Not Found' } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-google] listening on http://127.0.0.1:${PORT} — fictional Google, nothing leaves this machine`);
  console.log(`[mock-google] client: ${CLIENT_ID} / ${CLIENT_SECRET} · account: ${ACCOUNT_EMAIL}`);
});

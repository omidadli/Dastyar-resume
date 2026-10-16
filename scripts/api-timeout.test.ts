/**
 * Client API layer: every request has a deadline, honours the caller's
 * AbortSignal and carries the session token in a proxy-safe header. A single
 * unresponsive request must never freeze an analysis run, and a stale 401
 * must never sign out a fresh session. Run with: npx tsx scripts/api-timeout.test.ts
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
store.set('hovida.session.v1', 'test-token-123');
const dispatched: string[] = [];
(globalThis as any).window = { dispatchEvent: (e: Event) => void dispatched.push(e.type) };

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

let lastInit: RequestInit | undefined;

function installHangingFetch() {
  (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
    lastInit = init;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('This operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
}

function installOkFetch(body: unknown) {
  (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
    lastInit = init;
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
}

/** Replies 401 after `delayMs`, like a server rejecting an expired session. */
function install401Fetch(delayMs = 0) {
  (globalThis as any).fetch = (_url: string, init?: RequestInit) => {
    lastInit = init;
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: 'x', code: 'SESSION_EXPIRED' }) }), delayMs)
    );
  };
}

async function main() {
  const { api, setToken, getToken } = await import('../src/lib/api');
  const payload = { fileName: 'a.pdf', extractedText: 'x', unjudgeableReason: null };

  installOkFetch({ items: [], counts: {} });
  await api.jobs.list();
  const headers = () => (lastInit?.headers || {}) as Record<string, string>;
  assert(lastInit?.signal instanceof AbortSignal, 'every request carries an AbortSignal');
  assert(headers()['X-Hovida-Session'] === 'test-token-123', 'the session token travels in X-Hovida-Session');
  assert(!('Authorization' in headers()), 'no Authorization header (proxies strip or replace it)');

  installOkFetch({ token: 't', user: {}, org: {} });
  await api.auth.login({ email: 'a@b.co', password: 'x' });
  assert(!('X-Hovida-Session' in headers()), 'login never carries a (possibly stale) session token');
  await api.auth.signup({ orgName: 'o', name: 'n', email: 'a@b.co', password: 'x' });
  assert(!('X-Hovida-Session' in headers()), 'signup never carries a session token');

  // A 401 for a token that a new login replaced while the request was in flight.
  install401Fetch(150);
  dispatched.length = 0;
  const stale = api.jobs.list().catch((e) => e);
  setToken('fresh-token-456');
  const staleErr = await stale;
  assert(staleErr?.status === 401, 'the stale request still rejects with 401');
  assert(dispatched.length === 0, 'a stale 401 does not sign out the fresh session');
  assert(getToken() === 'fresh-token-456' && store.get('hovida.session.v1') === 'fresh-token-456', 'the fresh token is kept');

  install401Fetch(0);
  await api.jobs.list().catch(() => {});
  assert(dispatched.length === 1 && dispatched[0] === 'hovida:unauthorized', 'a 401 for the current session signs out');

  // Maintenance mode seen by this tab: one event when it starts, one when a
  // request succeeds again — never one per failing request.
  dispatched.length = 0;
  (globalThis as any).fetch = () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({ error: 'در حال به‌روزرسانی', code: 'MAINTENANCE' }) });
  const m1 = await api.jobs.list().catch((e) => e);
  await api.jobs.list().catch(() => {});
  assert(m1?.status === 503 && m1?.code === 'MAINTENANCE', 'a maintenance reply rejects with its code');
  assert(dispatched.filter((t) => t === 'hovida:maintenance').length === 1, 'maintenance start is announced once', dispatched.join(','));
  (globalThis as any).fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'x' }) });
  await api.jobs.list().catch(() => {});
  assert(dispatched.filter((t) => t === 'hovida:maintenance').length === 1, 'another error does not end maintenance');
  installOkFetch({ items: [] });
  await api.jobs.list();
  await api.jobs.list();
  assert(dispatched.filter((t) => t === 'hovida:maintenance').length === 2, 'the first success after maintenance is announced once', dispatched.join(','));

  // Another tab stored a newer session; clearing ours must not remove it.
  store.set('hovida.session.v1', 'other-tab-token');
  setToken(null);
  assert(store.get('hovida.session.v1') === 'other-tab-token', "signing out never removes another tab's session");
  setToken('test-token-123');
  setToken(null);
  assert(!store.has('hovida.session.v1'), 'signing out removes our own stored session');
  setToken('test-token-123');

  installHangingFetch();
  const t0 = Date.now();
  try {
    await api.jobs.get('job_x', { timeoutMs: 400 });
    assert(false, 'a hung request should reject');
  } catch (e: any) {
    const ms = Date.now() - t0;
    assert(ms >= 350 && ms < 2000, `a hung request rejects at its deadline (${ms}ms)`);
    assert(/بیش از/.test(String(e?.message)), 'the timeout message is Persian and honest', e?.message);
  }

  installHangingFetch();
  const controller = new AbortController();
  const t1 = Date.now();
  const pending = api.jobs.evaluate('job_x', payload, { timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 120);
  try {
    await pending;
    assert(false, 'evaluate should reject on abort');
  } catch (e: any) {
    assert(Date.now() - t1 < 2000, 'caller abort wins over a 30s deadline');
    assert(e?.name === 'AbortError', 'abort propagates as AbortError (the runner relies on it)', e?.name);
  }

  installOkFetch({ ok: true });
  const dead = new AbortController();
  dead.abort();
  try {
    await api.jobs.get('job_x', { signal: dead.signal });
    assert(false, 'an already-aborted call must not resolve');
  } catch {
    assert(true, 'an already-aborted signal rejects before hitting the network');
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

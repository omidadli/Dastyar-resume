/**
 * Client API layer: every request has a deadline, honours the caller's
 * AbortSignal and carries the bearer token. A single unresponsive request
 * must never freeze an analysis run. Run with: npx tsx scripts/api-timeout.test.ts
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
store.set('hovida.session.v1', 'test-token-123');

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

async function main() {
  const { api } = await import('../src/lib/api');
  const payload = { fileName: 'a.pdf', extractedText: 'x', unjudgeableReason: null };

  installOkFetch({ items: [], counts: {} });
  await api.jobs.list();
  assert(lastInit?.signal instanceof AbortSignal, 'every request carries an AbortSignal');
  assert((lastInit?.headers as Record<string, string>)?.Authorization === 'Bearer test-token-123', 'the bearer token is sent');

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

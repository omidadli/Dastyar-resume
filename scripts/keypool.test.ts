/**
 * Key pool / automatic failover tests against local mock providers:
 * an OpenAI-compatible gateway and a Gemini endpoint (the real @google/genai
 * SDK pointed at a custom base URL). Covers 429 with Retry-After, Gemini
 * RetryInfo, exhausted quota, invalid keys, 5xx, timeouts, proactive RPM
 * limits, round-robin, capability routing, encryption at rest and
 * persistence of benched keys across restarts.
 * Run with: npx tsx scripts/keypool.test.ts
 */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-pool-'));
process.env.DATA_DIR = DATA;
process.env.APP_SECRET = 'test-secret-for-key-vault-0123456789';
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.AI_PROVIDER;

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const hits: string[] = [];

function openAiMock(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      hits.push(key);
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (key === 'sk-limited-0001') return send(429, { error: { message: 'Rate limit reached for requests' } }, { 'retry-after': '30' });
      if (key === 'sk-quota-0002') return send(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } });
      if (key === 'sk-badkey-0003') return send(401, { error: { message: 'Incorrect API key provided.' } });
      if (key === 'sk-5xx-00004') return send(503, { error: { message: 'The server is overloaded' } });
      if (key === 'sk-slow-00005') return void setTimeout(() => send(200, { choices: [{ message: { content: '{"ok": true, "by": "slow"}' } }] }), 4000);
      const parsed = JSON.parse(body || '{}');
      if (key === 'sk-notemp-0006') {
        hits.push(`notemp:${'temperature' in parsed ? 'with' : 'without'}`);
        if ('temperature' in parsed) {
          return send(400, {
            error: {
              message: "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) value is supported.",
              type: 'invalid_request_error',
              param: 'temperature',
              code: 'unsupported_value',
            },
          });
        }
      }
      const hasFile = JSON.stringify(parsed.messages || []).includes('file_data');
      const sys = parsed.messages?.[0]?.content || '';
      send(200, { choices: [{ message: { content: JSON.stringify({ ok: true, by: key, file: hasFile, sys: sys.slice(0, 30) }) } }] });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function geminiMock(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const key = String(req.headers['x-goog-api-key'] || new URL(req.url || '/', 'http://x').searchParams.get('key') || '');
      hits.push(`gemini:${key}`);
      res.setHeader('Content-Type', 'application/json');
      if (key === 'AIza-limited-gem') {
        res.statusCode = 429;
        return res.end(
          JSON.stringify({
            error: {
              code: 429,
              message: 'Resource has been exhausted (e.g. check quota).',
              status: 'RESOURCE_EXHAUSTED',
              details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
            },
          })
        );
      }
      if (key === 'AIza-limit0-gem' && /models\/gemini-3\.5-flash-lite:/.test(req.url || '')) {
        res.statusCode = 429;
        return res.end(
          JSON.stringify({
            error: {
              code: 429,
              message:
                'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.5-flash-lite\nPlease retry in 41.37s.',
              status: 'RESOURCE_EXHAUSTED',
            },
          })
        );
      }
      if (key === 'AIza-region-gem') {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' } }));
      }
      const parsed = JSON.parse(body || '{}');
      if (key === 'AIza-nothink-gem') {
        const thinking = Boolean(parsed.generationConfig?.thinkingConfig);
        hits.push(`nothink:${thinking ? 'with' : 'without'}`);
        if (thinking) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: { code: 400, message: 'Thinking level is not supported for this model.', status: 'INVALID_ARGUMENT' } }));
        }
      }
      const parts = parsed.contents?.[0]?.parts || [];
      const mimes = parts.filter((p: any) => p.inlineData).map((p: any) => p.inlineData.mimeType);
      const sys = parsed.systemInstruction?.parts?.[0]?.text || '';
      const model = (req.url || '').match(/models\/([^:]+):/)?.[1] || '';
      res.end(
        JSON.stringify({
          candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify({ ok: true, by: `gemini:${key}`, model, mimes, sys: sys.slice(0, 30) }) }] }, finishReason: 'STOP' }],
        })
      );
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const db = await import('../server/db');
  await db.initStore();
  const platform = await import('../server/platform');
  const pool = await import('../server/ai/keypool');
  const provider = await import('../server/ai/provider');

  const oai = await openAiMock();
  const gem = await geminiMock();
  const oaiUrl = `http://127.0.0.1:${(oai.address() as any).port}/v1`;
  const gemUrl = `http://127.0.0.1:${(gem.address() as any).port}`;

  const clearKeys = () => {
    for (const k of platform.listKeysPublic()) if (k.source === 'admin') platform.deleteKey(k.id);
    pool._resetPoolForTests();
    hits.length = 0;
  };
  const add = (label: string, apiKey: string, extra: Record<string, unknown> = {}) =>
    platform.addKey({ label, provider: 'openai', apiKey, baseUrl: oaiUrl, model: 'gpt-test', ...extra });
  const run = (opts: Record<string, unknown> = {}) => provider.generate('ping', { timeoutMs: 3000, deadlineMs: 9000, ...opts });
  const health = (id: string) => pool.runtimeOf(platform.poolEntries().filter((e) => e.id === id))[0];

  // --- no keys at all
  clearKeys();
  assert(!provider.aiStatus().available && /پنل مدیریت/.test(provider.aiStatus().reason || ''), 'no keys: AI unavailable with an admin hint', provider.aiStatus().reason || '');

  // --- failover on 429 with Retry-After
  const k1 = add('کلید ۱', 'sk-limited-0001');
  const k2 = add('کلید ۲', 'sk-good-000001');
  const out = JSON.parse(await run());
  assert(out.by === 'sk-good-000001', '429 on key 1 → the same request is answered by key 2', out.by);
  const h1 = health(k1.id);
  assert(h1.health === 'cooling' && h1.cooldownUntil! - Date.now() > 25_000 && h1.cooldownUntil! - Date.now() <= 30_500, 'key 1 benched for the Retry-After (30 s)', String(h1.cooldownUntil! - Date.now()));
  const call = provider.recentCalls(5)[0];
  assert(call.ok && call.switchedFrom === 'کلید ۱' && call.keyLabel === 'کلید ۲', 'call log records the switch', JSON.stringify(call));
  hits.length = 0;
  await run();
  assert(!hits.includes('sk-limited-0001') && hits[0] === 'sk-good-000001', 'next request skips the benched key entirely', hits.join(','));
  const st = provider.aiStatus();
  assert(st.available && st.keys === 2 && st.readyKeys === 1 && /۱ از ۲/.test(st.label), 'status: «کلیدهای آماده: ۱ از ۲»', st.label);

  // --- everything benched → callers fall back to the local engine
  platform.updateKey(k2.id, { apiKey: 'sk-limited-0001' });
  pool.resetKey(k2.id);
  let threw = '';
  await run().catch((e) => (threw = e.message));
  assert(threw === provider.CIRCUIT_OPEN || /429/.test(threw), 'all keys limited → error for the local fallback', threw);
  const cooling = provider.aiStatus();
  assert(cooling.coolingDown && /خودکار برمی‌گردند/.test(cooling.reason || ''), 'status explains automatic recovery', cooling.reason || '');
  threw = '';
  await run().catch((e) => (threw = e.message));
  assert(threw === provider.CIRCUIT_OPEN, 'while all keys cool down no provider is hit', threw);

  // --- quota, invalid key, 5xx
  clearKeys();
  const q = add('سهمیه', 'sk-quota-0002');
  const bad = add('نامعتبر', 'sk-badkey-0003');
  const err5 = add('خطای سرور', 'sk-5xx-00004');
  const good = add('سالم', 'sk-good-000002');
  const r2 = JSON.parse(await run());
  assert(r2.by === 'sk-good-000002', 'quota → invalid → 5xx → healthy key, in one request', r2.by);
  assert(health(q.id).cooldownUntil! - Date.now() > 59 * 60_000, 'exhausted quota: benched for an hour');
  assert(health(bad.id).health === 'invalid', 'rejected key marked invalid (needs the admin)');
  assert(health(err5.id).health === 'ready', 'a single 5xx does not bench a key');
  hits.length = 0;
  await run();
  assert(!hits.includes('sk-badkey-0003') && !hits.includes('sk-quota-0002'), 'invalid and exhausted keys are skipped afterwards', hits.join(','));
  const tr = await provider.testKey(bad.id);
  assert(!tr.ok && /پذیرفته نشد/.test(tr.error || ''), 'admin test of the invalid key reports it in Persian', tr.error || '');
  platform.updateKey(bad.id, { apiKey: 'sk-good-000003' });
  const tr2 = await provider.testKey(bad.id);
  assert(tr2.ok && health(bad.id).health === 'ready', 'replacing the key + test → healthy again');

  // --- timeouts
  clearKeys();
  add('کند', 'sk-slow-00005');
  add('سریع', 'sk-good-000004');
  const t0 = Date.now();
  const r3 = JSON.parse(await provider.generate('ping', { timeoutMs: 1500, deadlineMs: 6000 }));
  assert(r3.by === 'sk-good-000004' && Date.now() - t0 < 4000, 'slow key times out → next key answers within budget', `${Date.now() - t0}ms`);

  // --- round-robin
  clearKeys();
  add('الف', 'sk-good-00000A');
  add('ب', 'sk-good-00000B');
  platform.updateAiSettings({ strategy: 'round-robin' });
  const seq = [];
  for (let i = 0; i < 4; i++) seq.push(JSON.parse(await run()).by.slice(-1));
  assert(seq.join('') === 'ABAB' || seq.join('') === 'BABA', 'round-robin alternates keys', seq.join(''));
  platform.updateAiSettings({ strategy: 'failover' });
  const seq2 = [];
  for (let i = 0; i < 3; i++) seq2.push(JSON.parse(await run()).by.slice(-1));
  assert(seq2.join('') === 'AAA', 'failover always prefers the first ready key', seq2.join(''));

  // --- proactive RPM limit (no 429 ever reaches the user)
  clearKeys();
  const rpm = add('سقف ۱ در دقیقه', 'sk-good-00000R', { rpm: 1 });
  add('پشتیبان', 'sk-good-00000S');
  const a = JSON.parse(await run());
  hits.length = 0;
  const b = JSON.parse(await run());
  assert(a.by.endsWith('R') && b.by.endsWith('S') && !hits.includes('sk-good-00000R'), 'RPM limit reached → switched before the provider refuses', `${a.by} → ${b.by}`);
  assert(health(rpm.id).health === 'limited', 'key shows «limited» until the minute passes');

  // --- Gemini through a custom base URL (proxy/mirror), RetryInfo, region block
  clearKeys();
  const g1 = platform.addKey({ label: 'جمنای محدود', provider: 'gemini', apiKey: 'AIza-limited-gem', baseUrl: gemUrl, model: 'gemini-test' });
  const g2 = platform.addKey({ label: 'جمنای ناحیه', provider: 'gemini', apiKey: 'AIza-region-gem', baseUrl: gemUrl, model: 'gemini-test' });
  platform.addKey({ label: 'جمنای سالم', provider: 'gemini', apiKey: 'AIza-good-gem', baseUrl: gemUrl, model: 'gemini-test' });
  const gr = JSON.parse(await run({ system: 'SYSTEM-PROMPT-MARKER' }));
  assert(gr.by === 'gemini:AIza-good-gem' && gr.model === 'gemini-test', 'Gemini: 429 and region block → third key answers', gr.by);
  assert(gr.sys === 'SYSTEM-PROMPT-MARKER', 'system instruction reaches Gemini');
  const gh = health(g1.id);
  assert(gh.health === 'cooling' && Math.abs(gh.cooldownUntil! - Date.now() - 37_000) < 2000, 'Gemini RetryInfo «37s» honoured', String(gh.cooldownUntil! - Date.now()));
  assert(health(g2.id).cooldownUntil! - Date.now() > 59 * 60_000 && /پراکسی/.test(health(g2.id).cooldownReason || ''), 'region block → 1 h + proxy advice', health(g2.id).cooldownReason || '');

  // --- capability routing: audio goes to Gemini first, PDFs work everywhere
  clearKeys();
  add('اوپن‌ای‌آی', 'sk-good-00000P');
  platform.addKey({ label: 'جمنای', provider: 'gemini', apiKey: 'AIza-good-gem', baseUrl: gemUrl, model: 'gemini-test' });
  const audio = { mimeType: 'audio/mpeg', base64: Buffer.from('ID3fake').toString('base64'), fileName: 'cv.mp3' };
  const ar = JSON.parse(await run({ files: [audio] }));
  assert(ar.by === 'gemini:AIza-good-gem' && ar.mimes[0] === 'audio/mpeg', 'audio résumé routed to the Gemini key', ar.by);
  const pdf = { mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64'), fileName: 'cv.pdf' };
  const pr = JSON.parse(await run({ files: [pdf] }));
  assert(pr.by === 'sk-good-00000P' && pr.file === true, 'PDF stays on the first key (OpenAI file part)', pr.by);
  const sysr = JSON.parse(await run({ system: 'رفتار-آزمایشی' }));
  assert(sysr.sys.startsWith('رفتار-آزمایشی'), 'system prompt sent as the OpenAI system message');

  // --- encryption at rest + public listing never leaks keys
  db.flushSaveSync();
  const snapshot = fs.readFileSync(path.join(DATA, 'hovida-store.json'), 'utf-8');
  assert(!snapshot.includes('sk-good-00000P') && !snapshot.includes('AIza-good-gem'), 'keys are encrypted in the data file');
  const listed = JSON.stringify(platform.listKeysPublic());
  assert(!listed.includes('sk-good-00000P') && listed.includes('sk-g…000P'), 'admin list shows only a hint', listed.slice(0, 120));
  assert(platform.listKeysPublic().length <= platform.MAX_AI_KEYS, 'at most five keys');
  let overflow = '';
  try {
    for (let i = 0; i < 6; i++) add(`اضافه ${i}`, `sk-good-extra-${i}`);
  } catch (e: any) {
    overflow = e.message;
  }
  assert(/حداکثر/.test(overflow), 'a sixth key is refused', overflow);

  // --- benched keys stay benched after a restart
  clearKeys();
  const p1 = add('ماندگار', 'sk-limited-0001');
  add('دوم', 'sk-good-000009');
  await run();
  const saved = pool.exportState();
  pool._resetPoolForTests();
  pool.importState(saved);
  assert(health(p1.id).health === 'cooling', 'cooldown survives a restart (persisted state)');

  // --- helpers
  assert(pool.retryAfterOf({ message: 'Please try again in 6m0s.' }) === 360_000, 'retry hint «6m0s»');
  assert(pool.retryAfterOf({ message: '{"retryDelay": "1.5s"}' }) === 1500, 'retry hint «1.5s»');
  assert(pool.classifyError({ status: 402, message: 'Payment Required' }) === 'quota', '402 → quota');
  assert(pool.classifyError({ message: 'fetch failed: ENOTFOUND api.example' }) === 'network', 'DNS failure → network');
  assert(pool.classifyError({ status: 404, message: 'model gpt-x does not exist' }) === 'model', '404 model → model');

  // --- real-world 429 shapes (Gemini free tier, OpenAI) — bug audit
  const gemini429 = (violations: string[], extra = '', retryDelay?: string) => ({
    status: 429,
    message: JSON.stringify({
      error: {
        code: 429,
        message: `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.${extra}`,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: violations.map((quotaId) => ({ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId })) },
          ...(retryDelay ? [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] : []),
        ],
      },
    }),
  });
  const perMinute = gemini429(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier'], '', '28s');
  assert(pool.classifyError(perMinute) === 'rate_limit', 'Gemini per-minute «exceeded your current quota» → rate limit (not a 1 h quota bench)', pool.classifyError(perMinute));
  assert(pool.retryAfterOf(perMinute) === 28_000, 'Gemini RetryInfo inside the SDK message → 28 s');
  const tokens = gemini429(['GenerateContentInputTokensPerModelPerMinute-FreeTier'], '', '9s');
  assert(pool.classifyError(tokens) === 'rate_limit', 'Gemini tokens-per-minute → rate limit');
  const perDay = gemini429(['GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '', '16s');
  assert(pool.classifyError(perDay) === 'quota', 'Gemini per-day quota → quota (long bench, short retryDelay ignored)', pool.classifyError(perDay));
  const mixed = gemini429(['GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'], '', '20s');
  assert(pool.classifyError(mixed) === 'rate_limit', 'minute + day violations → rate limit (backs off if it repeats)');
  const limit0 = gemini429([], '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro\nPlease retry in 41.37s.');
  assert(pool.classifyError(limit0) === 'model', '«limit: 0» (model has no free-tier quota) → model (try another model)', pool.classifyError(limit0));
  assert(pool.retryAfterOf({ message: 'Please retry in 17.59s.' }) === 17_590, 'retry hint «Please retry in 17.59s.»', String(pool.retryAfterOf({ message: 'Please retry in 17.59s.' })));
  assert(pool.classifyError({ status: 429, message: 'You exceeded your current quota.' }) === 'rate_limit', 'bare «exceeded your current quota» without a hint → rate limit');
  assert(pool.classifyError({ status: 429, message: 'You exceeded your current quota. Please retry in 3h0m0s.' }) === 'quota', '… with a multi-hour hint → quota');
  assert(
    pool.classifyError({ status: 429, message: 'Rate limit reached for gpt-4o-mini in organization org-x on requests per day (RPD): Limit 10000, Used 10000, Requested 1. Please try again in 8.64s.' }) === 'quota',
    'OpenAI requests-per-day → quota'
  );
  assert(
    pool.classifyError({ status: 429, message: 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 2000. Please try again in 2s.' }) === 'rate_limit',
    'OpenAI tokens-per-minute → rate limit'
  );
  assert(pool.classifyError({ status: 429, message: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}' }) === 'quota', 'OpenAI insufficient_quota → quota');

  // --- rate-limit backoff: hint first, exponential when there is none or it keeps repeating
  clearKeys();
  const bk = add('عقب‌نشینی', 'sk-good-backoff');
  const bkEntry = () => platform.poolEntries().find((e) => e.id === bk.id)!;
  const v1 = pool.markFailure(bkEntry(), { status: 429, message: 'Too Many Requests' });
  const v2 = pool.markFailure(bkEntry(), { status: 429, message: 'Too Many Requests' });
  const v3 = pool.markFailure(bkEntry(), { status: 429, message: 'Too Many Requests' });
  assert(v1.cooldownMs === 30_000 && v2.cooldownMs === 60_000 && v3.cooldownMs === 120_000, 'no hint: 30 s → 60 s → 120 s', `${v1.cooldownMs}/${v2.cooldownMs}/${v3.cooldownMs}`);
  pool.resetKey(bk.id);
  const h1v = pool.markFailure(bkEntry(), perMinute);
  assert(h1v.kind === 'rate_limit' && h1v.cooldownMs === 28_000, 'Gemini per-minute 429 benches the key for its retryDelay only', `${h1v.kind} ${h1v.cooldownMs}`);
  pool.markFailure(bkEntry(), perMinute);
  const h3v = pool.markFailure(bkEntry(), perMinute);
  assert(h3v.cooldownMs === 120_000, 'third consecutive hit: backoff beats a short hint (hidden daily cap)', String(h3v.cooldownMs));
  pool.resetKey(bk.id);
  const before = health(bk.id).lastError;
  const un = pool.markFailure(bkEntry(), Object.assign(new Error('unsupported'), { code: 'UNSUPPORTED_INPUT' }));
  assert(un.kind === 'unsupported' && un.cooldownMs === 0 && health(bk.id).lastError === before && health(bk.id).health !== 'cooling', 'unsupported file type: no strike, no error on the key');
  const req = pool.markFailure(bkEntry(), { status: 400, message: 'Invalid value for messages' });
  assert(req.kind === 'request' && req.cooldownMs === 0 && req.tryNext, '400 request error: next key, this one stays ready');

  // --- reasoning models (GPT-5, o-series) reject temperature → retried without it, remembered
  clearKeys();
  add('استدلالی', 'sk-notemp-0006', { model: 'gpt-5-mini' });
  const nt = JSON.parse(await run());
  assert(nt.by === 'sk-notemp-0006' && hits.join(',') === 'sk-notemp-0006,notemp:with,sk-notemp-0006,notemp:without', '«temperature not supported» → same key retried without temperature', hits.join(','));
  hits.length = 0;
  await run();
  assert(hits.join(',') === 'sk-notemp-0006,notemp:without', 'remembered: later calls skip temperature', hits.join(','));

  // --- Gemini model that rejects the thinking config → retried without it, remembered
  clearKeys();
  platform.addKey({ label: 'بدون تفکر', provider: 'gemini', apiKey: 'AIza-nothink-gem', baseUrl: gemUrl, model: 'gemini-3-test' });
  const th = JSON.parse(await run());
  const thHits = hits.filter((x) => x.startsWith('nothink:')).join(',');
  assert(th.by === 'gemini:AIza-nothink-gem' && thHits === 'nothink:with,nothink:without', '«Thinking level is not supported» → same model retried without thinking', thHits);
  hits.length = 0;
  await run();
  assert(hits.filter((x) => x.startsWith('nothink:')).join(',') === 'nothink:without', 'remembered for that model', hits.join(','));

  // --- «limit: 0» on the default model → the same key answers with the next model, stays ready
  clearKeys();
  const l0 = platform.addKey({ label: 'سطح رایگان', provider: 'gemini', apiKey: 'AIza-limit0-gem', baseUrl: gemUrl, model: '' });
  const l0r = JSON.parse(await run());
  assert(l0r.by === 'gemini:AIza-limit0-gem' && l0r.model !== 'gemini-3.5-flash-lite', '«limit: 0» on the default model → fallback model on the same key', l0r.model);
  assert(health(l0.id).health !== 'cooling', 'that key is not benched');

  // --- friendly errors for the admin
  assert(/سهمیه‌ای ندارد/.test(provider.friendlyAiError(limit0, { provider: 'gemini', label: 'k' } as any)), '«limit: 0» explained in Persian', provider.friendlyAiError(limit0, { provider: 'gemini', label: 'k' } as any));
  assert(/\/v1/.test(provider.friendlyAiError({ status: 404, message: 'OpenAI-compatible 404: Not Found' }, { provider: 'openai', label: 'k' } as any)), 'bare 404 on a gateway → «/v1» advice');

  oai.close();
  gem.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

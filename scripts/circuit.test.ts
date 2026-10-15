/**
 * AI provider resilience: circuit breaker, honest local fallback and the
 * "no AI configured" path. Run with: npx tsx scripts/circuit.test.ts
 */
import { aiStatus, isCircuitOpen, recordFailure, recordSuccess, resetCircuitBreaker } from '../server/ai/provider';
import { evaluateResume, understandJob } from '../server/ai/screening';
import type { JobUnderstanding } from '../src/types/screening';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: any[]) => {
  fetchCalls++;
  return realFetch(...(args as [any, any]));
}) as typeof fetch;

const understanding: JobUnderstanding = {
  department: 'تولید و عملیات',
  departmentId: 'manufacturing',
  roleTitle: 'اپراتور خط',
  seniority: 'کارشناسی',
  plainExplanation: 'تست',
  thresholds: { interview: 75, review: 50 },
  criteria: [
    { id: 'c1', title: 'سابقه خط تولید', weight: 50, mustHave: true },
    { id: 'c2', title: 'مهارت فنی', weight: 50, mustHave: false },
  ],
  questions: [{ id: 'q1', type: 'boolean', kind: 'knockout', label: 'سابقه کارگاهی', weight: 20, defaultChecked: true }],
};
const job = { departmentName: 'تولید و عملیات', roleTitle: 'اپراتور خط', extraNotes: '', understanding, answers: { q1: true } };
const resumeText = 'علی محمدی، کارشناس تولید با ۶ سال سابقه در خط تولید دارویی، آشنا با GMP، مدرک مهندسی شیمی.';

async function main() {
  // ---- 1. No key configured: honest, instant local fallback ----
  delete process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.AI_PROVIDER = 'auto';
  const st = aiStatus();
  assert(st.available === false && st.provider === null, 'no key → AI reported unavailable', st.reason || '');
  fetchCalls = 0;
  const t0 = Date.now();
  const ev = await evaluateResume({ orgName: 'تست', job, resumeText, fileName: 'cv.txt' });
  assert(fetchCalls === 0 && Date.now() - t0 < 300, 'no network call without a key', `fetch=${fetchCalls}`);
  assert(ev.engine === 'local' && ev.confidence === 'low', 'result is labelled as the low-confidence local engine');
  try {
    await understandJob({ orgName: 'تست', department: { id: 'it', name: 'فناوری اطلاعات', hint: '' }, roleTitle: 'پشتیبان شبکه' });
    assert(false, 'questionnaire generation must fail honestly without AI');
  } catch (e: any) {
    assert(/پیکربندی نشده|GEMINI_API_KEY/.test(String(e?.message)), 'questionnaire failure explains the missing key in Persian', e?.message);
  }

  // ---- 2. Breaker: opens after 5 consecutive failures, never on 503 spikes ----
  process.env.GEMINI_API_KEY = 'AIzaSyINVALID_TEST_KEY_000000000000000';
  resetCircuitBreaker();
  for (let i = 0; i < 4; i++) recordFailure(false, false);
  assert(!isCircuitOpen(), 'still closed after 4 failures');
  recordFailure(false, true);
  assert(!isCircuitOpen(), 'a 503 high-demand spike does not count');
  recordFailure(false, false);
  assert(isCircuitOpen(), 'opens after the 5th consecutive failure');
  assert(aiStatus().coolingDown === true, 'status exposes the cooldown to the UI');

  fetchCalls = 0;
  const t1 = Date.now();
  const ev2 = await evaluateResume({ orgName: 'تست', job, resumeText, fileName: 'cv.txt' });
  assert(fetchCalls === 0, 'no request is attempted while the breaker is open', `fetch=${fetchCalls}`);
  assert(Date.now() - t1 < 300 && ev2.engine === 'local', 'falls back to the local engine immediately');

  recordSuccess();
  assert(!isCircuitOpen(), 'a success closes the breaker');

  // ---- 3. OpenAI-compatible provider selection ----
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test';
  process.env.OPENAI_BASE_URL = 'https://gateway.example.ir/v1/';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  const st2 = aiStatus();
  assert(st2.provider === 'openai' && st2.label === 'gateway.example.ir · gpt-4o-mini', 'auto picks the OpenAI-compatible gateway', st2.label);
  process.env.AI_PROVIDER = 'off';
  assert(aiStatus().available === false, 'AI_PROVIDER=off disables AI');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(1);
});

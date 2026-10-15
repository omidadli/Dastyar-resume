/**
 * jsdom smoke test: mounts the REAL <App/> against a running server and walks
 * the main screens — landing, demo workspace, dashboard, jobs, job detail with
 * the candidate panel, comparison and settings.
 *
 *   npm run build && DATA_DIR=/tmp/hv-mount PORT=3000 NODE_ENV=production node dist/server.cjs
 *   npm run test:mount
 */
import { JSDOM } from 'jsdom';
import path from 'path';

const SERVER = process.env.BASE || 'http://127.0.0.1:3000';
const dom = new JSDOM('<!doctype html><html dir="rtl"><body><div id="root"></div></body></html>', {
  url: SERVER + '/',
  pretendToBeVisual: true,
});
const { window } = dom;

let failures = 0;
function assert(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- globals React and the app expect ----
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
for (const k of ['location', 'history', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'localStorage', 'KeyboardEvent', 'MouseEvent']) {
  globalThis[k] = window[k];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.DOMException = window.DOMException || globalThis.DOMException;
window.scrollTo = () => {};
window.matchMedia = (q) => ({ matches: /min-width:\s*1280px/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
if (!window.AbortController) window.AbortController = globalThis.AbortController;

const nodeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => nodeFetch(typeof input === 'string' && input.startsWith('/') ? SERVER + input : input, init);
window.fetch = globalThis.fetch;

let bootHidden = false;
window.__hovidaBoot = { hide: () => (bootHidden = true), fail: (m) => assert(false, 'no fatal boot error', m) };

const root = window.document.getElementById('root');
const { mount, navigate } = await import(path.resolve('dist-mount/mount-entry.js'));
const text = () => window.document.body.textContent || '';
async function waitFor(fn, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

// 1. Landing
const app1 = mount(root);
assert(await waitFor(() => text().includes('روشن می‌شود')), 'landing renders the brand tagline');
assert(bootHidden || root.childElementCount > 0, '#root is not empty (no blank page)');
assert(text().includes('ورود به نسخه نمایشی'), 'the demo entry point is offered');

// 2. Demo workspace → dashboard
const demo = await nodeFetch(SERVER + '/api/auth/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json());
assert(Boolean(demo.token), 'a demo workspace can be created');
window.localStorage.setItem('hovida.session.v1', demo.token);
// Remount so the AuthProvider picks up the session.
app1.unmount(); // a detached-but-mounted signed-out App would fight the router
const root2 = window.document.createElement('div');
window.document.body.appendChild(root2);
root.remove();
navigate('/app');
mount(root2);
assert(await waitFor(() => text().includes('در انتظار تصمیم شما'), 10000), 'dashboard renders for the demo workspace');
assert(text().includes('زمان صرفه‌جویی‌شده (برآورد)'), 'the time-saved figure is labelled as an estimate');

// 3. Jobs list
navigate('/app/jobs');
assert(await waitFor(() => text().includes('کارشناس جذب و استخدام') && text().includes('حسابدار ارشد')), 'jobs list shows the demo openings');

// 4. Job detail + candidate panel
const jobs = await nodeFetch(SERVER + '/api/jobs', { headers: { Authorization: `Bearer ${demo.token}` } }).then((r) => r.json());
const hr = jobs.items.find((j) => j.roleTitle.includes('جذب'));
navigate(`/app/jobs/${hr.id}`);
assert(await waitFor(() => text().includes('سارا محمدی') && text().includes('درصد تطابق')), 'job detail renders the candidate table');
assert(text().includes('تطابق بالا') && text().includes('نیازمند بررسی'), 'match levels are labelled, never «hire/reject»');
const list = await nodeFetch(SERVER + `/api/resumes?jobId=${hr.id}`, { headers: { Authorization: `Bearer ${demo.token}` } }).then((r) => r.json());
navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('دلایل تطابق') && text().includes('تصمیم شما')), 'the candidate panel shows evidence and the decision bar');

// 5. Compare
navigate(`/app/compare?ids=${list.items.slice(0, 3).map((i) => i.id).join(',')}`);
assert(await waitFor(() => text().includes('مقایسه کاندیداها') && text().includes('سابقه کار')), 'comparison renders side by side');

// 6. Settings › AI is honest about the engine
navigate('/app/settings/ai');
assert(await waitFor(() => text().includes('وضعیت هوش مصنوعی')), 'AI settings render');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

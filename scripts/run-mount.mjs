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
const { mount, navigate, setToken } = await import(path.resolve('dist-mount/mount-entry.js'));
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
setToken(demo.token, { demo: true });
// Remount so the AuthProvider picks up the session.
app1.unmount(); // a detached-but-mounted signed-out App would fight the router
const root2 = window.document.createElement('div');
window.document.body.appendChild(root2);
root.remove();
navigate('/app');
mount(root2);
assert(await waitFor(() => text().includes('در انتظار تصمیم شما'), 10000), 'dashboard renders for the demo workspace');
// The card titles show while the figures still load: wait for the data itself.
assert(await waitFor(() => text().includes('زمان صرفه‌جویی‌شده (برآورد)'), 10000), 'the time-saved figure is labelled as an estimate');

// 3. Jobs list
navigate('/app/jobs');
assert(await waitFor(() => text().includes('کارشناس جذب و استخدام') && text().includes('حسابدار ارشد')), 'jobs list shows the demo openings');

// 4. Job detail + candidate panel
const jobs = await nodeFetch(SERVER + '/api/jobs', { headers: { 'X-Hovida-Session': demo.token } }).then((r) => r.json());
const hr = jobs.items.find((j) => j.roleTitle.includes('جذب'));
navigate(`/app/jobs/${hr.id}`);
assert(await waitFor(() => text().includes('سارا محمدی') && text().includes('درصد تطابق')), 'job detail renders the candidate table');
assert(text().includes('تطابق بالا') && text().includes('نیازمند بررسی'), 'match levels are labelled, never «hire/reject»');
const list = await nodeFetch(SERVER + `/api/resumes?jobId=${hr.id}`, { headers: { 'X-Hovida-Session': demo.token } }).then((r) => r.json());
navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('دلایل تطابق') && text().includes('تصمیم شما')), 'the candidate panel shows evidence and the decision bar');

// 5. Compare
navigate(`/app/compare?ids=${list.items.slice(0, 3).map((i) => i.id).join(',')}`);
assert(await waitFor(() => text().includes('مقایسه کاندیداها') && text().includes('سابقه کار')), 'comparison renders side by side');

// 6. Settings › AI is honest about the engine
navigate('/app/settings/ai');
assert(await waitFor(() => text().includes('وضعیت هوش مصنوعی')), 'AI settings render');

// 7. Talent sourcing page (honest about a missing provider too)
navigate('/app/sourcing');
assert(await waitFor(() => text().includes('دنبال چه کسی هستید؟'), 10000), 'sourcing page renders its brief form');
assert(
  text().includes('جست‌وجو در LinkedIn') || text().includes('در این نصب فعال نیست'),
  'sourcing shows the search action or an honest «not configured» note'
);
// The file path works with no provider at all, so it must always be on the page.
assert(text().includes('فهرستی از قبل دارید؟'), 'the CSV import card is available without any provider');
assert(text().includes('انتخاب فایل CSV') && text().includes('ساخت فهرست و غربال'), 'the CSV card offers choosing a file and building the list');

// 8. Settings › connections (e-mail + calendar)
navigate('/app/settings/integrations');
assert(await waitFor(() => text().includes('ایمیل سازمان') && text().includes('Google Calendar')), 'connection settings render both cards');
assert(text().includes('اتصال‌ها'), 'the connections tab is reachable from settings');
assert(text().includes('پیامک سازمان'), 'the connections tab offers the workspace SMS line');
assert(text().includes('پورتال شغلی'), 'the connections tab offers the public career portal');

// 8b. Settings › account: the 2FA card is there, and the demo is honest about it.
navigate('/app/settings/account');
assert(await waitFor(() => text().includes('ورود دومرحله‌ای')), 'the account tab offers two-factor login');
assert(await waitFor(() => text().includes('در نسخهٔ نمایشی')), 'the demo workspace says 2FA belongs on a real account');
assert(text().includes('تغییر رمز عبور'), 'the password card is still beside it');

// 9. Interview modal opens from the candidate panel
const clickByText = (needle) => {
  const el = Array.from(window.document.querySelectorAll('button, a')).find((b) => (b.textContent || '').includes(needle));
  if (!el) return false;
  el.click();
  return true;
};
navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('تصمیم شما'), 10000), 'candidate panel is back for the interview step');
assert(clickByText('تعیین جلسهٔ مصاحبه'), 'the interview button exists in the candidate panel');
assert(await waitFor(() => text().includes('مدت جلسه') && text().includes('مصاحبه‌گران')), 'the interview form opens with its fields');
assert(text().includes('تاریخ (شمسی)') && text().includes('ساعت (تهران)'), 'the interview form asks for a Jalali date and Tehran time');

// 10. Message modal explains how the message leaves HOVIDA
navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('تصمیم شما'), 10000), 'candidate panel is back for the message step');
assert(clickByText('پیام'), 'the message action exists in the candidate panel');
// The two newer candidate actions live in the «اطلاعات بیشتر» tab: a scheduling
// link the candidate uses to pick a time, and an offer letter they sign.
navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('اطلاعات بیشتر'), 10000), 'the candidate panel is open');
assert(clickByText('اطلاعات بیشتر'), 'the «more» tab is reachable');
const hasAction = (needle) => Array.from(window.document.querySelectorAll('button')).some((b) => (b.textContent || '').includes(needle));
assert(await waitFor(() => hasAction('انتخاب زمان مصاحبه'), 8000), 'the candidate panel offers the self-scheduling link');
assert(hasAction('پیشنهاد شغلی'), 'the candidate panel offers the offer letter');
assert(
  await waitFor(() => text().includes('ارسال با ایمیل سازمان') || text().includes('ایمیل سازمان را در «تنظیمات'), 12000),
  'the message modal offers organizational e-mail or explains how to connect it'
);

// 11. «اتوماسیون جذب» — the queue, the rules, and the promise that nothing is
// sent to a candidate before a human approves it.
navigate('/app/automation');
assert(await waitFor(() => text().includes('اتوماسیون جذب'), 12000), 'automation page renders');
assert(await waitFor(() => text().includes('صف تأیید') && text().includes('قواعد و متن‌ها'), 15000), 'the queue and the rules tabs are offered');
assert(text().includes('تا شما تأیید نکنید'), 'the page states that nothing is sent before approval');
assert(clickByText('پیش‌نمایش'), 'the dry-run button exists');
assert(await waitFor(() => text().includes('پیش‌نمایش بدون ثبت'), 15000), 'a dry run says that nothing was saved');
assert(clickByText('قواعد و متن‌ها'), 'the rules tab is reachable');
assert(await waitFor(() => text().includes('آستانهٔ دعوت'), 12000), 'the rules tab shows the invite threshold');
assert(text().includes('ارسال خودکار نامهٔ نتیجه'), 'the automatic-send rule is exposed with its warning');
assert(text().includes('متغیرهای متن'), 'the template variables are documented on the page');

// 11a. «کیت مصاحبه» — the questions this job needs, and this candidate's own.
navigate(`/app/jobs/${hr.id}/kit`);
assert(await waitFor(() => text().includes('کیت مصاحبه'), 15000), 'the interview kit opens from the job');
assert(await waitFor(() => text().includes('بشنوید') && text().includes('علامت هشدار'), 15000), 'each question says what to listen for and what to worry about');
assert(text().includes('پایان جلسه'), 'the kit closes the session with a next step');
assert(text().includes('چطور از این کیت استفاده کنیم'), 'the sidebar explains how to run it');
assert(text().includes('معیارهای این فرصت'), 'the job criteria are repeated beside the questions');
navigate(`/app/jobs/${hr.id}/kit?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('پرسش از خود این رزومه'), 15000), 'with a candidate, the kit asks about that résumé');
assert(text().includes('این کیت برای'), 'and says whose kit it is');

// 11a2. «عملکرد تیم» و «هزینهٔ هر استخدام» — the numbers a manager asks for.
navigate('/app/reports/team');
assert(await waitFor(() => text().includes('عملکرد تیم') && text().includes('هر عضو، چه کاری انجام داده'), 15000), 'the team report opens');
assert(await waitFor(() => text().includes('تصمیم‌های ثبت‌شده') && text().includes('کارت ارزیابی'), 15000), 'team KPIs are counted, not placeholders');
assert(text().includes('این گزارش چه چیزی نیست'), 'the team report says plainly what it is not');
assert(!text().includes('مینا'), 'no candidate name appears in the team report');
navigate('/app/reports/cost');
assert(await waitFor(() => text().includes('هزینهٔ هر استخدام') && text().includes('ردیف‌های هزینه'), 15000), 'the cost report opens for the demo owner');
assert(await waitFor(() => text().includes('هزینهٔ زمان تیم'), 15000), 'the time-cost card is present');
assert(text().includes('آگهی و تبلیغ') || text().includes('شرکت مشاور'), 'the demo cost rows are listed');
assert(text().includes('مستقیم + برآورد زمان تیم'), 'direct cost and the estimate are labelled separately');
navigate('/app/reports');
assert(await waitFor(() => text().includes('روند رزومه‌ها'), 15000), 'the screening report still opens');
assert(text().includes('غربالگری') && text().includes('عملکرد تیم') && text().includes('هزینهٔ استخدام'), 'all three reports are one click apart');

// 11b. «غربالگری بی‌طرف» — the switch, the masked table, the reveal.
const setBlind = (on) =>
  nodeFetch(SERVER + '/api/org', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Hovida-Session': demo.token },
    body: JSON.stringify({ blindScreening: on }),
  }).then((r) => r.json());

const firstName = list.items[0].candidateName;
await setBlind(true);
navigate('/app/settings/org');
assert(await waitFor(() => text().includes('غربالگری بی‌طرف'), 12000), 'the workspace settings offer blind screening');
assert(await waitFor(() => text().includes('پنهان‌سازی فعال است'), 8000), 'the card shows it as on');
assert(text().includes('آشکارسازی هویت'), 'the card explains how the identity comes back');

navigate(`/app/jobs/${hr.id}`);
assert(await waitFor(() => text().includes('کارجوی'), 15000), 'the screening table labels candidates blind');
assert(Boolean(firstName) && !text().includes(firstName), 'the real name is not on the page', String(firstName));

navigate(`/app/jobs/${hr.id}?c=${list.items[0].id}`);
assert(await waitFor(() => text().includes('این کارجو بی‌نام نمایش داده می‌شود'), 15000), 'the panel says why it is anonymous');
assert(clickByText('آشکارسازی هویت'), 'the reveal action is offered');
assert(await waitFor(() => text().includes('دلیل آشکارسازی'), 12000), 'the reveal asks for a reason');
assert(clickByText('آشکار کن'), 'the reveal can be confirmed');
assert(await waitFor(() => text().includes('هویت آشکار شد'), 15000), 'the reveal reports itself');
assert(await waitFor(() => !text().includes('این کارجو بی‌نام نمایش داده می‌شود'), 12000), 'the banner goes away after the reveal');

await setBlind(false);
navigate(`/app/jobs/${hr.id}`);
assert(await waitFor(() => text().includes(firstName || 'کارجوی'), 15000), 'switching it off brings the names back');

// 12. «تجربهٔ کارجو» — the public survey page a candidate opens from the e-mail.
// Created through the API so the page is exercised exactly as a candidate sees it.
const surveyRes = await nodeFetch(SERVER + '/api/surveys', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hovida-Session': demo.token },
  body: JSON.stringify({ resumeId: list.items[0].id, stage: 'after_interview' }),
});
const created = await surveyRes.json().catch(() => ({}));
assert(Boolean(created?.survey?.url), 'a survey link can be created for a candidate', String(surveyRes.status));
if (created?.survey?.url) {
  const token = created.survey.url.split('/survey/')[1];
  navigate(`/survey/${token}`);
  assert(await waitFor(() => text().includes('معرفی'), 12000), 'the public survey page asks the NPS question');
  assert(text().includes('روشن بودن مراحل') && text().includes('رفتار محترمانه'), 'the three experience dimensions are shown');
  assert(text().includes('ثبت نظر'), 'the submit button is offered');
  const zeroButton = Array.from(window.document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '۰');
  assert(Boolean(zeroButton), 'the 0–10 scale is rendered with Persian digits');
  zeroButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await sleep(200);
  assert(clickByText('ثبت نظر'), 'a score can be picked and submitted');
  assert(await waitFor(() => text().includes('پاسخ شما ثبت شد'), 12000), 'the candidate is thanked after answering');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

/* End-to-end API smoke test for HOVIDA. Start a server first (e.g. DATA_DIR=/tmp/hv-data PORT=3111 NODE_ENV=production npx tsx server.ts), then: node scripts/smoke.mjs */
const BASE = process.env.BASE || "http://127.0.0.1:3111";
let fails = 0;
const ok = (c, l, x) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? ' — ' + x : ''}`); if (!c) fails++; };
async function call(method, path, { body, token } = {}) {
  const t = Date.now();
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 100); }
  return { status: res.status, json, ms: Date.now() - t, headers: res.headers };
}
const h = await call('GET', '/api/health'); ok(h.status === 200 && h.json.app === 'HOVIDA', 'health');
const unauth = await call('GET', '/api/jobs'); ok(unauth.status === 401, 'jobs requires auth', unauth.json.error);
const demo = await call('POST', '/api/auth/demo'); ok(demo.status === 201 && demo.json.token, 'demo workspace', `${demo.ms}ms org=${demo.json.org?.name}`);
const T = demo.json.token;
const me = await call('GET', '/api/auth/me', { token: T }); ok(me.status === 200 && me.json.user.role === 'owner', 'me', `unread=${me.json.unread} ai=${me.json.ai.available}`);
const jobs = await call('GET', '/api/jobs', { token: T }); ok(jobs.json.items?.length === 5, 'demo jobs = 5', JSON.stringify(jobs.json.counts));
const hrJob = jobs.json.items.find(j => j.roleTitle.includes('جذب'));
ok(hrJob.stats.total === 8 && hrJob.stats.approved === 2, 'HR job stats', JSON.stringify(hrJob.stats));
const list = await call('GET', `/api/resumes?jobId=${hrJob.id}&sort=match`, { token: T }); ok(list.json.total === 8 && list.json.items[0].score === 88, 'resume list sorted', JSON.stringify(list.json.counts));
ok(!('extractedText' in list.json.items[0]), 'list omits extractedText');
const pending = await call('GET', `/api/resumes?decision=pending`, { token: T }); ok(pending.json.total > 0, 'pending decisions', String(pending.json.total));
const search1 = await call('GET', `/api/resumes?q=${encodeURIComponent('سارا')}`, { token: T }); ok(search1.json.total === 1, 'search name');
const search2 = await call('GET', `/api/resumes?q=${encodeURIComponent('جذب واستخدام')}`, { token: T }); ok(search2.json.total >= 1, 'search ZWNJ/space-insensitive', String(search2.json.total));
const search3 = await call('GET', `/api/resumes?q=${encodeURIComponent('كريمي')}`, { token: T }); ok(search3.json.total === 1, 'search Arabic kaf/yeh normalization', String(search3.json.total));
const rid = list.json.items[0].id;
const full = await call('GET', `/api/resumes/${rid}`, { token: T }); ok(full.status === 200 && full.json.record.extractedText.length > 10 && full.json.job.id === hrJob.id, 'resume detail');
const fu = await call('GET', `/api/resumes/${rid}/file-url?inline=1`, { token: T }); ok(fu.json.hasFile && fu.json.url.startsWith('/api/files/'), 'signed file url', fu.json.mimeType);
const file = await fetch(BASE + fu.json.url); ok(file.status === 200 && file.headers.get('content-type') === 'application/pdf', 'signed file fetch', file.headers.get('content-disposition'));
const bad = await fetch(BASE + fu.json.url.replace(/sig=[^&]+/, 'sig=xyz')); ok(bad.status === 403, 'tampered signature rejected');
const txtRec = (await call('GET', `/api/resumes?q=${encodeURIComponent('پویا')}`, { token: T })).json.items[0];
const fu2 = await call('GET', `/api/resumes/${txtRec.id}/file-url?inline=1`, { token: T }); const f2 = await fetch(BASE + fu2.json.url); const t2 = await f2.text();
ok(f2.headers.get('content-type').includes('charset=utf-8') && t2.includes('پویا'), 'txt file utf-8');
const dec = await call('PATCH', `/api/resumes/${rid}`, { token: T, body: { action: 'decision', status: 'review', note: 'تست' } }); ok(dec.json.record?.decisionStatus === 'review' && dec.json.record.decidedByName === 'کاربر نمایشی', 'decision');
const dash = await call('GET', '/api/dashboard', { token: T }); ok(dash.status === 200 && dash.json.kpis.openJobs === 4, 'dashboard', JSON.stringify(dash.json.kpis) + ' saved=' + dash.json.timeSaved.hours);
for (const r of ['30', '90', '365', 'all']) { const rep = await call('GET', `/api/reports?range=${r}`, { token: T }); ok(rep.status === 200 && Array.isArray(rep.json.timeline), `reports ${r}`, `analyzed=${rep.json.totals.analyzed} buckets=${rep.json.timeline.length}`); }
const s = await call('GET', `/api/search?q=${encodeURIComponent('حسابدار')}`, { token: T }); ok(s.json.jobs.length >= 1, 'global search', `${s.json.jobs.length} jobs, ${s.json.candidates.length} cands`);
const act = await call('GET', '/api/activity', { token: T }); ok(act.json.items.length > 10, 'activity', `items=${act.json.items.length} unread=${act.json.unread}`);
const talent = await call('GET', '/api/talent', { token: T }); ok(talent.json.total >= 8, 'talent', `total=${talent.json.total}`);
const tl = await call('GET', '/api/talent/list?departmentId=finance', { token: T }); ok(tl.json.total === 2, 'talent list finance', String(tl.json.total));
const cmpIds = list.json.items.slice(0, 3).map(r => r.id).join(',');
const cmp = await call('GET', `/api/resumes/compare?ids=${cmpIds}`, { token: T }); ok(cmp.json.items?.length === 3 && cmp.json.job.understanding.criteria.length >= 3, 'compare');
// Signup new org + isolation
const email = `owner${Date.now()}@acme.ir`;
const weak = await call('POST', '/api/auth/signup', { body: { orgName: 'آکمه', name: 'علی', email, password: '123' } }); ok(weak.status === 400, 'weak password rejected', weak.json.error);
const su = await call('POST', '/api/auth/signup', { body: { orgName: 'شرکت آکمه', name: 'علی احمدی', email, password: 'secret1234' } }); ok(su.status === 201, 'signup');
const T2 = su.json.token;
const dup = await call('POST', '/api/auth/signup', { body: { orgName: 'شرکت دیگر', name: 'کاربر دیگر', email, password: 'secret1234' } }); ok(dup.status === 409, 'duplicate email');
const iso = await call('GET', `/api/resumes/${rid}`, { token: T2 }); ok(iso.status === 404, 'tenant isolation: resume');
const iso2 = await call('GET', `/api/jobs/${hrJob.id}`, { token: T2 }); ok(iso2.status === 404, 'tenant isolation: job');
const iso3 = await call('GET', `/api/resumes/${rid}/file-url`, { token: T2 }); ok(iso3.status === 404, 'tenant isolation: file url');
const empty = await call('GET', '/api/jobs', { token: T2 }); ok(empty.json.items.length === 0, 'new org empty');
const login = await call('POST', '/api/auth/login', { body: { email, password: 'secret1234' } }); ok(login.status === 200 && login.json.token, 'login');
const badLogin = await call('POST', '/api/auth/login', { body: { email, password: 'wrong' } }); ok(badLogin.status === 401, 'bad login');
// AI-less job creation path
const u = await call('POST', '/api/jobs/understand', { token: T2, body: { departmentId: 'sales', roleTitle: 'کارشناس فروش' } }); ok(u.status === 503 && u.json.templateAvailable, 'understand without AI → 503 honest', u.json.error);
const tpl = await call('POST', '/api/jobs/template', { token: T2, body: { departmentId: 'sales', roleTitle: 'کارشناس فروش' } }); ok(tpl.json.source === 'template', 'template understanding');
const nj = await call('POST', '/api/jobs', { token: T2, body: { departmentId: 'sales', roleTitle: 'کارشناس فروش', understanding: tpl.json.understanding, answers: { q4: true }, criteriaSource: 'template' } });
ok(nj.status === 201 && nj.json.job.criteriaSource === 'template', 'create job');
const J = nj.json.job.id;
const resumeText = 'رزومه رضا کرمی\nسمت: کارشناس فروش حضوری\n۴ سال سابقه فروش میدانی و ویزیتوری در شرکت پخش\nمذاکره با مشتری و تحقق تارگت\nتلفن: ۰۹۱۲۱۲۳۴۵۶۷';
const ev = await call('POST', `/api/jobs/${J}/evaluate`, { token: T2, body: { fileName: 'reza.txt', extractedText: resumeText, fileBase64: Buffer.from(resumeText).toString('base64') } });
ok(ev.status === 200 && ev.json.record.engine === 'local', 'evaluate → local engine (no AI)', `score=${ev.json.record.score} cat=${ev.json.record.category} years=${ev.json.record.facts?.yearsExperience} phone=${ev.json.record.contact?.phone}`);
const ev2 = await call('POST', `/api/jobs/${J}/evaluate`, { token: T2, body: { fileName: 'empty.pdf', unjudgeableReason: 'فایل خالی' } }); ok(ev2.json.record.category === 'UNJUDGEABLE', 'unjudgeable');
const ev3 = await call('POST', `/api/jobs/${J}/evaluate`, { token: T2, body: { fileName: 'x.pdf', errorMessage: 'network' } }); ok(ev3.json.record.category === 'ERROR', 'error record');
const cal = await call('POST', `/api/jobs/${J}/calibrate`, { token: T2, body: { count: 3 } }); ok(cal.json.job.analysisStatus === 'done', 'calibrate/finish');
const del = await call('DELETE', `/api/resumes/${ev.json.record.id}`, { token: T2 }); ok(del.status === 200, 'hard delete resume');
const fu3 = await call('GET', `/api/resumes/${ev.json.record.id}`, { token: T2 }); ok(fu3.status === 404, 'deleted resume gone');
const draft = await call('POST', '/api/messages/draft', { token: T, body: { resumeId: rid, kind: 'REJECTION' } }); ok(draft.json.body?.includes('گروه نمونه آوا') && draft.json.engine === 'local', 'message draft (template)', draft.json.subject);
const org = await call('GET', '/api/org', { token: T }); ok(org.json.members.length === 3, 'org members');
const addM = await call('POST', '/api/org/members', { token: T2, body: { name: 'سارا', email: `m${Date.now()}@acme.ir`, password: 'pass12345', role: 'member' } }); ok(addM.status === 201, 'add member');
const deps = await call('PUT', '/api/org/departments', { token: T2, body: { departments: [{ id: 'sales', name: 'فروش', hint: 'فروش' }, { name: 'حقوقی', hint: 'امور قراردادها' }] } }); ok(deps.json.org.departments.length === 2, 'departments update', deps.json.org.departments.map(d => d.id).join(','));
const lo = await call('POST', '/api/auth/logout', { token: T2 }); const after = await call('GET', '/api/auth/me', { token: T2 }); ok(after.status === 401, 'logout invalidates token');
console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
process.exit(fails ? 1 : 0);

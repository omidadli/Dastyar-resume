/**
 * End-to-end API test of «خلاصهٔ جلسه» — the transcript, distilled.
 *
 * The point of this suite is the honesty rules, not the wording:
 *   • with no AI key, the local engine still works and says so;
 *   • every line it produces exists verbatim in the transcript — nothing invented;
 *   • concerns and next steps are found by markers, not guessed;
 *   • a too-short transcript is refused instead of summarised into noise;
 *   • summaries follow per-job access, blind mode, erasure and transcript deletion;
 *   • another workspace sees nothing.
 *
 * Run with: npm run build && npx tsx scripts/summary-api.test.ts
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

const TRANSCRIPT = [
  'سارا محمدی هستم و شش سال در تیم شبکهٔ یک شرکت تولیدی کار کرده‌ام.',
  'در آنجا مسئول پایداری شبکهٔ کارخانه و پشتیبانی حدود دویست کاربر بودم.',
  'بیشتر کارم با فایروال پالو آلتو و سوئیچ‌های سیسکو بوده و مستندسازی تیم را من نوشتم.',
  'نمونه‌کارم را در قالب یک فایل طراحی شبکه آماده کرده‌ام و توضیح می‌دهم.',
  'دربارهٔ شیفت کاری باید بگویم که نمی‌توانم شیفت شب کار کنم، چون مسئولیت خانوادگی دارم.',
  'در مورد دورکاری هم مشکلی ندارم و دو روز در هفته را می‌توانم از خانه کار کنم.',
  'قرار است نمونه‌کار را تا پایان هفتهٔ آینده بفرستم و شمارهٔ سرپرست قبلی را هم بدهم.',
  'در مورد حقوق انتظارم با بازهٔ اعلام‌شدهٔ شما هم‌خوان است و سؤال دیگری ندارم.',
  'در پایان پرسیدم که تیم چند نفر است و ابزار مانیتورینگ فعلی چیست.',
].join(' ');

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-summary-'));
  const PORT = 4400 + Math.floor(Math.random() * 300);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'summary-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'LINKEDIN_ACCESS_TOKEN']) delete env[k];

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
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  try {
    const signup = async (orgName: string, email: string) =>
      (await call('POST', '/api/auth/signup', null, { orgName, name: 'مدیر منابع انسانی', email, password: 'Password12345' })).json.token as string;
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
      'سارا,محمدی,"کارشناس شبکه با شش سال تجربه",تهران,آلفا,https://www.linkedin.com/in/sara,Yes,"شبکه",sara@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profileId = imported.json.search.results[0].id;
    const rec = (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: job.id })).json.record;
    assert(Boolean(rec?.id), 'the candidate exists');

    // ------------------------------------------------------------ transcript --
    const draft = await call('POST', '/api/transcripts/text', A, { resumeId: rec.id, title: 'تماس اولیه', text: TRANSCRIPT });
    assert(draft.status === 201 && draft.json.transcript.status === 'ready', 'a manual transcript is stored', `${draft.status}`);
    const transcriptId = draft.json.transcript.id as string;

    const shortText = await call('POST', '/api/transcripts/text', A, { resumeId: rec.id, title: 'پیام کوتاه', text: 'سلام، وقت بخیر.' });
    const tooShort = await call('POST', `/api/transcripts/${shortText.json.transcript.id}/summary`, A, {});
    assert(tooShort.status === 409 && tooShort.json.code === 'TEXT_TOO_SHORT', 'a two-line transcript is refused, not summarised', `${tooShort.status} ${tooShort.json?.code}`);
    assert(/متن/.test(String(tooShort.json.error)), 'the refusal explains what to do first');

    // ------------------------------------------------------------ the engine --
    const made = await call('POST', `/api/transcripts/${transcriptId}/summary`, A, {});
    assert(made.status === 201, 'the summary is created', `${made.status} ${JSON.stringify(made.json?.error || '')}`);
    const sum = made.json.summary;
    assert(sum.source === 'local', 'with no AI key it is labelled «موتور محلی»', String(sum.source));
    assert(/موتور محلی/.test(sum.engineLabel), 'and the label is written out', String(sum.engineLabel));
    assert(typeof made.json.note === 'string' && /هوش مصنوعی/.test(made.json.note), 'the response says why it was the local engine', String(made.json.note).slice(0, 80));
    assert(Boolean(sum.headline) && sum.headline.length > 10, 'it has a headline');
    assert(sum.highlights.length >= 1, 'and at least one highlight', String(sum.highlights.length));
    assert(sum.sentenceCount >= 6, 'it counted the sentences it read', String(sum.sentenceCount));

    // The rule that matters: the local engine cannot invent. Every line must be
    // a substring of the transcript.
    const allLines = [...sum.highlights, ...sum.concerns, ...sum.nextSteps, ...sum.quotes];
    const invented = allLines.filter((line: string) => !TRANSCRIPT.includes(line));
    assert(invented.length === 0, 'every line exists verbatim in the transcript', invented.join(' | ').slice(0, 120));

    assert(sum.concerns.some((c: string) => /شیفت شب/.test(c)), 'the hesitation about night shifts is surfaced', JSON.stringify(sum.concerns));
    assert(sum.nextSteps.some((n: string) => /نمونه‌کار/.test(n)), 'the promise to send a work sample is a next step', JSON.stringify(sum.nextSteps));
    assert(sum.highlights.some((h: string) => /شش سال|شبکه/.test(h)), 'the experience line is a highlight');
    assert(!JSON.stringify(sum).includes('نمره'), 'nothing in the payload looks like a score');

    const listByResume = await call('GET', `/api/summaries?resumeId=${rec.id}`, A);
    assert(listByResume.json.items.length === 1, 'the summary is listed for the candidate', String(listByResume.json.items?.length));
    const listByTranscript = await call('GET', `/api/summaries?transcriptId=${transcriptId}`, A);
    assert(listByTranscript.json.items.length === 1, 'and for its transcript');
    assert((await call('GET', '/api/summaries', A)).status === 400, 'an unfiltered list is refused');

    // A detail that only exists in the transcript («فایروال پالو آلتو») must make
    // the candidate findable — the transcript is part of the evidence.
    const searched = await call('GET', `/api/resumes?q=${encodeURIComponent('پالو آلتو')}`, A);
    assert(searched.json.items.some((r: any) => r.id === rec.id), 'the transcript text is searchable from the candidate list');

    // A second pass is allowed — the transcript may have been corrected.
    const again = await call('POST', `/api/transcripts/${transcriptId}/summary`, A, {});
    assert(again.status === 201 && again.json.summary.id !== sum.id, 'regenerating makes a new summary');
    const afterTwo = await call('GET', `/api/summaries?transcriptId=${transcriptId}`, A);
    assert(afterTwo.json.items.length === 2, 'both are kept, newest first', String(afterTwo.json.items.length));
    assert(afterTwo.json.items[0].id === again.json.summary.id, 'the list starts with the newest');

    // ----------------------------------------------------------- permissions --
    assert((await call('GET', `/api/summaries?resumeId=${rec.id}`, B)).status === 404, 'another workspace cannot read the summaries');
    assert((await call('POST', `/api/transcripts/${transcriptId}/summary`, B, {})).status === 404, 'nor make one');
    assert((await call('DELETE', `/api/summaries/${sum.id}`, B)).status === 404, 'nor delete one');

    // Blind screening: a summary is a summary *of a person* — closed.
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blind = await call('GET', `/api/summaries?resumeId=${rec.id}`, A);
    assert(blind.status === 409 && blind.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode closes the list', `${blind.status}`);
    const blindMake = await call('POST', `/api/transcripts/${transcriptId}/summary`, A, {});
    assert(blindMake.status === 409 && blindMake.json.code === 'BLIND_REVEAL_REQUIRED', 'and refuses to build one', `${blindMake.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // -------------------------------------------------------------- deletion --
    assert((await call('DELETE', `/api/summaries/${sum.id}`, A)).status === 204, 'a summary can be deleted');
    assert((await call('DELETE', `/api/summaries/${sum.id}`, A)).status === 404, 'and is gone afterwards');

    // Blind screening closes transcripts too — they quote the person.
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindTranscripts = await call('GET', `/api/transcripts?resumeId=${rec.id}`, A);
    assert(blindTranscripts.status === 409 && blindTranscripts.json.code === 'BLIND_REVEAL_REQUIRED', 'blind mode closes the transcripts', `${blindTranscripts.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });

    // Deleting the transcript takes its summaries with it.
    assert((await call('DELETE', `/api/transcripts/${transcriptId}`, A)).status === 204, 'the transcript is deleted');
    const leftovers = await call('GET', `/api/summaries?resumeId=${rec.id}`, A);
    assert(leftovers.json.items.length === 0, 'a summary never outlives its transcript', String(leftovers.json.items?.length));

    // DSAR: erasing the candidate counts the summaries too.
    const t2 = await call('POST', '/api/transcripts/text', A, { resumeId: rec.id, title: 'تماس دوم', text: TRANSCRIPT });
    const s2 = await call('POST', `/api/transcripts/${t2.json.transcript.id}/summary`, A, {});
    assert(s2.status === 201, 'a fresh summary exists before erasure');
    const erased = await call('POST', `/api/resumes/${rec.id}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200, 'the candidate can be erased', `${erased.status}`);
    assert((erased.json.erased?.summaries || 0) >= 1, 'the erasure counted the summaries', JSON.stringify(erased.json.erased));
    assert((await call('GET', '/api/summaries?resumeId=' + rec.id, A)).status === 404, 'and nothing is left to read');
  } finally {
    child.kill();
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * End-to-end test of «رونویسی گفتار»:
 *   • with no AI configured, the status says so and the audio path keeps the
 *     file instead of inventing a transcript;
 *   • a hand-written transcript and a subtitle file work with no key at all,
 *     and the subtitle timings survive;
 *   • `.srt` and `.vtt` are both parsed (numbers, comma decimals, markup);
 *   • playback of the original recording needs a signed link that expires;
 *   • a recorded video answer can be sent for transcription and is attached to
 *     the same invitation;
 *   • another workspace sees nothing, erasing a candidate takes the transcript
 *     and its file with it, and everything survives a restart.
 *
 * Run with: npm run build && npx tsx scripts/transcript-api.test.ts
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

const FAKE_MP3 = Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03]), Buffer.alloc(4000, 5)]).toString('base64');

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:04,500',
  'سلام، وقتتان بخیر.',
  '',
  '2',
  '00:00:04,500 --> 00:00:09,000',
  'دربارهٔ سابقهٔ فروش‌تان بگویید.',
  '',
  '3',
  '00:00:09,000 --> 00:00:12,250',
  'سلام، ممنون. پنج سال در تیم فروش بودم.',
].join('\r\n');

const VTT = [
  'WEBVTT',
  '',
  '00:00:01.000 --> 00:00:03.000',
  '<c.colorE5E5E5>اولین جمله</c>',
  '',
  '00:00:03.000 --> 00:00:06.500',
  'دومین جمله با <i>تأکید</i>',
].join('\n');

async function main() {
  const dist = path.join(process.cwd(), 'dist', 'server.cjs');
  if (!fs.existsSync(dist)) throw new Error('Run `npm run build` first.');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-transcript-'));
  const PORT = 6300 + Math.floor(Math.random() * 150);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'transcript-api-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    RETENTION_SWEEP: 'off',
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])
    delete env[k];
  let child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const boot = async () => {
    log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const started = Date.now();
    while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));
  };
  await boot();

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
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };

  try {
    const signup = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت نمونه',
      name: 'مدیر',
      email: 'owner@example.com',
      password: 'Password12345',
    });
    const A = signup.json.token as string;
    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const tplJob = await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس فروش' });
    const job = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس فروش',
        understanding: tplJob.json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;
    const csv = [
      'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email',
      'مینا,رضایی,"کارشناس فروش",تهران,آلفا,https://www.linkedin.com/in/mina,Yes,"فروش",mina@example.ir',
    ].join('\r\n');
    const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: job.id, openToWorkOnly: true });
    const profile = imported.json.search.results[0];
    const resumeId = (
      await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId: profile.id, jobId: job.id })
    ).json.record.id as string;
    assert(Boolean(resumeId), 'a candidate is ready');

    // ---------------------------------------------------------------- status ----
    const status = await call('GET', '/api/transcripts/status', A);
    assert(status.status === 200 && status.json.canTranscribe === false, 'with AI off the status says auto-transcription is unavailable');
    assert(typeof status.json.aiReason === 'string' && status.json.aiReason.length > 5, 'and explains why', String(status.json.aiReason).slice(0, 40));
    assert((await call('GET', '/api/transcripts/status')).status === 401, 'the status needs a session like every workspace route');

    // ------------------------------------------------------------------ text ----
    const short = await call('POST', '/api/transcripts/text', A, { resumeId, text: 'کوتاه' });
    assert(short.status === 400, 'a too-short transcript is refused', `${short.status}`);
    const manual = await call('POST', '/api/transcripts/text', A, { resumeId, text: 'تماس اولیه: کارجو گفت پنج سال در تیم فروش بوده و آمادهٔ شروع است.', title: 'تماس اولیه' });
    assert(manual.status === 201 && manual.json.transcript.status === 'ready', 'a typed transcript is stored', `${manual.status}`);
    assert(manual.json.transcript.provider === 'دستی' && manual.json.transcript.language === 'fa', 'labelled as hand-written and detected as Persian');
    assert(manual.json.transcript.source === 'manual' && manual.json.transcript.title === 'تماس اولیه', 'with its source and title');
    assert(!/filePath|orgId/.test(JSON.stringify(manual.json)), 'the storage path never reaches the browser');

    // -------------------------------------------------------------- subtitles ----
    const srt = await call('POST', '/api/transcripts/subtitle', A, { resumeId, content: SRT, fileName: 'call.srt' });
    assert(srt.status === 201 && srt.json.transcript.cues.length === 3, 'the SRT file yields three cues', `${srt.json.transcript?.cues?.length}`);
    assert(srt.json.transcript.cues[0].startMs === 1000 && srt.json.transcript.cues[0].endMs === 4500, 'with the right comma-decimal timings');
    assert(srt.json.transcript.durationSec === 12, 'and a duration from the last cue', String(srt.json.transcript.durationSec));
    assert(srt.json.transcript.text.split('\n').length === 3, 'the flat text keeps one line per cue');
    assert(srt.json.transcript.provider === 'پردازش محلی', 'labelled as parsed locally, not by an AI');

    const vtt = await call('POST', '/api/transcripts/subtitle', A, { resumeId, content: VTT, fileName: 'call.vtt' });
    assert(vtt.status === 201 && vtt.json.transcript.cues.length === 2, 'a WebVTT file parses too', `${vtt.json.transcript?.cues?.length}`);
    assert(vtt.json.transcript.cues[0].text === 'اولین جمله', 'with markup stripped', vtt.json.transcript?.cues?.[0]?.text);
    assert(vtt.json.transcript.cues[1].text === 'دومین جمله با تأکید', 'including italic tags');

    const txt = await call('POST', '/api/transcripts/subtitle', A, { resumeId, content: 'این یک متن ساده است که کسی از گوشی فرستاده.\nخط دوم.', fileName: 'note.txt' });
    assert(txt.status === 201 && txt.json.transcript.cues === null, 'a plain text file is accepted without fake timings');

    const empty = await call('POST', '/api/transcripts/subtitle', A, { resumeId, content: '', fileName: 'x.srt' });
    assert(empty.status === 400, 'an empty file is refused', `${empty.status}`);

    // ----------------------------------------------------------------- audio ----
    const audio = await call('POST', '/api/transcripts/audio', A, {
      resumeId,
      fileName: 'call.mp3',
      mimeType: 'audio/mpeg',
      dataBase64: FAKE_MP3,
      durationSec: 95,
    });
    assert(audio.status === 202, 'with AI off the upload is accepted but waits for text', `${audio.status}`);
    assert(audio.json.transcript.status === 'needs_text' && audio.json.transcript.text === '', 'no transcript is invented');
    assert(/Gemini|تنظیم|متن/.test(String(audio.json.note)), 'and the note names the real reason', String(audio.json.note).slice(0, 40));
    assert(audio.json.transcript.durationSec === 95 && audio.json.transcript.sizeBytes > 1000, 'the file metadata is kept');
    const audioId = audio.json.transcript.id as string;
    const audioUrl = audio.json.transcript.audioUrl as string;
    assert(/\/api\/transcripts\/watch\//.test(audioUrl || ''), 'a signed playback link is offered', String(audioUrl));

    const playback = await fetch(BASE + audioUrl);
    assert(playback.status === 200 && playback.headers.get('content-type') === 'audio/mpeg', 'the original file plays', `${playback.status}`);
    assert((await playback.arrayBuffer()).byteLength > 3000, 'with the real bytes');
    const ranged = await fetch(BASE + audioUrl, { headers: { Range: 'bytes=0-99' } });
    assert(ranged.status === 206 && (await ranged.arrayBuffer()).byteLength === 100, 'a Range request works', `${ranged.status}`);
    assert((await fetch(BASE + audioUrl.replace(/sig=[^&]+/, 'sig=bad'))).status === 403, 'a tampered signature is refused');

    const badType = await call('POST', '/api/transcripts/audio', A, { resumeId, fileName: 'x.pdf', mimeType: 'application/pdf', dataBase64: FAKE_MP3 });
    assert(badType.status === 400 && badType.json.code === 'BAD_MEDIA', 'a PDF is refused as a recording', `${badType.status}`);

    const filled = await call('PATCH', `/api/transcripts/${audioId}`, A, { text: 'سلام، پنج سال در تیم فروش بودم و آمادهٔ شروع هستم.' });
    assert(filled.status === 200 && filled.json.transcript.status === 'ready', 'HR pastes the text and the row becomes readable');
    assert(filled.json.transcript.provider === 'دستی (بازبینی‌شده)', 'and is no longer labelled as the provider’s output', String(filled.json.transcript.provider));

    // ---------------------------------------------------------- video answer ----
    const settings = await call('PUT', '/api/video/settings', A, {
      jobId: job.id,
      enabled: true,
      retakes: 0,
      questions: [{ id: 'q1', text: 'خودتان را معرفی کنید.', seconds: 60 }],
    });
    assert(settings.status === 200, 'video questions are on for a transcription test');
    const invite = await call('POST', '/api/video/invites', A, { resumeId });
    const token = String(invite.json.invite.url).split('/video/')[1];
    const upload = await fetch(`${BASE}/api/video/public/${token}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 'q1', dataBase64: FAKE_MP3, mimeType: 'video/webm', durationMs: 30_000 }),
    });
    assert(upload.status === 200, 'a video answer is recorded');
    const inviteId = invite.json.invite.id as string;
    const videoTranscript = await call('POST', `/api/transcripts/video/${inviteId}/q1`, A);
    assert(videoTranscript.status === 202, 'transcribing an answer without AI keeps the row with a reason', `${videoTranscript.status}`);
    assert(videoTranscript.json.transcript.videoInviteId === inviteId && videoTranscript.json.transcript.questionId === 'q1', 'and links it to that answer');
    assert((await call('POST', `/api/transcripts/video/${inviteId}/q9`, A)).status === 404, 'an answer that does not exist is a clean 404');

    // ----------------------------------------------------------------- lists ----
    const list = await call('GET', `/api/transcripts?resumeId=${resumeId}`, A);
    assert(list.status === 200 && list.json.items.length === 6, 'the candidate has six transcripts (manual, SRT, VTT, txt, audio, video)', String(list.json.items.length));
    const byInvite = await call('GET', `/api/transcripts?videoInviteId=${inviteId}`, A);
    assert(byInvite.json.items.length === 1, 'and one of them belongs to the video answer');
    assert((await call('GET', '/api/transcripts', A)).status === 400, 'a list without a candidate or invitation is refused');

    // --------------------------------------------------------------- search ----
    const found = await call('GET', `/api/resumes?q=${encodeURIComponent('پنج سال در تیم فروش')}`, A);
    assert(found.status === 200 && found.json.items.some((r: any) => r.id === resumeId), 'a phrase heard on the call finds the candidate', String(found.json.items?.length));

    // ------------------------------------------------------ blind screening ----
    await call('PATCH', '/api/org', A, { blindScreening: true });
    const blindList = await call('GET', `/api/transcripts?resumeId=${resumeId}`, A);
    assert(blindList.status === 409 && blindList.json.code === 'BLIND_REVEAL_REQUIRED', 'blind screening hides transcripts until the identity is revealed', `${blindList.status}`);
    await call('PATCH', '/api/org', A, { blindScreening: false });
    assert((await call('GET', `/api/transcripts?resumeId=${resumeId}`, A)).status === 200, 'and they come back when it is off');

    // ----------------------------------------------------------- other tenant ----
    const other = await call('POST', '/api/auth/signup', null, {
      orgName: 'شرکت دوم',
      name: 'مدیر دوم',
      email: 'owner2@example.com',
      password: 'Password12345',
    });
    const B = other.json.token as string;
    assert((await call('GET', `/api/transcripts?resumeId=${resumeId}`, B)).json.items.length === 0, 'another workspace sees none of it');
    assert((await call('GET', `/api/transcripts/${audioId}`, B)).status === 404, 'and cannot read one by id');

    // ------------------------------------------------------------- deletion ----
    const del = await call('DELETE', `/api/transcripts/${audioId}`, A);
    assert(del.status === 204, 'HR can delete a transcript', `${del.status}`);
    assert((await fetch(BASE + audioUrl)).status === 404, 'its recording goes with it');

    // ---------------------------------------------------------- DSAR erasure ----
    const erased = await call('POST', `/api/resumes/${resumeId}/erase`, A, { confirm: 'ERASE' });
    assert(erased.status === 200 && erased.json.erased.transcripts >= 3, 'erasing a candidate takes their transcripts too', String(erased.json.erased?.transcripts));

    // -------------------------------------------------------------- restart ----
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 700));
    child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await boot();
    const afterRestart = await call('GET', '/api/transcripts/status', A);
    assert(afterRestart.status === 200, 'the module is healthy after a restart', `${afterRestart.status}`);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(DATA, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Unit tests for «اتوماسیون جذب» — the rules engine with no network and no
 * server. What is proposed, what is never proposed, and whether a message can
 * ever reach a candidate without a human.
 * Run with: npx tsx scripts/automation.test.ts
 */
import { DEFAULT_AUTOMATION, normalizeAutomationSettings, renderTemplate } from '../server/automation-settings';
import { decideAction, suggestedSlot } from '../server/automation';
import type { AutomationSettings } from '../src/types/automation';
import type { ResumeRecord } from '../src/types/screening';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const T = (over: Partial<AutomationSettings> = {}): AutomationSettings => normalizeAutomationSettings({ ...DEFAULT_AUTOMATION, ...over });

function candidate(over: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    id: 'res_test',
    jobId: 'job_test',
    candidateName: 'سارا محمدی',
    score: 82,
    category: 'INTERVIEW',
    novelty: 'fresh',
    contact: { email: 'sara@example.ir', phone: '09121234567' },
    decisionStatus: null,
    messageStatus: null,
    unjudgeableReason: null,
    ...over,
  } as unknown as ResumeRecord;
}

const decide = (rec: Partial<ResumeRecord>, settings: AutomationSettings = T()) => decideAction(candidate(rec), settings);

// --------------------------------------------------------------- defaults ---

assert(DEFAULT_AUTOMATION.autoInvite === false, 'sending an invitation without approval is off by default');
assert(DEFAULT_AUTOMATION.autoReject === false, 'sending a rejection without approval is off by default');
assert(DEFAULT_AUTOMATION.inviteThreshold > DEFAULT_AUTOMATION.rejectThreshold, 'the invite threshold sits above the reject threshold');
assert(DEFAULT_AUTOMATION.templates.invite.subject.length > 0 && DEFAULT_AUTOMATION.templates.invite.body.length > 0, 'the invitation template is pre-filled');
assert(DEFAULT_AUTOMATION.useSignature === true, 'the workspace signature is appended by default');

// -------------------------------------------------------------- normalise ---

{
  const n = normalizeAutomationSettings({ inviteThreshold: 80, rejectThreshold: 35, enabled: true });
  assert(n.inviteThreshold === 80 && n.rejectThreshold === 35, 'thresholds are kept as given');
  assert(n.enabled === true, 'the master switch is kept as given');
}

{
  const n = normalizeAutomationSettings({ inviteThreshold: 20, rejectThreshold: 70 });
  assert(n.inviteThreshold >= n.rejectThreshold, 'crossed thresholds are corrected, never inverted', `${n.rejectThreshold}..${n.inviteThreshold}`);
}

{
  const n = normalizeAutomationSettings({ inviteThreshold: -40, rejectThreshold: 400 });
  assert(n.inviteThreshold >= 0 && n.inviteThreshold <= 100, 'negative thresholds are clamped to 0..100', String(n.inviteThreshold));
  assert(n.rejectThreshold >= 0 && n.rejectThreshold <= 100, 'oversized thresholds are clamped to 0..100', String(n.rejectThreshold));
}

{
  const n = normalizeAutomationSettings({ inviteThreshold: 70.6, rejectThreshold: 39.2, autoInvite: 'yes' as any });
  assert(Number.isInteger(n.inviteThreshold) && Number.isInteger(n.rejectThreshold), 'thresholds are whole numbers');
  assert(n.autoInvite === false, 'a truthy-but-not-true auto-send flag stays off — never «on» by accident');
}

{
  const n = normalizeAutomationSettings({ templates: { invite: { subject: '   ', body: '' }, reject: { subject: '', body: '  ' } } });
  assert(n.templates.invite.subject.length > 0 && n.templates.invite.body.length > 0, 'an empty invitation template falls back to the default');
  assert(n.templates.reject.subject.length > 0 && n.templates.reject.body.length > 0, 'an empty rejection template falls back to the default');
}

{
  const n = normalizeAutomationSettings({ hourlyLimit: 0, scheduleDaysAhead: 99, scheduleHour: '25:99', scheduleDurationMin: 9999 });
  assert(n.hourlyLimit >= 1, 'the hourly cap can never be zero (a stuck state)', String(n.hourlyLimit));
  assert(n.scheduleDaysAhead <= 30, 'the lead time stays inside a month', String(n.scheduleDaysAhead));
  assert(n.scheduleHour === DEFAULT_AUTOMATION.scheduleHour, 'an impossible time falls back instead of booking nonsense', n.scheduleHour);
  assert(n.scheduleDurationMin <= 240, 'the duration stays sane', String(n.scheduleDurationMin));
}

{
  const n = normalizeAutomationSettings({ scheduleHour: '۹:۰۵' });
  assert(n.scheduleHour === '09:05', 'Persian digits and a single-digit hour are accepted', n.scheduleHour);
}

// -------------------------------------------------------------- templating --

{
  const out = renderTemplate('سلام {{نام}} عزیز، برای «{{عنوان شغلی}}» در {{شرکت}} دعوت می‌شوید.', {
    name: 'سارا محمدی',
    roleTitle: 'کارشناس شبکه',
    orgName: 'آوا',
  });
  assert(out === 'سلام سارا محمدی عزیز، برای «کارشناس شبکه» در آوا دعوت می‌شوید.', 'placeholders are replaced with the real values', out);
}

{
  const out = renderTemplate('سلام {{نام}}، {{چیز ناموجود}}', { name: 'رضا', roleTitle: '', orgName: '' });
  assert(out.includes('رضا'), 'known variables are filled');
  assert(!out.includes('{{'), 'no raw placeholder survives into a message a candidate sees', out);
}

{
  const out = renderTemplate('درخواست شما برای «{{عنوان شغلی}}» ثبت شد.', { name: '', roleTitle: 'کارشناس فروش', orgName: 'آوا' });
  assert(out === 'درخواست شما برای «کارشناس فروش» ثبت شد.', 'an unfilled variable does not leave an empty «» behind', out);
}

{
  const out = renderTemplate('امتیاز {{امتیاز}} از ۱۰۰', { name: '', roleTitle: '', orgName: '', score: 82 });
  assert(out === 'امتیاز ۸۲ از ۱۰۰', 'the score is written in Persian digits', out);
}

{
  const out = renderTemplate('بدون متغیر', { name: '', roleTitle: '', orgName: '' });
  assert(out === 'بدون متغیر', 'a template without variables is untouched');
}

// ----------------------------------------------------------------- slot -----

{
  const now = new Date('2026-10-27T06:00:00.000Z'); // 09:30 Tehran
  const slot = suggestedSlot(T({ scheduleDaysAhead: 3, scheduleHour: '10:30' }), now);
  assert(slot.iso === '2026-10-30T07:00:00.000Z', '10:30 Tehran three days later is 07:00 UTC', slot.iso);
  assert(slot.time === '10:30', 'the reported time is the Tehran wall clock', slot.time);
}

{
  const now = new Date('2026-10-27T21:00:00.000Z'); // 00:30 Tehran, next day
  const slot = suggestedSlot(T({ scheduleDaysAhead: 1, scheduleHour: '09:00' }), now);
  assert(new Date(slot.iso).getTime() > now.getTime(), 'the suggested slot is always in the future', slot.iso);
  const iso = new Date(slot.iso);
  assert(iso.getUTCHours() === 5 && iso.getUTCMinutes() === 30, 'Tehran is +03:30 year-round — 09:00 becomes 05:30 UTC', slot.iso);
}

{
  const now = new Date('2026-10-27T06:00:00.000Z');
  const a = suggestedSlot(T(), now);
  const b = suggestedSlot(T(), now);
  assert(a.iso === b.iso, 'the same input suggests the same slot (no randomness to explain away)');
}

// -------------------------------------------------------------- decisions ---

{
  const d = decide({ score: 95 });
  assert('kind' in d && d.kind === 'invite', 'a high score is proposed as an invitation');
  assert('kind' in d && d.reason.includes('۹۵'), 'the reason quotes the actual score', 'kind' in d ? d.reason : '');
}

{
  const d = decide({ score: 12, category: 'REJECT' });
  assert('kind' in d && d.kind === 'reject', 'a low score is proposed as a rejection');
}

{
  const d = decide({ score: 55 });
  assert('skip' in d, 'a score between the thresholds is left to a human');
  assert('skip' in d && d.skip.includes('بین دو آستانه'), 'and the sentence says why', 'skip' in d ? d.skip : '');
}

{
  const d = decide({ score: 95, category: 'ERROR' });
  assert('skip' in d, 'a résumé that was never analysed is never proposed');
}

{
  const d = decide({ score: 95, unjudgeableReason: 'متن کافی نبود' });
  assert('skip' in d, 'an unjudgeable résumé is never proposed');
}

{
  const d = decide({ score: 95, novelty: 'duplicate' });
  assert('skip' in d, 'a duplicate in the same department is never proposed again');
}

{
  const d = decide({ score: 95, contact: { email: null, phone: '09121234567' } as any });
  assert('skip' in d, 'a candidate with no e-mail is not proposed an e-mail');
}

{
  const d = decide({ score: 95, contact: { email: 'not-an-email', phone: null } as any });
  assert('skip' in d, 'a malformed address is treated as no address');
}

{
  const d = decide({ score: 95, decisionStatus: 'rejected', messageStatus: 'sent' });
  assert('skip' in d, 'nobody is told «no» twice');
}

{
  const d = decide({ score: 95, decisionStatus: 'approved', messageStatus: 'sent' });
  assert('skip' in d, 'nobody is invited twice');
}

{
  const d = decide({ score: 5, decisionStatus: 'approved' });
  assert('kind' in d && d.kind === 'invite', 'a human decision beats the score: approved means invite', 'kind' in d ? d.kind : '');
}

{
  const d = decide({ score: 99, decisionStatus: 'rejected' });
  assert('kind' in d && d.kind === 'reject', 'a human decision beats the score: rejected means rejection', 'kind' in d ? d.kind : '');
}

{
  const d = decide({ score: 95 }, T({ autoScheduleOnInvite: true }));
  assert('kind' in d && d.kind === 'schedule', 'when scheduling is on, the proposal carries a slot instead of only a message', 'kind' in d ? d.kind : '');
}

{
  const d = decide({ score: 95 }, T({ inviteThreshold: 96, rejectThreshold: 40 }));
  assert('skip' in d, 'changing the threshold changes the proposal — the number comes from settings, not the code');
}

if (failures > 0) {
  console.error(`\n${failures} automation test(s) failed.`);
  process.exit(1);
}
console.log('\nAll automation unit tests passed.');

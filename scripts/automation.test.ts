/**
 * Pure tests for «اتوماسیون جذب»: the rules that decide what happens to a
 * candidate, the templates that are rendered into real messages, and the slot a
 * booking proposal suggests.
 *
 * These run without a server or a database on purpose — the decision logic is the
 * part HR has to be able to trust, so it must be testable in isolation.
 *
 * Run with: npx tsx scripts/automation.test.ts
 */
import { DEFAULT_AUTOMATION, normalizeAutomationSettings, renderTemplate } from '../server/automation-settings';
import { decideAction, previewProposal, suggestedSlot } from '../server/automation';
import type { ResumeRecord } from '../src/types/screening';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from '../server/tehran-time';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

/** A candidate that looks like one the screening engine really produces. */
function candidate(patch: Partial<ResumeRecord> = {}): ResumeRecord {
  return {
    id: 'res_1',
    jobId: 'job_1',
    orgId: 'org_1',
    uploadedBy: null,
    departmentId: 'dep_fin',
    departmentName: 'مالی و حسابداری',
    roleTitle: 'کارشناس حسابداری صنعتی',
    fileName: 'cv.pdf',
    filePath: null,
    fileSize: 1000,
    extractedText: 'متن',
    unjudgeableReason: null,
    errorMessage: null,
    candidateName: 'مریم کاظمی',
    contact: { email: 'maryam@example.com', phone: '09120000000', city: 'تهران' },
    facts: null,
    criterionScores: [],
    score: 82,
    confidence: 'high',
    engine: 'local',
    recommendation: 'interview',
    summary: '',
    whyCategory: '',
    strengths: [],
    weaknesses: [],
    knockoutMisses: [],
    tags: [],
    bankSuggested: false,
    flags: null,
    deepFindings: null,
    category: 'INTERVIEW',
    rankInCategory: 1,
    analysisHistory: [],
    novelty: 'new',
    inBank: false,
    bankDepartmentId: null,
    bankNote: null,
    bankTags: [],
    addedToBankAtJalali: null,
    addedToBankAtISO: null,
    messageStatus: 'none',
    lastMessagedAtJalali: null,
    decisionStatus: 'none',
    decidedAtJalali: null,
    decidedAtISO: null,
    decidedBy: null,
    decidedByName: null,
    decisionNote: null,
    deepAnalysisAtJalali: null,
    createdAtISO: new Date().toISOString(),
    createdAtJalali: '۱۴۰۵/۰۷/۰۱',
    updatedAtISO: new Date().toISOString(),
    ...patch,
  } as ResumeRecord;
}

const settings = DEFAULT_AUTOMATION;

// ---------------------------------------------------------------- settings ----

{
  const clamped = normalizeAutomationSettings({ inviteThreshold: 30, rejectThreshold: 70 });
  assert(clamped.inviteThreshold === 70 && clamped.rejectThreshold === 70, 'the invite line can never sit below the reject line', `${clamped.inviteThreshold}/${clamped.rejectThreshold}`);
}
{
  const safe = normalizeAutomationSettings({
    enabled: 'yes',
    inviteThreshold: 1000,
    rejectThreshold: -5,
    hourlyLimit: 5000,
    scheduleHour: '25:99',
    scheduleDurationMin: 1,
    templates: { invite: { subject: '', body: '' } },
  });
  assert(safe.enabled === true, 'a non-boolean master switch falls back to the default instead of turning on/off oddly');
  assert(safe.inviteThreshold === 100 && safe.rejectThreshold === 0, 'thresholds are clamped to 0..100');
  assert(safe.hourlyLimit === 120, 'the hourly cap is clamped to the global ceiling');
  assert(safe.scheduleHour === DEFAULT_AUTOMATION.scheduleHour, 'an impossible slot time falls back to the default');
  assert(safe.scheduleDurationMin === 15, 'a too-short interview is raised to the minimum');
  assert(safe.templates.invite.subject === DEFAULT_AUTOMATION.templates.invite.subject, 'an empty template is replaced, not sent empty');
}
{
  const persian = normalizeAutomationSettings({ scheduleHour: '۹:۱۵' });
  assert(persian.scheduleHour === '09:15', 'a slot typed with Persian digits is understood', persian.scheduleHour);
}
{
  const fresh = normalizeAutomationSettings(null);
  assert(fresh.autoInvite === false && fresh.autoReject === false, 'auto-send is off by default — a human decides');
  assert(fresh.enabled === true, 'the engine itself is on by default (it only proposes)');
}
{
  // A stored setting cannot silently opt a workspace into automatic sending.
  const sneaky = normalizeAutomationSettings({ autoInvite: 'true', autoReject: 1 });
  assert(sneaky.autoInvite === false && sneaky.autoReject === false, 'only a real `true` enables automatic sending');
}

// --------------------------------------------------------------- templates ----

{
  const body = renderTemplate('{{نام}} عزیز،\n\nبرای «{{عنوان شغلی}}» در {{شرکت}}.\n\n{{امضای سازمان}}', {
    name: 'مریم',
    roleTitle: 'کارشناس حسابداری',
    orgName: 'شرکت الف',
    signature: 'واحد منابع انسانی',
    department: 'مالی',
  });
  assert(body.startsWith('مریم عزیز،'), 'the candidate name is filled in');
  assert(body.includes('کارشناس حسابداری') && body.includes('شرکت الف'), 'the role and the company are filled in');
  assert(body.includes('واحد منابع انسانی'), 'the signature is appended in place');
}
{
  const rendered = renderTemplate('امتیاز شما: {{امتیاز}} از ۱۰۰\n{{نام ناشناخته}}', {
    name: 'حسین',
    roleTitle: 'حسابدار',
    orgName: 'شرکت ب',
    score: 73.6,
  });
  assert(rendered.includes('۷۴'), 'numbers are shown with Persian digits', rendered.split('\n')[0]);
  assert(!rendered.includes('{{'), 'an unknown placeholder never reaches the candidate');
}
{
  const signed = renderTemplate('با احترام\n{{امضای سازمان}}', {
    name: 'مریم',
    roleTitle: 'نقش',
    orgName: 'شرکت',
    signature: 'با احترام\nواحد منابع انسانی',
  });
  assert(signed.split('\n').filter((l) => l === 'با احترام').length === 1, 'a signature that repeats the closing line is not duplicated', JSON.stringify(signed));
}
{
  const empty = renderTemplate('سلام\n\n{{امضای سازمان}}\n\nپایان', { name: 'سارا', roleTitle: 'نقش', orgName: 'شرکت' });
  assert(!/\n{3,}/.test(empty) && empty.endsWith('پایان'), 'an empty variable collapses instead of leaving a hole');
}
{
  const scoreOnly = renderTemplate('{{امتیاز}}', { name: 'x', roleTitle: 'y', orgName: 'z' });
  assert(scoreOnly === '', 'a missing score renders as nothing, not «NaN»', scoreOnly);
}

// ---------------------------------------------------------------- decisions ----

{
  const d = decideAction(candidate({ score: 85 }), settings);
  assert('kind' in d && d.kind === 'invite', 'a score above the invite line proposes an invitation');
  assert('reason' in d && /۸۵/.test(d.reason), 'the reason carries the number that produced it', 'reason' in d ? d.reason : '');
}
{
  const d = decideAction(candidate({ score: 20, category: 'REJECT' }), settings);
  assert('kind' in d && d.kind === 'reject', 'a score below the reject line proposes the rejection letter');
}
{
  const d = decideAction(candidate({ score: 55, category: 'REVIEW' }), settings);
  assert('skip' in d && /بین دو آستانه/.test(d.skip), 'a score between the two lines is left to the human', 'skip' in d ? d.skip : '');
}
{
  const d = decideAction(candidate({ score: 90, novelty: 'duplicate' }), settings);
  assert('skip' in d && /تکراری/.test(d.skip), 'a duplicate of the same department is never messaged');
}
{
  const d = decideAction(candidate({ score: 90, contact: { email: null, phone: null, city: null } }), settings);
  assert('skip' in d && /ایمیل/.test(d.skip), 'a candidate without an address is skipped with the reason');
}
{
  const d = decideAction(candidate({ score: 90, category: 'ERROR' }), settings);
  assert('skip' in d && /تحلیل/.test(d.skip), 'an unanalysed résumé is not messaged');
}
{
  const d = decideAction(candidate({ score: 90, decisionStatus: 'rejected' }), settings);
  assert('kind' in d && d.kind === 'reject', 'a human rejection wins over the score (the letter is still owed)');
}
{
  const d = decideAction(candidate({ score: 10, decisionStatus: 'approved' }), settings);
  assert('kind' in d && d.kind === 'invite', 'a human approval wins over a low score');
}
{
  const d = decideAction(candidate({ score: 95, messageStatus: 'sent', decisionStatus: 'approved' }), settings);
  assert('skip' in d, 'a candidate already messaged is not messaged twice');
}
{
  const scheduling = normalizeAutomationSettings({ ...settings, autoScheduleOnInvite: true });
  const d = decideAction(candidate({ score: 95 }), scheduling);
  assert('kind' in d && d.kind === 'schedule', 'with «book instead of invite» on, a strong candidate gets a slot proposal');
}

// -------------------------------------------------------------------- slot ----

{
  const slot = suggestedSlot(normalizeAutomationSettings({ scheduleDaysAhead: 3, scheduleHour: '10:30' }), new Date('2026-10-27T08:00:00Z'));
  const expectedDate = formatJalaliDate(tehranJalaliOf(new Date('2026-10-30T08:00:00Z')), true);
  assert(slot.date === expectedDate, 'the suggested day is N days ahead in Tehran', `${slot.date} / ${expectedDate}`);
  assert(slot.iso.endsWith('T07:00:00.000Z'), '10:30 Tehran is 07:00 UTC', slot.iso);
  assert(slot.time === '10:30', 'the suggested time is the configured one');
}

// ---------------------------------------------------------------- a message ----

{
  const org = {
    id: 'org_1',
    name: 'گروه صنعتی البرز',
    messageSignature: 'واحد منابع انسانی — گروه صنعتی البرز',
    departments: [],
  } as any;
  const preview = previewProposal(org, candidate({ score: 88 }), settings);
  assert('skip' in preview === false, 'a strong candidate produces a draft');
  if (!('skip' in preview)) {
    assert(preview.kind === 'invite', 'the draft is an invitation');
    assert(preview.subject.includes('کارشناس حسابداری صنعتی'), 'the subject names the role', preview.subject);
    assert(preview.body.includes('مریم') && preview.body.includes('گروه صنعتی البرز'), 'the body is addressed and signed');
    assert(!preview.body.includes('{{'), 'no placeholder survives into the draft');
    assert(preview.suggestedAtISO === null, 'a plain invitation carries no slot (the candidate proposes times)');
  }

  const scheduling = normalizeAutomationSettings({ ...settings, autoScheduleOnInvite: true });
  const booking = previewProposal(org, candidate({ score: 88 }), scheduling);
  if (!('skip' in booking)) {
    assert(Boolean(booking.suggestedAtISO), 'a booking proposal carries the suggested slot');
    assert(/ساعت/.test(booking.body) || !booking.body.includes('{{تاریخ}}'), 'the date placeholder is resolved in the text');
  } else {
    assert(false, 'a booking proposal should exist');
  }
  void org;
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

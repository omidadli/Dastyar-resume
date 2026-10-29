/**
 * Unit tests for HOVIDA's pure logic and for the bugs fixed in the rebuild.
 * Run with: npx tsx scripts/unit.test.ts
 */
import { buildAnswersBrief, buildTemplateUnderstanding, evaluateResumeLocal, finalizeEvaluation, repairUnderstanding } from '../server/ai/screening';
import { rtfToText } from '../src/lib/rtf';
import { safeExt } from '../server/db';
import { matchesSearch, normalizeForSearch, normalizePersianText } from '../src/lib/normalizeFa';
import { faRelative } from '../src/lib/format';
import { assemblePageText, restoreZwnj, type PdfTextItem } from '../src/lib/pdfLayout';
import { blindLabel, maskText, redactRecord } from '../server/blind';
import { bankSummary, matchPacksByCriteria, matchRole } from '../server/interview-kit';
import { buildTeamReport } from '../server/team-report';
import { COST_KINDS, byKind, normalizeAssumption, readAssumptionInput, readCostInput } from '../server/costs';
import { OidcError, decodeJwt, safeEndpoint, verifyIdToken, clearOidcCaches } from '../server/oidc';
import { emailDomain, identityFromClaims, normalizeDomains } from '../server/sso';
import crypto from 'crypto';
import { base32Decode, base32Encode, generateRecoveryCodes, generateSecret, hashRecoveryCode, hotp, otpauthUrl, secondsLeft, stepAt, verifyTotp } from '../server/totp';
import fs from 'fs';
import path from 'path';
import type { JobUnderstanding } from '../src/types/screening';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

const u: JobUnderstanding = {
  department: 'فروش',
  departmentId: 'sales',
  roleTitle: 'کارشناس فروش',
  seniority: 'کارشناسی',
  plainExplanation: 'تست',
  thresholds: { interview: 75, review: 50 },
  criteria: [
    { id: 'c1', title: 'سابقه فروش', weight: 60, mustHave: true },
    { id: 'c2', title: 'مذاکره', weight: 40, mustHave: false },
  ],
  questions: [
    { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه فروش حضوری', weight: 20, defaultChecked: true },
    { id: 'q2', kind: 'bonus', type: 'boolean', label: 'کار با CRM', weight: 10, defaultChecked: false },
    { id: 'q3', kind: 'bonus', type: 'boolean', label: 'گواهی‌نامه رانندگی', weight: 10, defaultChecked: true },
  ],
};

// ---- buildAnswersBrief: explicit answers always win (bug #1) ----
{
  const brief = buildAnswersBrief(u, { q2: true, q3: false });
  assert(brief.includes('کار با CRM'), 'a user-ticked optional criterion (default unchecked) is sent to the AI', brief);
  assert(!brief.includes('گواهی‌نامه رانندگی'), 'an explicitly un-ticked default criterion is not sent');
  assert(brief.includes('سابقه فروش حضوری'), 'an unanswered default-checked knockout still applies');
}

// ---- finalizeEvaluation: no more inflated experience (bug #2) ----
{
  const raw = { score: 70, criterionScores: [], facts: { yearsExperience: null } };
  const text = 'تحصیلات ۱۳۸۸ تا ۱۳۹۲ — دانشگاه تهران\nسوابق: کارشناس فروش از ۱۴۰۲ تا ۱۴۰۴';
  const ev = finalizeEvaluation(raw, u, {}, 'ai', text);
  assert(ev.facts.yearsExperience === null, 'years mentioned in education are no longer counted as experience', String(ev.facts.yearsExperience));

  const ev2 = finalizeEvaluation(raw, u, {}, 'ai', 'دارای ۵ سال سابقه فروش میدانی');
  assert(ev2.facts.yearsExperience === 5, 'an explicitly stated «۵ سال سابقه» fills a missing value', String(ev2.facts.yearsExperience));

  const ev3 = finalizeEvaluation({ ...raw, facts: { yearsExperience: 3 } }, u, {}, 'ai', 'بیش از ۱۰ سال سابقه در صنعت');
  assert(ev3.facts.yearsExperience === 3, 'the model value is never overridden by text heuristics', String(ev3.facts.yearsExperience));
}

// ---- hard ceiling rules still hold ----
{
  const ev = finalizeEvaluation(
    { score: 90, criterionScores: [{ criterionId: 'c1', score: 20 }, { criterionId: 'c2', score: 95 }], knockoutMisses: [] },
    u,
    {},
    'ai'
  );
  assert(ev.score <= 45 && ev.recommendation === 'REJECT', 'a missing must-have caps the score at 45', `score=${ev.score}`);
}

// ---- finalizeEvaluation: messy model output never zeroes or crashes (bug audit) ----
{
  const ev = finalizeEvaluation({ score: '78/100', criterionScores: [{ criterionId: 'c1', score: '' }, { criterionId: 'c2', score: '85/100' }] }, u, {}, 'ai');
  const c1 = ev.criterionScores.find((c) => c.criterionId === 'c1')!;
  const c2 = ev.criterionScores.find((c) => c.criterionId === 'c2')!;
  assert(c1.score === 40, 'an empty criterion score falls back to 40 (not 0 → must-have cap)', String(c1.score));
  assert(c2.score === 85, '«85/100» reads as 85 (not 85100 → 100)', String(c2.score));

  const map = finalizeEvaluation({ score: 75, criterionScores: { c1: 80, c2: { score: '۷۰٪', rationale: 'مذاکره با مشتریان کلیدی' } } }, u, {}, 'ai');
  assert(
    map.criterionScores.find((c) => c.criterionId === 'c1')?.score === 80 && map.criterionScores.find((c) => c.criterionId === 'c2')?.score === 70,
    'criterionScores as an object map are understood',
    JSON.stringify(map.criterionScores.map((c) => c.score))
  );

  let threw = '';
  let messy: ReturnType<typeof finalizeEvaluation> | null = null;
  try {
    messy = finalizeEvaluation(
      {
        score: 70,
        criterionScores: [null, { criterionId: 'c1', score: 72 }, { criterionId: 'c2', score: 68 }],
        strengths: ['ارتباط قوی با مشتری', null, { point: 'مذاکره', evidence: 'قرارداد سالانه' }],
        weaknesses: [null, 'سابقه مدیریتی ذکر نشده'],
        knockoutMisses: [null],
        tags: [{ label: 'فروش' }, 'B2B', null],
        facts: { yearsExperience: 'نامشخص', skills: [{ name: 'Excel' }, 'CRM', null, { skill: 'مذاکره' }], expectedSalary: 45 },
      },
      u,
      {},
      'ai'
    );
  } catch (e: any) {
    threw = e.message;
  }
  assert(!threw && messy !== null, 'null entries and plain strings in lists do not throw (the AI result is kept)', threw);
  if (messy) {
    assert(messy.strengths.length === 2 && messy.strengths[0].point === 'ارتباط قوی با مشتری', 'string strengths become points', JSON.stringify(messy.strengths));
    assert(messy.weaknesses.length === 1 && messy.weaknesses[0].point === 'سابقه مدیریتی ذکر نشده', 'string weaknesses become points');
    assert(messy.facts.yearsExperience === null, 'non-numeric years → unknown (not 0)', String(messy.facts.yearsExperience));
    assert(messy.facts.skills.join(',') === 'Excel,CRM,مذاکره', 'skills given as objects are named, not «[object Object]»', messy.facts.skills.join(','));
    assert(messy.tags.join(',') === 'فروش,B2B', 'tags given as objects are named', messy.tags.join(','));
    assert(messy.facts.expectedSalary === '45', 'a numeric salary is kept as text');
  }
  const yrs = finalizeEvaluation({ score: 70, criterionScores: [], facts: { yearsExperience: '۵ سال' } }, u, {}, 'ai');
  assert(yrs.facts.yearsExperience === 5, '«۵ سال» → 5', String(yrs.facts.yearsExperience));
  const ko = finalizeEvaluation({ score: 90, criterionScores: [{ criterionId: 'c1', score: 90 }, { criterionId: 'c2', score: 90 }], knockoutMisses: [{ title: 'سابقه فروش حضوری' }] }, u, {}, 'ai');
  assert(ko.knockoutMisses.length === 1 && ko.knockoutMisses[0] === 'سابقه فروش حضوری', 'knockout misses given as objects still count', JSON.stringify(ko.knockoutMisses));
}

// ---- repairUnderstanding: user-edited criteria are normalized ----
{
  const dept = { id: 'sales', name: 'فروش', hint: '' };
  const edited = repairUnderstanding({ ...u, criteria: [{ id: 'a', title: 'یک', weight: 30, mustHave: false }, { id: 'b', title: 'دو', weight: 30, mustHave: false }] }, dept, 'x', { userEdited: true });
  assert(Boolean(edited), 'two edited criteria are accepted');
  assert(edited!.criteria.reduce((s, c) => s + c.weight, 0) === 100, 'weights are rescaled to 100');
  assert(edited!.criteria.some((c) => c.mustHave), 'at least one criterion becomes must-have');
  assert(repairUnderstanding({ ...u, criteria: [] }, dept, 'x', { userEdited: true }) === null, 'an empty criteria list is rejected');
}

// ---- templates map custom departments to the closest template ----
{
  const t = buildTemplateUnderstanding({ id: 'online-sales', name: 'فروش اینترنتی', hint: '' }, 'کارشناس فروش آنلاین');
  assert(t.criteria.some((c) => c.title.includes('فروش')), 'a custom «فروش …» department gets the sales template');
  assert(t.departmentId === 'online-sales' && t.department === 'فروش اینترنتی', 'template keeps the custom department identity');
  const generic = buildTemplateUnderstanding({ id: 'legal', name: 'حقوقی', hint: '' }, 'کارشناس حقوقی');
  assert(generic.plainExplanation.includes('حقوقی'), 'unknown departments get the generic template with their own name');
}

// ---- Persian-aware search (bug #5) ----
{
  assert(normalizeForSearch('علي كريمي') === normalizeForSearch('علی کریمی'), 'Arabic ي/ك equal Persian ی/ک');
  assert(matchesSearch(['کارشناس جذب‌و‌استخدام'], 'جذب و استخدام'), 'ZWNJ and spaces are interchangeable');
  assert(matchesSearch(['۰۹۱۲۱۲۳۴۵۶۷'], '0912'), 'Persian and ASCII digits match');
  assert(matchesSearch(['آموزش و توسعه'], 'اموزش'), 'آ matches ا');
  assert(matchesSearch(['مدیر برنامۀ توسعه'], 'برنامه'), 'ۀ matches ه');
  assert(matchesSearch(['مدیر برنامهٔ توسعه'], 'برنامه'), 'هٔ matches ه');
  assert(!matchesSearch(['حسابداری'], 'فروش'), 'unrelated words do not match');
}

{
  // «دیروز» means the previous calendar day in Tehran, not «24–48 hours ago».
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-16T03:30:00Z'); // 07:00 Tehran
    assert(faRelative('2026-10-15T04:30:00Z') === '۲۳ ساعت پیش', 'under a day: hours', faRelative('2026-10-15T04:30:00Z'));
    assert(faRelative('2026-10-15T02:30:00Z') === 'دیروز', '25 hours ago, yesterday morning → «دیروز»', faRelative('2026-10-15T02:30:00Z'));
    assert(faRelative('2026-10-14T19:30:00Z') === '۲ روز پیش', '32 hours ago, 23:00 two calendar days back → «۲ روز پیش»', faRelative('2026-10-14T19:30:00Z'));
    assert(faRelative('2026-10-08T03:30:00Z') === '۱ هفته پیش', 'eight days → one week', faRelative('2026-10-08T03:30:00Z'));
  } finally {
    Date.now = realNow;
  }
}

// ---- ورود دومرحله‌ای: TOTP matches the RFC and the apps in people's pockets ----
{
  // RFC 6238, appendix B: the ASCII secret "12345678901234567890" at T=59 is 94287082.
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert(hotp(rfcSecret, Math.floor(59 / 30), 8) === '94287082', 'TOTP follows the RFC 6238 vector (T=59)', hotp(rfcSecret, 1, 8));
  assert(hotp(rfcSecret, Math.floor(1111111109 / 30), 8) === '07081804', 'TOTP follows the RFC 6238 vector (T=1111111109)');
  // Base32 is what the app reads off the screen: it must survive the round trip.
  const raw = Buffer.from([0, 1, 2, 250, 251, 252, 253]);
  assert(base32Decode(base32Encode(raw)).equals(raw), 'base32 round-trips arbitrary bytes');
  assert(!/[^A-Z2-7]/.test(generateSecret()), 'a generated secret is clean base32');
  assert(base32Decode(generateSecret()).length === 20, 'a secret carries 160 bits');

  // One step of drift is tolerated, two are not: a phone a minute behind works.
  const secret = generateSecret();
  const now = 1_700_000_000_000;
  const step = stepAt(now);
  const at = (s: number) => hotp(secret, s);
  assert(verifyTotp(secret, at(step), { at: now }) === step, 'the current code is accepted');
  assert(verifyTotp(secret, at(step - 1), { at: now }) === step - 1, 'one step in the past is accepted');
  assert(verifyTotp(secret, at(step + 2), { at: now }) === null, 'two steps ahead is refused');
  assert(verifyTotp(secret, '12345', { at: now }) === null, 'five digits is not a code');
  assert(verifyTotp(secret, 'abcdef', { at: now }) === null, 'letters are not a code');
  assert(verifyTotp(secret, ` ${at(step).slice(0, 3)} ${at(step).slice(3)} `, { at: now }) === step, 'a spaced code still works');

  const url = new URL(otpauthUrl({ secret, account: 'hr@company.ir', issuer: 'شرکت نمونه' }));
  assert(url.protocol === 'otpauth:' && url.host === 'totp', 'the setup link is an otpauth://totp address');
  assert(url.searchParams.get('secret') === secret && url.searchParams.get('digits') === '6' && url.searchParams.get('period') === '30', 'it names the secret, six digits and thirty seconds');

  // Recovery codes: unambiguous alphabet, single-use hashes, no clear text.
  const codes = generateRecoveryCodes();
  assert(codes.length === 8 && new Set(codes).size === 8, 'eight distinct recovery codes');
  assert(codes.every((c) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(c)), 'no I, O, 0 or 1 to misread on paper', codes[0]);
  assert(hashRecoveryCode(codes[0]) === hashRecoveryCode(codes[0].toLowerCase().replace('-', '')), 'a typed code normalizes before hashing');
  assert(hashRecoveryCode(codes[0]) !== hashRecoveryCode(codes[1]), 'different codes hash differently');
  assert(secondsLeft(now) > 0 && secondsLeft(now) <= 30, 'the window countdown is within one step');
}

// ---- غربالگری بی‌طرف: masking never leaves the identity behind ----
{
  const names = ['مینا رضایی', 'Mina Rezaei'];
  const masked = maskText('مینا رضایی — mina.rezaei@gmail.com — https://linkedin.com/in/mina — ۰۹۱۲۱۲۳۴۵۶۷ — ۰۲۱۸۸۷۷۶۶۵۵', names);
  assert(!masked.includes('مینا') && !masked.includes('رضایی'), 'a Persian full name is masked, token by token');
  assert(!masked.includes('mina.rezaei@') && masked.includes('«ایمیل»'), 'an e-mail becomes a placeholder');
  assert(!/linkedin\.com/i.test(masked) && masked.includes('«پیوند»'), 'a profile link becomes a placeholder');
  assert(!masked.includes('۰۹۱۲۱۲۳۴۵۶۷') && masked.includes('«تلفن»'), 'a mobile number in Persian digits is masked');
  assert(!maskText('تماس: 0912 123 4567', names).includes('4567'), 'and so is one in Latin digits');
  assert(masked.includes('«نام»'), 'the placeholder is the Persian word for the name');

  // The mask must not eat ordinary words that merely share letters.
  const kept = maskText('کارشناس شبکه با ۵ سال سابقه در مسیریابی', names);
  assert(kept === 'کارشناس شبکه با ۵ سال سابقه در مسیریابی', 'unrelated text is untouched');

  // A stuttered pair of placeholders reads as one.
  const tidy = maskText('پروفایل «مینا رضایی» را دید', names);
  assert(!/«نام»\s+«نام»/.test(tidy), 'the placeholders do not repeat', tidy);

  // Labels are stable, distinct and carry nothing of the person.
  const a = blindLabel('res_abc123');
  assert(a === blindLabel('res_abc123'), 'the blind label is stable for one candidate');
  assert(a !== blindLabel('res_xyz789'), 'and different for another');
  assert(/^کارجوی [۰-۹]{4}$/.test(a), 'it looks like «کارجوی ۲۴۸۱»', a);

  // The redacted copy keeps the decision material and drops the identity.
  const rec = {
    id: 'res_1',
    fileName: 'Mina-Rezaei-CV.pdf',
    filePath: 'resumes/res_1.pdf',
    fileHash: 'abc',
    candidateName: 'مینا رضایی',
    contact: { phone: '09121234567', email: 'mina@example.ir', city: 'تهران' },
    extractedText: 'مینا رضایی\nmina@example.ir',
    summary: 'مینا رضایی سابقهٔ شبکه دارد',
    whyCategory: 'امتیاز بالا',
    strengths: [{ point: 'مسیریابی', evidence: 'مینا رضایی: OSPF در آلفا' }],
    weaknesses: [],
    criterionScores: [{ criterionId: 'c1', score: 80, rationale: 'شاهد دارد', evidence: 'مینا رضایی — OSPF' }],
    knockoutMisses: [],
    deepFindings: null,
    bankNote: null,
    decisionNote: null,
    unjudgeableReason: null,
    errorMessage: null,
    source: null,
  } as any;
  const red = redactRecord(rec);
  assert(red.fileName.endsWith('.pdf') && !red.fileName.includes('Mina'), 'the file name keeps its extension but loses the name');
  assert(red.contact.email === null && red.contact.phone === null && red.contact.city === 'تهران', 'contact is null; the city (not identifying) stays');
  const json = JSON.stringify(red);
  assert(!json.includes('مینا') && !json.includes('mina@example.ir'), 'nothing identifying survives the redaction');
  assert(red.strengths[0].point === 'مسیریابی' && red.criterionScores[0].score === 80, 'the evidence and the scores stay');
}

// ---- کیت مصاحبه: the bank matches work, not words ----
{
  const bank = bankSummary();
  assert(bank.packCount === 30 && bank.roleCount === 30, 'thirty packs and thirty roles', `${bank.packCount}/${bank.roleCount}`);
  assert(bank.questionCount >= 70, 'the bank holds at least seventy questions', String(bank.questionCount));
  assert(bank.packs.every((p) => p.questions >= 2), 'no pack is a single question');

  // Role matching prefers the longest alias, so «فرانت‌اند» does not become «بک‌اند».
  assert(matchRole('کارشناس ارشد شبکه و زیرساخت')?.title === 'کارشناس شبکه', 'a senior network title maps to the network role');
  assert(matchRole('برنامه‌نویس فرانت‌اند')?.title === 'برنامه‌نویس فرانت‌اند', 'frontend stays frontend');
  assert(matchRole('برنامه‌نویس بک‌اند')?.title === 'برنامه‌نویس بک‌اند', 'backend stays backend');
  assert(matchRole('کارشناس فروش تلفنی')?.title === 'کارشناس فروش تلفنی', 'phone sales is its own role, not generic sales');
  assert(matchRole('هماهنگ‌کنندهٔ رویداد') === null, 'an unknown role is honestly unmatched');

  // Criteria pull packs by the job's own words, and only on word boundaries.
  const ids = (criteria: Array<{ id: string; title: string; weight: number }>) => matchPacksByCriteria(criteria).map((m) => m.pack.id);
  assert(ids([{ id: 'c1', title: 'تولید محتوا برای شبکه‌های اجتماعی', weight: 50 }]).includes('content'), '«تولید محتوا» pulls the content pack');
  assert(!ids([{ id: 'c1', title: 'تولید محتوا برای شبکه‌های اجتماعی', weight: 50 }]).includes('production'), 'and not the factory pack');
  assert(!ids([{ id: 'c1', title: 'نگهداری مشتریان کلیدی', weight: 50 }]).includes('maintenance'), '«نگهداری مشتری» is not machine maintenance');
  assert(ids([{ id: 'c1', title: 'مذاکره و بستن قرارداد فروش', weight: 50 }]).includes('negotiation'), 'negotiation is recognised');
  assert(ids([{ id: 'c1', title: 'برقراری ارتباط مؤثر با همکاران', weight: 50 }]).length === 0, '«برقراری» does not match «برق»');
  const many = matchPacksByCriteria([
    { id: 'a', title: 'فروش و مذاکره', weight: 30 },
    { id: 'b', title: 'تارگت و پورسانت', weight: 80 },
    { id: 'c', title: 'مدیریت مشتری در CRM', weight: 50 },
    { id: 'd', title: 'کشف نیاز مشتری', weight: 60 },
    { id: 'e', title: 'گزارش فروش', weight: 10 },
  ]);
  assert(many.length <= 4, 'criteria never pull more than four packs', String(many.length));
  const top = many.slice(0, 2).map((m) => m.pack.id).sort();
  assert(top.join(',') === 'negotiation,targets', 'the packs pulled by the heaviest criterion come first', top.join(','));
  assert(many.every((m) => Boolean(m.criterionId)), 'each matched pack records which criterion pulled it');
}

// ---- «عملکرد تیم»: counts real work, never ranks people ----
{
  const now = new Date().toISOString();
  const report = buildTeamReport({
    range: '90',
    nowISO: now,
    members: [
      { id: 'u1', name: 'مریم', role: 'admin', title: 'مدیر منابع انسانی' },
      { id: 'u2', name: 'حسین', role: 'member', title: 'کارشناس جذب' },
      { id: 'u3', name: 'رضا', role: 'member', title: 'مدیر فنی' },
    ],
    decisions: [
      { resumeId: 'r1', decidedBy: 'u1', decidedAtISO: now, arrivedAtISO: now, approved: true },
      { resumeId: 'r2', decidedBy: 'u1', decidedAtISO: now, arrivedAtISO: new Date(Date.now() - 10 * 86400_000).toISOString(), approved: false },
      { resumeId: 'r3', decidedBy: 'u2', decidedAtISO: now, arrivedAtISO: now, approved: true },
    ],
    scorecards: [{ reviewerId: 'u2', atISO: now }],
    comments: [{ authorId: 'u1', atISO: now }],
    interviews: [{ interviewerIds: ['u3'], startsAtISO: now, status: 'scheduled' }],
    offersSent: [{ userId: 'u2', atISO: now }],
    activity: [{ userId: 'u3', atISO: now }],
  });
  const by = (id: string) => report.members.find((m) => m.userId === id)!;
  assert(report.totals.decisions === 3 && report.totals.approved === 2 && report.totals.rejected === 1, 'decisions are split by outcome');
  assert(by('u1').decisions === 2 && by('u1').comments === 1, 'each member carries only their own work');
  assert(by('u2').scorecards === 1 && by('u2').offersSent === 1, 'scorecards and offers land on their author');
  assert(by('u3').interviews === 1 && by('u3').decisions === 0, 'an interviewer with no decisions still appears');
  assert(report.members[report.members.length - 1].userId === 'u3', 'the lightest workload sorts last');
  assert(report.totals.activeMembers === 3 && report.totals.members === 3, 'every member is counted');
  assert(report.concentration === 67, 'the busiest member holds two of three decisions', String(report.concentration));
  assert(report.fastShare === 67, 'two of three decisions came within 72 hours', String(report.fastShare));
  assert(by('u1').medianDecideHours === 120, 'the median sits between immediate and ten days', String(by('u1').medianDecideHours));

  const empty = buildTeamReport({
    range: '30',
    nowISO: now,
    members: [{ id: 'u1', name: 'مریم', role: 'owner', title: '' }],
    decisions: [],
    scorecards: [],
    comments: [],
    interviews: [],
    offersSent: [],
    activity: [],
  });
  assert(empty.concentration === null && empty.fastShare === null, 'no decisions ⇒ no percentages, not zero');
  assert(empty.members[0].totalActions === 0 && empty.members[0].lastActiveISO === null, 'an idle member is shown honestly');
}

// ---- «هزینهٔ هر استخدام»: money only when a human typed it ----
{
  assert(COST_KINDS.length === 7 && new Set(COST_KINDS.map((k) => k.id)).size === 7, 'seven distinct cost kinds');
  const clamp = normalizeAssumption({ hourlyRate: -5, minutesPerScorecard: 9999, minutesPerComment: 'x', minutesPerDecision: 12 });
  assert(clamp.hourlyRate === 0, 'a negative rate becomes zero');
  assert(clamp.minutesPerScorecard === 600, 'absurd minutes are capped');
  assert(clamp.minutesPerComment === 5 && clamp.minutesPerDecision === 12, 'missing fields fall back, typed ones are kept');

  const ok = readCostInput({ kind: 'advertising', amount: '۲٬۵۰۰٬۰۰۰', note: '  آگهی  ' });
  assert(!('error' in ok) && ok.amount === 2500000 && ok.note === 'آگهی', 'a Persian-digit amount with separators is accepted, and the note is trimmed');
  assert(!('error' in ok) && ok.jobId === null && ok.atISO === null, 'empty date and opening stay null');

  const bad = (body: unknown) => 'error' in readCostInput(body);
  assert(bad({ kind: 'nope', amount: 10 }), 'an unknown kind is refused');
  assert(bad({ kind: 'tools', amount: -1 }), 'a negative amount is refused');
  assert(bad({ kind: 'tools', amount: 0 }), 'zero is refused');
  assert(bad({ kind: 'tools', amount: 1_000_000_000_001 }), 'an absurd amount is refused');
  assert(bad({ kind: 'tools', amount: 10, atISO: 'not-a-date' }), 'an unreadable date is refused');
  assert(bad({ kind: 'tools', amount: 10, atISO: new Date(Date.now() + 30 * 86400_000).toISOString() }), 'a future date is refused');

  assert('error' in readAssumptionInput({ hourlyRate: 999_999_999 }, normalizeAssumption({})), 'an absurd hourly rate is refused');
  const kept = readAssumptionInput({ hourlyRate: 250_000 }, normalizeAssumption({ minutesPerComment: 7 }));
  assert(!('error' in kept) && kept.value.hourlyRate === 250_000 && kept.value.minutesPerComment === 7, 'saving the rate keeps the minute settings');

  const entries = [
    { id: 'c1', kind: 'advertising', amount: 3_000_000 },
    { id: 'c2', kind: 'advertising', amount: 1_000_000 },
    { id: 'c3', kind: 'agency', amount: 5_000_000 },
  ] as any[];
  const kinds = byKind(entries);
  assert(kinds.length === 2 && kinds[0].kind === 'agency', 'empty kinds are hidden and the biggest comes first');
  assert(kinds.find((k) => k.kind === 'advertising')!.count === 2, 'kinds also count their rows');
}

// ---- «ورود سازمانی»: the token checks that keep a session trustworthy ----
{
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as any), kid: 'k1', alg: 'RS256', use: 'sig' };
  const issuer = 'https://idp.example.ir';
  const doc = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
  const realFetch = globalThis.fetch;
  // Only the key set is fetched during verification; everything else stays real.
  (globalThis as any).fetch = async (url: any, init?: any) => {
    if (String(url) === doc.jwks_uri) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return realFetch(url, init);
  };
  clearOidcCaches();

  const sign = (claims: Record<string, unknown>, signingKey = key.privateKey, alg = 'RS256') => {
    const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid: 'k1' })).toString('base64url');
    const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = crypto.sign('sha256', Buffer.from(`${h}.${p}`), signingKey).toString('base64url');
    return `${h}.${p}.${sig}`;
  };
  const base = {
    iss: issuer,
    aud: 'hovida',
    sub: 'sub-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
    nonce: 'n-1',
    email: 'sara@company.ir',
    email_verified: true,
    name: 'سارا محمدی',
  };

  const good = await verifyIdToken(sign(base), { doc, clientId: 'hovida', nonce: 'n-1' });
  assert(good.email === 'sara@company.ir', 'a correctly signed token is accepted');
  const identity = identityFromClaims(good);
  assert(identity.name === 'سارا محمدی' && identity.subject === 'sub-1', 'the identity keeps the provider name and subject');

  const rejects = async (label: string, token: string, nonce = 'n-1') => {
    let code = '';
    try {
      await verifyIdToken(token, { doc, clientId: 'hovida', nonce });
    } catch (e) {
      code = e instanceof OidcError ? e.code : 'OTHER';
    }
    assert(Boolean(code), label, code);
  };

  await rejects('a token signed with an unknown key is refused', sign(base, other.privateKey));
  await rejects('a token for another audience is refused', sign({ ...base, aud: 'someone-else' }));
  await rejects('an expired token is refused', sign({ ...base, exp: Math.floor(Date.now() / 1000) - 120 }));
  await rejects('a token from another issuer is refused', sign({ ...base, iss: 'https://evil.example' }));
  await rejects('a token issued for another login (nonce) is refused', sign({ ...base, nonce: 'n-2' }));
  await rejects('an unsigned (alg=none) token is refused', sign(base, undefined, 'none'));
  await rejects('a malformed token is refused', 'not-a-jwt');

  let emailCode = '';
  try {
    identityFromClaims({ ...base, email_verified: false } as any);
  } catch (e) {
    emailCode = e instanceof OidcError ? e.code : '';
  }
  assert(emailCode === 'EMAIL_UNVERIFIED', 'an unverified e-mail is not a verified identity', emailCode);
  let noEmail = '';
  try {
    identityFromClaims({ ...base, email: undefined, preferred_username: undefined } as any);
  } catch (e) {
    noEmail = e instanceof OidcError ? e.code : '';
  }
  assert(noEmail === 'NO_EMAIL', 'a token without an e-mail is refused', noEmail);

  (globalThis as any).fetch = realFetch;
  clearOidcCaches();

  // URLs: https everywhere, except a provider on loopback.
  assert(safeEndpoint('https://accounts.google.com').host === 'accounts.google.com', 'an https issuer is accepted');
  assert(safeEndpoint('http://127.0.0.1:8080/realms/x').port === '8080', 'a loopback provider may use http (self-hosted Keycloak)');
  let insecure = '';
  try {
    safeEndpoint('http://idp.example.ir');
  } catch (e) {
    insecure = e instanceof OidcError ? e.code : '';
  }
  assert(insecure === 'INSECURE_URL', 'a public http issuer is refused', insecure);
  let badUrl = '';
  try {
    safeEndpoint('not a url');
  } catch (e) {
    badUrl = e instanceof OidcError ? e.code : '';
  }
  assert(badUrl === 'BAD_URL', 'a non-URL is refused', badUrl);

  const parts = decodeJwt(sign(base));
  assert(parts.header.alg === 'RS256' && parts.payload.aud === 'hovida', 'a JWT can be inspected without trusting it');

  // Domains: what the workspace may claim.
  assert(JSON.stringify(normalizeDomains(['@Company.IR', 'company.ir', ' x ', 'bad domain', 'sub.company.ir'])) === JSON.stringify(['company.ir', 'sub.company.ir']), 'domains are cleaned, lowercased and de-duplicated');
  assert(normalizeDomains('a.ir, b.com').length === 2, 'a comma-separated string works too');
  assert(normalizeDomains([]).length === 0 && normalizeDomains('localhost').length === 0, 'an empty or single-label domain is not accepted');
  assert(emailDomain('Sara@Company.IR') === 'company.ir' && emailDomain('nope') === null, 'the domain is read from the address, honestly');
}

// ---- file extensions are preserved (bug #4) ----
{
  assert(safeExt('scan.PNG') === 'png' && safeExt('a.heic') === 'heic' && safeExt('cv.pdf') === 'pdf', 'image and document extensions are kept');
  assert(safeExt('evil.exe') === 'bin' && safeExt('noext') === 'bin', 'unknown extensions become .bin');
}

// ---- PDF text layout: Persian glyph order, spaces, columns (extraction bug) ----
{
  const fixture = (name: string) => {
    const fx = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'pdf', `${name}.json`), 'utf8'));
    return (fx.pages as Array<{ width: number; items: Array<[string, number, number, number, number]> }>).map((p) =>
      normalizePersianText(assemblePageText(p.items.map(([str, x, y, w, h]): PdfTextItem => ({ str, x, y, w, h })), p.width))
    );
  };
  const [ali] = fixture('fa-ali-rezaei');
  const aliLines = ali.split('\n');
  assert(aliLines[0] === 'علی رضایی', 'per-glyph Persian PDF: the name is rebuilt in order', aliLines[0]);
  assert(aliLines[1] === 'کارشناس ارشد جذب و استخدام — تهران', 'spaces come from real gaps, not item boundaries', aliLines[1]);
  assert(ali.includes('ایمیل: ali.rezaei@example.com — تلفن: ۰۹۱۲۳۴۵۶۷۸۹'), 'emails and phone numbers stay intact inside RTL lines');
  assert(ali.includes('(۱۳۹۷ تا اکنون)'), 'mirrored brackets are restored');
  assert(ali.includes('طراحی مصاحبه‌های ساختاریافته'), 'a single-column page is not cut in half; ZWNJ restored', ali.slice(0, 0));
  assert(ali.includes('مهارت‌ها') && ali.includes('برنامه‌ریزی'), 'half-spaces are restored from glyph forms');

  const [mahsa] = fixture('fa-mahsa-two-column');
  const sideEnd = mahsa.indexOf('انگلیسی (IELTS 7)');
  assert(mahsa.indexOf('اطلاعات تماس') < sideEnd && sideEnd < mahsa.indexOf('سوابق کاری'), 'two-column RTL page: sidebar read as a block, then the main column');
  assert(mahsa.includes('Excel و Power BI'), 'Latin runs keep their order inside Persian lines');
  assert(mahsa.includes('مدیر جذب و استخدام — هلدینگ صنایع غذایی آریا (۱۳۹۸ تا اکنون)'), 'main-column lines are not interleaved with the sidebar');

  const sara = fixture('fa-sara-mohammadi-long');
  assert(sara.length === 2 && sara[0].includes('حسابدار — شرکت شماره 1 (1390 تا 1392)'), 'numbers and brackets in RTL lines follow the bidi rules', sara[0].split('\n')[3]);
  assert(sara[1].startsWith('دوره‌ها'), 'every page is assembled');

  const [john] = fixture('en-two-column');
  assert(john.includes('Phone: +98 912 000 1111') && john.includes('ATS (Greenhouse)'), 'English pages are untouched by the RTL logic');
  assert(john.indexOf('Employer branding') < john.indexOf('Experience'), 'two-column LTR page: left column first');

  const [seed] = fixture('en-seed-simple');
  assert(seed.split('\n')[1] === 'Tehran, Iran | 09121234567 | sara.mohammadi@example.com', 'line-level English PDFs are unchanged');

  assert(restoreZwnj('\uFEEA\uFEEB') === '\uFEEA\u200C\uFEEB' && restoreZwnj('\uFEEC\uFEEB') === '\uFEEC\uFEEB', 'ZWNJ only where the glyph forms prove a broken join');
}

// ---- RTF / local engine text quality ----
{
  const rtf = String.raw`{\rtf1\ansi\ansicpg1256{\fonttbl{\f0 B Nazanin;}}{\*\generator Riched20}\uc1\pard\rtlpar \'da\'e1\'ed \u1585?\u1590?\u1575?\u1740?\u1740?\par Excel \{ok\}\tab done\par}`;
  assert(normalizePersianText(rtfToText(rtf)) === 'علی رضایی\nExcel {ok} done', 'RTF: cp1256 bytes, \\u escapes, groups and tables', JSON.stringify(rtfToText(rtf)));

  const hr = buildTemplateUnderstanding({ id: 'sales', name: 'فروش', hint: '' }, 'کارشناس جذب و استخدام');
  assert(hr.criteria.some((c) => c.title.includes('جذب')), 'the role title picks the template even under another department');
  const cv = [
    'ندا احمدی',
    'کارشناس منابع انسانی — شیراز — neda.ahmadi@example.com — ۰۹۱۷۱۲۳۴۵۶۷',
    'کارشناس جذب و استخدام — شرکت مهرگان: غربالگری رزومه، هماهنگی مصاحبه‌ها و تهیه گزارش‌های ماهانه جذب.',
    'تحصیلات: کارشناسی مدیریت دولتی',
    'تلفن همراه در بالا آمده است',
  ].join('\n');
  const ev = evaluateResumeLocal(cv, hr, {}, 'neda.docx');
  assert(ev.facts.lastRole === 'کارشناس منابع انسانی', 'local engine: role is the title segment, not the whole contact line', String(ev.facts.lastRole));
  assert(ev.facts.education === 'کارشناسی مدیریت دولتی', 'local engine: education stops at the line end', String(ev.facts.education));
  assert(!/\d/.test(ev.summary), 'local engine: summary uses Persian digits');
  const interview = ev.criterionScores.find((c) => c.title?.includes('مصاحبه'));
  assert(Boolean(interview?.evidence.includes('هماهنگی مصاحبه‌ها')), 'local engine: evidence is the line with the keyword', interview?.evidence);
}

// ---- Comparison tray: one tray per workspace, never shown in another ----
{
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };
  store.set('hovida.compare.v1', JSON.stringify({ jobId: 'j0', jobTitle: 'old', items: [{ id: 'r0', name: 'legacy', score: 1, category: 'REVIEW' }] }));
  const c = await import('../src/lib/compare');
  const item = (id: string) => ({ id, name: id, score: 50, category: 'REVIEW' });
  const trayKeys = () => Array.from(store.keys()).filter((k) => k.startsWith('hovida.compare'));
  assert(!store.has('hovida.compare.v1'), 'compare: the old browser-wide tray is dropped');
  assert(c.toggleCompare('j1', 'job', item('a')) === 'added' && trayKeys().length === 0, 'compare: nothing is persisted while signed out');
  c.clearCompare();
  c.setCompareScope('orgA');
  c.toggleCompare('j1', 'job', item('a'));
  c.toggleCompare('j1', 'job', item('b'));
  assert(JSON.parse(store.get('hovida.compare.v2:orgA') || '{}').items?.length === 2, 'compare: the tray is stored under its own workspace');
  c.setCompareScope('orgB');
  assert(!c.isInCompare('a') && !c.isInCompare('b'), 'compare: another workspace starts with its own empty tray');
  c.toggleCompare('j9', 'other', item('z'));
  c.setCompareScope('orgA');
  assert(c.isInCompare('a') && c.isInCompare('b') && !c.isInCompare('z'), 'compare: switching back shows the first tray untouched');
  c.clearCompare();
  c.setCompareScope(null);
  assert(
    JSON.parse(store.get('hovida.compare.v2:orgA') || '{}').items?.length === 0 && JSON.parse(store.get('hovida.compare.v2:orgB') || '{}').items?.length === 1,
    'compare: signing out clears only the current workspace tray'
  );
  assert(!c.isInCompare('a') && !c.isInCompare('z'), 'compare: signed out, the tray is empty');
  delete (globalThis as any).localStorage;
}

// ---- «·» never touches a number on screen ----
// In Vazirmatn the Persian zero «۰» is a dot: in RTL «… · ۱ کاربر» reads «۱۰ کاربر»
// and «۱۴۰۵ · …» reads «۰۱۴۰۵». Lists with numbers use the Persian comma «،».
{
  const NUM = String.raw`(?:faNumber|toPersianDigits|faPercent|faRelative|faDate|faDateTime|faDuration|faBytes)\(|[A-Za-z_$][\w$.]*\.toLocaleString\(`;
  const dotThenNumber = new RegExp(String.raw`·\s*(?:\{|\$\{)[^{}\n]*?(?:${NUM})|·\s*[۰-۹]`);
  const numberThenDot = new RegExp(String.raw`(?:${NUM})[^{}\n]*\}\s*·|[۰-۹]\s*·`);
  const flags = (line: string) => dotThenNumber.test(line) || numberThenDot.test(line);
  // The detector itself: known-bad lines are caught, word separators are not.
  assert(
    flags('{faNumber(a)} فضای کاری · {faNumber(b)} کاربر') &&
      flags('` · ${toPersianDigits(y)} سال`') &&
      flags('{h.atISO ? faDate(h.atISO) : h.atJalali} · {engine}') &&
      flags('حسابدار ارشد · ۹ سال سابقه') &&
      flags('`${m} · ${n.toLocaleString("fa-IR")} از`') &&
      !flags('{user.title} · {org.name}') &&
      !flags('`${faNumber(kb)} کیلوبایت · `') &&
      !flags('وزن {toPersianDigits(w)}٪ · الزامی'),
    'number-dot guard: detects «·» next to a number, ignores word separators'
  );
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) files.push(p);
    }
  };
  ['src', 'server'].forEach((d) => walk(path.join(process.cwd(), d)));
  const offenders: string[] = [];
  for (const f of files) {
    fs.readFileSync(f, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) return;
        // A lone «·» text node between two elements: its neighbours (numbers?) are unknown here.
        if (flags(line) || t === '·') offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
  }
  assert(files.length > 50 && offenders.length === 0, 'no «·» next to a number in src/ or server/ (use «،»)', offenders.join(', ') || `${files.length} files`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

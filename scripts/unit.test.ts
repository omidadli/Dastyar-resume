/**
 * Unit tests for HOVIDA's pure logic and for the bugs fixed in the rebuild.
 * Run with: npx tsx scripts/unit.test.ts
 */
import { buildAnswersBrief, buildTemplateUnderstanding, finalizeEvaluation, repairUnderstanding } from '../server/ai/screening';
import { safeExt } from '../server/db';
import { matchesSearch, normalizeForSearch } from '../src/lib/normalizeFa';
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
  assert(!matchesSearch(['حسابداری'], 'فروش'), 'unrelated words do not match');
}

// ---- file extensions are preserved (bug #4) ----
{
  assert(safeExt('scan.PNG') === 'png' && safeExt('a.heic') === 'heic' && safeExt('cv.pdf') === 'pdf', 'image and document extensions are kept');
  assert(safeExt('evil.exe') === 'bin' && safeExt('noext') === 'bin', 'unknown extensions become .bin');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

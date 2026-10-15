/**
 * Unit tests for HOVIDA's pure logic and for the bugs fixed in the rebuild.
 * Run with: npx tsx scripts/unit.test.ts
 */
import { buildAnswersBrief, buildTemplateUnderstanding, evaluateResumeLocal, finalizeEvaluation, repairUnderstanding } from '../server/ai/screening';
import { rtfToText } from '../src/lib/rtf';
import { safeExt } from '../server/db';
import { matchesSearch, normalizeForSearch, normalizePersianText } from '../src/lib/normalizeFa';
import { assemblePageText, restoreZwnj, type PdfTextItem } from '../src/lib/pdfLayout';
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
  assert(!matchesSearch(['حسابداری'], 'فروش'), 'unrelated words do not match');
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

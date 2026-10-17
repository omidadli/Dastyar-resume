/**
 * AI behaviour management tests: industry detection, system prompt assembly,
 * versioned saving / restore / reset, and the evaluation path with a draft
 * behaviour (admin test lab) when no AI key is configured.
 * Run with: npx tsx scripts/behavior.test.ts
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-behavior-'));
process.env.DATA_DIR = DATA;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function main() {
  const db = await import('../server/db');
  await db.initStore();
  const b = await import('../server/ai/behavior');
  const { evaluateResume, buildTemplateUnderstanding } = await import('../server/ai/screening');

  // ---------------- industry detection ----------------
  const cases: Array<[string, string, string | null]> = [
    ['کارشناس فروش', 'فروش و بازاریابی', 'sales-marketing'],
    ['برنامه‌نویس React', 'فناوری اطلاعات', 'it-software'],
    ['Senior Backend Developer', 'IT', 'it-software'],
    ['حسابدار ارشد', 'مالی', 'finance-accounting'],
    ['سرپرست کنترل کیفیت', 'تولید', 'quality'],
    ['راننده پایه یک', 'پشتیبانی', 'transport-driving'],
    ['پرستار بخش ICU', 'درمان', 'healthcare'],
    ['کارشناس HSE', 'ایمنی', 'hse'],
    ['مدیرعامل', 'مدیریت', 'management'],
    ['نگهبان شیفت شب', 'خدمات', 'facility-services'],
    ['تحلیلگر داده', 'هوش تجاری', 'data-ai'],
    ['مسئول فنی کارخانه لبنیات', 'تولید', 'food-agri'],
    ['کارشناس جذب و استخدام', 'منابع انسانی', 'hr-admin'],
    ['مهندس عمران — دفتر فنی', 'پروژه‌ها', 'civil-construction'],
    ['تکنسین PLC', 'برق و اتوماسیون', 'electrical'],
    ['xyz', 'abc', null],
  ];
  for (const [role, dept, expected] of cases) {
    const got = b.detectIndustry({ roleTitle: role, departmentName: dept })?.profile.id ?? null;
    assert(got === expected, `industry: «${role}» / «${dept}»`, `${got}`);
  }
  assert(b.DEFAULT_INDUSTRIES.length >= 25, 'at least 25 built-in industry profiles', String(b.DEFAULT_INDUSTRIES.length));
  assert(b.DEFAULT_INDUSTRIES.every((i) => i.competencies.length >= 3 && i.evidence.length >= 2 && i.keywords.length >= 5), 'every profile has competencies, evidence and keywords');

  // ---------------- prompt assembly ----------------
  const cfg = b.defaultBehavior();
  const sales = b.detectIndustry({ roleTitle: 'کارشناس فروش', departmentName: 'فروش' }, cfg)!.profile;
  const p1 = b.buildSystemPrompt(cfg, { industry: sales, deep: false });
  assert(p1.includes('## اصول بنیادین') && p1.includes('## انصاف و منع تبعیض') && p1.includes('## خواندن انواع سند'), 'system prompt: principles, fairness, document rules');
  assert(p1.includes('راهنمای تخصصی حوزه «فروش، بازاریابی و توسعه بازار»'), 'system prompt: detected industry guide');
  assert(p1.includes('«متعادل»') && !p1.includes('## بازبینی دقیق') && !p1.includes('دستورالعمل‌های اختصاصی'), 'fast pass: no deep section, no empty custom section');
  assert(/تاریخ امروز: .+ \(\d{4}-\d{2}-\d{2}\)/.test(p1), 'system prompt carries today (Jalali + Gregorian) for «تاکنون»');
  const strict = { ...cfg, strictness: 'strict' as const, sections: { ...cfg.sections, custom: 'سابقه صنایع غذایی مزیت مهم است.' } };
  const p2 = b.buildSystemPrompt(strict, { industry: null, deep: true });
  assert(p2.includes('«سخت‌گیرانه»') && p2.includes('## بازبینی دقیق') && p2.includes('سابقه صنایع غذایی مزیت مهم است.'), 'strict + deep + custom instructions');
  assert(!p2.includes('راهنمای تخصصی حوزه'), 'no industry → no guide');
  const u = b.buildUnderstandSystemPrompt(cfg, sales);
  assert(u.includes('هرگز شاخص یا پرسشی بر اساس جنسیت') && u.includes('فروش'), 'questionnaire prompt carries fairness + industry');

  // ---------------- versioning ----------------
  const v1 = b.currentBehavior();
  assert(v1.version === 1 && v1.industries.length === b.DEFAULT_INDUSTRIES.length, 'defaults until the admin saves');
  const edited = b.saveBehavior(
    {
      ...v1,
      strictness: 'lenient',
      sections: { ...v1.sections, custom: 'آزمایش' },
      industries: [...v1.industries.filter((i) => i.id !== 'retail'), { id: 'aviation', name: 'هوانوردی', keywords: ['خلبان', 'هواپیما'], competencies: ['ایمنی پرواز'], evidence: [], credentials: [], redFlags: [], notes: '' }, { name: '' }],
    },
    'مدیر آزمایشی',
    'نسخه آزمایشی'
  );
  assert(edited.version === 2 && edited.strictness === 'lenient' && edited.sections.custom === 'آزمایش' && edited.updatedBy === 'مدیر آزمایشی', 'save → version 2 with the edits');
  assert(edited.industries.some((i) => i.id === 'aviation' && !i.builtin) && !edited.industries.some((i) => i.name === ''), 'custom industry added, empty ones dropped');
  assert(!b.currentBehavior().industries.some((i) => i.id === 'retail'), 'a removed built-in industry stays removed');
  assert(b.detectIndustry({ roleTitle: 'خلبان ارشد', departmentName: 'عملیات پرواز' })?.profile.id === 'aviation', 'custom industry is detected');
  const { behaviorHistory } = await import('../server/platform');
  assert(behaviorHistory().some((h) => h.version === 1 && h.note === 'تنظیمات پیش‌فرض هویدا'), 'first save also records the shipped defaults (v1) in history');
  const restored = b.restoreBehaviorVersion(2, 'مدیر');
  assert(restored?.version === 3 && restored.strictness === 'lenient', 'restore makes a new version with the old content');
  const reset = b.resetBehavior('مدیر');
  assert(reset.version === 4 && reset.strictness === 'balanced' && reset.industries.some((i) => i.id === 'retail'), 'reset brings back the defaults as a new version');
  const sanitized = b.sanitizeBehavior({ strictness: 'extreme', sections: { rubric: 42 }, autoIndustry: 'yes' });
  assert(sanitized.strictness === 'balanced' && sanitized.sections.rubric === b.DEFAULT_SECTIONS.rubric && sanitized.autoIndustry === true, 'invalid input falls back safely');

  // ---------------- test lab path (no AI key → local engine, prompts captured) ----------------
  const understanding = buildTemplateUnderstanding({ id: 'lab', name: 'فروش', hint: '' } as any, 'کارشناس فروش');
  let captured: { system: string; user: string } | null = null;
  const ev = await evaluateResume({
    orgName: 'آزمایشگاه',
    job: { departmentName: 'فروش', roleTitle: 'کارشناس فروش', extraNotes: '', understanding, answers: {} },
    resumeText: 'رضا احمدی — کارشناس فروش با ۵ سال سابقه فروش مویرگی و مدیریت مشتریان کلیدی در شرکت پخش البرز. تحقق ۱۲۰٪ سهمیه فروش در سال ۱۴۰۲.',
    fileName: 'reza.pdf',
    sourceLabel: 'PDF',
    intakeWarnings: ['آزمایش'],
    behavior: { ...b.defaultBehavior(), sections: { ...b.defaultBehavior().sections, custom: 'نشانگر-آزمایشگاه' } },
    onPrompt: (p) => {
      captured = p;
    },
  });
  assert(captured !== null && (captured as any).system.includes('نشانگر-آزمایشگاه'), 'draft behaviour is what the prompt uses');
  assert((captured as any)?.user.includes('"document"') && (captured as any)?.user.includes('notResume'), 'output schema asks for document type and the new flags');
  assert(ev.engine === 'local' && ev.meta?.format === 'PDF' && ev.meta?.industry === 'فروش، بازاریابی و توسعه بازار' && ev.meta?.warnings[0] === 'آزمایش', 'without AI: local engine, but meta (format/industry/notes) recorded', JSON.stringify(ev.meta));

  // garbled text must not be trusted as evidence
  let garbledPrompt = '';
  await evaluateResume({
    orgName: 'آزمایشگاه',
    job: { departmentName: 'فروش', roleTitle: 'کارشناس فروش', extraNotes: '', understanding, answers: {} },
    resumeText: 'Ø³Ù„Ø§Ù… Ù…Ù† Ø¹Ù„ÛŒ Ù‡Ø³ØªÙ… Ø¨Ø±Ù†Ø§Ù…Ù‡ Ù†ÙˆÛŒØ³ Ø¨Ø§ ØªØ¬Ø±Ø¨Ù‡ '.repeat(3),
    fileName: 'broken.pdf',
    attachments: [{ mimeType: 'application/pdf', base64: Buffer.from('%PDF-1.4').toString('base64'), fileName: 'broken.pdf' }],
    onPrompt: (p) => {
      garbledPrompt = p.user;
    },
  });
  assert(garbledPrompt.includes('درهم و ناخوانا') && !garbledPrompt.includes('Ø³Ù„Ø§Ù…'), 'mojibake text is dropped; the AI reads the original file instead');

  // a scan/photo with no AI available: honest «needs the AI», never judged from the file name
  const photo = await evaluateResume({
    orgName: 'آزمایشگاه',
    job: { departmentName: 'فروش', roleTitle: 'کارشناس فروش', extraNotes: '', understanding, answers: {} },
    resumeText: '',
    fileName: 'کارشناس فروش ۱۰ سال سابقه فروش مویرگی.jpg',
    attachments: [{ mimeType: 'image/jpeg', base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'), fileName: 'cv.jpg' }],
    sourceLabel: 'تصویر',
  });
  const photoReason = db.unjudgeableReasonOf(photo);
  assert(photo.flags.needsAi === true && photo.engine === 'local' && photo.score === 0, 'image + no AI → flagged «needs AI», not scored from the file name', `score=${photo.score} engine=${photo.engine}`);
  assert(Boolean(photoReason && /فقط با هوش مصنوعی/.test(photoReason) && /فعال نیست/.test(photoReason) && /تلاش دوباره/.test(photoReason)), 'reason says why and how to retry', photoReason || '');
  assert(photo.criterionScores.every((c) => !/سابقه فروش مویرگی/.test(c.evidence || '')), 'the file name is never quoted as evidence');

  // finalize: a non-resume document becomes «اطلاعات ناکافی», never a match
  const { finalizeEvaluation } = await import('../server/ai/screening');
  const nr = finalizeEvaluation(
    { document: { isResume: false, type: 'certificate', language: 'fa' }, score: 70, criterionScores: [], summary: 'گواهی‌نامه دوره' },
    understanding,
    {},
    'ai'
  );
  assert(nr.flags.notResume === true && nr.score === 0 && nr.recommendation === 'REJECT' && nr.meta?.documentType === 'certificate', 'certificate → notResume, score 0');
  const nr2 = finalizeEvaluation(
    { document: { isResume: false, type: 'certificate' }, candidateName: 'علی', facts: { yearsExperience: 6, lastRole: 'سرپرست فروش', skills: ['CRM'] }, contact: { email: 'a@b.c' }, tags: ['فروش'], criterionScores: [] },
    understanding,
    {},
    'ai'
  );
  assert(nr2.candidateName === null && nr2.facts.yearsExperience === null && nr2.facts.skills.length === 0 && nr2.contact.email === null && nr2.tags.length === 0, 'non-resume: guessed candidate facts are cleared');
  assert(db.unjudgeableReasonOf(nr)?.includes('گواهی‌نامه') === true, 'Persian reason names the document type', db.unjudgeableReasonOf(nr) || '');
  const pf = finalizeEvaluation({ document: { isResume: false, type: 'portfolio' }, score: 60, criterionScores: [] }, understanding, {}, 'ai');
  assert(!pf.flags.notResume, 'a portfolio is still judged');

  // ---------------- «today» in the prompt ----------------
  // 01:30 in Tehran is still the previous day in UTC: both calendars must name the Tehran day.
  const late = b.todayLine(new Date('2026-10-16T22:00:00Z'));
  assert(late.includes('(2026-10-17)') && late.includes('۲۵ مهر ۱۴۰۵'), 'prompt date: Gregorian and Jalali agree on the Tehran day after midnight', late);
  const noon = b.todayLine(new Date('2026-10-16T09:00:00Z'));
  assert(noon.includes('(2026-10-16)') && noon.includes('۲۴ مهر ۱۴۰۵'), 'prompt date at noon', noon);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

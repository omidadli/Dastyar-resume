/**
 * HOVIDA («هویدا») screening intelligence — provider-agnostic.
 *
 * Pass 0  — understandJob: department + role → weighted criteria, a simple
 *           checkbox questionnaire and dynamic thresholds.
 * Pass 1  — evaluateResume: evidence-based structured evaluation of a resume.
 * Pass 2  — calibrate: relative calibration of top & borderline candidates.
 * Extra   — draftMessage: personalised candidate message drafts.
 *
 * Hard rules enforced everywhere:
 *  - Every strength/weakness/criterion score must carry a real quote as evidence.
 *  - No fabricated names/numbers: the model may only state what the resume says.
 *  - The AI describes the match; the human decides. Output never says "hire".
 *  - When the AI is unavailable, questionnaires FAIL honestly (the user may then
 *    pick an explicitly-labelled department template), while evaluations fall
 *    back to a clearly-labelled LOCAL keyword engine.
 */
import { CIRCUIT_OPEN, friendlyAiError, generate, type AiFile } from './provider';
import type {
  AnalysisEngine,
  AnalysisMode,
  CandidateEvaluation,
  Criterion,
  CriterionScore,
  DeepFindings,
  DraftMessage,
  EmploymentType,
  EvidencePoint,
  Job,
  JobUnderstanding,
  MessageKind,
  Recommendation,
  ResumeRecord,
  ScreeningAnswers,
  ScreeningQuestion,
} from '../../src/types/screening';
import type { Department } from '../../src/types/app';
import { normalizePersianText, toEnglishDigits } from '../../src/lib/normalizeFa';

export { friendlyAiError };

/** Robust JSON extraction: strips markdown fences, finds outermost JSON, fixes trailing commas/control chars. */
export function cleanAndParseJson<T>(rawText: string, fallback: T): T {
  if (!rawText) return fallback;
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  let endIdx = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endIdx = cleaned.lastIndexOf('}');
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endIdx = cleaned.lastIndexOf(']');
  }
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    cleaned = cleaned.substring(startIdx, endIdx + 1);
  }
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    let sanitized = '';
    let inString = false;
    let isEscaped = false;
    for (let i = 0; i < cleaned.length; i++) {
      const ch = cleaned[i];
      const code = ch.charCodeAt(0);
      if (inString) {
        if (isEscaped) {
          sanitized += ch;
          isEscaped = false;
        } else if (ch === '\\') {
          sanitized += ch;
          isEscaped = true;
        } else if (ch === '"') {
          sanitized += ch;
          inString = false;
        } else if (ch === '\n') sanitized += '\\n';
        else if (ch === '\r') sanitized += '\\r';
        else if (ch === '\t') sanitized += '\\t';
        else if (code < 32) sanitized += '\\u' + code.toString(16).padStart(4, '0');
        else sanitized += ch;
      } else {
        if (ch === '"') inString = true;
        sanitized += ch;
      }
    }
    try {
      return JSON.parse(sanitized) as T;
    } catch (err) {
      console.error('Failed to parse JSON from AI:', err, 'Raw head:', rawText.slice(0, 300));
      return fallback;
    }
  }
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  tif: 'image/tiff',
  gif: 'image/gif',
};

/** Mime type of a resume the AI can read visually (extension first, magic bytes second). */
export function detectResumeMime(fileName: string, base64?: string | null): string | undefined {
  const ext = String(fileName).split('.').pop()?.toLowerCase() || '';
  if (MIME_BY_EXT[ext]) return MIME_BY_EXT[ext];
  if (!base64) return undefined;
  if (base64.startsWith('JVBERi0')) return 'application/pdf';
  if (base64.startsWith('/9j/')) return 'image/jpeg';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('UklGR')) return 'image/webp';
  if (base64.slice(0, 40).includes('ZnR5cGhlaWM')) return 'image/heic';
  return undefined;
}

export const EMPLOYMENT_LABELS: Record<EmploymentType, string> = {
  'full-time': 'تمام‌وقت',
  'part-time': 'پاره‌وقت',
  contract: 'قراردادی / پروژه‌ای',
  remote: 'دورکاری',
  hybrid: 'ترکیبی (حضوری و دورکاری)',
  internship: 'کارآموزی',
};

// ================================================================
// PASS 0 — Understand the job + generate the checkbox questionnaire
// ================================================================

const QUESTION_EXAMPLE_JSON = `{
  "department": "فروش و توسعه بازار",
  "roleTitle": "کارشناس فروش حضوری",
  "seniority": "کارشناسی",
  "plainExplanation": "این نقش یک فعالیت میدانی در حوزه فروش است؛ به همین دلیل سابقه فروش حضوری، مهارت مذاکره و آمادگی برای مأموریت را پررنگ‌تر در نظر گرفتیم. چون عملکرد این نقش با هدف فروش سنجیده می‌شود، تجربه کار با تارگت هم اهمیت دارد.",
  "thresholds": { "interview": 75, "review": 50 },
  "criteria": [
    { "id": "c1", "title": "سابقه و نتایج فروش میدانی", "weight": 35, "mustHave": true },
    { "id": "c2", "title": "فن بیان، مذاکره و روابط عمومی", "weight": 25, "mustHave": true },
    { "id": "c3", "title": "آشنایی با پخش و صنعت کالاهای تندمصرف", "weight": 15, "mustHave": false },
    { "id": "c4", "title": "آمادگی مأموریت و تردد میدانی", "weight": 15, "mustHave": true },
    { "id": "c5", "title": "پایداری و ثبات شغلی", "weight": 10, "mustHave": false }
  ],
  "questions": [
    { "id": "q1", "kind": "knockout", "type": "boolean", "label": "سابقه فروش حضوری یا میدانی داشته باشد", "weight": 30, "defaultChecked": true },
    { "id": "q2", "kind": "knockout", "type": "boolean", "label": "آماده مأموریت‌های درون‌شهری و برون‌شهری باشد", "weight": 20, "defaultChecked": true },
    { "id": "q3", "kind": "bonus", "type": "boolean", "label": "با نرم‌افزار CRM کار کرده باشد", "weight": 10, "defaultChecked": false },
    { "id": "q4", "kind": "bonus", "type": "boolean", "label": "سابقه کار پورسانتی و تارگت داشته باشد", "weight": 15, "defaultChecked": true },
    { "id": "q5", "kind": "knockout", "type": "single", "label": "حداقل سابقه کار مورد انتظار", "weight": 15,
      "options": [ {"value":"any","label":"فرقی نمی‌کند"}, {"value":"1","label":"بالای ۱ سال"}, {"value":"3","label":"بالای ۳ سال"}, {"value":"5","label":"بالای ۵ سال"} ],
      "defaultValue": "1" },
    { "id": "q6", "kind": "bonus", "type": "multi", "label": "کدام مهارت‌ها برای شما اولویت بیشتری دارد؟", "weight": 10,
      "options": [ {"value":"nego","label":"مذاکره و فن بیان"}, {"value":"merch","label":"چیدمان فروشگاهی"}, {"value":"fmcg","label":"آشنایی با پخش کالا"}, {"value":"excel","label":"اکسل و گزارش فروش"} ],
      "defaultValues": ["nego","fmcg"] }
  ]
}`;

/**
 * Validates and normalizes a questionnaire — from the AI, or one the user edited
 * in the job wizard (`userEdited` relaxes the minimum counts). Returns null when
 * the shape cannot be trusted.
 */
export function repairUnderstanding(
  raw: any,
  department: Department,
  roleTitle: string,
  opts: { userEdited?: boolean } = {}
): JobUnderstanding | null {
  try {
    const minCriteria = opts.userEdited ? 2 : 3;
    const minQuestions = opts.userEdited ? 1 : 3;
    if (!raw || !Array.isArray(raw.criteria) || raw.criteria.length < minCriteria) return null;
    if (!Array.isArray(raw.questions) || raw.questions.length < minQuestions) return null;

    // Normalize criteria: ids, integer weights summing to 100, at least one mustHave
    const criteria: Criterion[] = raw.criteria.slice(0, opts.userEdited ? 8 : 6).map((c: any, i: number) => ({
      id: typeof c.id === 'string' && c.id ? c.id : `c${i + 1}`,
      title: String(c.title || '').trim().slice(0, 140),
      weight: Math.max(1, Math.round(Number(c.weight) || 0)),
      mustHave: Boolean(c.mustHave),
    }));
    if (criteria.some((c) => !c.title)) return null;
    if (!criteria.some((c) => c.mustHave)) criteria[0].mustHave = true;
    const totalW = criteria.reduce((s, c) => s + c.weight, 0);
    if (totalW <= 0) return null;
    const scale = 100 / totalW;
    const weights = criteria.map((c) => Math.max(1, Math.round(c.weight * scale)));
    let diff = 100 - weights.reduce((s, w) => s + w, 0);
    let guard = 0;
    while (diff !== 0 && guard++ < 100) {
      const idx = weights.indexOf(Math.max(...weights));
      weights[idx] += diff > 0 ? 1 : -1;
      if (weights[idx] < 1) weights[idx] = 1;
      diff = 100 - weights.reduce((s, w) => s + w, 0);
    }
    criteria.forEach((c, i) => (c.weight = weights[i]));

    // Normalize questions (5-8 questions), booleans dominate
    const questions: ScreeningQuestion[] = [];
    const usedIds = new Set<string>();
    let qIdx = 0;
    for (const q of raw.questions.slice(0, 8)) {
      if (!q || typeof q.label !== 'string' || !q.label.trim()) continue;
      let id = typeof q.id === 'string' && q.id ? q.id : `q${++qIdx}`;
      while (usedIds.has(id)) id = `${id}-${++qIdx}`;
      usedIds.add(id);
      const kind: 'knockout' | 'bonus' = q.kind === 'bonus' ? 'bonus' : 'knockout';
      const weight = Math.max(1, Math.round(Number(q.weight) || 10));
      if (q.type === 'single' && Array.isArray(q.options) && q.options.length >= 2) {
        const options = q.options
          .slice(0, 6)
          .map((o: any, i: number) => ({ value: String(o.value ?? i), label: String(o.label ?? o.value ?? '').trim() }))
          .filter((o: { label: string }) => o.label);
        const def = String(q.defaultValue ?? options[0]?.value ?? 'any');
        questions.push({
          id, kind, type: 'single', label: q.label.trim(), weight, options,
          defaultValue: options.some((o: { value: string }) => o.value === def) ? def : options[0]?.value ?? 'any',
        });
      } else if (q.type === 'multi' && Array.isArray(q.options) && q.options.length >= 2) {
        const options = q.options
          .slice(0, 8)
          .map((o: any, i: number) => ({ value: String(o.value ?? i), label: String(o.label ?? o.value ?? '').trim() }))
          .filter((o: { label: string }) => o.label);
        const defs = new Set((Array.isArray(q.defaultValues) ? q.defaultValues : []).map((v: any) => String(v)));
        questions.push({
          id, kind, type: 'multi', label: q.label.trim(), weight, options,
          defaultValues: options.map((o: { value: string }) => o.value).filter((v: string) => defs.has(v)),
        });
      } else {
        questions.push({ id, kind, type: 'boolean', label: q.label.trim(), weight, defaultChecked: Boolean(q.defaultChecked) });
      }
    }
    if (questions.length < minQuestions) return null;
    // Ensure a minimum-experience single-choice question exists
    if (!questions.some((q) => q.type === 'single')) {
      questions.push({
        id: 'q-min-exp', kind: 'knockout', type: 'single', weight: 10,
        label: 'حداقل سابقه کار مورد انتظار',
        options: [
          { value: 'any', label: 'فرقی نمی‌کند' },
          { value: '1', label: 'بالای ۱ سال' },
          { value: '3', label: 'بالای ۳ سال' },
          { value: '5', label: 'بالای ۵ سال' },
        ],
        defaultValue: 'any',
      });
    }

    let interview = Math.round(Number(raw.thresholds?.interview) || 75);
    let review = Math.round(Number(raw.thresholds?.review) || 50);
    interview = Math.min(85, Math.max(70, interview));
    review = Math.min(60, Math.max(45, review));
    if (review >= interview - 10) review = interview - 15;

    return {
      department: department.name,
      departmentId: department.id,
      roleTitle: roleTitle || '',
      seniority: String(raw.seniority || 'کارشناسی').trim().slice(0, 60),
      plainExplanation:
        String(raw.plainExplanation || '').trim().slice(0, 600) ||
        'معیارهای این شغل تحلیل شد و رزومه‌ها بر اساس تطابق سوابق و مهارت‌ها سنجیده می‌شوند.',
      thresholds: { interview, review },
      criteria,
      questions,
    };
  } catch {
    return null;
  }
}

/** Maps any (possibly custom) department to the closest built-in template. */
function templateKey(department: Department): string {
  if (['sales', 'manufacturing', 'finance', 'it', 'hr'].includes(department.id)) return department.id;
  const n = `${department.name} ${department.hint}`;
  if (/فروش|بازرگانی|ویزیت/.test(n)) return 'sales';
  if (/تولید|کارخانه|کارگاه/.test(n)) return 'manufacturing';
  if (/مالی|حسابدار/.test(n)) return 'finance';
  if (/فناوری|نرم.?افزار|برنامه.?نویس|\bIT\b|شبکه/i.test(n)) return 'it';
  if (/منابع انسانی|جذب|کارگزینی/.test(n)) return 'hr';
  return 'default';
}

/**
 * Ready-made criteria + questionnaire used ONLY when the AI is unavailable and
 * the user explicitly chooses «الگوی آماده دپارتمان». Jobs created this way are
 * stored with criteriaSource = 'template' and labelled as such in the UI.
 */
export function buildTemplateUnderstanding(department: Department, roleTitle: string): JobUnderstanding {
  const dept = department;
  const departmentId = department.id;
  const title = roleTitle.trim();

  switch (templateKey(department)) {
    case 'sales':
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه برای موقعیت «${title}» بر اساس مهارت‌های فروش میدانی، فن بیان و تارگت‌های پخش تنظیم شد.`
          : 'معیارها و پرسش‌نامه بر اساس مهارت‌های فروش میدانی، فن بیان و تارگت‌های پخش تنظیم شد.',
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'سابقه و نتایج فروش میدانی، مویرگی یا ویزیتوری', weight: 35, mustHave: true },
          { id: 'c2', title: 'فن بیان، اصول مذاکره و متقاعدسازی مشتری', weight: 25, mustHave: true },
          { id: 'c3', title: 'آشنایی با صنعت و بازار هدف (مانند پخش و کالاهای تندمصرف)', weight: 20, mustHave: false },
          { id: 'c4', title: 'آمادگی تردد میدانی، انگیزه تارگت و پایداری شغلی', weight: 20, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه فروش حضوری، ویزیتوری یا پخش مویرگی داشته باشد؟', weight: 25, defaultChecked: true },
          { id: 'q2', kind: 'knockout', type: 'boolean', label: 'آماده تردد مستمر در مسیر ویزیت و مناطق شهری باشد؟', weight: 20, defaultChecked: true },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'سابقه کار در صنعت پخش FMCG یا آرایشی-بهداشتی داشته باشد؟', weight: 15, defaultChecked: true },
          { id: 'q4', kind: 'bonus', type: 'boolean', label: 'سابقه کار با نرم‌افزارهای سفارش‌گیری یا تبلت فروش داشته باشد؟', weight: 15, defaultChecked: false },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 15,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'مهارت‌های تکمیلی اولویت‌دار',
            weight: 10,
            options: [
              { value: 'nego', label: 'اصول مذاکره و متقاعدسازی' },
              { value: 'crm', label: 'ارتباط با مشتری (CRM)' },
              { value: 'merch', label: 'مرچندایزینگ و چیدمان فروشگاهی' },
              { value: 'route', label: 'مسیربندی و بازاریابی منطقه‌ای' },
            ],
            defaultValues: ['nego'],
          },
        ],
      };

    case 'manufacturing':
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی / فنی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه برای «${title}» با تمرکز بر سابقه خط تولید، کار شیفتی و انضباط کارگاهی تنظیم شد.`
          : 'معیارها و پرسش‌نامه با تمرکز بر سابقه خط تولید، کار شیفتی و انضباط کارگاهی تنظیم شد.',
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'سابقه کارگاهی، اپراتوری خط تولید یا کار با ماشین‌آلات صنعتی', weight: 35, mustHave: true },
          { id: 'c2', title: 'آمادگی کار در شیفت‌های چرخشی (روز/شب) و انضباط فردی', weight: 25, mustHave: true },
          { id: 'c3', title: 'رعایت اصول ایمنی محیط کار و ضوابط بهداشتی کارخانه', weight: 20, mustHave: false },
          { id: 'c4', title: 'مدارک فنی‌وحرفه‌ای مرتبط یا مهارت در ابزار دقیق', weight: 20, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه کار در محیط کارخانه یا خط تولید داشته باشد؟', weight: 25, defaultChecked: true },
          { id: 'q2', kind: 'knockout', type: 'boolean', label: 'آماده کار در شیفت‌های چرخشی و اضافه کاری باشد؟', weight: 25, defaultChecked: true },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'مدرک فنی‌وحرفه‌ای یا دیپلم/کاردانی فنی داشته باشد؟', weight: 15, defaultChecked: true },
          { id: 'q4', kind: 'bonus', type: 'boolean', label: 'تجربه کار با ماشین‌آلات بسته‌بندی یا تولید داشته باشد؟', weight: 15, defaultChecked: false },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 10,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'مهارت‌های تخصصی کارگاهی',
            weight: 10,
            options: [
              { value: 'pm', label: 'نگهداری و سرویس ماشین‌آلات (PM)' },
              { value: 'tools', label: 'کار با ابزارهای اندازه‌گیری دقیق' },
              { value: 'quality', label: 'کنترل اولیه حین تولید' },
              { value: 'shift-log', label: 'ثبت گزارش‌های روزانه شیفت' },
            ],
            defaultValues: ['pm'],
          },
        ],
      };

    case 'finance':
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه برای «${title}» بر اساس تسلط به نرم‌افزارهای مالی، حسابداری صنعتی و قوانین مالیاتی تدوین شد.`
          : 'معیارها و پرسش‌نامه بر اساس نرم‌افزارهای مالی، حسابداری صنعتی و قوانین مالیاتی تدوین شد.',
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'تسلط بر نرم‌افزارهای مالی و حسابداری (سپیدار / همکاران سیستم)', weight: 35, mustHave: true },
          { id: 'c2', title: 'تسلط بر قوانین مالیاتی، بیمه و ارسال اظهارنامه و سامانه مودیان', weight: 25, mustHave: true },
          { id: 'c3', title: 'حسابداری صنعتی، بهای تمام‌شده و کنترل انبار', weight: 20, mustHave: false },
          { id: 'c4', title: 'دقت محاسباتی، تسلط بر اکسل پیشرفته و گزارش‌گیری مالی', weight: 20, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه کار با نرم‌افزارهای مالی (مانند سپیدار یا همکاران سیستم) داشته باشد؟', weight: 25, defaultChecked: true },
          { id: 'q2', kind: 'knockout', type: 'boolean', label: 'تحصیلات دانشگاهی در رشته حسابداری یا مدیریت مالی داشته باشد؟', weight: 20, defaultChecked: true },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'تسلط به اکسل و فرمول‌نویسی پیشرفته مالی داشته باشد؟', weight: 15, defaultChecked: true },
          { id: 'q4', kind: 'bonus', type: 'boolean', label: 'تجربه کار در شرکت‌های تولیدی یا بازرگانی داشته باشد؟', weight: 15, defaultChecked: true },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 15,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'حوزه‌های مسلط حسابداری',
            weight: 10,
            options: [
              { value: 'tax', label: 'سامانه مودیان و مالیات ارزش افزوده' },
              { value: 'payroll', label: 'حقوق و دستمزد و لیست بیمه' },
              { value: 'cost', label: 'حسابداری بهای تمام‌شده' },
              { value: 'treasury', label: 'خزانه‌داری و مغایرت بانکی' },
            ],
            defaultValues: ['payroll', 'tax'],
          },
        ],
      };

    case 'it':
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه برای «${title}» بر اساس مهارت‌های تخصصی IT، پایداری زیرساخت و حل مسئله تدوین شد.`
          : 'معیارها و پرسش‌نامه بر اساس مهارت‌های فنی IT، زیرساخت و عیب‌یابی سامانه‌ها تدوین شد.',
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'سوابق فنی و پروژه‌های عملی مرتبط در حوزه IT', weight: 40, mustHave: true },
          { id: 'c2', title: 'توانایی عیب‌یابی، پشتیبانی سریع و حل مسئله', weight: 25, mustHave: true },
          { id: 'c3', title: 'آشنایی با شبکه‌های سازمانی، سرورها و پایگاه‌های داده', weight: 20, mustHave: false },
          { id: 'c4', title: 'مستندسازی فنی، مسئولیت‌پذیری و آموزش‌پذیری', weight: 15, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه کار تخصصی و پروژه‌های واقعی در حوزه IT داشته باشد؟', weight: 30, defaultChecked: true },
          { id: 'q2', kind: 'bonus', type: 'boolean', label: 'مدرک دانشگاهی مرتبط با مهندسی کامپیوتر یا فناوری اطلاعات داشته باشد؟', weight: 15, defaultChecked: false },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'تسلط به زبان انگلیسی تخصصی جهت مستندات و عیب‌یابی داشته باشد؟', weight: 15, defaultChecked: true },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 20,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'تخصص‌های کلیدی موردنیاز',
            weight: 20,
            options: [
              { value: 'network', label: 'پشتیبانی شبکه و سیستم‌ها (Helpdesk)' },
              { value: 'dev', label: 'برنامه‌نویسی و توسعه نرم‌افزار' },
              { value: 'db', label: 'پایگاه داده و کوئری‌نویسی SQL' },
              { value: 'infra', label: 'مدیریت سرور لینوکس / ویندوز' },
            ],
            defaultValues: ['network'],
          },
        ],
      };

    case 'hr':
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه برای «${title}» بر پایه تجربه جذب و استخدام، مهارت مصاحبه و آشنایی با قانون کار تنظیم شد.`
          : 'معیارها و پرسش‌نامه بر پایه تجربه جذب و استخدام، مهارت مصاحبه و آشنایی با قانون کار تنظیم شد.',
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'سابقه عملی جذب، منبع‌یابی و استخدام', weight: 35, mustHave: true },
          { id: 'c2', title: 'مهارت مصاحبه و ارزیابی شایستگی', weight: 25, mustHave: true },
          { id: 'c3', title: 'آشنایی با قانون کار، کارگزینی و بیمه', weight: 20, mustHave: false },
          { id: 'c4', title: 'کار با ابزارها و سامانه‌های منابع انسانی (ATS، اکسل)', weight: 20, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه کار در جذب و استخدام داشته باشد؟', weight: 30, defaultChecked: true },
          { id: 'q2', kind: 'bonus', type: 'boolean', label: 'تجربه مصاحبه شایستگی‌محور یا کانون ارزیابی داشته باشد؟', weight: 15, defaultChecked: true },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'با قانون کار و امور کارگزینی آشنا باشد؟', weight: 15, defaultChecked: true },
          { id: 'q4', kind: 'bonus', type: 'boolean', label: 'با سامانه‌های جذب (ATS) کار کرده باشد؟', weight: 10, defaultChecked: false },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 15,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'مهارت‌های تکمیلی اولویت‌دار',
            weight: 15,
            options: [
              { value: 'sourcing', label: 'منبع‌یابی فعال و شبکه‌سازی' },
              { value: 'branding', label: 'برند کارفرمایی' },
              { value: 'onboarding', label: 'فرایند جذب و آشناسازی نیرو' },
              { value: 'analytics', label: 'گزارش‌گیری و شاخص‌های جذب' },
            ],
            defaultValues: ['sourcing'],
          },
        ],
      };

    default:
      return {
        department: dept.name,
        departmentId,
        roleTitle: title,
        seniority: 'کارشناسی',
        plainExplanation: title
          ? `معیارها و پرسش‌نامه ارزیابی برای «${title}» در دپارتمان ${dept.name} آماده شد.`
          : `معیارها و پرسش‌نامه ارزیابی بر اساس نیازمندی‌های عمومی دپارتمان ${dept.name} آماده شد.`,
        thresholds: { interview: 75, review: 50 },
        criteria: [
          { id: 'c1', title: 'سوابق کاری و تجربیات مرتبط با این موقعیت شغلی', weight: 35, mustHave: true },
          { id: 'c2', title: 'مهارت‌های تخصصی و کار با ابزارها/سامانه‌های حوزه شغلی', weight: 25, mustHave: true },
          { id: 'c3', title: 'نظم کاری، مسئولیت‌پذیری و ثبات شغلی', weight: 20, mustHave: false },
          { id: 'c4', title: 'تحصیلات مرتبط یا مدارک دوره‌های آموزشی تخصصی', weight: 20, mustHave: false },
        ],
        questions: [
          { id: 'q1', kind: 'knockout', type: 'boolean', label: 'سابقه کار مرتبط در موقعیت شغلی مشابه داشته باشد؟', weight: 30, defaultChecked: true },
          { id: 'q2', kind: 'bonus', type: 'boolean', label: 'مدرک تحصیلی دانشگاهی یا گواهی معتبر مرتبط داشته باشد؟', weight: 15, defaultChecked: true },
          { id: 'q3', kind: 'bonus', type: 'boolean', label: 'مهارت در نرم‌افزارهای تخصصی و کاربردی (آفیس و سامانه‌ها) داشته باشد؟', weight: 15, defaultChecked: true },
          {
            id: 'q-min-exp',
            kind: 'knockout',
            type: 'single',
            label: 'حداقل سابقه کار مورد انتظار',
            weight: 20,
            options: [
              { value: 'any', label: 'فرقی نمی‌کند' },
              { value: '1', label: 'بالای ۱ سال' },
              { value: '3', label: 'بالای ۳ سال' },
              { value: '5', label: 'بالای ۵ سال' },
            ],
            defaultValue: '1',
          },
          {
            id: 'q-skills',
            kind: 'bonus',
            type: 'multi',
            label: 'شایستگی‌های رفتاری و فنی',
            weight: 20,
            options: [
              { value: 'teamwork', label: 'کار تیمی و انطباق‌پذیری' },
              { value: 'reporting', label: 'گزارش‌نویسی و مستندسازی' },
              { value: 'problem-solving', label: 'حل مسئله و پیگیری امور' },
              { value: 'communication', label: 'فن بیان و ارتباط موثر' },
            ],
            defaultValues: ['teamwork', 'problem-solving'],
          },
        ],
      };
  }
}

// In-memory cache for questionnaires (1 hour TTL), keyed per organization.
const understandCache = new Map<string, { result: JobUnderstanding; expiresAt: number }>();

export interface UnderstandInput {
  orgName: string;
  department: Department;
  roleTitle: string;
  extraNotes?: string;
  location?: string;
  employmentType?: EmploymentType | null;
}

export async function understandJob(input: UnderstandInput): Promise<JobUnderstanding> {
  const { orgName, department } = input;
  const roleTitle = input.roleTitle.trim();
  const extraNotes = (input.extraNotes || '').trim();
  const cacheKey = [orgName, department.id, department.name, roleTitle.toLowerCase(), extraNotes.toLowerCase(), input.location || '', input.employmentType || ''].join('::');
  const cached = understandCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  const prompt = `تو یک کارشناس ارشد تحلیل شغل و استخدام در سازمان «${orgName}» هستی و با دستیار هوشمند «هویدا» کار می‌کنی.
قرار است برای یک فرصت شغلی، شاخص‌های ارزیابی و چند پرسش بسیار ساده (چک‌باکسی) برای کارشناس منابع انسانی بسازی.

دپارتمان: ${department.name}
حوزه کاری این دپارتمان: ${department.hint || '—'}
عنوان شغلی: ${roleTitle || '—'}
${input.location ? `محل کار: ${input.location}\n` : ''}${input.employmentType ? `نوع همکاری: ${EMPLOYMENT_LABELS[input.employmentType]}\n` : ''}${extraNotes ? `شرح شغل و توضیحات تکمیلی کاربر:\n"""\n${extraNotes.slice(0, 2500)}\n"""` : ''}

کارها:
۱. «سطح ارشدیت» نقش را در یک عبارت کوتاه فارسی بنویس (کارآموزی، کارشناسی، کارشناس ارشد، سرپرستی، مدیریت).
۲. بین ۴ تا ۵ «شاخص ارزیابی وزن‌دار» بساز؛ جمع وزن‌ها دقیقاً ۱۰۰ شود؛ حداقل یکی و حداکثر دوتا mustHave: true باشد. شاخص‌ها مخصوص همین دپارتمان و همین شغل باشند، نه کلی و تکراری.
۳. بین ۵ تا ۸ «پرسش بسیار ساده» بساز که یک کاربر غیرفنی فقط با تیک‌زدن پاسخ بدهد:
   - بیشتر پرسش‌ها type=boolean با پاسخ بله/خیر و label ساده و روشن، مثلاً «سابقه کار در خط تولید داشته باشد؟»، «آماده کار در شیفت چرخشی باشد؟»، «مدرک فنی مرتبط داشته باشد؟».
   - دقیقاً یک پرسش type=single با id مثل q-exp برای «حداقل سابقه کار مورد انتظار» با گزینه‌های any/1/3/5.
   - حداکثر دو پرسش type=multi برای مهارت‌های کلیدی، با ۴ تا ۶ گزینه کوتاه.
   - kind: شرط‌هایی که نبودشان عملاً رزومه را از رقابت خارج می‌کند «knockout»؛ بقیه «bonus».
   - defaultChecked / defaultValue / defaultValues را طوری تنظیم کن که برای حالت معمول همین شغل کمترین تغییر لازم باشد.
۴. آستانه‌ها: interview بین ۷۰ تا ۸۵ (نقش مدیریتی یا حساس نزدیک ۸۵، نقش‌های عمومی نزدیک ۷۰)، review بین ۴۵ تا ۶۰ و همیشه دست‌کم ۱۵ واحد کمتر از interview.
۵. plainExplanation: یک یا دو جمله ساده، حرفه‌ای و گرم با خطاب «شما»، بدون عدد، وزن یا اصطلاح فنی، که بگوید برای این شغل چه چیزهایی مهم‌تر در نظر گرفته شد.

فقط و فقط JSON معتبر، دقیقاً با همین ساختار (نمونه از یک شغل دیگر، فقط برای فهم قالب):
${QUESTION_EXAMPLE_JSON}`;

  let lastErr: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await generate(prompt, { temperature: 0.2, timeoutMs: 25_000, deadlineMs: 45_000 });
      const parsed = cleanAndParseJson<any>(raw, null);
      const understanding = parsed ? repairUnderstanding(parsed, department, roleTitle) : null;
      if (understanding) {
        understandCache.set(cacheKey, { result: understanding, expiresAt: Date.now() + 3600_000 });
        return understanding;
      }
      lastErr = new Error('پاسخ هوش مصنوعی در قالب مورد نظر نبود');
    } catch (err: any) {
      lastErr = err;
      if (err?.name === 'AiUnavailableError' || err?.message === CIRCUIT_OPEN) break;
    }
  }
  console.error('[understandJob] questionnaire generation failed:', lastErr?.message || lastErr);
  throw new Error(friendlyAiError(lastErr));
}

// ================================================================
// Helpers: turn the user's checkbox answers into prompt constraints
// ================================================================

function optionLabel(q: ScreeningQuestion, value: string): string {
  if (q.type === 'single' && Array.isArray(q.options)) {
    return q.options.find((o) => o.value === value)?.label || value;
  }
  return value;
}

export function buildAnswersBrief(understanding: JobUnderstanding, answers: ScreeningAnswers): string {
  const lines: string[] = [];
  const questions = Array.isArray(understanding?.questions) ? understanding.questions : [];
  for (const q of questions) {
    const ans = answers?.[q.id];
    if (q.type === 'boolean') {
      // An explicit answer always wins; the default only applies when unanswered.
      // (Previously a user-ticked optional criterion with defaultChecked=false was dropped.)
      const checked = ans === undefined ? q.defaultChecked : ans === true;
      if (checked) {
        lines.push(`${q.kind === 'knockout' ? '【شرط حذفی الزام】' : '【مزیت امتیازی】'} ${q.label}`);
      }
    } else if (q.type === 'single') {
      const value = String(ans ?? q.defaultValue);
      if (value && value !== 'any') {
        lines.push(`【شرط سابقه】 ${q.label}: ${optionLabel(q, value)}`);
      }
    } else {
      const selected = Array.isArray(ans)
        ? ans
        : typeof ans === 'string'
        ? [ans]
        : Array.isArray(q.defaultValues)
        ? q.defaultValues
        : [];
      if (selected.length > 0 && Array.isArray(q.options)) {
        const labels = selected.map((v) => q.options.find((o) => o.value === v)?.label || v);
        lines.push(`【مهارت‌های ترجیحی کاربر】 ${q.label}: ${labels.join('، ')}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : 'کاربر شرط اضافه‌ای تیک نزده؛ فقط بر اساس شاخص‌های وزن‌دار ارزیابی کن.';
}

function emptyEvaluation(reason: string): CandidateEvaluation {
  return {
    candidateName: null,
    contact: { phone: null, email: null, city: null },
    facts: { yearsExperience: null, education: null, lastRole: null, skills: [], expectedSalary: null },
    criterionScores: [],
    score: 0,
    confidence: 'low',
    engine: 'ai',
    recommendation: 'REJECT',
    summary: reason,
    whyCategory: reason,
    strengths: [],
    weaknesses: [{ point: 'فایل بدون محتوای متنی معتبر', evidence: reason, severity: 'knockout' }],
    knockoutMisses: [],
    tags: [],
    bankSuggested: false,
    flags: { irrelevant: false, insufficientInfo: true, scannedNoText: false },
  };
}

// ================================================================
// PASS 1 — Evaluate a single resume
// ================================================================

export interface EvaluateInput {
  orgName: string;
  job: Pick<Job, 'departmentName' | 'roleTitle' | 'extraNotes' | 'understanding' | 'answers'>;
  resumeText: string;
  fileName: string;
  fileBase64?: string | null;
  fileMime?: string;
  /** 'deep' = «بازبینی دقیق»: slower, evidence-by-evidence re-read requested by the user. */
  mode?: AnalysisMode;
}

export async function evaluateResume(input: EvaluateInput): Promise<CandidateEvaluation> {
  const { job, fileName } = input;
  const understanding = job.understanding;
  const answers = job.answers || {};
  const deep = input.mode === 'deep';
  const normalized = normalizePersianText(input.resumeText || '');
  const hasText = Boolean(normalized && normalized.trim().length >= 30);
  const base64 = input.fileBase64 && input.fileBase64.length > 20 ? input.fileBase64 : null;
  const mime = input.fileMime || detectResumeMime(fileName, base64);
  const isMultimodal = Boolean(base64 && mime && (mime === 'application/pdf' || mime.startsWith('image/')));

  if (!hasText && !isMultimodal) {
    const ev = emptyEvaluation('متن استخراج‌شده از رزومه برای تحلیل کافی نیست (فایل خالی یا غیرقابل بازخوانی است).');
    ev.flags.scannedNoText = true;
    return ev;
  }

  // Fast pass: clean extracted text is enough (tiny payload, same quality).
  // Deep review deliberately re-reads the original file too: tables, charts and
  // two-column layouts often hide details that plain text extraction drops.
  const needsMultimodal = deep ? isMultimodal : !hasText && isMultimodal;
  const textBudget = deep ? 18000 : 9500;

  const criteriaStr = understanding.criteria
    .map((c) => `${c.id}. ${c.title} — وزن ${c.weight}٪ ${c.mustHave ? '(الزامی)' : ''}`)
    .join('\n');
  const answersBrief = buildAnswersBrief(understanding, answers);

  let fileContentSection: string;
  if (needsMultimodal && hasText && deep) {
    fileContentSection = `فایل اصلی رزومه (PDF یا تصویر) ضمیمه شده و متن استخراج‌شده آن هم در ادامه آمده است.
ابتدا فایل را صفحه‌به‌صفحه، شامل جدول‌ها، ستون‌ها، پاورقی‌ها، لینک‌ها و نوشته‌های ریز بررسی کن و سپس با متن استخراج‌شده مقایسه کن؛ هر چیزی که فقط در فایل دیده می‌شود را هم لحاظ کن.

متن استخراج‌شده از رزومه:
"""
${normalized.slice(0, textBudget)}
"""`;
  } else if (needsMultimodal) {
    fileContentSection = `رزومه به‌صورت فایل ضمیمه (PDF یا تصویر اسکن‌شده) همراه این درخواست ارسال شده است. همه لایه‌ها، جدول‌ها، متن‌های فارسی و انگلیسی، سوابق و مشخصات را مستقیماً از روی فایل با دقت استخراج و تحلیل کن.`;
  } else {
    fileContentSection = `متن کامل رزومه:
"""
${normalized.slice(0, textBudget)}
"""`;
  }

  const deepInstruction = deep
    ? `
【حالت بازبینی دقیق】
کارشناس منابع انسانی «بازبینی دقیق» را درخواست کرده است؛ یعنی یک بار این رزومه سریع بررسی شده و حالا قضاوتی جزئی‌نگرتر می‌خواهد:
الف) هر بند، هر شغل، هر تاریخ و هر عدد رزومه را جداگانه بخوان و با شاخص‌ها تطبیق بده.
ب) تناقض‌ها و ابهام‌ها را فعالانه جست‌وجو کن: هم‌پوشانی یا شکاف زمانی بین سوابق، عنوان شغلی بزرگ‌تر از شرح وظایف، ادعای مهارت بدون شاهد، تاریخ‌های نامنظم، یا دستاوردهای بدون عدد و سنجه.
پ) برای هر شاخص rationale را کامل‌تر و evidence را دقیق‌تر (نقل‌قول مستقیم و کوتاه از رزومه) بنویس؛ اگر شاهدی نیست صریحاً بنویس «در رزومه به این مورد اشاره نشده».
ت) نقاط قوت و ضعف را تا حداکثر ۶ مورد و فقط با شاهد واقعی بنویس.
ث) بلوک «deepFindings» را حتماً پر کن:
   - focusPoints: حداکثر ۵ نکته دقیق که در این بازخوانی پیدا کردی و در نگاه اول دیده نمی‌شد.
   - interviewQuestions: حداکثر ۵ پرسش مصاحبه‌ای اختصاصی برای راستی‌آزمایی همین رزومه.
   - risks: حداکثر ۴ ریسک، تناقض یا علامت هشدار؛ اگر موردی نبود آرایه خالی بده.
ج) اگر شواهد روشن‌تر شد امتیاز را بدون تعارف اصلاح کن؛ اگر تغییری نکرد همان امتیاز را نگه دار و در summary بنویس که بازبینی نتیجه را تأیید کرد.
`
    : '';

  const prompt = `تو یک کارشناس ارشد و بسیار دقیق غربالگری رزومه در سازمان «${input.orgName}» هستی و با دستیار هوشمند «هویدا» کار می‌کنی.
یک رزومه را با شرایط شغل می‌سنجی. نقش تو توصیف میزان تطابق با شواهد است؛ تصمیم نهایی با انسان است.

دپارتمان: ${job.departmentName}
${job.roleTitle.trim() ? `عنوان شغلی: ${job.roleTitle.trim()}` : ''}
سطح ارشدیت نقش: ${understanding.seniority}
${job.extraNotes.trim() ? `شرح شغل و توضیحات تکمیلی:\n${job.extraNotes.trim().slice(0, 2500)}\n` : ''}
شاخص‌های وزن‌دار امتیازدهی:
${criteriaStr}

شرط‌هایی که کارشناس منابع انسانی تیک زده:
${answersBrief}

آستانه‌ها:
- از ${understanding.thresholds.interview} به بالا = INTERVIEW (تطابق بالا)
- بین ${understanding.thresholds.review} و ${understanding.thresholds.interview} = REVIEW (نیازمند بررسی)
- زیر ${understanding.thresholds.review} = REJECT (تطابق پایین)

نام فایل رزومه: ${fileName}
${fileContentSection}
${deepInstruction}
قوانین نقض‌ناپذیر:
۱. فقط بر اساس چیزی که واقعاً در رزومه آمده قضاوت کن. هرگز نام، عدد، سابقه، مدرک یا مهارتی را حدس نزن یا از نام فایل برداشت نکن. اگر اطلاعاتی نبود، null بده.
۲. candidateName فقط اگر نام صریح در رزومه آمده پر شود؛ در غیر این صورت null.
۳. برای هر شاخص در criterionScores: امتیاز ۰ تا ۱۰۰، rationale یک جمله فارسی، و evidence یک «نقل‌قول مستقیم کوتاه واقعی» از متن رزومه. اگر شاخصی هیچ شاهدی نداشت، امتیاز پایین بده و evidence را «در رزومه به این مورد اشاره نشده» بنویس.
۴. strengths حداکثر ۴ و weaknesses حداکثر ۴ مورد؛ همه با evidence واقعی. severity: مواردی که شرط حذفی تیک‌خورده یا شاخص الزامی را نقض می‌کنند «knockout»، نقص‌های مهم «major»، موارد جزئی «minor».
۵. knockoutMisses: فهرست شرط‌های حذفی تیک‌خورده‌ای که در رزومه شاهدی برایشان نیست یا خلافشان دیده شده.
۶. score از ۰ تا ۱۰۰ بر اساس میانگین وزنی criterionScores و قضاوت تو. قوانین سقف:
   - رزومه کاملاً نامرتبط با دپارتمان/شغل: score زیر ۳۰، flags.irrelevant=true، recommendation=REJECT.
   - اگر هر شاخص الزامی یا هر شرط حذفی تیک‌خورده احراز نشود: سقف score برابر ۴۵.
   - اگر رزومه آن‌قدر کم‌اطلاع است که قضاوت ممکن نیست: flags.insufficientInfo=true و score پایین.
۷. صرف نام‌بردن از یک مهارت بدون سابقه، پروژه یا تجربه امتیاز کامل ندارد؛ جابه‌جایی‌های شغلی بسیار پرتکرار را به‌عنوان ریسک ثبات شغلی در weaknesses بیاور.
۸. نام، جنسیت، سن، وضعیت تأهل، عکس، قومیت و ملیت هیچ تأثیری بر امتیاز ندارند؛ فقط شایستگی‌ها سنجیده شوند.
۹. استخراج دقیق اطلاعات (facts و contact):
   - yearsExperience: مجموع سابقه کاری واقعی به سال (عدد صحیح). اگر کارجو عدد سابقه را صریحاً نوشته همان را ملاک بگذار؛ در غیر این صورت از بازه‌های شغلی محاسبه کن، دوره‌های هم‌پوشان را دوبار نشمار و سال‌های تحصیل، کارآموزی کوتاه یا سربازی غیرمرتبط را سابقه کاری حساب نکن. اگر قابل محاسبه نیست null بده.
   - lastRole: جدیدترین سمت شغلی بر اساس آخرین تاریخ مندرج در رزومه.
   - education: مقطع و رشته تحصیلی ذکرشده.
   - contact: phone (موبایل یا تلفن، از جمله لینک‌های tel: و واتساپ)، email (از جمله لینک‌های mailto:) و city (شهر سکونت).
   - skills: حداکثر ۸ مهارت کلیدی تخصصی.
   - expectedSalary: حقوق درخواستی فقط در صورت ذکر صریح.
۱۰. tags: ۳ تا ۶ برچسب کوتاه فارسی برای جست‌وجو در بانک استعداد (حوزه تخصص، مهارت‌ها، سطح).
۱۱. bankSuggested: اگر برای این شغل مناسب نیست ولی برای فرصت‌های آینده ارزشمند است true.
۱۲. summary: ۲ تا ۳ جمله روان فارسی که بگوید چرا این میزان تطابق. whyCategory: یک جمله کوتاه، روشن و حرفه‌ای.
۱۳. confidence: high وقتی شواهد کافی و روشن است؛ medium وقتی چند نکته مبهم است؛ low وقتی رزومه ناقص است.
۱۴. رزومه فارسی یا انگلیسی هر دو پشتیبانی می‌شود؛ همه فیلدهای متنی خروجی فارسی باشند (نام مهارت‌های انگلیسی می‌تواند بماند).

فقط JSON معتبر با این ساختار بده، بدون هیچ توضیح اضافه:
{
  "candidateName": null,
  "contact": { "phone": null, "email": null, "city": null },
  "facts": { "yearsExperience": null, "education": null, "lastRole": null, "skills": [], "expectedSalary": null },
  "criterionScores": [
    { "criterionId": "c1", "score": 80, "rationale": "...", "evidence": "نقل قول واقعی از رزومه" }
  ],
  "score": 78,
  "confidence": "high",
  "recommendation": "INTERVIEW",
  "summary": "...",
  "whyCategory": "...",
  "strengths": [ { "point": "...", "evidence": "...", "severity": "minor" } ],
  "weaknesses": [ { "point": "...", "evidence": "...", "severity": "major" } ],
  "knockoutMisses": [],
  "tags": [],
  "bankSuggested": false,
  "flags": { "irrelevant": false, "insufficientInfo": false, "scannedNoText": false }${
    deep
      ? `,
  "deepFindings": { "focusPoints": ["..."], "interviewQuestions": ["..."], "risks": ["..."] }`
      : ''
  }
}`;

  try {
    const file: AiFile | undefined =
      needsMultimodal && base64 && mime ? { mimeType: mime, base64, fileName } : undefined;
    const raw = await generate(prompt, {
      temperature: 0.1,
      // Deep review is an explicit user action with a spinner on screen, so it
      // gets a much larger budget than the batch pass (and thinks harder).
      timeoutMs: deep ? 45_000 : 12_000,
      deadlineMs: deep ? 80_000 : 20_000,
      depth: deep ? 'deep' : 'fast',
      file,
      fileOptional: hasText,
    });
    const parsed = cleanAndParseJson<any>(raw, null);
    if (!parsed) throw new Error('malformed evaluation');
    return finalizeEvaluation(parsed, understanding, answers, 'ai', normalized, { deep, maxPoints: deep ? 6 : 4 });
  } catch (err: any) {
    if (err?.message !== CIRCUIT_OPEN && err?.name !== 'AiUnavailableError') {
      console.log(`[evaluateResume] «${fileName}» → local engine (${err?.message || 'err'})`);
    }
    return evaluateResumeLocal(normalized || fileName, understanding, answers, fileName);
  }
}

export interface FinalizeOptions {
  /** Deep review keeps more evidence points and parses the deepFindings block. */
  deep?: boolean;
  /** Max strengths/weaknesses kept (4 on the fast pass, 6 on a deep review). */
  maxPoints?: number;
}

/** Normalize, clamp and apply hard business rules to any AI/local evaluation. */
export function finalizeEvaluation(
  raw: any,
  understanding: JobUnderstanding,
  _answers: ScreeningAnswers,
  engine: AnalysisEngine,
  contextText?: string,
  options?: FinalizeOptions
): CandidateEvaluation {
  const maxPoints = Math.max(1, Math.min(8, options?.maxPoints || 4));
  const num = (v: any, d = 0) => {
    const n = Math.round(Number(toEnglishDigits(String(v ?? '')).replace(/[^\d.-]/g, '')));
    return Number.isFinite(n) ? n : d;
  };
  const arr = <T>(v: any): T[] => (Array.isArray(v) ? v : []);
  const str = (v: any) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  const criteria: Criterion[] = understanding.criteria;
  const criterionScores: CriterionScore[] = criteria.map((c) => {
    const found = arr<any>(raw.criterionScores).find(
      (s) => String(s.criterionId) === c.id || (s.title && String(s.title).includes(c.title.slice(0, 8)))
    );
    return {
      criterionId: c.id,
      title: c.title,
      score: Math.max(0, Math.min(100, num(found?.score, 40))),
      rationale: str(found?.rationale) || 'تحلیل جزئی این شاخص در دسترس نیست.',
      evidence: str(found?.evidence) || 'در رزومه شاهد مشخصی برای این شاخص ثبت نشده.',
    };
  });

  // Weighted score from per-criterion scores (authoritative baseline)
  const weighted = Math.round(
    criterionScores.reduce((s, cs) => {
      const c = criteria.find((x) => x.id === cs.criterionId);
      return s + cs.score * (c?.weight || 0);
    }, 0) / 100
  );
  const aiScore = Math.max(0, Math.min(100, num(raw.score, weighted)));
  // Trust the model's holistic score only if it's within ±12 of the weighted baseline
  let score = Math.abs(aiScore - weighted) <= 12 ? aiScore : weighted;

  const flags = {
    irrelevant: Boolean(raw.flags?.irrelevant),
    insufficientInfo: Boolean(raw.flags?.insufficientInfo),
    scannedNoText: Boolean(raw.flags?.scannedNoText),
  };

  const severityOf = (v: any) => (['knockout', 'major', 'minor'].includes(v) ? v : 'minor') as 'knockout' | 'major' | 'minor';
  const strengths: EvidencePoint[] = arr<any>(raw.strengths)
    .slice(0, maxPoints)
    .map((s) => ({
      point: str(s.point) || 'نقطه قوت',
      evidence: str(s.evidence) || 'شاهد در رزومه ثبت نشده.',
      severity: severityOf(s.severity),
    }));
  const weaknesses: EvidencePoint[] = arr<any>(raw.weaknesses)
    .slice(0, maxPoints)
    .map((w) => ({
      point: str(w.point) || 'مورد نیازمند بررسی',
      evidence: str(w.evidence) || 'شاهد در رزومه ثبت نشده.',
      severity: severityOf(w.severity),
    }));
  const knockoutMisses = arr<string>(raw.knockoutMisses)
    .map((k) => str(k))
    .filter((k): k is string => Boolean(k));

  const facts = {
    yearsExperience:
      raw.facts?.yearsExperience == null || raw.facts?.yearsExperience === ''
        ? null
        : Math.min(50, Math.max(0, num(raw.facts.yearsExperience, 0))),
    education: str(raw.facts?.education),
    lastRole: str(raw.facts?.lastRole),
    skills: arr<any>(raw.facts?.skills).map((s) => String(s)).filter(Boolean).slice(0, 8),
    expectedSalary: str(raw.facts?.expectedSalary),
  };
  const contact = {
    phone: str(raw.contact?.phone),
    email: str(raw.contact?.email),
    city: str(raw.contact?.city),
  };

  // Text-based enrichment only fills gaps — it never overrides the model.
  if (contextText) {
    if (!contact.email) {
      const emailMatch = contextText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) contact.email = emailMatch[0];
    }
    if (!contact.phone) {
      const digits = toEnglishDigits(contextText);
      const phoneMatch =
        digits.match(/(?:(?:\+|00)?98|0)?9\d{2}[\s-]?\d{3}[\s-]?\d{4}\b/) ||
        digits.match(/(?:tel:|wa\.me\/)(?:\+?98|0)?(9\d{9})/);
      if (phoneMatch) {
        const rawDigits = (phoneMatch[1] || phoneMatch[0]).replace(/[^\d]/g, '');
        if (rawDigits.startsWith('98') && rawDigits.length >= 12) contact.phone = '0' + rawDigits.slice(2, 12);
        else if (rawDigits.startsWith('9') && rawDigits.length === 10) contact.phone = '0' + rawDigits;
        else if (rawDigits.startsWith('09')) contact.phone = rawDigits.slice(0, 11);
        else contact.phone = phoneMatch[0].trim();
      }
    }
    if (!facts.education) {
      const eduMatch = contextText.match(
        /(دیپلم|کاردانی|کارشناسی\s*ارشد|کارشناسی|لیسانس|فوق\s*لیسانس|دکتری)[^\n.;،]{0,60}/
      );
      if (eduMatch) facts.education = eduMatch[0].replace(/\s+/g, ' ').trim();
    }
    // Explicitly stated experience — used only when the model returned nothing.
    // (The old "span of years mentioned anywhere" heuristic counted education
    // and unrelated dates, and inflated experience for most candidates.)
    if (facts.yearsExperience === null) {
      const expMatch = toEnglishDigits(contextText).match(
        /(\d{1,2})\s*سال\s*(?:سابقه|تجربه)|سابقه\s*(?:کار|کاری)?\s*[:：]\s*(\d{1,2})\s*سال|(\d{1,2})\+?\s*years?\s*(?:of\s*)?experience/i
      );
      if (expMatch) {
        const stated = num(expMatch[1] || expMatch[2] || expMatch[3]);
        if (stated > 0 && stated <= 45) facts.yearsExperience = stated;
      }
    }
  }

  // Hard ceiling rules
  const hasKnockoutMiss = knockoutMisses.length > 0 || weaknesses.some((w) => w.severity === 'knockout');
  const missingMustHave = criterionScores.some((cs) => {
    const c = criteria.find((x) => x.id === cs.criterionId);
    return c?.mustHave && cs.score < 35;
  });
  if (flags.irrelevant) score = Math.min(score, 29);
  if ((hasKnockoutMiss || missingMustHave) && !flags.irrelevant) score = Math.min(score, 45);

  let recommendation: Recommendation;
  if (flags.irrelevant) recommendation = 'REJECT';
  else if (score >= understanding.thresholds.interview) recommendation = 'INTERVIEW';
  else if (score >= understanding.thresholds.review) recommendation = 'REVIEW';
  else recommendation = 'REJECT';

  const deepFindings: DeepFindings | null = options?.deep
    ? (() => {
        const list = (v: any, limit: number) =>
          arr<any>(v)
            .map((x) => (typeof x === 'string' ? x.trim() : str(x?.point) || str(x?.text) || ''))
            .filter(Boolean)
            .slice(0, limit);
        const focusPoints = list(raw.deepFindings?.focusPoints, 5);
        const interviewQuestions = list(raw.deepFindings?.interviewQuestions, 5);
        const risks = list(raw.deepFindings?.risks, 4);
        if (!focusPoints.length && !interviewQuestions.length && !risks.length) return null;
        return { focusPoints, interviewQuestions, risks };
      })()
    : null;

  return {
    candidateName: str(raw.candidateName),
    contact,
    facts,
    criterionScores,
    score,
    confidence: (['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium') as 'high' | 'medium' | 'low',
    engine,
    recommendation,
    summary: str(raw.summary) || 'تحلیل این رزومه به‌طور کامل در دسترس نیست.',
    whyCategory: str(raw.whyCategory) || str(raw.summary) || 'این رزومه بر اساس معیارهای شغل سنجیده شد.',
    strengths,
    weaknesses,
    knockoutMisses,
    tags: arr<any>(raw.tags).map((t) => String(t)).filter(Boolean).slice(0, 6),
    bankSuggested: Boolean(raw.bankSuggested),
    flags,
    deepFindings,
  };
}

// ---------------- Local keyword-based engine (honestly labeled) ----------------

export function evaluateResumeLocal(
  resumeText: string,
  understanding: JobUnderstanding,
  _answers: ScreeningAnswers,
  fileName: string
): CandidateEvaluation {
  const text = normalizePersianText(resumeText || '');
  const digitsText = toEnglishDigits(text);
  const lower = text.toLowerCase();

  // Name: top lines, "نام: ..." pattern
  let candidateName: string | null = null;
  const head = text.slice(0, 400).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of head.slice(0, 6)) {
    const m = line.match(/(?:نام\s*(?:و\s*نام\s*خانوادگی)?|Name)\s*[:\-–]\s*([^\n,;|]{3,40})/i);
    if (m && m[1] && !/رزومه|resume|cv/i.test(m[1])) {
      candidateName = m[1].trim();
      break;
    }
  }
  if (!candidateName && head[0]) {
    // «رزومه رضا کریمی» / «Resume - Sara Ahmadi» → keep only the name part.
    const first = head[0].replace(/^(?:رزومه|سوابق|resume|cv|curriculum vitae)\s*[:\-–]?\s*/i, '').trim();
    if (first.length >= 3 && first.length <= 30 && /^[\u0600-\u06FF\u200C\sA-Za-z.]+$/.test(first) && !/رزومه|resume|curriculum/i.test(first)) {
      candidateName = first;
    }
  }

  const phoneMatch = digitsText.match(/(?:\+98|0098|98|0)?9\d{9}/);
  const emailMatch = digitsText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  const cityMatch = digitsText.match(/(?:ساکن|محل سکونت|شهر|location)\s*[:\-–]?\s*([\u0600-\u06FF]{2,20})/i);

  const yearsMatch = digitsText.match(/(\d{1,2})\s*(?:سال\s*(?:سابقه|تجربه)|years?\s*(?:of)?\s*experience)/i);
  const years = yearsMatch ? Math.min(40, parseInt(yearsMatch[1], 10)) : null;

  // Per-criterion scoring via keyword overlap with title tokens
  const stopWords = new Set(['و', 'در', 'با', 'به', 'های', 'سازی', 'کار', 'تجربه', 'دانش', 'تسلط', 'آشنایی', 'بر', 'از', 'این', 'آن', 'یا', 'مرتبط']);
  const criterionScores: CriterionScore[] = understanding.criteria.map((c) => {
    const tokens = c.title
      .split(/[\s،,/()]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !stopWords.has(t));
    const hits = tokens.filter((t) => lower.includes(t.toLowerCase()));
    const ratio = tokens.length ? hits.length / tokens.length : 0;
    const score = Math.round(25 + ratio * 70);
    const quote = hits.length
      ? (() => {
          const idx = lower.indexOf(hits[0].toLowerCase());
          const start = Math.max(0, text.lastIndexOf('.', idx) + 1);
          const end = text.indexOf('.', idx);
          const snippet = text.slice(start, end === -1 ? Math.min(text.length, idx + 80) : end + 1).trim();
          return snippet.slice(0, 120) || `اشاره به ${hits.slice(0, 2).join('، ')} در رزومه`;
        })()
      : 'در رزومه شاهد مشخصی برای این شاخص یافت نشد';
    return {
      criterionId: c.id,
      title: c.title,
      score,
      rationale: hits.length
        ? `اشاره به ${hits.slice(0, 3).join('، ')} در متن رزومه دیده شد.`
        : 'کلیدواژه‌ها و سوابق مرتبط با این شاخص در رزومه دیده نشد.',
      evidence: quote,
    };
  });

  const score = Math.round(
    criterionScores.reduce((s, cs) => {
      const c = understanding.criteria.find((x) => x.id === cs.criterionId);
      return s + cs.score * (c?.weight || 0);
    }, 0) / 100
  );

  const strengths: EvidencePoint[] = criterionScores
    .filter((cs) => cs.score >= 55)
    .slice(0, 4)
    .map((cs) => ({ point: `تطابق نسبی در «${cs.title}»`, evidence: cs.evidence, severity: 'minor' as const }));
  const weaknesses: EvidencePoint[] = criterionScores
    .filter((cs) => cs.score < 45)
    .slice(0, 4)
    .map((cs) => ({
      point: `شواهد کافی برای «${cs.title}» یافت نشد`,
      evidence: cs.evidence,
      severity: (understanding.criteria.find((x) => x.id === cs.criterionId)?.mustHave ? 'knockout' : 'minor') as 'knockout' | 'minor',
    }));

  const missingMust = criterionScores.some((cs) => {
    const c = understanding.criteria.find((x) => x.id === cs.criterionId);
    return c?.mustHave && cs.score < 35;
  });
  const finalScore = missingMust ? Math.min(score, 45) : Math.max(20, Math.min(score, 90));

  let recommendation: Recommendation = 'REJECT';
  if (finalScore >= understanding.thresholds.interview) recommendation = 'INTERVIEW';
  else if (finalScore >= understanding.thresholds.review) recommendation = 'REVIEW';

  const insufficient = text.trim().length < 80;
  return {
    candidateName,
    contact: {
      phone: phoneMatch ? phoneMatch[0] : null,
      email: emailMatch ? emailMatch[0] : null,
      city: cityMatch ? cityMatch[1] : null,
    },
    facts: {
      yearsExperience: years,
      education: text.match(/(کارشناسی\s*ارشد|کارشناسی|کاردانی|دکتری|دیپلم)[\s\u0600-\u06FF]{0,25}/)?.[0]?.trim() || null,
      lastRole: head.find((l) => /(کارشناس|مهندس|مدیر|سرپرست|فروشنده|اپراتور|حسابدار|تکنسین|توسعه‌دهنده|برنامه‌نویس)/.test(l)) || null,
      skills: [],
      expectedSalary: null,
    },
    criterionScores,
    score: finalScore,
    confidence: 'low',
    engine: 'local',
    recommendation,
    summary: `این ارزیابی با موتور محلی (تطبیق کلیدواژه‌ای، نه هوش مصنوعی) انجام شده است؛ امتیاز ${finalScore} فقط بر اساس حضور کلیدواژه‌های شاخص‌ها در متن رزومه است و دقت کمتری دارد.`,
    whyCategory:
      recommendation === 'INTERVIEW'
        ? 'تطابق کلیدواژه‌ای خوبی با شاخص‌های شغل دیده شد (تحلیل محلی).'
        : recommendation === 'REVIEW'
        ? 'تطابق نسبی با شاخص‌ها دیده شد و بررسی انسانی لازم است (تحلیل محلی).'
        : 'شواهد کافی برای تطابق با شاخص‌های شغل در متن پیدا نشد (تحلیل محلی).',
    strengths,
    weaknesses,
    knockoutMisses: weaknesses.filter((w) => w.severity === 'knockout').map((w) => w.point),
    tags: [],
    bankSuggested: false,
    flags: { irrelevant: false, insufficientInfo: insufficient, scannedNoText: false },
  };
}

// ================================================================
// PASS 2 — Relative calibration (top 15 + borderline ±5)
// ================================================================

export async function calibrate(
  understanding: JobUnderstanding,
  candidates: Array<{ id: string; name: string; score: number; summary: string }>
): Promise<Record<string, number>> {
  if (candidates.length <= 1) return {};
  const prompt = `تو مسئول کالیبراسیون نهایی امتیازهای غربالگری هستی تا عدالت نسبی بین کاندیداها برقرار شود.
آستانه تطابق بالا: ${understanding.thresholds.interview}، آستانه بررسی: ${understanding.thresholds.review}.
کاندیداها:
${JSON.stringify(candidates.slice(0, 40), null, 2)}

برای هر فرد امتیاز تعدیل‌شده (۰ تا ۱۰۰) را بده؛ حداکثر تغییر مثبت یا منفی ۱۰ امتیاز؛ اگر امتیاز منصفانه است همان را برگردان.
فقط JSON: { "adjustments": { "id1": 82, "id2": 71 } }`;

  try {
    const raw = await generate(prompt, { temperature: 0.1, timeoutMs: 20_000, deadlineMs: 40_000 });
    const parsed = cleanAndParseJson<{ adjustments: Record<string, number> }>(raw, { adjustments: {} });
    const out: Record<string, number> = {};
    for (const [id, val] of Object.entries(parsed.adjustments || {})) {
      const orig = candidates.find((c) => c.id === id);
      if (!orig) continue;
      let n = Math.round(Number(val));
      if (!Number.isFinite(n)) continue;
      n = Math.max(0, Math.min(100, Math.max(orig.score - 10, Math.min(orig.score + 10, n))));
      out[id] = n;
    }
    return out;
  } catch {
    console.log('[calibrate] skipped (AI unavailable), keeping original scores.');
    return {};
  }
}

// ================================================================
// Message drafts
// ================================================================

export const KIND_TITLES: Record<MessageKind, string> = {
  INTERVIEW_INVITE: 'دعوت به مصاحبه',
  INFO_REQUEST: 'درخواست تکمیل اطلاعات',
  BANK_NOTICE: 'نگهداری رزومه در بانک استعداد',
  REJECTION: 'اعلام نتیجه (عدم ادامه فرایند)',
};

export async function draftMessage(
  record: Pick<ResumeRecord, 'candidateName' | 'facts' | 'departmentName' | 'roleTitle' | 'strengths'>,
  kind: MessageKind,
  org: { name: string; messageSignature: string }
): Promise<DraftMessage> {
  const name = record.candidateName || '[نام کاندید]';
  const role = record.roleTitle || record.departmentName;
  const signature = (org.messageSignature || `با احترام\nواحد منابع انسانی ${org.name}`).trim();

  const fallback = (): DraftMessage => {
    const templates: Record<MessageKind, { subject: string; body: string }> = {
      INTERVIEW_INVITE: {
        subject: `دعوت به مصاحبه — ${org.name}`,
        body:
          `سلام ${name} عزیز،\n\n` +
          `از اینکه رزومه خود را برای موقعیت «${role}» در ${org.name} ارسال کردید سپاسگزاریم. سوابق شما با نیازهای این موقعیت هم‌خوانی خوبی دارد و خوشحال می‌شویم برای یک گفت‌وگوی آشنایی هماهنگ کنیم.\n\n` +
          `زمان پیشنهادی: [زمان]\nمکان یا لینک جلسه: [مکان / لینک]\n\nلطفاً آمادگی خود را اعلام بفرمایید.\n\n${signature}`,
      },
      INFO_REQUEST: {
        subject: `درخواست تکمیل اطلاعات — ${org.name}`,
        body:
          `سلام ${name} عزیز،\n\n` +
          `رزومه شما برای موقعیت «${role}» در حال بررسی است. برای تکمیل ارزیابی، لطفاً موارد زیر را برای ما ارسال کنید:\n` +
          `۱. [مورد موردنیاز ۱]\n۲. [مورد موردنیاز ۲]\n\nاز همکاری شما سپاسگزاریم.\n\n${signature}`,
      },
      BANK_NOTICE: {
        subject: `رزومه شما در بانک استعداد ${org.name} نگهداری می‌شود`,
        body:
          `سلام ${name} عزیز،\n\n` +
          `از علاقه شما به همکاری با ${org.name} سپاسگزاریم. رزومه شما در بانک استعداد ما نگهداری می‌شود و با باز شدن موقعیت متناسب در واحد ${record.departmentName}، با شما تماس خواهیم گرفت.\n\n${signature}`,
      },
      REJECTION: {
        subject: `نتیجه بررسی رزومه — ${org.name}`,
        body:
          `سلام ${name} عزیز،\n\n` +
          `از وقتی که برای ارسال رزومه به موقعیت «${role}» گذاشتید صمیمانه سپاسگزاریم. پس از بررسی دقیق، در این مرحله امکان ادامه فرایند فراهم نیست. این تصمیم بر اساس نیازهای فعلی همین موقعیت گرفته شده و از ارزش توانمندی‌های شما نمی‌کاهد.\n\n` +
          `برایتان آرزوی موفقیت داریم.\n\n${signature}`,
      },
    };
    return { kind, ...templates[kind], engine: 'local' };
  };

  const prompt = `تو در واحد منابع انسانی سازمان «${org.name}» کار می‌کنی و می‌خواهی برای یک کاندید پیام کوتاه و مؤدبانه فارسی بنویسی.
نوع پیام: ${KIND_TITLES[kind]}
نام کاندید: ${name}
موقعیت شغلی: ${role}
دپارتمان: ${record.departmentName}
آخرین سمت: ${record.facts?.lastRole || '—'}
نقاط قوت استخراج‌شده: ${record.strengths.slice(0, 2).map((s) => s.point).join('؛ ') || '—'}

قواعد:
- لحن گرم، حرفه‌ای و کوتاه (۴ تا ۷ خط) با خطاب «شما»؛ خطاب با نام کاندید.
- در دعوت به مصاحبه به یک نقطه قوت واقعی اشاره کن و جای [زمان] و [مکان / لینک] را خالی بگذار.
- در درخواست تکمیل اطلاعات دو جای خالی شماره‌دار برای موارد موردنیاز بگذار.
- در پیام عدم ادامه فرایند، محترمانه، کوتاه و بدون ذکر دلیل فنی بنویس.
- هیچ عدد امتیاز، درصد تطابق یا اصطلاح فنی در متن نباشد.
- متن را دقیقاً با این امضا تمام کن:
${signature}
- خروجی فقط JSON: { "subject": "موضوع کوتاه", "body": "متن کامل با \\n برای خط جدید" }`;

  try {
    const raw = await generate(prompt, { temperature: 0.4, timeoutMs: 15_000, deadlineMs: 25_000 });
    const parsed = cleanAndParseJson<{ subject?: string; body?: string }>(raw, {});
    if (parsed.body && parsed.body.trim().length > 30) {
      let body = parsed.body.trim();
      const firstSigLine = signature.split('\n').pop() || signature;
      if (!body.includes(firstSigLine)) body = `${body}\n\n${signature}`;
      return { kind, subject: parsed.subject?.trim() || KIND_TITLES[kind], body, engine: 'ai' };
    }
    return fallback();
  } catch {
    return fallback();
  }
}

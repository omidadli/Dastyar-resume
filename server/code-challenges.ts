/**
 * The built-in challenge bank.
 *
 * Deliberately small and deliberate: three tasks that are close to the actual
 * work of the two roles we see most (support/data, and front-end/back-end), each
 * with visible examples that fully explain the task and a handful of hidden
 * cases that only stop hard-coding.
 *
 * No trick questions, no algorithm puzzles under time pressure, no leetcode
 * trivia. A senior engineer should finish each in ten minutes; a junior should be
 * able to make real progress.
 */
import type { CodeChallenge, CodeChallengeSummary } from '../src/types/coding';

const CHALLENGES: CodeChallenge[] = [
  {
    id: 'normalize-phones',
    title: 'یکسان‌سازی شمارهٔ تلفن',
    prompt:
      'در فایل ورودی، شماره‌ها به شکل‌های مختلف نوشته می‌شوند: «09121234567»، «+98 912 123 4567»، «۰۹۱۲-۱۲۳-۴۵۶۷» و حتی با فاصله‌های اضافه. تابعی بنویسید که هر شماره را به شکل یکسان «09XXXXXXXXX» برگرداند (۱۱ رقم، بدون فاصله و خط تیره). اگر بعد از پاک‌سازی شماره معتبر نباشد، null برگردانید.',
    signature: 'solution(input) → string | null',
    starterCode: `function solution(input) {
  // ورودی: رشته‌ای که ممکن است شمارهٔ موبایل ایران باشد
  // خروجی: «09XXXXXXXXX» یا null
  return null;
}`,
    difficulty: 'easy',
    minutes: 10,
    language: 'javascript',
    tests: [
      { name: 'شمارهٔ ساده', args: ['09121234567'], expected: '09121234567' },
      { name: 'با کد کشور و فاصله', args: ['+98 912 123 4567'], expected: '09121234567' },
      { name: 'با خط تیره', args: ['0912-123-4567'], expected: '09121234567' },
      { name: 'ارقام فارسی', args: ['۰۹۱۲۱۲۳۴۵۶۷'], expected: '09121234567' },
      { name: 'شمارهٔ نامعتبر', args: ['12345'], expected: null },
      { name: 'چیز دیگر', args: ['سلام'], expected: null },
      { name: 'پیش‌شمارهٔ ۰۰۹۸', args: ['0098 912 123 4567'], expected: '09121234567', hidden: true },
      { name: 'شمارهٔ ثابت تهران', args: ['02188776655'], expected: null, hidden: true },
      { name: 'فاصلهٔ اضافه', args: ['  0912 123 4567  '], expected: '09121234567', hidden: true },
    ],
    rubric:
      'نگاه کنید که آیا به حالت‌های کثیف واقعی (ارقام فارسی، +۹۸، ۰۰۹۸) فکر کرده یا فقط نمونه‌ها را پوشش داده. استفاده از Set برای نگاشت ارقام فارسی نشانهٔ تجربه است.',
    referenceSolution: `function solution(input) {
  if (typeof input !== 'string') return null;
  const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
  let s = input.trim().replace(/[۰-۹]/g, (d) => String(fa.indexOf(d))).replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)));
  s = s.replace(/[\\s()-]/g, '');
  if (s.startsWith('+98')) s = '0' + s.slice(3);
  else if (s.startsWith('0098')) s = '0' + s.slice(4);
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2);
  return /^09\\d{9}$/.test(s) ? s : null;
}`,
  },
  {
    id: 'group-by-department',
    title: 'گروه‌بندی رزومه‌ها بر اساس دپارتمان',
    prompt:
      'فهرستی از رزومه‌ها دارید؛ هر آیتم { name, department, score } است. تابعی بنویسید که آن‌ها را بر اساس دپارتمان گروه کند و در هر گروه، بالاترین امتیاز اول بیاید. نام دپارتمان‌ها باید بر اساس حروف الفبای لاتین مرتب باشند و آیتم‌های بدون دپارتمان در گروه «بدون دپارتمان» بیایند.',
    signature: 'solution(rows) → { [department: string]: Array<{ name, department, score }> }',
    starterCode: `function solution(rows) {
  // rows: [{ name, department, score }]
  // خروجی: شیئی که کلیدش نام دپارتمان است
  return {};
}`,
    difficulty: 'medium',
    minutes: 12,
    language: 'javascript',
    tests: [
      {
        name: 'دو دپارتمان',
        args: [
          [
            { name: 'a', department: 'Sales', score: 40 },
            { name: 'b', department: 'Sales', score: 80 },
            { name: 'c', department: 'Eng', score: 60 },
          ],
        ],
        expected: {
          Eng: [{ name: 'c', department: 'Eng', score: 60 }],
          Sales: [
            { name: 'b', department: 'Sales', score: 80 },
            { name: 'a', department: 'Sales', score: 40 },
          ],
        },
      },
      { name: 'فهرست خالی', args: [[]], expected: {} },
      {
        name: 'بدون دپارتمان',
        args: [
          [
            { name: 'x', department: '', score: 10 },
            { name: 'y', department: null, score: 5 },
          ],
        ],
        expected: { 'بدون دپارتمان': [{ name: 'x', department: '', score: 10 }, { name: 'y', department: null, score: 5 }] },
        hidden: true,
      },
      {
        name: 'امتیاز برابر',
        args: [
          [
            { name: 'first', department: 'Ops', score: 50 },
            { name: 'second', department: 'Ops', score: 50 },
          ],
        ],
        expected: { Ops: [{ name: 'first', department: 'Ops', score: 50 }, { name: 'second', department: 'Ops', score: 50 }] },
        hidden: true,
      },
    ],
    rubric:
      'ترتیب پایدار (stable) در امتیاز برابر مهم است؛ `sort` در جاوااسکریپت مدرن پایدار است. اگر شیء را با Object.fromEntries ساخته باشد یعنی با ساختار داده راحت است. گروه «بدون دپارتمان» تست نگاه به دادهٔ واقعی است.',
    referenceSolution: `function solution(rows) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = row && typeof row.department === 'string' && row.department.trim() ? row.department : 'بدون دپارتمان';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const out = {};
  for (const key of [...groups.keys()].sort()) {
    out[key] = groups.get(key).slice().sort((a, b) => (b.score || 0) - (a.score || 0));
  }
  return out;
}`,
  },
  {
    id: 'pipeline-duration',
    title: 'مدت هر مرحله در قیف استخدام',
    prompt:
      'به شما فهرستی از رویدادها می‌دهند: { candidateId, stage, at } که at یک زمان ISO است. برای هر کارجو، مدت ماندن در هر مرحله را حساب کنید (از ورود به مرحله تا رویداد بعدی همان کارجو). مرحلهٔ آخر تا «اکنون» حساب نمی‌شود و باید null باشد. خروجی: { [candidateId]: { [stage]: hours | null } } با یک رقم اعشار.',
    signature: 'solution(events) → { [candidateId]: { [stage]: number | null } }',
    starterCode: `function solution(events) {
  // events: [{ candidateId, stage, at }] با ترتیب زمانی درهم
  // خروجی: مدت هر مرحله به ساعت (یک رقم اعشار) یا null برای مرحلهٔ آخر
  return {};
}`,
    difficulty: 'hard',
    minutes: 15,
    language: 'javascript',
    tests: [
      {
        name: 'دو مرحله',
        args: [
          [
            { candidateId: 'c1', stage: 'applied', at: '2024-01-01T00:00:00Z' },
            { candidateId: 'c1', stage: 'interview', at: '2024-01-02T00:00:00Z' },
          ],
        ],
        expected: { c1: { applied: 24, interview: null } },
      },
      { name: 'بدون رویداد', args: [[]], expected: {} },
      {
        name: 'ورودی نامرتب و دو کارجو',
        args: [
          [
            { candidateId: 'c2', stage: 'offer', at: '2024-03-02T00:00:00Z' },
            { candidateId: 'c1', stage: 'applied', at: '2024-01-01T00:00:00Z' },
            { candidateId: 'c2', stage: 'interview', at: '2024-03-01T00:00:00Z' },
            { candidateId: 'c1', stage: 'interview', at: '2024-01-03T00:00:00Z' },
          ],
        ],
        expected: { c1: { applied: 48, interview: null }, c2: { interview: 24, offer: null } },
        hidden: true,
      },
      {
        name: 'کسر ساعت',
        args: [
          [
            { candidateId: 'c3', stage: 'applied', at: '2024-01-01T00:00:00Z' },
            { candidateId: 'c3', stage: 'interview', at: '2024-01-01T01:30:00Z' },
          ],
        ],
        expected: { c3: { applied: 1.5, interview: null } },
        hidden: true,
      },
    ],
    rubric:
      'این سؤال ترتیب‌دهی، گروه‌بندی و گرد کردن را با هم می‌سنجد. اگر بدون sort و با فرض ترتیب ورودی حل کرده باشد، تست پنهانِ نامرتب را رد می‌کند — همان اشتباهی که در کد واقعی هم رخ می‌دهد.',
    referenceSolution: `function solution(events) {
  const byCandidate = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.candidateId) continue;
    if (!byCandidate.has(e.candidateId)) byCandidate.set(e.candidateId, []);
    byCandidate.get(e.candidateId).push(e);
  }
  const out = {};
  for (const id of [...byCandidate.keys()].sort()) {
    const list = byCandidate.get(id).slice().sort((a, b) => new Date(a.at) - new Date(b.at));
    const stages = {};
    for (let i = 0; i < list.length; i++) {
      if (i === list.length - 1) stages[list[i].stage] = null;
      else {
        const hours = (new Date(list[i + 1].at) - new Date(list[i].at)) / 36e5;
        stages[list[i].stage] = Math.round(hours * 10) / 10;
      }
    }
    out[id] = stages;
  }
  return out;
}`,
  },
];

export const CHALLENGE_BANK: CodeChallenge[] = CHALLENGES;

export function findChallenge(id: string): CodeChallenge | null {
  return CHALLENGES.find((c) => c.id === id) || null;
}

export function challengeSummaries(): CodeChallengeSummary[] {
  return CHALLENGES.map((c) => ({
    id: c.id,
    title: c.title,
    difficulty: c.difficulty,
    minutes: c.minutes,
    language: c.language,
    signature: c.signature,
    testCount: c.tests.length,
    visibleCount: c.tests.filter((t) => !t.hidden).length,
    rubric: c.rubric,
  }));
}

/** 0–100, weighted by cases; a hidden case counts exactly like a visible one. */
export function scoreOf(passed: number, total: number): number | null {
  if (!total) return null;
  return Math.round((passed / total) * 100);
}

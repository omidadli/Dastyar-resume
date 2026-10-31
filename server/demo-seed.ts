/**
 * «نسخه نمایشی» — builds a fresh, self-expiring demo workspace.
 *
 * Every click on the demo button gets its own isolated organization (so two
 * visitors never see each other's changes), populated with five job openings,
 * thirty fictional candidates, teammates, human decisions, talent-pool entries
 * and a backdated activity feed. It works without any AI key. Demo workspaces
 * are deleted automatically after DEMO_TTL (see db.purgeExpired).
 *
 * All people, numbers and companies below are fictional.
 */
import crypto from 'crypto';
import * as db from './db';
import { hashPassword, DEMO_TTL_MS } from './auth';
import { buildTemplateUnderstanding } from './ai/screening';
import type { CandidateEvaluation, DecisionStatus, Recommendation, ResumeRecord } from '../src/types/screening';
import type { Department } from '../src/types/app';
import type { CostKind } from '../src/types/reports';
import { scoreAnswers } from './assessments';
import { templateById } from './assessment-bank';
import type { InterviewFeedback } from '../src/types/pipeline';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';

// ---------------------------------------------------------------------------
// A tiny, dependency-free PDF writer (single page, Helvetica, ASCII text).
// ---------------------------------------------------------------------------

function pdfEscape(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

export function makeSamplePdf(title: string, lines: string[]): string {
  const parts: string[] = ['BT', '/F1 18 Tf', '60 790 Td', `(${pdfEscape(title)}) Tj`, 'ET'];
  let y = 758;
  for (const line of lines) {
    if (y < 60) break;
    parts.push('BT', '/F1 11 Tf', `60 ${y} Td`, `(${pdfEscape(line)}) Tj`, 'ET');
    y -= 19;
  }
  const stream = parts.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

// ---------------------------------------------------------------------------
// Fictional data
// ---------------------------------------------------------------------------

type Who = 'you' | 'maryam' | 'hossein';
type Sev = 'knockout' | 'major' | 'minor';

interface DemoCandidate {
  name: string | null;
  file: string;
  role: string;
  years: number | null;
  edu: string;
  city: string;
  phone: string;
  email: string | null;
  skills: string[];
  salary: string | null;
  score: number;
  rec: Recommendation;
  summary: string;
  why: string;
  s: [string, string][];
  w: [string, string, Sev][];
  tags: string[];
  decision?: DecisionStatus;
  by?: Who;
  note?: string;
  /** Days before "now" the decision was made. */
  decidedAgo?: number;
  bank?: { dept: string; note: string };
  msg?: boolean;
  /** Approved and moved to «استخدام‌شده» — makes time-to-hire and cost-per-hire real. */
  hired?: boolean;
  deep?: boolean;
  local?: boolean;
  unjudgeable?: string;
  pdf?: string[];
}

interface DemoJob {
  deptId: string;
  title: string;
  location: string;
  type: 'full-time' | 'part-time' | 'contract' | 'remote' | 'hybrid' | 'internship';
  notes: string;
  createdAgo: number;
  by: Who;
  status: 'open' | 'paused' | 'closed';
  source: 'ai' | 'template';
  candidates: DemoCandidate[];
}

const NONE = 'در رزومه به این مورد اشاره نشده';

const JOBS: DemoJob[] = [
  {
    deptId: 'hr',
    title: 'کارشناس جذب و استخدام',
    location: 'تهران',
    type: 'full-time',
    notes: 'جذب نیروهای ستادی و کارخانه؛ همکاری نزدیک با مدیران واحدها و مدیریت سامانه جذب.',
    createdAgo: 38,
    by: 'maryam',
    status: 'open',
    source: 'ai',
    candidates: [
      {
        name: 'سارا محمدی', file: 'sara-mohammadi-resume.pdf', role: 'کارشناس ارشد جذب و استخدام', years: 6,
        edu: 'کارشناسی ارشد مدیریت منابع انسانی — دانشگاه تهران', city: 'تهران', phone: '09121234567', email: 'sara.mohammadi@example.com',
        skills: ['مصاحبه شایستگی‌محور', 'ATS', 'کارگزینی', 'قانون کار', 'برند کارفرمایی', 'اکسل'], salary: '۴۵ میلیون تومان',
        score: 88, rec: 'INTERVIEW',
        summary: 'شش سال سابقه پیوسته جذب و استخدام در دو شرکت تولیدی، با نمونه‌های عددی از کاهش زمان استخدام و تسلط بر مصاحبه شایستگی‌محور و سامانه‌های جذب.',
        why: 'هم سابقه تخصصی جذب دارد و هم با محیط تولیدی آشناست؛ تطابق بالایی با این موقعیت دارد.',
        s: [
          ['سابقه تخصصی جذب در محیط صنعتی', '«۴ سال فعالیت در واحد جذب هلدینگ تولیدی با میانگین ۳۵ استخدام در ماه»'],
          ['نتایج عددی و قابل راستی‌آزمایی', '«کاهش میانگین زمان استخدام از ۴۲ به ۲۶ روز در سال ۱۴۰۲»'],
          ['تسلط بر ابزارهای تخصصی', '«پیاده‌سازی و مدیریت سامانه ATS برای ۳ شعبه»'],
        ],
        w: [['فاصله زمانی کوتاه بین دو شغل آخر', '«از اسفند ۱۴۰۱ تا خرداد ۱۴۰۲ سابقه‌ای ذکر نشده است»', 'minor']],
        tags: ['جذب و استخدام', 'ATS', 'منابع انسانی', 'ارشد'],
        decision: 'approved', by: 'maryam', decidedAgo: 1, bank: { dept: 'hr', note: 'گزینه قوی برای نقش‌های ارشد جذب' }, msg: true, deep: true,
        pdf: [
          'SARA MOHAMMADI - Senior Talent Acquisition Specialist', 'Tehran | 09121234567 | sara.mohammadi@example.com', '',
          'EXPERIENCE', 'Senior Recruitment Specialist - Manufacturing Holding (1401 - present)',
          '  - 35 hires per month on average across plant and HQ roles', '  - Reduced average time-to-hire from 42 to 26 days in 1402',
          '  - Owner of the ATS rollout for 3 sites', 'Recruitment Expert - Food Industries Co. (1398 - 1401)',
          '  - Competency-based interviewing for 12 job families', '', 'EDUCATION', 'M.Sc. Human Resource Management - University of Tehran',
          '', 'SKILLS', 'Competency interviewing, ATS, labor law, personnel affairs, Excel',
        ],
      },
      {
        name: 'امیر رضایی', file: 'amir-rezaei-resume.pdf', role: 'کارشناس منابع انسانی', years: 4,
        edu: 'کارشناسی مدیریت صنعتی', city: 'کرج', phone: '09351112233', email: 'amir.rezaei@example.com',
        skills: ['کارگزینی', 'بیمه و مالیات حقوق', 'جذب', 'اکسل پیشرفته'], salary: null, score: 81, rec: 'INTERVIEW',
        summary: 'چهار سال سابقه کارگزینی و امور اداری با تجربه مشخص در فرایند جذب؛ حقوق درخواستی را ذکر نکرده است.',
        why: 'سابقه کارگزینی قوی است و بخشی از کار جذب را هم انجام داده است.',
        s: [
          ['تسلط بر امور کارگزینی و بیمه', '«ارسال ماهانه لیست بیمه ۱۸۰ نفره و رسیدگی به پرونده‌های بازرسی»'],
          ['تجربه جذب در مقیاس متوسط', '«همکاری در جذب ۶۰ نیروی خط تولید در دو فصل»'],
        ],
        w: [['سابقه مستقل در مصاحبه شایستگی‌محور دیده نمی‌شود', NONE, 'major']],
        tags: ['کارگزینی', 'بیمه', 'جذب', 'کارشناس'],
        pdf: [
          'AMIR REZAEI - Human Resources Expert', 'Karaj | 09351112233 | amir.rezaei@example.com', '', 'EXPERIENCE',
          'HR Expert - Polymer Parts Co. (1400 - present)', '  - Monthly social security list for 180 employees',
          '  - Supported 60 production hires across two seasons', '', 'EDUCATION', 'B.Sc. Industrial Management',
        ],
      },
      {
        name: 'نگار کریمی', file: 'negar-karimi-resume.pdf', role: 'سرپرست جذب و استخدام', years: 8,
        edu: 'کارشناسی ارشد روان‌شناسی سازمانی', city: 'تهران', phone: '09127654321', email: 'negar.karimi@example.com',
        skills: ['کانون ارزیابی', 'مصاحبه', 'جانشین‌پروری', 'ATS'], salary: '۷۰ میلیون تومان', score: 74, rec: 'REVIEW',
        summary: 'تخصص و سابقه بسیار خوبی دارد اما حقوق درخواستی حدود ۵۵٪ بالاتر از بازه این موقعیت است و سطح نقش فعلی از این شغل بالاتر است.',
        why: 'از نظر توانمندی مناسب است، ولی بودجه و سطح نقش با این موقعیت هم‌خوان نیست.',
        s: [
          ['سابقه سرپرستی تیم جذب', '«سرپرستی تیم ۶ نفره جذب در هلدینگ دارویی»'],
          ['تخصص در کانون ارزیابی', '«طراحی و اجرای کانون ارزیابی برای ۴۰ مدیر میانی»'],
        ],
        w: [
          ['حقوق درخواستی بالاتر از بودجه', '«حقوق درخواستی: ۷۰ میلیون تومان»', 'major'],
          ['احتمال بیش‌صلاحیتی برای نقش کارشناسی', '«سمت فعلی: سرپرست جذب و استخدام»', 'minor'],
        ],
        tags: ['جذب و استخدام', 'کانون ارزیابی', 'سرپرست'],
        decision: 'rejected', by: 'maryam', decidedAgo: 4, note: 'حقوق درخواستی بالاتر از بودجه — برای فرصت‌های آینده نگه داشته شد',
        bank: { dept: 'hr', note: 'برای موقعیت سرپرستی جذب در آینده' },
        pdf: [
          'NEGAR KARIMI - Recruitment Supervisor', 'Tehran | 09127654321 | negar.karimi@example.com', '', 'EXPERIENCE',
          'Recruitment Supervisor - Pharmaceutical Holding (1399 - present)', '  - Leading a 6-person talent acquisition team',
          '  - Assessment centers for 40 middle managers', '', 'EXPECTED SALARY', '70,000,000 per month (net)',
        ],
      },
      {
        name: 'محمد حسینی', file: 'mohammad-hosseini-resume.pdf', role: 'کارشناس آموزش و توسعه', years: 3,
        edu: 'کارشناسی علوم تربیتی', city: 'قم', phone: '09193334455', email: null,
        skills: ['آموزش', 'نیازسنجی آموزشی', 'جذب (پاره‌وقت)'], salary: '۳۰ میلیون تومان', score: 62, rec: 'REVIEW',
        summary: 'سابقه عمدتاً در آموزش و توسعه است و فقط بخشی از فعالیت‌ها به جذب مربوط می‌شود؛ برای نقش جذب تخصصی نیاز به بررسی بیشتر دارد.',
        why: 'نزدیک به نیمی از سابقه به آموزش مربوط است نه جذب.',
        s: [['تجربه نیازسنجی و اجرای دوره', '«نیازسنجی و اجرای ۴۸ دوره آموزشی در سال ۱۴۰۳»']],
        w: [['سابقه جذب محدود است', '«همکاری پاره‌وقت در فرایند جذب»', 'major'], ['ایمیل در رزومه ذکر نشده', NONE, 'minor']],
        tags: ['آموزش', 'توسعه', 'منابع انسانی'],
        decision: 'review', by: 'hossein', decidedAgo: 9, note: 'در مصاحبه تلفنی، میزان تجربه جذب سنجیده شود',
        pdf: [
          'MOHAMMAD HOSSEINI - Training and Development Expert', 'Qom | 09193334455', '', 'EXPERIENCE',
          'Training Expert - Industrial Group (1401 - present)', '  - 48 training courses delivered in 1403',
          '  - Part-time cooperation in the recruitment process',
        ],
      },
      {
        name: 'زهرا عباسی', file: 'zahra-abbasi-resume.txt', role: 'کارشناس اداری', years: 2,
        edu: 'کارشناسی مدیریت بازرگانی', city: 'تهران', phone: '09012223344', email: 'zahra.abbasi@example.com',
        skills: ['امور اداری', 'بایگانی', 'هماهنگی مصاحبه'], salary: null, score: 55, rec: 'REVIEW',
        summary: 'دو سال سابقه امور اداری با تجربه هماهنگی مصاحبه؛ سابقه تخصصی جذب ندارد ولی برای رشد در همین واحد پتانسیل دارد.',
        why: 'رزومه کوتاه و کم‌جزئیات است؛ برای قضاوت قطعی شاهد کافی نیست.',
        s: [['آشنایی با هماهنگی فرایند مصاحبه', '«هماهنگی ۱۲۰ مصاحبه حضوری و آنلاین در سال گذشته»']],
        w: [['سابقه تخصصی جذب ندارد', NONE, 'major'], ['جزئیات دستاوردها ذکر نشده', NONE, 'minor']],
        tags: ['امور اداری', 'قابل رشد'],
      },
      {
        name: 'رضا نوری', file: 'reza-nouri-resume.pdf', role: 'کارشناس جذب (قراردادی)', years: 5,
        edu: 'کاردانی کامپیوتر', city: 'اصفهان', phone: '09131239876', email: 'reza.nouri@example.com',
        skills: ['منبع‌یابی', 'لینکدین ریکروتر', 'مصاحبه تلفنی'], salary: '۳۸ میلیون تومان', score: 68, rec: 'REVIEW',
        summary: 'پنج سال سابقه منبع‌یابی و جذب، بیشتر به‌صورت قرارداد پروژه‌ای و در صنعت خدمات؛ پایداری شغلی نیاز به بررسی دارد.',
        why: 'مهارت منبع‌یابی خوبی دارد ولی جابه‌جایی‌های پرتکرار جای بررسی دارد.',
        s: [['منبع‌یابی فعال و شبکه‌سازی', '«شناسایی ۳۰۰ کاندید در ۶ ماه از طریق لینکدین»']],
        w: [['جابه‌جایی پرتکرار شغلی', '«چهار کارفرما در پنج سال اخیر»', 'major'], ['سابقه صنعت تولید ندارد', NONE, 'minor']],
        tags: ['منبع‌یابی', 'پروژه‌ای', 'جذب'],
        decision: 'approved', by: 'you', decidedAgo: 14, deep: true,
        pdf: [
          'REZA NOURI - Talent Sourcer (Contract)', 'Isfahan | 09131239876 | reza.nouri@example.com', '', 'EXPERIENCE',
          'Contract Sourcer - Services Holding (1402 - present)', '  - 300 candidates sourced in 6 months',
          'Contract Sourcer - IT Company (1401 - 1402)', 'Recruiter - Retail Chain (1400 - 1401)',
        ],
      },
      {
        name: 'مریم صادقی', file: 'maryam-sadeghi-resume.pdf', role: 'فروشنده فروشگاه', years: 1,
        edu: 'دیپلم تجربی', city: 'تهران', phone: '09199887766', email: null, skills: ['فروش حضوری'], salary: '۲۰ میلیون تومان',
        score: 28, rec: 'REJECT',
        summary: 'سابقه کاری با منابع انسانی مرتبط نیست و شاهدی درباره فرایندهای جذب، کارگزینی یا قانون کار در رزومه دیده نمی‌شود.',
        why: 'سابقه فقط در فروش حضوری است و با این شغل تطابق ندارد.',
        s: [],
        w: [['عدم تطابق حوزه سابقه با شغل', '«یک سال فروشندگی در فروشگاه پوشاک»', 'knockout'], ['نبود مهارت‌های تخصصی موردنیاز', NONE, 'major']],
        tags: ['نامرتبط'],
        decision: 'rejected', by: 'hossein', decidedAgo: 21, note: 'عدم تطابق سابقه با شغل',
        pdf: ['MARYAM SADEGHI', 'Tehran | 09199887766', '', 'EXPERIENCE', 'Shop Assistant - Clothing Store (1403 - present)'],
      },
      {
        name: 'علی موسوی', file: 'ali-mousavi-resume.txt', role: 'کارآموز منابع انسانی', years: 1,
        edu: 'کارشناسی مدیریت دولتی', city: 'رشت', phone: '09111223344', email: 'ali.mousavi@example.com',
        skills: ['اکسل', 'بایگانی'], salary: null, score: 44, rec: 'REJECT',
        summary: 'فقط یک دوره کارآموزی کوتاه در منابع انسانی دارد و شاهد کافی برای نقش کارشناس مستقل وجود ندارد.',
        why: 'سابقه در حد کارآموزی است و برای این موقعیت کافی نیست.',
        s: [['آشنایی اولیه با فرایندهای اداری', '«دوره کارآموزی ۳ ماهه در واحد اداری»']],
        w: [['سابقه مستقل ندارد', '«کارآموز منابع انسانی — ۳ ماه»', 'knockout']],
        tags: ['کارآموز', 'جوان'],
      },
    ],
  },
  {
    deptId: 'sales',
    title: 'کارشناس فروش حضوری',
    location: 'تهران',
    type: 'full-time',
    notes: 'ویزیت روزانه فروشگاه‌های منطقه، ثبت سفارش و پیگیری وصول مطالبات.',
    createdAgo: 24,
    by: 'hossein',
    status: 'open',
    source: 'ai',
    candidates: [
      {
        name: 'پویا شریفی', file: 'pouya-sharifi-cv.txt', role: 'کارشناس فروش میدانی', years: 5, edu: 'کارشناسی مدیریت بازرگانی',
        city: 'تهران', phone: '09124445566', email: 'pouya.sharifi@example.com',
        skills: ['فروش حضوری', 'مذاکره', 'CRM', 'مسیربندی ویزیت', 'اکسل'], salary: '۳۵ میلیون تومان', score: 86, rec: 'INTERVIEW',
        summary: 'پنج سال سابقه فروش میدانی در شرکت پخش مواد غذایی با تحقق مستمر تارگت و تجربه کار با نرم‌افزار سفارش‌گیری.',
        why: 'سابقه فروش میدانی و نتایج عددی روشن دارد و با نیاز این موقعیت هم‌خوان است.',
        s: [
          ['تحقق مستمر تارگت فروش', '«تحقق ۱۱۰٪ تارگت فصلی در ۶ فصل متوالی»'],
          ['تجربه پخش در صنعت غذایی', '«ویزیت روزانه ۳۵ فروشگاه در منطقه ۵ تهران»'],
          ['کار با ابزار سفارش‌گیری', '«ثبت سفارش با تبلت و نرم‌افزار ویزیتور»'],
        ],
        w: [['سابقه مدیریت تیم ندارد', NONE, 'minor']],
        tags: ['فروش میدانی', 'پخش', 'تارگت', 'کارشناس'],
        decision: 'approved', by: 'maryam', decidedAgo: 3, msg: true,
      },
      {
        name: 'الهام رستمی', file: 'elham-rostami.txt', role: 'نماینده فروش سازمانی', years: 3, edu: 'کارشناسی مهندسی صنایع',
        city: 'کرج', phone: '09365557788', email: 'elham.rostami@example.com',
        skills: ['فروش B2B', 'مذاکره', 'پیگیری مطالبات', 'اکسل'], salary: null, score: 79, rec: 'INTERVIEW',
        summary: 'سه سال فروش سازمانی به فروشگاه‌های زنجیره‌ای با تجربه پیگیری مطالبات؛ آمادگی تردد شهری را اعلام کرده است.',
        why: 'تجربه فروش و مذاکره کافی دارد؛ سابقه میدانی کوتاه‌تر از بهترین کاندید است.',
        s: [
          ['مذاکره با فروشگاه‌های زنجیره‌ای', '«عقد قرارداد با ۴ فروشگاه زنجیره‌ای منطقه‌ای»'],
          ['پیگیری مطالبات', '«کاهش مطالبات معوق مشتریان به زیر ۴۵ روز»'],
        ],
        w: [['تجربه پخش مویرگی محدود', '«بیشتر فروش سازمانی و قراردادی»', 'minor']],
        tags: ['فروش سازمانی', 'مذاکره', 'B2B'],
      },
      {
        name: 'سعید جعفری', file: 'saeed-jafari-resume.txt', role: 'کارشناس فروش', years: 4, edu: 'کارشناسی مدیریت',
        city: 'تهران', phone: '09128889900', email: 'saeed.jafari@example.com',
        skills: ['فروش حضوری', 'چیدمان فروشگاهی', 'اکسل'], salary: '۳۲ میلیون تومان', score: 77, rec: 'INTERVIEW',
        summary: 'چهار سال فروش حضوری محصولات آرایشی‌بهداشتی به همراه چیدمان فروشگاهی؛ نتایج فروش با عدد ذکر شده است.',
        why: 'سابقه فروش حضوری دارد و نتایجش قابل راستی‌آزمایی است.',
        s: [
          ['نتایج فروش قابل سنجش', '«رشد ۲۵ درصدی فروش منطقه در سال ۱۴۰۳»'],
          ['چیدمان فروشگاهی', '«مسئول چیدمان قفسه در ۲۰ فروشگاه»'],
        ],
        w: [['دو جابه‌جایی شغلی در دو سال اخیر', '«۱۴۰۲ تا ۱۴۰۳: دو کارفرما»', 'minor']],
        tags: ['فروش حضوری', 'چیدمان', 'آرایشی‌بهداشتی'],
      },
      {
        // Same person, same department, sent again a week later with a new file:
        // the demo shows «تکراری» and points back to the first screening.
        name: 'سعید جعفری', file: 'saeed-jafari-cv-1404.pdf', role: 'کارشناس فروش', years: 4, edu: 'کارشناسی مدیریت',
        city: 'تهران', phone: '۰۹۱۲۸۸۸۹۹۰۰', email: 'saeed.jafari@example.com',
        skills: ['فروش حضوری', 'چیدمان فروشگاهی', 'اکسل'], salary: '۳۴ میلیون تومان', score: 75, rec: 'REVIEW',
        summary: 'نسخهٔ به‌روزشدهٔ همان رزومهٔ قبلی است (حقوق درخواستی تغییر کرده) و برای همین دپارتمان دوباره ارسال شده؛ کاندید تازه‌ای نیست.',
        why: 'سابقه و مهارت‌ها همان رزومهٔ ثبت‌شده در غربالگری قبلی این دپارتمان است.',
        s: [['سابقه فروش حضوری', '«چهار سال فروش حضوری»']],
        w: [['تکرار درخواست برای همین دپارتمان', '«همین رزومه پیش‌تر ثبت شده بود»', 'minor']],
        tags: ['فروش حضوری', 'تکراری'],
      },
      {
        name: 'مهدی قربانی', file: 'mahdi-ghorbani.txt', role: 'ویزیتور', years: 7, edu: 'دیپلم بازرگانی',
        city: 'اصفهان', phone: '09131112244', email: null, skills: ['ویزیت', 'پخش مویرگی', 'مسیربندی'], salary: '۳۰ میلیون تومان',
        score: 72, rec: 'REVIEW',
        summary: 'هفت سال ویزیتوری در شرکت‌های پخش؛ سابقه طولانی و پایدار، اما شواهدی از کار با ابزارهای دیجیتال یا گزارش فروش دیده نمی‌شود.',
        why: 'سابقه میدانی طولانی دارد ولی محل سکونت و مهارت گزارش‌دهی جای بررسی دارد.',
        s: [['سابقه طولانی و پایدار', '«۷ سال همکاری با دو شرکت پخش»']],
        w: [['ساکن شهر دیگر است', '«ساکن اصفهان»', 'major'], ['مهارت گزارش‌دهی دیده نمی‌شود', NONE, 'minor']],
        tags: ['ویزیتور', 'پخش مویرگی', 'باتجربه'],
        decision: 'review', by: 'you', decidedAgo: 2, note: 'امکان جابه‌جایی به تهران پرسیده شود',
      },
      {
        name: 'نرگس یزدانی', file: 'narges-yazdani.txt', role: 'کارشناس فروش تلفنی', years: 2, edu: 'کارشناسی روان‌شناسی',
        city: 'تهران', phone: '09103334466', email: 'narges.yazdani@example.com', skills: ['فروش تلفنی', 'CRM', 'پاسخ‌گویی به مشتری'],
        salary: '۲۵ میلیون تومان', score: 44, rec: 'REJECT',
        summary: 'دو سال فروش تلفنی و کار با CRM؛ سابقه فروش حضوری و میدانی، که از شرط‌های اصلی این موقعیت است، دیده نمی‌شود.',
        why: 'مهارت ارتباطی خوبی دارد اما شرط اصلی این موقعیت را ندارد.',
        s: [['کار با CRM', '«ثبت و پیگیری ۸۰ تماس روزانه در CRM»']],
        w: [['سابقه فروش حضوری ندارد', NONE, 'knockout']],
        tags: ['فروش تلفنی', 'CRM', 'ارتباط با مشتری'],
        bank: { dept: 'support', note: 'برای مرکز تماس و خدمات مشتریان مناسب است' },
      },
      {
        name: 'آرش کاظمی', file: 'arash-kazemi.txt', role: 'راننده پخش', years: 6, edu: 'دیپلم', city: 'تهران',
        phone: '09125556677', email: null, skills: ['رانندگی پایه دو', 'تحویل کالا'], salary: null, score: 31, rec: 'REJECT',
        summary: 'سابقه در رانندگی و تحویل کالا است و فعالیت فروش یا مذاکره با مشتری در رزومه دیده نمی‌شود.',
        why: 'سابقه پخش دارد اما در نقش فروش نبوده است.',
        s: [],
        w: [['سابقه فروش ندارد', '«راننده پخش و تحویل‌دار کالا»', 'knockout']],
        tags: ['پخش', 'رانندگی'],
        decision: 'rejected', by: 'hossein', decidedAgo: 5, note: 'عدم تطابق سابقه با نقش فروش',
        bank: { dept: 'logistics', note: 'برای فرصت‌های لجستیک و توزیع' },
      },
      {
        name: null, file: 'scan_20240611.jpg', role: '', years: null, edu: '', city: '', phone: '', email: null, skills: [],
        salary: null, score: 0, rec: 'REJECT', summary: '', why: '', s: [], w: [], tags: [],
        unjudgeable: 'تصویر رزومه کم‌کیفیت است و متن آن قابل خواندن نبود؛ نسخه PDF یا تصویر واضح‌تر درخواست شود.',
      },
    ],
  },
  {
    deptId: 'finance',
    title: 'حسابدار ارشد',
    location: 'تهران',
    type: 'full-time',
    notes: 'مسئولیت بستن حساب‌ها، بهای تمام‌شده و تعامل با حسابرس؛ آشنایی با سامانه مودیان الزامی است.',
    createdAgo: 12,
    by: 'maryam',
    status: 'open',
    source: 'ai',
    candidates: [
      {
        name: 'فاطمه نجفی', file: 'fatemeh-najafi.txt', role: 'حسابدار ارشد', years: 9, edu: 'کارشناسی ارشد حسابداری',
        city: 'تهران', phone: '09122223355', email: 'f.najafi@example.com',
        skills: ['سپیدار', 'همکاران سیستم', 'بهای تمام‌شده', 'سامانه مودیان', 'صورت‌های مالی', 'اکسل پیشرفته'], salary: '۵۵ میلیون تومان',
        score: 91, rec: 'INTERVIEW',
        summary: 'نُه سال حسابداری در شرکت تولیدی با تسلط بر بهای تمام‌شده، تهیه صورت‌های مالی و کار با سامانه مودیان.',
        why: 'هم تجربه صنعتی دارد و هم نرم‌افزارهای مالی موردنیاز را می‌شناسد.',
        s: [
          ['تسلط بر حسابداری بهای تمام‌شده', '«استقرار سیستم بهای تمام‌شده استاندارد در کارخانه»'],
          ['تهیه صورت‌های مالی', '«تهیه صورت‌های مالی سالانه و پاسخ‌گویی به حسابرس»'],
          ['آشنایی با سامانه مودیان', '«راه‌اندازی صدور صورتحساب الکترونیکی در سامانه مودیان»'],
        ],
        w: [['حقوق درخواستی در سقف بازه', '«حقوق درخواستی: ۵۵ میلیون تومان»', 'minor']],
        tags: ['حسابداری صنعتی', 'سامانه مودیان', 'ارشد'],
        deep: true,
      },
      {
        name: 'بهنام فرهادی', file: 'behnam-farhadi.txt', role: 'حسابدار صنعتی', years: 6, edu: 'کارشناسی حسابداری',
        city: 'تهران', phone: '09126667788', email: 'behnam.farhadi@example.com',
        skills: ['بهای تمام‌شده', 'انبار', 'همکاران سیستم', 'اکسل'], salary: '۴۲ میلیون تومان', score: 83, rec: 'INTERVIEW',
        summary: 'شش سال حسابداری صنعتی و کنترل انبار در کارخانه قطعه‌سازی؛ شواهد روشنی از کار با همکاران سیستم دارد.',
        why: 'تجربه صنعتی و نرم‌افزاری او با این موقعیت هم‌خوان است.',
        s: [
          ['حسابداری صنعتی و انبار', '«کنترل موجودی و قیمت‌گذاری انبار مواد اولیه»'],
          ['تسلط بر همکاران سیستم', '«کاربر کلیدی ماژول مالی همکاران سیستم»'],
        ],
        w: [['تجربه مالیاتی محدود ذکر شده', NONE, 'minor']],
        tags: ['حسابداری صنعتی', 'همکاران سیستم', 'انبار'],
      },
      {
        name: 'کامران صالحی', file: 'kamran-salehi.txt', role: 'حسابدار', years: 5, edu: 'کارشناسی حسابداری', city: 'شیراز',
        phone: '09171112233', email: 'kamran.salehi@example.com', skills: ['همکاران سیستم', 'مالیات', 'بیمه', 'اکسل'],
        salary: '۳۸ میلیون تومان', score: 76, rec: 'INTERVIEW',
        summary: 'پنج سال حسابداری عمومی و مالیاتی؛ تجربه بهای تمام‌شده کمتر دیده می‌شود.',
        why: 'تجربه مالیاتی خوبی دارد؛ عمق حسابداری صنعتی باید در مصاحبه سنجیده شود.',
        s: [['تجربه مالیات و بیمه', '«تنظیم اظهارنامه‌های مالیاتی و لیست بیمه ۱۲۰ نفر»']],
        w: [['تجربه محدود در بهای تمام‌شده', NONE, 'major']],
        tags: ['حسابداری', 'مالیات', 'بیمه'],
      },
      {
        name: 'حمید رضوانی', file: 'hamid-rezvani.txt', role: 'مدیر مالی', years: 15, edu: 'کارشناسی ارشد مدیریت کسب‌وکار',
        city: 'تهران', phone: '09121119988', email: 'h.rezvani@example.com', skills: ['بودجه‌ریزی', 'مدیریت تیم', 'گزارش‌گیری مدیریتی'],
        salary: '۹۰ میلیون تومان', score: 68, rec: 'REVIEW',
        summary: 'پانزده سال سابقه مالی که شش سال آن در سمت مدیر مالی بوده است؛ سطح نقش و حقوق درخواستی بالاتر از این موقعیت است.',
        why: 'توانمند است اما احتمال بیش‌صلاحیتی و ناهم‌خوانی بودجه وجود دارد.',
        s: [['تجربه مدیریتی گسترده', '«مدیریت تیم ۷ نفره مالی»']],
        w: [['حقوق درخواستی بالاتر از بودجه', '«حقوق درخواستی: ۹۰ میلیون تومان»', 'major'], ['احتمال بیش‌صلاحیتی', '«مدیر مالی از ۱۳۹۸»', 'minor']],
        tags: ['مدیر مالی', 'بودجه', 'ارشد'],
        decision: 'rejected', by: 'maryam', decidedAgo: 3, note: 'حقوق درخواستی بالاتر از بودجه',
        bank: { dept: 'finance', note: 'برای موقعیت مدیریتی مالی در آینده' },
      },
      {
        name: 'سمیرا اکبری', file: 'samira-akbari.txt', role: 'کارشناس مالی', years: 3, edu: 'کارشناسی مدیریت مالی', city: 'تهران',
        phone: '09367778899', email: 'samira.akbari@example.com', skills: ['سپیدار', 'خزانه‌داری', 'مغایرت بانکی'], salary: null,
        score: 63, rec: 'REVIEW',
        summary: 'سه سال تجربه در خزانه‌داری و مغایرت‌گیری بانکی؛ برای نقش ارشد، عمق سابقه کمتر از انتظار است.',
        why: 'پایه مالی خوبی دارد ولی برای سطح ارشد هنوز زود است.',
        s: [['تجربه خزانه‌داری', '«مغایرت‌گیری ماهانه ۸ حساب بانکی»']],
        w: [['سابقه کمتر از حد انتظار برای نقش ارشد', '«۳ سال سابقه»', 'major']],
        tags: ['خزانه‌داری', 'سپیدار', 'میانی'],
        decision: 'review', by: 'maryam', decidedAgo: 1, note: 'برای نقش کارشناس مالی هم بررسی شود',
        bank: { dept: 'finance', note: 'گزینه مناسب برای کارشناس مالی' },
      },
      {
        name: 'زینب مرادی', file: 'zeinab-moradi.txt', role: 'کمک‌حسابدار', years: 1, edu: 'کاردانی حسابداری', city: 'قم',
        phone: '09192223344', email: null, skills: ['ثبت اسناد', 'اکسل'], salary: null, score: 41, rec: 'REJECT',
        summary: 'یک سال کمک‌حسابداری؛ برای نقش حسابدار ارشد، سابقه و تسلط کافی دیده نمی‌شود.',
        why: 'برای این سطح از نقش سابقه کافی ندارد.',
        s: [['آشنایی با ثبت اسناد', '«ثبت روزانه اسناد حسابداری در نرم‌افزار»']],
        w: [['سابقه کمتر از حداقل مورد انتظار', '«یک سال سابقه»', 'knockout']],
        tags: ['کمک‌حسابدار', 'جوان'],
      },
    ],
  },
  {
    deptId: 'it',
    title: 'کارشناس پشتیبانی شبکه و سیستم‌ها',
    location: 'تهران',
    type: 'hybrid',
    notes: 'پشتیبانی ۱۵۰ کاربر، نگهداری سرورها و شبکه دو شعبه، مستندسازی و پشتیبان‌گیری.',
    createdAgo: 4,
    by: 'you',
    status: 'open',
    source: 'ai',
    candidates: [
      {
        name: 'شیما رحیمی', file: 'shima-rahimi.txt', role: 'سرپرست زیرساخت', years: 6, edu: 'کارشناسی ارشد فناوری اطلاعات',
        city: 'تهران', phone: '09127778811', email: 'shima.rahimi@example.com', skills: ['Linux', 'Windows Server', 'Backup', 'Zabbix', 'Network+'],
        salary: '۴۸ میلیون تومان', score: 88, rec: 'INTERVIEW',
        summary: 'شش سال مدیریت زیرساخت و پشتیبانی در سازمان چندشعبه‌ای؛ تجربه پشتیبان‌گیری، مانیتورینگ و مستندسازی دارد.',
        why: 'تجربه زیرساخت و پشتیبانی او با نیاز این موقعیت هم‌خوان است.',
        s: [
          ['مانیتورینگ و پایداری', '«استقرار مانیتورینگ Zabbix برای ۶۰ سرور و تجهیز»'],
          ['مستندسازی فرایندها', '«تدوین دستورالعمل پشتیبان‌گیری و بازیابی»'],
        ],
        w: [['ممکن است سطح نقش برایش پایین باشد', '«سرپرست تیم زیرساخت از ۱۴۰۱»', 'minor']],
        tags: ['زیرساخت', 'لینوکس', 'مانیتورینگ', 'ارشد'],
        decision: 'approved', by: 'hossein', decidedAgo: 1, msg: true, deep: true, hired: true,
      },
      {
        name: 'یاسمن طاهری', file: 'yasaman-taheri.txt', role: 'کارشناس شبکه', years: 4, edu: 'کارشناسی مهندسی کامپیوتر',
        city: 'تهران', phone: '09359990011', email: 'yasaman.taheri@example.com',
        skills: ['MikroTik', 'Active Directory', 'Windows Server', 'VMware', 'Helpdesk'], salary: null, score: 84, rec: 'INTERVIEW',
        summary: 'چهار سال پشتیبانی شبکه و سرور در شرکت ۲۰۰ نفره؛ تجربه مستقیم با Active Directory و میکروتیک دارد.',
        why: 'تجربه عملی پشتیبانی شبکه دارد و ابزارهای موردنیاز را می‌شناسد.',
        s: [
          ['مدیریت Active Directory', '«مدیریت ۲۰۰ کاربر در Active Directory»'],
          ['پیکربندی شبکه', '«راه‌اندازی VLAN و فایروال میکروتیک برای دو شعبه»'],
        ],
        w: [['گواهی‌نامه رسمی ذکر نشده', NONE, 'minor']],
        tags: ['شبکه', 'Active Directory', 'میکروتیک'],
      },
      {
        name: 'امید نادری', file: 'omid-naderi.txt', role: 'تکنسین IT', years: 2, edu: 'کاردانی نرم‌افزار', city: 'کرج',
        phone: '09380001122', email: 'omid.naderi@example.com', skills: ['Helpdesk', 'Windows', 'سخت‌افزار'], salary: '۲۲ میلیون تومان',
        score: 66, rec: 'REVIEW',
        summary: 'دو سال پشتیبانی کاربران و سخت‌افزار؛ تجربه کار با سرور و شبکه سازمانی محدود است.',
        why: 'پایه پشتیبانی خوبی دارد ولی تجربه شبکه سازمانی کم است.',
        s: [['پشتیبانی کاربران', '«پاسخ‌گویی به حدود ۳۰ درخواست پشتیبانی در روز»']],
        w: [['تجربه محدود با سرور', NONE, 'major']],
        tags: ['Helpdesk', 'سخت‌افزار', 'جوان'],
      },
      {
        name: 'رضا امیری', file: 'resume_final_v2.txt', role: 'کارشناس IT', years: 3, edu: 'کارشناسی کامپیوتر', city: 'تهران',
        phone: '09121113344', email: null, skills: [], salary: null, score: 58, rec: 'REVIEW',
        summary: '', why: '', s: [], w: [], tags: [], local: true,
      },
      {
        name: 'کیان محمودی', file: 'kian-mahmoudi.txt', role: 'برنامه‌نویس وب', years: 3, edu: 'کارشناسی مهندسی کامپیوتر',
        city: 'تهران', phone: '09012345678', email: 'kian.mahmoudi@example.com', skills: ['React', 'Node.js', 'SQL'], salary: null,
        score: 52, rec: 'REVIEW',
        summary: 'سه سال برنامه‌نویسی وب؛ مهارت فنی خوبی دارد اما تجربه پشتیبانی کاربران و شبکه، که محور این موقعیت است، دیده نمی‌شود.',
        why: 'توان فنی دارد ولی جنس تجربه‌اش توسعه نرم‌افزار است نه پشتیبانی.',
        s: [['تجربه پروژه‌های نرم‌افزاری', '«توسعه پنل مدیریت فروش با React و Node.js»']],
        w: [['تجربه پشتیبانی شبکه ندارد', NONE, 'major']],
        tags: ['برنامه‌نویسی', 'React', 'وب'],
        bank: { dept: 'it', note: 'برای فرصت‌های توسعه نرم‌افزار' },
      },
    ],
  },
  {
    deptId: 'marketing',
    title: 'کارشناس دیجیتال مارکتینگ',
    location: 'تهران',
    type: 'full-time',
    notes: 'برنامه‌ریزی و اجرای کمپین‌های دیجیتال، سئو و گزارش‌دهی عملکرد.',
    createdAgo: 55,
    by: 'maryam',
    status: 'closed',
    source: 'template',
    candidates: [
      {
        name: 'نیلوفر شمس', file: 'niloofar-shams.txt', role: 'کارشناس دیجیتال مارکتینگ', years: 4, edu: 'کارشناسی مدیریت بازرگانی',
        city: 'تهران', phone: '09124443322', email: 'niloofar.shams@example.com',
        skills: ['SEO', 'Google Ads', 'Instagram', 'تولید محتوا', 'Google Analytics'], salary: '۴۰ میلیون تومان', score: 85, rec: 'INTERVIEW',
        summary: 'چهار سال اجرای کمپین‌های دیجیتال با نتایج عددی و تسلط بر ابزارهای تحلیلی.',
        why: 'تجربه اجرایی و نتایج قابل سنجش دارد.',
        s: [['نتایج عددی کمپین', '«افزایش ۴۰ درصدی ترافیک ارگانیک در ۸ ماه»']],
        w: [['تجربه مدیریت بودجه کلان تبلیغات ذکر نشده', NONE, 'minor']],
        tags: ['دیجیتال مارکتینگ', 'SEO', 'محتوا'],
        decision: 'approved', by: 'maryam', decidedAgo: 40, msg: true, hired: true,
      },
      {
        name: 'مینا کرمی', file: 'mina-karami.txt', role: 'کارشناس بازاریابی', years: 3, edu: 'کارشناسی ارشد مدیریت کسب‌وکار',
        city: 'اصفهان', phone: '09134445566', email: 'mina.karami@example.com', skills: ['تحقیقات بازار', 'برندینگ', 'اکسل'],
        salary: null, score: 71, rec: 'REVIEW',
        summary: 'سه سال تحقیقات بازار و برندینگ؛ تجربه اجرای کمپین دیجیتال کمتر دیده می‌شود.',
        why: 'دانش بازاریابی خوبی دارد ولی تجربه دیجیتال او باید سنجیده شود.',
        s: [['تحقیقات بازار', '«اجرای ۳ پروژه تحقیقات بازار برای محصولات جدید»']],
        w: [['تجربه کمپین دیجیتال محدود', NONE, 'major']],
        tags: ['بازاریابی', 'برندینگ', 'تحقیقات بازار'],
        decision: 'review', by: 'hossein', decidedAgo: 45,
      },
      {
        name: 'علیرضا بهرامی', file: 'alireza-bahrami.txt', role: 'تولیدکننده محتوا', years: 2, edu: 'کارشناسی علوم ارتباطات',
        city: 'تهران', phone: '09356667788', email: 'alireza.bahrami@example.com', skills: ['تولید محتوا', 'تدوین ویدیو', 'اینستاگرام'],
        salary: '۲۸ میلیون تومان', score: 64, rec: 'REVIEW',
        summary: 'دو سال تولید محتوای ویدیویی و مدیریت صفحه اینستاگرام؛ تجربه برنامه‌ریزی و تحلیل کمپین کمتر است.',
        why: 'در تولید محتوا قوی است اما این نقش بیشتر مدیریت کمپین می‌خواهد.',
        s: [['تولید محتوای ویدیویی', '«تولید ۱۲۰ ویدیوی کوتاه برای صفحه برند»']],
        w: [['تجربه تحلیل کمپین ندارد', NONE, 'major']],
        tags: ['تولید محتوا', 'ویدیو', 'شبکه‌های اجتماعی'],
        decision: 'rejected', by: 'maryam', decidedAgo: 42, note: 'تمرکز بر تولید محتوا، نه مدیریت کمپین',
        bank: { dept: 'marketing', note: 'برای نقش تولید محتوا مناسب است' },
      },
      {
        name: 'هادی سلطانی', file: 'hadi-soltani.txt', role: 'ادمین شبکه‌های اجتماعی', years: 1, edu: 'کارشناسی مهندسی مکانیک',
        city: 'تهران', phone: '09191110000', email: null, skills: ['اینستاگرام'], salary: null, score: 36, rec: 'REJECT',
        summary: 'یک سال ادمینی صفحه اینستاگرام بدون شواهدی از برنامه‌ریزی، تبلیغات یا تحلیل داده.',
        why: 'سابقه برای این نقش کافی نیست.',
        s: [],
        w: [['سابقه مرتبط کافی ندارد', '«ادمین صفحه اینستاگرام — یک سال»', 'knockout']],
        tags: ['شبکه‌های اجتماعی', 'جوان'],
        decision: 'rejected', by: 'maryam', decidedAgo: 44, note: 'عدم تطابق سابقه',
      },
    ],
  },
];

// ---------------------------------------------------------------------------

function daysAgo(days: number, hourOffset = 0): Date {
  return new Date(Date.now() - days * 86400_000 + hourOffset * 3600_000);
}

function resumeText(c: DemoCandidate, jobTitle: string): string {
  return [
    `رزومه ${c.name || ''}`.trim(),
    `سمت فعلی: ${c.role}`,
    c.years != null ? `سابقه کار: ${c.years} سال` : '',
    `تحصیلات: ${c.edu}`,
    `محل سکونت: ${c.city} — تلفن: ${c.phone}${c.email ? ` — ایمیل: ${c.email}` : ''}`,
    '',
    'سوابق و دستاوردها:',
    ...c.s.map(([, ev]) => `- ${ev.replace(/[«»]/g, '')}`),
    ...c.w.filter(([, ev]) => ev !== NONE).map(([, ev]) => `- ${ev.replace(/[«»]/g, '')}`),
    '',
    c.skills.length ? `مهارت‌ها: ${c.skills.join('، ')}` : '',
    c.salary ? `حقوق درخواستی: ${c.salary}` : '',
    '',
    `درخواست همکاری برای موقعیت: ${jobTitle}`,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

function evaluationFor(c: DemoCandidate, job: ReturnType<typeof buildTemplateUnderstanding>): CandidateEvaluation {
  const spread = job.criteria.map((crit, i) => {
    const delta = [6, -8, 4, -3, 2][i % 5];
    const score = Math.max(5, Math.min(100, c.score + delta));
    return {
      criterionId: crit.id,
      title: crit.title,
      score,
      rationale:
        score >= 70
          ? `شواهد رزومه برای «${crit.title}» روشن و قابل اتکاست.`
          : score >= 45
          ? `شواهد نسبی برای «${crit.title}» وجود دارد اما کامل نیست.`
          : `در رزومه شاهد مشخصی برای «${crit.title}» دیده نشد.`,
      evidence: c.s[i % Math.max(1, c.s.length)]?.[1] || NONE,
    };
  });
  return {
    candidateName: c.name,
    contact: { phone: c.phone || null, email: c.email, city: c.city || null },
    facts: { yearsExperience: c.years, education: c.edu || null, lastRole: c.role || null, skills: c.skills, expectedSalary: c.salary },
    criterionScores: spread,
    score: c.score,
    confidence: c.score >= 80 ? 'high' : c.score >= 50 ? 'medium' : 'low',
    engine: 'ai',
    recommendation: c.rec,
    summary: c.summary,
    whyCategory: c.why,
    strengths: c.s.map(([point, evidence]) => ({ point, evidence, severity: 'minor' as const })),
    weaknesses: c.w.map(([point, evidence, severity]) => ({ point, evidence, severity })),
    knockoutMisses: c.w.filter((w) => w[2] === 'knockout').map((w) => w[0]),
    tags: c.tags,
    bankSuggested: c.score >= 60 && c.rec !== 'INTERVIEW',
    flags: { irrelevant: c.score < 30, insufficientInfo: false, scannedNoText: false },
    deepFindings: c.deep
      ? {
          focusPoints: [
            'دستاوردها با عدد و بازه زمانی آمده‌اند و در مصاحبه قابل راستی‌آزمایی‌اند.',
            'توالی زمانی سوابق بدون هم‌پوشانی غیرعادی است؛ فقط یک فاصله کوتاه دیده می‌شود.',
            'عنوان‌های شغلی با شرح وظایف نوشته‌شده هم‌خوانی دارند.',
          ],
          interviewQuestions: [
            'یکی از دستاوردهای عددی رزومه را انتخاب کنید و بگویید دقیقاً سهم شخص شما چه بود؟',
            'در سخت‌ترین پروژه یا موقعیت کاری اخیر، چه تصمیمی گرفتید و چرا؟',
            'چه چیزی شما را به این موقعیت و این سازمان علاقه‌مند کرده است؟',
          ],
          risks: ['انتظارات حقوقی باید در همان جلسه اول شفاف شود.'],
        }
      : null,
  };
}

export async function createDemoWorkspace(ttlMs: number = DEMO_TTL_MS): Promise<{ org: db.OrgRecord; user: db.UserRecord }> {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const org = db.createOrg({ name: 'گروه نمونه آوا', isDemo: true, demoExpiresAt: expires });
  const pass = await hashPassword(crypto.randomBytes(18).toString('base64url'));
  const suffix = org.id.slice(-8);

  const people: Record<Who, db.UserRecord> = {
    you: db.createUser({ orgId: org.id, name: 'کاربر نمایشی', email: `demo-${suffix}@demo.hovida.local`, passwordHash: pass, role: 'owner', title: 'کارشناس ارشد منابع انسانی' }),
    maryam: db.createUser({ orgId: org.id, name: 'مریم احمدی', email: `maryam-${suffix}@demo.hovida.local`, passwordHash: pass, role: 'admin', title: 'مدیر منابع انسانی' }),
    hossein: db.createUser({ orgId: org.id, name: 'حسین کاظمی', email: `hossein-${suffix}@demo.hovida.local`, passwordHash: pass, role: 'member', title: 'کارشناس جذب' }),
  };
  const actor = (w: Who) => ({ id: people[w].id, name: people[w].name });
  db.logActivity(org.id, actor('maryam'), 'org.created', `فضای کاری «${org.name}» را ساخت`, { at: daysAgo(60) });
  db.logActivity(org.id, actor('maryam'), 'member.added', `«${people.hossein.name}» را به تیم اضافه کرد`, { at: daysAgo(59) });
  db.logActivity(org.id, actor('maryam'), 'member.added', `«${people.you.name}» را به تیم اضافه کرد`, { at: daysAgo(59, 1) });

  const dept = (id: string): Department => org.departments.find((d) => d.id === id) || org.departments[org.departments.length - 1];
  const created: { id: string; title: string; deptId: string }[] = [];
  /** Candidates the walkthrough needs by name (scorecards, interviews, notes). */
  const peopleByName = new Map<string, { rec: ResumeRecord; jobId: string; jobTitle: string; criteria: { id: string; title: string }[] }>();

  for (const spec of JOBS) {
    const d = dept(spec.deptId);
    const understanding = buildTemplateUnderstanding(d, spec.title);
    const job = db.createJob(
      org.id,
      actor(spec.by),
      {
        departmentId: d.id,
        departmentName: d.name,
        roleTitle: spec.title,
        extraNotes: spec.notes,
        location: spec.location,
        employmentType: spec.type,
        understanding,
        answers: {},
        criteriaSource: spec.source,
      },
      daysAgo(spec.createdAgo)
    );
    db.logActivity(org.id, actor(spec.by), 'job.created', `فرصت شغلی «${spec.title}» را ایجاد کرد`, { jobId: job.id, at: daysAgo(spec.createdAgo) });
    created.push({ id: job.id, title: spec.title, deptId: spec.deptId });

    let i = 0;
    for (const c of spec.candidates) {
      // Resumes arrive over the first days after the opening was published.
      const at = daysAgo(spec.createdAgo, 2 + i * Math.max(3, Math.round((spec.createdAgo * 6) / spec.candidates.length)));
      i++;
      if (c.unjudgeable) {
        await db.saveEvaluation({ job, uploadedBy: people[spec.by].id, fileName: c.file, extractedText: '', unjudgeableReason: c.unjudgeable, at });
        continue;
      }
      const text = resumeText(c, spec.title);
      let evaluation: CandidateEvaluation;
      if (c.local) {
        evaluation = {
          ...evaluationFor(c, understanding),
          engine: 'local',
          confidence: 'low',
          summary: `این ارزیابی با موتور محلی (تطبیق کلیدواژه‌ای، نه هوش مصنوعی) انجام شده است؛ امتیاز ${c.score} فقط بر اساس حضور کلیدواژه‌های شاخص‌ها در متن رزومه است و دقت کمتری دارد.`,
          whyCategory: 'تطابق نسبی با شاخص‌ها دیده شد و بررسی انسانی لازم است (تحلیل محلی).',
          strengths: [{ point: `تطابق نسبی در «${understanding.criteria[0].title}»`, evidence: 'اشاره به پشتیبانی و شبکه در رزومه', severity: 'minor' }],
          weaknesses: [{ point: `شواهد کافی برای «${understanding.criteria[2].title}» یافت نشد`, evidence: 'در رزومه شاهد مشخصی برای این شاخص یافت نشد', severity: 'minor' }],
          tags: [],
        };
      } else {
        evaluation = evaluationFor(c, understanding);
      }
      const isPdf = c.file.endsWith('.pdf') && c.pdf;
      const rec = await db.saveEvaluation({
        job,
        uploadedBy: people[spec.by].id,
        fileName: c.file,
        extractedText: isPdf ? c.pdf!.join('\n') : text,
        unjudgeableReason: null,
        fileBase64: isPdf
          ? makeSamplePdf((c.pdf![0] || '').split(' - ')[0], c.pdf!.slice(1))
          : Buffer.from(text, 'utf-8').toString('base64'),
        evaluation,
        at,
      });
      if (c.deep) {
        rec.deepAnalysisAtJalali = rec.createdAtJalali;
        rec.analysisHistory.push({ score: c.score, atJalali: rec.createdAtJalali, atISO: at.toISOString(), reason: 'deep', engine: 'ai', mode: 'deep' });
        db.logActivity(org.id, actor(spec.by), 'deep.review', `بازبینی دقیق رزومه «${c.name}» را انجام داد`, { jobId: job.id, resumeId: rec.id, at: new Date(at.getTime() + 3600_000) });
      }
      if (c.decision && c.decision !== 'none') {
        const when = daysAgo(c.decidedAgo ?? 0, -2);
        db.setDecision(rec, c.decision, c.note ?? null, actor(c.by || 'you'), when);
        const verb =
          c.decision === 'approved'
            ? `«${c.name}» را برای «${spec.title}» تأیید کرد`
            : c.decision === 'rejected'
            ? `«${c.name}» را برای «${spec.title}» رد کرد`
            : `«${c.name}» را در وضعیت «نیاز به بررسی» گذاشت`;
        db.logActivity(org.id, actor(c.by || 'you'), 'decision', verb, { jobId: job.id, resumeId: rec.id, at: when });
      }
      peopleByName.set(c.name || c.file, {
        rec,
        jobId: job.id,
        jobTitle: spec.title,
        criteria: (understanding.criteria || []).slice(0, 2).map((k) => ({ id: k.id, title: k.title })),
      });
      if (c.hired) {
        db.setStage(rec, 'stage_hired');
        db.logActivity(org.id, actor(c.by || 'you'), 'stage.moved', `«${c.name}» را به ستون «استخدام‌شده» برد`, {
          jobId: job.id,
          resumeId: rec.id,
          at: daysAgo(Math.max(0, (c.decidedAgo ?? 1) - 0.1)),
        });
      }
      if (c.bank) {
        const when = daysAgo(Math.max(0, (c.decidedAgo ?? spec.createdAgo - 1) - 0.2));
        const bd = dept(c.bank.dept);
        db.addToTalent(rec, bd.id, c.bank.note, c.tags.slice(0, 3), when);
        db.logActivity(org.id, actor(c.by || spec.by), 'talent.added', `«${c.name}» را به بانک استعداد «${bd.name}» افزود`, { jobId: job.id, resumeId: rec.id, at: when });
      }
      if (c.msg) {
        db.markMessageSent(rec);
        db.logActivity(org.id, actor(c.by || 'you'), 'message.sent', `پیام «دعوت به مصاحبه» را برای «${c.name}» ارسال‌شده علامت زد`, {
          jobId: job.id,
          resumeId: rec.id,
          at: daysAgo(Math.max(0, (c.decidedAgo ?? 1) - 0.1)),
        });
      }
    }
    db.logActivity(
      org.id,
      actor(spec.by),
      'analysis.completed',
      `${spec.candidates.length.toLocaleString('fa-IR')} رزومه را برای «${spec.title}» تحلیل کرد`,
      { jobId: job.id, at: daysAgo(spec.createdAgo, 3) }
    );
    if (spec.status !== 'open') {
      db.updateJob(org.id, job.id, { status: spec.status, analysisStatus: 'done' });
      db.logActivity(org.id, actor(spec.by), 'job.status', `وضعیت «${spec.title}» را به «بسته‌شده» تغییر داد`, { jobId: job.id, at: daysAgo(spec.createdAgo - 15) });
    } else {
      db.updateJob(org.id, job.id, { analysisStatus: 'done' });
    }
    job.updatedAtISO = daysAgo(Math.max(0, spec.createdAgo - 3)).toISOString();
  }

  // «هزینهٔ هر استخدام»: a small, believable budget. Money is only ever what a
  // human typed — here the demo workspace's own numbers, not a hidden estimate.
  const costSpecs: { kind: CostKind; amount: number; days: number; job?: number; note: string }[] = [
    { kind: 'advertising', amount: 18_000_000, days: 34, job: 3, note: 'آگهی جاب‌ویژن و ایران‌تلنت، ۳۰ روز' },
    { kind: 'advertising', amount: 12_500_000, days: 22, job: 4, note: 'آگهی اینستاگرام و لینکدین' },
    { kind: 'agency', amount: 45_000_000, days: 20, note: 'دستمزد ریکروتر برای نقش‌های فنی' },
    { kind: 'tools', amount: 9_600_000, days: 30, note: 'اشتراک سالانهٔ ابزار سنجش' },
    { kind: 'referral', amount: 5_000_000, days: 12, job: 3, note: 'پاداش معرفی همکار' },
    { kind: 'interview', amount: 3_200_000, days: 8, job: 4, note: 'پذیرایی و جایگزین شیفت روز مصاحبه' },
  ];
  for (const c of costSpecs) {
    const target = c.job !== undefined ? created[c.job] : undefined;
    db.addCost(
      org.id,
      {
        kind: c.kind,
        amount: c.amount,
        atISO: daysAgo(c.days).toISOString(),
        jobId: target?.id ?? null,
        jobTitle: target?.title ?? null,
        note: c.note,
      },
      people.maryam.name
    );
  }
  // Scorecards, notes and interviews: the collaboration the team report counts
  // and the hours the cost estimate is built from. All backdated like the rest.
  const scorecards: { name: string; reviewer: Who; days: number; recommendation: InterviewFeedback['recommendation']; notes: string }[] = [
    { name: 'شیما رحیمی', reviewer: 'hossein', days: 2, recommendation: 'yes', notes: 'روی پایداری و مستندسازی مسلط است؛ برای مصاحبهٔ نهایی مناسب است.' },
    { name: 'سارا محمدی', reviewer: 'maryam', days: 1, recommendation: 'strong_yes', notes: 'دقیقاً همان تجربهٔ جذب در محیط تولیدی که لازم داریم.' },
    { name: 'نیلوفر شمس', reviewer: 'you', days: 41, recommendation: 'yes', notes: 'نتایج کمپین‌ها عددی است؛ بودجهٔ تبلیغات را باید پرسید.' },
  ];
  for (const sc of scorecards) {
    const found = peopleByName.get(sc.name);
    if (!found) continue;
    const at = daysAgo(sc.days, 2);
    db.saveFeedback({
      id: db.uid('fb'),
      orgId: org.id,
      interviewId: null,
      resumeId: found.rec.id,
      jobId: found.jobId,
      reviewerId: people[sc.reviewer].id,
      reviewerName: people[sc.reviewer].name,
      recommendation: sc.recommendation,
      criteria: found.criteria.map((k, i) => ({ criterionId: k.id, title: k.title, score: i === 0 ? 5 : 4, note: '' })),
      notes: sc.notes,
      atISO: at.toISOString(),
      atJalali: formatJalaliDate(tehranJalaliOf(at), true),
    });
    db.logActivity(org.id, actor(sc.reviewer), 'scorecard.added', `برای «${sc.name}» کارت ارزیابی ثبت کرد`, {
      jobId: found.jobId,
      resumeId: found.rec.id,
      at,
    });
  }

  const notes: { name: string; author: Who; days: number; body: string }[] = [
    { name: 'سارا محمدی', author: 'maryam', days: 30, body: 'برای مصاحبهٔ دوم، نمونهٔ واقعی از کاهش زمان استخدام را بخواهیم.' },
    { name: 'شیما رحیمی', author: 'hossein', days: 2, body: 'دسترسی به سرور آزمایشی برای آزمون عملی هماهنگ شد.' },
  ];
  for (const n of notes) {
    const found = peopleByName.get(n.name);
    if (!found) continue;
    const at = daysAgo(n.days, 4);
    db.saveComment({
      id: db.uid('cm'),
      orgId: org.id,
      resumeId: found.rec.id,
      jobId: found.jobId,
      authorId: people[n.author].id,
      authorName: people[n.author].name,
      body: n.body,
      mentions: [],
      atISO: at.toISOString(),
      atJalali: formatJalaliDate(tehranJalaliOf(at), true),
    });
    db.logActivity(org.id, actor(n.author), 'comment.added', `روی پروندهٔ «${n.name}» یادداشت گذاشت`, {
      jobId: found.jobId,
      resumeId: found.rec.id,
      at,
    });
  }

  const interviewSpecs: { name: string; interviewer: Who; days: number; duration: number; title: string }[] = [
    { name: 'شیما رحیمی', interviewer: 'hossein', days: 2, duration: 60, title: 'مصاحبهٔ فنی زیرساخت' },
    { name: 'نیلوفر شمس', interviewer: 'you', days: 42, duration: 45, title: 'مصاحبهٔ بازاریابی دیجیتال' },
  ];
  for (const iv of interviewSpecs) {
    const found = peopleByName.get(iv.name);
    if (!found) continue;
    const at = daysAgo(iv.days, -3);
    const who = people[iv.interviewer];
    db.saveInterview({
      id: db.uid('iv'),
      orgId: org.id,
      jobId: found.jobId,
      jobTitle: found.jobTitle,
      resumeId: found.rec.id,
      candidateName: iv.name,
      candidateEmail: found.rec.contact?.email || null,
      title: iv.title,
      startsAtISO: at.toISOString(),
      durationMin: iv.duration,
      timezone: 'Asia/Tehran',
      interviewerIds: [who.id],
      interviewerNames: [who.name],
      interviewerEmails: [who.email],
      location: 'اتاق جلسات ۲',
      notes: '',
      calendarEventId: null,
      calendarHtmlLink: null,
      meetLink: null,
      inviteSentTo: found.rec.contact?.email || null,
      status: 'scheduled',
      createdBy: who.id,
      createdByName: who.name,
      createdAtISO: at.toISOString(),
      createdAtJalali: formatJalaliDate(tehranJalaliOf(at), true),
    });
  }

  // «آزمون و ارزیابی»: one keyed test and one behavioural profile, plus a link
  // that is still open — so the panel has a result and a pending state on day one.
  const demoPeople = Array.from(peopleByName.values());
  const pick = (needle: string) => demoPeople.find((p) => p.jobTitle.includes(needle)) || demoPeople[0];
  const answerSet = (templateId: string, strength: 'strong' | 'medium') => {
    const tpl = templateById(templateId)!;
    const answers: Record<string, string | number> = {};
    for (const q of tpl.questions) {
      if (q.type === 'single') {
        const ranked = [...q.options].sort((a, b) => b.score - a.score);
        answers[q.id] = (strength === 'strong' ? ranked[0] ?? ranked[0] : ranked[1] ?? ranked[0]).id;
      } else {
        answers[q.id] = strength === 'strong' ? (q.reverse ? 2 : 5) : q.reverse ? 4 : 3;
      }
    }
    return { tpl, answers, scored: scoreAnswers(tpl, answers) };
  };
  const seedAssessment = (target: ReturnType<typeof pick>, templateId: string, strength: 'strong' | 'medium', days: number, status: 'completed' | 'sent' | 'started') => {
    const { tpl, answers, scored } = answerSet(templateId, strength);
    const created = daysAgo(days);
    const email = target.rec.contact?.email || null;
    db.saveAssessment({
      id: db.uid('asm'),
      orgId: org.id,
      token: crypto.randomBytes(18).toString('base64url'),
      resumeId: target.rec.id,
      jobId: target.jobId,
      jobTitle: target.jobTitle,
      templateId: tpl.id,
      templateName: tpl.name,
      kind: tpl.kind,
      candidateName: target.rec.candidateName || null,
      candidateEmail: email,
      status,
      source: 'hovida',
      createdAtISO: created.toISOString(),
      sentAtISO: created.toISOString(),
      startedAtISO: status === 'sent' ? null : daysAgo(days, -1).toISOString(),
      completedAtISO: status === 'completed' ? daysAgo(days, -2).toISOString() : null,
      expiresAtISO: new Date(created.getTime() + 14 * 86_400_000).toISOString(),
      score: status === 'completed' ? scored.score : null,
      band: status === 'completed' ? scored.band : null,
      dimensions: status === 'completed' ? scored.dimensions : null,
      answeredCount: status === 'completed' ? tpl.questions.length : status === 'started' ? 2 : 0,
      questionCount: tpl.questions.length,
      note: null,
      answers: status === 'completed' ? answers : null,
    });
    if (status === 'completed') {
      db.logActivity(org.id, null, 'assessment.completed', `آزمون «${tpl.name}» را تکمیل کرد${scored.score !== null ? ` — نمرهٔ ${scored.score}` : ''}`, {
        jobId: target.jobId,
        resumeId: target.rec.id,
        at: daysAgo(days, -2),
      });
    }
  };
  if (demoPeople.length) {
    seedAssessment(pick('جذب'), 'situational-recruiting', 'strong', 6, 'completed');
    seedAssessment(pick('نرم'), 'behavioral-core', 'medium', 4, 'completed');
    seedAssessment(pick('شبکه'), 'work-sample-support', 'strong', 1, 'sent');
  }

  // The internal rate is entered like a real workspace would: the page adds the
  // cost of recorded hours only because someone typed this number.
  db.setCostAssumption(org.id, { hourlyRate: 320_000, minutesPerScorecard: 25, minutesPerComment: 5, minutesPerDecision: 10 });

  // A few teammate actions stay "unread" so notifications have something to show.
  db.updateUser(people.you.id, { lastSeenActivityISO: daysAgo(2.5).toISOString(), lastLoginISO: new Date().toISOString() });
  db.updateUser(people.maryam.id, { lastLoginISO: daysAgo(0, -3).toISOString() });
  db.updateUser(people.hossein.id, { lastLoginISO: daysAgo(1, -5).toISOString() });
  return { org, user: people.you };
}

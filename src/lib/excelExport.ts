import type { Job, ResumeListItem } from '../types/screening';
import { api } from './api';
import { DECISION_META, matchMeta } from './match';
import { candidateName, faDate, toPersianDigits } from './format';

async function allCandidates(jobId: string): Promise<ResumeListItem[]> {
  const out: ResumeListItem[] = [];
  let page = 1;
  for (;;) {
    const res = await api.resumes.list({ jobId, page, pageSize: 100, sort: 'match' });
    out.push(...res.items);
    if (page >= res.totalPages) break;
    page++;
  }
  return out;
}

/** Two-sheet workbook: job summary + every candidate with evidence and the human decision. */
export async function exportJobToExcel(job: Job) {
  const [XLSX, records] = await Promise.all([import('xlsx'), allCandidates(job.id)]);
  const wb = XLSX.utils.book_new();
  const s = job.stats;
  const summary = [
    { مورد: 'فرصت شغلی', مقدار: job.roleTitle },
    { مورد: 'دپارتمان', مقدار: job.departmentName },
    { مورد: 'تاریخ ایجاد', مقدار: faDate(job.createdAtISO) },
    { مورد: 'منبع معیارها', مقدار: job.criteriaSource === 'template' ? 'الگوی آماده دپارتمان' : 'پیشنهاد هوش مصنوعی' },
    { مورد: 'معیارهای ارزیابی', مقدار: job.understanding.criteria.map((c) => `${c.title} (${toPersianDigits(c.weight)}٪${c.mustHave ? '، الزامی' : ''})`).join('؛ ') },
    { مورد: 'آستانه تطابق بالا / بررسی', مقدار: `${toPersianDigits(job.understanding.thresholds.interview)}٪ / ${toPersianDigits(job.understanding.thresholds.review)}٪` },
    { مورد: 'کل رزومه‌ها', مقدار: toPersianDigits(s.total) },
    { مورد: 'تطابق بالا', مقدار: toPersianDigits(s.interview) },
    { مورد: 'نیازمند بررسی', مقدار: toPersianDigits(s.review) },
    { مورد: 'تطابق پایین', مقدار: toPersianDigits(s.reject) },
    { مورد: 'اطلاعات ناکافی / خطا', مقدار: toPersianDigits(s.unjudgeable + s.error) },
    { مورد: 'تصمیم‌ها (تأیید / رد / نیاز به بررسی)', مقدار: `${toPersianDigits(s.approved)} / ${toPersianDigits(s.rejected)} / ${toPersianDigits(s.reviewDecision)}` },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), 'خلاصه');

  const rows = records.map((r, i) => ({
    ردیف: toPersianDigits(i + 1),
    نام: candidateName(r),
    'میزان تطابق': matchMeta(r.category).label,
    'درصد تطابق': r.category === 'UNJUDGEABLE' || r.category === 'ERROR' ? '—' : toPersianDigits(r.score),
    'موتور تحلیل': r.engine === 'local' ? 'موتور محلی (غیرهوشمند)' : r.engine === 'ai' ? 'هوش مصنوعی' : '—',
    'آخرین سمت': r.facts?.lastRole || '—',
    'سال سابقه': r.facts?.yearsExperience != null ? toPersianDigits(r.facts.yearsExperience) : '—',
    تحصیلات: r.facts?.education || '—',
    مهارت‌ها: (r.facts?.skills || []).join('، '),
    شهر: r.contact?.city || '—',
    تلفن: r.contact?.phone || '—',
    ایمیل: r.contact?.email || '—',
    'حقوق درخواستی': r.facts?.expectedSalary || '—',
    'جمع‌بندی هویدا': r.summary || r.unjudgeableReason || r.errorMessage || '—',
    'دلایل تطابق': r.strengths.map((x) => x.point).join('؛ '),
    'نکات قابل بررسی': r.weaknesses.map((x) => x.point).join('؛ '),
    'تصمیم شما': DECISION_META[r.decisionStatus].label,
    'تصمیم‌گیرنده': r.decidedByName || '—',
    'تاریخ تصمیم': r.decidedAtISO ? faDate(r.decidedAtISO) : '—',
    'یادداشت تصمیم': r.decisionNote || '—',
    'بانک استعداد': r.inBank ? 'بله' : 'خیر',
    فایل: r.fileName,
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  (sheet as any)['!cols'] = Object.keys(rows[0] || { a: 1 }).map((k) => ({ wch: k.length < 8 ? 14 : 26 }));
  XLSX.utils.book_append_sheet(wb, sheet, 'کاندیداها');
  const safe = job.roleTitle.replace(/[\\/:*?"<>|]/g, '').slice(0, 40) || 'job';
  XLSX.writeFile(wb, `هویدا-${safe}.xlsx`);
  return records.length;
}

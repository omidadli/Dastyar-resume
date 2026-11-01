/**
 * Defaults and sanitising for «اتوماسیون جذب».
 *
 * Kept in its own module (no db import) so the store can normalise what it loads
 * from disk, and tests can exercise the pure parts without a server.
 */
import type { AutomationSettings, MessageTemplate } from '../src/types/automation';

export const DEFAULT_INVITE: MessageTemplate = {
  subject: 'دعوت به مصاحبه — {{عنوان شغلی}}',
  body: [
    '{{نام}} عزیز،',
    '',
    'از اینکه برای «{{عنوان شغلی}}» در {{شرکت}} درخواست دادید سپاسگزاریم. بر اساس بررسی اولیه، تجربهٔ شما با نیازهای این نقش هم‌خوانی خوبی دارد و خوشحال می‌شویم گفت‌وگویی کوتاه داشته باشیم.',
    '',
    'لطفاً دو یا سه بازهٔ زمانی که در روزهای آینده برایتان مناسب است را همین‌جا پاسخ دهید تا جلسه را نهایی کنیم.',
    '',
    'با احترام',
    '{{امضای سازمان}}',
  ].join('\n'),
};

export const DEFAULT_REJECT: MessageTemplate = {
  subject: 'نتیجهٔ بررسی درخواست — {{عنوان شغلی}}',
  body: [
    '{{نام}} عزیز،',
    '',
    'از زمانی که برای «{{عنوان شغلی}}» در {{شرکت}} گذاشتید صمیمانه سپاسگزاریم. پس از بررسی درخواست‌ها، در این مرحله هم‌خوانی کافی با نیازهای این نقش پیدا نشد.',
    '',
    'پروفایل شما در بانک استعداد ما می‌ماند و اگر فرصت مناسب‌تری باز شد، با شما تماس می‌گیریم.',
    '',
    'برایتان آرزوی موفقیت داریم.',
    '{{امضای سازمان}}',
  ].join('\n'),
};

export const DEFAULT_REQUEST_INFO: MessageTemplate = {
  subject: 'یک نکتهٔ کوتاه دربارهٔ درخواست شما — {{عنوان شغلی}}',
  body: [
    '{{نام}} عزیز،',
    '',
    'درخواست شما برای «{{عنوان شغلی}}» در {{شرکت}} را دیدیم و برای بررسی دقیق‌تر، یک نکتهٔ کوچک لازم داریم:',
    '',
    '• بازهٔ حقوقی مورد انتظار',
    '• امکان حضور در {{دپارتمان}} (حضوری/دورکاری)',
    '',
    'اگر این اطلاعات را پاسخ دهید، پروندهٔ شما را کامل می‌کنیم.',
    '',
    'با احترام',
    '{{امضای سازمان}}',
  ].join('\n'),
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  enabled: true,
  inviteThreshold: 70,
  rejectThreshold: 40,
  // A human approves by default — these are the two switches an admin can turn
  // on once they trust the engine.
  autoInvite: false,
  autoReject: false,
  autoScheduleOnInvite: false,
  scheduleDaysAhead: 3,
  scheduleHour: '10:30',
  scheduleDurationMin: 45,
  useSignature: true,
  hourlyLimit: 30,
  templates: {
    invite: { ...DEFAULT_INVITE },
    reject: { ...DEFAULT_REJECT },
    requestInfo: { ...DEFAULT_REQUEST_INFO },
  },
};

const num = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

function template(raw: any, fallback: MessageTemplate): MessageTemplate {
  const subject = typeof raw?.subject === 'string' && raw.subject.trim() ? raw.subject.trim().slice(0, 200) : fallback.subject;
  const body = typeof raw?.body === 'string' && raw.body.trim() ? raw.body.slice(0, 8000) : fallback.body;
  return { subject, body };
}

/** Whatever came from disk or from the panel, made safe and sane. */
export function normalizeAutomationSettings(raw: any): AutomationSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_AUTOMATION;
  const inviteThreshold = Math.round(num(r.inviteThreshold, 0, 100, d.inviteThreshold));
  const rejectThreshold = Math.round(num(r.rejectThreshold, 0, 100, d.rejectThreshold));
  // The panel may send «۱۰:۳۰» (Persian digits) or «10:30»; both are the same
  // slot, and an impossible time (25:99) falls back instead of booking nonsense.
  const hourRaw = typeof r.scheduleHour === 'string' ? r.scheduleHour.trim().replace(/[۰-۹]/g, (c: string) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c))) : '';
  const hourMatch = /^(\d{1,2}):(\d{2})$/.exec(hourRaw);
  const hour =
    hourMatch && Number(hourMatch[1]) <= 23 && Number(hourMatch[2]) <= 59
      ? `${hourMatch[1].padStart(2, '0')}:${hourMatch[2]}`
      : d.scheduleHour;
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    // The invite line can never sit below the reject line; that would make the
    // engine propose «invite» and «reject» for the same person.
    inviteThreshold: Math.max(inviteThreshold, rejectThreshold),
    rejectThreshold,
    autoInvite: r.autoInvite === true,
    autoReject: r.autoReject === true,
    autoScheduleOnInvite: r.autoScheduleOnInvite === true,
    scheduleDaysAhead: Math.round(num(r.scheduleDaysAhead, 0, 30, d.scheduleDaysAhead)),
    scheduleHour: hour,
    scheduleDurationMin: Math.round(num(r.scheduleDurationMin, 15, 240, d.scheduleDurationMin)),
    useSignature: r.useSignature === undefined ? d.useSignature : r.useSignature === true,
    hourlyLimit: Math.round(num(r.hourlyLimit, 1, 120, d.hourlyLimit)),
    templates: {
      invite: template(r.templates?.invite, d.templates.invite),
      reject: template(r.templates?.reject, d.templates.reject),
      requestInfo: template(r.templates?.requestInfo, d.templates.requestInfo),
    },
  };
}

export interface TemplateVars {
  name: string;
  roleTitle: string;
  department?: string;
  orgName: string;
  score?: number | null;
  date?: string | null;
  interviewer?: string | null;
  signature?: string | null;
}

/**
 * Fills «{{نام}}» and friends. Unknown placeholders are removed rather than left
 * visible to a candidate, and an empty variable collapses the blank line it was
 * on so the message still reads well.
 */
export function renderTemplate(text: string, vars: TemplateVars): string {
  const fa = (n: number) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const values: Record<string, string> = {
    '{{نام}}': vars.name || 'کارجو',
    '{{عنوان شغلی}}': vars.roleTitle || 'این نقش',
    '{{دپارتمان}}': vars.department || 'سازمان',
    '{{شرکت}}': vars.orgName || '',
    '{{امتیاز}}': vars.score === undefined || vars.score === null ? '' : fa(Math.round(vars.score)),
    '{{تاریخ}}': vars.date || '',
    '{{مصاحبه‌گر}}': vars.interviewer || '',
    '{{امضای سازمان}}': vars.signature || '',
  };
  let out = String(text || '');
  for (const [key, value] of Object.entries(values)) {
    out = out.split(key).join(value);
  }
  // A placeholder we do not know must never reach the candidate.
  out = out.replace(/\{\{[^}]{1,40}\}\}/g, '');
  const lines = out.split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  // A workspace signature often starts with the same closing the template ends
  // with («با احترام»); the candidate must not read it twice.
  const deduped = lines.filter((line, i) => !(i > 0 && line.trim() !== '' && line === lines[i - 1]));
  return deduped.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * «سنجش نرم‌شده» — the scales, the score, and the honesty about the comparison
 * group.
 *
 * Three rules, in order of importance:
 *
 *   1. **No unnamed percentile.** A percentile is only shown when a norm group
 *      exists, and the group is named on screen with its size: the workspace's
 *      own norms (once it has enough completed results) or a table HR entered
 *      themselves. Otherwise the page says «بدون هنجار» and shows the raw band.
 *   2. **Bad data is flagged, not averaged.** Attention checks, straight-lining
 *      and improbable speed mark a result as unusable, so one rushed click-through
 *      never becomes a candidate's personality.
 *   3. **This is not a gate.** Nothing here moves a stage or rejects anyone; the
 *      scale readings are written as interview topics.
 *
 * Items are short statements in the style of the International Personality Item
 * Pool (public domain), translated and rewritten for work context. No licensed
 * instrument (NEO, MBTI, DISC, Hogan…) is reproduced, and no clinical claim is
 * made — which is why every screen says so.
 */
import crypto from 'crypto';
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { isEmailConfigured, friendlySmtpError, sendMail } from './mailer';
import { mailBrandOf } from './mail-brand';
import { noteEmailSend, withinEmailLimit } from './email-rate';
import {
  MIN_NORM_N,
  PSYCH_SCALE_POINTS,
  SMALL_GROUP,
  type PsychAnswers,
  type PsychFlag,
  type PsychGroupReport,
  type PsychInvite,
  type PsychItemPublic,
  type PsychNormConfig,
  type PsychNormSource,
  type PsychResult,
  type PsychScaleId,
  type PsychScaleScore,
  type PublicPsychTest,
} from '../src/types/psychometrics';

export const PSYCH_TTL_DAYS = 14;

/**
 * Seconds of reading time we expect per item. Below this, a sheet is marked
 * «TOO_FAST» — 27 items in 40 seconds is not reading, it is clicking. Configurable
 * because a workspace may know its population reads faster or slower; `0` turns
 * the check off, and the screen then says the check is off instead of pretending.
 */
export const MIN_SECONDS_PER_ITEM = (() => {
  const v = Number(process.env.PSYCH_MIN_SECONDS_PER_ITEM);
  return Number.isFinite(v) && v >= 0 ? v : 2;
})();

export class PsychError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'PSYCH_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jalali(iso: string | null): string | null {
  return iso ? formatJalaliDate(tehranJalaliOf(new Date(iso)), true) : null;
}

// ------------------------------------------------------------------ scales ---

export interface PsychScale {
  id: PsychScaleId;
  label: string;
  high: string;
  low: string;
}

export const PSYCH_SCALES: PsychScale[] = [
  {
    id: 'conscientiousness',
    label: 'نظم و پیگیری',
    high: 'کارها را تمام می‌کند، جزئیات را نگه می‌دارد و برای تعهدش برنامه دارد.',
    low: 'شروع‌های زیاد و پایان‌های کم؛ به ساختار بیرونی و بازبینی نیاز دارد.',
  },
  {
    id: 'agreeableness',
    label: 'همکاری و اعتماد',
    high: 'در تعارض دنبال راه‌حل مشترک است و به هم‌تیمی‌ها اعتماد پایه می‌دهد.',
    low: 'رقابتی و صریح؛ در نقش‌هایی که نقد تند لازم است می‌تواند مؤثر باشد.',
  },
  {
    id: 'stability',
    label: 'ثبات هیجانی',
    high: 'زیر فشار آرام می‌ماند و بازخورد را بدون گرفتن موضع شخصی می‌شنود.',
    low: 'استرس را زود نشان می‌دهد؛ در نقش‌های پرتنش به پشتیبانی و زمان‌بندی روشن نیاز دارد.',
  },
  {
    id: 'openness',
    label: 'گشودگی به تجربه',
    high: 'ایدهٔ تازه را امتحان می‌کند و از یاد گرفتن ابزار جدید خوشش می‌آید.',
    low: 'روش آزموده را ترجیح می‌دهد؛ در کارهای تکراری و پرریسک مزیت است.',
  },
  {
    id: 'extraversion',
    label: 'ارتباط بیرونی',
    high: 'در جمع راحت حرف می‌زند و تماس با افراد ناشناس برایش هزینه ندارد.',
    low: 'در نوشتن و کار عمیق متمرکزتر است؛ در نقش‌های فروش و مذاکره به تمرین نیاز دارد.',
  },
];

export function scaleById(id: string): PsychScale | undefined {
  return PSYCH_SCALES.find((s) => s.id === id);
}

/** One bank item. `reverse` items are keyed 6 − answer. */
interface BankItem {
  id: string;
  text: string;
  scale?: PsychScaleId;
  reverse?: boolean;
  /** A directed-response check: this many items is right, this one is not scored. */
  attention?: 1 | 2 | 3 | 4 | 5;
}

/**
 * 25 scored items (five per scale, two of them reverse-keyed) and two attention
 * checks that are never scored. Short on purpose: a 27-item form is about six
 * minutes, which is the point where completion rates stop collapsing.
 */
export const PSYCH_BANK: BankItem[] = [
  // نظم و پیگیری
  { id: 'c1', scale: 'conscientiousness', text: 'کارهایی را که شروع می‌کنم تا آخر می‌برم.' },
  { id: 'c2', scale: 'conscientiousness', text: 'پیش از ضرب‌الاجل، کارم را تمام می‌کنم.' },
  { id: 'c3', scale: 'conscientiousness', text: 'جزئیات کار را بررسی می‌کنم، حتی وقتی عجله داریم.' },
  { id: 'c4', scale: 'conscientiousness', reverse: true, text: 'چیزهای مهم را زیاد فراموش می‌کنم.' },
  { id: 'c5', scale: 'conscientiousness', reverse: true, text: 'کارها را به آخرین لحظه می‌سپارم.' },
  // همکاری و اعتماد
  { id: 'a1', scale: 'agreeableness', text: 'وقت می‌گذارم تا نگرانی هم‌تیمی‌ام را بفهمم.' },
  { id: 'a2', scale: 'agreeableness', text: 'در اختلاف، اول دنبال نقطهٔ مشترک می‌گردم.' },
  { id: 'a3', scale: 'agreeableness', text: 'اشتباه دیگران را راحت می‌بخشم.' },
  { id: 'a4', scale: 'agreeableness', reverse: true, text: 'برای رسیدن به هدفم، منافع دیگران را نادیده می‌گیرم.' },
  { id: 'a5', scale: 'agreeableness', reverse: true, text: 'به نیت همکارانم بدبین هستم.' },
  // ثبات هیجانی
  { id: 's1', scale: 'stability', text: 'در شرایط پرتنش آرام می‌مانم.' },
  { id: 's2', scale: 'stability', text: 'بازخورد تند را می‌شنوم و از کارم جدا می‌کنم.' },
  { id: 's3', scale: 'stability', text: 'بعد از یک روز سخت، خودم را سریع جمع می‌کنم.' },
  { id: 's4', scale: 'stability', reverse: true, text: 'با کوچک‌ترین انتقاد، ساعت‌ها فکرم مشغول می‌شود.' },
  { id: 's5', scale: 'stability', reverse: true, text: 'وقتی کار زیاد می‌شود، زود کلافه می‌شوم.' },
  // گشودگی به تجربه
  { id: 'o1', scale: 'openness', text: 'دوست دارم روش تازه را امتحان کنم، حتی اگر فعلی کار می‌کند.' },
  { id: 'o2', scale: 'openness', text: 'از موضوع‌های ناآشنا و پیچیده خوشم می‌آید.' },
  { id: 'o3', scale: 'openness', text: 'وقت می‌گذارم ایده‌های دیگران را بشنوم، حتی اگر با نظرم نخواند.' },
  { id: 'o4', scale: 'openness', reverse: true, text: 'ترجیح می‌دهم هیچ‌وقت روش کارم را عوض نکنم.' },
  { id: 'o5', scale: 'openness', reverse: true, text: 'مطالعه دربارهٔ چیزهایی که به کارم مربوط نیست، وقتم را تلف می‌کند.' },
  // ارتباط بیرونی
  { id: 'e1', scale: 'extraversion', text: 'در جمع‌های کاری راحت صحبت می‌کنم.' },
  { id: 'e2', scale: 'extraversion', text: 'تماس گرفتن با فرد ناشناس برایم دشوار نیست.' },
  { id: 'e3', scale: 'extraversion', text: 'وقتی چیزی را می‌فهمم، دوست دارم برای دیگران توضیحش بدهم.' },
  { id: 'e4', scale: 'extraversion', reverse: true, text: 'در جلسه ترجیح می‌دهم حرف نزنم.' },
  { id: 'e5', scale: 'extraversion', reverse: true, text: 'شبکه‌سازی کاری برایم خسته‌کننده است.' },
  // attention checks — never scored
  { id: 'x1', attention: 2, text: 'در این گزاره، برای اطمینان از دقت، گزینهٔ «مخالفم» را انتخاب کنید.' },
  { id: 'x2', attention: 5, text: 'در این گزاره، برای اطمینان از دقت، گزینهٔ «کاملاً موافقم» را انتخاب کنید.' },
];

const SCORED_ITEMS = PSYCH_BANK.filter((i) => i.scale);
const ATTENTION_ITEMS = PSYCH_BANK.filter((i) => i.attention);

/** The item list the candidate sees: no scale, no keying direction. */
export function publicItems(): PsychItemPublic[] {
  return PSYCH_BANK.map((i) =>
    i.attention
      ? { id: i.id, text: i.text, instruction: 'گزارهٔ کنترلی: پاسخ گفته‌شده را انتخاب کنید.' }
      : { id: i.id, text: i.text }
  );
}

export function scaleSummaries() {
  return PSYCH_SCALES.map((s) => ({
    ...s,
    itemCount: SCORED_ITEMS.filter((i) => i.scale === s.id).length,
  }));
}

// ----------------------------------------------------------------- scoring ---

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 on erf) — no dependency needed. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

interface RawScore {
  id: PsychScaleId;
  raw: number;
  min: number;
  max: number;
  percent: number;
}

/** Raw sum per scale, with reverse-keyed items flipped. */
export function rawScores(answers: PsychAnswers): RawScore[] {
  return PSYCH_SCALES.map((scale) => {
    const items = SCORED_ITEMS.filter((i) => i.scale === scale.id);
    let raw = 0;
    for (const item of items) {
      const v = answers[item.id];
      raw += item.reverse ? 6 - v : v;
    }
    const min = items.length;
    const max = items.length * 5;
    return { id: scale.id, raw, min, max, percent: Math.round(((raw - min) / (max - min)) * 100) };
  });
}

/** Quality indicators. Any flag makes the result unusable, and the page says why. */
export function qualityOf(answers: PsychAnswers, durationSeconds: number, minSecondsPerItem = MIN_SECONDS_PER_ITEM): PsychResult['quality'] {
  const flags: PsychFlag[] = [];
  const attentionPassed = ATTENTION_ITEMS.every((i) => answers[i.id] === i.attention);
  if (!attentionPassed) {
    flags.push({ code: 'ATTENTION', label: 'پاسخ به گزارهٔ کنترلی درست نبود — یعنی صفحه بدون خواندن پر شده است.' });
  }
  const values = PSYCH_BANK.map((i) => answers[i.id]).filter((v) => typeof v === 'number') as number[];
  const distinct = new Set(values).size;
  const longestRun = (() => {
    let best = 0;
    let run = 1;
    for (let i = 1; i < values.length; i++) {
      run = values[i] === values[i - 1] ? run + 1 : 1;
      if (run > best) best = run;
    }
    return Math.max(best, values.length ? 1 : 0);
  })();
  if (distinct <= 2 && values.length >= 10) {
    flags.push({ code: 'STRAIGHT_LINE', label: 'تقریباً همهٔ گزاره‌ها یک پاسخ گرفته‌اند («خط مستقیم»).' });
  } else if (longestRun >= 14) {
    flags.push({ code: 'STRAIGHT_LINE', label: `${longestRun} پاسخ پشت‌سرهم یکسان بوده است.` });
  }
  const perItem = durationSeconds / Math.max(1, PSYCH_BANK.length);
  if (minSecondsPerItem > 0 && perItem < minSecondsPerItem) {
    flags.push({
      code: 'TOO_FAST',
      label: `کل آزمون ${durationSeconds} ثانیه طول کشیده؛ کمتر از ${minSecondsPerItem} ثانیه برای هر گزاره با خواندن واقعی سازگار نیست.`,
    });
  }
  return { usable: flags.length === 0, flags, durationSeconds, attentionPassed };
}

/**
 * The norm a workspace has for a scale: an entered table wins, then its own
 * completed results once there are enough of them. Otherwise nothing.
 */
export function normFor(
  orgId: string,
  scale: RawScore[],
  config: PsychNormConfig | null
): { source: PsychNormSource | null; n: number | null; label: string; stats: Record<string, { mean: number; sd: number }> } {
  if (config && Number.isFinite(config.n) && config.n > 0) {
    const stats: Record<string, { mean: number; sd: number }> = {};
    for (const s of scale) {
      const row = config.scales?.[s.id];
      if (row && Number.isFinite(row.mean) && Number.isFinite(row.sd) && row.sd > 0) stats[s.id] = { mean: row.mean, sd: row.sd };
    }
    if (Object.keys(stats).length) {
      return { source: 'external', n: config.n, label: `${config.source || 'هنجار واردشده'} (n=${config.n})`, stats };
    }
  }
  // Internal norms: mean/sd of raw sums over this workspace's usable results.
  const usable = db
    .listPsychInvites(orgId)
    .filter((r) => r.status === 'submitted' && r.result && r.result.quality.usable);
  const stats: Record<string, { mean: number; sd: number }> = {};
  let minN = Number.POSITIVE_INFINITY;
  for (const s of scale) {
    const raws = usable.map((r) => r.result!.scales.find((x) => x.id === s.id)?.raw).filter((v): v is number => typeof v === 'number');
    if (raws.length < MIN_NORM_N) continue;
    const mean = raws.reduce((a, b) => a + b, 0) / raws.length;
    const sd = Math.sqrt(raws.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, raws.length - 1));
    if (!(sd > 0)) continue;
    stats[s.id] = { mean, sd };
    minN = Math.min(minN, raws.length);
  }
  if (Object.keys(stats).length) {
    const n = Number.isFinite(minN) ? minN : usable.length;
    return { source: 'internal', n, label: `هنجار داخلی این فضای کاری (n=${n})`, stats };
  }
  return { source: null, n: null, label: 'بدون هنجار', stats: {} };
}

/** Full result: raw bands always, percentiles only where a norm exists. */
export function scoreTest(orgId: string, answers: PsychAnswers, durationSeconds: number, atISO: string): PsychResult {
  const config = db.getPsychNorms(orgId);
  const quality = qualityOf(answers, durationSeconds);
  const raw = rawScores(answers);
  const norm = normFor(orgId, raw, config);
  const scales: PsychScaleScore[] = raw.map((s) => {
    const label = scaleById(s.id)?.label || s.id;
    const stat = quality.usable ? norm.stats[s.id] : undefined;
    const percentile = stat ? clamp(Math.round(normalCdf((s.raw - stat.mean) / stat.sd) * 100), 1, 99) : null;
    return {
      id: s.id,
      label,
      raw: s.raw,
      min: s.min,
      max: s.max,
      percent: s.percent,
      percentile,
      normSource: percentile === null ? null : norm.source,
    };
  });
  const used = scales.filter((s) => s.percentile !== null).length;
  return {
    scales,
    quality,
    norm: {
      source: used ? norm.source : null,
      n: used ? norm.n : null,
      label: used ? norm.label : quality.usable ? 'بدون هنجار' : 'نتیجه قابل اتکا نیست',
    },
    submittedAtISO: atISO,
    submittedAtJalali: jalali(atISO) || '',
  };
}

// ------------------------------------------------------------ invitations ---

export function inviteView(baseUrl: string, row: db.PsychInviteRow): PsychInvite {
  return {
    id: row.id,
    resumeId: row.resumeId,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    candidateName: row.candidateName,
    candidateEmail: row.candidateEmail,
    status: row.status,
    createdAtISO: row.createdAtISO,
    createdAtJalali: jalali(row.createdAtISO) || '',
    sentAtISO: row.sentAtISO,
    startedAtISO: row.startedAtISO,
    submittedAtISO: row.submittedAtISO,
    submittedAtJalali: jalali(row.submittedAtISO),
    expiresAtISO: row.expiresAtISO,
    result: row.result,
    url: `${baseUrl.replace(/\/$/, '')}/psych/${row.token}`,
  };
}

export function publicView(baseUrl: string, row: db.PsychInviteRow): PublicPsychTest {
  const org = db.getOrg(row.orgId);
  const stale = !['submitted', 'cancelled', 'declined'].includes(row.status) && new Date(row.expiresAtISO).getTime() < Date.now();
  return {
    org: { name: org?.name || '' },
    candidateName: row.candidateName,
    jobTitle: row.jobTitle || null,
    status: stale ? 'expired' : row.status,
    expiresAtISO: row.expiresAtISO,
    intro:
      'این پرسش‌ها درست و غلط ندارند. هر گزاره را بر اساس رفتار واقعی خودتان در سه ماه گذشته پاسخ دهید، نه آنچه خوب به نظر می‌رسد. حدود ۶ دقیقه.',
    aboutMinutes: 6,
    scale: PSYCH_SCALE_POINTS.map((p) => ({ value: p.value, label: p.label })),
    items: publicItems(),
    submittedAtISO: row.submittedAtISO,
  };
  void baseUrl;
}

function ttlExpiry(): string {
  return new Date(Date.now() + PSYCH_TTL_DAYS * 86_400_000).toISOString();
}

export function createInvite(orgId: string, actor: { id: string; name: string }, input: { resumeId?: unknown }): db.PsychInviteRow {
  const rec = db.getResume(orgId, String(input.resumeId || ''));
  if (!rec) throw new PsychError('رزومه پیدا نشد.', 404, 'RESUME_NOT_FOUND');
  const live = db.listPsychInvites(orgId, { resumeId: rec.id }).find((r) => r.status === 'sent' || r.status === 'started');
  if (live) throw new PsychError('برای این کارجو یک آزمون باز وجود دارد؛ همان لینک را بفرستید یا لغو کنید.', 409, 'INVITE_OPEN');
  const job = db.getJob(orgId, rec.jobId);
  const now = new Date().toISOString();
  const row: db.PsychInviteRow = {
    id: db.uid('psy'),
    orgId,
    resumeId: rec.id,
    jobId: rec.jobId,
    jobTitle: job?.roleTitle || '',
    candidateName: rec.candidateName || 'کارجو',
    candidateEmail: (rec.contact?.email || '').toLowerCase() || null,
    status: 'sent',
    token: crypto.randomBytes(18).toString('base64url'),
    createdAtISO: now,
    sentAtISO: null,
    startedAtISO: null,
    submittedAtISO: null,
    submittedAtJalali: null,
    expiresAtISO: ttlExpiry(),
    answers: null,
    result: null,
    sentByName: actor.name,
  };
  db.savePsychInvite(row);
  return row;
}

export function invitationText(row: db.PsychInviteRow, orgName: string, url: string): { subject: string; body: string } {
  return {
    subject: `یک پرسش‌نامهٔ کوتاه (حدود ۶ دقیقه) — ${orgName}`,
    body: [
      `${row.candidateName} عزیز،`,
      '',
      'برای این‌که در گفت‌وگویمان از نقطهٔ درست شروع کنیم، یک پرسش‌نامهٔ کوتاه دربارهٔ شیوهٔ کار در نظر گرفته‌ایم.',
      '',
      'پرسش‌ها درست و غلط ندارند و نتیجه‌اش به‌تنهایی مبنای هیچ تصمیمی نیست؛ فقط موضوع گفت‌وگو را دقیق‌تر می‌کند.',
      '',
      url,
      '',
      'اگر ترجیح می‌دهید این مرحله را انجام ندهید، در همان صفحه اطلاع دهید — این انتخاب هیچ اثری در بررسی شما ندارد.',
      '',
      'با احترام،',
      orgName,
    ].join('\n'),
  };
}

export async function sendInvite(orgId: string, id: string, baseUrl: string, actor: { id: string; name: string }): Promise<db.PsychInviteRow> {
  const row = db.getPsychInvite(orgId, id);
  if (!row) throw new PsychError('آزمون پیدا نشد.', 404, 'INVITE_NOT_FOUND');
  if (row.status === 'submitted') throw new PsychError('این آزمون تکمیل شده است.', 409, 'ALREADY_SUBMITTED');
  if (row.status === 'cancelled' || row.status === 'declined') throw new PsychError('این دعوت بسته شده است؛ دعوت تازه بسازید.', 409, 'INVITE_CLOSED');
  if (!row.candidateEmail) throw new PsychError('برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و خودتان بفرستید.', 409, 'NO_EMAIL');
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new PsychError('صندوق ایمیل سازمان وصل نیست؛ لینک را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  if (!withinEmailLimit(orgId)) throw new PsychError('سقف ارسال ساعتی این فضای کاری پر شده است.', 429, 'EMAIL_LIMIT');
  const org = db.getOrg(orgId);
  const { subject, body } = invitationText(row, org?.name || 'سازمان', `${baseUrl.replace(/\/$/, '')}/psych/${row.token}`);
  try {
    await sendMail(secrets.email!, { to: row.candidateEmail, subject, text: body, brand: mailBrandOf(org) });
    noteEmailSend(orgId);
  } catch (err: any) {
    throw new PsychError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  const next = db.savePsychInvite({ ...row, sentAtISO: new Date().toISOString(), sentByName: actor.name });
  db.logActivity(orgId, actor, 'psych.sent', `پرسش‌نامهٔ سنجش برای «${row.candidateName}» فرستاده شد`, { resumeId: row.resumeId });
  return next;
}

export function cancel(orgId: string, id: string, actor: { id: string; name: string }): db.PsychInviteRow {
  const row = db.getPsychInvite(orgId, id);
  if (!row) throw new PsychError('آزمون پیدا نشد.', 404, 'INVITE_NOT_FOUND');
  if (row.status === 'submitted') throw new PsychError('این آزمون تکمیل شده است؛ لغو، نتیجه را پاک نمی‌کند.', 409, 'ALREADY_SUBMITTED');
  const next = db.savePsychInvite({ ...row, status: 'cancelled' });
  db.logActivity(orgId, actor, 'psych.cancelled', `دعوت سنجش «${row.candidateName}» لغو شد`, { resumeId: row.resumeId });
  return next;
}

export function decline(token: string, baseUrl: string): db.PsychInviteRow {
  const row = db.findPsychInviteByToken(token);
  if (!row) throw new PsychError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') throw new PsychError('پاسخ شما ثبت شده است.', 409, 'ALREADY_SUBMITTED');
  const next = db.savePsychInvite({ ...row, status: 'declined' });
  db.logActivity(row.orgId, null, 'psych.declined', `«${row.candidateName}» پرسش‌نامهٔ سنجش را نپذیرفت`, { resumeId: row.resumeId });
  return next;
}

function expired(row: db.PsychInviteRow): boolean {
  return row.status !== 'submitted' && new Date(row.expiresAtISO).getTime() < Date.now();
}

/** Opening the test starts the clock — used only to spot impossible speed. */
export function start(token: string): db.PsychInviteRow {
  const row = db.findPsychInviteByToken(token);
  if (!row) throw new PsychError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') return row;
  if (row.status === 'cancelled' || row.status === 'declined') throw new PsychError('این دعوت بسته شده است.', 409, 'INVITE_CLOSED');
  if (expired(row)) throw new PsychError('مهلت این آزمون تمام شده است.', 409, 'EXPIRED');
  if (row.startedAtISO) return row;
  return db.savePsychInvite({ ...row, status: 'started', startedAtISO: new Date().toISOString() });
}

export function submit(token: string): db.PsychInviteRow {
  const row = db.findPsychInviteByToken(token);
  if (!row) throw new PsychError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') throw new PsychError('پاسخ شما پیش‌تر ثبت شده است؛ سپاسگزاریم.', 409, 'ALREADY_SUBMITTED');
  if (row.status === 'cancelled' || row.status === 'declined') throw new PsychError('این دعوت بسته شده است.', 409, 'INVITE_CLOSED');
  if (expired(row)) throw new PsychError('مهلت این آزمون تمام شده است.', 409, 'EXPIRED');
  // Never accept a half-filled form: unanswered items would be scored as neutral.
  const answers = row.answers;
  if (!answers) throw new PsychError('پاسخی برای سنجش ثبت نشده است.', 400, 'NO_ANSWERS');
  const missing = PSYCH_BANK.filter((i) => typeof answers[i.id] !== 'number');
  if (missing.length) throw new PsychError(`به ${missing.length} گزاره پاسخ داده نشده است.`, 400, 'INCOMPLETE');
  const started = row.startedAtISO ? new Date(row.startedAtISO).getTime() : Date.now();
  const durationSeconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  const atISO = new Date().toISOString();
  const result = scoreTest(row.orgId, answers, durationSeconds, atISO);
  const next = db.savePsychInvite({
    ...row,
    status: 'submitted',
    startedAtISO: row.startedAtISO || atISO,
    submittedAtISO: atISO,
    submittedAtJalali: jalali(atISO),
    result,
  });
  db.logActivity(
    row.orgId,
    null,
    'psych.submitted',
    result.quality.usable
      ? `«${row.candidateName}» پرسش‌نامهٔ سنجش را تکمیل کرد`
      : `«${row.candidateName}» پرسش‌نامه را تکمیل کرد، اما نتیجه نیازمند بازبینی است`,
    { resumeId: row.resumeId }
  );
  return next;
}

/** Saving answers is separate from submitting, so a refresh does not lose work. */
export function saveAnswers(token: string, answers: unknown): db.PsychInviteRow {
  const row = db.findPsychInviteByToken(token);
  if (!row) throw new PsychError('این لینک معتبر نیست.', 404, 'TOKEN_NOT_FOUND');
  if (row.status === 'submitted') throw new PsychError('پاسخ شما ثبت شده است.', 409, 'ALREADY_SUBMITTED');
  if (row.status === 'cancelled' || row.status === 'declined') throw new PsychError('این دعوت بسته شده است.', 409, 'INVITE_CLOSED');
  if (expired(row)) throw new PsychError('مهلت این آزمون تمام شده است.', 409, 'EXPIRED');
  const clean: PsychAnswers = {};
  if (answers && typeof answers === 'object') {
    for (const item of PSYCH_BANK) {
      const v = (answers as Record<string, unknown>)[item.id];
      if (typeof v === 'number' && v >= 1 && v <= 5 && Number.isInteger(v)) clean[item.id] = v as 1 | 2 | 3 | 4 | 5;
    }
  }
  return db.savePsychInvite({ ...row, answers: clean, status: row.status === 'sent' ? 'started' : row.status, startedAtISO: row.startedAtISO || new Date().toISOString() });
}

// ----------------------------------------------------------- group report ---

/**
 * Averages across a job's candidates. Below five people the averages are
 * suppressed — an "average" of three is a person with a decimal point.
 */
export function groupReport(orgId: string, jobId: string): PsychGroupReport {
  const job = db.getJob(orgId, jobId);
  if (!job) throw new PsychError('آگهی پیدا نشد.', 404, 'JOB_NOT_FOUND');
  const rows = db
    .listPsychInvites(orgId, { jobId })
    .filter((r) => r.status === 'submitted' && r.result);
  const usable = rows.filter((r) => r.result!.quality.usable);
  const reportRows = rows.map((r) => {
    const percentiles: Record<string, number | null> = {};
    for (const s of r.result!.scales) percentiles[s.id] = s.percentile;
    return {
      resumeId: r.resumeId,
      candidateName: r.candidateName,
      jobTitle: r.jobTitle,
      submittedAtJalali: r.submittedAtJalali || '',
      usable: r.result!.quality.usable,
      percentiles,
    };
  });
  const scales = PSYCH_SCALES.map((scale) => {
    const values = usable
      .map((r) => r.result!.scales.find((s) => s.id === scale.id)?.percentile)
      .filter((v): v is number => typeof v === 'number');
    const suppressed = values.length < SMALL_GROUP;
    return {
      id: scale.id,
      label: scale.label,
      n: values.length,
      meanPercentile: suppressed || !values.length ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      suppressed,
      min: suppressed || !values.length ? null : Math.min(...values),
      max: suppressed || !values.length ? null : Math.max(...values),
    };
  });
  const first = usable[0]?.result;
  return {
    jobId,
    jobTitle: job.roleTitle,
    n: usable.length,
    norm: first ? first.norm : { source: null, n: null, label: 'بدون هنجار' },
    scales,
    rows: reportRows,
    suppressed: usable.length < SMALL_GROUP,
  };
}

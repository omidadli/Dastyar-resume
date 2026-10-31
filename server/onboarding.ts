/**
 * «تحویل پس از استخدام» — the checklist that starts when the offer is signed.
 *
 * Rules this file keeps:
 *   - **Only a hired candidate.** A plan for someone still in screening would
 *     quietly promise a laptop to a person nobody has decided about.
 *   - **The date is a Jalali day, stored as a Tehran instant.** «۱ آذر» must mean
 *     the same day in Tehran whatever the server's timezone is.
 *   - **Nothing leaves without a click.** The welcome e-mail is a button, sent
 *     from the workspace's own mailbox, and the UI says when no mailbox exists.
 *   - **Completion is earned by ticks.** The status follows the checklist; HR
 *     cannot mark a plan «کامل» while the laptop box is empty.
 */
import * as db from './db';
import { isEmailConfigured, sendMail, friendlySmtpError } from './mailer';
import { formatJalaliDate, parseJalaliDateString, toJalaliDateString, toPersianDigits } from '../src/utils/jalali';
import { jalaliAndTehranTime, tehranIsoFromJalali, tehranJalaliOf } from './tehran-time';
import { withinEmailLimit, noteEmailSend } from './email-rate';
import { DEFAULT_ONBOARDING_TASKS } from '../src/types/onboarding';
import type { OnboardingPlan, OnboardingStatus, OnboardingTask } from '../src/types/onboarding';
import type { ResumeRecord } from '../src/types/screening';

export class OnboardingError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'ONBOARDING_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DAY = 86_400_000;

function hiredNow(orgId: string, rec: ResumeRecord): boolean {
  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  const stage = db.stagesOf(job).find((s) => s.id === rec.stageId);
  return stage?.kind === 'hired';
}

/** Days between today (Tehran) and the start date; negative once it passed. */
function daysUntil(startISO: string): number {
  const start = new Date(startISO);
  if (isNaN(start.getTime())) return 0;
  const today = tehranJalaliOf(new Date());
  const target = tehranJalaliOf(start);
  const a = Date.UTC(today.year, today.month - 1, today.day);
  const b = Date.UTC(target.year, target.month - 1, target.day);
  return Math.round((b - a) / DAY);
}

function statusFrom(tasks: OnboardingTask[], current: OnboardingStatus): OnboardingStatus {
  if (current === 'cancelled') return current;
  const done = tasks.filter((t) => t.done).length;
  if (!tasks.length) return 'planned';
  if (done === tasks.length) return 'completed';
  return done > 0 ? 'in_progress' : 'planned';
}

export function viewOf(row: db.OnboardingRow): OnboardingPlan {
  const { orgId: _o, ...rest } = row;
  const doneCount = row.tasks.filter((t) => t.done).length;
  return {
    ...rest,
    status: statusFrom(row.tasks, row.status),
    doneCount,
    total: row.tasks.length,
    daysUntil: daysUntil(row.startDateISO),
  };
}

/** A Jalali day («۱۴۰۵/۰۹/۰۱») or an ISO instant → the Tehran start-of-day ISO. */
export function startInstantOf(input: { startDateJalali?: unknown; startDateISO?: unknown }): { iso: string; jalali: string } | null {
  const raw = typeof input.startDateJalali === 'string' ? input.startDateJalali.trim() : '';
  if (raw) {
    const day = parseJalaliDateString(raw);
    if (!day) return null;
    const canonical = toJalaliDateString(day.year, day.month, day.day);
    const iso = tehranIsoFromJalali(canonical, '09:00');
    if (!iso) return null;
    return { iso, jalali: canonical };
  }
  const isoInput = typeof input.startDateISO === 'string' ? input.startDateISO.trim() : '';
  if (isoInput) {
    const d = new Date(isoInput);
    if (isNaN(d.getTime())) return null;
    const parts = jalaliAndTehranTime(d.toISOString());
    const day = parseJalaliDateString(parts.date);
    if (!day) return null;
    const canonical = toJalaliDateString(day.year, day.month, day.day);
    const iso = tehranIsoFromJalali(canonical, '09:00');
    if (!iso) return null;
    return { iso, jalali: canonical };
  }
  return null;
}

function tasksFromLabels(labels: string[]): OnboardingTask[] {
  return labels.map((label, i) => ({ id: `t${i + 1}`, label: label.slice(0, 160), done: false, doneAtISO: null, doneByName: null }));
}

export function createPlan(
  orgId: string,
  actor: { id: string; name: string } | null,
  input: { resumeId?: unknown; startDateJalali?: unknown; startDateISO?: unknown; ownerName?: unknown; note?: unknown }
): db.OnboardingRow {
  const resumeId = typeof input.resumeId === 'string' ? input.resumeId : '';
  const rec = resumeId ? db.getResume(orgId, resumeId) : null;
  if (!rec) throw new OnboardingError('رزومه یافت نشد.', 404, 'RESUME_NOT_FOUND');
  if (!hiredNow(orgId, rec)) {
    throw new OnboardingError(
      'این کارجو هنوز در ستون «استخدام‌شده» نیست. اول پیشنهاد شغلی را بفرستید و پذیرش را ثبت کنید؛ تحویل پس از استخدام از همان لحظه معنا دارد.',
      409,
      'NOT_HIRED'
    );
  }
  const existing = db.onboardingFor(orgId, rec.id);
  if (existing) throw new OnboardingError('برای این کارجو یک برنامهٔ تحویل باز وجود دارد؛ همان را ادامه دهید.', 409, 'PLAN_EXISTS');

  // A date the user typed must be a real day; the default only covers «no date».
  const wanted = [input.startDateJalali, input.startDateISO].some((v) => typeof v === 'string' && v.trim());
  const parsedStart = startInstantOf(input);
  if (wanted && !parsedStart) throw new OnboardingError('تاریخ شروع معتبر نیست؛ روز و ماه شمسی را بررسی کنید.', 400, 'BAD_START_DATE');
  const start =
    parsedStart ||
    (() => {
      // No date given: two weeks out, still as a Tehran start-of-day.
      const later = new Date(Date.now() + 14 * DAY);
      const parts = jalaliAndTehranTime(later.toISOString());
      const day = parseJalaliDateString(parts.date);
      if (!day) return null;
      const canonical = toJalaliDateString(day.year, day.month, day.day);
      const iso = tehranIsoFromJalali(canonical, '09:00');
      return iso ? { iso, jalali: canonical } : null;
    })();
  if (!start) throw new OnboardingError('تاریخ شروع معتبر نیست؛ روز و ماه شمسی را بررسی کنید.', 400, 'BAD_START_DATE');

  const job = rec.jobId ? db.getJob(orgId, rec.jobId) : null;
  const row: db.OnboardingRow = {
    id: db.uid('onb'),
    orgId,
    resumeId: rec.id,
    jobId: rec.jobId || null,
    jobTitle: job?.roleTitle || null,
    departmentName: job?.departmentName || null,
    candidateName: rec.candidateName || rec.fileName || 'کارجو',
    candidateEmail: rec.contact?.email?.toLowerCase() || null,
    startDateISO: start.iso,
    startDateJalali: start.jalali,
    ownerName: typeof input.ownerName === 'string' && input.ownerName.trim() ? input.ownerName.trim().slice(0, 80) : null,
    status: 'planned',
    tasks: tasksFromLabels(DEFAULT_ONBOARDING_TASKS),
    note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 800) : null,
    welcomeSentAtISO: null,
    createdAtISO: new Date().toISOString(),
    createdByName: actor?.name || null,
  };
  db.saveOnboarding(row);
  db.logActivity(orgId, actor, 'onboarding.started', `تحویل پس از استخدام «${row.candidateName}» را از ${row.startDateJalali} آغاز کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return row;
}

export function updatePlan(
  orgId: string,
  id: string,
  input: { startDateJalali?: unknown; startDateISO?: unknown; ownerName?: unknown; note?: unknown },
  actor: { id: string; name: string } | null
): db.OnboardingRow {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  const next: db.OnboardingRow = { ...row };
  if (input.startDateJalali !== undefined || input.startDateISO !== undefined) {
    const start = startInstantOf({ startDateJalali: input.startDateJalali, startDateISO: input.startDateISO });
    if (!start) throw new OnboardingError('تاریخ شروع معتبر نیست.', 400, 'BAD_START_DATE');
    next.startDateISO = start.iso;
    next.startDateJalali = start.jalali;
  }
  if (input.ownerName !== undefined) {
    next.ownerName = typeof input.ownerName === 'string' && input.ownerName.trim() ? input.ownerName.trim().slice(0, 80) : null;
  }
  if (input.note !== undefined) {
    next.note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 800) : null;
  }
  const saved = db.saveOnboarding(next);
  db.logActivity(orgId, actor, 'onboarding.started', `برنامهٔ تحویل «${row.candidateName}» را ویرایش کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return saved;
}

export function toggleTask(orgId: string, id: string, taskId: string, actor: { id: string; name: string } | null): db.OnboardingRow {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  if (row.status === 'cancelled') throw new OnboardingError('این برنامه لغو شده است.', 409, 'CANCELLED');
  const task = row.tasks.find((t) => t.id === taskId);
  if (!task) throw new OnboardingError('این مورد در چک‌لیست نیست.', 404, 'TASK_NOT_FOUND');
  const nowDone = !task.done;
  const tasks = row.tasks.map((t) =>
    t.id === taskId
      ? { ...t, done: nowDone, doneAtISO: nowDone ? new Date().toISOString() : null, doneByName: nowDone ? actor?.name || null : null }
      : t
  );
  const wasComplete = row.status === 'completed';
  const status = statusFrom(tasks, row.status);
  const saved = db.saveOnboarding({ ...row, tasks, status });
  if (!wasComplete && status === 'completed') {
    db.logActivity(orgId, actor, 'onboarding.completed', `تحویل پس از استخدام «${row.candidateName}» کامل شد`, {
      jobId: row.jobId,
      resumeId: row.resumeId,
    });
  }
  return saved;
}

/** Adds one more line to the checklist — every company has its own extra step. */
export function addTask(
  orgId: string,
  id: string,
  label: unknown,
  actor: { id: string; name: string } | null
): db.OnboardingRow {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  const text = typeof label === 'string' ? label.trim().slice(0, 160) : '';
  if (text.length < 3) throw new OnboardingError('متن مورد چک‌لیست خیلی کوتاه است.', 400, 'TASK_TOO_SHORT');
  if (row.tasks.length >= 24) throw new OnboardingError('بیش از ۲۴ مورد، چک‌لیست را غیرقابل استفاده می‌کند.', 400, 'TOO_MANY_TASKS');
  const task: OnboardingTask = { id: db.uid('tsk'), label: text, done: false, doneAtISO: null, doneByName: null };
  const tasks = [...row.tasks, task];
  return db.saveOnboarding({ ...row, tasks, status: statusFrom(tasks, row.status) });
}

export function removeTask(orgId: string, id: string, taskId: string): db.OnboardingRow {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  const tasks = row.tasks.filter((t) => t.id !== taskId);
  if (!tasks.length) throw new OnboardingError('چک‌لیست نمی‌تواند خالی شود.', 400, 'LAST_TASK');
  return db.saveOnboarding({ ...row, tasks, status: statusFrom(tasks, row.status) });
}

export function cancelPlan(orgId: string, id: string, actor: { id: string; name: string } | null): db.OnboardingRow {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  const saved = db.saveOnboarding({ ...row, status: 'cancelled' });
  db.logActivity(orgId, actor, 'onboarding.started', `برنامهٔ تحویل «${row.candidateName}» را لغو کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return saved;
}

export function removePlan(orgId: string, id: string, actor: { id: string; name: string } | null): boolean {
  const row = db.getOnboarding(orgId, id);
  if (!row) return false;
  db.deleteOnboarding(orgId, id);
  db.logActivity(orgId, actor, 'onboarding.started', `برنامهٔ تحویل «${row.candidateName}» را پاک کرد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return true;
}

/** The welcome mail: short, names the day, and says who to ask. */
export function welcomeText(row: db.OnboardingRow, orgName: string): { subject: string; body: string } {
  const tasks = row.tasks.slice(0, 5).map((t) => `• ${t.label}`);
  return {
    subject: `خوش آمدید به ${orgName} — شروع کار از ${row.startDateJalali}`,
    body: [
      `${row.candidateName} عزیز،`,
      '',
      `خوشحالیم که به ${orgName} می‌پیوندید.${row.jobTitle ? ` نقش شما «${row.jobTitle}» است و` : ''} روز اول شما ${row.startDateJalali} است.`,
      row.ownerName ? `هماهنگی‌های روز اول با ${row.ownerName} است؛ هر سؤالی داشتید از ایشان بپرسید.` : '',
      '',
      'چیزهایی که تا روز اول آماده می‌شود:',
      ...tasks,
      '',
      'اگر مدارکی لازم است که هنوز نفرستاده‌اید، همین ایمیل را پاسخ دهید.',
      '',
      'با احترام،',
      orgName,
    ]
      .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
      .join('\n'),
  };
}

export async function sendWelcome(
  orgId: string,
  id: string,
  actor: { id: string; name: string } | null
): Promise<{ plan: db.OnboardingRow; emailed: boolean }> {
  const row = db.getOnboarding(orgId, id);
  if (!row) throw new OnboardingError('این برنامهٔ تحویل پیدا نشد.', 404, 'NOT_FOUND');
  if (row.status === 'cancelled') throw new OnboardingError('این برنامه لغو شده است.', 409, 'CANCELLED');
  if (!row.candidateEmail) {
    throw new OnboardingError('برای این کارجو ایمیل ثبت نشده است؛ متن را کپی کنید و از صندوق خودتان بفرستید.', 409, 'NO_EMAIL');
  }
  const secrets = db.resolveOrgSecrets(orgId);
  if (!isEmailConfigured(secrets)) {
    throw new OnboardingError('ایمیل سازمان وصل نیست؛ متن را کپی کنید و از صندوق خودتان بفرستید.', 409, 'EMAIL_NOT_CONFIGURED');
  }
  if (!withinEmailLimit(orgId)) {
    throw new OnboardingError('سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد دوباره تلاش کنید.', 429, 'EMAIL_RATE_LIMITED');
  }
  const org = db.getOrg(orgId);
  const { subject, body } = welcomeText(row, org?.name || 'سازمان');
  const stamp = new Date();
  const logged = {
    id: db.uid('eml'),
    orgId,
    resumeId: row.resumeId,
    candidateName: row.candidateName,
    jobId: row.jobId,
    to: row.candidateEmail,
    subject,
    body,
    status: 'sent' as const,
    error: null,
    sentAtISO: stamp.toISOString(),
    sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    sentByName: actor?.name || null,
    attachments: [],
  };
  try {
    await sendMail(secrets.email!, { to: row.candidateEmail, subject, text: body });
    noteEmailSend(orgId);
  } catch (err: any) {
    // The failure is part of the candidate's history too — not a silent no-op.
    db.saveEmail({ ...logged, status: 'failed', error: friendlySmtpError(err) });
    throw new OnboardingError(friendlySmtpError(err), 502, 'EMAIL_FAILED');
  }
  db.saveEmail(logged);
  const saved = db.saveOnboarding({ ...row, welcomeSentAtISO: new Date().toISOString() });
  db.logActivity(orgId, actor, 'onboarding.started', `پیام خوش‌آمد را برای «${row.candidateName}» فرستاد`, {
    jobId: row.jobId,
    resumeId: row.resumeId,
  });
  return { plan: saved, emailed: true };
}

/** Progress line for the activity feed and the sales demo. */
export function summaryLine(row: db.OnboardingRow): string {
  const done = row.tasks.filter((t) => t.done).length;
  return `${toPersianDigits(done)} از ${toPersianDigits(row.tasks.length)}`;
}

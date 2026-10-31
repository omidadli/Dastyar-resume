/**
 * «یادآوری مصاحبه» — one day before the interview, from the workspace's own
 * mailbox, to the candidate (and the interviewers).
 *
 * Rules that matter:
 *   • only interviews that are still `scheduled` and not yet reminded;
 *   • only when the workspace really has a mailbox (no fake success);
 *   • each interview is reminded at most once, ever (a restart or a second run
 *     cannot send the same reminder twice);
 *   • a failure is logged per interview and never blocks the others.
 *
 * The runner is called by a timer in server.ts and can be triggered by hand from
 * the admin panel / a cron job (`POST /api/interviews/reminders`).
 */
import * as db from './db';
import { friendlySmtpError, sendMail } from './mailer';
import { formatJalaliDate, toPersianDigits } from '../src/utils/jalali';
import { jalaliAndTehranTime, tehranJalaliOf } from './tehran-time';

export interface ReminderOutcome {
  /** How many interviews fall inside the window right now. */
  due: number;
  sent: number;
  /** Interviews skipped with a reason (no mailbox, no address, no notes…). */
  skipped: Array<{ interviewId: string; reason: string }>;
  failed: Array<{ interviewId: string; error: string }>;
  /** ISO instant the run happened. */
  atISO: string;
}

/** Hours before the interview when the reminder goes out (env override). */
export function reminderHours(): number {
  const n = Number(process.env.INTERVIEW_REMINDER_HOURS);
  return Number.isFinite(n) && n > 0 ? Math.min(24 * 7, Math.round(n)) : 24;
}

/** Set `INTERVIEW_REMINDERS=off` to stop the automatic timer. */
export function remindersEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test(String(process.env.INTERVIEW_REMINDERS || '').trim());
}

function bodyFor(row: db.InterviewRecordRow, organizer: string): string {
  const when = jalaliAndTehranTime(row.startsAtISO);
  const jalali = tehranJalaliOf(new Date(row.startsAtISO));
  const lines = [
    `${row.candidateName} عزیز،`,
    '',
    `یادآوری می‌کنیم جلسهٔ «${row.title}» ${formatJalaliDate(jalali, true)} ساعت ${toPersianDigits(when.time)} به وقت تهران برگزار می‌شود.`,
    '',
    `فرصت شغلی: ${row.jobTitle}`,
  ];
  if (row.location) lines.push(`محل برگزاری: ${row.location}`);
  if (row.meetLink) lines.push(`لینک جلسهٔ آنلاین: ${row.meetLink}`);
  if (row.interviewerNames.length) lines.push(`مصاحبه‌کننده‌ها: ${row.interviewerNames.join('، ')}`);
  if (row.notes) lines.push('', `توضیح: ${row.notes}`);
  lines.push('', 'اگر این زمان برای شما مناسب نیست، همین ایمیل را پاسخ دهید تا زمان دیگری هماهنگ کنیم.', '', organizer);
  return lines.join('\n');
}

/**
 * Sends every reminder that is due now. Safe to call often: it is idempotent
 * through `reminderSentAtISO` on the interview.
 */
export async function sendInterviewReminders(now = new Date(), orgId?: string): Promise<ReminderOutcome> {
  const atISO = now.toISOString();
  const hours = reminderHours();
  const untilISO = new Date(now.getTime() + hours * 3600_000).toISOString();
  // A manual run is always scoped to the caller's workspace; only the timer
  // (no orgId) sweeps every workspace.
  const rows = db
    .listInterviewsForReminder(atISO, untilISO)
    .filter((row) => !orgId || row.orgId === orgId);
  const outcome: ReminderOutcome = { due: rows.length, sent: 0, skipped: [], failed: [], atISO };

  for (const row of rows) {
    const secrets = db.resolveOrgSecrets(row.orgId).email;
    if (!secrets) {
      outcome.skipped.push({ interviewId: row.id, reason: 'صندوق ایمیل این فضای کاری وصل نیست' });
      continue;
    }
    if (!row.candidateEmail) {
      outcome.skipped.push({ interviewId: row.id, reason: 'کارجو ایمیل ندارد' });
      continue;
    }
    const organizer = secrets.fromName || secrets.fromAddress;
    const recipients = Array.from(
      new Set([row.candidateEmail, ...(row.interviewerEmails || [])].map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))
    );
    try {
      await sendMail(secrets, {
        to: recipients.join(', '),
        subject: `یادآوری مصاحبه — ${row.title}`,
        text: bodyFor(row, organizer),
      });
      // Marked only after the SMTP server accepted the message.
      row.reminderSentAtISO = atISO;
      db.saveInterview(row);
      db.logActivity(row.orgId, null, 'interview.reminder', `یادآوری مصاحبهٔ «${row.candidateName}» فرستاده شد`, {
        jobId: row.jobId,
      });
      outcome.sent += 1;
    } catch (err: any) {
      outcome.failed.push({ interviewId: row.id, error: friendlySmtpError(err) });
      console.error('[reminders]', row.id, err?.message || err);
    }
  }
  return outcome;
}

/** Called by the server timer; never throws into the timer. */
export async function runRemindersQuietly(): Promise<void> {
  try {
    const result = await sendInterviewReminders();
    if (result.sent || result.failed.length) {
      console.log(`[reminders] due=${result.due} sent=${result.sent} failed=${result.failed.length} skipped=${result.skipped.length}`);
    }
  } catch (err: any) {
    console.error('[reminders] run failed:', err?.message || err);
  }
}

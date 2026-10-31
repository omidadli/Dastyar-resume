/**
 * «ثبت جلسهٔ مصاحبه» — one implementation for the two ways an interview is
 * booked: the recruiter's dialog and an approved automation proposal.
 *
 * It never loses the interview because Google is down: the record is saved
 * first, the calendar error is reported separately, and the workspace mailbox
 * sends the invitation (with an .ics) whenever Google could not.
 */
import * as db from './db';
import type { OrgPublic, UserPublic } from '../src/types/app';
import { friendlySmtpError, isEmailConfigured, sendMail } from './mailer';
import { buildInviteIcs, CalendarError, accessTokenFor, createEvent } from './gcal';
import { decryptSecret, encryptSecret } from './secret';
import { noteEmailSend, withinEmailLimit } from './email-rate';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranIsoFromJalali, tehranJalaliOf } from './tehran-time';
import { str } from './routes/util';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** A refusal the caller can turn into a 4xx answer with this exact message. */
export class InterviewInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface BookInterviewResult {
  interview: ReturnType<typeof publicInterview>;
  calendarError: string | null;
  emailError: string | null;
  record: ReturnType<typeof db.toListItem> | null;
}

function publicInterview(row: db.InterviewRecordRow) {
  const { orgId: _o, ...rest } = row;
  return rest;
}

function candidateEmailOf(rec: { contact?: { email?: string | null } | null }): string | null {
  const email = rec.contact?.email?.trim().toLowerCase();
  return email && EMAIL_RE.test(email) ? email : null;
}

export async function bookInterview(input: {
  org: OrgPublic;
  user: UserPublic | { id: string; name: string };
  body: any;
}): Promise<BookInterviewResult> {
  const { org, user } = input;
  const body = input.body || {};

  const jobId = str(body?.jobId, 80);
  const job = db.getJob(org.id, jobId);
  if (!job) throw new InterviewInputError('فرصت شغلی یافت نشد.', 404);
  const resumeId = str(body?.resumeId, 80) || null;
  const rec = resumeId ? db.getResume(org.id, resumeId) : null;
  if (resumeId && !rec) throw new InterviewInputError('رزومه یافت نشد.', 404);

  const dateJalali = str(body?.date, 20);
  const time = str(body?.time, 10);
  const startsAtISO = tehranIsoFromJalali(dateJalali, time);
  if (!startsAtISO) throw new InterviewInputError('تاریخ یا ساعت جلسه معتبر نیست (نمونه: ۱۴۰۴/۰۷/۱۲ و ۱۰:۳۰).', 400);
  const durationMin = Math.min(480, Math.max(15, Number(body?.durationMin) || 45));
  if (new Date(startsAtISO).getTime() < Date.now() - 60_000) {
    throw new InterviewInputError('زمان جلسه در گذشته است؛ یک زمان آینده انتخاب کنید.', 400);
  }

  const interviewerIds: string[] = Array.isArray(body?.interviewerIds)
    ? body.interviewerIds.filter((x: unknown): x is string => typeof x === 'string').slice(0, 12)
    : [];
  const members = db.listMembers(org.id);
  const interviewers = members.filter((m) => interviewerIds.includes(m.id));
  if (interviewerIds.length && !interviewers.length) {
    throw new InterviewInputError('مصاحبه‌گر انتخاب‌شده در این فضای کاری پیدا نشد.', 400);
  }

  const titleInput = str(body?.title, 160);
  const candidateName = rec?.candidateName || str(body?.candidateName, 120) || 'کارجو';
  const candidateEmail = (str(body?.candidateEmail, 200) || candidateEmailOf(rec || {}) || '').toLowerCase() || null;
  if (candidateEmail && !EMAIL_RE.test(candidateEmail)) {
    throw new InterviewInputError('ایمیل کارجو معتبر نیست.', 400);
  }
  const withMeet = body?.withMeet !== false;
  const sendInvite = Boolean(body?.sendInvite);
  const notes = str(body?.notes, 1500);
  const location = str(body?.location, 300);
  const title = titleInput || `مصاحبهٔ ${candidateName} — ${job.roleTitle}`;

  const stamp = new Date();
  const row: db.InterviewRecordRow = {
    id: db.uid('itv'),
    orgId: org.id,
    jobId: job.id,
    jobTitle: job.roleTitle,
    resumeId: rec?.id ?? null,
    candidateName,
    candidateEmail,
    title,
    startsAtISO,
    durationMin,
    timezone: 'Asia/Tehran',
    interviewerIds: interviewers.map((m) => m.id),
    interviewerNames: interviewers.map((m) => m.name),
    interviewerEmails: interviewers.map((m) => m.email).filter(Boolean),
    location,
    notes,
    calendarEventId: null,
    calendarHtmlLink: null,
    meetLink: null,
    inviteSentTo: null,
    reminderSentAtISO: null,
    status: 'scheduled',
    createdBy: user.id,
    createdByName: user.name,
    createdAtISO: stamp.toISOString(),
    createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
  };

  // ---- Google Calendar (the invitation the candidate receives) ----
  let calendarError: string | null = null;
  const secrets = db.resolveOrgSecrets(org.id);
  if (secrets.calendar?.refreshTokenEnc) {
    try {
      const token = await accessTokenFor(secrets, decryptSecret, encryptSecret);
      const attendeeEmails = [candidateEmail, ...interviewers.map((m) => m.email), secrets.calendar.accountEmail].filter(
        (e): e is string => Boolean(e && EMAIL_RE.test(e))
      );
      const description = [
        `فرصت شغلی: ${job.roleTitle} (${job.departmentName})`,
        `کارجو: ${candidateName}`,
        interviewers.length ? `مصاحبه‌گر: ${interviewers.map((m) => m.name).join('، ')}` : '',
        notes,
        'ثبت‌شده با هویدا',
      ]
        .filter(Boolean)
        .join('\n');
      const event = await createEvent(token, secrets.calendar.calendarId, {
        title,
        description,
        startsAtISO,
        durationMin,
        attendeeEmails,
        location,
        withMeet,
      });
      row.calendarEventId = event.id || null;
      row.calendarHtmlLink = event.htmlLink;
      row.meetLink = event.meetLink;
      row.inviteSentTo = candidateEmail;
      db.patchOrgSecrets(org.id, { calendar: { ...secrets.calendar, accessTokenEnc: encryptSecret(token) } });
    } catch (err: any) {
      calendarError = err instanceof CalendarError ? err.message : 'ثبت رویداد در Google Calendar انجام نشد.';
      console.error('[interviews] calendar:', err?.message || err);
    }
  }

  // ---- No Google connection (or it failed): the workspace can still send
  // the invitation itself, with a standard .ics attachment. ----
  let emailError: string | null = null;
  const emailSecrets = db.resolveOrgSecrets(org.id).email;
  if (!row.calendarEventId && sendInvite) {
    if (!isEmailConfigured(db.resolveOrgSecrets(org.id)) || !candidateEmail) {
      emailError = !candidateEmail
        ? 'ایمیلی برای کارجو ثبت نشده است؛ دعوت‌نامه ایمیلی فرستاده نشد.'
        : 'ایمیل سازمان وصل نیست؛ دعوت‌نامه ایمیلی فرستاده نشد.';
    } else {
      try {
        const ics = buildInviteIcs({
          interview: { ...row, id: row.id, title: row.title, notes: row.notes, startsAtISO, durationMin, location, candidateName, jobTitle: job.roleTitle },
          organizer: { name: emailSecrets!.fromName, email: emailSecrets!.fromAddress },
          attendeeEmails: [candidateEmail, ...interviewers.map((m) => m.email)],
        });
        const when = `${formatJalaliDate(tehranJalaliOf(new Date(startsAtISO)), true)} ساعت ${time}`;
        const text = [
          `${candidateName} عزیز،`,
          '',
          `برای مصاحبهٔ «${job.roleTitle}» در ${org.name} در ${when} (به وقت تهران) با شما هماهنگ شده است.`,
          interviewers.length ? `مصاحبه‌گر: ${interviewers.map((m) => m.name).join('، ')}` : '',
          location ? `مکان: ${location}` : '',
          notes ? `توضیح: ${notes}` : '',
          '',
          'فایل تقویم (ICS) این جلسه پیوست است؛ با باز کردن آن، جلسه به تقویم شما اضافه می‌شود.',
          '',
          org.messageSignature,
        ]
          .filter(Boolean)
          .join('\n');
        await sendMail(emailSecrets!, {
          to: candidateEmail,
          subject: `دعوت به مصاحبه — ${job.roleTitle} — ${org.name}`,
          text,
          attachments: [{ filename: 'interview.ics', content: Buffer.from(ics, 'utf-8'), contentType: 'text/calendar' }],
        });
        row.inviteSentTo = candidateEmail;
        noteEmailSend(org.id);
        if (rec) db.markMessageSent(rec);
      } catch (err: any) {
        emailError = friendlySmtpError(err);
      }
    }
  }

  db.saveInterview(row);
  db.logActivity(org.id, { id: user.id, name: user.name }, 'interview.scheduled', `جلسهٔ مصاحبه با «${candidateName}» را برای ${dateJalali} ساعت ${time} تنظیم کرد`, {
    jobId: job.id,
    resumeId: rec?.id,
  });
  return { interview: publicInterview(row), calendarError, emailError, record: rec ? db.toListItem(rec) : null };
}

export { publicInterview };

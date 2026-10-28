/**
 * «لینک زمان‌بندی مصاحبه» — a public page where the candidate picks one of the
 * slots HR offered.
 *
 * Two routers:
 *   • `schedulingPublicRoutes()` — no session: the link's token is the key;
 *   • `schedulingRoutes()` — creating links, cancelling them, and reading the
 *     answer inside the workspace.
 *
 * The booking itself goes through the very same `bookInterview()` the manual
 * modal uses, so a self-booked interview still gets its calendar event, its
 * invitation e-mail and its record on the candidate's timeline.
 */
import crypto from 'crypto';
import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { h, int, str } from './util';
import { bookInterview } from '../interviews';
import { isEmailConfigured, sendMail, friendlySmtpError } from '../mailer';
import { formatJalaliDate } from '../../src/utils/jalali';
import { tehranIsoFromJalali, tehranJalaliOf } from '../tehran-time';
import type { PublicSchedulingLink, SchedulingLink, SchedulingSlot } from '../../src/types/scheduling';
import type { OrgPublic } from '../../src/types/app';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_SLOTS = 8;

function originOf(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function publicUrl(req: express.Request, token: string): string {
  return `${originOf(req)}/schedule/${token}`;
}

function viewOf(req: express.Request, row: db.SchedulingLinkRow): SchedulingLink {
  const { orgId: _o, token: _t, ...rest } = row;
  return { ...rest, url: publicUrl(req, row.token) };
}

/** «۱۴۰۵/۰۸/۱۲» + «۱۰:۳۰» → an ISO instant, or null when the pair is impossible. */
function slotOf(dateRaw: unknown, timeRaw: unknown): SchedulingSlot | null {
  const date = str(dateRaw, 20);
  const time = str(timeRaw, 10);
  const iso = tehranIsoFromJalali(date, time);
  if (!iso) return null;
  return { startsAtISO: iso, date, time, takenBy: null, takenAtISO: null };
}

// --------------------------------------------------------------- public -----

export function schedulingPublicRoutes() {
  const r = express.Router();

  const view = (row: db.SchedulingLinkRow): PublicSchedulingLink => {
    const org = db.getOrg(row.orgId);
    return {
      org: { name: org?.name || '' },
      candidateName: row.candidateName,
      jobTitle: row.jobTitle,
      title: row.title,
      durationMin: row.durationMin,
      notes: row.notes,
      interviewerNames: row.interviewerNames,
      orgTimeNote: 'همهٔ زمان‌ها به وقت تهران است.',
      slots: row.slots.map((s) => ({ startsAtISO: s.startsAtISO, date: s.date, time: s.time, taken: Boolean(s.takenBy) })),
      status: row.status,
      bookedAtJalali: row.status === 'booked' ? formatJalaliDate(tehranJalaliOf(new Date(row.createdAtISO)), true) : null,
    };
  };

  r.get(
    '/scheduling/public/:token',
    h(async (req, res) => {
      const row = db.findSchedulingLinkByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک زمان‌بندی پیدا نشد.' });
      res.json({ link: view(row) });
    })
  );

  r.post(
    '/scheduling/public/:token/book',
    h(async (req, res) => {
      const row = db.findSchedulingLinkByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این لینک زمان‌بندی پیدا نشد.' });
      if (row.status === 'cancelled') return res.status(409).json({ error: 'این لینک توسط سازمان لغو شده است.' });
      if (row.status === 'booked') return res.status(409).json({ error: 'برای این لینک پیش‌تر زمانی انتخاب شده است.' });
      if (new Date(row.expiresAtISO).getTime() < Date.now()) return res.status(409).json({ error: 'مهلت این لینک گذشته است؛ از منابع انسانی زمان تازه بخواهید.' });

      const startsAtISO = str(req.body?.startsAtISO, 40);
      const slot = row.slots.find((s) => s.startsAtISO === startsAtISO);
      if (!slot) return res.status(400).json({ error: 'این زمان در فهرست نیست؛ یکی از زمان‌های پیشنهادی را انتخاب کنید.' });
      if (slot.takenBy) return res.status(409).json({ error: 'این زمان پیش‌تر انتخاب شده است؛ زمان دیگری را ببینید.' });
      if (new Date(slot.startsAtISO).getTime() < Date.now() + 60_000) {
        return res.status(409).json({ error: 'این زمان گذشته است؛ از منابع انسانی زمان تازه بخواهید.' });
      }

      const org = db.getOrg(row.orgId);
      if (!org) return res.status(404).json({ error: 'سازمان یافت نشد.' });
      const rec = db.getResume(row.orgId, row.resumeId);

      let interviewId: string | null = null;
      try {
        const booked = await bookInterview({
          org: org as unknown as OrgPublic,
          user: { id: 'candidate', name: row.candidateName },
          body: {
            jobId: row.jobId,
            resumeId: row.resumeId,
            title: row.title,
            date: slot.date,
            time: slot.time,
            durationMin: row.durationMin,
            notes: row.notes,
            interviewerIds: row.interviewerIds,
            candidateName: row.candidateName,
            candidateEmail: row.candidateEmail || undefined,
            withMeet: true,
            sendInvite: true,
          },
        });
        interviewId = booked.interview.id;
      } catch (err: any) {
        // Nothing is claimed as booked: the link stays open so the candidate can try another time.
        return res.status(502).json({ error: err?.message || 'ثبت جلسه ممکن نشد؛ کمی بعد دوباره تلاش کنید.' });
      }

      const stamp = new Date();
      const next: db.SchedulingLinkRow = {
        ...row,
        status: 'booked',
        interviewId,
        slots: row.slots.map((s) => (s.startsAtISO === startsAtISO ? { ...s, takenBy: row.candidateName, takenAtISO: stamp.toISOString() } : s)),
      };
      db.saveSchedulingLink(next);
      if (rec) {
        const stage = db.stagesOf(db.getJob(row.orgId, row.jobId)).find((s) => s.kind === 'interview');
        if (stage) db.setStage(rec, stage.id);
      }
      db.logActivity(row.orgId, null, 'interview.scheduled', `«${row.candidateName}» خودش زمان مصاحبه را انتخاب کرد (${slot.date} — ${slot.time})`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ link: view(next), interviewId });
    })
  );

  return r;
}

// ------------------------------------------------------------ workspace -----

export function schedulingRoutes() {
  const r = express.Router();

  r.get(
    '/scheduling',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const items = db
        .listSchedulingLinks(org.id, { jobId: str(req.query.jobId, 80) || undefined, resumeId: str(req.query.resumeId, 80) || undefined })
        .map((l) => viewOf(req, l));
      res.json({ items });
    })
  );

  r.get(
    '/scheduling/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getSchedulingLink(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'لینک زمان‌بندی یافت نشد.' });
      res.json({ link: viewOf(req, row) });
    })
  );

  r.post(
    '/scheduling',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByBlind(org, res)) return;
      const job = db.getJob(org.id, rec.jobId);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });

      const rawSlots = Array.isArray(req.body?.slots) ? req.body.slots.slice(0, MAX_SLOTS) : [];
      const seen = new Set<string>();
      const slots: SchedulingSlot[] = [];
      for (const raw of rawSlots) {
        const slot = slotOf(raw?.date, raw?.time);
        if (!slot || seen.has(slot.startsAtISO)) continue;
        if (new Date(slot.startsAtISO).getTime() < Date.now()) continue; // a past hour is not an offer
        seen.add(slot.startsAtISO);
        slots.push(slot);
      }
      if (!slots.length) {
        return res.status(400).json({ error: 'دست‌کم یک زمان آینده پیشنهاد کنید (تاریخ شمسی و ساعت تهران).' });
      }
      slots.sort((a, b) => a.startsAtISO.localeCompare(b.startsAtISO));

      const open = db.openSchedulingLinkFor(org.id, rec.id);
      if (open) return res.status(409).json({ error: 'برای این کارجو یک لینک زمان‌بندی باز وجود دارد؛ همان را لغو کنید یا نتیجه‌اش را ببینید.' });

      const memberIds: string[] = Array.isArray(req.body?.interviewerIds)
        ? req.body.interviewerIds.filter((x: unknown): x is string => typeof x === 'string').slice(0, 12)
        : [];
      const members = db.listMembers(org.id);
      const interviewers = members.filter((m) => memberIds.includes(m.id));

      const stamp = new Date();
      const days = Math.min(30, Math.max(1, int(req.body?.expiresInDays, 7)));
      const row: db.SchedulingLinkRow = {
        id: db.uid('sch'),
        orgId: org.id,
        token: crypto.randomBytes(18).toString('base64url'),
        jobId: job.id,
        jobTitle: job.roleTitle,
        resumeId: rec.id,
        candidateName: rec.candidateName || rec.fileName,
        candidateEmail: rec.contact?.email || null,
        title: str(req.body?.title, 160) || `مصاحبهٔ ${rec.candidateName || rec.fileName} — ${job.roleTitle}`,
        durationMin: Math.min(240, Math.max(15, int(req.body?.durationMin, 45))),
        notes: str(req.body?.notes, 1000),
        interviewerIds: interviewers.map((m) => m.id),
        interviewerNames: interviewers.map((m) => m.name),
        status: 'open',
        slots,
        interviewId: null,
        createdAtISO: stamp.toISOString(),
        createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        expiresAtISO: new Date(stamp.getTime() + days * 86_400_000).toISOString(),
      };
      db.saveSchedulingLink(row);
      db.logActivity(org.id, user, 'interview.scheduled', `لینک انتخاب زمان مصاحبه برای «${row.candidateName}» آماده شد`, {
        jobId: job.id,
        resumeId: rec.id,
      });
      res.status(201).json({ link: viewOf(req, row) });
    })
  );

  /** Sending the link uses the workspace mailbox; the copy button needs no mailbox. */
  r.post(
    '/scheduling/:id/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getSchedulingLink(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'لینک زمان‌بندی یافت نشد.' });
      if (row.status !== 'open') return res.status(409).json({ error: 'این لینک دیگر باز نیست.' });
      const to = (row.candidateEmail || '').toLowerCase().trim();
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'برای این کارجو ایمیل معتبری ثبت نشده است.' });
      if (!isEmailConfigured(db.getOrgSecrets(org.id))) {
        return res.status(409).json({ error: 'صندوق ایمیل سازمان وصل نشده است؛ لینک را کپی و با ابزار خودتان بفرستید.', code: 'EMAIL_NOT_CONFIGURED' });
      }
      const link = publicUrl(req, row.token);
      const slots = row.slots.map((s) => `• ${s.date} — ساعت ${s.time}`).join('\n');
      const text = [
        `${row.candidateName} عزیز،`,
        '',
        `برای «${row.jobTitle}» یک گفت‌وگوی ${row.durationMin} دقیقه‌ای در نظر گرفته‌ایم. یکی از زمان‌های زیر را انتخاب کنید:`,
        '',
        slots,
        '',
        'انتخاب زمان: ' + link,
        '',
        org.name,
      ].join('\n');
      try {
        await sendMail(db.getOrgSecrets(org.id).email!, { to, subject: `انتخاب زمان مصاحبه — ${row.jobTitle}`, text });
      } catch (err: any) {
        return res.status(502).json({ error: `ارسال نشد: ${friendlySmtpError(err)}`, code: 'SMTP_FAILED' });
      }
      db.logActivity(org.id, user, 'interview.scheduled', `لینک انتخاب زمان برای «${row.candidateName}» ایمیل شد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ link: viewOf(req, row) });
    })
  );

  r.post(
    '/scheduling/:id/cancel',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getSchedulingLink(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'لینک زمان‌بندی یافت نشد.' });
      if (row.status === 'booked') return res.status(409).json({ error: 'کارجو زمان را انتخاب کرده است؛ برای تغییر، مصاحبه را لغو کنید.' });
      const next: db.SchedulingLinkRow = { ...row, status: 'cancelled' };
      db.saveSchedulingLink(next);
      db.logActivity(org.id, user, 'interview.cancelled', `لینک انتخاب زمان «${row.candidateName}» لغو شد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ link: viewOf(req, next) });
    })
  );

  return r;
}

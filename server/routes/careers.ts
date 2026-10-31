/**
 * «پورتال شغلی» + «تختهٔ جذب» + «کارت ارزیابی».
 *
 * Two routers live here on purpose:
 *   • `careerPublicRoutes()` — mounted before authentication. A stranger on the
 *     internet reads published openings and applies; nothing else is exposed,
 *     and the payload carries no internal id, score, note or colleague name.
 *   • `careerRoutes()` — the workspace side: publishing, the kanban board, moving
 *     a candidate between columns, and the interviewers' scorecards.
 */
import express from 'express';
import * as db from '../db';
import { ctxOf, requireRole } from '../auth';
import { h, str } from './util';
import { evaluateResume } from '../ai/screening';
import { ingestDocument } from '../ingest';
import { isEmailConfigured, sendMail } from '../mailer';
import { friendlySmtpError } from '../mailer';
import { formatJalaliDate, toPersianDigits } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import type { CareerSettings, PublicCareersPage, PublicJobDetail, PublicJobSummary } from '../../src/types/careers';
import type { FeedbackRecommendation, InterviewFeedback, ScorecardSummary } from '../../src/types/pipeline';
import type { Job, ResumeRecord } from '../../src/types/screening';
import { systemSettings } from '../platform';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESERVED_SLUGS = new Set(['api', 'app', 'admin', 'careers', 'login', 'signup', 'www', 'static', 'assets']);

function publicSummary(job: Job): PublicJobSummary {
  return {
    id: job.id,
    roleTitle: job.roleTitle,
    departmentName: job.departmentName,
    location: job.location || '',
    employmentType: job.employmentType ?? null,
    seniority: job.understanding?.seniority || '',
    summary: String(job.understanding?.plainExplanation || '').slice(0, 220),
    publishedAtJalali: job.publishedAtISO ? formatJalaliDate(tehranJalaliOf(new Date(job.publishedAtISO)), true) : job.createdAtJalali,
  };
}

function publicDetail(job: Job): PublicJobDetail {
  const u = job.understanding;
  const requirements = (u?.criteria || [])
    .filter((c) => c.mustHave || c.weight >= 15)
    .slice(0, 8)
    .map((c) => c.title);
  return {
    ...publicSummary(job),
    description: String(job.extraNotes || u?.plainExplanation || '').slice(0, 4000),
    requirements,
    questions: (u?.questions || []).slice(0, 8).map((q) => ({
      id: q.id,
      label: q.label,
      kind: q.kind,
      type: q.type,
      options: 'options' in q ? q.options.map((o) => o.label) : undefined,
    })),
  };
}

function originOf(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

// --------------------------------------------------------------- public -----

/** Simple in-memory guard: a public form must not become a free compute source. */
const attempts = new Map<string, number[]>();
const HOUR = 3600_000;
function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < HOUR);
  attempts.set(ip, list);
  return list.length >= 8;
}
function noteAttempt(ip: string) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}

/** Background screening of a public application; the applicant already got an answer. */
async function screenApplication(org: { id: string; name: string; departments: any[] }, job: Job, rec: ResumeRecord, fileBase64?: string) {
  try {
    let text = rec.extractedText || '';
    let attachments;
    let sourceLabel = rec.analysisMeta?.format ?? null;
    if (fileBase64) {
      const ing = await ingestDocument(Buffer.from(fileBase64, 'base64'), rec.fileName);
      attachments = ing.files;
      sourceLabel = ing.label;
      if (ing.text && ing.text.length > text.length) text = ing.text;
      if (ing.unreadable && !text.trim()) rec.unjudgeableReason = ing.unreadable;
    }
    if (!text.trim() && rec.unjudgeableReason) {
      db.scheduleSave();
      return;
    }
    const dept = org.departments.find((d) => d.id === job.departmentId);
    const evaluation = await evaluateResume({
      orgName: org.name,
      job: { ...job, departmentHint: dept?.hint },
      resumeText: text,
      fileName: rec.fileName,
      attachments,
      fileBase64: attachments ? undefined : fileBase64,
      sourceLabel,
    });
    // A colleague may have deleted the application meanwhile.
    if (db.getResume(org.id, rec.id) !== rec) return;
    rec.extractedText = text.slice(0, 20000);
    db.updateResumeEvaluation(rec, evaluation, 'rerun');
    // The form is the candidate's own statement: it wins over anything extracted.
    rec.candidateName = rec.candidateName || null;
  } catch (err: any) {
    console.error('[careers] screening failed:', err?.message);
    rec.errorMessage = 'بررسی خودکار این درخواست ممکن نشد؛ تیم منابع انسانی آن را دستی بررسی می‌کند.';
    db.scheduleSave();
  }
}

export function careerPublicRoutes() {
  const r = express.Router();

  r.get(
    '/careers/:slug',
    h(async (req, res, next) => {
      // «settings» is a workspace page, not a public slug — let it fall through
      // to the authenticated router instead of answering 404 here.
      if (req.params.slug === 'settings') return next();
      const org = db.findOrgByCareerSlug(req.params.slug);
      if (!org || org.suspended) return res.status(404).json({ error: 'این صفحهٔ استخدام پیدا نشد.' });
      const jobs = db
        .listJobs(org.id)
        .filter((j) => j.isPublic && j.status === 'open')
        .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
      const page: PublicCareersPage = {
        org: { name: org.name, about: org.careerAbout || '', slug: org.careerSlug },
        jobs: jobs.map(publicSummary),
      };
      res.json(page);
    })
  );

  r.get(
    '/careers/:slug/jobs/:jobId',
    h(async (req, res) => {
      const org = db.findOrgByCareerSlug(req.params.slug);
      if (!org || org.suspended) return res.status(404).json({ error: 'این صفحهٔ استخدام پیدا نشد.' });
      const job = db.getJob(org.id, req.params.jobId);
      if (!job || !job.isPublic || job.status !== 'open') return res.status(404).json({ error: 'این فرصت شغلی منتشر نشده است.' });
      res.json({ job: publicDetail(job), org: { name: org.name, about: org.careerAbout || '' } });
    })
  );

  r.post(
    '/careers/:slug/jobs/:jobId/apply',
    h(async (req, res) => {
      const org = db.findOrgByCareerSlug(req.params.slug);
      if (!org || org.suspended) return res.status(404).json({ error: 'این صفحهٔ استخدام پیدا نشد.' });
      const job = db.getJob(org.id, req.params.jobId);
      if (!job || !job.isPublic || job.status !== 'open') return res.status(404).json({ error: 'این فرصت شغلی منتشر نشده است.' });

      // A filled honeypot means a bot: answer 200 and do nothing.
      if (str(req.body?.website, 40)) return res.json({ applicationId: '', message: 'درخواست شما ثبت شد.' });

      const ip = String((req.headers['x-forwarded-for'] as string) || req.ip || '').split(',')[0].trim() || 'unknown';
      if (tooManyAttempts(ip)) {
        return res.status(429).json({ error: 'تعداد درخواست‌های شما زیاد بوده است؛ کمی بعد دوباره تلاش کنید.' });
      }

      const name = str(req.body?.name, 120);
      const email = str(req.body?.email, 160).toLowerCase();
      const phone = str(req.body?.phone, 40);
      const city = str(req.body?.city, 80);
      const message = str(req.body?.message, 2000);
      const fileName = str(req.body?.fileName, 200);
      const fileBase64 = typeof req.body?.fileBase64 === 'string' && req.body.fileBase64.length > 50 ? (req.body.fileBase64 as string) : undefined;
      const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 40000) : '';
      const consent = req.body?.consent === true;
      const ref = str(req.body?.ref ?? req.query.ref, 80);
      const heardFrom = str(req.body?.heardFrom, 60);

      if (name.length < 3) return res.status(400).json({ error: 'نام و نام خانوادگی را کامل بنویسید.' });
      if (!EMAIL_RE.test(email) && !/^0?9\d{9}$/.test(phone.replace(/[^\d]/g, ''))) {
        return res.status(400).json({ error: 'برای تماس با شما، یک ایمیل یا شمارهٔ موبایل معتبر لازم است.' });
      }
      if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'ایمیل وارد‌شده معتبر نیست.' });
      if (!consent) return res.status(400).json({ error: 'برای ارسال درخواست، تأیید نگه‌داری اطلاعات الزامی است.' });
      if (!fileBase64 && text.trim().length < 50) {
        return res.status(400).json({ error: 'رزومهٔ خود را بارگذاری کنید یا متن آن را بچسبانید.' });
      }
      const maxMb = systemSettings().maxFileMb;
      if (fileBase64 && fileBase64.length * 0.75 > maxMb * 1024 * 1024 + 4096) {
        return res.status(413).json({ error: `حجم فایل بیش از ${toPersianDigits(maxMb)} مگابایت است.` });
      }

      // The same person applying twice to one opening is told so, not duplicated.
      const existing = db
        .listOrgResumes(org.id, job.id)
        .find((r) => email && r.contact?.email && r.contact.email.toLowerCase() === email);
      if (existing) {
        return res.json({
          applicationId: existing.id,
          message: 'درخواست شما قبلاً برای این فرصت شغلی ثبت شده است و در حال بررسی است.',
        });
      }

      noteAttempt(ip);
      let record: ResumeRecord;
      try {
        record = await db.saveEvaluation({
          job,
          uploadedBy: null,
          fileName: fileName || `application-${name.replace(/\s+/g, '-').slice(0, 40)}.txt`,
          extractedText: text,
          unjudgeableReason: null,
          fileBase64,
          source: {
            kind: ref ? 'referral' : 'careers',
            profileUrl: '',
            headline: message || 'درخواست از پورتال شغلی',
            company: null,
            location: city,
            openToWork: true,
            searchId: null,
            referrer: ref || null,
            heardFrom: heardFrom || null,
          },
          errorMessage: 'رزومه دریافت شد؛ بررسی خودکار در حال انجام است.',
        });
      } catch {
        return res.status(409).json({ error: 'این فرصت شغلی در همین لحظه بسته شد؛ صفحه را تازه کنید.' });
      }

      // Statement from the form — authoritative for how to reach the person.
      record.candidateName = name;
      record.contact = { email: email || null, phone: phone || null, city: city || null };
      db.scheduleSave();
      if (message) record.extractedText = `${record.extractedText}\n\n— یادداشت کارجو:\n${message}`.slice(0, 22000);

      // Screening runs after the answer: the candidate never waits on an AI call.
      void screenApplication(org, job, record, fileBase64);

      // Confirmation e-mail, only from a mailbox that is really connected.
      let emailed = false;
      const secrets = db.resolveOrgSecrets(org.id);
      if (email && isEmailConfigured(secrets)) {
        const stamp = new Date();
        const bodyText = [
          `${name} عزیز،`,
          '',
          `درخواست شما برای «${job.roleTitle}» در ${org.name} ثبت شد.`,
          'رزومهٔ شما بررسی می‌شود و اگر با نیازهای این نقش هم‌خوان باشد، برای هماهنگی مصاحبه با شما تماس می‌گیریم.',
          '',
          'با احترام',
          org.messageSignature,
        ].join('\n');
        const row: db.SentEmailRow = {
          id: db.uid('mail'),
          orgId: org.id,
          to: email,
          subject: `دریافت درخواست — ${job.roleTitle}`,
          body: bodyText,
          resumeId: record.id,
          candidateName: name,
          jobId: job.id,
          status: 'sent',
          error: null,
          sentAtISO: stamp.toISOString(),
          sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
          sentByName: 'پورتال شغلی',
          attachments: [],
        };
        try {
          await sendMail(secrets.email!, { to: email, subject: row.subject, text: bodyText });
          emailed = true;
          db.saveEmail(row);
        } catch (err: any) {
          db.saveEmail({ ...row, status: 'failed', error: friendlySmtpError(err) });
        }
      }

      db.logActivity(org.id, null, 'sourcing.imported', `درخواست تازه از پورتال شغلی: «${name}» برای «${job.roleTitle}»`, {
        jobId: job.id,
        resumeId: record.id,
      });
      return res.json({
        applicationId: record.id,
        message: emailed
          ? 'درخواست شما ثبت شد و یک ایمیل تأیید برایتان فرستادیم.'
          : 'درخواست شما ثبت شد و در صف بررسی قرار گرفت.',
      });
    })
  );

  return r;
}

// ----------------------------------------------------------- workspace ------

export function careerRoutes() {
  const r = express.Router();

  /** The link the workspace puts on its own website. */
  r.get(
    '/careers/settings',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobs = db.listJobs(org.id);
      const settings: CareerSettings = {
        slug: org.careerSlug,
        about: org.careerAbout,
        url: `${originOf(req)}/careers/${org.careerSlug}`,
        publishedJobs: jobs.filter((j) => j.isPublic && j.status === 'open').length,
        totalJobs: jobs.filter((j) => j.status === 'open').length,
      };
      res.json({ careers: settings });
    })
  );

  r.put(
    '/careers/settings',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rawSlug = str(req.body?.slug, 60).toLowerCase();
      const slug = rawSlug || org.careerSlug;
      if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(slug)) {
        return res.status(400).json({ error: 'نشانی پورتال فقط با حروف کوچک انگلیسی، رقم و خط تیره (۳ تا ۴۰ نویسه) ساخته می‌شود.' });
      }
      if (RESERVED_SLUGS.has(slug)) return res.status(400).json({ error: 'این نشانی رزرو شده است؛ نشانی دیگری انتخاب کنید.' });
      if (db.careerSlugTaken(slug, org.id)) return res.status(409).json({ error: 'این نشانی قبلاً برای سازمان دیگری ثبت شده است.' });
      const about = typeof req.body?.about === 'string' ? req.body.about.slice(0, 1200) : org.careerAbout;
      const updated = db.updateOrg(org.id, { careerSlug: slug, careerAbout: about })!;
      db.logActivity(org.id, { id: user.id, name: user.name }, 'settings.changed', 'تنظیمات پورتال شغلی را تغییر داد');
      res.json({
        careers: {
          slug: updated.careerSlug,
          about: updated.careerAbout,
          url: `${originOf(req)}/careers/${updated.careerSlug}`,
          publishedJobs: db.listJobs(org.id).filter((j) => j.isPublic && j.status === 'open').length,
          totalJobs: db.listJobs(org.id).filter((j) => j.status === 'open').length,
        } as CareerSettings,
      });
    })
  );

  /** Publish/unpublish an opening on the public portal. */
  r.post(
    '/jobs/:id/publish',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const job = db.getJob(org.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      if (user.role === 'member' && job.createdBy !== user.id) {
        return res.status(403).json({ error: 'انتشار آگهی کار مدیر فضای کاری یا سازندهٔ آن است.' });
      }
      const next = req.body?.isPublic === true;
      if (next && job.status !== 'open') {
        return res.status(409).json({ error: 'فرصت شغلی بسته است؛ اول آن را باز کنید.' });
      }
      const updated = db.updateJob(org.id, job.id, { isPublic: next })!;
      db.logActivity(
        org.id,
        { id: user.id, name: user.name },
        'job.status',
        next ? `«${job.roleTitle}» را در پورتال شغلی منتشر کرد` : `«${job.roleTitle}» را از پورتال شغلی برداشت`,
        { jobId: job.id }
      );
      res.json({ job: db.toJobSummary(updated) });
    })
  );

  /** One read for the whole board. */
  r.get(
    '/jobs/:id/board',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const board = db.jobBoard(org.id, req.params.id);
      if (!board) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      res.json(board);
    })
  );

  /** «ستون بعدی» — moving a candidate is one small, logged action. */
  r.post(
    '/resumes/:id/stage',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const job = db.getJob(org.id, rec.jobId);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      const stages = db.stagesOf(job);
      const stage = stages.find((s) => s.id === str(req.body?.stageId, 40));
      if (!stage) return res.status(400).json({ error: 'این ستون در تختهٔ این فرصت شغلی وجود ندارد.' });
      db.setStage(rec, stage.id);
      if (stage.kind === 'rejected' && rec.decisionStatus === 'none') {
        db.setDecision(rec, 'rejected', 'از تختهٔ جذب به ستون کنار گذاشته‌شده منتقل شد', { id: user.id, name: user.name });
      }
      db.logActivity(org.id, { id: user.id, name: user.name }, 'stage.moved', `«${rec.candidateName || rec.fileName}» را به ستون «${stage.name}» منتقل کرد`, {
        jobId: rec.jobId,
        resumeId: rec.id,
      });
      res.json({ record: db.toListItem(rec), stage });
    })
  );

  // ------------------------------------------------------------ scorecards ----

  function summarize(items: InterviewFeedback[]): ScorecardSummary {
    const byRecommendation: Record<FeedbackRecommendation, number> = { strong_yes: 0, yes: 0, no: 0, strong_no: 0 };
    let sum = 0;
    let count = 0;
    for (const f of items) {
      byRecommendation[f.recommendation] += 1;
      for (const c of f.criteria) {
        sum += c.score;
        count += 1;
      }
    }
    return {
      count: items.length,
      averageScore: count ? Math.round((sum / count) * 10) / 10 : 0,
      byRecommendation,
      feedback: items,
    };
  }

  r.get(
    '/resumes/:id/feedback',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const items = db.listFeedback(org.id, { resumeId: rec.id }).map(db.withoutOrg);
      res.json({ summary: summarize(items), mine: items.find((f) => f.reviewerId === ctxOf(req).user.id) || null });
    })
  );

  r.post(
    '/resumes/:id/feedback',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const job = db.getJob(org.id, rec.jobId);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });

      const allowed: FeedbackRecommendation[] = ['strong_yes', 'yes', 'no', 'strong_no'];
      const recommendation = allowed.find((x) => x === req.body?.recommendation);
      if (!recommendation) return res.status(400).json({ error: 'نظر نهایی خود را انتخاب کنید.' });
      const notes = str(req.body?.notes, 2000);
      const titles = new Map((job.understanding?.criteria || []).map((c) => [c.id, c.title]));
      const criteria = (Array.isArray(req.body?.criteria) ? req.body.criteria : [])
        .slice(0, 12)
        .map((c: any) => {
          const criterionId = str(c?.criterionId, 60);
          const score = Math.round(Number(c?.score));
          if (!titles.has(criterionId) || !Number.isFinite(score) || score < 1 || score > 5) return null;
          return { criterionId, title: titles.get(criterionId)!, score, note: str(c?.note, 300) };
        })
        .filter(Boolean) as InterviewFeedback['criteria'];
      if (!criteria.length && !notes) {
        return res.status(400).json({ error: 'دست‌کم امتیاز یک معیار یا یک یادداشت لازم است.' });
      }

      const interviewId = str(req.body?.interviewId, 80) || null;
      if (interviewId) {
        const interview = db.getInterview(org.id, interviewId);
        if (!interview || interview.resumeId !== rec.id) {
          return res.status(400).json({ error: 'این جلسه به این کارجو تعلق ندارد.' });
        }
      }

      const stamp = new Date();
      const row: db.InterviewFeedbackRow = {
        id: db.uid('fb'),
        orgId: org.id,
        interviewId,
        resumeId: rec.id,
        jobId: rec.jobId,
        reviewerId: user.id,
        reviewerName: user.name,
        recommendation,
        criteria,
        notes,
        atISO: stamp.toISOString(),
        atJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
      };
      db.saveFeedback(row);
      db.logActivity(org.id, { id: user.id, name: user.name }, 'scorecard.added', `برای «${rec.candidateName || rec.fileName}» کارت ارزیابی ثبت کرد`, {
        jobId: rec.jobId,
        resumeId: rec.id,
      });
      const items = db.listFeedback(org.id, { resumeId: rec.id }).map(db.withoutOrg);
      res.json({ summary: summarize(items), mine: db.withoutOrg(row) });
    })
  );

  return r;
}


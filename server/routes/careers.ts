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
import { markOfferReached, markOutcome, memberByCode, recordReferral } from '../referrals';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RESERVED_SLUGS = new Set([
  'api',
  'app',
  'admin',
  'careers',
  'login',
  'signup',
  'www',
  'static',
  'assets',
  'robots.txt',
  'sitemap.xml',
  'job-posting.json',
  'feed.xml',
]);

/** «مهلت درخواست» passed? An expired opening is never advertised as open. */
function isExpired(job: Job): boolean {
  return Boolean(job.applyByISO && new Date(job.applyByISO).getTime() < Date.now());
}

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
    applyByJalali: job.applyByJalali || null,
    expired: isExpired(job),
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

export function careerOriginOf(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

// ------------------------------------------------- schema.org JobPosting -----
//
// «گوگل برای مشاغل» (Google for Jobs) reads JobPosting JSON-LD from the page —
// not from a private API. Two consequences the product must honour:
//   • the markup has to describe the *same* facts the page shows (title, place,
//     deadline, employment type), otherwise Google flags a mismatch;
//   • it disappears as soon as the opening does — never advertise a job the
//     workspace cannot accept applications for.

const EMPLOYMENT_SCHEMA: Record<string, string[]> = {
  'full-time': ['FULL_TIME'],
  'part-time': ['PART_TIME'],
  contract: ['CONTRACTOR'],
  remote: ['FULL_TIME'],
  hybrid: ['FULL_TIME'],
  internship: ['INTERN'],
};

/**
 * Plain text → the small subset of HTML Google's guideline asks for: paragraphs
 * and bullet lists. A run of «- item» lines becomes one <ul>, even when it sits
 * under a heading inside the same block.
 */
function descriptionHtml(text: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks = String(text || '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 40);
  const out: string[] = [];
  for (const block of blocks) {
    const lines = block.split(/\n/).map((l) => l.trim()).filter(Boolean);
    let bullets: string[] = [];
    let paragraph: string[] = [];
    const flushBullets = () => {
      if (bullets.length) out.push(`<ul>${bullets.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`);
      bullets = [];
    };
    const flushParagraph = () => {
      if (paragraph.length) out.push(`<p>${paragraph.map(esc).join('<br>')}</p>`);
      paragraph = [];
    };
    for (const line of lines) {
      if (/^[-•*]\s+/.test(line)) {
        flushParagraph();
        bullets.push(line.replace(/^[-•*]\s+/, ''));
      } else {
        flushBullets();
        paragraph.push(line);
      }
    }
    flushBullets();
    flushParagraph();
  }
  return out.join('');
}

/** One JobPosting object — exactly the fields Google reads, nothing invented. */
export function jobPostingJson(job: Job, org: { name: string; careerSlug: string }, origin: string) {
  const base = `${origin.replace(/\/$/, '')}/careers/${org.careerSlug}`;
  const url = `${base}/jobs/${job.id}`;
  const u = job.understanding;
  const city = (job.location || '').trim();
  const remote = job.employmentType === 'remote';
  const detail: any = {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: job.roleTitle,
    description: descriptionHtml(job.extraNotes || u?.plainExplanation || job.roleTitle),
    datePosted: job.publishedAtISO || job.createdAtISO,
    hiringOrganization: {
      '@type': 'Organization',
      name: org.name,
      sameAs: base,
    },
    jobLocation: {
      '@type': 'Place',
      address: {
        '@type': 'PostalAddress',
        ...(city ? { addressLocality: city } : {}),
        addressCountry: 'IR',
      },
    },
    identifier: { '@type': 'PropertyValue', name: org.name, value: job.id },
    url,
    // HOVIDA's own form is the application path — no third-party redirect.
    directApply: true,
    industry: job.departmentName || undefined,
    ...(job.employmentType ? { employmentType: EMPLOYMENT_SCHEMA[job.employmentType] || ['FULL_TIME'] } : {}),
    ...(remote ? { jobLocationType: 'TELECOMMUTE' } : {}),
    // Only a real deadline: an invented one would tell Google a live job is over.
    ...(job.applyByISO && !isExpired(job) ? { validThrough: job.applyByISO } : {}),
  };
  if (!detail.industry) delete detail.industry;
  return detail;
}

/**
 * A listing page is not a job posting: Google expects one JobPosting per job
 * *page*, so the portal index carries an ItemList that points at each opening.
 */
export function jobListLd(slug: string, origin: string): string {
  const org = db.findOrgByCareerSlug(slug);
  if (!org || org.suspended) return '';
  const jobs = db
    .listJobs(org.id)
    .filter((j) => j.isPublic && j.status === 'open' && !isExpired(j))
    .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
  if (!jobs.length) return '';
  const base = (origin || 'https://hovida.local').replace(/\/$/, '');
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `فرصت‌های شغلی ${org.name}`,
    numberOfItems: jobs.length,
    itemListElement: jobs.map((j, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: j.roleTitle,
      url: `${base}/careers/${org.careerSlug}/jobs/${j.id}`,
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(list)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')}</script>`;
}

/** The JSON-LD block(s) for one page; empty when the page has nothing to say. */
export function jobPostingLd(slug: string, jobId: string | undefined, origin: string): string {
  const org = db.findOrgByCareerSlug(slug);
  if (!org || org.suspended) return '';
  const jobs = jobId
    ? [db.getJob(org.id, jobId)].filter((j): j is Job => Boolean(j && j.isPublic && j.status === 'open' && !isExpired(j)))
    : db
        .listJobs(org.id)
        .filter((j) => j.isPublic && j.status === 'open' && !isExpired(j))
        .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
  if (!jobs.length) return '';
  const base = (origin || 'https://hovida.local').replace(/\/$/, '');
  const items = jobs.map((j) => jobPostingJson(j, org, base));
  // «</script>» inside a description would end the block early: escape < and >.
  const json = JSON.stringify(items.length === 1 ? items[0] : items).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<script type="application/ld+json">${json}</script>`;
}

/** The <head> a career page needs: its own title, description and the JSON-LD. */
export function careersHeadHtml(slug: string, jobId: string | undefined, origin: string): string | null {
  const org = db.findOrgByCareerSlug(slug);
  if (!org || org.suspended) return null;
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  if (jobId) {
    const job = db.getJob(org.id, jobId);
    if (!job || !job.isPublic || job.status !== 'open') return null;
    const expired = isExpired(job);
    const title = `${job.roleTitle} — ${org.name}`;
    const desc = String(job.understanding?.plainExplanation || job.extraNotes || '').slice(0, 180);
    return [
      `<title>${esc(title)}</title>`,
      `<meta name="description" content="${esc(desc)}" />`,
      `<meta property="og:title" content="${esc(title)}" />`,
      `<meta property="og:description" content="${esc(desc)}" />`,
      `<meta property="og:type" content="website" />`,
      expired ? `<meta name="robots" content="noindex,follow" />` : jobPostingLd(slug, jobId, origin),
    ].join('\n    ');
  }
  const jobs = db.listJobs(org.id).filter((j) => j.isPublic && j.status === 'open' && !isExpired(j));
  const title = `فرصت‌های شغلی ${org.name}`;
  const desc = (org.careerAbout || '').slice(0, 180) || `${jobs.length} فرصت شغلی باز در ${org.name} — درخواست آنلاین.`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}" />`,
    `<meta property="og:title" content="${esc(title)}" />`,
    `<meta property="og:description" content="${esc(desc)}" />`,
    `<meta property="og:type" content="website" />`,
    jobListLd(slug, origin),
  ].join('\n    ');
}

/**
 * The same facts as the JSON-LD, as plain JSON — for an aggregator, a job-board
 * partner or the workspace's own website to poll. Public and read-only: it is
 * mounted both under `/api/careers/...` and at the crawlable `/careers/...`.
 */
export const jobPostingFeed: express.RequestHandler = (req, res) => {
  const org = db.findOrgByCareerSlug(req.params.slug);
  if (!org || org.suspended) return res.status(404).json({ error: 'این صفحهٔ استخدام پیدا نشد.' });
  const origin = careerOriginOf(req);
  const jobs = db
    .listJobs(org.id)
    .filter((j) => j.isPublic && j.status === 'open' && !isExpired(j))
    .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    org: { name: org.name, slug: org.careerSlug },
    count: jobs.length,
    items: jobs.map((j) => jobPostingJson(j, org, origin)),
  });
};

/** A sitemap so a search engine finds every published opening by itself. */
export const careersSitemap: express.RequestHandler = (req, res) => {
  const org = db.findOrgByCareerSlug(req.params.slug);
  if (!org || org.suspended) return res.status(404).type('text/plain').send('Not found');
  const base = `${careerOriginOf(req)}/careers/${org.careerSlug}`;
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const jobs = db
    .listJobs(org.id)
    .filter((j) => j.isPublic && j.status === 'open' && !isExpired(j))
    .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
  const urls = [
    `<url><loc>${esc(base)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...jobs.map(
      (j) =>
        `<url><loc>${esc(`${base}/jobs/${j.id}`)}</loc>${
          j.publishedAtISO ? `<lastmod>${j.publishedAtISO.slice(0, 10)}</lastmod>` : ''
        }<changefreq>weekly</changefreq><priority>0.9</priority></url>`
    ),
  ];
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
};

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
        .filter((j) => j.isPublic && j.status === 'open' && !isExpired(j))
        .sort((a, b) => (b.publishedAtISO || '').localeCompare(a.publishedAtISO || ''));
      const page: PublicCareersPage = {
        org: { name: org.name, about: org.careerAbout || '', slug: org.careerSlug },
        jobs: jobs.map(publicSummary),
      };
      res.json(page);
    })
  );

  r.get('/careers/:slug/job-posting.json', jobPostingFeed);
  r.get('/careers/:slug/sitemap.xml', careersSitemap);

  r.get(
    '/careers/:slug/jobs/:jobId',
    h(async (req, res) => {
      const org = db.findOrgByCareerSlug(req.params.slug);
      if (!org || org.suspended) return res.status(404).json({ error: 'این صفحهٔ استخدام پیدا نشد.' });
      const job = db.getJob(org.id, req.params.jobId);
      if (!job || !job.isPublic || job.status !== 'open') return res.status(404).json({ error: 'این فرصت شغلی منتشر نشده است.' });
      // An expired opening stays readable (a shared link must not dead-end) but
      // says plainly that the deadline has passed — and the form is closed.
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
      if (isExpired(job)) {
        return res.status(410).json({
          error: 'مهلت درخواست برای این فرصت شغلی به پایان رسیده است.',
          code: 'APPLICATION_CLOSED',
          applyByJalali: job.applyByJalali || null,
        });
      }

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

      // A code that really belongs to a member is a referral; a random string
      // the candidate typed is just what they typed (still kept as `heardFrom`).
      const referrer = ref ? memberByCode(org.id, ref) : null;

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
            kind: referrer ? 'referral' : 'careers',
            profileUrl: '',
            headline: message || 'درخواست از پورتال شغلی',
            company: null,
            location: city,
            openToWork: true,
            searchId: null,
            referrer: referrer?.name || null,
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

      // A real member code of an enabled program becomes a tracked referral;
      // anything else is ignored (the answer to «چطور آشنا شدید؟» still stands).
      if (ref) {
        const tracked = recordReferral({
          orgId: org.id,
          jobId: job.id,
          jobTitle: job.roleTitle,
          resumeId: record.id,
          candidateName: name,
          code: ref,
          heardFrom: heardFrom || null,
        });
        if (tracked) {
          db.logActivity(org.id, null, 'sourcing.imported', `«${name}» با معرفی «${tracked.referrerName}» درخواست داد`, {
            jobId: job.id,
            resumeId: record.id,
          });
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
        url: `${careerOriginOf(req)}/careers/${org.careerSlug}`,
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
          url: `${careerOriginOf(req)}/careers/${updated.careerSlug}`,
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
      // The referral follows the funnel, including its money.
      if (stage.kind === 'hired') markOutcome(org.id, rec.id, 'hired', { id: user.id, name: user.name });
      else if (stage.kind === 'rejected') markOutcome(org.id, rec.id, 'rejected', { id: user.id, name: user.name });
      else if (stage.kind === 'offer') markOfferReached(org.id, rec.id);
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


/**
 * «پیشنهاد شغلی» — written in the workspace, sent on the workspace's own
 * mailbox, accepted by the candidate on a public page with a typed signature.
 *
 * Two routers, same as the career portal:
 *   • `offerPublicRoutes()` — the page the candidate opens (no session), looked
 *     up by an unguessable token, showing only what belongs on the offer;
 *   • `offerRoutes()` — drafts, sending, cancelling and the record for the
 *     workspace.
 *
 * Nothing here invents a delivery: if the mailbox is not configured, sending
 * fails with a clear code and the offer stays a draft.
 */
import crypto from 'crypto';
import express from 'express';
import * as db from '../db';
import { ctxOf } from '../auth';
import { h, str } from './util';
import { isEmailConfigured, sendMail, friendlySmtpError } from '../mailer';
import { formatJalaliDate, toPersianDigits } from '../../src/utils/jalali';
import { tehranJalaliOf } from '../tehran-time';
import { withinEmailLimit, noteEmailSend } from '../email-rate';
import type { JobOffer, OfferStatus, OfferTerms, PublicOffer } from '../../src/types/offers';
import { OFFER_STATUS_LABEL } from '../../src/types/offers';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function originOf(req: express.Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function publicUrl(req: express.Request, token: string): string {
  return `${originOf(req)}/offer/${token}`;
}

function withoutToken(row: db.OfferRow): JobOffer {
  const { orgId: _o, token: _t, updatedAtISO: _u, ...rest } = row;
  return rest;
}

function viewOf(req: express.Request, row: db.OfferRow): JobOffer {
  return { ...withoutToken(row), url: publicUrl(req, row.token) };
}

/** null / '' / an omitted field all mean «no number»; only a real figure becomes one. */
function readAmount(raw: unknown, base: number | null | undefined): number | null {
  if (raw === undefined) return base ?? null;
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : base ?? null;
}

/** Whatever the panel sends, made safe. Empty salary means «بدون عدد». */
function readTerms(raw: any, fallback?: OfferTerms): OfferTerms {
  const base = fallback || ({} as OfferTerms);
  const probation = Number(raw?.probationMonths);
  return {
    title: str(raw?.title, 120) || base.title || '',
    salaryAmount: readAmount(raw?.salaryAmount, base.salaryAmount),
    salaryPeriod: raw?.salaryPeriod === 'annual' ? 'annual' : raw?.salaryPeriod === 'monthly' ? 'monthly' : base.salaryPeriod || 'monthly',
    benefitsNote: typeof raw?.benefitsNote === 'string' ? raw.benefitsNote.slice(0, 600) : base.benefitsNote || '',
    startDate: str(raw?.startDate, 20) || base.startDate || '',
    location: str(raw?.location, 120) || base.location || '',
    employmentType: str(raw?.employmentType, 60) || base.employmentType || '',
    probationMonths: Number.isFinite(probation) ? Math.max(0, Math.min(12, Math.round(probation))) : base.probationMonths ?? 3,
    notes: typeof raw?.notes === 'string' ? raw.notes.slice(0, 1200) : base.notes || '',
  };
}

/** The default covering note, in the workspace's own voice. */
function defaultMessage(terms: OfferTerms, orgName: string): string {
  return [
    `سلام،`,
    '',
    `خوشحالیم که «${terms.title || 'این نقش'}» را در ${orgName} به شما پیشنهاد کنیم. جزئیات کامل در همین صفحه آمده است.`,
    '',
    'اگر شرایط را می‌پذیرید، نام و نام خانوادگی خودتان را در انتهای صفحه بنویسید و دکمهٔ «می‌پذیرم» را بزنید؛ همین، امضای الکترونیکی شماست. اگر نکته‌ای هست، همان‌جا برایمان بنویسید.',
    '',
    'با احترام',
    orgName,
  ].join('\n');
}

function emailBody(row: db.OfferRow, orgName: string, link: string): string {
  return [
    `${row.candidateName} عزیز،`,
    '',
    row.message.trim(),
    '',
    'جزئیات پیشنهاد و پاسخ شما در این نشانی است:',
    link,
    '',
    'این پیام از صندوق ایمیل رسمی سازمان فرستاده شده است.',
    '',
    orgName,
  ].join('\n');
}

// --------------------------------------------------------------- public -----

export function offerPublicRoutes() {
  const r = express.Router();

  r.get(
    '/offers/public/:token',
    h(async (req, res) => {
      const row = db.findOfferByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این پیشنهاد پیدا نشد یا نشانی آن کامل نیست.' });
      // A draft (and a draft that was cancelled before it ever went out) is
      // invisible to the candidate: the link exists, the offer does not.
      if (row.status === 'draft' || (row.status === 'cancelled' && !row.sentAtISO)) {
        return res.status(404).json({ error: 'این پیشنهاد هنوز برای شما فرستاده نشده است.' });
      }
      const org = db.getOrg(row.orgId);
      const offer: PublicOffer = {
        org: { name: org?.name || '', about: org?.careerAbout || '' },
        candidateName: row.candidateName,
        jobTitle: row.terms.title || row.jobTitle,
        terms: row.terms,
        message: row.message,
        status: row.status,
        sentAtJalali: row.sentAtJalali,
        respondedAtJalali: row.respondedAtJalali,
        signatureName: row.signatureName,
        signatureNote: row.signatureNote,
      };
      res.json({ offer });
    })
  );

  r.post(
    '/offers/public/:token/accept',
    h(async (req, res) => {
      const row = db.findOfferByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این پیشنهاد پیدا نشد.' });
      if (row.status === 'accepted') return res.json({ offer: publicOf(row), already: true });
      if (row.status !== 'sent') return res.status(409).json({ error: `این پیشنهاد در وضعیت «${OFFER_STATUS_LABEL[row.status]}» است و قابل پذیرش نیست.` });

      // The typed name is the signature: it must match the person we wrote to.
      const name = str(req.body?.name, 120);
      if (name.length < 3) return res.status(400).json({ error: 'برای امضا، نام و نام خانوادگی خود را کامل بنویسید.' });
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : '';

      const stamp = new Date();
      const done: db.OfferRow = {
        ...row,
        status: 'accepted',
        signatureName: name,
        signatureNote: note,
        respondedAtISO: stamp.toISOString(),
        respondedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        updatedAtISO: stamp.toISOString(),
      };
      db.saveOffer(done);

      // The funnel follows: the candidate is hired, in the «استخدام‌شده» column.
      const rec = db.getResume(row.orgId, row.resumeId);
      const job = rec ? db.getJob(row.orgId, rec.jobId) : null;
      if (rec) {
        const hired = db.stagesOf(job).find((s) => s.kind === 'hired');
        if (hired) db.setStage(rec, hired.id);
        db.setDecision(rec, 'approved', `پیشنهاد شغلی را پذیرفت (${done.respondedAtJalali})`, { id: 'candidate', name: row.candidateName });
      }
      db.logActivity(row.orgId, null, 'offer.accepted', `«${row.candidateName}» پیشنهاد شغلی «${row.terms.title || row.jobTitle}» را پذیرفت`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ offer: publicOf(done) });
    })
  );

  r.post(
    '/offers/public/:token/decline',
    h(async (req, res) => {
      const row = db.findOfferByToken(str(req.params.token, 80));
      if (!row) return res.status(404).json({ error: 'این پیشنهاد پیدا نشد.' });
      if (row.status === 'declined') return res.json({ offer: publicOf(row), already: true });
      if (row.status !== 'sent') return res.status(409).json({ error: `این پیشنهاد در وضعیت «${OFFER_STATUS_LABEL[row.status]}» است.` });
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : '';
      const stamp = new Date();
      const done: db.OfferRow = {
        ...row,
        status: 'declined',
        signatureName: str(req.body?.name, 120) || null,
        signatureNote: note || null,
        respondedAtISO: stamp.toISOString(),
        respondedAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        updatedAtISO: stamp.toISOString(),
      };
      db.saveOffer(done);
      db.logActivity(row.orgId, null, 'offer.declined', `«${row.candidateName}» پیشنهاد شغلی «${row.terms.title || row.jobTitle}» را نپذیرفت`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ offer: publicOf(done) });
    })
  );

  return r;
}

function publicOf(row: db.OfferRow): PublicOffer {
  const org = db.getOrg(row.orgId);
  return {
    org: { name: org?.name || '', about: org?.careerAbout || '' },
    candidateName: row.candidateName,
    jobTitle: row.terms.title || row.jobTitle,
    terms: row.terms,
    message: row.message,
    status: row.status,
    sentAtJalali: row.sentAtJalali,
    respondedAtJalali: row.respondedAtJalali,
    signatureName: row.signatureName,
    signatureNote: row.signatureNote,
  };
}

// ------------------------------------------------------------ workspace -----

export function offerRoutes() {
  const r = express.Router();

  r.get(
    '/offers',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const jobId = str(req.query.jobId, 80) || undefined;
      const resumeId = str(req.query.resumeId, 80) || undefined;
      const items = db.listOffers(org.id, { jobId, resumeId }).map((o) => viewOf(req, o));
      res.json({ items, counts: db.offerCounts(org.id) });
    })
  );

  r.get(
    '/offers/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (req.params.id === 'public') return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      res.json({ offer: viewOf(req, row) });
    })
  );

  /** A draft is a draft: it never leaves the workspace and never blocks the funnel. */
  r.post(
    '/offers',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const job = db.getJob(org.id, rec.jobId);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      if (db.openOfferFor(org.id, rec.id)) {
        return res.status(409).json({ error: 'برای این کارجو یک پیشنهاد باز وجود دارد؛ همان را ویرایش یا لغو کنید.' });
      }
      const terms = readTerms(req.body?.terms, {
        title: job.roleTitle,
        salaryAmount: null,
        salaryPeriod: 'monthly',
        benefitsNote: '',
        startDate: '',
        location: job.location || '',
        employmentType: job.employmentType || '',
        probationMonths: 3,
        notes: '',
      });
      if (!terms.title) return res.status(400).json({ error: 'عنوان شغلی پیشنهاد را بنویسید.' });
      if (!terms.startDate) return res.status(400).json({ error: 'تاریخ شروع همکاری را وارد کنید.' });

      const stamp = new Date();
      const row: db.OfferRow = {
        id: db.uid('off'),
        orgId: org.id,
        token: crypto.randomBytes(18).toString('base64url'),
        jobId: job.id,
        resumeId: rec.id,
        candidateName: rec.candidateName || rec.fileName,
        candidateEmail: rec.contact?.email || null,
        jobTitle: job.roleTitle,
        departmentName: rec.departmentName,
        status: 'draft',
        terms,
        message: typeof req.body?.message === 'string' && req.body.message.trim() ? req.body.message.slice(0, 4000) : defaultMessage(terms, org.name),
        createdByName: user.name,
        createdAtISO: stamp.toISOString(),
        createdAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        sentAtISO: null,
        sentAtJalali: null,
        respondedAtISO: null,
        respondedAtJalali: null,
        signatureName: null,
        signatureNote: null,
        updatedAtISO: stamp.toISOString(),
      };
      db.saveOffer(row);
      res.status(201).json({ offer: viewOf(req, row) });
    })
  );

  /** Editing is allowed while the offer has not left the workspace. */
  r.patch(
    '/offers/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      if (row.status !== 'draft') return res.status(409).json({ error: 'پیشنهاد فرستاده‌شده قابل ویرایش نیست؛ برای تغییر، پیشنهاد تازه بسازید.' });
      const next: db.OfferRow = {
        ...row,
        terms: readTerms(req.body?.terms, row.terms),
        message: typeof req.body?.message === 'string' ? req.body.message.slice(0, 4000) : row.message,
        updatedAtISO: new Date().toISOString(),
      };
      db.saveOffer(next);
      res.json({ offer: viewOf(req, next) });
    })
  );

  r.post(
    '/offers/:id/send',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      if (row.status === 'sent') return res.status(409).json({ error: 'این پیشنهاد پیش‌تر فرستاده شده است؛ می‌توانید نشانی را دوباره کپی کنید.' });
      if (row.status !== 'draft') return res.status(409).json({ error: `این پیشنهاد در وضعیت «${OFFER_STATUS_LABEL[row.status]}» است.` });
      const to = (row.candidateEmail || '').toLowerCase().trim();
      if (!EMAIL_RE.test(to)) return res.status(400).json({ error: 'برای این کارجو ایمیل معتبری ثبت نشده است؛ ابتدا آن را در پروفایل کامل کنید.' });
      if (!isEmailConfigured(db.getOrgSecrets(org.id))) {
        return res.status(409).json({
          error: 'صندوق ایمیل سازمان هنوز وصل نشده است؛ از «تنظیمات ← اتصال‌ها» آن را وصل کنید تا پیشنهاد از ایمیل خودتان برود.',
          code: 'EMAIL_NOT_CONFIGURED',
        });
      }
      if (!withinEmailLimit(org.id)) return res.status(429).json({ error: 'سقف ارسال ساعتی این فضای کاری پر شده است؛ کمی بعد دوباره تلاش کنید.' });

      const link = publicUrl(req, row.token);
      try {
        await sendMail(db.getOrgSecrets(org.id).email!, {
          to,
          subject: `پیشنهاد شغلی — ${row.terms.title || row.jobTitle}`,
          text: emailBody(row, org.name, link),
        });
        noteEmailSend(org.id);
      } catch (err: any) {
        db.saveEmail({
          id: db.uid('eml'),
          orgId: org.id,
          resumeId: row.resumeId,
          candidateName: row.candidateName,
          jobId: row.jobId,
          to,
          subject: `پیشنهاد شغلی — ${row.terms.title || row.jobTitle}`,
          body: emailBody(row, org.name, link),
          status: 'failed',
          error: friendlySmtpError(err),
          sentAtISO: new Date().toISOString(),
          sentAtJalali: formatJalaliDate(tehranJalaliOf(new Date()), true),
          sentByName: user.name,
          attachments: [],
        });
        return res.status(502).json({ error: `ارسال نشد: ${friendlySmtpError(err)}`, code: 'SMTP_FAILED' });
      }

      const stamp = new Date();
      const sent: db.OfferRow = {
        ...row,
        status: 'sent',
        sentAtISO: stamp.toISOString(),
        sentAtJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
        updatedAtISO: stamp.toISOString(),
      };
      db.saveOffer(sent);
      db.saveEmail({
        id: db.uid('eml'),
        orgId: org.id,
        resumeId: row.resumeId,
        candidateName: row.candidateName,
        jobId: row.jobId,
        to,
        subject: `پیشنهاد شغلی — ${row.terms.title || row.jobTitle}`,
        body: emailBody(row, org.name, link),
        status: 'sent',
        error: null,
        sentAtISO: stamp.toISOString(),
        sentAtJalali: sent.sentAtJalali!,
        sentByName: user.name,
        attachments: [],
      });
      if (db.getResume(org.id, row.resumeId)) db.markMessageSent(db.getResume(org.id, row.resumeId)!);
      db.logActivity(org.id, user, 'offer.sent', `پیشنهاد شغلی «${row.terms.title || row.jobTitle}» را برای «${row.candidateName}» فرستاد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ offer: viewOf(req, sent) });
    })
  );

  r.post(
    '/offers/:id/cancel',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      if (row.status !== 'draft' && row.status !== 'sent') {
        return res.status(409).json({ error: `پیشنهادی که «${OFFER_STATUS_LABEL[row.status]}» است لغو نمی‌شود.` });
      }
      const next: db.OfferRow = { ...row, status: 'cancelled' as OfferStatus, updatedAtISO: new Date().toISOString() };
      db.saveOffer(next);
      db.logActivity(org.id, user, 'offer.cancelled', `پیشنهاد شغلی «${row.terms.title || row.jobTitle}» را برای «${row.candidateName}» لغو کرد`, {
        jobId: row.jobId,
        resumeId: row.resumeId,
      });
      res.json({ offer: viewOf(req, next) });
    })
  );

  /** Salary is shown to the candidate; the panel needs a Persian-formatted figure. */
  r.get(
    '/offers/:id/preview',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getOffer(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'پیشنهاد یافت نشد.' });
      res.json({
        offer: viewOf(req, row),
        salaryLabel: row.terms.salaryAmount === null ? 'توافقی' : `${toPersianDigits(row.terms.salaryAmount.toLocaleString('en-US'))} تومان ${row.terms.salaryPeriod === 'annual' ? 'سالانه' : 'ماهانه'}`,
        daysOpen: Math.max(0, Math.round((Date.now() - new Date(row.sentAtISO || row.createdAtISO).getTime()) / 86_400_000)),
        probationLabel: row.terms.probationMonths ? `${toPersianDigits(row.terms.probationMonths)} ماه` : 'ندارد',
      });
    })
  );

  return r;
}

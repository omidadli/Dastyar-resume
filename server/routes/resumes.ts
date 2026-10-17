import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, signedFileUrl, verifyFileSignature } from '../auth';
import { draftMessage, evaluateResume, KIND_TITLES } from '../ai/screening';
import type { AiFile } from '../ai/provider';
import { ingestDocument } from '../ingest';
import { assessText } from '../../src/lib/officeText';
import { resetCircuitBreaker } from '../ai/provider';
import type {
  AnalysisMode,
  DecisionFilter,
  DecisionStatus,
  MatchFilter,
  MessageKind,
  ResumeRecord,
  ResumeSort,
} from '../../src/types/screening';
import { h, int, oneOf, str } from './util';
import { systemSettings } from '../platform';

/**
 * Content types we serve. Anything else (HTML, SVG, XML, scripts…) is sent as
 * an opaque download so an uploaded file can never run in our origin.
 */
const FILE_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv; charset=utf-8',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avif: 'image/avif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
};
/** Shown inline in the candidate panel; everything else is download-only. */
const PREVIEWABLE = ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'txt', 'md'];

const DECISION_VERB: Record<DecisionStatus, (name: string, role: string) => string> = {
  approved: (n, r) => `«${n}» را برای «${r}» تأیید کرد`,
  rejected: (n, r) => `«${n}» را برای «${r}» رد کرد`,
  review: (n) => `«${n}» را در وضعیت «نیاز به بررسی» گذاشت`,
  none: (n) => `تصمیم درباره «${n}» را بازگرداند`,
};

const displayName = (r: ResumeRecord) => r.candidateName || r.fileName;

function fileExt(rec: ResumeRecord): string {
  return (rec.filePath || rec.fileName).split('.').pop()?.toLowerCase() || 'bin';
}

export function resumeRoutes(): express.Router {
  const r = express.Router();

  r.get('/resumes', (req, res) => {
    const { org } = ctxOf(req);
    const q = req.query;
    res.json(
      db.queryResumes(org.id, {
        jobId: str(q.jobId, 80) || undefined,
        match: oneOf<MatchFilter>(q.match, ['all', 'high', 'review', 'low', 'insufficient'], 'all'),
        decision: oneOf<DecisionFilter>(q.decision, ['all', 'undecided', 'pending', 'approved', 'rejected', 'review'], 'all'),
        q: str(q.q, 120) || undefined,
        departmentId: str(q.departmentId, 80) || undefined,
        minScore: q.minScore ? int(q.minScore) : undefined,
        minYears: q.minYears ? int(q.minYears) : undefined,
        fromJalali: str(q.from, 10) || undefined,
        toJalali: str(q.to, 10) || undefined,
        sort: oneOf<ResumeSort>(q.sort, ['match', 'newest', 'oldest', 'experience', 'name', 'decided'], 'match'),
        page: q.page ? int(q.page, 1) : 1,
        pageSize: q.pageSize ? int(q.pageSize, 10) : 10,
      })
    );
  });

  r.get('/resumes/compare', (req, res) => {
    const { org } = ctxOf(req);
    const ids = str(req.query.ids, 1000)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const wanted = Array.from(new Set(ids)).slice(0, 4);
    const found = wanted.map((id) => db.getResume(org.id, id)).filter((r): r is ResumeRecord => Boolean(r));
    const items = db.getComparable(org.id, wanted);
    if (!items.length) return res.status(404).json({ error: 'کاندیدی برای مقایسه پیدا نشد؛ ممکن است حذف شده باشند.' });
    const job = db.getJob(org.id, items[0].jobId);
    res.json({
      job,
      items: items.map(db.toListItem),
      // Two different reasons for a shorter list — the page explains each one.
      droppedOtherJobs: found.length > items.length,
      missingIds: wanted.filter((id) => !found.some((r) => r.id === id)),
    });
  });

  r.post('/resumes/bulk', (req, res) => {
    const { org } = ctxOf(req);
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string').slice(0, 200) : [];
    const action = oneOf(req.body?.action, ['decision', 'delete'] as const, 'decision');
    const recs = ids.map((id) => db.getResume(org.id, id)).filter((x): x is ResumeRecord => Boolean(x));
    if (!recs.length) return res.status(400).json({ error: 'هیچ موردی انتخاب نشده است.' });
    if (action === 'delete') {
      recs.forEach((rec) => db.deleteResume(rec));
      db.logActivity(org.id, actorOf(req), 'resume.deleted', `${recs.length.toLocaleString('fa-IR')} رزومه را حذف کرد`, { jobId: recs[0].jobId });
      return res.json({ updated: recs.length });
    }
    const status = oneOf<DecisionStatus>(req.body?.status, ['approved', 'rejected', 'review', 'none'], 'review');
    const note = typeof req.body?.note === 'string' ? req.body.note : null;
    recs.forEach((rec) => db.setDecision(rec, status, note, actorOf(req)));
    const label = { approved: 'تأیید', rejected: 'رد', review: 'نیاز به بررسی', none: 'بدون تصمیم' }[status];
    db.logActivity(org.id, actorOf(req), 'decision', `وضعیت ${recs.length.toLocaleString('fa-IR')} کاندید را «${label}» ثبت کرد`, { jobId: recs[0].jobId });
    res.json({ updated: recs.length });
  });

  r.get('/resumes/:id', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    res.json({ record: rec, job: db.getJob(org.id, rec.jobId) });
  });

  r.patch('/resumes/:id', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    const action = str(req.body?.action, 30);
    if (action === 'decision') {
      const status = oneOf<DecisionStatus>(req.body?.status, ['approved', 'rejected', 'review', 'none'], 'none');
      if (req.body?.status !== status) return res.status(400).json({ error: 'وضعیت تصمیم نامعتبر است.' });
      const note = typeof req.body?.note === 'string' ? req.body.note : null;
      db.setDecision(rec, status, note, actorOf(req));
      db.logActivity(org.id, actorOf(req), 'decision', DECISION_VERB[status](displayName(rec), rec.roleTitle || rec.departmentName), {
        jobId: rec.jobId,
        resumeId: rec.id,
      });
      return res.json({ record: db.toListItem(rec) });
    }
    if (action === 'message-sent') {
      const kind = oneOf<MessageKind>(req.body?.kind, ['INTERVIEW_INVITE', 'INFO_REQUEST', 'BANK_NOTICE', 'REJECTION'], 'INTERVIEW_INVITE');
      db.markMessageSent(rec);
      db.logActivity(org.id, actorOf(req), 'message.sent', `پیام «${KIND_TITLES[kind]}» را برای «${displayName(rec)}» ارسال‌شده علامت زد`, {
        jobId: rec.jobId,
        resumeId: rec.id,
      });
      return res.json({ record: db.toListItem(rec) });
    }
    res.status(400).json({ error: 'عملیات نامعتبر است.' });
  });

  r.delete('/resumes/:id', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    db.deleteResume(rec);
    db.logActivity(org.id, actorOf(req), 'resume.deleted', `رزومه «${displayName(rec)}» را حذف کرد`, { jobId: rec.jobId });
    res.json({ ok: true, stats: db.getJob(org.id, rec.jobId)?.stats });
  });

  const rerun = (mode: AnalysisMode) =>
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const job = db.getJob(org.id, rec.jobId);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      resetCircuitBreaker(); // explicit user action — never blocked by short error cooldowns
      let text = rec.extractedText || '';
      let attachments: AiFile[] | undefined;
      let sourceLabel = rec.analysisMeta?.format ?? null;
      let intakeWarnings: string[] = [];
      let unreadable: string | null = null;
      const quality = assessText(text);
      // A deep review re-reads the original; a re-run reads it again only when
      // the stored text is unusable (scans, images, formats read on the server).
      if (mode === 'deep' || !quality.usable) {
        const buf = await db.readResumeFileBuffer(rec);
        if (buf) {
          const ing = await ingestDocument(buf, rec.fileName);
          attachments = ing.files;
          sourceLabel = ing.label;
          intakeWarnings = ing.warnings;
          if (!quality.usable && assessText(ing.text).letters > quality.letters) {
            text = ing.text;
            rec.extractedText = text.slice(0, 20000);
          }
          if (ing.unreadable && !ing.files.length && !assessText(text).usable) unreadable = ing.unreadable;
        }
      }
      const dept = org.departments.find((d) => d.id === job.departmentId);
      const evaluation = await evaluateResume({
        orgName: org.name,
        job: { ...job, departmentHint: dept?.hint },
        resumeText: text,
        fileName: rec.fileName,
        attachments,
        sourceLabel,
        intakeWarnings,
        mode,
      });
      // The AI call takes a while: a teammate may have deleted the resume meanwhile.
      if (db.getResume(org.id, rec.id) !== rec) return res.status(404).json({ error: 'این رزومه در این فاصله حذف شده است.' });
      db.updateResumeEvaluation(rec, evaluation, mode === 'deep' ? 'deep' : 'rerun');
      // Keep the specific, actionable reason (e.g. «RAR is not supported; send a ZIP»).
      if (unreadable && evaluation.flags.scannedNoText) rec.unjudgeableReason = unreadable;
      if (mode === 'deep' && evaluation.engine === 'ai') {
        db.logActivity(org.id, actorOf(req), 'deep.review', `بازبینی دقیق رزومه «${displayName(rec)}» را انجام داد`, { jobId: rec.jobId, resumeId: rec.id });
      }
      res.json({ record: rec, engine: evaluation.engine, mode });
    });

  r.post('/resumes/:id/rerun', rerun('standard'));
  r.post('/resumes/:id/deep-rerun', rerun('deep'));

  r.post('/resumes/:id/talent', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    const departmentId = str(req.body?.departmentId, 60);
    const dept = org.departments.find((d) => d.id === departmentId);
    if (!dept) return res.status(400).json({ error: 'دپارتمان مقصد را انتخاب کنید.' });
    // Trimmed, non-empty, unique, at most 12 (the form's limit) — whatever the client sends.
    const rawTags: unknown[] = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const tags = Array.from(new Set(rawTags.filter((t): t is string => typeof t === 'string').map((t) => t.trim().slice(0, 40)).filter(Boolean))).slice(0, 12);
    const wasInBank = rec.inBank;
    db.addToTalent(rec, dept.id, str(req.body?.note, 400), tags);
    db.logActivity(
      org.id,
      actorOf(req),
      'talent.added',
      wasInBank ? `اطلاعات «${displayName(rec)}» را در بانک استعداد «${dept.name}» به‌روز کرد` : `«${displayName(rec)}» را به بانک استعداد «${dept.name}» افزود`,
      { jobId: rec.jobId, resumeId: rec.id }
    );
    res.json({ record: db.toListItem(rec) });
  });

  r.delete('/resumes/:id/talent', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    res.json({ record: db.toListItem(db.removeFromTalent(rec)) });
  });

  /** Background upload of the original file after a fast text-only evaluation. */
  r.post(
    '/resumes/:id/file',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const rec = db.getResume(org.id, req.params.id);
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      const base64 = typeof req.body?.fileBase64 === 'string' ? req.body.fileBase64 : '';
      if (base64.length < 20) return res.status(400).json({ error: 'محتوای فایل الزامی است.' });
      const maxMb = systemSettings().maxFileMb;
      if (base64.length * 0.75 > maxMb * 1024 * 1024 + 4096) {
        return res.status(413).json({ error: `حجم فایل بیش از ${maxMb.toLocaleString('fa-IR')} مگابایت است.` });
      }
      const ok = await db.attachResumeFile(rec, str(req.body?.fileName, 200) || rec.fileName, base64);
      if (!ok) {
        // Deleted while the file was being written — not a server fault.
        if (!db.getResume(org.id, rec.id)) return res.status(404).json({ error: 'این رزومه حذف شده است.' });
        return res.status(500).json({ error: 'ذخیره فایل ممکن نشد.' });
      }
      res.json({ ok: true });
    })
  );

  /** Short-lived signed URL for previews/downloads (no bearer token in URLs). */
  r.get('/resumes/:id/file-url', (req, res) => {
    const { org } = ctxOf(req);
    const rec = db.getResume(org.id, req.params.id);
    if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
    const ext = fileExt(rec);
    const inline = str(req.query.inline, 2) === '1';
    if (!rec.filePath) {
      return res.json({ hasFile: false, url: null, expiresAt: null, fileName: rec.fileName, ext, mimeType: null, previewable: false });
    }
    const signed = signedFileUrl(rec.id, inline);
    res.json({
      hasFile: true,
      url: signed.url,
      expiresAt: signed.expiresAt,
      fileName: rec.fileName,
      ext,
      mimeType: FILE_MIME[ext] || 'application/octet-stream',
      previewable: PREVIEWABLE.includes(ext),
    });
  });

  r.post(
    '/messages/draft',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const kind = oneOf<MessageKind>(req.body?.kind, ['INTERVIEW_INVITE', 'INFO_REQUEST', 'BANK_NOTICE', 'REJECTION'], 'INTERVIEW_INVITE');
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      res.json(await draftMessage(rec, kind, org));
    })
  );

  return r;
}

/** Mounted WITHOUT requireAuth: access is granted by the HMAC signature. */
export function fileRoutes(): express.Router {
  const r = express.Router();
  r.get(
    '/files/:id',
    h(async (req, res) => {
      const id = req.params.id;
      const exp = Number(req.query.exp);
      const inline = str(req.query.inline, 2) === '1';
      if (!verifyFileSignature(id, exp, inline, str(req.query.sig, 200))) {
        return res.status(403).json({ error: 'پیوند فایل منقضی شده یا نامعتبر است؛ صفحه را تازه کنید.' });
      }
      const rec = db.getResumeUnsafe(id);
      if (!rec || !rec.filePath) return res.status(404).json({ error: 'فایل در دسترس نیست.' });
      const file = await db.openResumeFile(rec);
      if (!file) return res.status(404).json({ error: 'فایل روی سرور موجود نیست.' });
      const ext = fileExt(rec);
      const asInline = inline && PREVIEWABLE.includes(ext);
      res.setHeader('Content-Type', FILE_MIME[ext] || 'application/octet-stream');
      if (file.size) res.setHeader('Content-Length', String(file.size));
      res.setHeader('Content-Disposition', `${asInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(rec.fileName)}`);
      // Images and text can't script anyway; the sandbox is defence in depth.
      // (Not for PDFs: Chrome refuses to render a sandboxed PDF.)
      if (ext !== 'pdf') res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // The file can vanish between the check above and the read (deleted
      // resume, cleanup): answer 404 instead of crashing the process.
      file.stream.on('error', () => {
        if (!res.headersSent) {
          res.removeHeader('Content-Disposition');
          res.removeHeader('Content-Security-Policy');
          res.removeHeader('Content-Length');
          res.status(404).type('application/json').send(JSON.stringify({ error: 'فایل روی سرور موجود نیست.' }));
        } else {
          res.destroy();
        }
      });
      res.on('close', () => file.stream.destroy());
      file.stream.pipe(res);
    })
  );
  return r;
}

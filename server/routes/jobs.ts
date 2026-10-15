import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, hasRole } from '../auth';
import {
  buildTemplateUnderstanding,
  calibrate,
  detectResumeMime,
  evaluateResume,
  repairUnderstanding,
  understandJob,
} from '../ai/screening';
import type { CandidateEvaluation, EmploymentType, JobStatus, Recommendation, ScreeningAnswers } from '../../src/types/screening';
import type { Department } from '../../src/types/app';
import { matchesSearch } from '../../src/lib/normalizeFa';
import { h, oneOf, str } from './util';

const EMPLOYMENT: EmploymentType[] = ['full-time', 'part-time', 'contract', 'remote', 'hybrid', 'internship'];
const STATUS_LABEL: Record<JobStatus, string> = { open: 'باز', paused: 'متوقف', closed: 'بسته‌شده' };

function employmentOf(v: unknown): EmploymentType | null {
  return typeof v === 'string' && (EMPLOYMENT as string[]).includes(v) ? (v as EmploymentType) : null;
}

function departmentOf(req: express.Request, id: unknown): Department | null {
  const { org } = ctxOf(req);
  return (typeof id === 'string' && org.departments.find((d) => d.id === id)) || null;
}

function sanitizeAnswers(raw: unknown): ScreeningAnswers {
  const out: ScreeningAnswers = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string') out[k] = v.slice(0, 60);
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 12).map((x) => String(x).slice(0, 60));
  }
  return out;
}

function recommendationFor(score: number, t: { interview: number; review: number }): Recommendation {
  if (score >= t.interview) return 'INTERVIEW';
  if (score >= t.review) return 'REVIEW';
  return 'REJECT';
}

export function jobRoutes(): express.Router {
  const r = express.Router();

  r.get('/jobs', (req, res) => {
    const { org } = ctxOf(req);
    const status = oneOf(req.query.status, ['all', 'open', 'paused', 'closed'] as const, 'all');
    const q = str(req.query.q, 100);
    const all = db.listJobs(org.id).filter((j) => !q || matchesSearch([j.roleTitle, j.departmentName, j.location], q));
    res.json({
      items: all.filter((j) => status === 'all' || j.status === status).map(db.toJobSummary),
      counts: {
        all: all.length,
        open: all.filter((j) => j.status === 'open').length,
        paused: all.filter((j) => j.status === 'paused').length,
        closed: all.filter((j) => j.status === 'closed').length,
      },
    });
  });

  r.post(
    '/jobs/understand',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const department = departmentOf(req, req.body?.departmentId);
      if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
      const roleTitle = str(req.body?.roleTitle, 120);
      if (roleTitle.length < 2) return res.status(400).json({ error: 'عنوان فرصت شغلی را وارد کنید.' });
      try {
        const understanding = await understandJob({
          orgName: org.name,
          department,
          roleTitle,
          extraNotes: str(req.body?.extraNotes, 3000),
          location: str(req.body?.location, 80),
          employmentType: employmentOf(req.body?.employmentType),
        });
        res.json({ understanding, source: 'ai' });
      } catch (err: any) {
        res.status(503).json({ error: err?.message || 'تحلیل شغل با هوش مصنوعی ممکن نشد.', code: 'AI_FAILED', templateAvailable: true });
      }
    })
  );

  r.post('/jobs/template', (req, res) => {
    const department = departmentOf(req, req.body?.departmentId);
    if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
    res.json({ understanding: buildTemplateUnderstanding(department, str(req.body?.roleTitle, 120)), source: 'template' });
  });

  r.post('/jobs', (req, res) => {
    const { org } = ctxOf(req);
    const department = departmentOf(req, req.body?.departmentId);
    if (!department) return res.status(400).json({ error: 'دپارتمان را انتخاب کنید.' });
    const roleTitle = str(req.body?.roleTitle, 120);
    if (roleTitle.length < 2) return res.status(400).json({ error: 'عنوان فرصت شغلی را وارد کنید.' });
    const understanding = repairUnderstanding(req.body?.understanding, department, roleTitle, { userEdited: true });
    if (!understanding) return res.status(400).json({ error: 'معیارهای ارزیابی ناقص است؛ دوباره تلاش کنید.' });
    const job = db.createJob(org.id, actorOf(req), {
      departmentId: department.id,
      departmentName: department.name,
      roleTitle,
      extraNotes: str(req.body?.extraNotes, 3000),
      location: str(req.body?.location, 80),
      employmentType: employmentOf(req.body?.employmentType),
      understanding,
      answers: sanitizeAnswers(req.body?.answers),
      criteriaSource: req.body?.criteriaSource === 'template' ? 'template' : 'ai',
    });
    db.logActivity(org.id, actorOf(req), 'job.created', `فرصت شغلی «${job.roleTitle}» را ایجاد کرد`, { jobId: job.id });
    res.status(201).json({ job });
  });

  r.get('/jobs/:id', (req, res) => {
    const { org } = ctxOf(req);
    const job = db.getJob(org.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
    res.json({ job });
  });

  r.patch('/jobs/:id', (req, res) => {
    const { org } = ctxOf(req);
    const job = db.getJob(org.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
    const prevStatus = job.status;
    const status = req.body?.status ? oneOf<JobStatus>(req.body.status, ['open', 'paused', 'closed'], job.status) : undefined;
    const updated = db.updateJob(org.id, job.id, {
      ...(typeof req.body?.roleTitle === 'string' ? { roleTitle: str(req.body.roleTitle, 120) } : {}),
      ...(typeof req.body?.extraNotes === 'string' ? { extraNotes: str(req.body.extraNotes, 3000) } : {}),
      ...(typeof req.body?.location === 'string' ? { location: str(req.body.location, 80) } : {}),
      ...(req.body?.employmentType !== undefined ? { employmentType: employmentOf(req.body.employmentType) } : {}),
      ...(status ? { status } : {}),
    });
    if (updated && status && status !== prevStatus) {
      db.logActivity(org.id, actorOf(req), 'job.status', `وضعیت «${updated.roleTitle}» را به «${STATUS_LABEL[status]}» تغییر داد`, { jobId: job.id });
    }
    res.json({ job: updated });
  });

  r.delete('/jobs/:id', (req, res) => {
    const { org, user } = ctxOf(req);
    const job = db.getJob(org.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
    if (!hasRole(user.role, 'admin') && job.createdBy !== user.id) {
      return res.status(403).json({ error: 'فقط سازنده این فرصت شغلی یا مدیر فضای کاری می‌تواند آن را حذف کند.' });
    }
    db.deleteJob(org.id, job.id);
    db.logActivity(org.id, actorOf(req), 'job.deleted', `فرصت شغلی «${job.roleTitle}» را همراه رزومه‌هایش حذف کرد`);
    res.json({ ok: true });
  });

  /** Runner lifecycle: marks the job as processing / done so every teammate sees it. */
  r.post('/jobs/:id/analysis', (req, res) => {
    const { org } = ctxOf(req);
    const job = db.getJob(org.id, req.params.id);
    if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
    const state = oneOf(req.body?.state, ['start', 'cancel'] as const, 'start');
    db.updateJob(org.id, job.id, { analysisStatus: state === 'start' ? 'processing' : 'cancelled' });
    res.json({ job: db.getJob(org.id, job.id) });
  });

  r.post(
    '/jobs/:id/evaluate',
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const job = db.getJob(org.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      if (job.status === 'closed') {
        return res.status(409).json({ error: 'این فرصت شغلی بسته شده است؛ برای افزودن رزومه ابتدا آن را دوباره باز کنید.' });
      }
      const fileName = str(req.body?.fileName, 200);
      if (!fileName) return res.status(400).json({ error: 'نام فایل الزامی است.' });
      const fileBase64 = typeof req.body?.fileBase64 === 'string' && req.body.fileBase64.length > 50 ? (req.body.fileBase64 as string) : undefined;
      const errorMessage = req.body?.errorMessage ? str(req.body.errorMessage, 300) : undefined;
      let text = typeof req.body?.extractedText === 'string' ? (req.body.extractedText as string).slice(0, 60000) : '';
      const ext = fileName.split('.').pop()?.toLowerCase() || '';

      let evaluation: CandidateEvaluation | undefined;
      let reason: string | null = null;
      try {
        if ((fileBase64 || text.trim()) && !errorMessage) {
          // Word/plain text uploaded without client-side extraction: extract here.
          if (text.trim().length < 30 && fileBase64) {
            try {
              const buf = Buffer.from(fileBase64, 'base64');
              if (ext === 'docx') {
                const mammoth = await import('mammoth');
                const out = await mammoth.extractRawText({ buffer: buf });
                if (out?.value?.trim().length > 10) text = out.value.trim();
              } else if (['txt', 'md', 'csv', 'log', 'rtf'].includes(ext)) {
                text = buf.toString('utf8').trim();
              }
            } catch (extractErr: any) {
              console.warn('server-side extraction failed:', extractErr?.message);
            }
          }
          evaluation = await evaluateResume({
            orgName: org.name,
            job,
            resumeText: text,
            fileName,
            fileBase64,
            fileMime: detectResumeMime(fileName, fileBase64),
          });
          if (evaluation.flags.scannedNoText) {
            reason = 'فایل رزومه محتوای خواندنی ندارد (فایل خالی، اسکن ناخوانا یا تصویر بدون متن).';
          }
        } else if (req.body?.unjudgeableReason) {
          reason = str(req.body.unjudgeableReason, 300);
        }
      } catch (err: any) {
        console.error('evaluate failed:', err?.message);
      }

      const record = await db.saveEvaluation({
        job,
        uploadedBy: user.id,
        fileName,
        extractedText: text,
        unjudgeableReason: reason,
        fileBase64,
        evaluation,
        errorMessage: evaluation || reason ? undefined : errorMessage || 'تحلیل این فایل ممکن نشد؛ دوباره تلاش کنید.',
      });
      res.json({ record: db.toListItem(record), stats: db.getJob(org.id, job.id)?.stats });
    })
  );

  /** Pass 2 + finish: relative calibration, then marks the analysis complete. */
  r.post(
    '/jobs/:id/calibrate',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const job = db.getJob(org.id, req.params.id);
      if (!job) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
      const count = Math.max(0, Math.min(1000, Number(req.body?.count) || 0));
      const pool = db
        .queryResumes(org.id, { jobId: job.id, pageSize: 100, sort: 'match' })
        .items.filter((r) => r.engine === 'ai' && ['INTERVIEW', 'REVIEW', 'REJECT'].includes(r.category));
      let adjusted = 0;
      if (pool.length > 1) {
        const t = job.understanding.thresholds;
        const chosen = new Map<string, (typeof pool)[number]>();
        pool.slice(0, 15).forEach((r) => chosen.set(r.id, r));
        for (const r of pool) {
          if (Math.abs(r.score - t.interview) <= 5 || Math.abs(r.score - t.review) <= 5) chosen.set(r.id, r);
        }
        const adjustments = await calibrate(
          job.understanding,
          Array.from(chosen.values()).map((r) => ({ id: r.id, name: r.candidateName || r.fileName, score: r.score, summary: r.summary }))
        );
        for (const [id, score] of Object.entries(adjustments)) {
          const rec = db.getResume(org.id, id);
          if (!rec || rec.score === score) continue;
          db.applyCalibration(rec, score, recommendationFor(score, t));
          adjusted++;
        }
      }
      db.recomputeJob(job.id);
      db.updateJob(org.id, job.id, { analysisStatus: 'done' });
      if (count > 0) {
        db.logActivity(org.id, actorOf(req), 'analysis.completed', `${count.toLocaleString('fa-IR')} رزومه را برای «${job.roleTitle}» تحلیل کرد`, { jobId: job.id });
      }
      res.json({ job: db.getJob(org.id, job.id), adjusted });
    })
  );

  return r;
}

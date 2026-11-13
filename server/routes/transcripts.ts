/**
 * «رونویسی گفتار» — the workspace routes, plus one public (signed) playback
 * route for the original recording.
 *
 * The status endpoint exists because HR deserves to know *before* uploading a
 * 30 MB call whether auto-transcription is configured on this deployment.
 */
import express from 'express';
import type { Request } from 'express';
import * as db from '../db';
import { actorOf, ctxOf, signedTranscriptUrl, verifyTranscriptSignature } from '../auth';
import { blockedByBlind } from '../blind';
import { blockedByResume } from '../job-access';
import { h, str } from './util';
import {
  MAX_MEDIA_BYTES,
  TranscriptError,
  addAudio,
  addFromVideoAnswer,
  addManualText,
  addSubtitle,
  canTranscribeNow,
  readMedia,
  remove,
  setText,
} from '../transcripts';
import type { Transcript, TranscriptStatusPayload } from '../../src/types/transcript';
import { SummaryError, removeSummary, summarize } from '../summaries';
import type { MeetingSummary } from '../../src/types/summary';

function fail(res: express.Response, err: unknown) {
  if (err instanceof TranscriptError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof SummaryError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

function summaryView(row: db.SummaryRow): MeetingSummary {
  const { orgId: _o, ...rest } = row;
  return rest;
}

/** A transcript belongs to a candidate; if that candidate is out of reach, so is it. */
function guardTranscript(req: Request, res: express.Response, row: db.TranscriptRow): boolean {
  const rec = db.getResume(row.orgId, row.resumeId);
  if (!rec) return false;
  return blockedByResume(req, res, rec);
}

function originOf(req: Request): string {
  const fixed = (process.env.PUBLIC_URL || '').trim();
  if (fixed) return fixed.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function viewOf(row: db.TranscriptRow, withUrl = true): Transcript {
  const { orgId: _o, filePath, ...rest } = row;
  void originOf;
  return { ...rest, status: row.status, audioUrl: withUrl && filePath ? signedTranscriptUrl(row.id).url : null };
}

export function transcriptPublicRoutes() {
  const r = express.Router();

  /** Signed playback of the original audio/video. No session, no path guessing. */
  r.get(
    '/transcripts/watch/:id',
    h(async (req, res) => {
      const id = str(req.params.id, 80);
      if (!verifyTranscriptSignature(id, Number(req.query.exp), str(req.query.sig, 200))) {
        return res.status(403).json({ error: 'این لینک پخش منقضی شده است؛ صفحه را تازه کنید.' });
      }
      const row = db.findTranscriptById(id);
      if (!row) return res.status(404).json({ error: 'این رونویسی پیدا نشد.' });
      const file = await readMedia(row);
      if (!file) return res.status(404).json({ error: 'فایل اصلی این رونویسی موجود نیست.' });
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (m) {
        const total = file.buffer.length;
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
          res.setHeader('Content-Range', `bytes */${total}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        return res.end(file.buffer.subarray(start, end + 1));
      }
      res.setHeader('Content-Length', String(file.buffer.length));
      res.end(file.buffer);
    })
  );

  return r;
}

export function transcriptRoutes() {
  const r = express.Router();

  // A transcript quotes the person. While «غربالگری بی‌طرف» is on, it is closed
  // like the résumé file itself — not redacted sentence by sentence, which would
  // silently break the text.
  // Scoped to the transcript paths on purpose: an unscoped router-level guard
  // would also close every `/api` route mounted after this one (referrals, the
  // payroll hand-off, live rooms), which is not what blind screening means.
  r.use('/transcripts', (req, res, next) => {
    if (blockedByBlind(ctxOf(req).org, res)) return;
    next();
  });

  /** Whether auto-transcription is possible here, and why not when it is not. */
  r.get(
    '/transcripts/status',
    h(async (_req, res) => {
      const capability = canTranscribeNow();
      const payload: TranscriptStatusPayload = { aiReady: Boolean(capability.label), aiReason: capability.reason, canTranscribe: capability.ready };
      res.json(payload);
    })
  );

  r.get(
    '/transcripts',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const resumeId = str(req.query.resumeId, 80);
      const videoInviteId = str(req.query.videoInviteId, 80);
      if (!resumeId && !videoInviteId) return res.status(400).json({ error: 'کارجو یا مصاحبه را مشخص کنید.' });
      const candidate = resumeId ? db.getResume(org.id, resumeId) : null;
      if (candidate && blockedByResume(req, res, candidate)) return;
      const rows = db.listTranscripts(org.id, {
        ...(resumeId ? { resumeId } : {}),
        ...(videoInviteId ? { videoInviteId } : {}),
      });
      res.json({ items: rows.map((row) => viewOf(row)) });
    })
  );

  r.get(
    '/transcripts/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const row = db.getTranscript(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این رونویسی پیدا نشد.' });
      if (guardTranscript(req, res, row)) return;
      res.json({ transcript: viewOf(row) });
    })
  );

  /** A recording. Auto when a provider can read it; otherwise kept for manual text. */
  r.post(
    '/transcripts/audio',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      const size = typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64.length : 0;
      if (size > MAX_MEDIA_BYTES * 1.4) return res.status(413).json({ error: 'حجم فایل بیش از حد مجاز است.' });
      try {
        const result = await addAudio(org.id, rec, req.body || {}, actorOf(req).name);
        res.status(result.row.status === 'ready' ? 201 : 202).json({ transcript: viewOf(result.row), note: result.note });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** Typed or pasted text — the path that needs no key at all. */
  r.post(
    '/transcripts/text',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      try {
        const row = addManualText(org.id, rec, { text: req.body?.text, title: req.body?.title }, actorOf(req).name);
        res.status(201).json({ transcript: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** An `.srt` / `.vtt` / `.txt` file, parsed on this server with its timings. */
  r.post(
    '/transcripts/subtitle',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const rec = db.getResume(org.id, str(req.body?.resumeId, 80));
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      try {
        const row = addSubtitle(org.id, rec, { content: req.body?.content, fileName: req.body?.fileName }, actorOf(req).name);
        res.status(201).json({ transcript: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** One recorded video answer, transcribed by the configured provider. */
  r.post(
    '/transcripts/video/:inviteId/:questionId',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const invite = db.getVideoInvite(org.id, str(req.params.inviteId, 80));
      if (!invite) return res.status(404).json({ error: 'این مصاحبه پیدا نشد.' });
      const rec = invite.resumeId ? db.getResume(org.id, invite.resumeId) : null;
      if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
      if (blockedByResume(req, res, rec)) return;
      try {
        const result = await addFromVideoAnswer(org.id, rec, invite, str(req.params.questionId, 40), actorOf(req).name);
        res.status(result.row.status === 'ready' ? 201 : 202).json({ transcript: viewOf(result.row), note: result.note });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.patch(
    '/transcripts/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const existing = db.getTranscript(org.id, str(req.params.id, 80));
      if (existing && guardTranscript(req, res, existing)) return;
      try {
        const row = setText(org.id, str(req.params.id, 80), { text: req.body?.text, title: req.body?.title }, actorOf(req).name);
        res.json({ transcript: viewOf(row) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.delete(
    '/transcripts/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const existing = db.getTranscript(org.id, str(req.params.id, 80));
      if (existing && guardTranscript(req, res, existing)) return;
      const ok = await remove(org.id, str(req.params.id, 80), actorOf(req).name);
      if (!ok) return res.status(404).json({ error: 'این رونویسی پیدا نشد.' });
      res.status(204).end();
    })
  );

  /** «خلاصهٔ جلسه» — the ten lines someone will actually read. */
  r.post(
    '/transcripts/:id/summary',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const row = db.getTranscript(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این رونویسی پیدا نشد.' });
      if (guardTranscript(req, res, row)) return;
      try {
        const result = await summarize(org.id, row.id, actorOf(req).name);
        res.status(201).json({ summary: summaryView(result.summary), fellBack: result.fellBack, note: result.note });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/summaries',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const resumeId = str(req.query.resumeId, 80);
      const transcriptId = str(req.query.transcriptId, 80);
      if (!resumeId && !transcriptId) return res.status(400).json({ error: 'کارجو یا رونویسی را مشخص کنید.' });
      if (resumeId) {
        const rec = db.getResume(org.id, resumeId);
        if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
        if (blockedByResume(req, res, rec)) return;
      }
      const items = db.listSummaries(org.id, { ...(resumeId ? { resumeId } : {}), ...(transcriptId ? { transcriptId } : {}) });
      res.json({ items: items.map(summaryView) });
    })
  );

  r.delete(
    '/summaries/:id',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getSummary(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'این خلاصه پیدا نشد.' });
      const rec = db.getResume(org.id, row.resumeId);
      if (rec && blockedByResume(req, res, rec)) return;
      removeSummary(org.id, row.id);
      res.status(204).end();
    })
  );

  return r;
}

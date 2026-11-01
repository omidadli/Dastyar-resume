/**
 * «اتاق مصاحبهٔ زنده» — signalling routes.
 *
 * Two families, deliberately separate:
 *   • public  — the candidate, keyed by the room token, can only ever speak as
 *     «candidate»; the server forces the role, so a token cannot fake a host;
 *   • session — the workspace, whose members only see rooms of jobs they are
 *     allowed to see.
 *
 * Neither family ever carries media, and neither writes a signal to disk.
 */
import express from 'express';
import { actorOf, ctxOf } from '../auth';
import { blockedByBlind } from '../blind';
import { blockedByJobId, blockedByResume } from '../job-access';
import * as db from '../db';
import {
  RoomError,
  appendSignal,
  assertLive,
  closeRoom,
  createRoomForInterview,
  listRoomsFor,
  pollFor,
  publicRoomOf,
  roomByToken,
  stateOf,
  touchPresence,
} from '../room';
import { iceServersFor, relayNote, turnStatus } from '../turn';
import { h, str } from './util';

function fail(res: express.Response, err: unknown) {
  if (err instanceof RoomError) return res.status(err.status).json({ error: err.message, code: err.code });
  throw err;
}

export function roomsPublicRoutes() {
  const r = express.Router();

  const open = (req: express.Request) => {
    const row = roomByToken(str(req.params.token, 120));
    assertLive(row);
    touchPresence(row.id, 'candidate');
    return row;
  };

  r.get(
    '/rooms/public/:token',
    h(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      try {
        const row = roomByToken(str(req.params.token, 120));
        const state = stateOf(row);
        if (state === 'expired') {
          return res.status(410).json({ error: 'اعتبار این اتاق تمام شده است؛ از منابع انسانی یک اتاق تازه بخواهید.', code: 'ROOM_EXPIRED' });
        }
        // A closed room still answers once, so the page can say why it is over.
        res.json({ room: publicRoomOf(row), state });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** The candidate's heartbeat and inbox, in one call. */
  r.get(
    '/rooms/public/:token/signals',
    h(async (req, res) => {
      try {
        const row = open(req);
        res.setHeader('Cache-Control', 'no-store');
        res.json(pollFor(row, req.query.since));
      } catch (err) {
        fail(res, err);
      }
    })
  );

  /** The candidate may say only offer/answer/ice/bye — never «host». */
  r.post(
    '/rooms/public/:token/signal',
    h(async (req, res) => {
      try {
        const row = open(req);
        const signal = appendSignal(row.id, 'candidate', req.body?.kind, req.body?.payload);
        res.status(201).json({ signal });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/rooms/public/:token/leave',
    h(async (req, res) => {
      try {
        const row = roomByToken(str(req.params.token, 120));
        try {
          appendSignal(row.id, 'candidate', 'bye', 'candidate-left');
        } catch {
          // Leaving is best-effort: a dead tab is not an error worth showing.
        }
        res.json({ ok: true });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

export function roomRoutes() {
  const r = express.Router();

  /** One click from the interview: get the room, or the link you already have. */
  r.post(
    '/interviews/:id/room',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const interview = db.getInterview(org.id, str(req.params.id, 80));
      if (!interview) return res.status(404).json({ error: 'جلسه پیدا نشد.' });
      if (blockedByJobId(req, res, interview.jobId)) return;
      try {
        const { room, reused } = createRoomForInterview(org.id, actorOf(req), interview.id);
        res.status(reused ? 200 : 201).json({ room, reused });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.get(
    '/rooms',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const interviewId = str(req.query.interviewId, 80) || undefined;
      const jobId = str(req.query.jobId, 80) || undefined;
      const resumeId = str(req.query.resumeId, 80) || undefined;
      if (jobId && blockedByJobId(req, res, jobId)) return;
      if (resumeId) {
        const rec = db.getResume(org.id, resumeId);
        if (!rec) return res.status(404).json({ error: 'رزومه یافت نشد.' });
        if (blockedByResume(req, res, rec)) return;
      }
      res.json({ items: listRoomsFor(org.id, { interviewId, jobId, resumeId }) });
    })
  );

  /** The host opens the same `/room/<token>` address; this tells the page which side it is. */
  r.get(
    '/rooms/by-token/:token',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.findRoomByToken(str(req.params.token, 120));
      if (!row || row.orgId !== org.id) return res.status(404).json({ error: 'اتاق پیدا نشد.', code: 'ROOM_NOT_FOUND' });
      if (blockedByJobId(req, res, row.jobId)) return;
      if (blockedByBlind(org, res)) return;
      res.json({
        room: listRoomsFor(org.id, { interviewId: row.interviewId || undefined }).find((r) => r.id === row.id) || null,
        // The host's own ephemeral relay credentials (never the candidate's).
        ice: { servers: iceServersFor(org.id, 'host'), relayConfigured: turnStatus(org.id).configured, note: relayNote(org) },
      });
    })
  );

  /** The host's page: same polling contract, but the role is forced to «host». */
  r.get(
    '/rooms/:id/signals',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getRoom(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'اتاق پیدا نشد.' });
      if (blockedByJobId(req, res, row.jobId)) return;
      // Opening blind mode mid-call is a decision to hide identity: the host's
      // side stops here, while the candidate's link simply ends.
      if (blockedByBlind(org, res)) return;
      const state = stateOf(row);
      if (state === 'open') touchPresence(row.id, 'host');
      res.setHeader('Cache-Control', 'no-store');
      res.json(pollFor(row, req.query.since));
    })
  );

  r.post(
    '/rooms/:id/signal',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const row = db.getRoom(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'اتاق پیدا نشد.' });
      if (blockedByJobId(req, res, row.jobId)) return;
      // Opening blind mode mid-call is a decision to hide identity: the host's
      // side stops here, while the candidate's link simply ends.
      if (blockedByBlind(org, res)) return;
      try {
        assertLive(row);
        const signal = appendSignal(row.id, 'host', req.body?.kind, req.body?.payload);
        res.status(201).json({ signal });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  r.post(
    '/rooms/:id/close',
    h(async (req, res) => {
      const { org } = ctxOf(req);
      if (blockedByBlind(org, res)) return;
      const row = db.getRoom(org.id, str(req.params.id, 80));
      if (!row) return res.status(404).json({ error: 'اتاق پیدا نشد.' });
      if (blockedByJobId(req, res, row.jobId)) return;
      // Opening blind mode mid-call is a decision to hide identity: the host's
      // side stops here, while the candidate's link simply ends.
      if (blockedByBlind(org, res)) return;
      try {
        res.json({ room: closeRoom(org.id, row.id, actorOf(req)) });
      } catch (err) {
        fail(res, err);
      }
    })
  );

  return r;
}

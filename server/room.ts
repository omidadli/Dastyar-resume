/**
 * «اتاق مصاحبهٔ زنده» — a P2P video room, with the server doing only signalling.
 *
 * Design rules:
 *   • **No media ever reaches this process.** The browser sends a few short
 *     messages (SDP offer/answer, ICE candidates); the video and voice go
 *     directly between the two machines.
 *   • **Nothing about the call is stored.** Signals live in memory and die with
 *     the process; a restart empties the room and both sides reconnect.
 *   • **Self-destructing by design.** A link dies four hours after the call was
 *     meant to start, and HR can close it earlier with one click.
 *   • **One room per interview.** Asking twice returns the same link, so two
 *     links can never be live for the same call.
 *   • **Honest about the network.** Only STUN is configured by default: on a
 *     network that blocks direct connections (symmetric NAT / strict corporate
 *     firewall) the call will not connect. TURN relay needs a paid server, so
 *     the page says so instead of pretending the connection works everywhere.
 */
import crypto from 'crypto';
import * as db from './db';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import { iceServersFor, relayNote, turnStatus } from './turn';
import type { PublicRoom, RoomPoll, RoomPresence, RoomRole, RoomSignal, SignalKind } from '../src/types/room';

export class RoomError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'ROOM_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const HOUR = 3_600_000;
const SIGNAL_CAP = 400;
const PAYLOAD_CAP = 24_000;
const CHAT_CAP = 2_000;
const PRESENCE_WINDOW_MS = 12_000;
const KINDS: SignalKind[] = ['offer', 'answer', 'ice', 'chat', 'screen', 'bye'];

/** In-memory only: signals and presence are not part of the snapshot. */
const signals = new Map<string, RoomSignal[]>();
const presence = new Map<string, { host: number; candidate: number }>();

function presenceOf(roomId: string): RoomPresence {
  const p = presence.get(roomId) || { host: 0, candidate: 0 };
  const now = Date.now();
  const hostOnline = now - p.host < PRESENCE_WINDOW_MS;
  const candidateOnline = now - p.candidate < PRESENCE_WINDOW_MS;
  return {
    hostLastSeenISO: p.host ? new Date(p.host).toISOString() : null,
    candidateLastSeenISO: p.candidate ? new Date(p.candidate).toISOString() : null,
    hostOnline,
    candidateOnline,
  };
}

export function touchPresence(roomId: string, role: RoomRole) {
  const p = presence.get(roomId) || { host: 0, candidate: 0 };
  p[role] = Date.now();
  presence.set(roomId, p);
}

export function signalsFor(roomId: string): RoomSignal[] {
  return signals.get(roomId) || [];
}

export function appendSignal(roomId: string, role: RoomRole, kindRaw: unknown, payloadRaw: unknown): RoomSignal {
  const kind = String(kindRaw || '') as SignalKind;
  if (!KINDS.includes(kind)) {
    throw new RoomError('نوع پیام اتاق معتبر نیست.', 400, 'BAD_SIGNAL_KIND');
  }
  const payload = typeof payloadRaw === 'string' ? payloadRaw : '';
  if (!payload) throw new RoomError('بدنهٔ پیام اتاق خالی است.', 400, 'BAD_SIGNAL_PAYLOAD');
  if (payload.length > PAYLOAD_CAP) throw new RoomError('پیام اتاق بیش از حد بزرگ است.', 413, 'SIGNAL_TOO_LARGE');
  // A chat line is a sentence, not a file: the room is not a place to send CVs.
  if (kind === 'chat' && payload.length > CHAT_CAP) {
    throw new RoomError('متن پیام بیش از حد بلند است؛ کوتاه‌تر بنویسید.', 413, 'CHAT_TOO_LONG');
  }
  const list = signals.get(roomId) || [];
  const row: RoomSignal = {
    seq: (list[list.length - 1]?.seq || 0) + 1,
    from: role,
    kind,
    payload,
    atISO: new Date().toISOString(),
  };
  list.push(row);
  // A long call must not grow memory without end: the oldest addressing
  // messages are useless once both sides have connected.
  while (list.length > SIGNAL_CAP) list.shift();
  signals.set(roomId, list);
  return row;
}

export function dropRoomMemory(roomId: string) {
  signals.delete(roomId);
  presence.delete(roomId);
}

function stamp(d: Date) {
  return formatJalaliDate(tehranJalaliOf(d), true);
}

/**
 * The link is good for the call, not for ever: four hours after «ساعت جلسه»,
 * or four hours from now when that moment has already passed.
 */
function expiryFor(scheduledStartISO: string | null): Date {
  const now = Date.now();
  const start = scheduledStartISO ? new Date(scheduledStartISO).getTime() : now;
  return new Date(Math.max(now, start) + 4 * HOUR);
}

function viewOf(row: db.InterviewRoomRow): import('../src/types/room').InterviewRoom {
  const { orgId: _o, token, ...rest } = row;
  return { ...rest, url: `/room/${token}`, presence: presenceOf(row.id) };
}

export function createRoomForInterview(orgId: string, actor: { id: string; name: string } | null, interviewId: string) {
  const interview = db.getInterview(orgId, interviewId);
  if (!interview) throw new RoomError('جلسه پیدا نشد.', 404, 'INTERVIEW_NOT_FOUND');
  if (interview.status === 'cancelled') {
    throw new RoomError('این جلسه لغو شده است؛ برای اتاق زنده اول یک جلسهٔ تازه بگذارید.', 409, 'INTERVIEW_CANCELLED');
  }
  // One live link per call: asking again is how you find the link you already have.
  const existing = db.roomForInterview(orgId, interview.id);
  if (existing) return { room: viewOf(existing), reused: true as const };

  const now = new Date();
  const row: db.InterviewRoomRow = {
    id: db.uid('rom'),
    orgId,
    interviewId: interview.id,
    jobId: interview.jobId,
    resumeId: interview.resumeId || null,
    token: crypto.randomBytes(24).toString('base64url'),
    title: interview.title,
    candidateName: interview.candidateName,
    jobTitle: interview.jobTitle,
    hostName: interview.interviewerNames[0] || actor?.name || null,
    status: 'open',
    createdAtISO: now.toISOString(),
    createdAtJalali: stamp(now),
    closedAtISO: null,
    expiresAtISO: expiryFor(interview.startsAtISO).toISOString(),
    expiresAtJalali: stamp(expiryFor(interview.startsAtISO)),
    scheduledStartISO: interview.startsAtISO,
    scheduledStartJalali: interview.startsAtISO ? stamp(new Date(interview.startsAtISO)) : null,
  };
  db.saveRoom(row);
  db.logActivity(orgId, actor, 'room.opened', `اتاق ویدئویی «${interview.title}» با «${interview.candidateName}» باز شد`, {
    jobId: interview.jobId,
    resumeId: interview.resumeId,
  });
  return { room: viewOf(row), reused: false as const };
}

export function listRoomsFor(orgId: string, filter: { interviewId?: string; jobId?: string; resumeId?: string } = {}) {
  return db.listRooms(orgId, filter).map(viewOf);
}

export function closeRoom(orgId: string, id: string, actor: { id: string; name: string } | null) {
  const row = db.getRoom(orgId, id);
  if (!row) throw new RoomError('اتاق پیدا نشد.', 404, 'ROOM_NOT_FOUND');
  if (row.status === 'closed') {
    dropRoomMemory(row.id);
    return viewOf(row);
  }
  const next = db.saveRoom({ ...row, status: 'closed', closedAtISO: new Date().toISOString() });
  // A `bye` is queued so the other side's page closes on its own.
  try {
    appendSignal(row.id, 'host', 'bye', 'host-closed');
  } catch {
    // The room is closed either way.
  }
  db.logActivity(orgId, actor, 'room.closed', `اتاق ویدئویی «${row.title}» را بست`, { jobId: row.jobId, resumeId: row.resumeId });
  return viewOf(next);
}

/** The candidate's page: everything they may know, and nothing else. */
export function publicRoomOf(row: db.InterviewRoomRow): PublicRoom {
  const org = db.getOrg(row.orgId);
  return {
    orgName: org?.name || 'سازمان',
    title: row.title,
    jobTitle: row.jobTitle,
    candidateName: row.candidateName,
    hostName: row.hostName,
    status: row.status,
    scheduledStartJalali: row.scheduledStartJalali,
    expiresAtJalali: row.expiresAtJalali,
    // The candidate gets ephemeral credentials too; a relay never sees a
    // permanent secret in a page that a stranger opened.
    iceServers: iceServersFor(row.orgId, 'candidate'),
    relayConfigured: turnStatus(row.orgId).configured,
    relayNote: relayNote(org),
  };
}

/** A room can be found by token from the candidate side, with no session. */
export function roomByToken(token: string): db.InterviewRoomRow {
  const row = db.findRoomByToken(token);
  if (!row) throw new RoomError('این اتاق پیدا نشد؛ نشانی را کامل از پیام منابع انسانی باز کنید.', 404, 'ROOM_NOT_FOUND');
  return row;
}

export type RoomState = 'open' | 'closed' | 'expired';

export function stateOf(row: db.InterviewRoomRow): RoomState {
  if (new Date(row.expiresAtISO).getTime() < Date.now()) return 'expired';
  return row.status === 'closed' ? 'closed' : 'open';
}

/** Refuses new signals once the call is over, and says which one it was. */
export function assertLive(row: db.InterviewRoomRow) {
  const state = stateOf(row);
  if (state === 'expired') {
    throw new RoomError('اعتبار این اتاق تمام شده است؛ از منابع انسانی یک اتاق تازه بخواهید.', 410, 'ROOM_EXPIRED');
  }
  if (state === 'closed') {
    throw new RoomError('این اتاق بسته شده است.', 410, 'ROOM_CLOSED');
  }
}

export function pollFor(row: db.InterviewRoomRow, sinceRaw: unknown): RoomPoll {
  const since = Number(sinceRaw);
  const cursor = Number.isFinite(since) && since > 0 ? since : 0;
  const items = signalsFor(row.id).filter((s) => s.seq > cursor);
  const state = stateOf(row);
  return {
    seq: items.length ? items[items.length - 1].seq : cursor,
    items,
    presence: presenceOf(row.id),
    status: state === 'open' ? 'open' : 'closed',
    closedReason:
      state === 'expired'
        ? 'اعتبار این اتاق تمام شده است؛ از منابع انسانی یک اتاق تازه بخواهید.'
        : state === 'closed'
          ? 'این اتاق توسط منابع انسانی بسته شده است.'
          : null,
  };
}

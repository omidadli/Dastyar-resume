/**
 * «اتاق مصاحبهٔ زنده» — a peer-to-peer video room for one scheduled interview.
 *
 * The server never sees the picture or the voice: it only carries the few short
 * messages browsers need to find each other (SDP offer/answer, ICE candidates).
 * Those messages live in memory for the duration of the call and are never
 * written to disk, because a recording nobody asked for is a liability.
 */

/** Who is speaking. Decided by the server, never by the browser. */
export type RoomRole = 'host' | 'candidate';

/**
 * The only things a browser may send through the room:
 *   • `offer`/`answer`/`ice` — finding each other (and re-negotiating when a
 *     screen share starts or stops);
 *   • `chat` — a line of text typed during the call (never stored);
 *   • `screen` — «screen started» / «screen stopped», so the other side's label
 *     is honest;
 *   • `bye` — the call is over.
 */
export type SignalKind = 'offer' | 'answer' | 'ice' | 'chat' | 'screen' | 'bye';

/** A chat line as the page renders it. Ephemeral: it dies with the call. */
export interface RoomChatLine {
  seq: number;
  from: RoomRole;
  text: string;
  atISO: string;
}

/** The body of a `chat` signal. */
export interface RoomChatPayload {
  text: string;
}

export interface RoomSignal {
  seq: number;
  from: RoomRole;
  kind: SignalKind;
  /** SDP or a JSON ICE candidate — opaque to the server, capped in size. */
  payload: string;
  atISO: string;
}

export interface RoomPresence {
  hostLastSeenISO: string | null;
  candidateLastSeenISO: string | null;
  hostOnline: boolean;
  candidateOnline: boolean;
}

export interface InterviewRoom {
  id: string;
  interviewId: string | null;
  jobId: string;
  resumeId: string | null;
  title: string;
  candidateName: string;
  jobTitle: string;
  hostName: string | null;
  status: 'open' | 'closed';
  /** Absolute URL the candidate opens — the token is the whole key. */
  url: string;
  createdAtISO: string;
  createdAtJalali: string;
  closedAtISO: string | null;
  /** The link dies four hours after the call was meant to start. */
  expiresAtISO: string;
  expiresAtJalali: string;
  scheduledStartISO: string | null;
  scheduledStartJalali: string | null;
  presence: RoomPresence;
}

/** What the candidate's browser gets: no ids, no notes, no scores. */
export interface PublicRoom {
  orgName: string;
  title: string;
  jobTitle: string;
  candidateName: string;
  hostName: string | null;
  status: 'open' | 'closed';
  scheduledStartJalali: string | null;
  expiresAtJalali: string;
  /** STUN servers the browser may use; TURN relay is not provided. */
  iceServers: { urls: string | string[] }[];
  /** Said on screen, in Persian, so nobody has to guess. */
  relayNote: string;
}

export interface RoomPoll {
  seq: number;
  items: RoomSignal[];
  presence: RoomPresence;
  status: 'open' | 'closed';
  /** Why the room stopped accepting signals, when it did. */
  closedReason: string | null;
}

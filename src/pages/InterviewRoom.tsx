import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, MessageSquare, Mic, MicOff, MonitorUp, PhoneOff, Send, ShieldOff, Square, Users, Video, VideoOff, Wifi, WifiOff } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, IconButton, Spinner, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { toPersianDigits } from '../lib/format';
import { useTitle } from '../lib/useTitle';
import type { InterviewRoom as HostRoom, PublicRoom, RoomChatLine, RoomPoll, RoomSignal } from '../types/room';

type Phase = 'loading' | 'missing' | 'lobby' | 'connecting' | 'live' | 'ended';
type Role = 'host' | 'candidate';

/**
 * «اتاق مصاحبهٔ زنده» — the call itself.
 *
 * The server only carries a handful of short messages so the two browsers can
 * find each other; the video and the voice go straight from one browser to the
 * other and are never recorded, uploaded or stored. Everything visible here is
 * said plainly: who is on the other side, whether the network really connected,
 * and — when it cannot connect — that a direct connection is not always
 * possible and a phone call is the honest fallback.
 */
export default function InterviewRoom({ token }: { token: string }) {
  useTitle('اتاق مصاحبه');
  const [phase, setPhase] = useState<Phase>('loading');
  const [reason, setReason] = useState('');
  const [meta, setMeta] = useState<PublicRoom | null>(null);
  const [role, setRole] = useState<Role>('candidate');
  const [hostRoom, setHostRoom] = useState<HostRoom | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [netState, setNetState] = useState<'idle' | 'waiting' | 'connected' | 'failed'>('idle');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [peerName, setPeerName] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [chat, setChat] = useState<RoomChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [chatOpen, setChatOpen] = useState(true);
  const [screenOn, setScreenOn] = useState(false);
  const [peerScreen, setPeerScreen] = useState(false);

  const localRef = useRef<HTMLVideoElement | null>(null);
  const remoteRef = useRef<HTMLVideoElement | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const cursorRef = useRef(0);
  const roleRef = useRef<Role>('candidate');
  const activeRef = useRef(false);
  const peerSeenRef = useRef(false);
  /** «Perfect negotiation»: only one side may be mid-offer at a time. */
  const makingOfferRef = useRef(false);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const timerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  /** Who am I? A session in this workspace means host; otherwise the candidate. */
  useEffect(() => {
    let alive = true;
    api.rooms
      .publicRoom(token)
      .then((r) => {
        if (!alive) return;
        setMeta(r.room);
        setPhase(r.state === 'closed' ? 'ended' : 'lobby');
        if (r.state === 'closed') setReason('این اتاق بسته شده است.');
      })
      .catch((err: any) => {
        if (!alive) return;
        setReason(err?.message || 'این اتاق پیدا نشد.');
        setPhase('missing');
      });

    api.rooms
      .byToken(token)
      .then((r) => {
        if (!alive || !r.room) return;
        setHostRoom(r.room);
        setRole('host');
        roleRef.current = 'host';
        setPeerName(r.room.candidateName);
      })
      .catch(() => {
        // No session (or another workspace): this is the candidate side.
      });

    return () => {
      alive = false;
    };
  }, [token]);

  const send = useCallback(
    async (kind: RoomSignal['kind'], payload: string) => {
      try {
        if (roleRef.current === 'host') {
          if (hostRoom) await api.rooms.hostSignal(hostRoom.id, kind, payload);
        } else {
          await api.rooms.candidateSignal(token, kind, payload);
        }
      } catch {
        // A lost signal is normal on a flaky network; the next poll retries.
      }
    },
    [hostRoom, token]
  );

  const hangUp = useCallback(
    (announce: boolean) => {
      activeRef.current = false;
      makingOfferRef.current = false;
      screenTrackRef.current?.stop();
      screenTrackRef.current = null;
      setScreenOn(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      if (pollRef.current) window.clearTimeout(pollRef.current);
      pollRef.current = null;
      try {
        pcRef.current?.close();
      } catch {
        // Already closed.
      }
      pcRef.current = null;
      localStream.current?.getTracks().forEach((t) => t.stop());
      localStream.current = null;
      if (localRef.current) localRef.current.srcObject = null;
      if (remoteRef.current) remoteRef.current.srcObject = null;
      if (announce) void send('bye', `${roleRef.current}-left`);
      setNetState('idle');
      setPhase((p) => (p === 'missing' ? p : 'ended'));
    },
    [send]
  );

  useEffect(() => {
    return () => {
      // Leaving the page is leaving the call: nothing keeps running in the dark.
      if (activeRef.current) hangUp(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = useCallback(
    async (pc: RTCPeerConnection, signal: RoomSignal) => {
      if (signal.from === roleRef.current) return;
      if (signal.kind === 'bye') {
        toast('طرف مقابل تماس را پایان داد.', 'info');
        hangUp(false);
        return;
      }
      if (signal.kind === 'chat') {
        // A line of text, carried as a signal: it lives and dies with the call.
        const text = (() => {
          try {
            return String(JSON.parse(signal.payload)?.text || '').slice(0, 2000);
          } catch {
            return '';
          }
        })();
        if (text) setChat((prev) => [...prev, { seq: signal.seq, from: signal.from, text, atISO: signal.atISO }]);
        return;
      }
      if (signal.kind === 'screen') {
        setPeerScreen(signal.payload === 'started');
        return;
      }
      if (signal.kind === 'offer') {
        // Glare: the candidate is the polite side and accepts the host's offer;
        // the host ignores an offer while its own is in flight (it will retry).
        const polite = roleRef.current === 'candidate';
        const collision = makingOfferRef.current || pc.signalingState === 'have-local-offer';
        if (collision && !polite) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: signal.payload });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await send('answer', answer.sdp || '');
        return;
      }
      if (signal.kind === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: signal.payload });
        }
        return;
      }
      if (signal.kind === 'ice') {
        try {
          await pc.addIceCandidate(JSON.parse(signal.payload));
        } catch {
          // Candidates arriving before the description are simply dropped.
        }
      }
    },
    [hangUp, send]
  );

  const startLoop = useCallback(
    (pc: RTCPeerConnection) => {
      const tick = async () => {
        if (!activeRef.current) return;
        let poll: RoomPoll | null = null;
        try {
          poll =
            roleRef.current === 'host' && hostRoom
              ? await api.rooms.hostSignals(hostRoom.id, cursorRef.current)
              : await api.rooms.candidateSignals(token, cursorRef.current);
        } catch {
          poll = null;
        }
        if (!activeRef.current) return;
        if (poll) {
          for (const s of poll.items) {
            cursorRef.current = Math.max(cursorRef.current, s.seq);
            try {
              await apply(pc, s);
            } catch {
              // A malformed SDP from a flaky peer must not kill the page.
            }
          }
          const other = roleRef.current === 'host' ? poll.presence.candidateOnline : poll.presence.hostOnline;
          if (poll.status === 'closed') {
            setReason(poll.closedReason || 'این اتاق بسته شده است.');
            hangUp(false);
            return;
          }
          if (other) {
            peerSeenRef.current = true;
            setNetState((n) => (n === 'connected' ? n : 'waiting'));
          } else if (peerSeenRef.current) {
            setNetState('waiting');
          }
        }
        if (activeRef.current) pollRef.current = window.setTimeout(() => void tick(), 1100);
      };
      void tick();
    },
    [apply, hangUp, hostRoom, send, token]
  );

  const join = async () => {
    setMediaError(null);
    setPhase('connecting');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err: any) {
      setPhase('lobby');
      setMediaError(
        err?.name === 'NotAllowedError'
          ? 'مرورگر اجازهٔ دوربین و میکروفون نداد. از آیکن قفل کنار نشانی، دسترسی را روشن کنید و دوباره بزنید.'
          : 'دوربین یا میکروفون پیدا نشد. اگر دستگاه وصل نیست، می‌توانید فقط صدا داشته باشید یا از تماس تلفنی استفاده کنید.'
      );
      return;
    }
    localStream.current = stream;
    if (localRef.current) localRef.current.srcObject = stream;
    setMicOn(stream.getAudioTracks().length > 0);
    setCamOn(stream.getVideoTracks().length > 0);

    const pc = new RTCPeerConnection({ iceServers: meta?.iceServers || [] });
    pcRef.current = pc;
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));
    pc.ontrack = (ev) => {
      if (remoteRef.current) remoteRef.current.srcObject = ev.streams[0] || null;
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) void send('ice', JSON.stringify(ev.candidate));
    };
    // The browser tells us when the call needs (re)negotiating — the first
    // connect, and again if a screen share adds a track. One code path.
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true;
        await pc.setLocalDescription();
        await send('offer', pc.localDescription?.sdp || '');
      } catch {
        // A failed negotiation is retried by the browser on the next change.
      } finally {
        makingOfferRef.current = false;
      }
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        setNetState('connected');
        setPhase('live');
        if (!timerRef.current) timerRef.current = window.setInterval(() => setElapsed((v) => v + 1), 1000);
      } else if (s === 'failed') {
        setNetState('failed');
        setPhase('live');
      } else if (s === 'disconnected') {
        setNetState('waiting');
      }
    };

    activeRef.current = true;
    setPhase('live');
    startLoop(pc);
  };

  const toggleMic = () => {
    const tracks = localStream.current?.getAudioTracks() || [];
    const next = !micOn;
    tracks.forEach((t) => (t.enabled = next));
    setMicOn(next);
  };

  const toggleCam = () => {
    const tracks = localStream.current?.getVideoTracks() || [];
    const next = !camOn;
    tracks.forEach((t) => (t.enabled = next));
    setCamOn(next);
  };

  /**
   * «اشتراک صفحه» — the same video sender swaps its track, so no renegotiation
   * is needed when a camera already exists; if there is no video at all, the
   * browser's `negotiationneeded` handles it. The other side is told, so its
   * label stops lying.
   */
  const shareScreen = async () => {
    if (!pcRef.current) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = display.getVideoTracks()[0];
      if (!track) return;
      screenTrackRef.current = track;
      const sender = pcRef.current.getSenders().find((x) => x.track?.kind === 'video');
      if (sender) {
        await sender.replaceTrack(track);
      } else {
        pcRef.current.addTrack(track, display);
      }
      track.onended = () => {
        void stopScreen();
      };
      setScreenOn(true);
      await send('screen', 'started');
    } catch (err: any) {
      toast(
        err?.name === 'NotAllowedError' ? 'اشتراک صفحه لغو شد.' : 'اشتراک صفحه ممکن نشد؛ مرورگر اجازه نداد.',
        'error'
      );
    }
  };

  const stopScreen = async () => {
    const track = screenTrackRef.current;
    screenTrackRef.current = null;
    track?.stop();
    const cam = localStream.current?.getVideoTracks()[0] || null;
    const sender = pcRef.current?.getSenders().find((x) => x.track?.kind === 'video' || x.track === null);
    try {
      if (cam && sender) await sender.replaceTrack(cam);
      else if (sender && !cam) await sender.replaceTrack(null);
    } catch {
      // Losing the swap is cosmetic: the call itself stays up.
    }
    setScreenOn(false);
    await send('screen', 'stopped');
  };

  const sendChat = async () => {
    const text = draft.trim().slice(0, 2000);
    if (!text) return;
    setDraft('');
    // Shown at once from the local side; the server order is what the other
    // side sees, so the two lists can differ by a second, never by content.
    setChat((prev) => [...prev, { seq: -Date.now(), from: roleRef.current, text, atISO: new Date().toISOString() }]);
    await send('chat', JSON.stringify({ text }));
  };

  const end = async () => {
    hangUp(true);
    if (roleRef.current === 'host' && hostRoom) {
      try {
        await api.rooms.close(hostRoom.id);
      } catch {
        // Closing from the browser is a convenience; HR can always close it later.
      }
    } else {
      try {
        await api.rooms.leave(token);
      } catch {
        // Same.
      }
    }
  };

  const clock = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">اتاق مصاحبهٔ زنده</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-6 sm:py-8">
        <div className="max-w-[960px] mx-auto flex flex-col gap-4">
          {phase === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {phase === 'missing' && (
            <Callout tone="warning" icon={ShieldOff} title="این اتاق باز نمی‌شود">
              {reason || 'نشانی را کامل از پیام منابع انسانی باز کنید.'}
            </Callout>
          )}

          {meta && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone="outline">{meta.orgName}</Chip>
                <span className="text-[13px] font-bold text-ink">{meta.title}</span>
                <span className="text-[12.5px] text-ink-3">{meta.jobTitle}</span>
                {role === 'host' ? (
                  <Chip tone="brand">مصاحبه‌گر — {meta.candidateName}</Chip>
                ) : (
                  <Chip tone="neutral">کارجو — {meta.candidateName}</Chip>
                )}
                {meta.scheduledStartJalali && (
                  <span className="text-[12px] text-ink-3 inline-flex items-center gap-1">
                    <CalendarClock className="w-3.5 h-3.5" />
                    {meta.scheduledStartJalali}
                  </span>
                )}
              </div>

              {phase === 'ended' && (
                <Callout tone="warning" icon={PhoneOff} title="تماس پایان یافت">
                  {reason || 'این اتاق بسته شده است. اگر هنوز کار دارید، از منابع انسانی بخواهید اتاق تازه بسازد.'}
                </Callout>
              )}

              {phase === 'lobby' && (
                <div className="hv-card p-5 flex flex-col gap-3">
                  <p className="text-[13px] text-ink-2 leading-relaxed">
                    {role === 'host'
                      ? 'شما به‌عنوان مصاحبه‌گر وارد می‌شوید. لینک همین صفحه را برای کارجو بفرستید؛ وقتی هر دو طرف اینجا باشید، تماس خودش وصل می‌شود.'
                      : 'هر وقت آماده بودید دوربین را روشن کنید. این صفحه فقط وقتی کار می‌کند که هر دو طرف باز باشند.'}
                  </p>
                  {mediaError && <Callout tone="warning" icon={ShieldOff}>{mediaError}</Callout>}
                  <div>
                    <Button icon={Video} onClick={() => void join()}>
                      روشن‌کردن دوربین و پیوستن
                    </Button>
                  </div>
                </div>
              )}

              {phase !== 'missing' && (
                <div className={`relative rounded-[16px] overflow-hidden bg-[#101418] border border-line ${phase === 'lobby' ? 'hidden' : ''}`}>
                  <video ref={remoteRef} autoPlay playsInline className="w-full aspect-video bg-[#101418]" />
                  {netState !== 'connected' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/80 text-[13px]">
                      {netState === 'failed' ? (
                        <>
                          <WifiOff className="w-6 h-6" />
                          <span>اتصال مستقیم برقرار نشد — شبکه اجازه نداد.</span>
                          <span className="text-white/50 text-[11.5px]">برای این حالت به سرور میانی (TURN) نیاز است که در دسترس نیست؛ تماس تلفنی مطمئن‌تر است.</span>
                        </>
                      ) : (
                        <>
                          {peerName && <span className="text-white/90">{peerName}</span>}
                          <span className="inline-flex items-center gap-2">
                            <Spinner className="w-4 h-4" /> منتظر طرف مقابل…
                          </span>
                        </>
                      )}
                    </div>
                  )}
                  <div className="absolute bottom-3 left-3 w-[26%] max-w-[220px] rounded-[10px] overflow-hidden border border-white/20 bg-black/40">
                    <video ref={localRef} autoPlay muted playsInline className="w-full aspect-video object-cover scale-x-[-1]" />
                  </div>
                  <div className="absolute top-3 right-3 flex items-center gap-2">
                    {netState === 'connected' ? (
                      <Chip tone="brand">
                        <span className="inline-flex items-center gap-1">
                          <Wifi className="w-3 h-3" /> وصل — {clock}
                        </span>
                      </Chip>
                    ) : (
                      <Chip tone="neutral">
                        <span className="inline-flex items-center gap-1">
                          <Users className="w-3 h-3" /> در انتظار
                        </span>
                      </Chip>
                    )}
                  </div>
                </div>
              )}

              {(phase === 'live' || phase === 'connecting') && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" icon={micOn ? Mic : MicOff} onClick={toggleMic}>
                    {micOn ? 'قطع میکروفون' : 'روشن‌کردن میکروفون'}
                  </Button>
                  <Button variant="secondary" icon={camOn ? Video : VideoOff} onClick={toggleCam}>
                    {camOn ? 'قطع دوربین' : 'روشن‌کردن دوربین'}
                  </Button>
                  <Button
                    variant={screenOn ? 'primary' : 'secondary'}
                    icon={screenOn ? Square : MonitorUp}
                    onClick={() => void (screenOn ? stopScreen() : shareScreen())}
                  >
                    {screenOn ? 'پایان اشتراک صفحه' : 'اشتراک صفحه'}
                  </Button>
                  <Button
                    variant="secondary"
                    icon={MessageSquare}
                    onClick={() => setChatOpen((v) => !v)}
                    aria-pressed={chatOpen}
                  >
                    پیام‌ها{chat.length ? ` (${toPersianDigits(chat.length)})` : ''}
                  </Button>
                  <Button variant="ghost" icon={PhoneOff} onClick={() => void end()}>
                    {role === 'host' ? 'پایان و بستن اتاق' : 'خروج از تماس'}
                  </Button>
                </div>
              )}

              {phase === 'live' && (peerScreen || screenOn) && (
                <Chip tone="outline">
                  {screenOn ? 'شما در حال اشتراک صفحه‌اید' : ''}
                  {screenOn && peerScreen ? ' — ' : ''}
                  {peerScreen ? 'طرف مقابل صفحهٔ خود را نشان می‌دهد' : ''}
                </Chip>
              )}

              {phase === 'live' && chatOpen && (
                <div className="hv-card p-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[12.5px] font-bold text-ink">پیام‌های کنار تماس</p>
                    <span className="text-[11px] text-ink-4">ذخیره نمی‌شود؛ با پایان تماس پاک می‌شود</span>
                  </div>
                  <div className="max-h-[220px] overflow-y-auto flex flex-col gap-1.5" aria-live="polite">
                    {chat.length === 0 && (
                      <p className="text-[12px] text-ink-4">هنوز پیامی رد و بدل نشده است.</p>
                    )}
                    {chat.map((line) => {
                      const mine = line.from === roleRef.current;
                      return (
                        <div key={line.seq} className={`flex ${mine ? 'justify-start' : 'justify-end'}`}>
                          <div
                            className={`max-w-[80%] rounded-[12px] px-3 py-1.5 text-[12.5px] leading-relaxed ${
                              mine ? 'bg-brand-tint text-ink' : 'bg-canvas-2 text-ink-2'
                            }`}
                          >
                            <span className="block text-[10.5px] text-ink-4 mb-0.5">
                              {mine ? 'شما' : line.from === 'host' ? 'مصاحبه‌گر' : 'کارجو'}
                            </span>
                            {line.text}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <form
                    className="flex items-end gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void sendChat();
                    }}
                  >
                    <div className="flex-1">
                      <TextInput
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder="یک جمله بنویسید و Enter بزنید"
                        maxLength={2000}
                        aria-label="متن پیام"
                      />
                    </div>
                    <IconButton icon={Send} label="فرستادن پیام" type="submit" disabled={!draft.trim()} />
                  </form>
                </div>
              )}

              {meta.relayNote && (
                <p className="text-[11.5px] text-ink-4 leading-relaxed">
                  {meta.relayNote} اعتبار این اتاق تا {meta.expiresAtJalali} است.
                </p>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CameraOff,
  CheckCircle2,
  Circle,
  Clock3,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  Square,
  Video as VideoIcon,
} from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Spinner, toast } from '../components/ui';
import { api } from '../lib/api';
import { useTitle } from '../lib/useTitle';
import { toPersianDigits } from '../lib/format';
import type { PublicVideoInvite } from '../types/video';

/**
 * The candidate's recording page — no account, one link, a phone is enough.
 *
 * What it refuses to do: start the camera on its own, hide the time limit, or
 * pretend a failed upload worked. The questions, the seconds and the number of
 * takes are all shown *before* the first click, and every answer is uploaded
 * the moment it is recorded, so closing the tab does not lose the earlier ones.
 */

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${toPersianDigits(m)}:${toPersianDigits(String(s).padStart(2, '0'))}`;
}

function pickMime(): string {
  const options = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
  for (const type of options) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export default function VideoRecord({ token }: { token: string }) {
  useTitle('مصاحبهٔ ویدئویی');
  const [invite, setInvite] = useState<PublicVideoInvite | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Camera
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const [camera, setCamera] = useState<'off' | 'starting' | 'live' | 'denied'>('off');
  const [facing, setFacing] = useState<'user' | 'environment'>('user');
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api.video.public
      .get(token)
      .then((r) => {
        setInvite(r.invite);
        setState('ready');
      })
      .catch(() => setState('missing'));
  }, [token]);

  const questions = invite?.questions || [];
  const question = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const recordedMap = useMemo(() => {
    const map = new Map<string, { durationMs: number; takesLeft: number }>();
    (invite?.recorded || []).forEach((r) => map.set(r.questionId, { durationMs: r.durationMs, takesLeft: r.takesLeft }));
    return map;
  }, [invite]);
  const recordedCount = recordedMap.size;
  const takesLeft = question ? recordedMap.get(question.id)?.takesLeft ?? 99 : 0;

  const stopTracks = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera('off');
  }, []);

  useEffect(() => stopTracks, [stopTracks]);

  const startCamera = async (mode: 'user' | 'environment' = facing) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast('این مرورگر ضبط ویدئو را پشتیبانی نمی‌کند؛ از Chrome/Firefox نسخهٔ تازه یا گوشی استفاده کنید.', 'error', undefined, 9000);
      return;
    }
    setCamera('starting');
    try {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setFacing(mode);
      setCamera('live');
      // The first open flips «دعوت‌شده» → «در حال ضبط» so HR sees progress.
      if (invite?.status === 'invited') api.video.public.open(token).then((r) => setInvite(r.invite)).catch(() => undefined);
    } catch {
      setCamera('denied');
    }
  };

  const startRecording = () => {
    const stream = streamRef.current;
    if (!stream || !question) return;
    const mimeType = pickMime();
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 1_200_000 } : undefined);
    } catch {
      toast('ضبط در این مرورگر ممکن نشد؛ مرورگر دیگری را امتحان کنید.', 'error');
      return;
    }
    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'video/webm' });
      setRecording(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
      timerRef.current = null;
      void uploadTake(blob, Date.now() - startedAtRef.current);
    };
    recorderRef.current = rec;
    startedAtRef.current = Date.now();
    setElapsed(0);
    rec.start(1000);
    setRecording(true);
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsed(ms);
      if (question && ms >= question.seconds * 1000) stopRecording();
    }, 200);
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    else setRecording(false);
  };

  const uploadTake = async (blob: Blob, durationMs: number) => {
    if (!question) return;
    if (blob.size < 2000) {
      toast('ضبط خیلی کوتاه بود؛ دوباره تلاش کنید.', 'error');
      return;
    }
    setUploading(true);
    try {
      const dataBase64 = await blobToBase64(blob);
      const r = await api.video.public.answer(token, {
        questionId: question.id,
        dataBase64,
        mimeType: blob.type || 'video/webm',
        durationMs,
      });
      setInvite(r.invite);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
      toast('این پاسخ ذخیره شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ارسال ویدئو ممکن نشد؛ اتصال را بررسی کنید و دوباره ضبط کنید.', 'error', undefined, 9000);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await api.video.public.submit(token);
      setInvite(r.invite);
      stopTracks();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      toast(err?.message || 'ثبت نهایی ممکن نشد.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const done = invite?.status === 'submitted' || invite?.status === 'reviewed';
  const closed = invite?.status === 'expired' || invite?.status === 'cancelled';
  const allRecorded = recordedCount === questions.length && questions.length > 0;
  const already = question ? recordedMap.get(question.id) : undefined;

  return (
    <div className="min-h-screen bg-canvas flex flex-col" dir="rtl">
      <header className="h-16 flex items-center px-5 sm:px-10 border-b border-line-2 bg-surface">
        <HovidaLogo />
        <span className="text-[12px] text-ink-3 mr-auto">مصاحبهٔ ویدئویی</span>
      </header>

      <main className="flex-1 px-4 sm:px-6 py-8 sm:py-12">
        <div className="max-w-[760px] mx-auto">
          {state === 'loading' && (
            <div className="py-24 flex justify-center">
              <Spinner />
            </div>
          )}

          {state === 'missing' && (
            <Callout tone="warning" title="این لینک معتبر نیست">
              ممکن است نشانی ناقص کپی شده باشد. اگر لینک را از منابع انسانی گرفته‌اید، از آن‌ها بخواهید دوباره بفرستند.
            </Callout>
          )}

          {state === 'ready' && invite && (
            <div className="bg-surface border border-line-2 rounded-[16px] p-5 sm:p-8">
              <div className="flex items-start gap-3 mb-5">
                <span className="w-11 h-11 rounded-[12px] bg-brand-soft flex items-center justify-center shrink-0">
                  <VideoIcon className="w-5 h-5 text-brand-ink" strokeWidth={1.9} />
                </span>
                <div className="min-w-0">
                  <h1 className="text-[17px] font-extrabold text-ink leading-snug">
                    {invite.candidateName ? `${invite.candidateName} عزیز، ` : ''}
                    یک مصاحبهٔ ویدئویی کوتاه
                  </h1>
                  <p className="mt-1 text-[12.5px] text-ink-3 leading-relaxed">
                    {invite.orgName}
                    {invite.jobTitle ? ` — نقش «${invite.jobTitle}»` : ''}
                  </p>
                </div>
              </div>

              {done && (
                <Callout tone="brand" icon={CheckCircle2} title="پاسخ‌های شما ثبت شد">
                  از وقتی که گذاشتید سپاسگزاریم. ویدئوها در کنار رزومهٔ شما خوانده می‌شوند و جای گفت‌وگوی حضوری را نمی‌گیرند؛ اگر مرحلهٔ بعد باشد، با شما تماس می‌گیریم.
                </Callout>
              )}

              {closed && !done && (
                <Callout tone="warning" title={invite.status === 'cancelled' ? 'این درخواست لغو شده است' : 'مهلت این لینک گذشته است'}>
                  {invite.status === 'cancelled'
                    ? 'اگر فکر می‌کنید اشتباهی رخ داده، با منابع انسانی تماس بگیرید.'
                    : `مهلت این لینک تا ${invite.expiresAtJalali} بود. اگر هنوز به این نقش علاقه دارید، با منابع انسانی تماس بگیرید تا لینک تازه بگیرید.`}
                </Callout>
              )}

              {!done && !closed && (
                <>
                  {invite.intro && <p className="text-[13px] text-ink-2 leading-relaxed mb-4">{invite.intro}</p>}

                  <div className="rounded-[12px] border border-line-2 bg-canvas px-4 py-3 mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink-2">
                    <span className="inline-flex items-center gap-1.5">
                      <Circle className="w-2 h-2 fill-current" /> {toPersianDigits(questions.length)} پرسش
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Clock3 className="w-4 h-4 text-ink-3" /> برای هر پرسش{' '}
                      {toPersianDigits(question?.seconds || 0)} ثانیه
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <RefreshCw className="w-4 h-4 text-ink-3" />
                      {invite.retakes > 0
                        ? `تا ${toPersianDigits(invite.retakes + 1)} بار ضبط برای هر پرسش`
                        : 'یک بار ضبط برای هر پرسش'}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-ink-3">
                      <ShieldCheck className="w-4 h-4" /> ویدئو فقط برای تیم جذب
                    </span>
                  </div>

                  {/* question header */}
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-[12px] text-ink-3">
                      پرسش {toPersianDigits(index + 1)} از {toPersianDigits(questions.length)}
                    </p>
                    {already && (
                      <span className="text-[11.5px] text-brand-strong inline-flex items-center gap-1">
                        <CheckCircle2 className="w-3.5 h-3.5" /> پاسخ ثبت شده
                      </span>
                    )}
                  </div>
                  <p className="text-[14.5px] font-semibold text-ink leading-relaxed mb-4">{question?.text}</p>

                  <div className="relative rounded-[14px] overflow-hidden bg-[#111] aspect-video mb-3">
                    <video ref={videoRef} playsInline muted className={`w-full h-full object-cover ${camera === 'live' ? '' : 'hidden'}`} />

                    {camera !== 'live' && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
                        {camera === 'denied' ? (
                          <>
                            <CameraOff className="w-8 h-8 text-white/70" />
                            <p className="text-[12.5px] text-white/80 leading-relaxed max-w-[360px]">
                              دسترسی به دوربین و میکروفن داده نشد. در تنظیمات مرورگر اجازه بدهید و دوباره تلاش کنید — بدون دوربین ضبط ممکن نیست.
                            </p>
                          </>
                        ) : (
                          <>
                            <Camera className="w-8 h-8 text-white/70" />
                            <p className="text-[12.5px] text-white/80 leading-relaxed max-w-[360px]">
                              وقتی آماده بودید «روشن‌کردن دوربین» را بزنید. تا آن لحظه هیچ تصویری گرفته نمی‌شود.
                            </p>
                          </>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void startCamera(facing)}
                          loading={camera === 'starting'}
                          icon={Camera}
                        >
                          {camera === 'denied' ? 'تلاش دوباره' : 'روشن‌کردن دوربین'}
                        </Button>
                      </div>
                    )}

                    {recording && (
                      <div className="absolute top-3 right-3 inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-[12px] text-white">
                        <span className="w-2 h-2 rounded-full bg-[#ef4444] animate-pulse" />
                        {clock(elapsed)} / {clock((question?.seconds || 0) * 1000)}
                      </div>
                    )}
                    {uploading && (
                      <div className="absolute inset-0 bg-black/50 flex items-center justify-center gap-2 text-white text-[13px]">
                        <Loader2 className="w-5 h-5 animate-spin" /> در حال ارسال ویدئو…
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 mb-4">
                    {camera === 'live' && !recording && (
                      <Button onClick={startRecording} disabled={uploading || takesLeft <= 0} icon={Circle}>
                        {already ? 'ضبط دوباره' : 'شروع ضبط'}
                      </Button>
                    )}
                    {recording && (
                      <Button onClick={stopRecording} variant="secondary" icon={Square}>
                        پایان ضبط
                      </Button>
                    )}
                    {camera === 'live' && !recording && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={RefreshCw}
                          onClick={() => void startCamera(facing === 'user' ? 'environment' : 'user')}
                        >
                          دوربین دیگر
                        </Button>
                        <button type="button" onClick={stopTracks} className="text-[12px] text-ink-3 hover:text-ink underline">
                          خاموش‌کردن دوربین
                        </button>
                      </>
                    )}
                    {takesLeft <= 0 && (
                      <span className="text-[12px] text-ink-3">برای این پرسش دیگر امکان ضبط دوباره نیست.</span>
                    )}
                  </div>

                  {previewUrl && already && !recording && (
                    <div className="mb-4">
                      <p className="text-[12px] text-ink-3 mb-1.5">ضبط خودتان را ببینید:</p>
                      <video src={previewUrl} controls className="w-full max-h-[220px] rounded-[12px] bg-black" />
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 border-t border-line-2 pt-4">
                    <Button
                      variant="ghost"
                      icon={ArrowRight}
                      disabled={index === 0}
                      onClick={() => {
                        stopTracks();
                        setPreviewUrl(null);
                        setIndex((i) => Math.max(0, i - 1));
                      }}
                    >
                      پرسش قبلی
                    </Button>
                    <span className="text-[12px] text-ink-3">
                      {toPersianDigits(recordedCount)} از {toPersianDigits(questions.length)} پاسخ داده شده
                    </span>
                    {index < questions.length - 1 ? (
                      <Button
                        variant="secondary"
                        icon={ArrowLeft}
                        onClick={() => {
                          stopTracks();
                          setPreviewUrl(null);
                          setIndex((i) => Math.min(questions.length - 1, i + 1));
                        }}
                      >
                        پرسش بعدی
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void submit()}
                        loading={submitting}
                        disabled={!allRecorded || uploading || recording}
                        icon={Send}
                      >
                        ارسال نهایی
                      </Button>
                    )}
                  </div>

                  {!allRecorded && index === questions.length - 1 && (
                    <p className="mt-3 text-[12px] text-ink-3 leading-relaxed">
                      تا همهٔ پرسش‌ها ضبط نشوند، ارسال نهایی فعال نمی‌شود. می‌توانید لینک را ببندید و بعداً با همین لینک برگردید؛ پاسخ‌های ثبت‌شده می‌مانند.
                    </p>
                  )}

                  {allRecorded && index !== questions.length - 1 && (
                    <Callout tone="brand" icon={CheckCircle2} className="mt-4">
                      همهٔ پرسش‌ها پاسخ دارند. برای ثبت نهایی به آخرین پرسش بروید و «ارسال نهایی» را بزنید.
                    </Callout>
                  )}
                </>
              )}
            </div>
          )}

          <p className="mt-5 text-[11.5px] text-ink-4 text-center leading-relaxed">
            این صفحه بخشی از سامانهٔ استخدام هویدا است. ویدئوها فقط برای تیم جذب همین سازمان قابل مشاهده‌اند و بدون اجازهٔ شما جایی منتشر نمی‌شوند.
          </p>
        </div>
      </main>
    </div>
  );
}

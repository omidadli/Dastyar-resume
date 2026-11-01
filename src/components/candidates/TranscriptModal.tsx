import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, FileAudio, FileText, Info, Sparkles, Trash2, Upload } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import { TRANSCRIPT_SOURCE_LABEL, type Transcript, type TranscriptStatusPayload } from '../../types/transcript';
import { api } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { emitChange } from '../../lib/events';
import { faDate } from '../../lib/format';
import { Button, Callout, Chip, ConfirmDialog, Modal, Segmented, Spinner, TextArea, TextInput, toast } from '../ui';
import { MeetingSummaryCard } from './MeetingSummaryCard';
import type { MeetingSummary } from '../../types/summary';

type Mode = 'text' | 'audio' | 'subtitle';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * «رونویسی گفتار» — three honest doors, in the order the page shows them:
 * paste the text (always works), send a subtitle file (parsed here, timings
 * kept), or send the recording (auto only when a provider that can read audio
 * is configured — and the page says so before you upload 30 MB).
 */
export function TranscriptModal({
  record,
  onClose,
}: {
  record: ResumeListItem | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<TranscriptStatusPayload | null>(null);
  const [items, setItems] = useState<Transcript[] | null>(null);
  const [mode, setMode] = useState<Mode>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Transcript | null>(null);
  // One latest summary per transcript, keyed by transcript id.
  const [summaries, setSummaries] = useState<Record<string, MeetingSummary>>({});
  const [busySummary, setBusySummary] = useState<string | null>(null);
  const audioRef = useRef<HTMLInputElement | null>(null);
  const subtitleRef = useRef<HTMLInputElement | null>(null);

  const load = () => {
    if (!record) return;
    api.transcripts
      .list({ resumeId: record.id })
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
    api.summaries
      .list({ resumeId: record.id })
      .then((r) => {
        const latest: Record<string, MeetingSummary> = {};
        for (const s of r.items) if (!latest[s.transcriptId]) latest[s.transcriptId] = s;
        setSummaries(latest);
      })
      .catch(() => setSummaries({}));
  };

  const makeSummary = async (t: Transcript) => {
    setBusySummary(t.id);
    try {
      const r = await api.summaries.create(t.id);
      setSummaries((prev) => ({ ...prev, [t.id]: r.summary }));
      if (r.note) toast(r.note, r.fellBack ? 'info' : 'success', undefined, 8000);
      else toast('خلاصه ساخته شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ساختن خلاصه ممکن نشد.', 'error');
    } finally {
      setBusySummary(null);
    }
  };

  const dropSummary = async (t: Transcript) => {
    const s = summaries[t.id];
    if (!s) return;
    try {
      await api.summaries.remove(s.id);
      setSummaries((prev) => {
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      toast('خلاصه پاک شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک‌کردن ممکن نشد.', 'error');
    }
  };

  useEffect(() => {
    if (!record) return;
    setItems(null);
    setText('');
    setTitle('');
    setMode('text');
    api.transcripts.status().then(setStatus).catch(() => setStatus(null));
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.id]);

  const saveText = async () => {
    if (!record) return;
    if (text.trim().length < 10) {
      toast('متن خیلی کوتاه است؛ دست‌کم چند جمله بنویسید.', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api.transcripts.text({ resumeId: record.id, text, title: title.trim() || undefined });
      setItems((prev) => [r.transcript, ...(prev || [])]);
      setText('');
      setTitle('');
      toast('متن ثبت شد.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'ثبت متن ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const uploadAudio = async (file: File) => {
    if (!record) return;
    if (file.size > 40 * 1024 * 1024) {
      toast('حجم فایل بیش از ۴۰ مگابایت است.', 'error');
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await readAsBase64(file);
      const r = await api.transcripts.audio({
        resumeId: record.id,
        fileName: file.name,
        mimeType: file.type || 'audio/mpeg',
        dataBase64,
      });
      setItems((prev) => [r.transcript, ...(prev || [])]);
      if (r.note) toast(r.note, 'info', undefined, 12_000);
      else toast('رونویسی آماده شد.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'ارسال فایل ممکن نشد.', 'error');
    } finally {
      setBusy(false);
      if (audioRef.current) audioRef.current.value = '';
    }
  };

  const uploadSubtitle = async (file: File) => {
    if (!record) return;
    setBusy(true);
    try {
      const content = await readAsText(file);
      const r = await api.transcripts.subtitle({ resumeId: record.id, content, fileName: file.name });
      setItems((prev) => [r.transcript, ...(prev || [])]);
      toast('زیرنویس خوانده شد.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'خواندن فایل ممکن نشد.', 'error');
    } finally {
      setBusy(false);
      if (subtitleRef.current) subtitleRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.transcripts.remove(removing.id);
      setItems((prev) => (prev || []).filter((t) => t.id !== removing.id));
      toast('رونویسی پاک شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'پاک‌کردن ممکن نشد.', 'error');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Modal
      open={Boolean(record)}
      onClose={onClose}
      icon={<FileText className="w-5 h-5 text-brand-strong" />}
      title="رونویسی گفتار"
      description={record ? `گفت‌وگوها و یادداشت‌های صوتی «${record.candidateName || 'کارجو'}»` : undefined}
      size="lg"
    >
      {record && (
        <div className="flex flex-col gap-4">
          {status && (
            <Callout
              tone={status.canTranscribe ? 'brand' : 'info'}
              icon={status.canTranscribe ? Sparkles : Info}
              title={status.canTranscribe ? 'رونویسی خودکار فعال است' : 'رونویسی خودکار تنظیم نشده است'}
            >
              {status.canTranscribe
                ? 'فایل صوتی یا ویدئویی را بفرستید؛ متن آماده می‌شود. بارگذاری فایل زیرنویس و چسباندن متن هم همیشه کار می‌کند.'
                : status.aiReason ||
                  'برای متن، یکی از دو راه همیشه باز است: چسباندن متن یا فرستادن فایل زیرنویس. فایل صوتی هم ذخیره می‌شود تا بعداً رونویسی شود.'}
            </Callout>
          )}

          <Segmented<Mode>
            value={mode}
            onChange={setMode}
            items={[
              { id: 'text', label: 'چسباندن متن' },
              { id: 'subtitle', label: 'فایل زیرنویس' },
              { id: 'audio', label: 'فایل صوتی/تصویری' },
            ]}
          />

          {mode === 'text' && (
            <div className="flex flex-col gap-3">
              <TextInput label="عنوان (اختیاری)" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="مثلاً تماس اولیه ۱۲ آبان" />
              <TextArea
                label="متن گفت‌وگو"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="هرچه در تماس گفته شد… می‌توانید با «گوینده ۱:» و «گوینده ۲:» جدا کنید."
              />
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11.5px] text-ink-3">این متن به پروندهٔ کارجو می‌چسبد و در فعالیت‌های تیم ثبت می‌شود.</p>
                <Button onClick={saveText} loading={busy} icon={CheckCircle2}>
                  ثبت متن
                </Button>
              </div>
            </div>
          )}

          {mode === 'subtitle' && (
            <div className="rounded-[12px] border border-line-2 bg-canvas p-4">
              <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
                فایل <b>.srt</b>، <b>.vtt</b> یا <b>.txt</b> را بفرستید. زمان‌ها روی همین سرور خوانده می‌شوند — بدون کلید و بدون
                سرویس بیرونی — و کنار هر جمله می‌مانند.
              </p>
              <input
                ref={subtitleRef}
                type="file"
                accept=".srt,.vtt,.txt,text/plain"
                className="block w-full text-[12.5px]"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadSubtitle(f);
                }}
              />
              {busy && (
                <p className="mt-3 text-[12px] text-ink-3 inline-flex items-center gap-2">
                  <Spinner className="w-4 h-4" /> در حال خواندن…
                </p>
              )}
            </div>
          )}

          {mode === 'audio' && (
            <div className="rounded-[12px] border border-line-2 bg-canvas p-4">
              <p className="text-[13px] text-ink-2 leading-relaxed mb-3">
                mp3، m4a، wav، ogg، webm یا mp4 تا ۴۰ مگابایت.
                {status && !status.canTranscribe && ' روی این سرور رونویسی خودکار خاموش است؛ فایل ذخیره می‌شود و متن را خودتان ثبت می‌کنید.'}
              </p>
              <input
                ref={audioRef}
                type="file"
                accept="audio/*,video/mp4,video/webm"
                className="block w-full text-[12.5px]"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void uploadAudio(f);
                }}
              />
              {busy && (
                <p className="mt-3 text-[12px] text-ink-3 inline-flex items-center gap-2">
                  <Upload className="w-4 h-4 animate-pulse" /> در حال ارسال… ممکن است چند لحظه طول بکشد.
                </p>
              )}
            </div>
          )}

          <div>
            <p className="text-[12.5px] font-semibold text-ink mb-2">رونویسی‌های این کارجو</p>
            {items === null ? (
              <div className="py-6 flex justify-center">
                <Spinner />
              </div>
            ) : !items.length ? (
              <p className="text-[12.5px] text-ink-3">هنوز رونویسی‌ای ثبت نشده است.</p>
            ) : (
              <div className="flex flex-col gap-2 max-h-[340px] overflow-y-auto">
                {items.map((t) => (
                  <details key={t.id} className="rounded-[12px] border border-line-2 bg-surface px-3.5 py-2.5">
                    <summary className="cursor-pointer flex flex-wrap items-center gap-2 text-[12.5px]">
                      <span className="font-semibold text-ink">{t.title}</span>
                      <Chip tone={t.status === 'ready' ? 'neutral' : 'warning'}>{t.status === 'ready' ? TRANSCRIPT_SOURCE_LABEL[t.source] : 'متن لازم است'}</Chip>
                      {t.provider && <span className="text-[11px] text-ink-4">{t.provider}</span>}
                      <span className="text-[11px] text-ink-4">{faDate(t.createdAtISO)}</span>
                    </summary>
                    <div className="mt-2.5">
                      {t.status === 'needs_text' ? (
                        <p className="text-[12.5px] text-ink-3 leading-relaxed">
                          فایل ذخیره شده است، ولی متنی ندارد. متن را از تب «چسباندن متن» ثبت کنید (عنوان را تکرار نکنید) یا فایل
                          زیرنویس بفرستید.
                        </p>
                      ) : (
                        <p className="text-[12.5px] text-ink-2 leading-relaxed whitespace-pre-wrap max-h-[220px] overflow-y-auto">{t.text}</p>
                      )}
                      {t.audioUrl && (
                        <audio controls src={t.audioUrl} className="mt-2.5 w-full h-9">
                          مرورگر شما پخش صدا را پشتیبانی نمی‌کند.
                        </audio>
                      )}

                      {/* «خلاصهٔ جلسه» — ten lines instead of a transcript. */}
                      {t.status === 'ready' && (
                        <div className="mt-2.5">
                          {summaries[t.id] ? (
                            <MeetingSummaryCard
                              summary={summaries[t.id]}
                              regenerating={busySummary === t.id}
                              onRegenerate={() => void makeSummary(t)}
                              onDelete={() => void dropSummary(t)}
                            />
                          ) : (
                            <Button size="sm" variant="secondary" icon={Sparkles} loading={busySummary === t.id} onClick={() => void makeSummary(t)}>
                              ساخت خلاصهٔ جلسه
                            </Button>
                          )}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-1.5">
                        {t.status === 'ready' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={Copy}
                            onClick={async () => {
                              const ok = await copyText(t.text);
                              toast(ok ? 'متن کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error');
                            }}
                          >
                            کپی متن
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemoving(t)}>
                          پاک‌کردن
                        </Button>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
            <p className="mt-2.5 text-[11px] text-ink-4 inline-flex items-start gap-1.5 leading-relaxed">
              <FileAudio className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              رونویسی خودکار با نام سرویس سازنده برچسب می‌خورد؛ متن دستی با «دستی». این متن جای شنیدنِ خودتان را نمی‌گیرد.
            </p>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        title="این رونویسی پاک شود؟"
        description="متن و فایل صوتیِ آن برای همیشه حذف می‌شوند."
        confirmLabel="پاک‌کردن"
        tone="danger"
      />
    </Modal>
  );
}

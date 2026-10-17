import React, { useEffect, useRef, useState } from 'react';
import { ArchiveRestore, CloudUpload, Download, Route, ShieldAlert } from 'lucide-react';
import { Button, Callout, Card, CardHeader, ErrorState, Skeleton, TextInput, toast } from '../../components/ui';
import { ApiError, adminApi } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { faNumber } from '../../lib/format';
import { useLeaveGuard } from '../../lib/router';
import { useAsync } from '../../lib/useAsync';
import type { BackupInfo, BackupSummary, RestoreResult } from '../../types/admin';
import { AdminHeader, Row, faBytes, faDateTime } from './shared';

const CONFIRM_WORD = 'بازیابی';
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function storageLabel(info: BackupInfo): string {
  return info.storage.driver === 'remote' ? `فضای ابری (${info.storage.location})` : 'دیسک سرور';
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)));
  return (
    <div>
      <div className="flex items-center justify-between text-[12.5px] mb-1.5">
        <span className="text-ink-2 font-semibold">{label}</span>
        <span className="text-ink-3 hv-num">{faNumber(pct)}٪</span>
      </div>
      <div className="h-2 rounded-full bg-line-2 overflow-hidden" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full bg-brand rounded-full transition-[width] duration-300" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DownloadCard({ info, onStarted }: { info: BackupInfo; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const { url } = await adminApi.backupLink();
      const a = document.createElement('a');
      a.href = url;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('دریافت فایل پشتیبان شروع شد؛ بسته به حجم داده‌ها ممکن است چند دقیقه طول بکشد.');
      onStarted();
    } catch (err: any) {
      toast(err?.message || 'دریافت پشتیبان ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader
        title="دریافت پشتیبان کامل"
        subtitle="یک فایل ZIP با همه فضاهای کاری، کاربران، فرصت‌های شغلی، رزومه‌ها همراه فایل اصلی، تصمیم‌ها و تنظیمات."
        icon={Download}
      />
      <div className="mt-3">
        <Row label="محل نگهداری داده‌ها">{storageLabel(info)}</Row>
        <Row label="حجم داده‌ها">{faBytes(info.storageBytes)}</Row>
        <Row label="محتوا">
          {faNumber(info.counts.orgs)} فضای کاری · {faNumber(info.counts.users)} کاربر · {faNumber(info.counts.resumes)} رزومه · {faNumber(info.counts.files)} فایل
        </Row>
        <Row label="آخرین پشتیبان">{info.lastBackup ? `${faDateTime(info.lastBackup.atISO)} — ${info.lastBackup.actorName}` : 'هنوز پشتیبانی گرفته نشده است'}</Row>
      </div>
      <Callout tone="warning" className="mt-4">
        این فایل اطلاعات شخصی متقاضیان را دارد؛ آن را مثل یک سند محرمانه نگه دارید. نشست‌های ورود در فایل نیست. کلیدهای هوش مصنوعی رمزشده در فایل می‌آیند و فقط روی سروری با همان
        <span className="hv-latin"> APP_SECRET </span>
        قابل استفاده‌اند.
      </Callout>
      <Button className="mt-4" icon={Download} loading={busy} onClick={() => void download()}>
        دریافت فایل پشتیبان
      </Button>
    </Card>
  );
}

type Phase = 'idle' | 'uploading' | 'inspecting' | 'review' | 'applying' | 'finishing' | 'error';

function Summary({ s, current }: { s: BackupSummary; current: BackupInfo }) {
  return (
    <div className="rounded-[12px] border border-line bg-canvas px-4 py-2 mt-4">
      <Row label="فایل">
        <span className="hv-latin text-[12px]">{s.fileName}</span> ({faBytes(s.bytes)})
      </Row>
      <Row label="تاریخ پشتیبان">{s.createdAtJalali || faDateTime(s.createdAtISO)}</Row>
      {s.createdBy && <Row label="گرفته‌شده توسط">{s.createdBy}</Row>}
      <Row label="نسخه هویدا">{s.appVersion}</Row>
      <Row label="محتوا">
        {faNumber(s.counts.orgs)} فضای کاری{s.counts.demoOrgs ? ` (${faNumber(s.counts.demoOrgs)} نمایشی)` : ''} · {faNumber(s.counts.users)} کاربر · {faNumber(s.counts.jobs)} فرصت شغلی ·{' '}
        {faNumber(s.counts.resumes)} رزومه · {faNumber(s.counts.files)} فایل
      </Row>
      <Row label="جایگزین می‌شود با">
        داده‌های فعلی این سامانه: {faNumber(current.counts.orgs)} فضای کاری · {faNumber(current.counts.resumes)} رزومه
      </Row>
    </div>
  );
}

function RestoreCard({ info, onReload }: { info: BackupInfo; onReload: () => void }) {
  const { signOut } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [applied, setApplied] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<RestoreResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const prevPhase = useRef<Phase>('idle');
  const idRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Leaving mid-upload loses it; leaving mid-restore hides the result.
  useLeaveGuard(phase === 'uploading' || phase === 'inspecting' || phase === 'applying');

  useEffect(() => () => abortRef.current?.abort(), []);

  // The section on screen changes as the restore moves on: keep the keyboard
  // focus with it instead of losing it to the page.
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (phase === 'review') reviewRef.current?.focus();
    else if (phase === 'error') errorRef.current?.focus();
    else if (phase === 'idle' && prev !== 'idle') chooseRef.current?.focus();
  }, [phase]);

  // Every session ended with the restore: sign out with the good news (after
  // the leave guard above is gone, so no «leave this page?» question).
  useEffect(() => {
    if (phase !== 'finishing' || !result) return;
    const fa = (n: number) => faNumber(n);
    const keys = result.aiKeys.unreadable
      ? ` ${fa(result.aiKeys.unreadable)} کلید هوش مصنوعی با APP_SECRET دیگری رمز شده است؛ در «کلیدهای هوش مصنوعی» دوباره واردش کنید.`
      : '';
    const admins = result.admins ? '' : ' در داده‌های بازیابی‌شده مدیر سامانه‌ای نیست؛ از ADMIN_EMAILS یا کد راه‌اندازی لاگ سرور استفاده کنید.';
    void signOut({
      silent: true,
      noticeTone: 'success',
      notice: `بازیابی انجام شد: ${fa(result.counts.orgs)} فضای کاری، ${fa(result.counts.users)} کاربر و ${fa(result.counts.resumes)} رزومه${
        result.filesRestored ? ` با ${fa(result.filesRestored)} فایل` : ''
      }. همه نشست‌ها بسته شد؛ با یکی از حساب‌های داخل فایل پشتیبان وارد شوید.${keys}${admins}`,
    });
  }, [phase, result, signOut]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    const id = idRef.current;
    idRef.current = null;
    if (id) adminApi.restoreCancel(id).catch(() => {});
    setPhase('idle');
    setProgress(0);
    setSummary(null);
    setError(null);
    setConfirm('');
  };

  const fail = (err: any) => {
    setError(err?.message || 'کار با فایل پشتیبان ممکن نشد.');
    setPhase('error');
  };

  const upload = async (file: File) => {
    setError(null);
    setSummary(null);
    setConfirm('');
    setProgress(0);
    if (!/\.zip$/i.test(file.name)) return fail({ message: 'فایل پشتیبان باید فایل ZIP باشد (همان فایلی که از «دریافت پشتیبان کامل» گرفته‌اید).' });
    if (file.size > info.limits.maxBytes) return fail({ message: 'فایل پشتیبان بزرگ‌تر از ۴ گیگابایت است.' });
    setPhase('uploading');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const { id, chunkBytes } = await adminApi.restoreStart(file.name, file.size);
      idRef.current = id;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(file.size, offset + chunkBytes);
        for (let attempt = 1; ; attempt++) {
          try {
            offset = (await adminApi.restoreChunk(id, offset, file.slice(offset, end), ctrl.signal)).received;
            break;
          } catch (err) {
            if (ctrl.signal.aborted) throw err;
            const status = err instanceof ApiError ? err.status : 0;
            // Network hiccups and restarts are retried; a refusal is final.
            if (attempt >= 4 || (status >= 400 && status < 500)) throw err;
            await sleep(1500 * attempt);
          }
        }
        setProgress(offset / file.size);
      }
      setPhase('inspecting');
      setSummary(await adminApi.restoreInspect(id));
      setPhase('review');
    } catch (err: any) {
      if (ctrl.signal.aborted) return;
      const id = idRef.current;
      idRef.current = null;
      if (id) adminApi.restoreCancel(id).catch(() => {});
      fail(err);
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const apply = async () => {
    const id = idRef.current;
    if (!id || confirm.trim() !== CONFIRM_WORD) return;
    setPhase('applying');
    setApplied({ done: 0, total: summary?.counts.files || 0 });
    try {
      await adminApi.restoreApply(id, confirm.trim());
    } catch (err: any) {
      if (err instanceof ApiError && err.field === 'confirm') {
        setPhase('review');
        return toast(err.message, 'error');
      }
      return fail(err);
    }
    let misses = 0;
    for (;;) {
      await sleep(1000);
      let st;
      try {
        st = await adminApi.restoreStatus(id);
        misses = 0;
      } catch (err) {
        // The restore runs on the server either way; a few lost polls are fine.
        if (++misses >= 30) return fail({ message: 'وضعیت بازیابی از سرور دریافت نشد. چند دقیقه بعد صفحه را تازه کنید و با حساب‌های داخل فایل پشتیبان وارد شوید.' });
        continue;
      }
      setApplied(st.progress);
      if (st.state === 'done' && st.result) {
        idRef.current = null;
        setResult(st.result);
        setPhase('finishing');
        return;
      }
      if (st.state === 'failed') {
        idRef.current = null;
        onReload();
        return fail({ message: st.error || 'بازیابی انجام نشد؛ داده‌های فعلی دست نخورده است.' });
      }
    }
  };

  return (
    <Card>
      <CardHeader title="بازیابی از فایل پشتیبان" subtitle="داده‌های یک پشتیبان هویدا — از همین سرور یا سرور قبلی — را جایگزین داده‌های این سامانه کنید." icon={ArchiveRestore} />

      {phase === 'idle' && (
        <div className="mt-4">
          <p className="text-[13px] text-ink-3 leading-relaxed">
            فایل اول بارگذاری و بررسی می‌شود و پیش از هر تغییری، محتوای آن را می‌بینید. تا تأیید نکنید، چیزی جایگزین نمی‌شود.
          </p>
          {/* Hidden (not sr-only): keyboard and screen-reader users reach it through the button below. */}
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            id="hv-restore-file"
            aria-label="فایل پشتیبان"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
          <Button ref={chooseRef} className="mt-4" variant="secondary" icon={CloudUpload} onClick={() => inputRef.current?.click()}>
            انتخاب فایل پشتیبان
          </Button>
        </div>
      )}

      {phase === 'uploading' && (
        <div className="mt-5" aria-live="polite">
          <ProgressBar value={progress} label="بارگذاری فایل پشتیبان" />
          <Button className="mt-4" variant="ghost" size="sm" onClick={reset}>
            لغو
          </Button>
        </div>
      )}

      {phase === 'inspecting' && (
        <div className="mt-5" aria-live="polite">
          <Skeleton className="h-4 w-2/3 rounded-full" />
          <p className="text-[13px] text-ink-3 mt-3">در حال بررسی فایل پشتیبان…</p>
        </div>
      )}

      {phase === 'review' && summary && (
        <div className="mt-2 outline-none" ref={reviewRef} tabIndex={-1} role="group" aria-label="بررسی فایل پشتیبان">
          <Summary s={summary} current={info} />
          {summary.counts.missingFiles > 0 && (
            <Callout tone="warning" className="mt-3">
              فایل اصلی {faNumber(summary.counts.missingFiles)} رزومه در این پشتیبان نیست؛ نتیجه تحلیل آن‌ها بازیابی می‌شود ولی فایلشان نه.
            </Callout>
          )}
          {summary.aiKeys.total > summary.aiKeys.readable && (
            <Callout tone="info" className="mt-3">
              {faNumber(summary.aiKeys.total - summary.aiKeys.readable)} کلید هوش مصنوعی این پشتیبان با APP_SECRET دیگری رمز شده است؛ بعد از بازیابی آن را دوباره وارد کنید (کلیدهای فعلی این سرور هم نگه داشته می‌شوند).
            </Callout>
          )}
          {summary.admins === 0 && (
            <Callout tone="warning" className="mt-3">
              هیچ‌کدام از حساب‌های این پشتیبان مدیر سامانه نیست؛ بعد از بازیابی، با ADMIN_EMAILS یا کد راه‌اندازی لاگ سرور به پنل مدیریت برگردید.
            </Callout>
          )}
          <Callout tone="danger" icon={ShieldAlert} className="mt-3" title="همه داده‌های فعلی جایگزین می‌شود">
            همه فضاهای کاری، کاربران و رزومه‌های فعلی این سامانه با محتوای این فایل جایگزین می‌شود و همه کاربران — از جمله شما — باید دوباره وارد شوند. اگر داده‌های فعلی را لازم دارید، اول از
            آن‌ها پشتیبان بگیرید.
          </Callout>
          <div className="mt-4 max-w-[320px]">
            <TextInput label={`برای تأیید، کلمه «${CONFIRM_WORD}» را بنویسید`} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <Button variant="danger" icon={ArchiveRestore} disabled={confirm.trim() !== CONFIRM_WORD} onClick={() => void apply()}>
              بازیابی داده‌ها
            </Button>
            <Button variant="ghost" onClick={reset}>
              انصراف
            </Button>
          </div>
        </div>
      )}

      {(phase === 'applying' || phase === 'finishing') && (
        <div className="mt-5" aria-live="polite">
          <ProgressBar value={applied.total ? applied.done / applied.total : phase === 'finishing' ? 1 : 0} label="بازیابی داده‌ها و فایل‌ها" />
          <p className="text-[12.5px] text-ink-3 mt-3 leading-relaxed">
            {applied.total ? `${faNumber(applied.done)} از ${faNumber(applied.total)} فایل` : 'در حال آماده‌سازی…'} — این صفحه را نبندید. در پایان، همه کاربران از جمله شما از حساب خارج می‌شوند.
          </p>
        </div>
      )}

      {phase === 'error' && (
        <div className="mt-4 outline-none" ref={errorRef} tabIndex={-1} role="alert">
          <Callout tone="danger">{error}</Callout>
          <Button className="mt-4" variant="secondary" onClick={reset}>
            انتخاب فایل دیگر
          </Button>
        </div>
      )}
    </Card>
  );
}

export default function BackupPage() {
  const { data, error, reload } = useAsync(() => adminApi.backupInfo(), []);
  const refreshSoon = () => window.setTimeout(reload, 8000);

  if (error && !data) {
    return (
      <div>
        <AdminHeader title="پشتیبان‌گیری و انتقال" />
        <div className="hv-card">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </div>
    );
  }
  if (!data) return <Skeleton className="h-[420px] rounded-card" />;

  return (
    <div>
      <AdminHeader
        title="پشتیبان‌گیری و انتقال"
        subtitle="از همه داده‌های هویدا یک فایل پشتیبان بگیرید، یا داده‌های نسخه دیگری از هویدا (مثلاً سرور قبلی) را به این سامانه منتقل کنید."
      />
      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <DownloadCard info={data} onStarted={refreshSoon} />
        <RestoreCard info={data} onReload={reload} />
      </div>
      <Card className="mt-4">
        <CardHeader title="انتقال به سرور جدید" subtitle="مثلاً از یک سرور به Cloudflare، بدون از دست رفتن هیچ رزومه‌ای." icon={Route} />
        <ol className="mt-4 grid md:grid-cols-2 gap-3 text-[13px] text-ink-2 leading-relaxed">
          {[
            'روی سرور قبلی: پنل مدیریت › پشتیبان‌گیری و انتقال › «دریافت فایل پشتیبان».',
            'روی سرور جدید: با ایمیل ADMIN_EMAILS ثبت‌نام کنید (یا کد راه‌اندازی لاگ سرور را وارد کنید) تا مدیر سامانه شوید.',
            'همین صفحه روی سرور جدید: «انتخاب فایل پشتیبان» › بررسی محتوا › تأیید با کلمه «بازیابی».',
            'برای اینکه کلیدهای هوش مصنوعی بدون ورود دوباره کار کنند، APP_SECRET سرور جدید را همان مقدار سرور قبلی بگذارید.',
          ].map((text, i) => (
            <li key={i} className="flex items-start gap-3 rounded-[12px] border border-line-2 px-3.5 py-3">
              <span className="w-7 h-7 rounded-full bg-brand-soft text-brand-strong text-[12.5px] font-extrabold flex items-center justify-center shrink-0 hv-num" aria-hidden="true">
                {faNumber(i + 1)}
              </span>
              <span className="min-w-0">{text}</span>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

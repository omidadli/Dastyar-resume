import type { ResumeFileItem, ScreeningProgressUpdate } from '../types/screening';
import { extractResumeContent, type TextExtractionResult } from './extractText';
import { api, fileToBase64 } from './api';
import { assessText } from './officeText';
import { getPublicConfig } from './config';

/**
 * The original file travels with the evaluation when the browser could not
 * extract trustworthy text itself; the limit is the per-file size the
 * platform admin allows (/admin › تنظیمات سامانه).
 */
export function maxInlineFileBytes(): number {
  return getPublicConfig().maxFileMb * 1024 * 1024;
}

/** If nothing has moved for this long, tell the user instead of spinning silently. */
const STALL_WARNING_MS = 60_000;

const isLikelyMobile = (): boolean =>
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent || '');

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

function extractConcurrency(total: number): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const base = isLikelyMobile() ? 2 : clamp(Math.floor(cores / 2), 2, 4);
  return clamp(base, 1, Math.max(1, total));
}

function evalConcurrency(total: number): number {
  // 2–3 requests in flight are faster in practice than 4+ (rate limits) and kinder to memory.
  return clamp(isLikelyMobile() ? 2 : 3, 1, Math.max(1, total));
}

/**
 * Errors that will fail every remaining file the same way (opening closed or
 * deleted by a teammate, maintenance mode): stop the run once, clearly,
 * instead of sending two doomed requests per file.
 */
const FATAL_CODES = new Set(['JOB_CLOSED', 'JOB_NOT_FOUND', 'MAINTENANCE']);
const isFatal = (err: any): boolean => Boolean(err && FATAL_CODES.has(err.code));

export interface RunResult {
  total: number;
  aiCount: number;
  localCount: number;
  unjudgeable: number;
  errors: number;
  /** Candidates this department had already screened before («رزومهٔ تکراری»). */
  duplicates: number;
}

/**
 * Analyses a set of resumes for an existing job opening:
 *  1) mark the job as processing (visible to teammates)
 *  2) extract text client-side (PDF/DOCX/ZIP were unpacked at upload time)
 *  3) send each resume to the evaluator with bounded concurrency
 *  4) calibrate top & borderline candidates and mark the analysis done
 *
 * Robustness contract: one bad file, a dead network or a slow model can never
 * hang the run. Every call carries the AbortSignal and a deadline; worker
 * failures are captured per item and persisted as visible ERROR records.
 */
export async function runJobAnalysis(
  jobId: string,
  files: File[],
  onProgress: (u: ScreeningProgressUpdate) => void,
  signal?: AbortSignal
): Promise<RunResult> {
  const throwIfAborted = () => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  const items: ResumeFileItem[] = files.map((f, i) => ({
    id: `${Date.now().toString(36)}-${i}`,
    file: f,
    name: f.name,
    size: f.size,
    status: 'queued',
  }));
  const total = items.length;
  const extractionByItem = new Map<string, TextExtractionResult>();
  let processed = 0;
  let extractedCount = 0;
  const result: RunResult = { total, aiCount: 0, localCount: 0, unjudgeable: 0, errors: 0, duplicates: 0 };
  let phase: 'extracting' | 'evaluating' | 'calibrating' | 'done' = 'extracting';
  /** Files being evaluated right now: item id → file name (names may repeat). */
  const active = new Map<string, string>();
  let fatal: (Error & { code?: string }) | null = null;

  // Originals of text-only evaluations are uploaded quietly afterwards — two
  // at a time, so a batch of 200 never holds 200 base64 copies in memory.
  const attachQueue: Array<() => Promise<unknown>> = [];
  let attachRunning = 0;
  const pumpAttachments = () => {
    while (attachRunning < 2 && attachQueue.length) {
      const task = attachQueue.shift()!;
      attachRunning++;
      task()
        .catch(() => {})
        .finally(() => {
          attachRunning--;
          pumpAttachments();
        });
    }
  };
  const startTime = Date.now();
  let lastProgressAt = Date.now();
  const markProgress = () => (lastProgressAt = Date.now());
  let tick = 0;
  let highWater = 0;
  let lastEmitAt = 0;

  const percent = (): number => {
    if (phase === 'done') return 100;
    if (total <= 0) return 0;
    let computed = 0;
    if (phase === 'extracting') {
      computed = Math.min(15, Math.max(3, Math.round((extractedCount / total) * 15)));
    } else if (phase === 'evaluating') {
      const done = (Math.min(1, processed / total)) * 75;
      const inflight = Math.min(active.size, Math.max(0, total - processed));
      const bonus = inflight > 0 && processed < total ? (1 - Math.exp(-tick * 0.06)) * 0.65 * (75 / total) : 0;
      computed = Math.min(90, Math.round(15 + done + bonus));
    } else if (phase === 'calibrating') {
      computed = 94;
    }
    highWater = Math.max(highWater, computed); // never moves backwards
    return Math.min(highWater, 98);
  };

  const emit = (statusText: string, current?: string, subStatusText?: string, force = true) => {
    const now = Date.now();
    if (!force && now - lastEmitAt < 120) return;
    lastEmitAt = now;
    let speedPerMinute: number | undefined;
    let eta: number | undefined;
    if (phase === 'done') eta = 0;
    else if (phase === 'calibrating') eta = 2;
    else if (phase === 'extracting') {
      eta = Math.max(2, Math.ceil(((total - extractedCount) * 1.5) / extractConcurrency(total) + (total * 2.5) / evalConcurrency(total)));
    } else {
      const remaining = Math.max(0, total - processed);
      if (processed > 0) {
        const rate = processed / Math.max(1, (now - startTime) / 1000);
        speedPerMinute = Math.round(rate * 60);
        eta = Math.max(1, Math.round(remaining / (rate || 0.35)));
      } else {
        eta = Math.max(2, Math.ceil((remaining * 2.8) / Math.min(evalConcurrency(total), Math.max(1, remaining))));
      }
    }
    const stalled = phase !== 'done' && now - lastProgressAt > STALL_WARNING_MS && tick > 35;
    onProgress({
      items: [...items],
      processedCount: processed,
      totalCount: total,
      statusText,
      subStatusText,
      currentEvaluatingName: current,
      activeEvaluatingNames: Array.from(active.values()),
      phase,
      extractedCount,
      estimatedSecondsRemaining: eta,
      speedPerMinute,
      overallPercent: percent(),
      warningText: stalled ? 'پاسخ سرور کمی طولانی شده است؛ هویدا همچنان در حال تحلیل است.' : undefined,
    });
  };

  await api.jobs.analysis(jobId, 'start', { signal }).catch(() => {});
  // Heartbeat: the server shows "in progress" to teammates only while it hears
  // from this tab (a closed tab must not leave the job stuck as processing).
  const keepAlive = setInterval(() => {
    if (!signal?.aborted) api.jobs.analysis(jobId, 'start').catch(() => {});
  }, 120_000);
  try {
    return await analyse();
  } finally {
    clearInterval(keepAlive);
  }

  async function analyse(): Promise<RunResult> {
    // ---- Step A: bounded, fault-isolated text extraction ----
    emit(`در حال خواندن ${total.toLocaleString('fa-IR')} فایل…`);
    let extractNext = 0;
    async function extractWorker() {
      while (extractNext < items.length) {
        throwIfAborted();
        const item = items[extractNext++];
        item.status = 'extracting';
        emit(`در حال خواندن «${item.name}»`, item.name, undefined, false);
        try {
          if (item.file) {
            const extraction = await extractResumeContent(item.file, item.name);
            item.extractedText = extraction.text;
            extractionByItem.set(item.id, extraction);
            if (item.file.size === 0) {
              item.status = 'unjudgeable';
              item.unjudgeableReason = 'فایل خالی است (حجم صفر بایت).';
            } else {
              item.status = 'queued';
            }
          } else {
            item.status = 'queued';
          }
        } catch (err: any) {
          if (err?.name === 'AbortError') throw err;
          item.status = 'queued'; // let the server try — never drop a file here
        }
        extractedCount++;
        markProgress();
        emit(`${extractedCount.toLocaleString('fa-IR')} از ${total.toLocaleString('fa-IR')} فایل خوانده شد`, item.name, undefined, false);
      }
    }
    const extractResults = await Promise.allSettled(Array.from({ length: extractConcurrency(items.length) }, () => extractWorker()));
    const extractAbort = extractResults.find((r) => r.status === 'rejected' && (r.reason as any)?.name === 'AbortError');
    if (extractAbort) {
      await api.jobs.analysis(jobId, 'cancel').catch(() => {});
      throw (extractAbort as PromiseRejectedResult).reason;
    }

    throwIfAborted();
    markProgress();

    // ---- Step B: evaluation with bounded parallelism ----
    phase = 'evaluating';
    emit('خواندن فایل‌ها تمام شد؛ تحلیل هویدا آغاز شد…');
    let next = 0;
    const microSteps = [
      'بازخوانی سوابق و ساختار رزومه…',
      'سنجش مهارت‌ها با معیارهای فرصت شغلی…',
      'تطبیق با شرط‌های پرسش‌نامه…',
      'گردآوری شواهد و محاسبه میزان تطابق…',
    ];
    const heartbeat = setInterval(() => {
      if (active.size > 0 && phase === 'evaluating') {
        tick++;
        const name = active.values().next().value as string;
        emit(`هویدا در حال تحلیل «${name}»`, name, microSteps[tick % microSteps.length]);
      } else if (phase !== 'done' && Date.now() - lastProgressAt > STALL_WARNING_MS) {
        emit('در انتظار پاسخ سرور…');
      }
    }, 1000);

    async function evalWorker() {
      while (next < items.length && !fatal) {
        throwIfAborted();
        const item = items[next++];
        // With clean extracted text the base64 file is NOT sent (≈5KB vs MBs).
        // Everything else — scans, photos, PowerPoint/Excel, e-mails, audio,
        // unknown formats and PDFs whose text layer is garbled — goes to the
        // server's universal intake, which reads the original.
        const hasCleanText = assessText(item.extractedText || '').usable;
        const needAttachment = !hasCleanText && item.file && item.file.size <= maxInlineFileBytes();
        const attachment = needAttachment && item.file ? await fileToBase64(item.file).catch(() => undefined) : undefined;

        if (item.status === 'unjudgeable') {
          try {
            const { record } = await api.jobs.evaluate(
              jobId,
              { fileName: item.name, extractedText: '', unjudgeableReason: item.unjudgeableReason || 'فایل قابل تحلیل نیست.', fileBase64: attachment },
              { signal }
            );
            item.recordId = record.id;
            item.category = record.category;
            if (record.novelty === 'duplicate') result.duplicates++;
            result.unjudgeable++;
          } catch (err: any) {
            if (err?.name === 'AbortError') throw err;
            if (isFatal(err)) fatal = fatal || err;
            item.status = 'error';
            item.errorMessage = err?.message || 'ثبت فایل ناموفق بود.';
            result.errors++;
          }
          processed++;
          markProgress();
          emit(`${processed.toLocaleString('fa-IR')} از ${total.toLocaleString('fa-IR')} رزومه بررسی شد`);
          continue;
        }

        item.status = 'evaluating';
        active.set(item.id, item.name);
        markProgress();
        emit(`هویدا در حال تحلیل «${item.name}»`, item.name, microSteps[0]);
        try {
          const { record } = await api.jobs.evaluate(
            jobId,
            { fileName: item.name, extractedText: item.extractedText || '', unjudgeableReason: null, fileBase64: attachment },
            { signal }
          );
          item.recordId = record.id;
          item.category = record.category;
          item.score = record.score;
          if (record.novelty === 'duplicate') result.duplicates++;
          if (record.category === 'UNJUDGEABLE') {
            item.status = 'unjudgeable';
            item.unjudgeableReason = record.unjudgeableReason || 'اطلاعات رزومه برای قضاوت کافی نیست.';
            result.unjudgeable++;
          } else if (record.category === 'ERROR') {
            item.status = 'error';
            result.errors++;
          } else {
            item.status = 'success';
            if (record.engine === 'local') result.localCount++;
            else result.aiCount++;
          }
          // Text-only fast path: upload the original quietly afterwards so it
          // stays available for preview/download without blocking the queue.
          if (hasCleanText && item.file && item.file.size <= maxInlineFileBytes()) {
            const file = item.file;
            const recId = record.id;
            const name = item.name;
            attachQueue.push(() => fileToBase64(file).then((b64) => api.resumes.attachFile(recId, name, b64)));
            pumpAttachments();
          }
        } catch (err: any) {
          if (err?.name === 'AbortError' || signal?.aborted) throw err;
          if (isFatal(err)) {
            fatal = fatal || err;
            item.status = 'error';
            item.errorMessage = err.message;
            result.errors++;
            continue; // `finally` still runs; the loop then stops
          }
          try {
            const { record } = await api.jobs.evaluate(
              jobId,
              {
                fileName: item.name,
                extractedText: item.extractedText || '',
                unjudgeableReason: null,
                fileBase64: attachment,
                errorMessage: err?.message || 'خطا در تحلیل',
              },
              { signal }
            );
            item.recordId = record.id;
            item.category = record.category;
          } catch {
            /* server unreachable — keep the local error state */
          }
          item.status = 'error';
          item.errorMessage = err?.message || 'خطا در تحلیل';
          result.errors++;
        } finally {
          active.delete(item.id);
          processed++;
          markProgress();
          emit(`تحلیل ${processed.toLocaleString('fa-IR')} از ${total.toLocaleString('fa-IR')} رزومه انجام شد`, item.name);
        }
      }
    }

    const evalResults = await Promise.allSettled(Array.from({ length: evalConcurrency(items.length) }, () => evalWorker())).finally(() =>
      clearInterval(heartbeat)
    );
    const evalAbort = evalResults.find((r) => r.status === 'rejected' && (r.reason as any)?.name === 'AbortError');
    if (evalAbort) {
      await api.jobs.analysis(jobId, 'cancel').catch(() => {});
      throw (evalAbort as PromiseRejectedResult).reason;
    }
    if (fatal) {
      const stopped = fatal as Error & { code?: string };
      if (stopped.code !== 'JOB_NOT_FOUND') await api.jobs.analysis(jobId, 'cancel').catch(() => {});
      const saved = result.aiCount + result.localCount + result.unjudgeable;
      throw new Error(
        `${stopped.message}${saved ? ` ${saved.toLocaleString('fa-IR')} رزومه پیش از توقف ثبت شد.` : ''}`
      );
    }

    // ---- Step C: relative calibration + finish ----
    phase = 'calibrating';
    markProgress();
    emit('در حال هم‌سنجی نهایی و رتبه‌بندی منصفانه…');
    await api.jobs.calibrate(jobId, total, { signal }).catch((e) => console.warn('calibration skipped', e));

    phase = 'done';
    emit('تحلیل رزومه‌ها کامل شد.');
    extractionByItem.clear();
    return result;
  }
}

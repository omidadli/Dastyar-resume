import React, { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, FileWarning, RefreshCw } from 'lucide-react';
import type { ResumeRecord } from '../../types/screening';
import { api, openResumeFile, type FileUrlInfo } from '../../lib/api';
import { Button, IconButton, Spinner, toast } from '../ui';

/**
 * In-app preview of the ORIGINAL uploaded resume via a short-lived signed URL:
 * PDFs in an iframe, images inline, text in a reader pane. Formats the browser
 * can't render (Word) fall back to the extracted text plus a download button.
 */
export function ResumePreview({ record, className = '' }: { record: ResumeRecord; className?: string }) {
  const [info, setInfo] = useState<FileUrlInfo | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    setText(null);
    try {
      const i = await api.resumes.fileUrl(record.id, true);
      setInfo(i);
      if (i.hasFile && i.url && (i.ext === 'txt' || i.ext === 'md')) {
        const res = await fetch(i.url);
        if (!res.ok) throw new Error(`دریافت فایل ممکن نشد (${res.status})`);
        setText((await res.text()).slice(0, 80_000));
      }
      setState('ready');
    } catch (e: any) {
      setError(e?.message || 'نمایش فایل ممکن نشد.');
      setState('error');
    }
  }, [record.id]);

  useEffect(() => {
    void load();
  }, [load, record.filePath]);

  const kind = !info?.hasFile ? 'none' : info.ext === 'pdf' ? 'pdf' : info.mimeType?.startsWith('image/') && info.previewable ? 'image' : text !== null ? 'text' : 'other';

  const download = async () => {
    try {
      if (!(await openResumeFile(record.id, 'download'))) toast('فایل اصلی ذخیره نشده است.', 'info');
    } catch (e: any) {
      toast(e?.message || 'دانلود ممکن نشد.', 'error');
    }
  };

  return (
    <div className={`hv-card flex flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-line shrink-0">
        <span className="w-9 h-9 rounded-[10px] bg-line-2 flex items-center justify-center shrink-0">
          <FileText className="w-[18px] h-[18px] text-ink-3" strokeWidth={1.7} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-ink truncate hv-latin text-right">{record.fileName}</p>
          <p className="text-[11.5px] text-ink-3">
            {state === 'loading' ? 'در حال آماده‌سازی پیش‌نمایش…' : kind === 'pdf' ? 'پیش‌نمایش PDF' : kind === 'image' ? 'تصویر رزومه' : kind === 'text' ? 'متن فایل' : kind === 'none' ? 'فایل اصلی ذخیره نشده است' : 'پیش‌نمایش این قالب در مرورگر ممکن نیست'}
          </p>
        </div>
        <IconButton icon={RefreshCw} label="بارگذاری دوباره" size="sm" onClick={() => void load()} />
        <IconButton
          icon={ExternalLink}
          label="باز کردن در زبانه جدید"
          size="sm"
          disabled={!info?.hasFile}
          onClick={() => openResumeFile(record.id, 'tab').catch(() => toast('باز کردن فایل ممکن نشد.', 'error'))}
        />
        <Button size="sm" icon={Download} onClick={download} disabled={!info?.hasFile} className="max-sm:hidden">
          دانلود
        </Button>
      </div>
      <div className="flex-1 min-h-[480px] bg-canvas relative">
        {state === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner label="در حال بارگذاری فایل…" />
          </div>
        )}
        {state === 'ready' && kind === 'pdf' && info?.url && (
          <iframe src={info.url} title={`رزومه ${record.candidateName || record.fileName}`} className="absolute inset-0 w-full h-full bg-white" />
        )}
        {state === 'ready' && kind === 'image' && info?.url && (
          <div className="absolute inset-0 overflow-auto p-4 flex items-start justify-center">
            <img src={info.url} alt={`رزومه ${record.candidateName || record.fileName}`} className="max-w-full h-auto rounded-[10px] shadow-raise bg-white" />
          </div>
        )}
        {state === 'ready' && kind === 'text' && (
          <pre dir="auto" className="absolute inset-0 overflow-auto hv-scroll p-5 text-[13px] leading-[1.9] text-ink-2 whitespace-pre-wrap font-sans bg-surface">
            {text || 'فایل متنی خالی است.'}
          </pre>
        )}
        {(state === 'error' || (state === 'ready' && (kind === 'other' || kind === 'none'))) && (
          <div className="absolute inset-0 overflow-auto hv-scroll p-4 flex flex-col gap-3">
            <div className="flex items-start gap-2.5 rounded-[12px] border border-review/25 bg-review-soft p-3.5">
              <FileWarning className="w-[18px] h-[18px] text-review-ink shrink-0 mt-0.5" />
              <p className="text-[13px] text-[#7A4A0B] leading-relaxed">
                {state === 'error'
                  ? error
                  : kind === 'none'
                  ? 'فایل اصلی این رزومه روی سرور ذخیره نشده است؛ متن استخراج‌شده در ادامه آمده است.'
                  : 'فایل‌های Word را می‌توانید دانلود کنید. متن استخراج‌شده در ادامه آمده است.'}
              </p>
            </div>
            <div className="hv-card p-4">
              <p className="text-[12px] font-bold text-ink-3 mb-2">متن استخراج‌شده از رزومه</p>
              <pre dir="auto" className="text-[13px] leading-[1.9] text-ink-2 whitespace-pre-wrap font-sans">
                {record.extractedText || 'متنی از این فایل استخراج نشده است.'}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

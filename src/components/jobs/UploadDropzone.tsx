import React, { useRef, useState } from 'react';
import { FileArchive, FileText, Image as ImageIcon, Loader2, UploadCloud, X } from 'lucide-react';
import { processUploadFiles } from '../../lib/extractText';
import { formatFileSize, toPersianDigits } from '../../lib/normalizeFa';
import { toast } from '../ui';

/** Per-file ceiling: a giant scan must never freeze the tab before upload. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ACCEPT = '.pdf,.docx,.doc,.txt,.rtf,.md,.odt,.zip,.jpg,.jpeg,.png,.webp,.heic,.heif,.bmp,.tif,.tiff';

function iconFor(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'].includes(ext)) return ImageIcon;
  if (ext === 'zip') return FileArchive;
  return FileText;
}

/** Drag & drop / pick resumes (PDF, Word, images, text, or a ZIP of them). */
export function UploadDropzone({
  files,
  onChange,
  disabled,
  compact,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const [unpacking, setUnpacking] = useState<{ current: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const add = async (list: FileList | File[]) => {
    const raw = Array.from(list);
    if (!raw.length) return;
    setUnpacking({ current: 0, total: 0 });
    try {
      const unpacked = await processUploadFiles(raw, (current, total) => setUnpacking({ current, total }));
      const keys = new Set(files.map((f) => `${f.name}_${f.size}_${f.lastModified}`));
      const next = [...files];
      let tooBig = 0;
      let dupes = 0;
      for (const f of unpacked) {
        if (f.size > MAX_FILE_BYTES) {
          tooBig++;
          continue;
        }
        const key = `${f.name}_${f.size}_${f.lastModified}`;
        if (keys.has(key)) {
          dupes++;
          continue;
        }
        keys.add(key);
        next.push(f);
      }
      onChange(next);
      if (tooBig) toast(`${toPersianDigits(tooBig)} فایل بیش از ۲۰ مگابایت بود و اضافه نشد.`, 'error');
      if (dupes) toast(`${toPersianDigits(dupes)} فایل تکراری کنار گذاشته شد.`, 'info');
    } finally {
      setUnpacking(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!disabled && e.dataTransfer.files?.length) void add(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center justify-center text-center rounded-[16px] border-2 border-dashed transition-colors ${
          compact ? 'py-7 px-4' : 'py-10 px-6'
        } ${disabled ? 'opacity-60 cursor-not-allowed border-line' : dragging ? 'border-brand bg-brand-tint cursor-copy' : 'border-line-strong bg-surface hover:border-brand/50 hover:bg-brand-tint/50 cursor-pointer'}`}
      >
        <span className="w-12 h-12 rounded-[14px] bg-brand-soft flex items-center justify-center mb-3">
          {unpacking ? <Loader2 className="w-6 h-6 text-brand-strong animate-spin" /> : <UploadCloud className="w-6 h-6 text-brand-strong" strokeWidth={1.7} />}
        </span>
        <p className="text-[14px] font-bold text-ink">
          {unpacking
            ? unpacking.total
              ? `در حال باز کردن فایل فشرده: ${toPersianDigits(unpacking.current)} از ${toPersianDigits(unpacking.total)}`
              : 'در حال آماده‌سازی فایل‌ها…'
            : 'رزومه‌ها را اینجا رها کنید یا برای انتخاب بزنید'}
        </p>
        <p className="text-[12.5px] text-ink-3 mt-1.5 leading-relaxed">
          PDF، Word، تصویر اسکن‌شده، متن یا یک فایل ZIP شامل چند رزومه — هر فایل حداکثر ۲۰ مگابایت
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <div className="rounded-[12px] border border-line bg-surface">
          <div className="flex items-center justify-between px-3.5 h-10 border-b border-line-2">
            <span className="text-[12.5px] font-bold text-ink-2">{toPersianDigits(files.length)} فایل آماده تحلیل</span>
            <button onClick={() => onChange([])} className="text-[12px] font-semibold text-ink-3 hover:text-low-ink" disabled={disabled}>
              پاک کردن همه
            </button>
          </div>
          <ul className="max-h-[220px] overflow-y-auto hv-scroll divide-y divide-line-2">
            {files.map((f, i) => {
              const Icon = iconFor(f.name);
              return (
                <li key={`${f.name}_${f.size}_${i}`} className="flex items-center gap-3 px-3.5 py-2">
                  <Icon className="w-4 h-4 text-ink-4 shrink-0" strokeWidth={1.8} />
                  <span className="flex-1 min-w-0 text-[13px] text-ink-2 truncate hv-latin text-right">{f.name}</span>
                  <span className="text-[11.5px] text-ink-4 shrink-0">{formatFileSize(f.size)}</span>
                  <button
                    onClick={() => onChange(files.filter((_, k) => k !== i))}
                    disabled={disabled}
                    aria-label={`حذف ${f.name}`}
                    className="w-7 h-7 rounded-md flex items-center justify-center text-ink-4 hover:text-low-ink hover:bg-low-soft"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

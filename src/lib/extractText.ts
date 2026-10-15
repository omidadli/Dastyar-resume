import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { normalizePersianText } from './normalizeFa';
import { assemblePageText, type PdfTextItem } from './pdfLayout';
import { rtfToText } from './rtf';

/** Lazy loaded to avoid bloating initial bundle on page load */
let mammothPromise: Promise<any> | null = null;
function loadMammoth(): Promise<any> {
  if (!mammothPromise) {
    mammothPromise = import('mammoth').then((mod) => (mod as any).default ?? mod);
  }
  return mammothPromise;
}

let jszipPromise: Promise<any> | null = null;
function loadJSZip(): Promise<any> {
  if (!jszipPromise) {
    jszipPromise = import('jszip').then((mod) => (mod as any).default ?? mod);
  }
  return jszipPromise;
}

export interface TextExtractionResult {
  text: string;
  success: boolean;
  unjudgeableReason?: string;
  isVisualDocument?: boolean;
}

export interface UnpackedFile {
  name: string;
  file: File;
  size: number;
}

/** Upper bound on parsed PDF pages: a 300-page scan must not freeze the queue. */
const MAX_PDF_PAGES = 40;
/** Hard wall-clock budget for opening + reading a single document. */
const DOCUMENT_TIMEOUT_MS = 45_000;

/** pdf.js is heavy (~1.2 MB); load it only when a PDF actually shows up. */
type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => {
        const lib = (mod as any).default ?? mod;
        // Same-origin worker only. The previous cdnjs.cloudflare.com fallback
        // pointed at a pdf.js version that does not exist there for v6 and is
        // frequently blocked on Iranian networks, which made extraction hang.
        try {
          lib.GlobalWorkerOptions.workerSrc = pdfWorker;
        } catch (e) {
          console.warn('Could not set pdf.js workerSrc:', e);
        }
        return lib as PdfJsModule;
      })
      .catch((err) => {
        pdfjsPromise = null; // allow a retry on the next file
        throw err;
      });
  }
  return pdfjsPromise;
}

function getExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() || '';
}

/** Rejects with a readable Persian error once `ms` elapses. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} بیش از ${Math.round(ms / 1000)} ثانیه طول کشید`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Lightweight binary text extractor for legacy .doc (Word 97-2003)
 */
function extractFromDocBinary(buffer: ArrayBuffer): string {
  try {
    const bytes = new Uint8Array(buffer);
    // Large legacy .doc files produce huge intermediate strings; cap the scan
    // so a single file cannot stall the main thread on a phone.
    const window = bytes.length > 4_000_000 ? bytes.subarray(0, 4_000_000) : bytes;
    const textDecoder = new TextDecoder('utf-8', { fatal: false });
    // Look for UTF-16LE text streams common in Word FIB structures
    const utf16Decoder = new TextDecoder('utf-16le', { fatal: false });
    const utf16Text = utf16Decoder.decode(window);
    // Filter out control and noise characters
    const cleanU16 = utf16Text.replace(/[^\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF\w\s.,;:!?@#%&*()_\-+=/]/g, ' ').replace(/\s{2,}/g, ' ');
    if (cleanU16.trim().length > 100) {
      return cleanU16.trim();
    }
    const plainText = textDecoder.decode(window);
    const cleanPlain = plainText.replace(/[^\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF\w\s.,;:!?@#%&*()_\-+=/]/g, ' ').replace(/\s{2,}/g, ' ');
    return cleanPlain.trim();
  } catch {
    return '';
  }
}

/**
 * PDF text extraction. Layout (lines, columns, Persian glyph order, spaces)
 * is rebuilt by assemblePageText. Fails gracefully so visual or complex PDFs
 * proceed to multimodal AI.
 */
async function extractFromPdfWithCoordinates(buffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await loadPdfJs();

  // Make a defensive copy of buffer slice so original arrayBuffer isn't detached
  const dataCopy = new Uint8Array(buffer.slice(0));

  let loadingTask: any;
  try {
    loadingTask = pdfjsLib.getDocument({
      data: dataCopy,
      useSystemFonts: true,
    } as any);
  } catch (initErr) {
    // If worker init failed, try in main thread mode
    try {
      (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';
      loadingTask = pdfjsLib.getDocument({
        data: dataCopy,
        useSystemFonts: true,
      } as any);
    } catch {
      return '';
    }
  }

  try {
    const pdf: any = await withTimeout(loadingTask.promise, 20_000, 'باز کردن فایل PDF');
    const pageTexts: string[] = [];
    const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);

    for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 1.0 });
        const content = await page.getTextContent();

        // Reading order, spaces, columns and RTL glyph order are rebuilt in
        // pdfLayout.ts (Chrome/Word place Persian glyphs one by one, visually).
        const items: PdfTextItem[] = [];
        for (const item of content.items as any[]) {
          if (typeof item?.str !== 'string' || !item.str.length || !item.transform) continue;
          items.push({
            str: item.str,
            x: item.transform[4],
            y: viewport.height - item.transform[5],
            w: item.width || 0,
            h: item.height || 0,
          });
        }
        if (items.length === 0) continue;
        let sortedText = assemblePageText(items, viewport.width);

        // Extract PDF annotations (links, email mailto, phone tel, whatsapp wa.me, etc.)
        try {
          const annotations = await page.getAnnotations();
          const pageLinks: string[] = [];
          for (const ann of annotations || []) {
            const rawUrl = ann?.url || ann?.unsafeUrl || '';
            if (!rawUrl) continue;
            if (rawUrl.startsWith('mailto:')) {
              const email = rawUrl.replace(/^mailto:/i, '').trim();
              if (email) pageLinks.push(`ایمیل: ${email}`);
            } else if (rawUrl.startsWith('tel:')) {
              const phone = rawUrl.replace(/^tel:/i, '').trim();
              if (phone) pageLinks.push(`تلفن: ${phone}`);
            } else if (rawUrl.includes('wa.me/')) {
              const wa = rawUrl.split('wa.me/')[1]?.replace(/[^0-9+]/g, '');
              if (wa) pageLinks.push(`واتساپ / تلفن: ${wa}`);
            } else if (rawUrl.includes('linkedin.com/in/')) {
              pageLinks.push(`لینکدین: ${rawUrl}`);
            } else if (/^https?:\/\//i.test(rawUrl)) {
              pageLinks.push(`لینک: ${rawUrl}`);
            }
          }
          if (pageLinks.length > 0) {
            sortedText += `\n\n[لینک‌ها و اطلاعات تماس استخراج‌شده از این صفحه]:\n` + pageLinks.join('\n');
          }
        } catch {
          /* ignore annotation extraction errors */
        }

        pageTexts.push(sortedText);
        try {
          await page.cleanup();
        } catch {
          /* ignore */
        }
      } catch (pageErr) {
        console.warn(`Error reading PDF page ${pageNum}:`, pageErr);
      }
    }

    return pageTexts.join('\n\n').trim();
  } catch (err) {
    console.warn('PDF text extraction caught error, falling back to multimodal:', err);
    return '';
  } finally {
    try {
      if (loadingTask && typeof loadingTask.destroy === 'function') {
        await loadingTask.destroy();
      }
    } catch {
      /* ignore */
    }
  }
}

/**
 * Extract text from DOCX using mammoth with fallback to direct XML extraction
 */
async function extractFromDocx(buffer: ArrayBuffer): Promise<string> {
  try {
    const mammoth = await loadMammoth();
    const result: any = await withTimeout(
      mammoth.extractRawText({ arrayBuffer: buffer.slice(0) }),
      15_000,
      'باز کردن فایل Word'
    );
    if (result?.value && typeof result.value === 'string' && result.value.trim().length > 10) {
      // mammoth separates every paragraph with a blank line; keep one break.
      return result.value.replace(/\n[ \t]*\n+/g, '\n').trim();
    }
  } catch (mErr) {
    console.warn('Mammoth extraction failed, trying zip xml fallback:', mErr);
  }

  // Fallback: direct ZIP parsing of word/document.xml
  return extractDocxViaZip(buffer);
}

/**
 * Direct XML text extraction from DOCX archive (bypasses mammoth formatting errors)
 */
async function extractDocxViaZip(buffer: ArrayBuffer): Promise<string> {
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    const loaded: any = await zip.loadAsync(buffer.slice(0));
    const docXml = loaded.files['word/document.xml'];
    if (!docXml) return '';
    const xmlText = await docXml.async('string');
    const paragraphs = xmlText.split(/<\/w:p>/);
    const lines: string[] = [];
    for (const p of paragraphs) {
      const matches = p.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
      if (matches) {
        const line = matches
          .map((m: string) => m.replace(/<[^>]+>/g, ''))
          .join('')
          .trim();
        if (line) lines.push(line);
      }
    }
    return lines.join('\n');
  } catch (zipErr) {
    console.warn('Docx direct XML extraction error:', zipErr);
    return '';
  }
}

/** OpenDocument text (.odt) is a ZIP: read paragraphs from content.xml. */
async function extractFromOdt(buffer: ArrayBuffer): Promise<string> {
  try {
    const JSZip = await loadJSZip();
    const zip: any = await new JSZip().loadAsync(buffer.slice(0));
    const xml: string | undefined = await zip.files['content.xml']?.async('string');
    if (!xml) return '';
    return xml
      .replace(/<text:(?:s|tab)[^>]*\/>/g, ' ')
      .replace(/<text:line-break[^>]*\/>/g, '\n')
      .replace(/<\/text:(?:p|h)>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .trim();
  } catch (err) {
    console.warn('ODT extraction failed:', err);
    return '';
  }
}

/**
 * Extract text from TXT or other plain formats with UTF-8 and Persian Windows-1256 fallback
 */
function extractFromPlainText(buffer: ArrayBuffer): string {
  try {
    const utf8Text = new TextDecoder('utf-8').decode(buffer).trim();
    if (utf8Text && !utf8Text.includes('\uFFFD')) {
      return utf8Text;
    }
    // Try Persian Windows-1256 if UTF-8 has replacement characters
    try {
      const winDecoder = new TextDecoder('windows-1256');
      const winText = winDecoder.decode(buffer).trim();
      if (winText && !winText.includes('\uFFFD')) {
        return winText;
      }
    } catch {
      /* ignore */
    }
    return utf8Text;
  } catch {
    return '';
  }
}

/**
 * Main extractor: returns clean normalized text or marks for multimodal AI processing.
 * NEVER rejects a non-empty file: visual PDFs, scanned files, images, and documents
 * will proceed to Gemini multimodal analysis.
 */
export async function extractResumeContent(file: File | Blob, fileName: string): Promise<TextExtractionResult> {
  const ext = getExtension(fileName);

  if (file.size === 0) {
    return {
      text: '',
      success: false,
      unjudgeableReason: 'فایل خالی و بدون محتواست (حجم صفر بایت)',
    };
  }

  try {
    const buffer = await withTimeout(
      file.arrayBuffer(),
      DOCUMENT_TIMEOUT_MS,
      'خواندن فایل'
    );

    // 1. PDF
    if (ext === 'pdf') {
      let rawText = '';
      try {
        rawText = await extractFromPdfWithCoordinates(buffer);
      } catch (pdfErr) {
        console.warn('PDF text extraction error, proceeding with vision:', pdfErr);
      }
      const normalized = normalizePersianText(rawText);
      // If we extracted good text, use it. If text is sparse (scanned or image-only PDF),
      // mark isVisualDocument = true so Gemini multimodal reads the full file!
      const hasGoodText = Boolean(normalized && normalized.trim().length >= 50);
      return {
        text: normalized || '',
        success: true,
        isVisualDocument: !hasGoodText,
      };
    }

    // 2. Images (JPG, PNG, WEBP, HEIC, HEIF, BMP, TIFF, GIF)
    if (['png', 'jpg', 'jpeg', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'gif'].includes(ext)) {
      return {
        text: '',
        success: true,
        isVisualDocument: true,
      };
    }

    // 3. Word DOCX
    if (ext === 'docx') {
      let rawText = '';
      try {
        rawText = await extractFromDocx(buffer);
      } catch (docxErr) {
        console.warn('DOCX extraction error:', docxErr);
      }
      const normalized = normalizePersianText(rawText);
      return {
        text: normalized || '',
        success: true,
        isVisualDocument: !normalized || normalized.trim().length < 30,
      };
    }

    // 4. Legacy Word DOC (97-2003)
    if (ext === 'doc') {
      let rawText = '';
      try {
        rawText = extractFromDocBinary(buffer);
      } catch (docErr) {
        console.warn('Legacy DOC binary extraction error:', docErr);
      }
      const normalized = normalizePersianText(rawText);
      return {
        text: normalized || '',
        success: true,
        isVisualDocument: !normalized || normalized.trim().length < 30,
      };
    }

    // 5. OpenDocument (a ZIP — never decode it as text) and RTF (markup)
    if (ext === 'odt' || ext === 'rtf') {
      let rawText = '';
      try {
        rawText = ext === 'odt' ? await extractFromOdt(buffer) : rtfToText(new TextDecoder('latin1').decode(buffer));
      } catch (err) {
        console.warn(`${ext} extraction error:`, err);
      }
      const normalized = normalizePersianText(rawText);
      return { text: normalized, success: true, isVisualDocument: normalized.trim().length < 30 };
    }

    // 6. Plain text (TXT, MD, CSV, LOG)
    if (['txt', 'md', 'text', 'csv', 'log'].includes(ext)) {
      const rawText = extractFromPlainText(buffer);
      const normalized = normalizePersianText(rawText);
      return {
        text: normalized || rawText,
        success: true,
      };
    }

    // 7. Any other non-empty file format:
    // Pass along to Gemini multimodal / server evaluation
    return {
      text: '',
      success: true,
      isVisualDocument: true,
    };
  } catch (err: any) {
    console.warn('Extraction caught fallback for file:', fileName, err);
    // Never fail a file if it has bytes; allow server / Gemini to evaluate
    return {
      text: '',
      success: true,
      isVisualDocument: true,
    };
  }
}

/**
 * Handles multi-file unpacking including ZIP files.
 * Recursively extracts files from ZIP archives with real-time progress callbacks.
 */
export async function processUploadFiles(
  rawFiles: File[],
  onProgress?: (unpackedCount: number, totalEntries: number, currentName: string) => void
): Promise<File[]> {
  const flattened: File[] = [];

  for (const f of rawFiles) {
    const ext = getExtension(f.name);
    if (ext === 'zip') {
      try {
        const JSZip = await loadJSZip();
        const zip = new JSZip();
        const loaded: any = await withTimeout(zip.loadAsync(f), 120_000, 'باز کردن فایل فشرده');
        const entries = Object.keys(loaded.files);

        // Filter valid resume entries
        const validKeys = entries.filter((relPath) => {
          const entry = loaded.files[relPath];
          if (entry.dir || relPath.includes('__MACOSX') || relPath.startsWith('.') || relPath.includes('/.')) {
            return false;
          }
          const entryExt = getExtension(entry.name);
          return ['pdf', 'docx', 'doc', 'txt', 'rtf', 'md', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'bmp', 'tiff', 'tif', 'odt'].includes(entryExt);
        });

        let count = 0;
        for (const relativePath of validKeys) {
          const zipEntry = loaded.files[relativePath];
          const blob = await zipEntry.async('blob');
          const innerFileName = zipEntry.name.split('/').pop() || zipEntry.name;
          const unpackedFile = new File([blob], innerFileName, {
            type: blob.type || 'application/octet-stream',
            lastModified: zipEntry.date?.getTime() || Date.now(),
          });
          flattened.push(unpackedFile);
          count++;
          if (onProgress) {
            onProgress(count, validKeys.length, innerFileName);
          }
          // Yield to the event loop so the progress UI stays responsive on
          // phones while a large archive is being unpacked.
          await new Promise((r) => setTimeout(r, 0));
        }
      } catch (err) {
        console.error('Error unpacking zip file:', err);
        flattened.push(f);
      }
    } else {
      flattened.push(f);
    }
  }

  return flattened;
}

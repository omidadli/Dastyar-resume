/**
 * Decompression limits for ZIP-based files (DOCX/PPTX/XLSX/ODF/EPUB/XPS and
 * plain ZIP archives).
 *
 * A «zip bomb» is a few kilobytes on disk and gigabytes once inflated; read
 * naively, one upload exhausts the server's memory and takes every workspace
 * down with it. Every entry is therefore inflated through a counting stream:
 *
 *  - the size declared in the archive is checked first (cheap rejection);
 *  - the bytes actually produced are counted while inflating, because the
 *    declared size can lie — inflation stops the moment a limit is crossed;
 *  - one budget is shared by the whole file, nested archives and e-mail
 *    attachments included.
 */
import type { ZipEntryLike, ZipLike } from '../../src/lib/officeText';

/** Largest single entry we inflate (a resume's document.xml is rarely > 5 MB). */
export const MAX_ENTRY_BYTES = 40 * 1024 * 1024;
/** Total inflated bytes allowed for one uploaded file. */
export const MAX_INFLATE_BYTES = 128 * 1024 * 1024;
/** Archives with more entries than this are not resumes. */
export const MAX_ZIP_ENTRIES = 5000;

export class ArchiveLimitError extends Error {
  constructor(what: string) {
    super(`archive limit exceeded: ${what}`);
    this.name = 'ArchiveLimitError';
  }
}

export interface InflateBudget {
  remaining: number;
  /** Per-entry ceiling (tests lower it). */
  maxEntry: number;
}

export function newInflateBudget(total = MAX_INFLATE_BYTES, maxEntry = MAX_ENTRY_BYTES): InflateBudget {
  return { remaining: total, maxEntry };
}

/**
 * Entry count from the End Of Central Directory record — read *before*
 * JSZip parses the directory (a directory of millions of entries is itself a
 * memory bomb). Null when the record is not found (JSZip then decides).
 */
export function zipEntryCount(buf: Buffer): number | null {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const total = buf.readUInt16LE(i + 10);
      return total === 0xffff ? Number.POSITIVE_INFINITY : total; // ZIP64 ⇒ more than 65 534 entries
    }
  }
  return null;
}

/** Size the archive claims for an entry (JSZip keeps it on the compressed object). */
function declaredSize(file: any): number {
  const n = Number(file?._data?.uncompressedSize);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Inflates one JSZip entry, counting bytes. `keep=false` only measures
 * (nothing is retained) — used before handing the archive to libraries that
 * inflate on their own (mammoth, SheetJS).
 */
function inflate(file: any, budget: InflateBudget, keep: boolean): Promise<Uint8Array> {
  const name = String(file?.name || 'entry');
  const declared = declaredSize(file);
  if (declared > budget.maxEntry || declared > budget.remaining) return Promise.reject(new ArchiveLimitError(name));
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    let helper: any;
    try {
      helper = file.internalStream('uint8array');
    } catch (err: any) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    helper
      .on('data', (chunk: Uint8Array) => {
        if (settled) return;
        total += chunk.length;
        if (total > budget.maxEntry || total > budget.remaining) {
          try {
            helper.pause();
          } catch {
            /* already stopped */
          }
          fail(new ArchiveLimitError(name));
          return;
        }
        if (keep) chunks.push(chunk);
      })
      .on('error', (err: any) => fail(err instanceof Error ? err : new Error(String(err))))
      .on('end', () => {
        if (settled) return;
        settled = true;
        budget.remaining -= total;
        if (!keep) return resolve(new Uint8Array(0));
        if (chunks.length === 1) return resolve(chunks[0]);
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        resolve(out);
      })
      .resume();
  });
}

const utf8 = new TextDecoder('utf-8');

/** The same archive, but every read goes through the limits above. */
export function guardZip(zip: any, budget: InflateBudget): ZipLike {
  const files: Record<string, ZipEntryLike> = {};
  for (const [path, file] of Object.entries<any>(zip.files || {})) {
    files[path] = {
      name: file.name,
      dir: Boolean(file.dir),
      async: (async (type: 'string' | 'uint8array') => {
        const bytes = await inflate(file, budget, true);
        return type === 'string' ? utf8.decode(bytes) : bytes;
      }) as ZipEntryLike['async'],
    };
  }
  return { files, file: (path: string) => files[path] || null };
}

/**
 * Inflates (without keeping) every entry matching `filter`, so a library that
 * reads the raw archive itself is never handed a bomb.
 */
export async function measureEntries(zip: any, budget: InflateBudget, filter: (name: string) => boolean = () => true): Promise<void> {
  for (const [path, file] of Object.entries<any>(zip.files || {})) {
    if (file.dir || !filter(path)) continue;
    await inflate(file, budget, false);
  }
}

/** Charges bytes inflated outside JSZip (e.g. gzip) to the same budget. */
export function charge(budget: InflateBudget, bytes: number, what: string) {
  if (bytes > budget.remaining) throw new ArchiveLimitError(what);
  budget.remaining -= bytes;
}

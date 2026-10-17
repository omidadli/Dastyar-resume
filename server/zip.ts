/**
 * Minimal ZIP writer/reader for full backups (server/backup.ts).
 *
 * Writer: streams entries to a Writable (an HTTP response) one at a time —
 * resume files are stored as-is (already compressed formats), the JSON
 * snapshot is deflated. Memory stays at one file, whatever the backup size.
 *
 * Reader: random access on a file on disk (the uploaded backup) through the
 * central directory, so a backup of any size is never loaded whole. It also
 * reads archives re-packed by other tools (deflate, data descriptors, a
 * wrapping folder). Encrypted entries and ZIP64 (> 4 GB) are refused.
 */
import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';
import { once } from 'events';
import type { Writable } from 'stream';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw) as (buf: Buffer, opts?: zlib.ZlibOptions & { maxOutputLength?: number }) => Promise<Buffer>;

// ------------------------------------------------------------------ crc32 ----

let CRC_TABLE: Int32Array | null = null;
function crcTable(): Int32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(buf: Buffer): number {
  const native = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (typeof native === 'function') return native(buf) >>> 0;
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ----------------------------------------------------------------- writer ----

const LIMIT_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipLimitError';
  }
}

interface WrittenEntry {
  name: Buffer;
  method: number;
  crc: number;
  csize: number;
  usize: number;
  time: number;
  date: number;
  offset: number;
}

/** DOS time/date of a wall-clock moment (Tehran: the archive has no timezone). */
function dosStamp(d: Date): { time: number; date: number } {
  const parts: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const year = Math.max(1980, parts.year || 1980);
  const hour = parts.hour === 24 ? 0 : parts.hour || 0;
  return {
    time: (hour << 11) | ((parts.minute || 0) << 5) | Math.floor((parts.second || 0) / 2),
    date: ((year - 1980) << 9) | ((parts.month || 1) << 5) | (parts.day || 1),
  };
}

export class ZipWriter {
  private offset = 0;
  private entries: WrittenEntry[] = [];
  private stamp = dosStamp(new Date());
  private aborted = false;

  constructor(private out: Writable) {
    out.on('close', () => {
      this.aborted = true;
    });
  }

  get bytesWritten(): number {
    return this.offset;
  }

  private async write(buf: Buffer) {
    if (this.aborted || this.out.destroyed) throw new Error('download aborted');
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      await Promise.race([once(this.out, 'drain'), once(this.out, 'close')]);
      if (this.out.destroyed) throw new Error('download aborted');
    }
  }

  async add(name: string, data: Buffer, opts: { compress?: boolean } = {}) {
    if (this.entries.length >= MAX_ENTRIES) throw new ZipLimitError('too many files for one archive');
    const nameBuf = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    let method = 0;
    let payload = data;
    if (opts.compress && data.length > 512) {
      const deflated = await deflateRaw(data, { level: 6 });
      if (deflated.length < data.length) {
        method = 8;
        payload = deflated;
      }
    }
    if (payload.length >= LIMIT_32 || data.length >= LIMIT_32 || this.offset + 30 + nameBuf.length + payload.length >= LIMIT_32) {
      throw new ZipLimitError('archive larger than 4 GB');
    }
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4); // version needed
    h.writeUInt16LE(0x0800, 6); // UTF-8 names
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(this.stamp.time, 10);
    h.writeUInt16LE(this.stamp.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(payload.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28);
    const offset = this.offset;
    await this.write(Buffer.concat([h, nameBuf]));
    await this.write(payload);
    this.entries.push({ name: nameBuf, method, crc, csize: payload.length, usize: data.length, ...this.stamp, offset });
  }

  async finish() {
    const cdStart = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.csize, 20);
      c.writeUInt32LE(e.usize, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt16LE(0, 30); // extra
      c.writeUInt16LE(0, 32); // comment
      c.writeUInt16LE(0, 34); // disk
      c.writeUInt16LE(0, 36); // internal attrs
      c.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
      c.writeUInt32LE(e.offset, 42);
      await this.write(Buffer.concat([c, e.name]));
    }
    const cdSize = this.offset - cdStart;
    if (cdStart >= LIMIT_32 || cdSize >= LIMIT_32) throw new ZipLimitError('archive larger than 4 GB');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20);
    await this.write(end);
  }
}

// ----------------------------------------------------------------- reader ----

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipFormatError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
}

export class ZipReader {
  private constructor(
    private fh: fs.promises.FileHandle,
    private size: number,
    readonly entries: ZipEntry[]
  ) {}

  static async open(filePath: string, maxEntries = 200_000): Promise<ZipReader> {
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const size = (await fh.stat()).size;
      if (size < 22) throw new ZipFormatError('not a zip archive');
      const tailLen = Math.min(size, 22 + 0xffff);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, size - tailLen);
      let eocd = -1;
      for (let i = tailLen - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) throw new ZipFormatError('not a zip archive (no end record)');
      const count = tail.readUInt16LE(eocd + 10);
      const cdSize = tail.readUInt32LE(eocd + 12);
      const cdOffset = tail.readUInt32LE(eocd + 16);
      if (count === 0xffff || cdOffset === LIMIT_32 || cdSize === LIMIT_32) throw new ZipFormatError('ZIP64 archives are not supported');
      if (count > maxEntries) throw new ZipFormatError('too many entries');
      if (cdOffset + cdSize > size) throw new ZipFormatError('truncated archive');
      const cd = Buffer.alloc(cdSize);
      await fh.read(cd, 0, cdSize, cdOffset);
      const entries: ZipEntry[] = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError('corrupt central directory');
        const flags = cd.readUInt16LE(p + 8);
        const method = cd.readUInt16LE(p + 10);
        const crc = cd.readUInt32LE(p + 16);
        const csize = cd.readUInt32LE(p + 20);
        const usize = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const offset = cd.readUInt32LE(p + 42);
        const rawName = cd.subarray(p + 46, p + 46 + nameLen);
        // Bit 11: UTF-8. Older tools write CP437/locale names — only ASCII
        // names matter to us (manifest, store, resumes/<ids>), which decode the same.
        const name = rawName.toString(flags & 0x0800 ? 'utf-8' : 'latin1');
        if (csize === LIMIT_32 || usize === LIMIT_32 || offset === LIMIT_32) throw new ZipFormatError('ZIP64 archives are not supported');
        entries.push({ name, method, flags, crc, csize, usize, offset });
        p += 46 + nameLen + extraLen + commentLen;
      }
      return new ZipReader(fh, size, entries);
    } catch (err) {
      await fh.close().catch(() => {});
      throw err;
    }
  }

  find(name: string): ZipEntry | undefined {
    return this.entries.find((e) => e.name === name);
  }

  /** Inflated, size- and CRC-checked content of one entry (at most `maxBytes`). */
  async read(entry: ZipEntry, maxBytes: number): Promise<Buffer> {
    if (entry.flags & 0x0001) throw new ZipFormatError(`encrypted entry: ${entry.name}`);
    if (entry.usize > maxBytes || entry.csize > maxBytes * 2 + 1024) throw new ZipFormatError(`entry too large: ${entry.name}`);
    const lh = Buffer.alloc(30);
    await this.fh.read(lh, 0, 30, entry.offset);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new ZipFormatError(`corrupt entry header: ${entry.name}`);
    const start = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (start + entry.csize > this.size) throw new ZipFormatError(`truncated entry: ${entry.name}`);
    const raw = Buffer.alloc(entry.csize);
    if (entry.csize) await this.fh.read(raw, 0, entry.csize, start);
    let data: Buffer;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try {
        data = await inflateRaw(raw, { maxOutputLength: maxBytes + 1 });
      } catch {
        throw new ZipFormatError(`entry could not be decompressed: ${entry.name}`);
      }
    } else throw new ZipFormatError(`unsupported compression in ${entry.name}`);
    if (data.length !== entry.usize) throw new ZipFormatError(`size mismatch in ${entry.name}`);
    if (crc32(data) !== entry.crc) throw new ZipFormatError(`checksum mismatch in ${entry.name}`);
    return data;
  }

  async close() {
    await this.fh.close().catch(() => {});
  }
}

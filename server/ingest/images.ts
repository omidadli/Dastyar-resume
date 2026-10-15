/**
 * Image conversion for multimodal AI input (pure JS — no native modules).
 *
 * Gemini reads PNG / JPEG / WebP / HEIC; OpenAI-compatible gateways read
 * PNG / JPEG / WebP / GIF. Everything else a candidate might send — BMP,
 * multi-page TIFF fax scans, animated GIF, HEIC for gateways — is decoded
 * here, downscaled to a size models read well and re-encoded as JPEG.
 */
import type { AiFile } from '../ai/provider';

export interface Rgba {
  data: Uint8Array | Uint8ClampedArray | Buffer;
  width: number;
  height: number;
}

/** Long side the models read comfortably (text stays legible, payload small). */
const MAX_SIDE = 2200;
const MAX_PIXELS = 80_000_000;

async function lib<T = any>(name: string): Promise<T> {
  const mod: any = await import(name);
  return (mod.default && typeof mod.default === 'object') || typeof mod.default === 'function' ? mod.default : mod;
}

/** Area-average downscale (keeps thin text strokes readable). */
export function downscale(img: Rgba, maxSide = MAX_SIDE): Rgba {
  const { width: w, height: h, data } = img;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Uint8Array(nw * nh * 4);
  const xr = w / nw;
  const yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor(y * yr);
    const sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor(x * xr);
      const sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((x + 1) * xr)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let i = (sy * w + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, i += 4) {
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { data: out, width: nw, height: nh };
}

export async function rgbaToJpeg(img: Rgba, quality = 84): Promise<Buffer> {
  const jpeg = await lib('jpeg-js');
  const small = downscale(img);
  const d = small.data;
  const flat = Buffer.alloc(small.width * small.height * 4);
  for (let i = 0; i < flat.length; i += 4) {
    // Transparent pixels → white paper (scans and exported resumes are on white).
    const a = d[i + 3] / 255;
    flat[i] = d[i] * a + 255 * (1 - a);
    flat[i + 1] = d[i + 1] * a + 255 * (1 - a);
    flat[i + 2] = d[i + 2] * a + 255 * (1 - a);
    flat[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: flat, width: small.width, height: small.height }, quality).data);
}

// ------------------------------------------------------------------ BMP ----

/** BMP (1/4/8-bit palette, 16/24/32-bit, BI_RGB / BI_BITFIELDS). */
export function decodeBmp(buf: Buffer): Rgba {
  if (buf.length < 26 || buf.toString('latin1', 0, 2) !== 'BM') throw new Error('not a BMP');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  let width: number;
  let height: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  if (headerSize === 12) {
    width = buf.readUInt16LE(18);
    height = buf.readInt16LE(20);
    bpp = buf.readUInt16LE(24);
  } else {
    width = buf.readInt32LE(18);
    height = buf.readInt32LE(22);
    bpp = buf.readUInt16LE(28);
    compression = buf.readUInt32LE(30);
    colorsUsed = buf.readUInt32LE(46);
  }
  const topDown = height < 0;
  height = Math.abs(height);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) throw new Error('BMP size not supported');
  if (compression !== 0 && compression !== 3) throw new Error('compressed BMP not supported');
  const palette: number[][] = [];
  if (bpp <= 8) {
    const n = colorsUsed || 1 << bpp;
    const start = 14 + headerSize;
    const step = headerSize === 12 ? 3 : 4;
    for (let i = 0; i < n; i++) {
      const p = start + i * step;
      palette.push([buf[p + 2] ?? 0, buf[p + 1] ?? 0, buf[p] ?? 0]);
    }
  }
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f] : [0x00ff0000, 0x0000ff00, 0x000000ff];
  if (compression === 3 && buf.length >= 66) masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62)];
  const shift = (m: number) => {
    let s = 0;
    while (m && !(m & 1)) {
      m >>>= 1;
      s++;
    }
    return s;
  };
  const shifts = masks.map(shift);
  const maxes = masks.map((m, i) => (m >>> shifts[i]) || 1);
  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + rowSize * height > buf.length + rowSize) throw new Error('truncated BMP');
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      if (bpp === 24) {
        const p = row + x * 3;
        b = buf[p] ?? 0;
        g = buf[p + 1] ?? 0;
        r = buf[p + 2] ?? 0;
      } else if (bpp === 32 || bpp === 16) {
        const p = row + x * (bpp / 8);
        if (p + bpp / 8 > buf.length) break;
        const v = bpp === 32 ? buf.readUInt32LE(p) : buf.readUInt16LE(p);
        [r, g, b] = masks.map((m, i) => Math.round((((v & m) >>> shifts[i]) * 255) / maxes[i]));
      } else {
        const bit = x * bpp;
        const byte = buf[row + (bit >> 3)] ?? 0;
        const idx = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] || [0, 0, 0];
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { data: out, width, height };
}

// ---------------------------------------------------------- GIF / TIFF ----

export async function decodeGifFirstFrame(buf: Buffer): Promise<Rgba> {
  const { GifReader } = await lib<any>('omggif');
  const reader = new GifReader(new Uint8Array(buf));
  if (reader.width * reader.height > MAX_PIXELS) throw new Error('GIF too large');
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { data, width: reader.width, height: reader.height };
}

/** Pages of a (multi-page) TIFF — CCITT fax, LZW, Deflate, PackBits, JPEG. */
export async function decodeTiffPages(buf: Buffer, maxPages = 5): Promise<Rgba[]> {
  const UTIF = await lib<any>('utif2');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const ifds: any[] = UTIF.decode(ab);
  const pages: Rgba[] = [];
  for (const ifd of ifds) {
    if (pages.length >= maxPages) break;
    const w = ifd.t256?.[0];
    const h = ifd.t257?.[0];
    if (!w || !h || w * h > MAX_PIXELS) continue;
    // Skip reduced-resolution thumbnails (NewSubfileType bit 0).
    if (ifd.t254 && ifd.t254[0] & 1) continue;
    UTIF.decodeImage(ab, ifd);
    const rgba: Uint8Array = UTIF.toRGBA8(ifd);
    if (rgba?.length) pages.push({ data: rgba, width: ifd.width || w, height: ifd.height || h });
  }
  return pages;
}

export async function heicToJpeg(buf: Buffer): Promise<Buffer> {
  const decode = await lib<any>('heic-decode');
  const img = await decode({ buffer: buf });
  return rgbaToJpeg({ data: img.data, width: img.width, height: img.height });
}

// --------------------------------------------------------------- entry ----

const NATIVE = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif']);
const BIG_IMAGE = 12 * 1024 * 1024;

/**
 * Turns any supported image into AI-readable attachments. Returns null for
 * formats the server cannot decode (AVIF, ICO, JPEG 2000, PSD…) — the
 * browser converts most of those before upload.
 */
export async function imageToAiFiles(buf: Buffer, mime: string, fileName = 'image'): Promise<AiFile[] | null> {
  const asJpeg = async (img: Rgba, suffix = ''): Promise<AiFile> => ({
    mimeType: 'image/jpeg',
    base64: (await rgbaToJpeg(img)).toString('base64'),
    fileName: `${fileName}${suffix}.jpg`,
  });
  if (NATIVE.has(mime)) {
    if (mime === 'image/jpeg' && buf.length > BIG_IMAGE) {
      // Huge phone photos: decode, downscale, re-encode.
      try {
        const jpeg = await lib('jpeg-js');
        const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 120 });
        return [await asJpeg(img)];
      } catch {
        /* send as is */
      }
    }
    return [{ mimeType: mime, base64: buf.toString('base64'), fileName }];
  }
  if (mime === 'image/gif') return [await asJpeg(await decodeGifFirstFrame(buf))];
  if (mime === 'image/bmp') return [await asJpeg(decodeBmp(buf))];
  if (mime === 'image/tiff') {
    const pages = await decodeTiffPages(buf);
    if (!pages.length) return null;
    return Promise.all(pages.map((p, i) => asJpeg(p, pages.length > 1 ? `-p${i + 1}` : '')));
  }
  return null;
}

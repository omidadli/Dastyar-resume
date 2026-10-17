/**
 * Minimal MIME parser for resumes that arrive as e-mails (.eml) or saved web
 * pages (.mht/.mhtml): text and HTML bodies plus attachments (which are then
 * ingested recursively — the real resume is usually the attached PDF/DOCX).
 * Handles nested multiparts, base64, quoted-printable, RFC 2047 encoded
 * words and RFC 2231 file names, and legacy charsets such as Windows-1256.
 */

export interface MimeAttachment {
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface ParsedMime {
  subject: string;
  from: string;
  date: string;
  text: string;
  html: string;
  attachments: MimeAttachment[];
}

function decodeCharset(bytes: Buffer, charset: string): string {
  const cs = (charset || 'utf-8').trim().toLowerCase().replace(/^cp-?(\d+)$/, 'windows-$1');
  try {
    return new TextDecoder(cs).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

function qpDecode(s: string): Buffer {
  const src = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '=' && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(src.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** =?utf-8?B?…?= / =?windows-1256?Q?…?= */
export function decodeWords(s: string): string {
  return s
    .replace(/(=\?[^?]+\?[bqBQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : qpDecode(data.replace(/_/g, ' '));
      return decodeCharset(bytes, charset);
    });
}

function headerParam(value: string, name: string): string | null {
  // RFC 2231 continuation / extended value: name*0*=utf-8''%D8%B1… name*1*=…
  const ext = Array.from(value.matchAll(new RegExp(`${name}\\*(\\d+)?\\*?=("([^"]*)"|[^;\\s]+)`, 'gi')));
  if (ext.length) {
    const joined = ext
      .sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
      .map((m) => (m[3] !== undefined ? m[3] : m[2]))
      .join('');
    const m = joined.match(/^([^']*)'[^']*'(.*)$/);
    if (m) {
      try {
        return decodeCharset(Buffer.from(m[2].replace(/%([0-9A-Fa-f]{2})/g, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'), m[1] || 'utf-8');
      } catch {
        return m[2];
      }
    }
    return joined;
  }
  const plain = value.match(new RegExp(`(?:^|;)\\s*${name}=(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return plain ? decodeWords(plain[1] ?? plain[2]) : null;
}

function splitHeaders(buf: Buffer): { headers: Map<string, string>; body: Buffer } {
  const s = buf.toString('latin1');
  const m = s.match(/\r?\n\r?\n/);
  const idx = m?.index ?? s.length;
  const sep = m ? m[0].length : 0;
  const headers = new Map<string, string>();
  for (const line of s.slice(0, idx).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const h = line.match(/^([\w-]+):\s*(.*)$/);
    if (!h) continue;
    const key = h[1].toLowerCase();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${h[2]}` : h[2]);
  }
  return { headers, body: buf.subarray(idx + sep) };
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const s = body.toString('latin1');
  const delim = `--${boundary}`;
  const parts: Buffer[] = [];
  let pos = s.indexOf(delim);
  while (pos >= 0) {
    const lineEnd = s.indexOf('\n', pos);
    if (lineEnd < 0) break;
    const next = s.indexOf(delim, lineEnd + 1);
    if (next < 0) {
      parts.push(body.subarray(lineEnd + 1)); // unterminated last part
      break;
    }
    let end = next;
    if (s[end - 1] === '\n') end--;
    if (s[end - 1] === '\r') end--;
    parts.push(body.subarray(lineEnd + 1, end));
    if (s.startsWith(`${delim}--`, next)) break;
    pos = next;
  }
  return parts;
}

function decodeBody(body: Buffer, encoding: string): Buffer {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpDecode(body.toString('latin1'));
  return body;
}

function walk(buf: Buffer, out: ParsedMime, depth: number) {
  const { headers, body } = splitHeaders(buf);
  if (depth === 0) {
    out.subject = decodeWords(headers.get('subject') || '');
    out.from = decodeWords(headers.get('from') || '');
    out.date = headers.get('date') || '';
  }
  const ctype = headers.get('content-type') || 'text/plain';
  const mime = ctype.split(';')[0].trim().toLowerCase();
  const encoding = headers.get('content-transfer-encoding') || '';
  if (mime.startsWith('multipart/') && depth < 10) {
    const boundary = headerParam(ctype, 'boundary');
    if (boundary) for (const part of splitMultipart(body, boundary)) walk(part, out, depth + 1);
    return;
  }
  const data = decodeBody(body, encoding);
  if (mime === 'message/rfc822' && depth < 10) {
    walk(data, out, depth + 1);
    return;
  }
  const disposition = headers.get('content-disposition') || '';
  const fileName = headerParam(disposition, 'filename') || headerParam(ctype, 'name') || '';
  const isBody = (mime === 'text/plain' || mime === 'text/html') && !/attachment/i.test(disposition);
  if (isBody) {
    const text = decodeCharset(data, headerParam(ctype, 'charset') || 'utf-8');
    if (mime === 'text/plain') out.text += (out.text ? '\n' : '') + text;
    else out.html += text;
    return;
  }
  if (!data.length) return;
  out.attachments.push({ fileName: fileName || `attachment.${mime.split('/')[1] || 'bin'}`, contentType: mime, data });
}

export function parseMime(buf: Buffer): ParsedMime {
  const out: ParsedMime = { subject: '', from: '', date: '', text: '', html: '', attachments: [] };
  walk(buf, out, 0);
  return out;
}

/** Heuristic: does this text start with RFC 822 headers? */
export function looksLikeEmail(head: string): boolean {
  const lines = head.split(/\r?\n/).slice(0, 40);
  const known = lines.filter((l) => /^(Received|From|To|Subject|Date|Message-ID|MIME-Version|Return-Path|Delivered-To|Content-Type|X-[\w-]+):/i.test(l)).length;
  return known >= 3;
}

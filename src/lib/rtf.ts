/**
 * Minimal RTF → text: Unicode escapes (\uN?), code-page escapes (\'hh, Persian
 * Word uses cp1256), paragraph breaks; skips font/colour tables and other
 * destinations. Enough for resumes; formatting is irrelevant here.
 */
export function rtfToText(rtf: string): string {
  const cpMatch = rtf.match(/\\ansicpg(\d+)/);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(cpMatch ? `windows-${cpMatch[1]}` : 'windows-1256');
  } catch {
    decoder = new TextDecoder('windows-1252');
  }
  const out: string[] = [];
  const stack: Array<{ skip: boolean; uc: number }> = [];
  let skip = false;
  let uc = 1; // chars to skip after a \uN escape
  let pendingSkip = 0;
  let bytes: number[] = [];
  const flushBytes = () => {
    if (bytes.length) {
      out.push(decoder.decode(new Uint8Array(bytes)));
      bytes = [];
    }
  };
  const emit = (t: string) => {
    if (skip) return;
    flushBytes();
    out.push(t);
  };
  const DESTINATIONS = /^(fonttbl|colortbl|stylesheet|info|pict|object|header|footer|headerl|headerr|footerl|footerr|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|datastore|latentstyles|pgdsctbl)$/;
  for (let i = 0; i < rtf.length; i++) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push({ skip, uc });
      continue;
    }
    if (ch === '}') {
      flushBytes();
      const prev = stack.pop();
      if (prev) ({ skip, uc } = prev);
      continue;
    }
    if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        if (pendingSkip > 0) pendingSkip--;
        else emit(next);
        i++;
        continue;
      }
      if (next === "'") {
        const hex = rtf.substr(i + 2, 2);
        i += 3;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        if (!skip && /^[0-9a-fA-F]{2}$/.test(hex)) bytes.push(parseInt(hex, 16));
        continue;
      }
      if (next === '*') {
        skip = true;
        i++;
        continue;
      }
      const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      const word = m[1];
      const arg = m[2] !== undefined ? Number(m[2]) : null;
      if (DESTINATIONS.test(word)) skip = true;
      else if (word === 'uc' && arg !== null) uc = arg;
      else if (word === 'u' && arg !== null) {
        emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        pendingSkip = uc;
      } else if (word === 'par' || word === 'line' || word === 'row') emit('\n');
      else if (word === 'tab' || word === 'cell') emit(' ');
      continue;
    }
    if (ch === '\r' || ch === '\n') continue;
    if (pendingSkip > 0) {
      pendingSkip--;
      continue;
    }
    if (!skip) {
      flushBytes();
      out.push(ch);
    }
  }
  flushBytes();
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

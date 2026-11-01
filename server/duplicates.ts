import crypto from 'crypto';
import type { ResumeRecord } from '../src/types/screening';

const digits = (s: string) => s.replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 1632));
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function resumeFileHash(base64?: string): string | undefined {
  return base64 ? crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') : undefined;
}

/** Strong signals only: a name or filename alone never identifies a candidate. */
function keys(r: ResumeRecord): Array<[string, NonNullable<ResumeRecord['duplicateOf']>['reason']]> {
  const out: ReturnType<typeof keys> = [];
  if (r.fileHash) out.push([`file:${r.fileHash}`, 'file']);
  const text = digits(r.extractedText || '').normalize('NFKC').toLowerCase().replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/[\s\u200c\u200d\u200e\u200f]+/g, '');
  if (text.length >= 100) out.push([`text:${hash(text)}`, 'text']);
  const email = r.contact?.email?.trim().toLowerCase();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.push([`email:${email}`, 'email']);
  let phone = digits(r.contact?.phone || '').replace(/\D/g, '');
  if (phone.startsWith('0098')) phone = `0${phone.slice(4)}`;
  else if (phone.startsWith('98') && phone.length === 12) phone = `0${phone.slice(2)}`;
  else if (phone.length === 10 && phone.startsWith('9')) phone = `0${phone}`;
  if (phone.length >= 10 && phone.length <= 15 && !/^(\d)\1+$/.test(phone)) out.push([`phone:${phone}`, 'phone']);
  return out;
}

type Signal = [string, NonNullable<ResumeRecord['duplicateOf']>['reason']];

// A batch upload re-scans its whole department for every new file: hashing the
// same 20k-character text again for each of them would be wasteful, so the
// signals are memoised until the identifying fields of a record change.
const keyCache = new WeakMap<ResumeRecord, { sig: string; signals: Signal[] }>();

function signalsFor(r: ResumeRecord): Signal[] {
  const sig = [
    r.fileHash || '',
    (r.extractedText || '').length,
    r.contact?.email || '',
    r.contact?.phone || '',
    r.updatedAtISO || '',
  ].join('\u0000');
  const hit = keyCache.get(r);
  if (hit && hit.sig === sig) return hit.signals;
  const signals = keys(r);
  keyCache.set(r, { sig, signals });
  return signals;
}

/** Rebuild also upgrades historical snapshots without requiring another AI call.
 * Map insertion order breaks timestamp ties deterministically (parallel uploads).
 * Each organization/department has a completely separate signal index.
 */
export function refreshDuplicates(records: Iterable<ResumeRecord>) {
  const scopes = new Map<string, Map<string, ResumeRecord>>();
  for (const r of [...records].sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO))) {
    r.duplicateOf = null;
    const signals = signalsFor(r);
    r.novelty = signals.length ? 'new' : 'unknown';
    if (!r.orgId) continue;
    const scope = JSON.stringify([r.orgId, r.departmentId]);
    let index = scopes.get(scope);
    if (!index) scopes.set(scope, index = new Map());
    for (const [key, reason] of signals) {
      const prior = index.get(key);
      if (prior) {
        r.novelty = 'duplicate';
        r.duplicateOf = { resumeId: prior.id, jobId: prior.jobId, roleTitle: prior.roleTitle, createdAtISO: prior.createdAtISO, reason };
        break;
      }
    }
    for (const [key] of signals) if (!index.has(key)) index.set(key, r);
  }
}

/**
 * «غربالگری بی‌طرف» — blind screening.
 *
 * When the workspace turns it on, every screening view receives a *redacted*
 * copy of the candidate: no name, no e-mail, no phone, no file name, no links,
 * and the quoted evidence is masked where it mentions those things. The record
 * on disk is untouched; the decision, the score and the pipeline keep working,
 * because they are keyed by `resumeId`, not by the person.
 *
 * The redaction happens on the server, not in the browser: a hidden field that
 * still travels in the JSON is not hidden at all — anyone can open the network
 * tab. For the same reason the original PDF is not downloadable while blind
 * mode is on, and the actions that *contact* the candidate (e-mail, SMS,
 * interview, offer, survey) answer `409 BLIND_REVEAL_REQUIRED` until someone
 * explicitly reveals the identity — and every reveal is written to the
 * workspace history.
 */
import crypto from 'crypto';
import type { ResumeListItem, ResumeRecord } from '../src/types/screening';
import type { OrgPublic } from '../src/types/app';
import { toPersianDigits } from '../src/utils/jalali';

export const BLIND_MESSAGE =
  'غربالگری بی‌طرف روشن است. برای دیدن هویت یا تماس با این کارجو، اول هویت را آشکار کنید؛ همین کار در تاریخچه ثبت می‌شود.';

/**
 * Answers `409 BLIND_REVEAL_REQUIRED` and returns true when a contact action
 * must wait for a reveal. One line in each route that reaches a candidate.
 */
export function blockedByBlind(org: OrgPublic | null | undefined, res: any): boolean {
  if (!blindOn(org)) return false;
  res.status(409).json({ error: BLIND_MESSAGE, code: 'BLIND_REVEAL_REQUIRED' });
  return true;
}

/** Is blind screening on for this workspace? */
export function blindOn(org: OrgPublic | null | undefined): boolean {
  return Boolean(org?.blindScreening);
}

/** Stable, non-identifying label: «کارجوی ۲۴۸۱» — same candidate, same number. */
export function blindLabel(resumeId: string): string {
  const digest = crypto.createHash('sha256').update(`blind|${resumeId}`).digest();
  const n = ((digest[0] << 8) | digest[1]) % 9000 + 1000;
  return `کارجوی ${toPersianDigits(n)}`;
}

const NAME_MASK = '«نام»';
const EMAIL_MASK = '«ایمیل»';
const PHONE_MASK = '«تلفن»';
const LINK_MASK = '«پیوند»';

/**
 * Masks the identity markers that leak into free text: the AI quotes a line of
 * the résumé, and that line often starts with the person's own name.
 */
export function maskText(text: string | null | undefined, names: string[] = []): string {
  if (!text) return '';
  let out = text;
  // Links first (a LinkedIn URL contains the name), then e-mail, then phone.
  out = out.replace(/(?:https?:\/\/|www\.)[^\s،؛،)"'<>]+/gi, LINK_MASK);
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, EMAIL_MASK);
  // Phones are written in Persian digits as often as in Latin ones.
  const D = '[0-9\u06F0-\u06F9\u0660-\u0669]';
  out = out.replace(new RegExp(`(?:\\+?98|0)?[\\s-]?${D}{2}[\\s-]?${D}{3}[\\s-]?${D}{4}(?!${D})`, 'g'), PHONE_MASK);
  out = out.replace(new RegExp(`(?:\\+?98|0)${D}{2}[\\s-]?${D}{3,4}[\\s-]?${D}{4}(?!${D})`, 'g'), PHONE_MASK);
  // The name, one token at a time: «مینا رضایی» hides both halves.
  const tokens = new Set<string>();
  for (const name of names) {
    for (const token of String(name || '').split(/[\s,،.·()\-_/]+/)) {
      const t = token.trim();
      if (t.length >= 3) tokens.add(t);
    }
  }
  for (const token of Array.from(tokens).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}])${escapeRe(token)}(?![\\p{L}])`, 'gu'), NAME_MASK);
  }
  // «رضایی مینا» twice in a row reads as one «نام», not a stutter of placeholders.
  out = out.replace(/«نام»(?:[\s،]+«نام»)+/g, '«نام»');
  out = out.replace(/««نام»»/g, '«نام»');
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every name this workspace has seen — used to mask the activity feed too. */
export function knownNames(list: Array<{ candidateName: string | null }>): string[] {
  return list.map((r) => r.candidateName || '').filter((n) => n.trim().length >= 3);
}

function fileExtOf(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,6})$/.exec(fileName || '');
  return m ? m[1] : 'pdf';
}

function maskEvidence(list: ResumeRecord['strengths'], names: string[]) {
  return list.map((p) => ({ ...p, point: maskText(p.point, names), evidence: maskText(p.evidence, names) }));
}

/**
 * The redacted view of one candidate. Everything that identifies the person is
 * replaced; everything the reviewer needs to judge the work — score, criteria,
 * evidence, years, skills — stays.
 */
export function redactRecord<T extends Partial<ResumeRecord> & { id: string }>(rec: T): T {
  const label = blindLabel(rec.id);
  const names = [rec.candidateName || ''];
  const ext = fileExtOf(rec.fileName || '');
  return {
    ...rec,
    candidateName: label,
    fileName: `${label}.${ext}`,
    filePath: null,
    fileHash: null,
    contact: { phone: null, email: null, city: rec.contact?.city ?? null },
    source: rec.source
      ? { ...rec.source, profileUrl: '', headline: maskText(rec.source.headline, names) }
      : rec.source,
    // The list shape has no resume text at all; do not add an empty one.
    ...('extractedText' in rec ? { extractedText: maskText(rec.extractedText, names) } : {}),
    summary: maskText(rec.summary, names),
    whyCategory: maskText(rec.whyCategory, names),
    knockoutMisses: (rec.knockoutMisses || []).map((m) => maskText(m, names)),
    strengths: maskEvidence(rec.strengths || [], names),
    weaknesses: maskEvidence(rec.weaknesses || [], names),
    criterionScores: (rec.criterionScores || []).map((c) => ({
      ...c,
      rationale: maskText(c.rationale, names),
      evidence: maskText(c.evidence, names),
    })),
    deepFindings: rec.deepFindings
      ? {
          focusPoints: rec.deepFindings.focusPoints.map((t) => maskText(t, names)),
          interviewQuestions: rec.deepFindings.interviewQuestions.map((t) => maskText(t, names)),
          risks: rec.deepFindings.risks.map((t) => maskText(t, names)),
        }
      : rec.deepFindings,
    bankNote: rec.bankNote ? maskText(rec.bankNote, names) : rec.bankNote,
    decisionNote: rec.decisionNote ? maskText(rec.decisionNote, names) : rec.decisionNote,
    unjudgeableReason: rec.unjudgeableReason ? maskText(rec.unjudgeableReason, names) : rec.unjudgeableReason,
    errorMessage: rec.errorMessage ? maskText(rec.errorMessage, names) : rec.errorMessage,
    blindHidden: true,
  } as T;
}

/** Same, for the lightweight list shape the tables and the dashboard use. */
export function redactListItem<T extends ResumeListItem>(item: T): T {
  return redactRecord(item);
}

export function redactList<T extends ResumeListItem>(items: T[]): T[] {
  return items.map(redactListItem);
}

/** Activity messages («… را تأیید کرد») must not name the person either. */
export function maskActivity<T extends { text: string }>(items: T[], names: string[]): T[] {
  return items.map((a) => ({ ...a, text: maskText(a.text, names) }));
}

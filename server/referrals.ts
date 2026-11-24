/**
 * «معرفی همکار» — the referral program behind the public career portal.
 *
 * Why it lives in its own module: a referral touches three parts of the product
 * that otherwise never meet — a colleague's share link, the public application,
 * and the money HR has to approve. Keeping the rules here means the portal only
 * calls `recordReferral`, the pipeline/offer code only calls `markOutcome`, and
 * the payout rules stay in one readable place.
 *
 * Honesty rules kept on purpose:
 *   • a referral link is worthless unless the program is on and the code really
 *     belongs to a member of *this* workspace;
 *   • a reward is never «paid» by the machine — HR approves, then HR pays;
 *   • a rejected candidate never leaves a pending reward behind.
 */
import crypto from 'crypto';
import * as db from './db';
import { appSecret } from './secret';
import { formatJalaliDate, toPersianDigits } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { MemberReferralLink, ReferralRow, ReferralSummary, ReferralsPayload } from '../src/types/referrals';

const REFERRAL_SALT = 'hovida-referral-code-v1';

/**
 * A member's share code. Deterministic (the same link keeps working across
 * restarts and machines) and not guessable from the user id alone, because it
 * is an HMAC of the id with the installation's own secret.
 */
export function memberCode(userId: string): string {
  // Hex, not base64: a code ends up in a URL, a spreadsheet and a chat message,
  // so it must survive every one of them without `-`/`_` confusion.
  const digest = crypto.createHmac('sha256', appSecret()).update(`${REFERRAL_SALT}:${userId}`).digest('hex');
  return `r${digest.slice(0, 10)}`;
}

export interface ReferralMember {
  id: string;
  name: string;
  email: string | null;
}

/** The member behind a code — only inside the workspace the portal belongs to. */
export function memberByCode(orgId: string, code: string): ReferralMember | null {
  const clean = String(code || '').trim().toLowerCase();
  if (!/^r[a-z0-9]{6,16}$/.test(clean)) return null;
  for (const m of db.listMembers(orgId)) {
    if (memberCode(m.id) === clean) return { id: m.id, name: m.name, email: m.email ?? null };
  }
  return null;
}

function stampJalali(at: Date): string {
  return formatJalaliDate(tehranJalaliOf(at), true);
}

/**
 * A public application arrived with `ref=<code>`. Only a real member code of an
 * enabled program becomes a tracked referral; anything else is ignored (the
 * candidate's own «چطور با ما آشنا شدید؟» answer is still kept on the record).
 */
export function recordReferral(args: {
  orgId: string;
  jobId: string;
  jobTitle: string;
  resumeId: string;
  candidateName: string;
  code: string;
  heardFrom: string | null;
}): ReferralRow | null {
  const program = db.getReferralProgram(args.orgId);
  if (!program.enabled) return null;
  const member = memberByCode(args.orgId, args.code);
  if (!member && program.membersOnly) return null;
  const at = new Date();
  const row: ReferralRow = {
    id: db.uid('ref'),
    orgId: args.orgId,
    jobId: args.jobId,
    jobTitle: args.jobTitle,
    resumeId: args.resumeId,
    candidateName: args.candidateName,
    referrerUserId: member?.id ?? null,
    referrerName: member?.name ?? String(args.code || '').slice(0, 40),
    code: member ? memberCode(member.id) : String(args.code || '').slice(0, 40),
    outcome: 'submitted',
    rewardAmount: program.rewardAmount,
    rewardStatus: 'none',
    submittedAtISO: at.toISOString(),
    submittedAtJalali: stampJalali(at),
    decidedAtISO: null,
    decidedAtJalali: null,
    decidedByName: null,
    paidAtISO: null,
    paidAtJalali: null,
    paidByName: null,
    heardFrom: args.heardFrom,
    note: '',
  };
  db.saveReferral(row);
  return row;
}

/**
 * The funnel moved: a referred candidate was hired (or rejected / closed).
 * `offer` and `probation` triggers are recorded as the program asked, but the
 * reward still only becomes «در انتظار تأیید» at the moment the program says.
 */
export function markOutcome(
  orgId: string,
  resumeId: string,
  outcome: 'hired' | 'rejected' | 'closed',
  actor: { id: string; name: string } | null
): ReferralRow | null {
  const row = db.findReferralByResume(orgId, resumeId);
  if (!row || row.outcome === outcome) return row;
  const at = new Date();
  const next: ReferralRow = {
    ...row,
    outcome,
    decidedAtISO: at.toISOString(),
    decidedAtJalali: stampJalali(at),
    decidedByName: actor?.name ?? 'سیستم',
  };
  if (outcome === 'hired') {
    const program = db.getReferralProgram(orgId);
    // `hire` → owed now; `offer`/`probation` have their own moments below.
    if (program.trigger === 'hire' && row.rewardAmount > 0 && row.rewardStatus === 'none') next.rewardStatus = 'pending';
  } else if (next.rewardStatus === 'pending' || next.rewardStatus === 'approved') {
    // Nobody is paid for a candidate who was not hired after all.
    next.rewardStatus = 'void';
  }
  return db.saveReferral(next);
}

/**
 * A referred candidate reached the offer column / accepted an offer. Only the
 * `offer` trigger reacts here; for `hire` this is just a nice signal in the log.
 */
export function markOfferReached(orgId: string, resumeId: string): ReferralRow | null {
  const row = db.findReferralByResume(orgId, resumeId);
  if (!row) return null;
  const program = db.getReferralProgram(orgId);
  if (program.trigger !== 'offer' || row.rewardAmount <= 0 || row.rewardStatus !== 'none') return row;
  return db.saveReferral({ ...row, rewardStatus: 'pending' });
}

/**
 * «دورهٔ آزمایشی تمام شد» — the `probation` trigger is deliberately manual:
 * only a person knows the person stayed. No status is invented automatically.
 */
export function confirmProbation(orgId: string, id: string, actor: { name: string }): ReferralRow | null {
  const row = db.getReferral(orgId, id);
  if (!row || row.outcome !== 'hired' || row.rewardStatus !== 'none' || row.rewardAmount <= 0) return null;
  if (db.getReferralProgram(orgId).trigger !== 'probation') return null;
  return db.saveReferral({ ...row, rewardStatus: 'pending', decidedByName: actor.name });
}

/** HR confirms the payout (pending → approved). */
export function approveReward(orgId: string, id: string, actor: { name: string }, note: string): ReferralRow | null {
  const row = db.getReferral(orgId, id);
  if (!row || row.rewardStatus !== 'pending') return null;
  return db.saveReferral({
    ...row,
    rewardStatus: 'approved',
    decidedByName: actor.name,
    note: note.slice(0, 500),
  });
}

/** HR marks it as actually paid. Never automatic. */
export function payReward(orgId: string, id: string, actor: { name: string }): ReferralRow | null {
  const row = db.getReferral(orgId, id);
  if (!row || row.rewardStatus !== 'approved') return null;
  const at = new Date();
  const saved = db.saveReferral({
    ...row,
    rewardStatus: 'paid',
    paidAtISO: at.toISOString(),
    paidAtJalali: stampJalali(at),
    paidByName: actor.name,
  });
  // The money is now spend: writing it into «هزینهٔ هر استخدام» the same moment
  // keeps the per-hire cost honest without HR retyping the number.
  if (saved.rewardAmount > 0) {
    db.addCost(
      orgId,
      {
        kind: 'referral',
        amount: saved.rewardAmount,
        atISO: at.toISOString(),
        jobId: saved.jobId,
        jobTitle: saved.jobTitle,
        note: `پاداش معرفی به ${saved.referrerName} برای استخدام ${saved.candidateName}`,
      },
      actor.name
    );
  }
  return saved;
}

/** Cancels a reward that should not be paid (wrong person, left the company…). */
export function voidReward(orgId: string, id: string, note: string): ReferralRow | null {
  const row = db.getReferral(orgId, id);
  if (!row || row.rewardStatus === 'paid') return null;
  return db.saveReferral({ ...row, rewardStatus: 'void', note: note.slice(0, 500) });
}

export function summarize(items: ReferralRow[]): ReferralSummary {
  const sum = (status: ReferralRow['rewardStatus']) =>
    items.filter((r) => r.rewardStatus === status).reduce((n, r) => n + r.rewardAmount, 0);
  return {
    total: items.length,
    hired: items.filter((r) => r.outcome === 'hired').length,
    pending: items.filter((r) => r.rewardStatus === 'pending').length,
    approved: items.filter((r) => r.rewardStatus === 'approved').length,
    paid: items.filter((r) => r.rewardStatus === 'paid').length,
    pendingAmount: sum('pending'),
    approvedAmount: sum('approved'),
    paidAmount: sum('paid'),
  };
}

/** Everything the «معرفی همکار» page needs, in one read. */
export function referralsPayload(orgId: string, portalUrl: string): ReferralsPayload {
  const program = db.getReferralProgram(orgId);
  const items = db.listReferrals(orgId);
  const base = portalUrl.replace(/\/$/, '');
  const members: MemberReferralLink[] = db.listMembers(orgId).map((m) => {
    const code = memberCode(m.id);
    const mine = items.filter((r) => r.referrerUserId === m.id);
    const amount = (status: ReferralRow['rewardStatus']) =>
      mine.filter((r) => r.rewardStatus === status).reduce((n, r) => n + r.rewardAmount, 0);
    return {
      userId: m.id,
      name: m.name,
      email: m.email ?? null,
      code,
      link: `${base}?ref=${code}`,
      total: mine.length,
      hired: mine.filter((r) => r.outcome === 'hired').length,
      pendingAmount: amount('pending'),
      approvedAmount: amount('approved'),
      paidAmount: amount('paid'),
    };
  });
  return { program, items, members, summary: summarize(items), portalUrl: base };
}

/** «۱٫۵۰۰٫۰۰۰ تومان» — one phrasing for every place the amount is shown. */
export function formatToman(amount: number): string {
  return `${toPersianDigits(amount.toLocaleString('en-US'))} تومان`;
}

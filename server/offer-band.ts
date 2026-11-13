/**
 * «کنترل بازهٔ حقوق» — the offer is checked against the requisition that pays for
 * it, at the moment it is written, edited and sent.
 *
 * Why this exists: a requisition with a salary band that nobody checks is a
 * number in a drawer. The band is the approved envelope; an offer above it is a
 * decision someone has to own in writing. So:
 *
 *   • **above the ceiling is not silently allowed** — it needs a written reason,
 *     stored on the offer with the name of the person who gave it;
 *   • **below the floor is flagged, never blocked** — paying less is legal, and
 *     flagging it is useful («was this a typo?»);
 *   • **no band means no verdict** — the record says `no_band` instead of
 *     inventing a range;
 *   • **the check is re-run at send**, because the requisition may have been
 *     changed (or filled) between drafting and sending.
 */
import * as db from './db';
import type { OfferBandCheck, OfferBandStatus, OfferTerms } from '../src/types/offers';

export class BandError extends Error {
  status: number;
  code: string;
  band: OfferBandCheck | null;
  constructor(message: string, status: number, code: string, band: OfferBandCheck | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.band = band;
  }
}

/** The shortest sentence we accept as «someone owned this». */
export const MIN_OVERRIDE_REASON = 10;

/** Any period → monthly toman. Annual is /12, rounded. */
export function monthlyOf(terms: Pick<OfferTerms, 'salaryAmount' | 'salaryPeriod'>): number | null {
  if (terms.salaryAmount === null || terms.salaryAmount === undefined) return null;
  const amount = Number(terms.salaryAmount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return terms.salaryPeriod === 'annual' ? Math.round(amount / 12) : Math.round(amount);
}

function statusFor(offerMonthly: number | null, min: number | null, max: number | null): OfferBandStatus {
  if (min === null && max === null) return 'no_band';
  if (offerMonthly === null) return 'no_amount';
  if (max !== null && offerMonthly > max) return 'above';
  if (min !== null && offerMonthly < min) return 'below';
  return 'in';
}

/**
 * Build the check for one offer. Returns null when the opening has no requisition
 * at all (the common case for workspaces that never turned the module on).
 */
export function checkOffer(orgId: string, jobId: string, terms: OfferTerms, previous?: OfferBandCheck | null): OfferBandCheck | null {
  const req = db.requisitionOfJob(orgId, jobId);
  if (!req) return null;
  const offerMonthly = monthlyOf(terms);
  const status = statusFor(offerMonthly, req.salaryMin, req.salaryMax);
  // An override already written for this offer stays valid while the numbers stay
  // above the same ceiling; a new figure needs a new sentence.
  const stillAbove = status === 'above';
  const carry = stillAbove && previous && previous.status === 'above' && previous.maxMonthly === req.salaryMax ? previous : null;
  return {
    requisitionId: req.id,
    code: req.code,
    minMonthly: req.salaryMin,
    maxMonthly: req.salaryMax,
    offerMonthly,
    status,
    overrideReason: carry?.overrideReason ?? null,
    overriddenByName: carry?.overriddenByName ?? null,
    checkedAtISO: new Date().toISOString(),
  };
}

const money = (n: number) => n.toLocaleString('en-US');

/**
 * The gate used by create / edit / revise / send.
 *
 * `reason` is what HR typed. When the offer is above the ceiling and no reason is
 * given (and none is carried over), this throws a 409 that carries the numbers so
 * the dialog can ask for one instead of showing a dead end.
 */
export function enforceBand(
  orgId: string,
  jobId: string,
  terms: OfferTerms,
  input: { reason?: string; previous?: OfferBandCheck | null; actorName: string }
): OfferBandCheck | null {
  const check = checkOffer(orgId, jobId, terms, input.previous);
  if (!check) return null;
  if (check.status !== 'above') return check;
  const typed = String(input.reason || '').trim();
  const carried = check.overrideReason || '';
  const reason = typed || carried;
  if (reason.length < MIN_OVERRIDE_REASON) {
    throw new BandError(
      `این حقوق از سقف تأییدشدهٔ نیازمندسنجی «${check.code}» (${money(check.maxMonthly || 0)} تومان در ماه) بالاتر است. برای ادامه، دلیلش را بنویسید — همین جمله در پروندهٔ پیشنهاد می‌ماند.`,
      409,
      'OFFER_ABOVE_BAND',
      check
    );
  }
  return {
    ...check,
    overrideReason: reason.slice(0, 800),
    overriddenByName: typed ? input.actorName : check.overriddenByName,
  };
}

export function bandLabel(status: OfferBandStatus): string {
  switch (status) {
    case 'above':
      return 'بالاتر از سقف تأییدشده';
    case 'below':
      return 'پایین‌تر از کف تأییدشده';
    case 'in':
      return 'درون بازهٔ تأییدشده';
    case 'no_band':
      return 'نیازمندسنجی بازهٔ حقوق ندارد';
    default:
      return 'پیشنهاد عدد حقوق ندارد';
  }
}

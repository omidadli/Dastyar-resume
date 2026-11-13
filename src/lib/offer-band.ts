/**
 * Client-side helpers for the salary-band check shown next to an offer.
 * The verdict itself always comes from the server; nothing here decides anything.
 */
import type { OfferBandCheck } from '../types/offers';

export function bandLabel(status: OfferBandCheck['status']): string {
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

export function offerBandTone(status: OfferBandCheck['status']): 'brand' | 'warning' | 'neutral' {
  if (status === 'above') return 'warning';
  if (status === 'below') return 'neutral';
  if (status === 'in') return 'brand';
  return 'neutral';
}

export const money = (n: number | null | undefined) => (n == null ? '—' : `${n.toLocaleString('en-US')} تومان`);

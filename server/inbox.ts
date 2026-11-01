/**
 * «کارتابل تأیید» — the read side of «هیچ چیزی بدون تأیید انسان نمی‌رود».
 *
 * It collects the three queues that already exist elsewhere and answers two
 * questions per row: *who* is the decision waiting on, and *can I* make it.
 * Nothing is approved from here unless that action sends nothing to anyone —
 * an approval that mails a candidate belongs on the page that shows the letter.
 */
import * as db from './db';
import { blindOn, maskText } from './blind';
import { visibleJobIds, type Viewer } from './job-access';
import { settingsFor } from './automation';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type { InboxItem, InboxView } from '../src/types/inbox';

function jalali(iso: string): string {
  return formatJalaliDate(tehranJalaliOf(new Date(iso)), true);
}

function isAdmin(user: db.UserRecord): boolean {
  return user.role === 'admin' || user.role === 'owner';
}

/**
 * Everything waiting, newest last. Job access is applied first: a recruiter
 * without access to a confidential opening must not even learn it is waiting.
 */
export function inboxFor(org: db.OrgRecord, user: db.UserRecord): InboxView {
  const allowed = visibleJobIds(org.id, user as unknown as Viewer);
  const canSeeJob = (jobId: string | null) => !allowed || !jobId || allowed.includes(jobId);
  const names = blindOn(org) ? db.listOrgResumes(org.id).map((r) => r.candidateName || '').filter(Boolean) : [];
  const hide = (text: string) => (names.length ? maskText(text, names) : text);

  const items: InboxItem[] = [];

  // ---------------------------------------------------------------- offers ---
  // A draft offer with an approval chain is waiting; the first pending step is
  // the person who decides. The offer itself does not leave until the last one.
  for (const offer of db.listOffers(org.id)) {
    if (offer.status !== 'draft') continue;
    if (!canSeeJob(offer.jobId)) continue;
    const step = (offer.approvals || []).find((a) => a.status === 'pending');
    if (!step) continue;
    const mine = step.approverId === user.id;
    items.push({
      id: `offer:${offer.id}`,
      kind: 'offer',
      title: `تأیید پیشنهاد شغلی — ${offer.terms.title || offer.jobTitle}`,
      detail: `مرحلهٔ «${step.label}»؛ تا تأیید نشود پیشنهاد برای کارجو فرستاده نمی‌شود.`,
      candidateName: hide(offer.candidateName),
      jobTitle: offer.jobTitle,
      jobId: offer.jobId,
      resumeId: offer.resumeId,
      waitingSinceISO: offer.createdAtISO,
      waitingSinceJalali: offer.createdAtJalali,
      waitingOn: mine ? 'شما' : step.approverName,
      mine,
      canAct: mine || isAdmin(user),
      blockedReason: mine || isAdmin(user) ? null : `این مرحله در اختیار «${step.approverName}» است.`,
      href: offer.resumeId ? `/app/candidates/${offer.resumeId}` : null,
    });
  }

  // ------------------------------------------------------------ automation ---
  // A proposal is a draft message or a booking; approving it is what sends it.
  const settings = settingsFor(org.id);
  if (settings.enabled) {
    for (const action of db.listAutomationActions(org.id, { status: 'pending', limit: 200 })) {
      if (!canSeeJob(action.jobId)) continue;
      const what =
        action.kind === 'invite'
          ? 'دعوت به مصاحبه'
          : action.kind === 'reject'
            ? 'نامهٔ نتیجه'
            : action.kind === 'schedule'
              ? 'زمان‌بندی مصاحبه'
              : 'درخواست اطلاعات';
      items.push({
        id: `automation:${action.id}`,
        kind: 'automation',
        title: `${what} — ${hide(action.candidateName)}`,
        detail: `«${action.reason || 'بدون دلیل ثبت‌شده'}» — تأیید، همین پیام را برای کارجو می‌فرستد.`,
        candidateName: hide(action.candidateName),
        jobTitle: action.jobTitle || null,
        jobId: action.jobId,
        resumeId: action.resumeId,
        waitingSinceISO: action.createdAtISO,
        waitingSinceJalali: action.createdAtJalali,
        waitingOn: 'هر عضو تیم',
        mine: true,
        canAct: true,
        // Approving here would send a letter the viewer has not read: the honest
        // place for that decision is the page that shows the wording.
        blockedReason: null,
        href: '/app/automation',
      });
    }
  }

  // -------------------------------------------------------------- referrals ---
  // A reward is owed once the trigger happened; paying it is a human decision.
  for (const row of db.listReferrals(org.id)) {
    if (row.rewardStatus !== 'pending') continue;
    if (!canSeeJob(row.jobId || null)) continue;
    items.push({
      id: `referral:${row.id}`,
      kind: 'referral',
      title: 'تأیید پاداش معرفی',
      detail: `«${hide(row.candidateName)}» استخدام شد؛ پاداش برای «${row.referrerName}» در انتظار تأیید است.`,
      candidateName: hide(row.candidateName),
      jobTitle: row.jobTitle || null,
      jobId: row.jobId || null,
      resumeId: row.resumeId || null,
      waitingSinceISO: row.submittedAtISO,
      waitingSinceJalali: row.submittedAtJalali,
      waitingOn: 'مدیر یا مالک',
      mine: isAdmin(user),
      canAct: isAdmin(user),
      blockedReason: isAdmin(user) ? null : 'تأیید پاداش فقط با مدیر یا مالک فضای کاری است.',
      href: `/app/settings/referrals`,
    });
  }

  // Mine first — that is the whole point of an inbox — then oldest first.
  items.sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return a.waitingSinceISO.localeCompare(b.waitingSinceISO);
  });

  const of = (kind: InboxItem['kind']) => items.filter((i) => i.kind === kind).length;
  return {
    items,
    counts: {
      total: items.length,
      mine: items.filter((i) => i.mine).length,
      offers: of('offer'),
      automation: of('automation'),
      referrals: of('referral'),
    },
    enabled: {
      offers: Boolean(org.offerApproval?.enabled),
      automation: settings.enabled,
      referrals: db.getReferralProgram(org.id).enabled,
    },
  };
}

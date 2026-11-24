/**
 * «انتشار در جاب‌بورد» — the honest half of multi-board posting.
 *
 * Global competitors push an opening to LinkedIn/Indeed with an API key. In Iran
 * that is not how it works: Jobinja, Jobvision, E-estekhdam, Quera and IranTalent
 * sell posting through a **contract with the company** (and an account a human
 * signs into). No public write API exists for us to call.
 *
 * So this module does what can be done truthfully:
 *   • it writes the ad copy once, in the shape each board asks for;
 *   • it keeps the canonical `JobPosting` JSON and the workspace's own public
 *     page as the source of truth;
 *   • it records where a human actually posted it — with the link and the date —
 *     so nobody wonders «did we put this on Jobinja?»;
 *   • and it says, in each board's row, what that board needs before you can.
 *
 * Automatic posting would need a partner contract per board; pretending
 * otherwise would be the exact thing this product refuses to do.
 */

export type JobBoardId = 'jobinja' | 'jobvision' | 'estekhdam' | 'quera' | 'irantalent' | 'other';

export interface JobBoardMeta {
  id: JobBoardId;
  label: string;
  host: string;
  /** What you need before you can post there — the honest sentence. */
  requires: string;
  /** How the copy is usually pasted. */
  format: 'form' | 'upload' | 'email';
}

export const JOB_BOARDS: JobBoardMeta[] = [
  {
    id: 'jobinja',
    label: 'جابینجا',
    host: 'jobinja.ir',
    requires: 'حساب کارفرما + قرارداد انتشار (B2B). رابط نوشتن عمومی ندارد.',
    format: 'form',
  },
  {
    id: 'jobvision',
    label: 'جاب‌ویژن',
    host: 'jobvision.ir',
    requires: 'پنل کارفرما + بستهٔ انتشار. رابط نوشتن عمومی ندارد.',
    format: 'form',
  },
  {
    id: 'estekhdam',
    label: 'ای‌استخدام',
    host: 'e-estekhdam.com',
    requires: 'حساب کارفرما + قرارداد. متن را در فرم می‌چسبانید.',
    format: 'form',
  },
  {
    id: 'quera',
    label: 'کوئرا',
    host: 'quera.org',
    requires: 'حساب کارفرما در کوئرا جاب. برای نقش‌های فنی مناسب‌تر است.',
    format: 'form',
  },
  {
    id: 'irantalent',
    label: 'ایران تلنت',
    host: 'irantalent.com',
    requires: 'حساب کارفرما + بستهٔ انتشار.',
    format: 'form',
  },
  {
    id: 'other',
    label: 'جای دیگر',
    host: '',
    requires: 'هر جایی که خودتان منتشر می‌کنید (لینکدین، تلگرام، سایت خودتان).',
    format: 'form',
  },
];

export const JOB_BOARD_LABEL: Record<JobBoardId, string> = Object.fromEntries(
  JOB_BOARDS.map((b) => [b.id, b.label])
) as Record<JobBoardId, string>;

export type PublicationStatus = 'submitted' | 'live' | 'expired' | 'removed';

export const PUBLICATION_STATUS_LABEL: Record<PublicationStatus, string> = {
  submitted: 'فرستاده شد — منتظر تأیید جاب‌بورد',
  live: 'منتشر شده',
  expired: 'مهلتش گذشته',
  removed: 'برداشته شد',
};

/** One human act of posting one opening on one board. */
export interface JobPublication {
  id: string;
  jobId: string;
  board: JobBoardId;
  status: PublicationStatus;
  /** The board's own link to the ad, when there is one. */
  url: string | null;
  note: string;
  postedAtISO: string;
  postedAtJalali: string;
  postedByName: string;
  /** Set when the status changed to removed/expired. */
  closedAtISO: string | null;
}

/** What the page shows: the boards, the ads, and the ready-to-paste copy. */
export interface PublicationsView {
  jobId: string;
  items: JobPublication[];
  boards: (JobBoardMeta & { count: number; live: boolean })[];
  /** The workspace's own public page — always the canonical link. */
  portalUrl: string | null;
  isPublic: boolean;
  /** True when the ad is worth posting at all (open, public, not expired). */
  readyToPost: boolean;
  counts: { total: number; live: number; removed: number };
}

/** The paste-ready ad for one board. Plain text on purpose: every board takes it. */
export interface PublicationKit {
  board: JobBoardId;
  boardLabel: string;
  title: string;
  text: string;
  /** schema.org JobPosting — for the workspace's own page and Google Jobs. */
  jsonLd: Record<string, unknown>;
  portalUrl: string | null;
  requires: string;
  /** Things the board will ask for that we do not invent. */
  missing: string[];
}

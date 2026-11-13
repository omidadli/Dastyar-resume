/**
 * «بستهٔ شواهد انطباق» — the evidence engine.
 *
 * Two kinds of control live in one catalogue, and the difference is the whole
 * point of this module:
 *
 *   • **`source: 'product'`** — measured from this workspace's live state right
 *     now (who has access, is 2FA on, which keys exist, when the last backup
 *     ran). Every number in `evidence` is read from the store, never typed by
 *     hand, and a control only reads `met` when the evidence supports it.
 *   • **`source: 'customer'`** — a document only the customer can produce (the
 *     information-security policy, training records, incident log, the host's
 *     SOC report). Until it is uploaded or attested, the state is
 *     `missing_evidence` — never a green tick we cannot back.
 *
 * The pack is a **hash-frozen artefact**: the JSON body is hashed, the hash is
 * printed on the cover, and both files are written to storage with that hash in
 * the manifest. Later changes in the workspace cannot silently rewrite what was
 * handed to an auditor.
 */
import crypto from 'crypto';
import { Writable } from 'stream';
import * as db from './db';
import { appVersion } from './version';
import { storage } from './storage';
import { policyOf } from './retention';
import { ssoConfigured, ssoOf } from './sso';
import { ZipWriter } from './zip';
import { formatJalaliDate } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import type {
  AccessReview,
  AccessReviewMember,
  ComplianceControl,
  CompliancePayload,
  ComplianceSummary,
  ControlDeclaration,
  ControlEvidence,
  ControlState,
  EvidenceAttachment,
  Framework,
  IssuedPack,
} from '../src/types/compliance';
import { FRAMEWORK_LABEL } from '../src/types/compliance';

export class ComplianceError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'BAD_REQUEST'
  ) {
    super(message);
  }
}

const STALE_DAYS = 365;
const REVIEW_WINDOW_DAYS = 180;

const now = () => new Date().toISOString();
export const jalaliOf = (iso: string | null | undefined): string => (iso ? formatJalaliDate(tehranJalaliOf(new Date(iso)), true) : '—');

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

const fa = (n: number) => n.toLocaleString('fa-IR');

// ------------------------------------------------------------------ facts ----

interface Facts {
  org: db.OrgRecord;
  members: db.UserRecord[];
  admins: db.UserRecord[];
  twoFactorAdmins: number;
  ssoOn: boolean;
  ssoDomains: number;
  scimOn: boolean;
  apiKeys: db.ApiKeyRow[];
  staleKeys: number;
  webhooks: db.WebhookEndpointRow[];
  retention: ReturnType<typeof policyOf>;
  activity: Awaited<ReturnType<typeof db.listActivity>>;
  lastActivityISO: string | null;
  activity30: number;
  checks: db.BackgroundCheckRow[];
  lastBackupISO: string | null;
  lastRestoreISO: string | null;
  reviews: db.AccessReviewRow[];
  lastReviewCompletedISO: string | null;
  bags: db.IssuedPackRow[];
  secrets: db.OrgSecrets;
  approvalSteps: number;
  https: boolean;
  version: string;
  jobs: number;
  candidates: number;
}

function factsOf(orgId: string): Facts {
  const org = db.getOrg(orgId);
  if (!org) throw new ComplianceError('فضای کاری یافت نشد.', 404, 'ORG_NOT_FOUND');
  const members = db.listMembers(orgId).filter((m) => !m.disabled);
  const admins = members.filter((m) => m.role === 'admin' || m.role === 'owner');
  const apiKeys = db.listApiKeys(orgId).filter((k) => !k.revokedAtISO);
  const staleKeys = apiKeys.filter((k) => (daysSince(k.lastUsedAtISO || k.createdAtISO) || 0) > 180).length;
  const activity = db.listActivity(orgId, 800);
  const cutoff = Date.now() - 30 * 86_400_000;
  const activity30 = activity.filter((a) => new Date(a.atISO).getTime() >= cutoff).length;
  const audit = db.listAudit(1000);
  const pg = ssoOf(orgId);
  const reviews = db.listAccessReviews(orgId);
  const completed = reviews.filter((r) => r.status === 'completed');
  const jobs = db.listJobs(orgId);
  const candidates = db.listOrgResumes(orgId).length;
  return {
    org,
    members,
    admins,
    twoFactorAdmins: admins.filter((a) => a.twoFactor?.enabledAtISO).length,
    ssoOn: ssoConfigured(orgId),
    ssoDomains: pg?.domains?.length || 0,
    scimOn: Boolean(org.scim),
    apiKeys,
    staleKeys,
    webhooks: db.listWebhookEndpoints(orgId),
    retention: policyOf(orgId),
    activity,
    lastActivityISO: activity[0]?.atISO || null,
    activity30,
    checks: db.listBackgroundChecks(orgId),
    lastBackupISO: audit.find((a) => a.action === 'backup.download')?.atISO || null,
    lastRestoreISO: audit.find((a) => a.action === 'backup.restore')?.atISO || null,
    reviews,
    lastReviewCompletedISO: completed[0]?.completedAtISO || null,
    bags: db.listIssuedPacks(orgId),
    secrets: db.getOrgSecrets(orgId),
    approvalSteps: org.offerApproval?.enabled ? org.offerApproval.steps.length : 0,
    https: /^https:/i.test((process.env.PUBLIC_URL || '').trim()),
    version: appVersion(),
    jobs: jobs.length,
    candidates,
  };
}

// -------------------------------------------------------------- catalogue ----

type Built = { state: ControlState; reason: string; evidence: ControlEvidence[]; action?: { label: string; to: string } | null };

interface Definition {
  id: string;
  group: string;
  title: string;
  requirement: string;
  howWeHelp: string;
  refs: string[];
  source: 'product' | 'customer';
  customerAction?: string;
  /** Automatic evidence that exists regardless of uploads. */
  auto?: (f: Facts) => ControlEvidence[];
  evaluate: (f: Facts) => Built;
}

const ACTIVITY_SAMPLE = (f: Facts) => f.activity.slice(0, 12).map((a) => `• ${jalaliOf(a.atISO)} — ${a.type}`);

const DEFS: Definition[] = [
  // ---------------------------------------------------------- access & identity
  {
    id: 'A.5.15',
    group: 'دسترسی و هویت',
    title: 'دسترسی بر پایهٔ نقش و کمینهٔ لازم',
    requirement: 'فهرست کسانی که به سامانه دسترسی دارند، نقش هرکدام، و اینکه دسترسی‌ها دوره‌ای بازبینی می‌شود.',
    howWeHelp: 'سه نقش (مالک، مدیر، عضو) وجود دارد و تنها مالک/مدیر می‌تواند عضو اضافه یا حذف کند. «بازنگری دسترسی» در همین صفحه فهرست را منجمد می‌کند و تصمیم هر عضو را با نام و تاریخ نگه می‌دارد.',
    refs: ['ISO A.5.15', 'SOC2 CC6.1', 'SOC2 CC6.3'],
    source: 'product',
    evaluate: (f) => {
      const since = daysSince(f.lastReviewCompletedISO);
      const evidence: ControlEvidence[] = [
        { label: 'اعضای فعال', value: `${fa(f.members.length)} نفر (${fa(f.admins.length)} مدیر/مالک)`, kind: 'auto' },
        { label: 'آخرین بازنگری دسترسی', value: f.lastReviewCompletedISO ? `${jalaliOf(f.lastReviewCompletedISO)} — ${fa(since || 0)} روز پیش` : 'انجام نشده', kind: 'auto' },
      ];
      if (f.lastReviewCompletedISO && (since || 0) <= REVIEW_WINDOW_DAYS) {
        return { state: 'met', reason: `دسترسی‌ها ${fa(since || 0)} روز پیش بازبینی و تأیید شده است (پنجرهٔ ۱۸۰ روز).`, evidence };
      }
      if (f.lastReviewCompletedISO) {
        return {
          state: 'partial',
          reason: `آخرین بازنگری ${fa(since || 0)} روز پیش بود؛ برای انطباق، بازنگری باید حداقل هر ۱۸۰ روز یک‌بار انجام شود.`,
          evidence,
          action: { label: 'شروع بازنگری دسترسی', to: '#review' },
        };
      }
      return {
        state: 'partial',
        reason: 'نقش‌ها و فهرست اعضا موجود است، اما هیچ بازنگری دسترسی ثبت نشده — حسابرس فهرست امضاشده می‌خواهد.',
        evidence,
        action: { label: 'شروع بازنگری دسترسی', to: '#review' },
      };
    },
  },
  {
    id: 'A.5.17',
    group: 'دسترسی و هویت',
    title: 'احراز هویت: رمز یکبارمصرف و ورود سازمانی',
    requirement: 'ورود به سامانه با عاملی بیش از رمز عبور، و ترجیحاً از طریق سرویس هویت سازمان.',
    howWeHelp: 'ورود دومرحله‌ای (TOTP + کدهای بازیابی) و SSO با OIDC (Google Workspace، Microsoft 365، Okta، Keycloak) هر دو در محصول هست؛ این بسته می‌گوید چند حساب واقعاً از آن استفاده می‌کند.',
    refs: ['ISO A.5.17', 'SOC2 CC6.1'],
    source: 'product',
    evaluate: (f) => {
      const covered = f.admins.length ? f.twoFactorAdmins === f.admins.length : true;
      const evidence: ControlEvidence[] = [
        { label: 'ورود دومرحله‌ای', value: `${fa(f.twoFactorAdmins)} از ${fa(f.admins.length)} حساب مدیر/مالک`, kind: 'auto' },
        { label: 'ورود سازمانی (SSO)', value: f.ssoOn ? `فعال — ${fa(f.ssoDomains)} دامنه` : 'تنظیم نشده', kind: 'auto' },
      ];
      if (covered && f.ssoOn) return { state: 'met', reason: 'همهٔ حساب‌های مدیر دو مرحله‌ای هستند و ورود سازمانی هم فعال است.', evidence };
      if (f.twoFactorAdmins === 0 && !f.ssoOn) {
        return {
          state: 'gap',
          reason: 'هیچ حساب مدیری دو مرحله‌ای نیست و SSO هم تنظیم نشده؛ دسترسی فقط با رمز عبور محافظت می‌شود.',
          evidence,
          action: { label: 'فعال‌سازی ورود دومرحله‌ای', to: '/app/settings/account' },
        };
      }
      return {
        state: 'partial',
        reason: covered ? 'همهٔ مدیران دو مرحله‌ای هستند، اما ورود سازمانی تنظیم نشده است.' : `${fa(f.admins.length - f.twoFactorAdmins)} حساب مدیر بدون ورود دومرحله‌ای است.`,
        evidence,
        action: { label: 'تنظیم ورود دومرحله‌ای', to: '/app/settings/account' },
      };
    },
  },
  {
    id: 'A.5.18',
    group: 'دسترسی و هویت',
    title: 'مدیریت کلیدها و اعتبارنامه‌ها',
    requirement: 'هر کلید دسترسی نام دارد، دامنهٔ محدود دارد، باطل‌شدنی است و کلید بی‌استفاده در سامانه نمی‌ماند.',
    howWeHelp: 'کلید API فقط یک بار نمایش داده می‌شود و در سرور تنها هش SHA-256 آن می‌ماند؛ دامنه read/write، شمارش فراخوانی و باطل‌سازی فوری دارد. رمزهای اتصال (SMTP، SMS، OAuth) با AES-256-GCM ذخیره می‌شوند و هرگز به مرورگر برنمی‌گردند.',
    refs: ['ISO A.5.18', 'SOC2 CC6.1', 'SOC2 CC6.2'],
    source: 'product',
    evaluate: (f) => {
      const evidence: ControlEvidence[] = [
        { label: 'کلید API فعال', value: fa(f.apiKeys.length), kind: 'auto' },
        { label: 'کلید بی‌استفاده بیش از ۱۸۰ روز', value: fa(f.staleKeys), kind: 'auto' },
        { label: 'وبهوک فعال', value: fa(f.webhooks.filter((w) => w.active).length), kind: 'auto' },
        { label: 'اعتبارنامه‌های ذخیره‌شده', value: 'رمزنگاری‌شده با AES-256-GCM', kind: 'auto' },
      ];
      if (f.staleKeys > 0) {
        return { state: 'partial', reason: `${fa(f.staleKeys)} کلید بیش از ۱۸۰ روز استفاده نشده و هنوز فعال است.`, evidence, action: { label: 'بازبینی کلیدها', to: '/app/settings/developer' } };
      }
      return {
        state: 'met',
        reason: f.apiKeys.length ? `${fa(f.apiKeys.length)} کلید فعال، همه با سابقهٔ استفادهٔ تازه.` : 'هیچ کلید API فعالی وجود ندارد؛ سطح حملهٔ کلید صفر است.',
        evidence,
      };
    },
  },
  {
    id: 'A.5.16',
    group: 'دسترسی و هویت',
    title: 'چرخهٔ عمر هویت (ورود، جابه‌جایی، خروج)',
    requirement: 'با خروج یک همکار، دسترسی‌اش همان روز بسته می‌شود؛ تغییر نقش هم ثبت دارد.',
    howWeHelp: 'حذف/غیرفعال‌سازی عضو و تغییر نقش فوری اثر می‌کند و در فید فعالیت می‌ماند. با SCIM، ساخت و حذف حساب از Okta/Entra می‌آید و دستی نمی‌ماند.',
    refs: ['ISO A.5.16', 'SOC2 CC6.2'],
    source: 'product',
    evaluate: (f) => {
      const evidence: ControlEvidence[] = [
        { label: 'SCIM (تأمین خودکار حساب)', value: f.scimOn ? `فعال از ${jalaliOf(f.org.scim?.createdAtISO || null)}` : 'تنظیم نشده', kind: 'auto' },
        { label: 'ورود سازمانی', value: f.ssoOn ? 'فعال' : 'تنظیم نشده', kind: 'auto' },
        { label: 'اعضای فعال', value: fa(f.members.length), kind: 'auto' },
      ];
      if (f.scimOn) return { state: 'met', reason: 'حساب‌ها با SCIM از سرویس هویت سازمان ساخته و حذف می‌شوند.', evidence };
      if (f.ssoOn) return { state: 'partial', reason: 'ورود سازمانی فعال است، اما ساخت/حذف حساب هنوز دستی است (SCIM وصل نیست).', evidence, action: { label: 'اتصال SCIM', to: '/app/settings/developer' } };
      return { state: 'partial', reason: 'افزودن و حذف عضو در محصول ممکن و ثبت‌شده است، اما تأمین خودکار (SCIM/SSO) تنظیم نشده.', evidence, action: { label: 'تنظیم SCIM یا SSO', to: '/app/settings/developer' } };
    },
  },

  // ------------------------------------------------------- crypto and data
  {
    id: 'A.8.24',
    group: 'رمزنگاری و داده',
    title: 'رمزنگاری در انتقال و در ذخیره',
    requirement: 'دادهٔ کاری روی شبکه رمزنگاری‌شده منتقل شود و اعتبارنامه‌ها رمزنگاری‌شده ذخیره شوند.',
    howWeHelp: 'اعتبارنامه‌ها (SMTP، SMS، OAuth، TOTP) با AES-256-GCM و کلید مشتق‌شده از راز استقرار ذخیره می‌شوند. انتقال HTTPS است. **فایل رزومه و گواهی روی دیسک رمزنگاری درجا ندارد** — این را صریح می‌نویسیم.',
    refs: ['ISO A.8.24', 'SOC2 CC6.7'],
    source: 'product',
    evaluate: (f) => {
      const evidence: ControlEvidence[] = [
        { label: 'انتقال', value: f.https ? 'HTTPS (PUBLIC_URL با https)' : 'HTTP — گواهی TLS دیده نشد', kind: 'auto' },
        { label: 'اعتبارنامه‌ها', value: 'AES-256-GCM با کلید مشتق‌شده', kind: 'auto' },
        { label: 'فایل‌های بارگذاری‌شده', value: 'رمزنگاری درجا ندارد؛ دسترسی با نقش و لاگ', kind: 'auto' },
        { label: 'میزبانی', value: 'با ارائه‌دهندهٔ زیرساخت شما (گزارش SOC میزبان را جدا بگیرید)', kind: 'auto' },
      ];
      if (!f.https) return { state: 'gap', reason: 'نشانی عمومی سامانه با HTTP تنظیم شده؛ دادهٔ کارجو نباید روی HTTP منتقل شود.', evidence };
      return { state: 'partial', reason: 'انتقال و اعتبارنامه‌ها رمزنگاری‌شده‌اند؛ فایل‌های بارگذاری‌شده رمزنگاری درجا ندارند — این محدودیت صریح ثبت شده است.', evidence };
    },
  },
  {
    id: 'A.8.15',
    group: 'ثبت و پایش',
    title: 'ثبت رویدادهای امنیتی',
    requirement: 'رویدادهای مهم (ورود، تغییر دسترسی، ارسال داده، حذف) ثبت و قابل ارائه باشند.',
    howWeHelp: 'فید فعالیت هر اقدام حساس را با نام کاربر و زمان شمسی ثبت می‌کند؛ در این بسته فقط **نوع و تعداد** رویداد می‌آید، نه نام کارجو. لاگ به‌صورت تغییرناپذیر (WORM) و بیرون از سامانه نگه داشته نمی‌شود.',
    refs: ['ISO A.8.15', 'SOC2 CC7.2'],
    source: 'product',
    evaluate: (f) => {
      const kinds = new Set(f.activity.slice(0, 400).map((a) => a.type));
      const evidence: ControlEvidence[] = [
        { label: 'رویداد ۳۰ روز گذشته', value: fa(f.activity30), kind: 'auto' },
        { label: 'گونهٔ رویداد ثبت‌شده', value: fa(kinds.size), kind: 'auto' },
        { label: 'آخرین رویداد', value: jalaliOf(f.lastActivityISO), kind: 'auto' },
        { label: 'نگه‌داری', value: 'درون سامانه، سقف ۳٬۰۰۰ رویداد سطح سکو؛ WORM بیرونی ندارد', kind: 'auto' },
        { label: 'نمونه', value: ACTIVITY_SAMPLE(f).join(' \n ') || '—', kind: 'auto' },
      ];
      if (f.activity30 === 0) return { state: 'gap', reason: 'در ۳۰ روز گذشته هیچ رویدادی ثبت نشده — یا سامانه استفاده نشده، یا ثبت کار نمی‌کند; هر دو باید بررسی شود.', evidence };
      return { state: 'partial', reason: 'ثبت رویداد در محصول کار می‌کند و شاهدش همین بسته است؛ اما لاگ تغییرناپذیر/بیرونی (SIEM) ندارد.', evidence };
    },
  },
  {
    id: 'A.8.16',
    group: 'ثبت و پایش',
    title: 'پایش فعالیت و هشدار ناهنجاری',
    requirement: 'رفتار مشکوک (ورود نامتعارف، حجم بالای دانلود) دیده و به کسی هشدار داده شود.',
    howWeHelp: 'در محصول **هیچ موتور تشخیص ناهنجاری یا هشدار خودکار ورود مشکوک وجود ندارد**. ورودها و ۲FA ثبت می‌شوند، اما پایش فعال با کسی نیست. این را جای خالی می‌نامیم، نه «پوشش‌داده‌شده».',
    refs: ['ISO A.8.16', 'SOC2 CC7.2'],
    source: 'product',
    evaluate: (f) => ({
      state: 'gap',
      reason: 'پایش خودکار ناهنجاری و هشدار ورود مشکوک در این سامانه نیست؛ برای انطباق باید از SIEM یا پایش میزبان خودتان استفاده کنید.',
      evidence: [
        { label: 'هشدار خودکار', value: 'ندارد', kind: 'auto' },
        { label: 'رویداد قابل ارسال به SIEM', value: f.webhooks.some((w) => w.active) ? 'با وبهوک فعال — بله' : 'وبهوک فعال نیست', kind: 'auto' },
      ],
    }),
  },
  {
    id: 'A.8.10',
    group: 'رمزنگاری و داده',
    title: 'حذف اطلاعات و نگه‌داری محدود',
    requirement: 'دادهٔ شخصی بیشتر از مدت لازم نگه داشته نشود و حذف آن قابل اثبات باشد.',
    howWeHelp: 'سیاست نگه‌داری (ناشناس‌سازی یا حذف بعد از n روز)، پاک‌سازی کامل به درخواست صاحب داده، و حذف فایل‌های گواهی — هر سه واقعاً ردیف و فایل را پاک می‌کنند.',
    refs: ['ISO A.8.10', 'SOC2 C1.2'],
    source: 'product',
    evaluate: (f) => {
      // A full erasure and a retention sweep both land in the activity feed.
      const erasures = f.activity.filter((a) => a.type === 'resume.deleted' || a.type === 'retention.applied').length;
      const evidence: ControlEvidence[] = [
        { label: 'سیاست نگه‌داری', value: f.retention.days > 0 ? `${fa(f.retention.days)} روز — ${f.retention.action === 'delete' ? 'حذف کامل' : 'ناشناس‌سازی'}` : 'خاموش', kind: 'auto' },
        { label: 'آخرین اجرای سیاست', value: f.retention.lastRunAtISO ? `${jalaliOf(f.retention.lastRunAtISO)} (${fa(f.retention.lastRunCount)} رکورد)` : 'اجرا نشده', kind: 'auto' },
        { label: 'پاک‌سازی به درخواست صاحب داده', value: `${fa(erasures)} مورد در سابقهٔ این فضا`, kind: 'auto' },
      ];
      if (f.retention.days <= 0) {
        return { state: 'partial', reason: 'ابزار حذف و پاک‌سازی هست، اما سیاست نگه‌داری خاموش است؛ چیزی خودکار حذف نمی‌شود.', evidence, action: { label: 'تنظیم سیاست نگه‌داری', to: '/app/settings/org' } };
      }
      return { state: 'met', reason: `سیاست ${fa(f.retention.days)} روزه فعال است و ابزار حذف با سابقه در دسترس است.`, evidence };
    },
  },
  {
    id: 'A.5.34',
    group: 'رمزنگاری و داده',
    title: 'حریم خصوصی و رضایت صاحب داده',
    requirement: 'دادهٔ شخصی با رضایت و برای هدف مشخص جمع شود و راه تماس/حذف داشته باشد.',
    howWeHelp: 'فرم پورتال رضایت اجباری دارد، استعلام سوءپیشینه بدون رضایت نام‌دار شروع نمی‌شود، و درخواست داده (DSAR) با یک کلیک خروجی JSON می‌دهد.',
    refs: ['ISO A.5.34', 'SOC2 P1.1', 'SOC2 P4.2'],
    source: 'product',
    evaluate: (f) => {
      const withConsent = f.checks.filter((c) => c.consent).length;
      const evidence: ControlEvidence[] = [
        { label: 'رضایت در فرم پورتال', value: 'اجباری (بدون آن درخواست ثبت نمی‌شود)', kind: 'auto' },
        { label: 'استعلام سوءپیشینه', value: f.checks.length ? `${fa(withConsent)} از ${fa(f.checks.length)} با رضایت ثبت‌شده` : 'موردی ثبت نشده', kind: 'auto' },
        { label: 'درخواست دادهٔ شخصی (DSAR)', value: 'خروجی JSON و پاک‌سازی کامل، فقط مدیر', kind: 'auto' },
        { label: 'سیاست نگه‌داری', value: f.retention.days > 0 ? `${fa(f.retention.days)} روز` : 'تعیین نشده', kind: 'auto' },
      ];
      if (f.retention.days <= 0) return { state: 'partial', reason: 'رضایت و DSAR در محصول هست، اما مدت نگه‌داری داده تعیین نشده — سند حریم خصوصی باید آن را بگوید.', evidence, action: { label: 'تعیین مدت نگه‌داری', to: '/app/settings/org' } };
      return { state: 'met', reason: 'رضایت، دسترسی صاحب داده و مدت نگه‌داری هر سه تعریف و قابل ارائه‌اند.', evidence };
    },
  },

  // ------------------------------------------------------- continuity
  {
    id: 'A.8.13',
    group: 'تداوم و پشتیبان',
    title: 'پشتیبان‌گیری از اطلاعات',
    requirement: 'پشتیبان دوره‌ای گرفته شود، جایی بیرون از سرور اصلی نگه داشته شود و بازیابی‌اش آزموده شده باشد.',
    howWeHelp: 'پشتیبان کامل (داده + فایل‌ها) به‌صورت ZIP قابل دانلود است و هر دانلود در لاگ سکو ثبت می‌شود. **پشتیبان‌گیری خودکار زمان‌بندی‌شده در محصول نیست** — این فضا باید آن را به میزبان یا اسکریپت خودتان بسپارد.',
    refs: ['ISO A.8.13', 'SOC2 A1.2', 'SOC2 A1.3'],
    source: 'product',
    evaluate: (f) => {
      const since = daysSince(f.lastBackupISO);
      const evidence: ControlEvidence[] = [
        { label: 'آخرین دانلود پشتیبان (کل سکو)', value: f.lastBackupISO ? `${jalaliOf(f.lastBackupISO)} — ${fa(since || 0)} روز پیش` : 'هرگز', kind: 'auto' },
        { label: 'آخرین بازیابی آزمایشی', value: f.lastRestoreISO ? jalaliOf(f.lastRestoreISO) : 'ثبت نشده', kind: 'auto' },
        { label: 'محل ذخیره‌سازی', value: storage().location || storage().driver, kind: 'auto' },
        { label: 'زمان‌بندی خودکار', value: 'در محصول نیست — با cron/میزبان تنظیم کنید', kind: 'auto' },
      ];
      if (!f.lastBackupISO) return { state: 'gap', reason: 'هیچ پشتیبانی از این سامانه برداشته نشده — بزرگ‌ترین جای خالی این بسته.', evidence, action: { label: 'گرفتن پشتیبان', to: '/admin' } };
      if ((since || 0) > 30) return { state: 'gap', reason: `آخرین پشتیبان ${fa(since || 0)} روز پیش بود؛ پشتیبان ماهانه برای بازیابی قابل قبول نیست.`, evidence, action: { label: 'گرفتن پشتیبان تازه', to: '/admin' } };
      if ((since || 0) > 7) return { state: 'partial', reason: `آخرین پشتیبان ${fa(since || 0)} روز پیش است؛ هدف هفتگی نگه داشته می‌شود.`, evidence };
      if (!f.lastRestoreISO) return { state: 'partial', reason: 'پشتیبان تازه است، اما هیچ‌وقت بازیابی آزمایشی نشده — پشتیبانِ آزموده‌نشده شاهد نیست.', evidence };
      return { state: 'met', reason: 'پشتیبان تازه است و بازیابی هم آزمایش شده.', evidence };
    },
  },
  {
    id: 'A.5.29',
    group: 'تداوم و پشتیبان',
    title: 'تداوم کسب‌وکار در اختلال',
    requirement: 'سند تداوم/بازیابی با RTO و RPO مشخص و تمرین‌شده.',
    howWeHelp: 'محصول ابزار پشتیبان و بازیابی می‌دهد، اما **سند تداوم و تعیین RTO/RPO تصمیم سازمان شماست**؛ آن را بارگذاری کنید.',
    refs: ['ISO A.5.29', 'SOC2 A1.3'],
    source: 'customer',
    customerAction: 'سند تداوم کسب‌وکار یا DR با RTO/RPO امضاشده را بارگذاری کنید (PDF).',
    auto: (f) => [{ label: 'ابزار فنی موجود', value: f.lastBackupISO ? `پشتیبان کامل + بازیابی؛ آخرین پشتیبان ${jalaliOf(f.lastBackupISO)}` : 'پشتیبان کامل + بازیابی در محصول هست', kind: 'auto' }],
    evaluate: () => ({ state: 'missing_evidence', reason: 'سند تداوم را سازمان شما باید تأمین کند.', evidence: [] }),
  },

  // ------------------------------------------------------- hiring process
  {
    id: 'A.6.1',
    group: 'فرآیند استخدام',
    title: 'بررسی پیشینهٔ کارکنان و کارجویان',
    requirement: 'پیش از استخدام، بررسی پیشینه با رضایت، مرجع مشخص و تصمیم انسانی مستند شود.',
    howWeHelp: '«استعلام سوءپیشینه» رضایت نام‌دار، شمارهٔ نامه، تصویر گواهی و تصمیم انسانی با دلیل را نگه می‌دارد؛ نتیجه هیچ‌وقت خودکار رد یا قبول نمی‌کند.',
    refs: ['ISO A.6.1', 'SOC2 CC1.4'],
    source: 'product',
    evaluate: (f) => {
      const consented = f.checks.filter((c) => c.consent).length;
      const decided = f.checks.filter((c) => c.decision).length;
      const evidence: ControlEvidence[] = [
        { label: 'استعلام ثبت‌شده', value: fa(f.checks.length), kind: 'auto' },
        { label: 'با رضایت', value: fa(consented), kind: 'auto' },
        { label: 'با تصمیم انسانی مستند', value: fa(decided), kind: 'auto' },
        { label: 'شرط', value: 'درخواست بدون رضایت نام‌دار رد می‌شود (۴۰۹)', kind: 'auto' },
      ];
      if (!f.checks.length) return { state: 'partial', reason: 'ابزار و قواعدش آماده است، اما هیچ استعلامی در این فضا ثبت نشده — شاهدی برای ارائه وجود ندارد.', evidence, action: { label: 'رفتن به پروندهٔ کارجو', to: '/app/candidates' } };
      if (decided < f.checks.length) return { state: 'partial', reason: `${fa(f.checks.length - decided)} استعلام بدون تصمیم انسانی مستند مانده است.`, evidence };
      return { state: 'met', reason: `همهٔ ${fa(f.checks.length)} استعلام با رضایت و تصمیم مستند بسته شده‌اند.`, evidence };
    },
  },
  {
    id: 'CC5.3',
    group: 'فرآیند استخدام',
    title: 'تفکیک وظایف در تصمیم استخدام',
    requirement: 'یک نفر تنها تصمیم‌گیر و مجری نباشد؛ پیشنهاد و تصمیم‌های حساس تأیید دومی داشته باشند.',
    howWeHelp: 'گردش تأیید پیشنهاد (۱ تا ۳ مرحله)، کارتابل تأیید، و غربالگری بی‌طرف. تعداد مراحل تأییدِ همین حالا در شاهد می‌آید.',
    refs: ['SOC2 CC5.3', 'ISO A.5.3'],
    source: 'product',
    evaluate: (f) => {
      const evidence: ControlEvidence[] = [
        { label: 'مراحل تأیید پیشنهاد', value: f.approvalSteps ? `${fa(f.approvalSteps)} مرحله` : 'خاموش', kind: 'auto' },
        { label: 'غربالگری بی‌طرف', value: f.org.blindScreening ? 'فعال' : 'خاموش', kind: 'auto' },
        { label: 'کارتابل تأیید', value: 'در محصول هست (همهٔ تصمیم‌های منتظر انسان)', kind: 'auto' },
      ];
      if (f.approvalSteps > 0) return { state: 'met', reason: `پیشنهاد پیش از ارسال، ${fa(f.approvalSteps)} مرحله تأیید می‌گیرد.`, evidence };
      return {
        state: 'partial',
        reason: 'ابزار تأیید چندمرحله‌ای هست، اما برای این فضا خاموش است؛ پیشنهاد بدون تأیید دوم به کارجو می‌رود.',
        evidence,
        action: { label: 'تنظیم گردش تأیید', to: '/app/settings/org' },
      };
    },
  },
  {
    id: 'A.5.19',
    group: 'اسناد سازمان (باید خودتان تأمین کنید)',
    title: 'امنیت تأمین‌کنندگان و پیمانکاران',
    requirement: 'فهرست تأمین‌کنندگانی که دادهٔ شخصی می‌بینند، ارزیابی امنیتی هرکدام و قرارداد پردازش داده.',
    howWeHelp: 'فهرست اتصال‌های همین فضا را سیستم می‌دهد؛ **ارزیابی و قرارداد هر تأمین‌کننده سند شماست** و باید بارگذاری شود.',
    refs: ['ISO A.5.19', 'SOC2 CC9.2'],
    source: 'customer',
    customerAction: 'فهرست تأمین‌کنندگان + ارزیابی/قرارداد پردازش داده (PDF یا متن) را بارگذاری کنید.',
    auto: (f) => {
      const out: ControlEvidence[] = [];
      out.push({ label: 'صندوق ایمیل', value: f.secrets.email ? `متصل — ${f.secrets.email.host}` : 'متصل نیست', kind: 'auto' });
      out.push({ label: 'درگاه پیامک', value: f.secrets.sms ? f.secrets.sms.provider : 'متصل نیست', kind: 'auto' });
      out.push({ label: 'وبهوک خروجی', value: f.webhooks.length ? `${fa(f.webhooks.length)} مقصد (${f.webhooks.map((w) => w.urlHost).slice(0, 3).join('، ')})` : 'ندارد', kind: 'auto' });
      out.push({ label: 'میزبان داده', value: 'ارائه‌دهندهٔ زیرساخت شما', kind: 'auto' });
      return out;
    },
    evaluate: () => ({ state: 'missing_evidence', reason: 'ارزیابی تأمین‌کننده سند سازمان شماست.', evidence: [] }),
  },
  {
    id: 'A.5.24',
    group: 'اسناد سازمان (باید خودتان تأمین کنید)',
    title: 'مدیریت رخداد امنیتی',
    requirement: 'مسیر گزارش، ثبت، بررسی و درس‌گرفته‌شدهٔ رخداد، با نمونهٔ ثبت‌شده.',
    howWeHelp: '**مدیریت رخداد در محصول نیست** — نه تیکت امنیتی، نه ثبت رخداد. سند رویه و فهرست رخدادهایتان را بارگذاری کنید.',
    refs: ['ISO A.5.24', 'SOC2 CC7.3', 'SOC2 CC7.4'],
    source: 'customer',
    customerAction: 'رویهٔ پاسخ به رخداد + فهرست رخدادهای سال گذشته (یا اعلام «رخدادی نداشته‌ایم») را بارگذاری/ثبت کنید.',
    evaluate: () => ({ state: 'missing_evidence', reason: 'رویه و سابقهٔ رخداد باید از سازمان شما بیاید.', evidence: [] }),
  },
  {
    id: 'A.5.1',
    group: 'اسناد سازمان (باید خودتان تأمین کنید)',
    title: 'خط‌مشی امنیت اطلاعات',
    requirement: 'سیاست مصوب و امضاشدهٔ مدیریت که دامنه، نقش‌ها و بازبینی سالانه را بگوید.',
    howWeHelp: 'این سند را نمی‌سازیم؛ اما در همین صفحه جای بارگذاری، اعلام نام تصویب‌کننده و تاریخ دارد تا در بستهٔ شواهد با هش فایل بیاید.',
    refs: ['ISO A.5.1', 'SOC2 CC1.1'],
    source: 'customer',
    customerAction: 'خط‌مشی امنیت اطلاعات (PDF) را بارگذاری کنید و در کادر اعلام، نام تصویب‌کننده و تاریخ را بنویسید.',
    evaluate: () => ({ state: 'missing_evidence', reason: 'خط‌مشی مصوب سازمان شما لازم است.', evidence: [] }),
  },
  {
    id: 'A.6.3',
    group: 'اسناد سازمان (باید خودتان تأمین کنید)',
    title: 'آموزش و آگاهی امنیتی کارکنان',
    requirement: 'سابقهٔ آموزش دوره‌ای کارکنان با نام و تاریخ.',
    howWeHelp: 'فهرست اعضای فضا را سیستم می‌دهد؛ **سابقهٔ آموزش سند شماست**.',
    refs: ['ISO A.6.3', 'SOC2 CC1.4'],
    source: 'customer',
    customerAction: 'سابقهٔ آموزش امنیتی (فهرست نام/تاریخ یا گزارش سامانهٔ آموزش) را بارگذاری کنید.',
    auto: (f) => [{ label: 'اعضایی که باید آموزش ببینند', value: `${fa(f.members.length)} نفر`, kind: 'auto' }],
    evaluate: () => ({ state: 'missing_evidence', reason: 'سابقهٔ آموزش باید از سازمان شما بیاید.', evidence: [] }),
  },
  {
    id: 'A.7.1',
    group: 'اسناد سازمان (باید خودتان تأمین کنید)',
    title: 'امنیت فیزیکی محل نگهداری داده',
    requirement: 'کنترل ورود، پایش و حفاظت فیزیکی سروری که داده روی آن است.',
    howWeHelp: '**داده روی سرور شما/میزبان شماست؛ کنترل فیزیکی در دست ما نیست.** گزارش انطباق میزبان (SOC 2/ISO) را بگیرید و همین‌جا بارگذاری کنید.',
    refs: ['ISO A.7.1', 'SOC2 CC6.4'],
    source: 'customer',
    customerAction: 'گزارش انطباق یا نامهٔ امنیت فیزیکی میزبان/دیتاسنتر را بارگذاری کنید.',
    evaluate: () => ({ state: 'missing_evidence', reason: 'شاهد فیزیکی باید از میزبان بیاید، نه از نرم‌افزار.', evidence: [] }),
  },
];

// ------------------------------------------------------------- evaluation ----

function coversFramework(def: Definition, framework: Framework): boolean {
  return def.refs.some((r) => (framework === 'iso27001' ? r.startsWith('ISO') : r.startsWith('SOC2')));
}

export function buildControls(orgId: string, framework: Framework): { controls: ComplianceControl[]; summary: ComplianceSummary } {
  const f = factsOf(orgId);
  const measuredAtISO = now();
  const attachments = db.listComplianceAttachments(orgId);
  const controls: ComplianceControl[] = [];

  for (const def of DEFS.filter((d) => coversFramework(d, framework))) {
    const attachmentsOfControl = attachments
      .filter((a) => a.controlId === def.id)
      .map<EvidenceAttachment>((a) => ({
        id: a.id,
        controlId: a.controlId,
        fileName: a.fileName,
        contentType: a.contentType,
        bytes: a.bytes,
        sha256: a.sha256,
        uploadedByName: a.uploadedByName,
        uploadedAtISO: a.uploadedAtISO,
        uploadedAtJalali: jalaliOf(a.uploadedAtISO),
      }));
    const decl = db.getComplianceDeclaration(orgId, def.id);
    const declaration: ControlDeclaration | null = decl
      ? { text: decl.text, byName: decl.byName, atISO: decl.atISO, atJalali: jalaliOf(decl.atISO) }
      : null;
    const stale = Boolean(declaration && (daysSince(declaration.atISO) || 0) > STALE_DAYS);

    const auto = def.auto ? def.auto(f) : [];
    const uploadEvidence: ControlEvidence[] = attachmentsOfControl.map((a) => ({
      label: `سند بارگذاری‌شده: ${a.fileName}`,
      value: `${a.uploadedAtJalali}، ${a.uploadedByName}، SHA-256: ${a.sha256.slice(0, 16)}…`,
      kind: 'upload' as const,
    }));
    const declEvidence: ControlEvidence[] = declaration
      ? [{ label: 'اعلام کتبی', value: `${declaration.byName} — ${declaration.atJalali}`, kind: 'declaration' as const }]
      : [];

    let built: Built;
    if (def.source === 'customer') {
      if (!attachmentsOfControl.length && !declaration) {
        built = { state: 'missing_evidence', reason: def.customerAction || 'این سند باید از سازمان شما بیاید.', evidence: [] };
      } else if (stale) {
        built = { state: 'partial', reason: 'اعلام کتبی بیش از یک سال قدمت دارد و باید بازبینی شود.', evidence: [] };
      } else if (attachmentsOfControl.length && declaration) {
        built = { state: 'met', reason: 'سند بارگذاری‌شده و اعلام کتبی هر دو در بسته هست.', evidence: [] };
      } else if (attachmentsOfControl.length) {
        built = { state: 'partial', reason: 'سند بارگذاری شده، اما اعلام کتبی (نام تصویب‌کننده/تاریخ) ثبت نشده است.', evidence: [] };
      } else {
        built = { state: 'partial', reason: 'اعلام کتبی ثبت شده، اما سند پشتیبان بارگذاری نشده است.', evidence: [] };
      }
    } else {
      built = def.evaluate(f);
      if (stale && built.state === 'met') built = { ...built, state: 'partial', reason: 'شاهد بیش از یک سال قدمت دارد.' };
    }

    controls.push({
      id: def.id,
      group: def.group,
      title: def.title,
      requirement: def.requirement,
      howWeHelp: def.howWeHelp,
      refs: def.refs.filter((r) => (framework === 'iso27001' ? r.startsWith('ISO') : r.startsWith('SOC2'))),
      source: def.source,
      state: built.state,
      reason: built.reason,
      evidence: [...auto, ...uploadEvidence, ...declEvidence, ...built.evidence],
      action: built.action || null,
      customerAction: def.customerAction || null,
      attachments: attachmentsOfControl,
      declaration,
      stale,
      measuredAtISO,
    });
  }

  return { controls, summary: summarize(controls, framework) };
}

const EMPTY_COUNTS = (): Record<ControlState, number> => ({ met: 0, partial: 0, gap: 0, missing_evidence: 0 });

function summarize(controls: ComplianceControl[], framework: Framework): ComplianceSummary {
  const counts = EMPTY_COUNTS();
  let points = 0;
  for (const c of controls) {
    counts[c.state]++;
    points += c.state === 'met' ? 1 : c.state === 'partial' ? 0.5 : 0;
  }
  const total = controls.length || 1;
  const score = Math.round((points / total) * 100);
  const readiness: ComplianceSummary['readiness'] = score >= 90 && counts.gap === 0 && counts.missing_evidence === 0 ? 'ready' : score >= 60 ? 'nearly' : 'starting';
  const gaps = controls
    .filter((c) => c.state === 'gap' || c.state === 'missing_evidence')
    .map((c) => ({ id: c.id, title: c.title, reason: c.reason, state: c.state }));
  const measuredAtISO = controls[0]?.measuredAtISO || now();
  return {
    framework,
    total: controls.length,
    counts,
    score,
    readiness,
    gaps,
    lastMeasuredISO: measuredAtISO,
    lastMeasuredJalali: jalaliOf(measuredAtISO),
    limits: [
      'این بسته «شاهد» است، نه گواهی. گواهی ISO/IEC 27001 یا گزارش SOC 2 را فقط نهاد صدوردهنده/حسابرس مستقل می‌دهد.',
      'میزبانی، امنیت فیزیکی و پشتیبان زیرساخت با ارائه‌دهندهٔ سرور شماست؛ گزارش خودش را جدا بگیرید.',
      'آزمون نفوذ، SIEM و پایش خودکار ناهنجاری در این محصول نیست — جای خالی‌شان در فهرست، عمداً خالی مانده است.',
      'فایل‌های رزومه و گواهی روی دیسک رمزنگاری درجا ندارند؛ دسترسی به آن‌ها با نقش، جریان مستقیم و لاگ کنترل می‌شود.',
      'کنترل‌های «اسناد سازمان» را شما بارگذاری می‌کنید؛ HOVIDA آن اسناد را نمی‌سازد و درستی‌شان را تأیید نمی‌کند.',
      'وضعیت هر کنترل لحظهٔ اندازه‌گیری است؛ پس از تغییر تنظیمات، بستهٔ تازه صادر کنید.',
    ],
  };
}

export function loadPayload(orgId: string, framework: Framework, canManage: boolean): CompliancePayload {
  const { controls, summary } = buildControls(orgId, framework);
  const f = factsOf(orgId);
  return {
    controls,
    summary,
    reviews: db.listAccessReviews(orgId).slice(0, 20),
    packs: db.listIssuedPacks(orgId, framework).slice(0, 20).map(publicPack),
    canManage,
    rosterSize: f.members.length,
    canIssue: canManage,
    lastBackupISO: f.lastBackupISO,
  };
}

export function publicPack(row: db.IssuedPackRow): IssuedPack {
  const { orgId: _o, markdownKey: _m, jsonKey: _j, frameworkLabel: _f, ...rest } = row;
  return rest;
}

// ------------------------------------------------------------ access review ----

export function startAccessReview(orgId: string, framework: Framework, note: string, actor: { id: string; name: string }): AccessReview {
  const open = db.listAccessReviews(orgId).find((r) => r.status === 'open');
  if (open) throw new ComplianceError('یک بازنگری دسترسی باز وجود دارد؛ اول آن را تمام کنید.', 409, 'REVIEW_OPEN');
  const f = factsOf(orgId);
  const members: AccessReviewMember[] = f.members
    .map((m) => {
      const admin = m.role === 'admin' || m.role === 'owner';
      const inactive = (daysSince(m.lastLoginISO) || 999) > 90;
      return {
        userId: m.id,
        name: m.name,
        email: m.email,
        role: m.role,
        twoFactor: Boolean(m.twoFactor?.enabledAtISO),
        lastLoginISO: m.lastLoginISO,
        flag: admin ? 'admin' : !m.twoFactor?.enabledAtISO ? 'no_2fa' : inactive ? 'inactive' : null,
        confirmed: false,
        confirmedAtISO: null,
        confirmedByName: null,
      } as AccessReviewMember;
    })
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, 'fa') : a.role === 'member' ? 1 : -1));
  const iso = now();
  const review: AccessReview = {
    id: `acr_${crypto.randomBytes(8).toString('hex')}`,
    framework,
    status: 'open',
    note: note.slice(0, 400),
    startedByName: actor.name,
    startedAtISO: iso,
    startedAtJalali: jalaliOf(iso),
    members,
    completedAtISO: null,
    completedAtJalali: null,
    completedByName: null,
    summary: null,
    snapshot: null,
  };
  db.saveAccessReview(orgId, review);
  return review;
}

export function confirmAccessMember(
  orgId: string,
  reviewId: string,
  userId: string,
  confirmed: boolean,
  actor: { id: string; name: string }
): AccessReview {
  const row = db.getAccessReview(orgId, reviewId);
  if (!row) throw new ComplianceError('بازنگری یافت نشد.', 404, 'REVIEW_NOT_FOUND');
  if (row.status !== 'open') throw new ComplianceError('این بازنگری بسته شده است.', 409, 'REVIEW_CLOSED');
  const m = row.members.find((x) => x.userId === userId);
  if (!m) throw new ComplianceError('این عضو در بازنگری نیست.', 404, 'MEMBER_NOT_FOUND');
  m.confirmed = confirmed;
  m.confirmedAtISO = confirmed ? now() : null;
  m.confirmedByName = confirmed ? actor.name : null;
  return publicReview(db.saveAccessReview(orgId, row));
}

export function completeAccessReview(orgId: string, reviewId: string, note: string, actor: { id: string; name: string }): AccessReview {
  const row = db.getAccessReview(orgId, reviewId);
  if (!row) throw new ComplianceError('بازنگری یافت نشد.', 404, 'REVIEW_NOT_FOUND');
  if (row.status !== 'open') throw new ComplianceError('این بازنگری قبلاً بسته شده است.', 409, 'REVIEW_CLOSED');
  const pending = row.members.filter((m) => !m.confirmed);
  if (pending.length) throw new ComplianceError(`${fa(pending.length)} عضو هنوز تأیید نشده است.`, 400, 'MEMBERS_PENDING');
  if (note.trim().length < 10) throw new ComplianceError('یادداشت پایان بازنگری باید حداقل ۱۰ نویسه باشد (چه تصمیمی گرفته شد).', 400, 'NOTE_REQUIRED');
  const iso = now();
  row.status = 'completed';
  row.completedAtISO = iso;
  row.completedAtJalali = jalaliOf(iso);
  row.completedByName = actor.name;
  row.note = `${row.note}${row.note ? '\n' : ''}${note.trim()}`.slice(0, 800);
  row.snapshot = {
    total: row.members.length,
    confirmed: row.members.filter((m) => m.confirmed).length,
    admins: row.members.filter((m) => m.role === 'admin' || m.role === 'owner').length,
    withoutTwoFactor: row.members.filter((m) => !m.twoFactor).length,
  };
  row.summary = `${fa(row.snapshot.total)} عضو بازبینی شد؛ ${fa(row.snapshot.admins)} مدیر، ${fa(row.snapshot.withoutTwoFactor)} نفر بدون ورود دومرحله‌ای.`;
  return publicReview(db.saveAccessReview(orgId, row));
}

export function publicReview(row: db.AccessReviewRow): AccessReview {
  const { orgId: _o, ...rest } = row;
  return rest;
}

// -------------------------------------------------------------- the pack ----

function sanitizeCell(s: string): string {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function csvCell(s: string | number | boolean | null | undefined): string {
  const raw = s === null || s === undefined ? '' : String(s);
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

function csv(rows: Array<Array<string | number | boolean | null | undefined>>): string {
  // A BOM so Excel opens Persian text correctly.
  return '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export interface BuiltPack {
  markdown: string;
  json: string;
  sha256: string;
  data: Record<string, unknown>;
  rosterCsv: string;
  activityCsv: string;
}

export function buildPack(orgId: string, framework: Framework, scopeNote: string, actor: { id: string; name: string } | null): BuiltPack {
  const { controls, summary } = buildControls(orgId, framework);
  const f = factsOf(orgId);
  const issuedAtISO = now();
  const org = f.org;

  const rosterRows: Array<Array<string | number | boolean>> = [
    ['name', 'email', 'role', 'two_factor', 'last_login_iso', 'last_login_jalali', 'active'],
    ...f.members.map((m) => [
      m.name,
      m.email,
      m.role,
      Boolean(m.twoFactor?.enabledAtISO),
      m.lastLoginISO || '',
      m.lastLoginISO ? jalaliOf(m.lastLoginISO) : '',
      true,
    ]),
  ];

  // Activity is summarised by month + type: an auditor needs coverage, not the
  // names of the candidates a recruiter opened in March.
  const buckets = new Map<string, number>();
  for (const a of f.activity) {
    const month = jalaliOf(a.atISO).slice(0, 7);
    const key = `${month}|${a.type}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const activityRows: Array<Array<string | number>> = [
    ['month_jalali', 'event_type', 'count'],
    ...Array.from(buckets.entries())
      .map(([k, n]) => {
        const [month, type] = k.split('|');
        return [month, type, n] as Array<string | number>;
      })
      .sort((a, b) => String(b[0]).localeCompare(String(a[0])) || String(a[1]).localeCompare(String(b[1]))),
  ];

  const lastReview = db.listAccessReviews(orgId).find((r) => r.status === 'completed') || null;

  const data = {
    pack: {
      framework,
      frameworkLabel: FRAMEWORK_LABEL[framework],
      generatedAtISO: issuedAtISO,
      generatedAtJalali: jalaliOf(issuedAtISO),
      generatedBy: actor?.name || 'سامانه',
      scopeNote,
      productVersion: f.version,
      organisation: { id: org.id, name: org.name, createdAtISO: org.createdAtISO },
      // Stated plainly, so nobody mistakes the artefact for a certificate.
      nature: 'شواهد وضعیت (evidence pack) — نه گواهی ISO و نه گزارش SOC 2',
    },
    summary,
    controls: controls.map((c) => ({
      id: c.id,
      refs: c.refs,
      group: c.group,
      title: c.title,
      requirement: c.requirement,
      state: c.state,
      reason: c.reason,
      source: c.source,
      evidence: c.evidence.map((e) => ({ label: e.label, value: e.value, kind: e.kind })),
      declaration: c.declaration,
      attachments: c.attachments.map((a) => ({ fileName: a.fileName, bytes: a.bytes, sha256: a.sha256, uploadedByName: a.uploadedByName, uploadedAtISO: a.uploadedAtISO })),
    })),
    accessReview: lastReview
      ? {
          id: lastReview.id,
          startedAtISO: lastReview.startedAtISO,
          completedAtISO: lastReview.completedAtISO,
          completedByName: lastReview.completedByName,
          summary: lastReview.summary,
          note: lastReview.note,
          members: lastReview.members.map((m) => ({ name: m.name, email: m.email, role: m.role, twoFactor: m.twoFactor, confirmed: m.confirmed, confirmedByName: m.confirmedByName, confirmedAtISO: m.confirmedAtISO })),
        }
      : null,
    roster: { count: f.members.length, file: 'access-roster.csv' },
    activity: { eventsInLog: f.activity.length, file: 'activity-summary.csv', note: 'فقط ماه و نوع رویداد؛ نام کارجو در این فایل نیست' },
    files: [] as string[],
  };

  const json = JSON.stringify(data, null, 2);
  const sha256 = crypto.createHash('sha256').update(json, 'utf8').digest('hex');

  const counts = summary.counts;
  const lines: string[] = [];
  lines.push(`# بستهٔ شواهد انطباق — ${FRAMEWORK_LABEL[framework]}`);
  lines.push('');
  lines.push(`**سازمان:** ${org.name}`);
  lines.push('');
  lines.push(`**تاریخ صدور:** ${jalaliOf(issuedAtISO)} (${issuedAtISO})`);
  lines.push('');
  lines.push(`**صادرکننده:** ${actor?.name || 'سامانه'}`);
  lines.push('');
  lines.push(`**نسخهٔ محصول:** ${f.version}`);
  lines.push('');
  lines.push(`**اثر انگشت بسته (SHA-256):** \`${sha256}\``);
  lines.push('');
  lines.push('> این سند «شاهد وضعیت» است، نه گواهی. گواهی ISO/IEC 27001 یا گزارش SOC 2 را فقط نهاد صدوردهنده/حسابرس مستقل می‌دهد.');
  lines.push('');
  if (scopeNote) {
    lines.push(`**دامنهٔ اعلام‌شده:** ${scopeNote}`);
    lines.push('');
  }
  lines.push('## ۱) خلاصه');
  lines.push('');
  lines.push(`| اندازه | مقدار |`);
  lines.push(`| --- | --- |`);
  lines.push(`| کنترل‌های این چارچوب | ${fa(summary.total)} |`);
  lines.push(`| پوشش‌داده‌شده | ${fa(counts.met)} |`);
  lines.push(`| پوشش جزئی | ${fa(counts.partial)} |`);
  lines.push(`| جای خالی | ${fa(counts.gap)} |`);
  lines.push(`| سند ارسال‌نشده | ${fa(counts.missing_evidence)} |`);
  lines.push(`| امتیاز آمادگی (وزنی) | ${fa(summary.score)}٪ |`);
  lines.push('');
  lines.push(`این عدد «گواهی» نیست: هر کنترل «پوشش جزئی» نیم امتیاز دارد و جای خالی صفر. اندازه‌گیری: ${summary.lastMeasuredJalali}.`);
  lines.push('');
  if (summary.gaps.length) {
    lines.push('### جای خالی‌ها (پیش از ارائه به حسابرس)');
    lines.push('');
    for (const g of summary.gaps) {
      lines.push(`- **${g.id} — ${sanitizeCell(g.title)}** (${g.state === 'gap' ? 'جای خالی' : 'سند ارسال‌نشده'}): ${sanitizeCell(g.reason)}`);
    }
    lines.push('');
  }
  lines.push('## ۲) محدودیت‌های این بسته');
  lines.push('');
  for (const l of summary.limits) lines.push(`- ${l}`);
  lines.push('');
  lines.push('## ۳) کنترل‌ها');
  lines.push('');
  for (const c of controls) {
    lines.push(`### ${c.id} — ${c.title}`);
    lines.push('');
    lines.push(`- **مرجع:** ${c.refs.join('، ')}`);
    lines.push(`- **وضعیت:** ${c.state}`);
    lines.push(`- **منبع شاهد:** ${c.source === 'product' ? 'اندازه‌گیری خودکار از سامانه' : 'سند سازمان'}`);
    lines.push(`- **خواستهٔ حسابرس:** ${c.requirement}`);
    lines.push(`- **چرا این وضعیت:** ${c.reason}`);
    lines.push('');
    if (c.evidence.length) {
      lines.push('| شاهد | مقدار |');
      lines.push('| --- | --- |');
      for (const e of c.evidence) lines.push(`| ${sanitizeCell(e.label)} | ${sanitizeCell(e.value)} |`);
      lines.push('');
    }
    if (c.declaration) {
      lines.push(`> اعلام کتبی — ${c.declaration.byName}، ${c.declaration.atJalali}: ${c.declaration.text}`);
      lines.push('');
    }
    for (const a of c.attachments) {
      lines.push(`- پیوست: \`attachments/${c.id}/${a.fileName}\` — ${a.bytes} بایت، SHA-256 \`${a.sha256}\``);
    }
    lines.push('');
  }
  lines.push('## ۴) بازنگری دسترسی');
  lines.push('');
  if (lastReview) {
    lines.push(`آخرین بازنگری کامل: ${jalaliOf(lastReview.completedAtISO)} توسط ${lastReview.completedByName || '—'}. ${lastReview.summary || ''}`);
    lines.push('');
    lines.push(`یادداشت: ${sanitizeCell(lastReview.note)}`);
  } else {
    lines.push('هیچ بازنگری دسترسی کامل‌شده‌ای وجود ندارد.');
  }
  lines.push('');
  lines.push(`فهرست کامل دسترسی‌ها در \`access-roster.csv\` (${fa(f.members.length)} ردیف) آمده است.`);
  lines.push('');
  lines.push('## ۵) ثبت رویداد');
  lines.push('');
  lines.push(`\`activity-summary.csv\` تعداد رویدادها را به تفکیک ماه و نوع می‌دهد (${fa(f.activity.length)} رویداد در لاگ فعلی). نام کارجو در این فایل نیست.`);
  lines.push('');
  lines.push('## ۶) فایل‌های این بسته');
  lines.push('');
  lines.push('| فایل | توضیح |');
  lines.push('| --- | --- |');
  lines.push('| `README.md` | همین گزارش |');
  lines.push('| `evidence.json` | دادهٔ کامل و ماشین‌خوان؛ هش روی همین فایل محاسبه شده |');
  lines.push('| `access-roster.csv` | فهرست اعضا، نقش، وضعیت ورود دومرحله‌ای |');
  lines.push('| `activity-summary.csv` | شمارش ماهانهٔ رویدادها بر اساس نوع |');
  lines.push('| `SHA256SUMS` | هش همهٔ فایل‌ها، برای بررسی دست‌نخوردگی |');
  lines.push('| `attachments/…` | اسنادی که سازمان بارگذاری کرده است |');
  lines.push('');

  return { markdown: lines.join('\n'), json, sha256, data, rosterCsv: csv(rosterRows), activityCsv: csv(activityRows) };
}

/** Names of every file in the pack, in a stable order. */
function packAttachmentNames(orgId: string): Array<{ name: string; attachment: db.ComplianceAttachmentRow }> {
  return db.listComplianceAttachments(orgId).map((a) => ({ name: `attachments/${a.controlId}/${safeName(a.fileName)}`, attachment: a }));
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'file';
}

export function sha256Of(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Issues a pack: builds it, writes `README.md` + `evidence.json` to storage and
 * keeps a row with the hash. The ZIP is assembled on download from these files,
 * so two downloads months apart are byte-identical for the same pack.
 */
export async function issuePack(
  orgId: string,
  framework: Framework,
  scopeNote: string,
  actor: { id: string; name: string }
): Promise<db.IssuedPackRow> {
  const built = buildPack(orgId, framework, scopeNote, actor);
  const id = `pack_${crypto.randomBytes(8).toString('hex')}`;
  const markdownKey = `compliance/${orgId}/pack-${id}.md`;
  const jsonKey = `compliance/${orgId}/pack-${id}.json`;
  const rosterKey = `compliance/${orgId}/pack-${id}.roster.csv`;
  const activityKey = `compliance/${orgId}/pack-${id}.activity.csv`;
  await storage().put(markdownKey, Buffer.from(built.markdown, 'utf8'));
  await storage().put(jsonKey, Buffer.from(built.json, 'utf8'));
  await storage().put(rosterKey, Buffer.from(built.rosterCsv, 'utf8'));
  await storage().put(activityKey, Buffer.from(built.activityCsv, 'utf8'));
  const attachments = db.listComplianceAttachments(orgId).length;
  const files = ['README.md', 'evidence.json', 'access-roster.csv', 'activity-summary.csv', 'SHA256SUMS', ...packAttachmentNames(orgId).map((x) => x.name)];
  const iso = now();
  const row: db.IssuedPackRow = {
    id,
    orgId,
    framework,
    frameworkLabel: FRAMEWORK_LABEL[framework],
    scopeNote: scopeNote.slice(0, 400),
    issuedByName: actor.name,
    issuedAtISO: iso,
    issuedAtJalali: jalaliOf(iso),
    sha256: built.sha256,
    bytes: Buffer.byteLength(built.json, 'utf8'),
    counts: built.data.summary ? (built.data.summary as ComplianceSummary).counts : EMPTY_COUNTS(),
    score: (built.data.summary as ComplianceSummary)?.score ?? 0,
    attachments,
    files,
    markdownKey,
    jsonKey,
    rosterKey,
    activityKey,
  };
  db.saveIssuedPack(row);
  return row;
}

export async function readPackArtifact(row: db.IssuedPackRow, format: 'md' | 'json'): Promise<Buffer> {
  const key = format === 'md' ? row.markdownKey : row.jsonKey;
  const obj = await storage().get(key);
  if (!obj) throw new ComplianceError('فایل این بسته در ذخیره‌سازی پیدا نشد.', 404, 'PACK_FILE_MISSING');
  return obj.body;
}

/**
 * Assembles the ZIP from the files frozen at issue time. Nothing here is
 * recomputed from today's workspace: the roster and the activity summary are the
 * ones the report was built from, so the hash on the cover stays true.
 */
export async function buildPackZip(orgId: string, row: db.IssuedPackRow): Promise<Buffer> {
  const md = await readPackArtifact(row, 'md');
  const json = await readPackArtifact(row, 'json');
  const readKey = async (key: string): Promise<Buffer | null> => {
    if (!key) return null;
    const obj = await storage().get(key);
    return obj ? obj.body : null;
  };
  const roster = await readKey(row.rosterKey);
  const activity = await readKey(row.activityKey);

  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'README.md', data: md },
    { name: 'evidence.json', data: json },
  ];
  if (roster) entries.push({ name: 'access-roster.csv', data: roster });
  if (activity) entries.push({ name: 'activity-summary.csv', data: activity });

  const seen = new Set<string>();
  for (const { name, attachment } of packAttachmentNames(orgId)) {
    if (seen.has(name)) continue;
    const data = await storage().get(attachment.key);
    if (!data) continue;
    seen.add(name);
    entries.push({ name, data: data.body });
  }
  const sum = entries.map((e) => `${sha256Of(e.data)}  ${e.name}`).join('\n') + '\n';
  entries.push({ name: 'SHA256SUMS', data: Buffer.from(sum, 'utf8') });

  // The ZIP is assembled in memory: a pack is a few MB at most, and a single
  // buffer makes the hash-summed artefact easy to serve and to test.
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const writer = new ZipWriter(sink);
  for (const e of entries) await writer.add(e.name, e.data, { compress: true });
  await writer.finish();
  await new Promise<void>((resolve) => sink.end(() => resolve()));
  return Buffer.concat(chunks);
}

export async function deletePack(orgId: string, id: string): Promise<boolean> {
  const row = db.getIssuedPack(orgId, id);
  if (!row) return false;
  await storage().delete(row.markdownKey).catch(() => undefined);
  await storage().delete(row.jsonKey).catch(() => undefined);
  if (row.rosterKey) await storage().delete(row.rosterKey).catch(() => undefined);
  if (row.activityKey) await storage().delete(row.activityKey).catch(() => undefined);
  db.removeIssuedPack(orgId, id);
  return true;
}

/** Uploading evidence: size and type limits, hashed, and stored under the workspace. */
export const EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
const EVIDENCE_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'txt', 'md', 'csv', 'docx', 'xlsx']);

export async function saveEvidence(
  orgId: string,
  controlId: string,
  input: { fileName: unknown; fileBase64: unknown },
  actor: { id: string | null; name: string }
): Promise<EvidenceAttachment> {
  const def = DEFS.find((d) => d.id === controlId);
  if (!def) throw new ComplianceError('کنترل یافت نشد.', 404, 'CONTROL_NOT_FOUND');
  const fileName = String(input.fileName || '').trim().slice(0, 160);
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!fileName || !EVIDENCE_TYPES.has(ext)) {
    throw new ComplianceError('فقط PDF، تصویر، متن یا سند اداری (docx/xlsx) پذیرفته می‌شود.', 400, 'BAD_FILE_TYPE');
  }
  const raw = typeof input.fileBase64 === 'string' ? input.fileBase64 : '';
  const b64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch {
    throw new ComplianceError('فایل خوانده نشد.', 400, 'BAD_FILE');
  }
  if (!bytes.length) throw new ComplianceError('فایل خالی است.', 400, 'EMPTY_FILE');
  if (bytes.length > EVIDENCE_MAX_BYTES) throw new ComplianceError('حجم فایل بیش از ۸ مگابایت است.', 413, 'FILE_TOO_LARGE');
  const existing = db.listComplianceAttachments(orgId, controlId);
  if (existing.length >= 10) throw new ComplianceError('برای هر کنترل حداکثر ۱۰ سند می‌توان نگه داشت.', 409, 'TOO_MANY_FILES');

  const id = `evd_${crypto.randomBytes(8).toString('hex')}`;
  const key = `compliance/${orgId}/att/${id}.${ext}`;
  await storage().put(key, bytes);
  const iso = now();
  const row: db.ComplianceAttachmentRow = {
    id,
    orgId,
    controlId,
    fileName,
    contentType: ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream',
    bytes: bytes.length,
    sha256: sha256Of(bytes),
    key,
    uploadedById: actor.id,
    uploadedByName: actor.name,
    uploadedAtISO: iso,
  };
  db.saveComplianceAttachment(row);
  return {
    id: row.id,
    controlId,
    fileName,
    contentType: row.contentType,
    bytes: row.bytes,
    sha256: row.sha256,
    uploadedByName: row.uploadedByName,
    uploadedAtISO: iso,
    uploadedAtJalali: jalaliOf(iso),
  };
}

export async function deleteEvidence(orgId: string, controlId: string, id: string): Promise<boolean> {
  const row = db.getComplianceAttachment(orgId, id);
  if (!row || row.controlId !== controlId) return false;
  await storage().delete(row.key).catch(() => undefined);
  db.removeComplianceAttachment(orgId, id);
  return true;
}

export function saveDeclaration(orgId: string, controlId: string, text: string, actor: { id: string | null; name: string }): ComplianceControl['declaration'] {
  const def = DEFS.find((d) => d.id === controlId);
  if (!def) throw new ComplianceError('کنترل یافت نشد.', 404, 'CONTROL_NOT_FOUND');
  const clean = text.trim();
  if (clean.length < 20) throw new ComplianceError('اعلام کتبی باید حداقل ۲۰ نویسه باشد و بگوید چه چیزی، کجا و توسط چه کسی تصویب شده است.', 400, 'DECLARATION_TOO_SHORT');
  const iso = now();
  db.saveComplianceDeclaration({ orgId, controlId, text: clean.slice(0, 1200), byId: actor.id, byName: actor.name, atISO: iso });
  return { text: clean.slice(0, 1200), byName: actor.name, atISO: iso, atJalali: jalaliOf(iso) };
}

export function clearDeclaration(orgId: string, controlId: string): boolean {
  return db.removeComplianceDeclaration(orgId, controlId);
}

/** Every control id in the catalogue, for validation and for the docs page. */
export function controlIds(): string[] {
  return DEFS.map((d) => d.id);
}

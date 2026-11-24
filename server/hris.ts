/**
 * «انتقال به حقوق و دستمزد» — the payroll handoff, in one place.
 *
 * Design rules:
 *   • **The roster is a projection, not a second database.** Every row is read
 *     from the onboarding plan (which is itself created by an accepted offer),
 *     the job, and the offer that was signed. Nothing is retyped, nothing drifts.
 *   • **Empty stays empty.** No salary in the offer → an empty payroll column,
 *     counted in the UI, never a guessed number.
 *   • **Payroll's own data is not collected.** National ID, insurance number and
 *     bank account never enter HOVIDA; they are listed as "not here" on purpose.
 *   • **The file is theirs, the columns are theirs.** Every field can be renamed
 *     or dropped; the mapping is saved per workspace and survives a restart.
 *   • **Sending is a button, not a timer.** The push happens when an admin
 *     presses it, is signed with HMAC, and its failure never breaks anything.
 */
import crypto from 'crypto';
import * as db from './db';
import { decryptSecret, encryptSecret } from './secret';
import { signatureFor } from './webhooks';
import { EMPLOYMENT_LABELS } from '../src/lib/match';
import { formatJalaliDate, toPersianDigits } from '../src/utils/jalali';
import { tehranJalaliOf } from './tehran-time';
import {
  DEFAULT_HRIS_MAPPING,
  HRIS_FIELDS,
  HRIS_FIELD_KEYS,
  type HrisEndpointView,
  type HrisField,
  type HrisPushResult,
  type HrisRoster,
  type HrisRow,
} from '../src/types/hris';

export class HrisError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = 'HRIS_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SALARY_PERIOD_LABEL: Record<'monthly' | 'annual', string> = { monthly: 'ماهانه', annual: 'سالانه' };
const PLAN_STATUS_LABEL: Record<'inProgress' | 'completed', string> = { inProgress: 'در جریان', completed: 'کامل‌شده' };
const TIMEOUT_MS = 8000;

function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** `H-0007`, one per workspace, derived from the codes already in use. */
export function nextEmployeeCode(orgId: string): string {
  let max = 0;
  for (const plan of db.listOnboarding(orgId)) {
    const m = /^H-(\d{3,})$/.exec(plan.employeeCode || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `H-${String(max + 1).padStart(4, '0')}`;
}

function signedOffer(orgId: string, resumeId: string) {
  return db.listOffers(orgId, { resumeId }).find((o) => o.status === 'accepted') || null;
}

/**
 * Everyone payroll must pay: plans that are not cancelled. A plan whose start
 * date is still ahead is included — payroll wants the contract before day one.
 */
export function buildRoster(orgId: string): HrisRow[] {
  const rows: HrisRow[] = [];
  for (const plan of db.listOnboarding(orgId)) {
    if (plan.status === 'cancelled') continue;
    // Plans written before payroll codes existed get one on first sight.
    if (!plan.employeeCode) plan.employeeCode = db.saveOnboarding({ ...plan, employeeCode: nextEmployeeCode(orgId) }).employeeCode;
    const rec = db.getResume(orgId, plan.resumeId);
    const job = plan.jobId ? db.getJob(orgId, plan.jobId) : null;
    const offer = signedOffer(orgId, plan.resumeId);
    const fullName = plan.candidateName || rec?.candidateName || 'کارجو';
    const { first, last } = splitName(fullName);
    rows.push({
      planId: plan.id,
      resumeId: plan.resumeId,
      employeeCode: plan.employeeCode || '',
      fullName,
      firstName: first,
      lastName: last,
      email: plan.candidateEmail || rec?.contact?.email || null,
      jobTitle: plan.jobTitle || job?.roleTitle || '',
      departmentName: plan.departmentName || job?.departmentName || '',
      startDateJalali: plan.startDateJalali,
      startDateISO: plan.startDateISO,
      employmentType: offer?.terms.employmentType || job?.employmentType || '',
      location: offer?.terms.location || job?.location || '',
      baseSalary: offer?.terms.salaryAmount ?? null,
      salaryPeriod: offer?.terms.salaryAmount == null ? null : offer.terms.salaryPeriod,
      planStatus: plan.status === 'completed' ? 'completed' : 'inProgress',
      ownerName: plan.ownerName,
    });
  }
  return rows.sort((a, b) => a.startDateISO.localeCompare(b.startDateISO));
}

/** The value of one field for one row, already formatted for a spreadsheet. */
export function cellOf(row: HrisRow, field: HrisField): string {
  switch (field) {
    case 'employeeCode':
      return row.employeeCode;
    case 'fullName':
      return row.fullName;
    case 'firstName':
      return row.firstName;
    case 'lastName':
      return row.lastName;
    case 'email':
      return row.email || '';
    case 'jobTitle':
      return row.jobTitle;
    case 'departmentName':
      return row.departmentName;
    case 'startDateJalali':
      return row.startDateJalali;
    case 'startDateISO':
      return row.startDateISO.slice(0, 10);
    case 'employmentType':
      // Payroll reads Persian; the record stores the stable English code.
      return (EMPLOYMENT_LABELS as Record<string, string>)[row.employmentType] || row.employmentType;
    case 'location':
      return row.location;
    case 'baseSalary':
      return row.baseSalary == null ? '' : String(row.baseSalary);
    case 'salaryPeriod':
      return row.salaryPeriod ? SALARY_PERIOD_LABEL[row.salaryPeriod] : '';
    case 'planStatus':
      return PLAN_STATUS_LABEL[row.planStatus];
    case 'ownerName':
      return row.ownerName || '';
    default:
      return '';
  }
}

export function normalizeMapping(input: unknown, previous?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = { ...DEFAULT_HRIS_MAPPING, ...(previous || {}) };
  if (input === undefined) return base;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HrisError('تنظیم ستون‌ها معتبر نیست.', 400, 'BAD_MAPPING');
  }
  const out: Record<string, string> = { ...DEFAULT_HRIS_MAPPING };
  for (const key of HRIS_FIELD_KEYS) out[key] = '';
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(HRIS_FIELD_KEYS as string[]).includes(key)) continue;
    if (typeof value !== 'string') throw new HrisError('نام هر ستون باید متن باشد.', 400, 'BAD_MAPPING');
    const header = value.trim().slice(0, 60);
    out[key] = header;
  }
  if (!Object.values(out).some((v) => v)) {
    throw new HrisError('دست‌کم یک ستون برای فایل حقوق انتخاب کنید.', 400, 'MAPPING_EMPTY');
  }
  const headers = Object.values(out).filter(Boolean);
  if (new Set(headers).size !== headers.length) {
    throw new HrisError('نام دو ستون یکسان است؛ هر ستون باید نام خودش را داشته باشد.', 400, 'MAPPING_DUPLICATE');
  }
  return out;
}

/** Fields in file order, skipping the ones HR removed. */
export function columnsOf(mapping: Record<string, string>): { key: HrisField; header: string }[] {
  return HRIS_FIELD_KEYS.filter((key) => Boolean(mapping[key])).map((key) => ({ key, header: mapping[key] }));
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Excel on Windows reads a UTF-8 CSV as mojibake unless it starts with a BOM and
 * uses CRLF. Payroll clerks use Excel, so this is not a detail — it is the file.
 */
export function toCsv(rows: HrisRow[], mapping: Record<string, string>): string {
  const cols = columnsOf(mapping);
  const lines = [cols.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(cellOf(row, c.key))).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function endpointView(row: db.HrisConfigRow | null): HrisEndpointView {
  // A row may exist only to hold the column mapping: no URL means not configured.
  if (!row || !row.urlEnc) return { configured: false, host: null, masked: null, secretHint: null, updatedAtISO: row?.updatedAtISO ?? null };
  return {
    configured: true,
    host: row.urlHost,
    masked: row.urlMasked,
    secretHint: row.secretHint,
    updatedAtISO: row.updatedAtISO,
  };
}

export function mappingOf(orgId: string): Record<string, string> {
  return normalizeMapping(undefined, db.getHrisConfig(orgId)?.mapping);
}

export function rosterFor(orgId: string): HrisRoster {
  const items = buildRoster(orgId);
  const now = Date.now();
  const started = items.filter((r) => new Date(r.startDateISO).getTime() <= now).length;
  const config = db.getHrisConfig(orgId);
  const last = db.listHrisPushes(orgId, 1)[0] || null;
  return {
    items,
    fields: HRIS_FIELDS,
    mapping: normalizeMapping(undefined, config?.mapping),
    endpoint: endpointView(config),
    lastPush: last ? pushResultOf(last) : null,
    counts: {
      total: items.length,
      started,
      upcoming: items.length - started,
      missingSalary: items.filter((r) => r.baseSalary == null).length,
      missingEmail: items.filter((r) => !r.email).length,
    },
  };
}

function pushResultOf(row: db.HrisPushRow): HrisPushResult {
  const { orgId: _o, ...rest } = row;
  return rest;
}

/** Saves the endpoint. The URL is a secret everywhere except its host. */
export function saveEndpoint(orgId: string, input: { url?: unknown; secret?: unknown }): db.HrisConfigRow {
  const rawUrl = typeof input.url === 'string' ? input.url.trim() : '';
  if (!rawUrl) throw new HrisError('نشانی دریافت‌کنندهٔ فایل حقوق را وارد کنید.', 400, 'URL_REQUIRED');
  let parsed: URL | null = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }
  if (!parsed) throw new HrisError('نشانی معتبر نیست؛ باید با https:// شروع شود.', 400, 'INVALID_URL');
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new HrisError('برای امنیت، نشانی باید https باشد. برای سرور داخلی از 127.0.0.1 استفاده کنید.', 400, 'INVALID_URL');
  }
  if (rawUrl.length > 500) throw new HrisError('نشانی بیش از حد طولانی است.', 400, 'INVALID_URL');

  const previous = db.getHrisConfig(orgId);
  const secretInput = typeof input.secret === 'string' ? input.secret.trim() : '';
  if (secretInput && secretInput.length < 16) {
    throw new HrisError('کلید امضا دست‌کم ۱۶ نویسه باشد؛ یا خالی بگذارید تا ما بسازیم.', 400, 'SECRET_TOO_SHORT');
  }
  const secret = secretInput || `hris_${crypto.randomBytes(24).toString('base64url')}`;
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  const stamp = new Date().toISOString();
  return db.saveHrisConfig({
    orgId,
    urlEnc: encryptSecret(rawUrl),
    secretEnc: encryptSecret(secret),
    secretHint: secret.slice(-4),
    urlHost: parsed.host,
    urlMasked: `${parsed.origin}${path.slice(0, 5)}${path.length > 5 ? '…' : ''}`,
    mapping: normalizeMapping(undefined, previous?.mapping),
    updatedAtISO: stamp,
  });
}

function decodeEndpoint(row: db.HrisConfigRow): { url: string; secret: string } {
  const url = decryptSecret(row.urlEnc);
  const secret = decryptSecret(row.secretEnc);
  if (!url || !secret) {
    throw new HrisError('کلید رمزنگاری این اتصال در دسترس نیست؛ نشانی را دوباره ثبت کنید.', 409, 'SECRET_UNAVAILABLE');
  }
  return { url, secret };
}

/**
 * One handoff to payroll: signed JSON, two attempts, and a recorded result.
 * A failed push is not an exception the page hides — it is the page's content.
 */
export async function pushRoster(orgId: string, actor: { id: string; name: string } | null): Promise<{ push: HrisPushResult; rows: number }> {
  const config = db.getHrisConfig(orgId);
  // A row may exist only to hold the column mapping — that is not a receiver.
  if (!config || !config.urlEnc) {
    throw new HrisError('هنوز نشانی دریافت‌کننده تنظیم نشده است؛ اول آن را در همین صفحه ثبت کنید.', 409, 'HRIS_NOT_CONFIGURED');
  }
  const { url, secret } = decodeEndpoint(config);
  const org = db.getOrg(orgId);
  const rows = buildRoster(orgId);
  if (!rows.length) {
    throw new HrisError('هنوز کسی در فهرست حقوق نیست؛ فهرست از برنامهٔ تحویل پس از استخدام ساخته می‌شود.', 409, 'ROSTER_EMPTY');
  }
  const mapping = normalizeMapping(undefined, config.mapping);
  const id = db.uid('hrp');
  const stamp = new Date();
  const body = JSON.stringify({
    id,
    event: 'hris.roster',
    apiVersion: 1,
    occurredAt: stamp.toISOString(),
    org: { name: org?.name || '' },
    columns: columnsOf(mapping).map((c) => ({ key: c.key, header: c.header })),
    mapping,
    currency: 'IRT',
    rows: rows.map((r) => Object.fromEntries(columnsOf(mapping).map((c) => [c.key, cellOf(r, c.key)]))),
  });

  let status: number | null = null;
  let error: string | null = null;
  let ok = false;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Hovida-HRIS/1',
          'X-Hovida-Event': 'hris.roster',
          'X-Hovida-Delivery': id,
          'X-Hovida-Signature': signatureFor(secret, Math.floor(Date.now() / 1000), body),
        },
        body,
        signal: controller.signal,
      });
      status = res.status;
      if (res.ok) {
        ok = true;
        error = null;
      } else {
        const text = await res.text().catch(() => '');
        error = `پاسخ ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`;
      }
    } catch (err: any) {
      status = null;
      error = err?.name === 'AbortError' ? 'در زمان مقرر پاسخ نداد.' : 'ارسال به سیستم حقوق ممکن نشد.';
    } finally {
      clearTimeout(timer);
    }
    if (!ok && attempt === 0) await new Promise((r) => setTimeout(r, 400));
  }

  const saved = db.saveHrisPush({
    id,
    orgId,
    atISO: stamp.toISOString(),
    atJalali: formatJalaliDate(tehranJalaliOf(stamp), true),
    ok,
    status,
    error,
    rows: rows.length,
    byName: actor?.name || null,
  });
  db.logActivity(
    orgId,
    actor,
    'hris.push',
    ok
      ? `فهرست ${toPersianDigits(rows.length)} نفر به سیستم حقوق فرستاده شد`
      : `ارسال فهرست حقوق ناموفق بود${error ? ` — ${error}` : ''}`,
    { jobId: null, resumeId: null }
  );
  return { push: pushResultOf(saved), rows: rows.length };
}

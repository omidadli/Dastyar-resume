/**
 * HOVIDA persistence layer (multi-tenant).
 *
 * No external database: state lives in memory and is snapshotted to
 * data/hovida-store.json (debounced, atomic rename). Original resume files are
 * stored under data/resumes/<orgId>/<jobId>/<resumeId>.<ext>.
 *
 * Every read/write helper that takes an `orgId` enforces tenant isolation — a
 * record that belongs to another organization behaves exactly like a missing one.
 *
 * Earlier single-tenant snapshots (data/screening-store.json with `batches`)
 * are migrated on first start: batches become jobs, soft-deleted resumes are
 * purged for real, and the first organization that signs up adopts that legacy
 * data (or the one whose owner email matches LEGACY_OWNER_EMAIL).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AuditItem } from '../src/types/admin';
import type {
  AnalysisHistoryEntry,
  CandidateEvaluation,
  EvaluationMeta,
  DecisionStatus,
  EmploymentType,
  Job,
  JobStats,
  JobSummary,
  ResumeCategory,
  ResumeCounts,
  ResumeListItem,
  ResumePage,
  ResumeQuery,
  ResumeRecord,
  PagedResult,
  Recommendation,
} from '../src/types/screening';
import type {
  ActivityItem,
  ActivityType,
  DashboardData,
  Department,
  OrgPublic,
  ReportRange,
  ReportsData,
  Role,
  SearchResults,
  TalentDepartment,
  UserPublic,
} from '../src/types/app';
import { cloneDefaultDepartments } from '../src/shared/departments';
import { tehranJalaliOf, tehranNow, tehranWallDate } from './tehran-time';
import {
  JALALI_MONTH_NAMES,
  compareJalali,
  formatJalaliDate,
  gregorianToJalali,
  parseJalaliDateString,
  toPersianDigits,
} from '../src/utils/jalali';
import { matchesSearch } from '../src/lib/normalizeFa';

export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'hovida-store.json');
const LEGACY_FILE = path.join(DATA_DIR, 'screening-store.json');
export const RESUMES_DIR = path.join(DATA_DIR, 'resumes');

/** Minutes a recruiter typically spends on a first manual read — shown as an assumption. */
export const MANUAL_MINUTES_PER_RESUME = 6;
/** Minutes still spent per resume when reviewing HOVIDA's evidence instead. */
export const ASSISTED_MINUTES_PER_RESUME = 1.5;

// ---------------------------------------------------------------- records ----

export type OrgRecord = OrgPublic;

export interface UserRecord extends UserPublic {
  passwordHash: string;
  lastSeenActivityISO: string | null;
}

export interface SessionRecord {
  tokenHash: string;
  userId: string;
  createdAtISO: string;
  expiresAt: number;
  lastSeenAt: number;
  /** Set when a platform admin opened this session for support («ورود پشتیبانی»). */
  support?: { adminId: string; adminName: string } | null;
}

interface Snapshot {
  version: 2;
  orgs: OrgRecord[];
  users: UserRecord[];
  sessions: SessionRecord[];
  jobs: Job[];
  resumes: ResumeRecord[];
  activity: ActivityItem[];
  /** Platform settings (/admin): AI keys (encrypted), behaviour, system switches. */
  platform?: unknown;
  audit?: AuditItem[];
  aiStats?: unknown;
}

const orgs = new Map<string, OrgRecord>();
const users = new Map<string, UserRecord>();
const sessions = new Map<string, SessionRecord>();
const jobs = new Map<string, Job>();
const resumes = new Map<string, ResumeRecord>();
let activity: ActivityItem[] = [];
let platformBlob: unknown = null;
let auditLog: AuditItem[] = [];
let aiStatsBlob: unknown = null;

let saveTimer: NodeJS.Timeout | null = null;
let initialized = false;

export function uid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

function nowStamp(at?: Date) {
  if (at) return { iso: at.toISOString(), jalali: formatJalaliDate(tehranJalaliOf(at), true) };
  return { iso: new Date().toISOString(), jalali: tehranNow().jalaliString };
}

// ------------------------------------------------------------ persistence ----

export async function initStore() {
  if (initialized) return;
  initialized = true;
  await fs.promises.mkdir(RESUMES_DIR, { recursive: true });
  // Temp files left by a crash mid-save (the real snapshot is renamed atomically).
  for (const f of await fs.promises.readdir(DATA_DIR).catch(() => [] as string[])) {
    if (f.startsWith(path.basename(STORE_FILE) + '.') && f.endsWith('.tmp')) await fs.promises.unlink(path.join(DATA_DIR, f)).catch(() => {});
  }
  let raw: string | null = null;
  try {
    raw = await fs.promises.readFile(STORE_FILE, 'utf-8');
  } catch {
    raw = null;
  }
  if (raw) {
    try {
      const snap = JSON.parse(raw) as Snapshot;
      snap.orgs?.forEach((o) => orgs.set(o.id, normalizeOrg(o)));
      snap.users?.forEach((u) => users.set(u.id, u));
      snap.sessions?.forEach((s) => sessions.set(s.tokenHash, s));
      snap.jobs?.forEach((j) => jobs.set(j.id, normalizeJob(j)));
      snap.resumes?.forEach((r) => resumes.set(r.id, normalizeResume(r)));
      activity = Array.isArray(snap.activity) ? snap.activity : [];
      platformBlob = snap.platform ?? null;
      auditLog = Array.isArray(snap.audit) ? snap.audit : [];
      aiStatsBlob = snap.aiStats ?? null;
      for (const j of jobs.values()) {
        // A server restart interrupts any analysis that was in flight.
        if (j.analysisStatus === 'processing') j.analysisStatus = 'done';
        recomputeJob(j.id, false);
      }
      console.log(`[store] loaded ${orgs.size} orgs, ${users.size} users, ${jobs.size} jobs, ${resumes.size} resumes.`);
      claimLegacyDataOnStartup();
      return;
    } catch (err) {
      console.error('[store] snapshot unreadable — starting empty (file kept as .corrupt):', err);
      await fs.promises.copyFile(STORE_FILE, STORE_FILE + '.corrupt').catch(() => {});
    }
  }
  await migrateLegacySnapshot();
  claimLegacyDataOnStartup();
}

async function migrateLegacySnapshot() {
  let raw: string;
  try {
    raw = await fs.promises.readFile(LEGACY_FILE, 'utf-8');
  } catch {
    return; // fresh install
  }
  try {
    const snap = JSON.parse(raw) as { batches?: any[]; resumes?: any[] };
    let purged = 0;
    for (const b of snap.batches || []) {
      const created = b.createdAtISO || new Date().toISOString();
      jobs.set(
        b.id,
        normalizeJob({
          id: b.id,
          orgId: null,
          createdBy: null,
          createdByName: null,
          departmentId: b.departmentId || 'other',
          departmentName: b.departmentName || 'سایر',
          roleTitle: b.roleTitle || '',
          extraNotes: String(b.extraNotes || '').replace('[demo-seed]', '').trim(),
          location: '',
          employmentType: null,
          understanding: b.understanding,
          answers: b.answers || {},
          criteriaSource: 'ai',
          status: 'open',
          analysisStatus: b.status === 'cancelled' ? 'cancelled' : 'done',
          stats: emptyStats(),
          createdAtJalali: b.createdAtJalali || '',
          createdAtISO: created,
          updatedAtISO: created,
        } as Job)
      );
    }
    for (const r of snap.resumes || []) {
      if (r.deleted) {
        // Soft-deleted resumes used to keep personal data on disk forever.
        if (r.filePath) deleteFileQuietly(r.filePath);
        purged++;
        continue;
      }
      if (!jobs.has(r.batchId)) continue;
      resumes.set(r.id, normalizeResume({ ...r, jobId: r.batchId, orgId: null, uploadedBy: null } as ResumeRecord));
    }
    for (const j of jobs.values()) recomputeJob(j.id, false);
    console.log(`[store] migrated legacy snapshot: ${jobs.size} jobs, ${resumes.size} resumes (purged ${purged} deleted).`);
    scheduleSave();
  } catch (err) {
    console.error('[store] legacy snapshot could not be migrated:', err);
  }
}

function snapshot(): Snapshot {
  return {
    version: 2,
    orgs: Array.from(orgs.values()),
    users: Array.from(users.values()),
    sessions: Array.from(sessions.values()),
    jobs: Array.from(jobs.values()),
    resumes: Array.from(resumes.values()),
    activity,
    platform: platformBlob ?? undefined,
    audit: auditLog,
    aiStats: aiStatsBlob ?? undefined,
  };
}

let saving = false;
let dirty = false;
let firstDirtyAt = 0;
let tmpCounter = 0;
/** Debounce, but never postpone a save by more than this while changes keep coming. */
const SAVE_DEBOUNCE_MS = 400;
const SAVE_MAX_WAIT_MS = 3000;

function tmpPath() {
  tmpCounter = (tmpCounter + 1) % 1_000_000;
  return `${STORE_FILE}.${process.pid}.${tmpCounter}.tmp`;
}

/**
 * Debounced snapshot save. Writes are serialized (one at a time) and every
 * write uses its own temp file, so a slow disk can never interleave two
 * snapshots into one corrupt file before the atomic rename.
 */
export function scheduleSave() {
  if (!dirty) firstDirtyAt = Date.now();
  dirty = true;
  if (saving) return; // the running save re-schedules itself when it finishes
  if (saveTimer) clearTimeout(saveTimer);
  const wait = Math.max(0, Math.min(SAVE_DEBOUNCE_MS, firstDirtyAt + SAVE_MAX_WAIT_MS - Date.now()));
  saveTimer = setTimeout(() => void runSave(), wait);
}

async function runSave() {
  saveTimer = null;
  if (saving || !dirty) return;
  saving = true;
  dirty = false;
  const tmp = tmpPath();
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, JSON.stringify(snapshot()), 'utf-8');
    await fs.promises.rename(tmp, STORE_FILE);
  } catch (err) {
    console.error('[store] snapshot save failed:', err);
    fs.promises.unlink(tmp).catch(() => {});
    dirty = true; // try again with the next change or the retry below
  } finally {
    saving = false;
    if (dirty) scheduleSave();
  }
}

/** Synchronous flush for graceful shutdown (SIGTERM on deploys). */
export function flushSaveSync() {
  if (!initialized) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = tmpPath();
    fs.writeFileSync(tmp, JSON.stringify(snapshot()), 'utf-8');
    fs.renameSync(tmp, STORE_FILE);
    dirty = false;
  } catch (err) {
    console.error('[store] final flush failed:', err);
  }
}

// --------------------------------------------------------- normalization ----

function emptyStats(): JobStats {
  return {
    total: 0,
    interview: 0,
    review: 0,
    reject: 0,
    unjudgeable: 0,
    error: 0,
    approved: 0,
    rejected: 0,
    reviewDecision: 0,
    undecided: 0,
    avgScore: 0,
  };
}

function normalizeOrg(o: OrgRecord): OrgRecord {
  return {
    ...o,
    departments: Array.isArray(o.departments) && o.departments.length ? o.departments : cloneDefaultDepartments(),
    messageSignature: o.messageSignature ?? `واحد منابع انسانی ${o.name}`,
    isDemo: Boolean(o.isDemo),
    demoExpiresAt: o.demoExpiresAt ?? null,
    suspended: Boolean(o.suspended),
    suspendedReason: o.suspendedReason ?? null,
  };
}

function normalizeJob(j: Job): Job {
  return {
    ...j,
    orgId: j.orgId ?? null,
    createdBy: j.createdBy ?? null,
    createdByName: j.createdByName ?? null,
    location: j.location || '',
    employmentType: j.employmentType ?? null,
    criteriaSource: j.criteriaSource || 'ai',
    status: j.status || 'open',
    analysisStatus: j.analysisStatus || 'done',
    answers: j.answers || {},
    stats: j.stats || emptyStats(),
    updatedAtISO: j.updatedAtISO || j.createdAtISO,
  };
}

function normalizeResume(r: ResumeRecord): ResumeRecord {
  const created = r.createdAtISO || new Date().toISOString();
  const d = new Date(created);
  return {
    ...r,
    orgId: r.orgId ?? null,
    uploadedBy: r.uploadedBy ?? null,
    roleTitle: r.roleTitle ?? jobs.get(r.jobId)?.roleTitle ?? null,
    fileSize: r.fileSize ?? null,
    criterionScores: Array.isArray(r.criterionScores) ? r.criterionScores : [],
    strengths: Array.isArray(r.strengths) ? r.strengths : [],
    weaknesses: Array.isArray(r.weaknesses) ? r.weaknesses : [],
    knockoutMisses: Array.isArray(r.knockoutMisses) ? r.knockoutMisses : [],
    tags: Array.isArray(r.tags) ? r.tags : [],
    bankTags: Array.isArray(r.bankTags) ? r.bankTags : [],
    deepFindings: r.deepFindings ?? null,
    analysisHistory: Array.isArray(r.analysisHistory) ? r.analysisHistory : [],
    addedToBankAtISO: r.addedToBankAtISO ?? null,
    decisionStatus: r.decisionStatus || 'none',
    decidedAtJalali: r.decidedAtJalali ?? null,
    decidedAtISO: r.decidedAtISO ?? null,
    decidedBy: r.decidedBy ?? null,
    decidedByName: r.decidedByName ?? null,
    decisionNote: r.decisionNote ?? null,
    deepAnalysisAtJalali: r.deepAnalysisAtJalali ?? null,
    createdAtISO: created,
    createdAtJalali: r.createdAtJalali || (isNaN(d.getTime()) ? '' : formatJalaliDate(tehranJalaliOf(d), true)),
    updatedAtISO: r.updatedAtISO || created,
  };
}

// ------------------------------------------------------------------ files ----

/** Formats the intake reads (ingest/) — anything else (executables, scripts) is stored as .bin. */
const SAFE_EXTENSIONS = [
  'pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'markdown', 'pages', 'wps', 'dot', 'dotx',
  'pptx', 'ppt', 'odp', 'key', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'numbers',
  'epub', 'xps', 'oxps', 'djvu', 'html', 'htm', 'xhtml', 'mht', 'mhtml', 'xml', 'json', 'vcf',
  'eml', 'msg', 'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svg', 'ico', 'jp2', 'psd',
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'aiff', 'aif', 'amr', 'wma',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', '3gp', 'mpeg', 'mpg',
];

/** Keeps the real extension (images used to be saved as .bin, which broke previews). */
export function safeExt(fileName: string): string {
  const ext = String(fileName).toLowerCase().split('.').pop() || '';
  return SAFE_EXTENSIONS.includes(ext) ? ext : 'bin';
}

export function resolveFilePath(relPath: string): string | null {
  const full = path.resolve(RESUMES_DIR, relPath);
  if (!full.startsWith(path.resolve(RESUMES_DIR) + path.sep)) return null; // traversal guard
  return full;
}

export function deleteFileQuietly(relPath: string | null | undefined) {
  if (!relPath) return;
  const full = resolveFilePath(relPath);
  if (!full) return;
  fs.promises.unlink(full).catch(() => {});
}

async function writeResumeFile(
  orgKey: string,
  jobId: string,
  recordId: string,
  fileName: string,
  base64: string | undefined
): Promise<{ relPath: string; size: number } | null> {
  if (!base64) return null;
  try {
    const dir = path.join(RESUMES_DIR, orgKey, jobId);
    await fs.promises.mkdir(dir, { recursive: true });
    const full = path.join(dir, `${recordId}.${safeExt(fileName)}`);
    const buf = Buffer.from(base64, 'base64');
    await fs.promises.writeFile(full, buf);
    return { relPath: path.relative(RESUMES_DIR, full), size: buf.length };
  } catch (err) {
    console.error('[store] file save failed:', err);
    return null;
  }
}

export async function readResumeFileBuffer(rec: ResumeRecord): Promise<Buffer | null> {
  if (!rec.filePath) return null;
  const full = resolveFilePath(rec.filePath);
  if (!full) return null;
  try {
    return await fs.promises.readFile(full);
  } catch {
    return null;
  }
}

export async function readResumeFileBase64(rec: ResumeRecord): Promise<string | null> {
  if (!rec.filePath) return null;
  const full = resolveFilePath(rec.filePath);
  if (!full) return null;
  try {
    return (await fs.promises.readFile(full)).toString('base64');
  } catch {
    return null;
  }
}

// ------------------------------------------------------- orgs / members ----

export function getOrg(id: string | null | undefined): OrgRecord | null {
  return (id && orgs.get(id)) || null;
}

export function createOrg(input: { name: string; isDemo?: boolean; demoExpiresAt?: string | null; ownerEmail?: string }): OrgRecord {
  const org: OrgRecord = {
    id: uid('org'),
    name: input.name.trim().slice(0, 80),
    departments: cloneDefaultDepartments(),
    messageSignature: `با احترام\nواحد منابع انسانی ${input.name.trim().slice(0, 80)}`,
    isDemo: Boolean(input.isDemo),
    demoExpiresAt: input.demoExpiresAt ?? null,
    createdAtISO: new Date().toISOString(),
  };
  orgs.set(org.id, org);
  // Data created before multi-tenancy goes ONLY to the workspace whose owner
  // e-mail is LEGACY_OWNER_EMAIL — never to "whoever signs up first" on a
  // public deployment (that would hand candidates' personal data to a stranger).
  if (!org.isDemo && legacyOwnerEmail() && legacyOwnerEmail() === (input.ownerEmail || '').trim().toLowerCase()) {
    adoptLegacyData(org.id);
  }
  scheduleSave();
  return org;
}

function legacyOwnerEmail(): string {
  return (process.env.LEGACY_OWNER_EMAIL || '').trim().toLowerCase();
}

function adoptLegacyData(orgId: string): number {
  let adopted = 0;
  for (const j of jobs.values()) {
    if (j.orgId === null) {
      j.orgId = orgId;
      adopted++;
    }
  }
  for (const r of resumes.values()) if (r.orgId === null) r.orgId = orgId;
  if (adopted) {
    console.log(`[store] org ${orgId} adopted ${adopted} legacy jobs.`);
    scheduleSave();
  }
  return adopted;
}

/**
 * Startup: unclaimed legacy data is attached to the existing account whose
 * e-mail is LEGACY_OWNER_EMAIL (so setting the variable after signing up
 * works too); otherwise it stays hidden and we say how to claim it.
 */
function claimLegacyDataOnStartup() {
  const orphans = Array.from(jobs.values()).filter((j) => j.orgId === null).length;
  if (!orphans) return;
  const email = legacyOwnerEmail();
  const owner = email ? Array.from(users.values()).find((u) => u.email === email) : null;
  if (owner) {
    adoptLegacyData(owner.orgId);
    return;
  }
  console.log(
    `[store] ${orphans} job(s) from the previous single-workspace version are waiting for their owner. ` +
      'Set LEGACY_OWNER_EMAIL to the e-mail you sign up (or already signed up) with to attach them to your workspace.'
  );
}

export function updateOrg(id: string, patch: Partial<Pick<OrgRecord, 'name' | 'messageSignature' | 'departments'>>): OrgRecord | null {
  const org = orgs.get(id);
  if (!org) return null;
  if (typeof patch.name === 'string' && patch.name.trim()) org.name = patch.name.trim().slice(0, 80);
  if (typeof patch.messageSignature === 'string') org.messageSignature = patch.messageSignature.slice(0, 400);
  if (Array.isArray(patch.departments)) org.departments = patch.departments;
  scheduleSave();
  return org;
}

/** Removes a whole workspace: members, sessions, jobs, candidates, files, activity. */
export function deleteOrg(id: string) {
  for (const j of Array.from(jobs.values())) if (j.orgId === id) deleteJobRecord(j.id);
  for (const u of Array.from(users.values())) if (u.orgId === id) deleteUserRecord(u.id);
  activity = activity.filter((a) => a.orgId !== id);
  orgs.delete(id);
  fs.promises.rm(path.join(RESUMES_DIR, id), { recursive: true, force: true }).catch(() => {});
  scheduleSave();
}

export function publicUser(u: UserRecord): UserPublic {
  const { passwordHash: _p, lastSeenActivityISO: _l, ...rest } = u;
  return rest;
}

export function findUserByEmail(email: string): UserRecord | null {
  const e = email.trim().toLowerCase();
  for (const u of users.values()) if (u.email === e) return u;
  return null;
}

export function getUser(id: string | null | undefined): UserRecord | null {
  return (id && users.get(id)) || null;
}

export function createUser(input: { orgId: string; name: string; email: string; passwordHash: string; role: Role; title?: string }): UserRecord {
  const u: UserRecord = {
    id: uid('usr'),
    orgId: input.orgId,
    name: input.name.trim().slice(0, 80),
    email: input.email.trim().toLowerCase(),
    role: input.role,
    title: (input.title || '').trim().slice(0, 80),
    createdAtISO: new Date().toISOString(),
    lastLoginISO: null,
    passwordHash: input.passwordHash,
    lastSeenActivityISO: new Date().toISOString(),
  };
  users.set(u.id, u);
  scheduleSave();
  return u;
}

export function updateUser(
  id: string,
  patch: Partial<Pick<UserRecord, 'name' | 'title' | 'role' | 'passwordHash' | 'lastLoginISO' | 'lastSeenActivityISO' | 'platformAdmin' | 'disabled' | 'email'>>
) {
  const u = users.get(id);
  if (!u) return null;
  Object.assign(u, patch);
  scheduleSave();
  return u;
}

function deleteUserRecord(id: string) {
  users.delete(id);
  for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k);
}

export function deleteUser(id: string) {
  deleteUserRecord(id);
  scheduleSave();
}

export function listMembers(orgId: string): UserRecord[] {
  return Array.from(users.values())
    .filter((u) => u.orgId === orgId)
    .sort((a, b) => a.createdAtISO.localeCompare(b.createdAtISO));
}

// --------------------------------------------------------------- sessions ----

export function createSession(
  userId: string,
  tokenHash: string,
  ttlMs: number,
  support?: { adminId: string; adminName: string } | null
): SessionRecord {
  const s: SessionRecord = {
    tokenHash,
    userId,
    createdAtISO: new Date().toISOString(),
    expiresAt: Date.now() + ttlMs,
    lastSeenAt: Date.now(),
    ...(support ? { support } : {}),
  };
  sessions.set(tokenHash, s);
  scheduleSave();
  return s;
}

export function getSession(tokenHash: string): SessionRecord | null {
  const s = sessions.get(tokenHash);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(tokenHash);
    scheduleSave();
    return null;
  }
  return s;
}

/** Sliding expiry, written at most once a minute per session. */
export function touchSession(s: SessionRecord, ttlMs: number) {
  if (Date.now() - s.lastSeenAt < 60_000) return;
  if (s.support) return; // support sessions keep their short, fixed lifetime
  s.lastSeenAt = Date.now();
  s.expiresAt = Date.now() + ttlMs;
  scheduleSave();
}

export function deleteSession(tokenHash: string) {
  sessions.delete(tokenHash);
  scheduleSave();
}

export function deleteSessionsOfUser(userId: string, exceptHash?: string) {
  for (const [k, s] of sessions) if (s.userId === userId && k !== exceptHash) sessions.delete(k);
  scheduleSave();
}

/** Periodic housekeeping: expired sessions and expired demo workspaces. */
export function purgeExpired() {
  const now = Date.now();
  let changed = false;
  for (const [k, s] of sessions) if (s.expiresAt < now) { sessions.delete(k); changed = true; }
  for (const o of Array.from(orgs.values())) {
    if (o.isDemo && o.demoExpiresAt && new Date(o.demoExpiresAt).getTime() < now) {
      deleteOrg(o.id);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// --------------------------------------------------------------- activity ----

export function logActivity(
  orgId: string | null,
  actor: { id: string; name: string } | null,
  type: ActivityType,
  text: string,
  refs: { jobId?: string | null; resumeId?: string | null; at?: Date } = {}
): ActivityItem | null {
  if (!orgId) return null;
  const stamp = nowStamp(refs.at);
  const item: ActivityItem = {
    id: uid('act'),
    orgId,
    userId: actor?.id ?? null,
    userName: actor?.name ?? null,
    type,
    text: text.slice(0, 240),
    jobId: refs.jobId ?? null,
    resumeId: refs.resumeId ?? null,
    atISO: stamp.iso,
    atJalali: stamp.jalali,
  };
  activity.push(item);
  // Keep the newest 600 entries per organization.
  const mine = activity.filter((a) => a.orgId === orgId);
  if (mine.length > 600) {
    const drop = new Set(
      mine
        .sort((a, b) => a.atISO.localeCompare(b.atISO))
        .slice(0, mine.length - 600)
        .map((a) => a.id)
    );
    activity = activity.filter((a) => !drop.has(a.id));
  }
  scheduleSave();
  return item;
}

export function listActivity(orgId: string, limit = 30): ActivityItem[] {
  return activity
    .filter((a) => a.orgId === orgId)
    .sort((a, b) => b.atISO.localeCompare(a.atISO))
    .slice(0, limit);
}

export function unreadCount(user: UserRecord): number {
  const since = user.lastSeenActivityISO || '';
  return activity.filter((a) => a.orgId === user.orgId && a.userId !== user.id && a.atISO > since).length;
}

// ------------------------------------------------------------------- jobs ----

/** The runner pings every 2 minutes; silence for longer means the tab was closed mid-run. */
const STALE_ANALYSIS_MS = 6 * 60_000;

function expireStaleAnalysis(j: Job): Job {
  if (j.analysisStatus === 'processing' && Date.now() - new Date(j.updatedAtISO).getTime() > STALE_ANALYSIS_MS) {
    j.analysisStatus = 'done';
    scheduleSave();
  }
  return j;
}

export function getJob(orgId: string, id: string): Job | null {
  const j = jobs.get(id);
  return j && j.orgId === orgId ? expireStaleAnalysis(j) : null;
}

export function toJobSummary(j: Job): JobSummary {
  const { understanding, answers: _a, ...rest } = j;
  return { ...rest, criteriaCount: understanding?.criteria?.length || 0, thresholds: understanding?.thresholds };
}

export function listJobs(orgId: string): Job[] {
  return Array.from(jobs.values())
    .filter((j) => j.orgId === orgId)
    .map(expireStaleAnalysis)
    .sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
}

export function createJob(
  orgId: string,
  actor: { id: string; name: string } | null,
  input: Pick<
    Job,
    'departmentId' | 'departmentName' | 'roleTitle' | 'extraNotes' | 'location' | 'employmentType' | 'understanding' | 'answers' | 'criteriaSource'
  >,
  at?: Date
): Job {
  const stamp = nowStamp(at);
  const job: Job = {
    id: uid('job'),
    orgId,
    createdBy: actor?.id ?? null,
    createdByName: actor?.name ?? null,
    departmentId: input.departmentId,
    departmentName: input.departmentName,
    roleTitle: input.roleTitle.trim().slice(0, 120),
    extraNotes: input.extraNotes.slice(0, 3000),
    location: (input.location || '').slice(0, 80),
    employmentType: input.employmentType ?? null,
    understanding: input.understanding,
    answers: input.answers || {},
    criteriaSource: input.criteriaSource,
    status: 'open',
    analysisStatus: 'idle',
    stats: emptyStats(),
    createdAtJalali: stamp.jalali,
    createdAtISO: stamp.iso,
    updatedAtISO: stamp.iso,
  };
  jobs.set(job.id, job);
  scheduleSave();
  return job;
}

export function updateJob(
  orgId: string,
  id: string,
  patch: Partial<Pick<Job, 'roleTitle' | 'extraNotes' | 'location' | 'employmentType' | 'status' | 'analysisStatus'>>
): Job | null {
  const j = getJob(orgId, id);
  if (!j) return null;
  if (typeof patch.roleTitle === 'string' && patch.roleTitle.trim()) j.roleTitle = patch.roleTitle.trim().slice(0, 120);
  if (typeof patch.extraNotes === 'string') j.extraNotes = patch.extraNotes.slice(0, 3000);
  if (typeof patch.location === 'string') j.location = patch.location.slice(0, 80);
  if (patch.employmentType !== undefined) j.employmentType = patch.employmentType as EmploymentType | null;
  if (patch.status && ['open', 'paused', 'closed'].includes(patch.status)) j.status = patch.status;
  if (patch.analysisStatus) j.analysisStatus = patch.analysisStatus;
  j.updatedAtISO = new Date().toISOString();
  if (typeof patch.roleTitle === 'string') {
    for (const r of resumes.values()) if (r.jobId === j.id) r.roleTitle = j.roleTitle;
  }
  scheduleSave();
  return j;
}

function deleteJobRecord(id: string) {
  const j = jobs.get(id);
  for (const [rid, r] of resumes) {
    if (r.jobId === id) {
      deleteFileQuietly(r.filePath);
      resumes.delete(rid);
    }
  }
  if (j?.orgId) fs.promises.rm(path.join(RESUMES_DIR, j.orgId, id), { recursive: true, force: true }).catch(() => {});
  fs.promises.rm(path.join(RESUMES_DIR, id), { recursive: true, force: true }).catch(() => {}); // legacy layout
  jobs.delete(id);
}

/** Hard delete — candidates and their original files are removed from disk too. */
export function deleteJob(orgId: string, id: string): boolean {
  if (!getJob(orgId, id)) return false;
  deleteJobRecord(id);
  scheduleSave();
  return true;
}

function resumesOfJob(jobId: string): ResumeRecord[] {
  const out: ResumeRecord[] = [];
  for (const r of resumes.values()) if (r.jobId === jobId) out.push(r);
  return out;
}

function knockoutsSatisfied(job: Job, rec: ResumeRecord): number {
  const total = (job.understanding?.questions || []).filter(
    (q) =>
      q.kind === 'knockout' &&
      q.type === 'boolean' &&
      (job.answers[q.id] === undefined ? q.defaultChecked : job.answers[q.id] === true)
  ).length;
  return Math.max(0, total - rec.knockoutMisses.length);
}

export function recomputeJob(jobId: string, persist = true): Job | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  const recs = resumesOfJob(jobId);
  const cats: ResumeCategory[] = ['INTERVIEW', 'REVIEW', 'REJECT', 'UNJUDGEABLE', 'ERROR'];
  for (const cat of cats) {
    recs
      .filter((r) => r.category === cat)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ka = knockoutsSatisfied(job, a);
        const kb = knockoutsSatisfied(job, b);
        if (ka !== kb) return kb - ka;
        const ya = a.facts?.yearsExperience ?? -1;
        const yb = b.facts?.yearsExperience ?? -1;
        if (ya !== yb) return yb - ya;
        return a.createdAtISO.localeCompare(b.createdAtISO);
      })
      .forEach((r, i) => (r.rankInCategory = i + 1));
  }
  const scored = recs.filter((r) => r.category === 'INTERVIEW' || r.category === 'REVIEW' || r.category === 'REJECT');
  job.stats = {
    total: recs.length,
    interview: recs.filter((r) => r.category === 'INTERVIEW').length,
    review: recs.filter((r) => r.category === 'REVIEW').length,
    reject: recs.filter((r) => r.category === 'REJECT').length,
    unjudgeable: recs.filter((r) => r.category === 'UNJUDGEABLE').length,
    error: recs.filter((r) => r.category === 'ERROR').length,
    approved: recs.filter((r) => r.decisionStatus === 'approved').length,
    rejected: recs.filter((r) => r.decisionStatus === 'rejected').length,
    reviewDecision: recs.filter((r) => r.decisionStatus === 'review').length,
    undecided: recs.filter((r) => r.decisionStatus === 'none' && r.category !== 'ERROR').length,
    avgScore: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : 0,
  };
  if (persist) scheduleSave();
  return job;
}

// ---------------------------------------------------------------- resumes ----

function categoryFromEvaluation(ev: CandidateEvaluation, extractionReason: string | null): ResumeCategory {
  if (extractionReason) return 'UNJUDGEABLE';
  if (ev.flags.scannedNoText || ev.flags.insufficientInfo || ev.flags.notResume) return 'UNJUDGEABLE';
  return ev.recommendation;
}

export function getResume(orgId: string, id: string): ResumeRecord | null {
  const r = resumes.get(id);
  return r && r.orgId === orgId ? r : null;
}

/** Unscoped lookup — only for HMAC-signed file URLs. */
export function getResumeUnsafe(id: string): ResumeRecord | null {
  return resumes.get(id) || null;
}

export function toListItem(r: ResumeRecord): ResumeListItem {
  const { extractedText: _t, ...rest } = r;
  return rest;
}

export async function saveEvaluation(input: {
  job: Job;
  uploadedBy: string | null;
  fileName: string;
  extractedText: string;
  unjudgeableReason: string | null;
  fileBase64?: string;
  evaluation?: CandidateEvaluation;
  errorMessage?: string;
  at?: Date;
  /** How the file was read, when there is no evaluation to carry it. */
  meta?: EvaluationMeta | null;
}): Promise<ResumeRecord> {
  const { job } = input;
  const stamp = nowStamp(input.at);
  const id = uid('res');
  const file = await writeResumeFile(job.orgId || 'legacy', job.id, id, input.fileName, input.fileBase64);
  const ev = input.evaluation;
  const isError = !ev && !input.unjudgeableReason;
  const category: ResumeCategory = ev
    ? categoryFromEvaluation(ev, input.unjudgeableReason)
    : input.unjudgeableReason
    ? 'UNJUDGEABLE'
    : 'ERROR';

  const record: ResumeRecord = {
    id,
    jobId: job.id,
    orgId: job.orgId,
    uploadedBy: input.uploadedBy,
    departmentId: job.departmentId,
    departmentName: job.departmentName,
    roleTitle: job.roleTitle || null,
    fileName: input.fileName.slice(0, 200),
    filePath: file?.relPath || null,
    fileSize: file?.size ?? null,
    extractedText: (input.extractedText || '').slice(0, 20000),
    unjudgeableReason: input.unjudgeableReason,
    errorMessage: isError ? input.errorMessage || 'خطا در تحلیل' : null,
    candidateName: ev?.candidateName || null,
    contact: ev?.contact || null,
    facts: ev?.facts || null,
    criterionScores: ev?.criterionScores || [],
    score: ev?.score || 0,
    confidence: ev?.confidence || null,
    engine: ev?.engine || null,
    recommendation: ev?.recommendation || null,
    summary: ev?.summary || '',
    whyCategory: ev?.whyCategory || '',
    strengths: ev?.strengths || [],
    weaknesses: ev?.weaknesses || [],
    knockoutMisses: ev?.knockoutMisses || [],
    tags: ev?.tags || [],
    bankSuggested: ev?.bankSuggested || false,
    flags: ev?.flags || null,
    deepFindings: ev?.deepFindings || null,
    analysisMeta: ev?.meta || input.meta || null,
    category,
    rankInCategory: null,
    analysisHistory: ev
      ? [{ score: ev.score, atJalali: stamp.jalali, atISO: stamp.iso, reason: 'initial', engine: ev.engine }]
      : [],
    inBank: false,
    bankDepartmentId: null,
    bankNote: null,
    bankTags: [],
    addedToBankAtJalali: null,
    addedToBankAtISO: null,
    messageStatus: 'none',
    lastMessagedAtJalali: null,
    decisionStatus: 'none',
    decidedAtJalali: null,
    decidedAtISO: null,
    decidedBy: null,
    decidedByName: null,
    decisionNote: null,
    deepAnalysisAtJalali: null,
    createdAtISO: stamp.iso,
    createdAtJalali: stamp.jalali,
    updatedAtISO: stamp.iso,
  };
  resumes.set(id, record);
  job.updatedAtISO = stamp.iso;
  recomputeJob(job.id);
  return record;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  cover_letter: 'فقط نامه همراه (کاورلتر) است',
  certificate: 'گواهی‌نامه یا مدرک تحصیلی است',
  id_document: 'مدرک هویتی است',
  job_description: 'آگهی یا شرح شغل است',
  form: 'فرم خام یا خالی است',
  other: 'سند دیگری غیر از رزومه است',
};

/** Persian reason shown for UNJUDGEABLE evaluations (null when judgeable). */
export function unjudgeableReasonOf(ev: CandidateEvaluation): string | null {
  if (ev.flags.notResume) {
    const type = ev.meta?.documentType || 'other';
    return `این فایل رزومه نیست؛ به نظر می‌رسد ${DOCUMENT_TYPE_LABELS[type] || DOCUMENT_TYPE_LABELS.other}.`;
  }
  if (ev.flags.scannedNoText) return 'فایل رزومه محتوای خواندنی ندارد (فایل خالی، اسکن ناخوانا یا تصویر بدون متن).';
  if (ev.flags.insufficientInfo) return 'اطلاعات رزومه برای سنجش با معیارهای این فرصت شغلی کافی نیست.';
  return null;
}

export function updateResumeEvaluation(rec: ResumeRecord, ev: CandidateEvaluation, mode: 'rerun' | 'deep'): ResumeRecord {
  const stamp = nowStamp();
  Object.assign(rec, {
    unjudgeableReason: unjudgeableReasonOf(ev),
    errorMessage: null,
    candidateName: ev.candidateName,
    contact: ev.contact,
    facts: ev.facts,
    criterionScores: ev.criterionScores,
    score: ev.score,
    confidence: ev.confidence,
    engine: ev.engine,
    recommendation: ev.recommendation,
    summary: ev.summary,
    whyCategory: ev.whyCategory,
    strengths: ev.strengths,
    weaknesses: ev.weaknesses,
    knockoutMisses: ev.knockoutMisses,
    tags: ev.tags,
    bankSuggested: ev.bankSuggested,
    flags: ev.flags,
    deepFindings: ev.deepFindings || null,
    analysisMeta: ev.meta || rec.analysisMeta || null,
    category: categoryFromEvaluation(ev, null),
    updatedAtISO: stamp.iso,
  });
  const entry: AnalysisHistoryEntry = {
    score: ev.score,
    atJalali: stamp.jalali,
    atISO: stamp.iso,
    reason: mode,
    engine: ev.engine,
    mode: mode === 'deep' ? 'deep' : 'standard',
  };
  rec.analysisHistory.push(entry);
  if (mode === 'deep' && ev.engine === 'ai') rec.deepAnalysisAtJalali = stamp.jalali;
  recomputeJob(rec.jobId);
  return rec;
}

/** Calibration adjustments are recorded in the history (they used to be silent). */
export function applyCalibration(rec: ResumeRecord, score: number, recommendation: Recommendation) {
  if (score === rec.score) return;
  const stamp = nowStamp();
  rec.score = score;
  rec.recommendation = recommendation;
  if (rec.category !== 'UNJUDGEABLE' && rec.category !== 'ERROR') rec.category = recommendation;
  rec.analysisHistory.push({ score, atJalali: stamp.jalali, atISO: stamp.iso, reason: 'calibration', engine: rec.engine || 'ai' });
  rec.updatedAtISO = stamp.iso;
}

export async function attachResumeFile(rec: ResumeRecord, fileName: string, base64: string): Promise<boolean> {
  const file = await writeResumeFile(rec.orgId || 'legacy', rec.jobId, rec.id, fileName, base64);
  if (!file) return false;
  if (rec.filePath && rec.filePath !== file.relPath) deleteFileQuietly(rec.filePath);
  rec.filePath = file.relPath;
  rec.fileSize = file.size;
  scheduleSave();
  return true;
}

/** Hard delete: the record and the original file are both removed. */
export function deleteResume(rec: ResumeRecord) {
  deleteFileQuietly(rec.filePath);
  resumes.delete(rec.id);
  recomputeJob(rec.jobId);
}

export function setDecision(
  rec: ResumeRecord,
  status: DecisionStatus,
  note: string | null,
  actor: { id: string; name: string } | null,
  at?: Date
): ResumeRecord {
  if (status === 'none') {
    rec.decisionStatus = 'none';
    rec.decidedAtJalali = null;
    rec.decidedAtISO = null;
    rec.decidedBy = null;
    rec.decidedByName = null;
    rec.decisionNote = null;
  } else {
    const stamp = nowStamp(at);
    rec.decisionStatus = status;
    rec.decidedAtJalali = stamp.jalali;
    rec.decidedAtISO = stamp.iso;
    rec.decidedBy = actor?.id ?? null;
    rec.decidedByName = actor?.name ?? null;
    const clean = typeof note === 'string' ? note.trim().slice(0, 400) : '';
    rec.decisionNote = clean || null;
  }
  rec.updatedAtISO = new Date().toISOString();
  recomputeJob(rec.jobId);
  return rec;
}

export function markMessageSent(rec: ResumeRecord): ResumeRecord {
  rec.messageStatus = 'sent';
  rec.lastMessagedAtJalali = tehranNow().jalaliString;
  scheduleSave();
  return rec;
}

export function addToTalent(rec: ResumeRecord, departmentId: string, note: string, tags: string[], at?: Date): ResumeRecord {
  const stamp = nowStamp(at);
  rec.inBank = true;
  rec.bankDepartmentId = departmentId;
  rec.bankNote = note.trim().slice(0, 400) || null;
  rec.bankTags = Array.from(new Set(tags.map((t) => t.trim()).filter(Boolean))).slice(0, 12);
  rec.addedToBankAtJalali = stamp.jalali;
  rec.addedToBankAtISO = stamp.iso;
  scheduleSave();
  return rec;
}

export function removeFromTalent(rec: ResumeRecord): ResumeRecord {
  rec.inBank = false;
  rec.bankDepartmentId = null;
  rec.bankNote = null;
  rec.bankTags = [];
  rec.addedToBankAtJalali = null;
  rec.addedToBankAtISO = null;
  scheduleSave();
  return rec;
}

// ---------------------------------------------------------------- queries ----

function orgResumes(orgId: string): ResumeRecord[] {
  const out: ResumeRecord[] = [];
  for (const r of resumes.values()) if (r.orgId === orgId) out.push(r);
  return out;
}

function searchHaystack(r: ResumeRecord): Array<string | null | undefined> {
  return [
    r.candidateName,
    r.fileName,
    r.roleTitle,
    r.departmentName,
    r.facts?.lastRole,
    r.facts?.education,
    r.facts?.skills?.join(' '),
    r.tags.join(' '),
    r.bankTags.join(' '),
    r.contact?.city,
    r.contact?.email,
    r.contact?.phone,
    r.decisionNote,
    r.bankNote,
  ];
}

const isHigh = (r: ResumeRecord) => r.category === 'INTERVIEW';
const isReviewCat = (r: ResumeRecord) => r.category === 'REVIEW';
const isLow = (r: ResumeRecord) => r.category === 'REJECT';
const isInsufficient = (r: ResumeRecord) => r.category === 'UNJUDGEABLE' || r.category === 'ERROR';
/** Undecided candidates worth a human look. */
const isPending = (r: ResumeRecord) => r.decisionStatus === 'none' && (isHigh(r) || isReviewCat(r));

function jalaliOfISO(iso: string | null | undefined) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return tehranJalaliOf(d);
}

export function queryResumes(orgId: string, q: ResumeQuery): ResumePage {
  const pageSize = Math.min(100, Math.max(1, q.pageSize || 10));
  const decidedList = q.decision === 'approved' || q.decision === 'rejected' || q.decision === 'review';
  const from = parseJalaliDateString(q.fromJalali || null);
  const to = parseJalaliDateString(q.toJalali || null);

  let pool = orgResumes(orgId).filter((r) => {
    if (q.jobId && r.jobId !== q.jobId) return false;
    if (q.departmentId && q.departmentId !== 'all' && r.departmentId !== q.departmentId) return false;
    if (q.minScore && r.score < q.minScore) return false;
    if (q.minYears && (r.facts?.yearsExperience ?? -1) < q.minYears) return false;
    if (q.q && !matchesSearch(searchHaystack(r), q.q)) return false;
    if (from || to) {
      const day = jalaliOfISO(decidedList ? r.decidedAtISO || r.createdAtISO : r.createdAtISO);
      if (!day) return false;
      if (from && compareJalali(day, from) < 0) return false;
      if (to && compareJalali(day, to) > 0) return false;
    }
    return true;
  });

  const counts: ResumeCounts = {
    all: pool.length,
    high: pool.filter(isHigh).length,
    review: pool.filter(isReviewCat).length,
    low: pool.filter(isLow).length,
    insufficient: pool.filter(isInsufficient).length,
    undecided: pool.filter((r) => r.decisionStatus === 'none').length,
    pending: pool.filter(isPending).length,
    approved: pool.filter((r) => r.decisionStatus === 'approved').length,
    rejected: pool.filter((r) => r.decisionStatus === 'rejected').length,
    reviewDecision: pool.filter((r) => r.decisionStatus === 'review').length,
  };

  switch (q.match) {
    case 'high': pool = pool.filter(isHigh); break;
    case 'review': pool = pool.filter(isReviewCat); break;
    case 'low': pool = pool.filter(isLow); break;
    case 'insufficient': pool = pool.filter(isInsufficient); break;
  }
  switch (q.decision) {
    case 'undecided': pool = pool.filter((r) => r.decisionStatus === 'none'); break;
    case 'pending': pool = pool.filter(isPending); break;
    case 'approved':
    case 'rejected':
    case 'review':
      pool = pool.filter((r) => r.decisionStatus === q.decision);
      break;
  }

  const catOrder: Record<ResumeCategory, number> = { INTERVIEW: 0, REVIEW: 1, REJECT: 2, UNJUDGEABLE: 3, ERROR: 4 };
  const sort = q.sort || 'match';
  pool.sort((a, b) => {
    switch (sort) {
      case 'newest': return b.createdAtISO.localeCompare(a.createdAtISO);
      case 'oldest': return a.createdAtISO.localeCompare(b.createdAtISO);
      case 'experience': return (b.facts?.yearsExperience ?? -1) - (a.facts?.yearsExperience ?? -1) || b.score - a.score;
      case 'name': return (a.candidateName || a.fileName).localeCompare(b.candidateName || b.fileName, 'fa');
      case 'decided': return (b.decidedAtISO || b.createdAtISO).localeCompare(a.decidedAtISO || a.createdAtISO);
      default: {
        const ia = isInsufficient(a) ? 1 : 0;
        const ib = isInsufficient(b) ? 1 : 0;
        if (ia !== ib) return ia - ib;
        if (b.score !== a.score) return b.score - a.score;
        return catOrder[a.category] - catOrder[b.category] || (a.rankInCategory ?? 99) - (b.rankInCategory ?? 99);
      }
    }
  });

  const total = pool.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, q.page || 1), totalPages);
  const start = (page - 1) * pageSize;
  return {
    items: pool.slice(start, start + pageSize).map(toListItem),
    page,
    pageSize,
    total,
    totalPages,
    counts,
  };
}

/** Same-job candidates for side-by-side comparison (max 4, org-scoped). */
export function getComparable(orgId: string, ids: string[]): ResumeRecord[] {
  const list = ids
    .slice(0, 4)
    .map((id) => getResume(orgId, id))
    .filter((r): r is ResumeRecord => Boolean(r));
  if (!list.length) return [];
  const jobId = list[0].jobId;
  return list.filter((r) => r.jobId === jobId);
}

// ----------------------------------------------------------------- talent ----

export function talentDepartments(org: OrgRecord): TalentDepartment[] {
  const counts = new Map<string, { name: string; count: number }>();
  for (const r of orgResumes(org.id)) {
    if (!r.inBank || !r.bankDepartmentId) continue;
    const prev = counts.get(r.bankDepartmentId);
    if (prev) prev.count++;
    else counts.set(r.bankDepartmentId, { name: r.bankDepartmentId === r.departmentId ? r.departmentName : 'دپارتمان حذف‌شده', count: 1 });
  }
  const out: TalentDepartment[] = org.departments.map((d) => ({ id: d.id, name: d.name, count: counts.get(d.id)?.count || 0 }));
  for (const [id, v] of counts) if (!out.some((d) => d.id === id)) out.push({ id, name: v.name, count: v.count });
  return out;
}

export function talentTags(orgId: string): string[] {
  const set = new Map<string, number>();
  for (const r of orgResumes(orgId)) {
    if (!r.inBank) continue;
    for (const t of [...r.bankTags, ...r.tags]) set.set(t, (set.get(t) || 0) + 1);
  }
  return Array.from(set.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map(([t]) => t);
}

export function queryTalent(
  orgId: string,
  f: { departmentId?: string; q?: string; tags?: string[]; minScore?: number; minYears?: number; sort?: string; page?: number; pageSize?: number }
): PagedResult<ResumeListItem> {
  const pageSize = Math.min(50, Math.max(1, f.pageSize || 12));
  let items = orgResumes(orgId).filter((r) => r.inBank);
  if (f.departmentId && f.departmentId !== 'all') items = items.filter((r) => r.bankDepartmentId === f.departmentId);
  if (f.q) items = items.filter((r) => matchesSearch(searchHaystack(r), f.q || ''));
  if (f.minScore) items = items.filter((r) => r.score >= (f.minScore || 0));
  if (f.minYears) items = items.filter((r) => (r.facts?.yearsExperience ?? -1) >= (f.minYears || 0));
  if (f.tags?.length) items = items.filter((r) => f.tags!.every((t) => r.bankTags.includes(t) || r.tags.includes(t)));
  const sort = f.sort || 'newest';
  items.sort((a, b) => {
    if (sort === 'score') return b.score - a.score;
    if (sort === 'experience') return (b.facts?.yearsExperience ?? -1) - (a.facts?.yearsExperience ?? -1);
    return (b.addedToBankAtISO || '').localeCompare(a.addedToBankAtISO || '');
  });
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, f.page || 1), totalPages);
  return { items: items.slice((page - 1) * pageSize, page * pageSize).map(toListItem), page, pageSize, total, totalPages };
}

// --------------------------------------------------------------- insights ----

function timeSavedFor(resumeCount: number) {
  const hours = Math.round(((resumeCount * (MANUAL_MINUTES_PER_RESUME - ASSISTED_MINUTES_PER_RESUME)) / 60) * 10) / 10;
  return {
    hours,
    resumes: resumeCount,
    minutesManual: MANUAL_MINUTES_PER_RESUME,
    minutesWithHovida: ASSISTED_MINUTES_PER_RESUME,
  };
}

export function dashboard(orgId: string): DashboardData {
  const all = orgResumes(orgId);
  const analyzed = all.filter((r) => r.category !== 'ERROR');
  const cutoff = Date.now() - 30 * 86400_000;
  const orgJobs = listJobs(orgId);
  return {
    kpis: {
      openJobs: orgJobs.filter((j) => j.status === 'open').length,
      totalJobs: orgJobs.length,
      analyzed30d: analyzed.filter((r) => new Date(r.createdAtISO).getTime() >= cutoff).length,
      analyzedAll: analyzed.length,
      pendingDecisions: all.filter(isPending).length,
      highMatch: all.filter(isHigh).length,
      decided30d: all.filter((r) => r.decidedAtISO && new Date(r.decidedAtISO).getTime() >= cutoff).length,
    },
    timeSaved: timeSavedFor(analyzed.length),
    pending: all
      .filter(isPending)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(toListItem),
    jobs: orgJobs
      .filter((j) => j.status !== 'closed')
      .sort((a, b) => b.updatedAtISO.localeCompare(a.updatedAtISO))
      .slice(0, 6)
      .map(toJobSummary),
    activity: listActivity(orgId, 8),
    aiShare: {
      ai: analyzed.filter((r) => r.engine === 'ai').length,
      local: analyzed.filter((r) => r.engine === 'local').length,
    },
  };
}

function jalaliLabel(iso: string, mode: 'day' | 'week' | 'month'): { key: string; label: string } {
  const d = tehranWallDate(new Date(iso));
  if (mode === 'week') {
    // bucket by Saturday (Iranian week start)
    const day = (d.getDay() + 1) % 7; // Sat=0
    d.setDate(d.getDate() - day);
  }
  const j = gregorianToJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
  if (mode === 'month') {
    return { key: `${j.year}-${String(j.month).padStart(2, '0')}`, label: `${JALALI_MONTH_NAMES[j.month - 1]} ${toPersianDigits(j.year)}` };
  }
  return {
    key: `${j.year}-${String(j.month).padStart(2, '0')}-${String(j.day).padStart(2, '0')}`,
    label: `${toPersianDigits(j.day)} ${JALALI_MONTH_NAMES[j.month - 1]}`,
  };
}

export function reports(orgId: string, range: ReportRange): ReportsData {
  const days = range === 'all' ? null : Number(range);
  const cutoff = days ? Date.now() - days * 86400_000 : 0;
  const all = orgResumes(orgId);
  const inRange = all.filter((r) => new Date(r.createdAtISO).getTime() >= cutoff);
  const analyzed = inRange.filter((r) => r.category !== 'ERROR');
  const decidedInRange = all.filter((r) => r.decidedAtISO && new Date(r.decidedAtISO).getTime() >= cutoff);
  const mode: 'day' | 'week' | 'month' = range === '30' ? 'day' : range === '90' ? 'week' : 'month';

  // Timeline buckets — continuous (empty buckets included) so the chart is honest.
  const buckets = new Map<string, { key: string; label: string; analyzed: number; high: number; approved: number }>();
  const startTs = days
    ? cutoff
    : Math.min(Date.now(), ...analyzed.map((r) => new Date(r.createdAtISO).getTime()));
  const step = mode === 'day' ? 86400_000 : mode === 'week' ? 7 * 86400_000 : 28 * 86400_000;
  for (let t = startTs; t <= Date.now() + step; t += step) {
    const { key, label } = jalaliLabel(new Date(Math.min(t, Date.now())).toISOString(), mode);
    if (!buckets.has(key)) buckets.set(key, { key, label, analyzed: 0, high: 0, approved: 0 });
  }
  for (const r of analyzed) {
    const { key, label } = jalaliLabel(r.createdAtISO, mode);
    const b = buckets.get(key) || { key, label, analyzed: 0, high: 0, approved: 0 };
    b.analyzed++;
    if (isHigh(r)) b.high++;
    buckets.set(key, b);
  }
  for (const r of decidedInRange) {
    if (r.decisionStatus !== 'approved' || !r.decidedAtISO) continue;
    const { key, label } = jalaliLabel(r.decidedAtISO, mode);
    const b = buckets.get(key) || { key, label, analyzed: 0, high: 0, approved: 0 };
    b.approved++;
    buckets.set(key, b);
  }
  let timeline = Array.from(buckets.values()).sort((a, b) => a.key.localeCompare(b.key));
  if (mode === 'month' && timeline.length > 24) timeline = timeline.slice(-24);

  const cats: ResumeCategory[] = ['INTERVIEW', 'REVIEW', 'REJECT', 'UNJUDGEABLE', 'ERROR'];
  const deptMap = new Map<string, { departmentId: string; name: string; analyzed: number; high: number; approved: number }>();
  for (const r of analyzed) {
    const d = deptMap.get(r.departmentId) || { departmentId: r.departmentId, name: r.departmentName, analyzed: 0, high: 0, approved: 0 };
    d.analyzed++;
    if (isHigh(r)) d.high++;
    if (r.decisionStatus === 'approved') d.approved++;
    deptMap.set(r.departmentId, d);
  }
  const skillMap = new Map<string, number>();
  for (const r of analyzed.filter(isHigh)) for (const s of r.facts?.skills || []) skillMap.set(s, (skillMap.get(s) || 0) + 1);

  const scored = analyzed.filter((r) => !isInsufficient(r));
  const orgJobs = listJobs(orgId).filter((j) => !days || new Date(j.updatedAtISO).getTime() >= cutoff || j.status === 'open');
  return {
    range,
    totals: {
      analyzed: analyzed.length,
      jobs: listJobs(orgId).filter((j) => new Date(j.createdAtISO).getTime() >= cutoff).length,
      highMatch: analyzed.filter(isHigh).length,
      avgScore: scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : 0,
      decided: decidedInRange.length,
      approved: decidedInRange.filter((r) => r.decisionStatus === 'approved').length,
      rejected: decidedInRange.filter((r) => r.decisionStatus === 'rejected').length,
      talentAdded: all.filter((r) => r.inBank && r.addedToBankAtISO && new Date(r.addedToBankAtISO).getTime() >= cutoff).length,
      deepReviews: inRange.filter((r) => r.deepAnalysisAtJalali).length,
    },
    timeline,
    distribution: cats.map((c) => ({ category: c, count: inRange.filter((r) => r.category === c).length })),
    byDepartment: Array.from(deptMap.values()).sort((a, b) => b.analyzed - a.analyzed),
    funnel: {
      analyzed: analyzed.length,
      matched: analyzed.filter((r) => isHigh(r) || isReviewCat(r)).length,
      decided: analyzed.filter((r) => r.decisionStatus !== 'none').length,
      approved: analyzed.filter((r) => r.decisionStatus === 'approved').length,
    },
    topSkills: Array.from(skillMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skill, count]) => ({ skill, count })),
    engines: {
      ai: analyzed.filter((r) => r.engine === 'ai').length,
      local: analyzed.filter((r) => r.engine === 'local').length,
    },
    jobs: orgJobs.map((j) => ({
      id: j.id,
      roleTitle: j.roleTitle || j.departmentName,
      departmentName: j.departmentName,
      status: j.status,
      total: j.stats.total,
      high: j.stats.interview,
      approved: j.stats.approved,
      avgScore: j.stats.avgScore,
    })),
    timeSaved: timeSavedFor(analyzed.length),
  };
}

export function search(orgId: string, query: string): SearchResults {
  if (!query.trim()) return { jobs: [], candidates: [] };
  const jobHits = listJobs(orgId)
    .filter((j) => matchesSearch([j.roleTitle, j.departmentName, j.location, j.extraNotes], query))
    .slice(0, 5)
    .map((j) => ({ id: j.id, roleTitle: j.roleTitle || j.departmentName, departmentName: j.departmentName, status: j.status, total: j.stats.total }));
  const candHits = orgResumes(orgId)
    .filter((r) => matchesSearch(searchHaystack(r), query))
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map((r) => ({
      id: r.id,
      name: r.candidateName || r.fileName,
      jobId: r.jobId,
      roleTitle: r.roleTitle || r.departmentName,
      lastRole: r.facts?.lastRole || null,
      score: r.score,
      category: r.category,
    }));
  return { jobs: jobHits, candidates: candHits };
}

/** Test/QA helper — counts per collection. */
export function storeCounts() {
  return { orgs: orgs.size, users: users.size, jobs: jobs.size, resumes: resumes.size, activity: activity.length };
}

// ---------------------------------------------------- platform (/admin) ----

export function getPlatformBlob(): unknown {
  return platformBlob;
}

export function setPlatformBlob(value: unknown) {
  platformBlob = value;
  scheduleSave();
}

export function getAiStatsBlob(): unknown {
  return aiStatsBlob;
}

export function setAiStatsBlob(value: unknown) {
  aiStatsBlob = value;
  scheduleSave();
}

const AUDIT_CAP = 3000;

export function appendAudit(item: Omit<AuditItem, 'id' | 'atISO'>): AuditItem {
  const full: AuditItem = { id: uid('aud'), atISO: new Date().toISOString(), ...item };
  auditLog.unshift(full);
  if (auditLog.length > AUDIT_CAP) auditLog.length = AUDIT_CAP;
  scheduleSave();
  return full;
}

export function listAudit(limit = 300, query = ''): AuditItem[] {
  const q = query.trim();
  const items = q ? auditLog.filter((a) => matchesSearch([a.actorName, a.action, a.target, a.detail], q)) : auditLog;
  return items.slice(0, Math.max(1, Math.min(1000, limit)));
}

export function allOrgs(): OrgRecord[] {
  return Array.from(orgs.values());
}

export function allUsers(): UserRecord[] {
  return Array.from(users.values());
}

export function sessionsOfUser(userId: string): SessionRecord[] {
  const now = Date.now();
  return Array.from(sessions.values()).filter((s) => s.userId === userId && s.expiresAt > now);
}

export function setOrgSuspended(id: string, suspended: boolean, reason: string | null): OrgRecord | null {
  const org = orgs.get(id);
  if (!org) return null;
  org.suspended = suspended;
  org.suspendedReason = suspended ? (reason || '').slice(0, 300) || null : null;
  scheduleSave();
  return org;
}

export function extendDemo(id: string, hours: number): OrgRecord | null {
  const org = orgs.get(id);
  if (!org || !org.isDemo) return null;
  const base = Math.max(Date.now(), org.demoExpiresAt ? new Date(org.demoExpiresAt).getTime() : 0);
  org.demoExpiresAt = new Date(base + hours * 3600_000).toISOString();
  scheduleSave();
  return org;
}

/** A demo workspace kept by the operator becomes a regular one (no expiry). */
export function convertDemoToRegular(id: string): OrgRecord | null {
  const org = orgs.get(id);
  if (!org) return null;
  org.isDemo = false;
  org.demoExpiresAt = null;
  scheduleSave();
  return org;
}

export function orgUsage(orgId: string): { members: number; jobs: number; resumes: number; lastActivityISO: string | null } {
  let members = 0;
  for (const u of users.values()) if (u.orgId === orgId) members++;
  let jobCount = 0;
  for (const j of jobs.values()) if (j.orgId === orgId) jobCount++;
  let resumeCount = 0;
  let last: string | null = null;
  for (const r of resumes.values()) {
    if (r.orgId !== orgId) continue;
    resumeCount++;
    const at = r.updatedAtISO || r.createdAtISO;
    if (at && (!last || at > last)) last = at;
  }
  for (const a of activity) {
    if (a.orgId === orgId) {
      if (!last || a.atISO > last) last = a.atISO;
      break; // newest first
    }
  }
  return { members, jobs: jobCount, resumes: resumeCount, lastActivityISO: last };
}

export function platformTotals() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const resumeList = Array.from(resumes.values());
  const formatCounts = new Map<string, number>();
  for (const r of resumeList) {
    const f = r.analysisMeta?.format || (r.fileName.includes('.') ? r.fileName.split('.').pop()!.toUpperCase() : '—');
    formatCounts.set(f, (formatCounts.get(f) || 0) + 1);
  }
  return {
    orgs: {
      total: orgs.size,
      demo: Array.from(orgs.values()).filter((o) => o.isDemo).length,
      suspended: Array.from(orgs.values()).filter((o) => o.suspended).length,
      newThisWeek: Array.from(orgs.values()).filter((o) => o.createdAtISO >= weekAgo).length,
    },
    users: {
      total: users.size,
      disabled: Array.from(users.values()).filter((u) => u.disabled).length,
      activeThisWeek: Array.from(users.values()).filter((u) => (u.lastLoginISO || '') >= weekAgo).length,
    },
    jobs: { total: jobs.size, open: Array.from(jobs.values()).filter((j) => j.status === 'open').length },
    resumes: {
      total: resumeList.length,
      thisWeek: resumeList.filter((r) => r.createdAtISO >= weekAgo).length,
      aiEngine: resumeList.filter((r) => r.engine === 'ai').length,
      localEngine: resumeList.filter((r) => r.engine === 'local').length,
      unjudgeable: resumeList.filter((r) => r.category === 'UNJUDGEABLE').length,
    },
    formats: Array.from(formatCounts.entries())
      .map(([format, count]) => ({ format, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

/** Resumes analysed and workspaces created per day (Tehran calendar), oldest first. */
export function platformDaily(days = 14): Array<{ day: string; resumes: number; signups: number }> {
  const out: Array<{ day: string; resumes: number; signups: number; key: string }> = [];
  const keyOf = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : formatJalaliDate(tehranJalaliOf(d), false);
  };
  for (let i = days - 1; i >= 0; i--) {
    const key = formatJalaliDate(tehranJalaliOf(new Date(Date.now() - i * 24 * 3600_000)), false);
    out.push({ day: key, resumes: 0, signups: 0, key });
  }
  const index = new Map(out.map((d, i) => [d.key, i]));
  const since = new Date(Date.now() - (days + 1) * 24 * 3600_000).toISOString();
  for (const r of resumes.values()) {
    if (r.createdAtISO < since) continue;
    const i = index.get(keyOf(r.createdAtISO));
    if (i !== undefined) out[i].resumes++;
  }
  for (const o of orgs.values()) {
    if (o.isDemo || o.createdAtISO < since) continue;
    const i = index.get(keyOf(o.createdAtISO));
    if (i !== undefined) out[i].signups++;
  }
  return out.map(({ key: _k, ...rest }) => rest);
}

let storageCache: { at: number; bytes: number } | null = null;

/** Bytes used by stored resume files (cached for a minute). */
export async function storageBytes(): Promise<number> {
  if (storageCache && Date.now() - storageCache.at < 60_000) return storageCache.bytes;
  let total = 0;
  async function walk(dir: string) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[]);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else total += (await fs.promises.stat(full).catch(() => null))?.size || 0;
    }
  }
  await walk(RESUMES_DIR);
  try {
    total += (await fs.promises.stat(STORE_FILE)).size;
  } catch {
    /* no snapshot yet */
  }
  storageCache = { at: Date.now(), bytes: total };
  return total;
}

/** Jobs of any workspace (platform admin test lab). */
export function allJobsBrief(limit = 300): Array<{ id: string; orgId: string | null; orgName: string; title: string; departmentName: string }> {
  return Array.from(jobs.values())
    .sort((a, b) => (b.updatedAtISO || '').localeCompare(a.updatedAtISO || ''))
    .slice(0, limit)
    .map((j) => ({
      id: j.id,
      orgId: j.orgId,
      orgName: (j.orgId && orgs.get(j.orgId)?.name) || '—',
      title: j.roleTitle || j.departmentName,
      departmentName: j.departmentName,
    }));
}

export function getJobUnsafe(id: string): Job | null {
  return jobs.get(id) || null;
}

/**
 * Platform administration API — /api/admin/* (the /admin panel).
 *
 * Only platform admins (ADMIN_EMAILS, a flag set in /admin, or whoever
 * redeemed the one-time setup code) may call it. Every change is written to
 * the audit log. Support sessions opened from here can never reach /admin.
 */
import crypto from 'crypto';
import express from 'express';
import * as db from '../db';
import { RateLimiter, clientIp, ctxOf, hashPassword, signedBackupUrl } from '../auth';
import {
  MAX_AI_KEYS,
  PlatformInputError,
  addKey,
  aiSettings,
  audit,
  claimWithSetupCode,
  deleteKey,
  envForcedOff,
  isEnvAdmin,
  isPlatformAdmin,
  listKeysPublic,
  poolEntries,
  reorderKeys,
  setupPending,
  systemSettings,
  updateAiSettings,
  updateKey,
  updateSystemSettings,
} from '../platform';
import * as pool from '../ai/keypool';
import { aiStatus, recentCalls, testKey, type AiFile } from '../ai/provider';
import {
  buildSystemPrompt,
  currentBehavior,
  defaultBehavior,
  detectIndustry,
  resetBehavior,
  restoreBehaviorVersion,
  sanitizeBehavior,
  saveBehavior,
} from '../ai/behavior';
import { behaviorHistory } from '../platform';
import { buildTemplateUnderstanding, evaluateResume } from '../ai/screening';
import { ingestDocument } from '../ingest';
import type {
  AdminOrgRow,
  AdminOverview,
  AdminUserRow,
  AiKeyPublic,
  AiSettingsPublic,
  BackupInfo,
  BehaviorPayload,
  KeyStrategy,
  LabResult,
  SystemSettings,
} from '../../src/types/admin';
import type { Role } from '../../src/types/app';
import type { Job } from '../../src/types/screening';
import { matchesSearch } from '../../src/lib/normalizeFa';
import { h, int, oneOf, str } from './util';
import { appVersion } from '../version';
import {
  BackupError,
  MAX_BACKUP_BYTES,
  RESTORE_CHUNK_BYTES,
  appendChunk,
  applyUpload,
  cancelUpload,
  inspectUpload,
  startUpload,
} from '../backup';

/** Integer within [lo, hi]. */
const num = (v: unknown, fallback: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, int(v, fallback)));

const STARTED_AT = new Date().toISOString();
const claimLimiter = new RateLimiter(8, 15 * 60_000);
const SUPPORT_TTL_MS = 2 * 3600_000;

function requirePlatformAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ctx = ctxOf(req);
  if (ctx.support) return res.status(403).json({ error: 'نشست پشتیبانی به پنل مدیریت دسترسی ندارد.', code: 'SUPPORT_SESSION' });
  if (!isPlatformAdmin(ctx.user)) {
    return res.status(403).json({ error: 'پنل مدیریت فقط برای مدیران سامانه است.', code: 'NOT_PLATFORM_ADMIN' });
  }
  next();
}

function actor(req: express.Request) {
  const { user } = ctxOf(req);
  return { id: user.id, name: `${user.name} (${user.email})` };
}

function log(req: express.Request, action: string, target: string, detail = '') {
  audit(actor(req), clientIp(req), action, target, detail);
}

function inputError(res: express.Response, err: unknown) {
  if (err instanceof PlatformInputError) return res.status(400).json({ error: err.message, field: err.field });
  throw err;
}

function orgRow(o: db.OrgRecord): AdminOrgRow {
  const usage = db.orgUsage(o.id);
  const owner = db.listMembers(o.id).find((u) => u.role === 'owner') || null;
  return {
    id: o.id,
    name: o.name,
    isDemo: o.isDemo,
    suspended: Boolean(o.suspended),
    suspendedReason: o.suspendedReason ?? null,
    createdAtISO: o.createdAtISO,
    demoExpiresAt: o.demoExpiresAt,
    owner: owner ? { id: owner.id, name: owner.name, email: owner.email } : null,
    ...usage,
  };
}

function userRow(u: db.UserRecord): AdminUserRow {
  const org = db.getOrg(u.orgId);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    title: u.title,
    role: u.role,
    orgId: u.orgId,
    orgName: org?.name || '—',
    orgIsDemo: Boolean(org?.isDemo),
    platformAdmin: isPlatformAdmin(u),
    platformAdminViaEnv: isEnvAdmin(u),
    disabled: Boolean(u.disabled),
    createdAtISO: u.createdAtISO,
    lastLoginISO: u.lastLoginISO,
    sessions: db.sessionsOfUser(u.id).length,
  };
}

function aiPayload(): AiSettingsPublic {
  const s = aiSettings();
  const keys = listKeysPublic();
  // Runtime for every listed key (disabled ones too, so their history shows).
  const entries = keys.map(
    (k): pool.PoolEntry => ({
      id: k.id,
      label: k.label,
      provider: k.provider,
      apiKey: '',
      baseUrl: k.baseUrl,
      model: k.model,
      enabled: k.enabled,
      rpm: k.rpm,
      dailyLimit: k.dailyLimit,
      source: k.source,
    })
  );
  const live = new Map(poolEntries().map((e) => [e.id, e]));
  const runtime = entries.map((e) => pool.runtimeOf([live.get(e.id) || e])[0]);
  return {
    enabled: s.enabled,
    envForcedOff: envForcedOff(),
    strategy: s.strategy,
    useEnvKeys: s.useEnvKeys,
    temperature: s.temperature,
    fastTimeoutSec: s.fastTimeoutSec,
    deepTimeoutSec: s.deepTimeoutSec,
    keys: keys as AiKeyPublic[],
    runtime,
    maxKeys: MAX_AI_KEYS,
  };
}

function behaviorPayload(): BehaviorPayload {
  return {
    config: currentBehavior(),
    defaults: defaultBehavior(),
    history: behaviorHistory().map(({ config: _c, ...info }) => info),
  };
}

function tempPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const letters = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
  return `Hv-${letters}-${crypto.randomInt(10, 99)}`;
}

export function adminRoutes(): express.Router {
  const r = express.Router();

  // ------------------------------------------------ access (any signed-in user) ----

  r.get('/me', (req, res) => {
    const { user, support } = ctxOf(req);
    res.json({ isAdmin: !support && isPlatformAdmin(user), setupPending: setupPending() });
  });

  r.post('/claim', (req, res) => {
    const { user, org } = ctxOf(req);
    const ip = clientIp(req);
    const limit = claimLimiter.hit(ip);
    if (!limit.ok) return res.status(429).json({ error: 'تلاش‌های زیادی انجام شد؛ چند دقیقه دیگر دوباره امتحان کنید.' });
    if (org.isDemo) return res.status(403).json({ error: 'با حساب نسخه نمایشی نمی‌توان مدیر سامانه شد؛ با حساب واقعی وارد شوید.' });
    if (!claimWithSetupCode(user, str(req.body?.code, 40))) {
      return res.status(400).json({ error: 'کد راه‌اندازی درست نیست یا قبلاً استفاده شده است.', field: 'code' });
    }
    audit({ id: user.id, name: `${user.name} (${user.email})` }, ip, 'admin.claim', user.email, 'با کد راه‌اندازی یک‌بارمصرف');
    res.json({ ok: true });
  });

  r.use(requirePlatformAdmin);

  // ------------------------------------------------------------- overview ----

  r.get(
    '/overview',
    h(async (_req, res) => {
      const totals = db.platformTotals();
      const entries = poolEntries();
      const runtime = pool.runtimeOf(entries);
      const today = pool.todayTotals();
      const body: AdminOverview = {
        orgs: totals.orgs,
        users: { ...totals.users, admins: db.allUsers().filter((u) => isPlatformAdmin(u)).length },
        jobs: totals.jobs,
        resumes: totals.resumes,
        storageBytes: await db.storageBytes(),
        ai: {
          enabled: aiStatus().available,
          keys: entries.length,
          ready: runtime.filter((x) => x.health === 'ready').length,
          cooling: runtime.filter((x) => x.health === 'cooling' || x.health === 'limited').length,
          invalid: runtime.filter((x) => x.health === 'invalid').length,
          callsToday: today.calls,
          failuresToday: today.failures,
        },
        formats: totals.formats,
        daily: db.platformDaily(14),
        server: {
          startedAtISO: STARTED_AT,
          node: process.version,
          dataDir: db.storeStatus().driver === 'fs' ? db.DATA_DIR : db.storeStatus().location,
          version: appVersion(),
          storage: { driver: db.storeStatus().driver, location: db.storeStatus().location },
        },
      };
      res.json(body);
    })
  );

  // ------------------------------------------------------------ workspaces ----

  r.get('/orgs', (req, res) => {
    const q = str(req.query.q, 80);
    const filter = oneOf(req.query.filter, ['all', 'active', 'demo', 'suspended'] as const, 'all');
    const rows = db
      .allOrgs()
      .filter((o) => (filter === 'demo' ? o.isDemo : filter === 'suspended' ? o.suspended : filter === 'active' ? !o.isDemo && !o.suspended : true))
      .map(orgRow)
      .filter((o) => !q || matchesSearch([o.name, o.owner?.name, o.owner?.email], q))
      .sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO));
    res.json({ items: rows });
  });

  r.patch('/orgs/:id', (req, res) => {
    const org = db.getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'فضای کاری یافت نشد.' });
    const name = typeof req.body?.name === 'string' ? str(req.body.name, 80) : '';
    if (name && name !== org.name) {
      if (name.length < 2) return res.status(400).json({ error: 'نام خیلی کوتاه است.', field: 'name' });
      log(req, 'org.rename', org.name, `→ ${name}`);
      db.updateOrg(org.id, { name });
    }
    if (typeof req.body?.suspended === 'boolean' && req.body.suspended !== Boolean(org.suspended)) {
      if (req.body.suspended && org.id === ctxOf(req).org.id) {
        return res.status(400).json({ error: 'فضای کاری خودتان را نمی‌توانید تعلیق کنید.' });
      }
      const reason = str(req.body?.suspendedReason, 300);
      // Sessions are kept on purpose: the next request of each member is
      // refused with the suspension reason (requireAuth) instead of a vague
      // «session expired», and the session is dropped right then.
      db.setOrgSuspended(org.id, req.body.suspended, reason || null);
      log(req, req.body.suspended ? 'org.suspend' : 'org.unsuspend', org.name, reason);
    }
    res.json({ org: orgRow(db.getOrg(org.id)!) });
  });

  r.post('/orgs/:id/extend-demo', (req, res) => {
    const hours = num(req.body?.hours, 24, 1, 24 * 30);
    const org = db.extendDemo(req.params.id, hours);
    if (!org) return res.status(404).json({ error: 'فضای کاری نمایشی یافت نشد.' });
    log(req, 'org.extend_demo', org.name, `${hours} ساعت`);
    res.json({ org: orgRow(org) });
  });

  r.post('/orgs/:id/convert-demo', (req, res) => {
    const org = db.convertDemoToRegular(req.params.id);
    if (!org) return res.status(404).json({ error: 'فضای کاری یافت نشد.' });
    log(req, 'org.convert_demo', org.name);
    res.json({ org: orgRow(org) });
  });

  r.delete('/orgs/:id', (req, res) => {
    const org = db.getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'فضای کاری یافت نشد.' });
    if (org.id === ctxOf(req).org.id) return res.status(400).json({ error: 'فضای کاری خودتان را از اینجا نمی‌توانید حذف کنید.' });
    if (str(req.body?.confirm, 80) !== org.name) {
      return res.status(400).json({ error: 'برای تأیید، نام فضای کاری را دقیقاً وارد کنید.', field: 'confirm' });
    }
    const usage = db.orgUsage(org.id);
    db.deleteOrg(org.id);
    log(req, 'org.delete', org.name, `${usage.members} عضو، ${usage.jobs} فرصت شغلی، ${usage.resumes} رزومه`);
    res.json({ ok: true });
  });

  /** «ورود پشتیبانی»: a 2-hour session as the workspace owner, opened in a new tab. */
  r.post('/orgs/:id/support', (req, res) => {
    const org = db.getOrg(req.params.id);
    if (!org) return res.status(404).json({ error: 'فضای کاری یافت نشد.' });
    const target = db.listMembers(org.id).find((u) => u.role === 'owner' && !u.disabled) || db.listMembers(org.id).find((u) => !u.disabled);
    if (!target) return res.status(400).json({ error: 'این فضای کاری عضو فعالی ندارد.' });
    const { user } = ctxOf(req);
    const token = sessionFor(target.id, user);
    log(req, 'org.support', org.name, `ورود پشتیبانی به‌جای ${target.email} (۲ ساعت)`);
    res.json({ token, expiresAt: Date.now() + SUPPORT_TTL_MS, user: db.publicUser(target), org });
  });

  function sessionFor(userId: string, admin: db.UserRecord): string {
    const token = crypto.randomBytes(32).toString('base64url');
    db.createSession(userId, crypto.createHash('sha256').update(token).digest('hex'), SUPPORT_TTL_MS, {
      adminId: admin.id,
      adminName: admin.name,
    });
    return token;
  }

  // ----------------------------------------------------------------- users ----

  r.get('/users', (req, res) => {
    const q = str(req.query.q, 80);
    const filter = oneOf(req.query.filter, ['all', 'admins', 'disabled', 'owners'] as const, 'all');
    const orgId = str(req.query.orgId, 60);
    const rows = db
      .allUsers()
      .filter((u) => !orgId || u.orgId === orgId)
      .map(userRow)
      .filter((u) => (filter === 'admins' ? u.platformAdmin : filter === 'disabled' ? u.disabled : filter === 'owners' ? u.role === 'owner' : true))
      .filter((u) => !q || matchesSearch([u.name, u.email, u.orgName, u.title], q))
      .sort((a, b) => b.createdAtISO.localeCompare(a.createdAtISO))
      .slice(0, 1000);
    res.json({ items: rows });
  });

  r.patch('/users/:id', (req, res) => {
    const target = db.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'کاربر یافت نشد.' });
    const me = ctxOf(req).user;
    const patch: Parameters<typeof db.updateUser>[1] = {};
    const changes: string[] = [];
    if (typeof req.body?.name === 'string' && str(req.body.name, 80).length >= 2 && str(req.body.name, 80) !== target.name) {
      patch.name = str(req.body.name, 80);
      changes.push(`نام → ${patch.name}`);
    }
    if (req.body?.role !== undefined) {
      const role = oneOf<Role>(req.body.role, ['owner', 'admin', 'member'], target.role);
      if (role !== target.role) {
        if (target.role === 'owner' && !db.listMembers(target.orgId).some((u) => u.id !== target.id && u.role === 'owner')) {
          return res.status(400).json({ error: 'هر فضای کاری باید دست‌کم یک مالک داشته باشد؛ ابتدا فرد دیگری را مالک کنید.' });
        }
        patch.role = role;
        changes.push(`نقش → ${({ owner: 'مالک', admin: 'مدیر', member: 'عضو' } as const)[role]}`);
      }
    }
    if (typeof req.body?.disabled === 'boolean' && req.body.disabled !== Boolean(target.disabled)) {
      if (target.id === me.id) return res.status(400).json({ error: 'حساب خودتان را نمی‌توانید غیرفعال کنید.' });
      patch.disabled = req.body.disabled;
      changes.push(req.body.disabled ? 'غیرفعال شد' : 'فعال شد');
      // Open sessions end on their next request, with the «disabled» message.
    }
    if (typeof req.body?.platformAdmin === 'boolean' && req.body.platformAdmin !== Boolean(target.platformAdmin)) {
      if (target.id === me.id && !req.body.platformAdmin) return res.status(400).json({ error: 'نقش مدیر سامانه را از خودتان نمی‌توانید بگیرید.' });
      if (req.body.platformAdmin && db.getOrg(target.orgId)?.isDemo) return res.status(400).json({ error: 'حساب نمایشی نمی‌تواند مدیر سامانه باشد.' });
      patch.platformAdmin = req.body.platformAdmin;
      changes.push(req.body.platformAdmin ? 'مدیر سامانه شد' : 'نقش مدیر سامانه گرفته شد');
    }
    if (Object.keys(patch).length) {
      db.updateUser(target.id, patch);
      log(req, 'user.update', target.email, changes.join('، '));
    }
    res.json({ user: userRow(db.getUser(target.id)!) });
  });

  r.post(
    '/users/:id/reset-password',
    h(async (req, res) => {
      const target = db.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: 'کاربر یافت نشد.' });
      const password = tempPassword();
      db.updateUser(target.id, { passwordHash: await hashPassword(password) });
      // Resetting your own password must not sign out the tab doing it.
      const keep = target.id === ctxOf(req).user.id ? ctxOf(req).tokenHash : undefined;
      db.deleteSessionsOfUser(target.id, keep);
      log(req, 'user.reset_password', target.email, keep ? 'رمز موقت ساخته شد و نشست‌های دیگر بسته شد' : 'رمز موقت ساخته شد و همه نشست‌ها بسته شد');
      res.json({ tempPassword: password });
    })
  );

  r.post('/users/:id/revoke-sessions', (req, res) => {
    const target = db.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'کاربر یافت نشد.' });
    const keep = target.id === ctxOf(req).user.id ? ctxOf(req).tokenHash : undefined;
    db.deleteSessionsOfUser(target.id, keep);
    log(req, 'user.revoke_sessions', target.email);
    res.json({ user: userRow(target) });
  });

  r.delete('/users/:id', (req, res) => {
    const target = db.getUser(req.params.id);
    if (!target) return res.status(404).json({ error: 'کاربر یافت نشد.' });
    if (target.id === ctxOf(req).user.id) return res.status(400).json({ error: 'حساب خودتان را نمی‌توانید حذف کنید.' });
    const members = db.listMembers(target.orgId);
    if (target.role === 'owner' && !members.some((u) => u.id !== target.id && u.role === 'owner')) {
      return res.status(400).json({ error: 'این کاربر تنها مالک فضای کاری است؛ برای حذف، کل فضای کاری را حذف کنید یا مالک دیگری تعیین کنید.' });
    }
    db.deleteUser(target.id);
    log(req, 'user.delete', target.email, db.getOrg(target.orgId)?.name || '');
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------- AI ----

  r.get('/ai', (_req, res) => res.json(aiPayload()));

  r.patch('/ai', (req, res) => {
    const b = req.body || {};
    const patch: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.strategy !== undefined) patch.strategy = oneOf<KeyStrategy>(b.strategy, ['failover', 'round-robin'], 'failover');
    if (typeof b.useEnvKeys === 'boolean') patch.useEnvKeys = b.useEnvKeys;
    if (b.temperature !== undefined) patch.temperature = Number(b.temperature);
    if (b.fastTimeoutSec !== undefined) patch.fastTimeoutSec = Number(b.fastTimeoutSec);
    if (b.deepTimeoutSec !== undefined) patch.deepTimeoutSec = Number(b.deepTimeoutSec);
    updateAiSettings(patch);
    log(req, 'ai.settings', 'تنظیمات هوش مصنوعی', JSON.stringify(patch));
    res.json(aiPayload());
  });

  r.post('/ai/keys', (req, res) => {
    try {
      const key = addKey(req.body || {});
      log(req, 'ai.key_add', key.label, `${key.provider} · ${key.keyHint}${key.baseUrl ? ` · ${key.baseUrl}` : ''}`);
      res.status(201).json(aiPayload());
    } catch (err) {
      inputError(res, err);
    }
  });

  r.patch('/ai/keys/:id', (req, res) => {
    try {
      const key = updateKey(req.params.id, req.body || {});
      pool.resetKey(key.id);
      log(req, 'ai.key_update', key.label, Object.keys(req.body || {}).filter((k) => k !== 'apiKey' || req.body.apiKey).join('، '));
      res.json(aiPayload());
    } catch (err) {
      inputError(res, err);
    }
  });

  r.delete('/ai/keys/:id', (req, res) => {
    const label = listKeysPublic().find((k) => k.id === req.params.id)?.label || req.params.id;
    if (!deleteKey(req.params.id)) return res.status(404).json({ error: 'کلید یافت نشد.' });
    log(req, 'ai.key_delete', label);
    res.json(aiPayload());
  });

  r.post('/ai/keys/reorder', (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string') : [];
    reorderKeys(ids);
    log(req, 'ai.key_reorder', 'ترتیب کلیدها', ids.length.toString());
    res.json(aiPayload());
  });

  r.post(
    '/ai/keys/:id/test',
    h(async (req, res) => {
      const result = await testKey(req.params.id);
      log(req, 'ai.key_test', result.label, result.ok ? `موفق (${result.latencyMs}ms)` : result.error || 'ناموفق');
      res.json({ result, ai: aiPayload() });
    })
  );

  r.post('/ai/keys/:id/reset', (req, res) => {
    pool.resetKey(req.params.id);
    log(req, 'ai.key_reset', listKeysPublic().find((k) => k.id === req.params.id)?.label || req.params.id);
    res.json(aiPayload());
  });

  r.get('/ai/calls', (req, res) => {
    res.json({ items: recentCalls(num(req.query.limit, 200, 1, 400)) });
  });

  // ------------------------------------------------------------ behaviour ----

  r.get('/behavior', (_req, res) => res.json(behaviorPayload()));

  r.put('/behavior', (req, res) => {
    const { user } = ctxOf(req);
    const cfg = saveBehavior(req.body?.config, user.name, str(req.body?.note, 160));
    log(req, 'behavior.save', `نسخه ${cfg.version}`, str(req.body?.note, 160));
    res.json(behaviorPayload());
  });

  r.post('/behavior/reset', (req, res) => {
    const cfg = resetBehavior(ctxOf(req).user.name);
    log(req, 'behavior.reset', `نسخه ${cfg.version}`);
    res.json(behaviorPayload());
  });

  r.post('/behavior/restore', (req, res) => {
    const version = num(req.body?.version, 0, 0, 1_000_000);
    const cfg = restoreBehaviorVersion(version, ctxOf(req).user.name);
    if (!cfg) return res.status(404).json({ error: 'این نسخه در تاریخچه نیست.' });
    log(req, 'behavior.restore', `نسخه ${version} → ${cfg.version}`);
    res.json(behaviorPayload());
  });

  r.get('/jobs', (_req, res) => res.json({ items: db.allJobsBrief() }));

  /** The test lab: run one resume through a (draft) behaviour and show everything. */
  r.post(
    '/behavior/lab',
    h(async (req, res) => {
      const draft = req.body?.config ? sanitizeBehavior(req.body.config, currentBehavior()) : currentBehavior();
      const jobId = str(req.body?.jobId, 80);
      let job: Pick<Job, 'departmentName' | 'roleTitle' | 'extraNotes' | 'understanding' | 'answers'> & { departmentHint?: string };
      let orgName = 'آزمایشگاه هویدا';
      if (jobId) {
        const found = db.getJobUnsafe(jobId);
        if (!found) return res.status(404).json({ error: 'فرصت شغلی یافت نشد.' });
        const org = found.orgId ? db.getOrg(found.orgId) : null;
        orgName = org?.name || orgName;
        job = { ...found, departmentHint: org?.departments.find((d) => d.id === found.departmentId)?.hint };
      } else {
        const roleTitle = str(req.body?.roleTitle, 120);
        const departmentName = str(req.body?.departmentName, 80) || 'عمومی';
        if (!roleTitle) return res.status(400).json({ error: 'یک فرصت شغلی انتخاب کنید یا عنوان شغل را بنویسید.', field: 'roleTitle' });
        const department = { id: 'lab', name: departmentName, hint: str(req.body?.departmentHint, 200), builtin: false } as any;
        job = {
          departmentName,
          roleTitle,
          extraNotes: str(req.body?.extraNotes, 2500),
          understanding: buildTemplateUnderstanding(department, roleTitle),
          answers: {},
          departmentHint: department.hint,
        };
      }
      const fileName = str(req.body?.fileName, 200) || 'resume.txt';
      let text = typeof req.body?.resumeText === 'string' ? req.body.resumeText.slice(0, 60000) : '';
      let attachments: AiFile[] | undefined;
      let format: string | null = null;
      let warnings: string[] = [];
      if (typeof req.body?.fileBase64 === 'string' && req.body.fileBase64.length > 20) {
        const ing = await ingestDocument(Buffer.from(req.body.fileBase64, 'base64'), fileName);
        text = text || ing.text;
        attachments = ing.files;
        format = ing.label;
        warnings = [...ing.warnings, ...(ing.unreadable ? [ing.unreadable] : [])];
      }
      if (!text.trim() && !attachments?.length) return res.status(400).json({ error: 'متن رزومه را وارد کنید یا فایلی انتخاب کنید.', field: 'resumeText' });
      let prompts = { system: '', user: '', industry: null as any };
      const started = Date.now();
      const evaluation = await evaluateResume({
        orgName,
        job,
        resumeText: text,
        fileName,
        attachments,
        sourceLabel: format,
        intakeWarnings: warnings,
        mode: req.body?.mode === 'deep' ? 'deep' : 'standard',
        behavior: draft,
        purpose: 'lab',
        onPrompt: (p) => {
          prompts = p;
        },
      });
      const body: LabResult = {
        industry: prompts.industry ? { id: prompts.industry.id, name: prompts.industry.name } : null,
        systemPrompt: prompts.system,
        userPrompt: prompts.user,
        engine: evaluation.engine,
        evaluation,
        format,
        textPreview: text.slice(0, 1500),
        warnings,
        latencyMs: Date.now() - started,
      };
      res.json(body);
    })
  );

  /** Prompt preview without calling the AI (industry detection + system prompt). */
  r.post('/behavior/preview', (req, res) => {
    const draft = req.body?.config ? sanitizeBehavior(req.body.config, currentBehavior()) : currentBehavior();
    const roleTitle = str(req.body?.roleTitle, 120);
    const departmentName = str(req.body?.departmentName, 80);
    const detected = draft.autoIndustry ? detectIndustry({ roleTitle, departmentName, extraNotes: str(req.body?.extraNotes, 2500) }, draft) : null;
    res.json({
      industry: detected ? { id: detected.profile.id, name: detected.profile.name, score: detected.score } : null,
      systemPrompt: buildSystemPrompt(draft, { industry: detected?.profile ?? null, deep: req.body?.deep === true }),
    });
  });

  // --------------------------------------------------------------- system ----

  r.get('/system', (_req, res) => res.json(systemSettings()));

  r.patch('/system', (req, res) => {
    const before = systemSettings();
    const next = updateSystemSettings((req.body || {}) as Partial<SystemSettings>);
    const changed = (Object.keys(next) as Array<keyof SystemSettings>).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
    if (changed.length) log(req, 'system.update', 'تنظیمات سامانه', changed.join('، '));
    res.json(next);
  });

  // ---------------------------------------------------------------- audit ----

  r.get('/audit', (req, res) => {
    res.json({ items: db.listAudit(num(req.query.limit, 300, 1, 1000), str(req.query.q, 80)) });
  });

  // ------------------------------------------------------ backup & restore ----

  const backupFail = (res: express.Response, err: unknown) => {
    if (err instanceof BackupError) return res.status(err.status).json({ error: err.message });
    throw err;
  };

  r.get(
    '/backup',
    h(async (_req, res) => {
      const status = db.storeStatus();
      const totals = db.platformTotals();
      const last = db.listAudit(1000).find((a) => a.action === 'backup.download') || null;
      const body: BackupInfo = {
        storage: { driver: status.driver, location: status.location },
        lastSavedAtISO: status.lastSavedAtISO,
        counts: { orgs: totals.orgs.total, users: totals.users.total, jobs: totals.jobs.total, resumes: totals.resumes.total, files: db.resumeFileEntries().length },
        storageBytes: await db.storageBytes(),
        lastBackup: last ? { atISO: last.atISO, actorName: last.actorName } : null,
        limits: { maxBytes: MAX_BACKUP_BYTES, chunkBytes: RESTORE_CHUNK_BYTES },
        appVersion: appVersion(),
      };
      res.json(body);
    })
  );

  /** A 10-minute download link (a plain link, so big backups stream straight to disk). */
  r.post('/backup/link', (req, res) => {
    res.json(signedBackupUrl(ctxOf(req).user.id));
  });

  r.post(
    '/restore',
    h(async (req, res) => {
      try {
        res.json(await startUpload(ctxOf(req).user.id, str(req.body?.fileName, 200), Number(req.body?.size)));
      } catch (err) {
        backupFail(res, err);
      }
    })
  );

  r.put(
    '/restore/:id/chunk',
    express.raw({ type: () => true, limit: RESTORE_CHUNK_BYTES + 64 * 1024 }),
    h(async (req, res) => {
      const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!data.length) return res.status(400).json({ error: 'بخش خالی رسید؛ دوباره تلاش کنید.' });
      try {
        res.json({ received: await appendChunk(str(req.params.id, 64), ctxOf(req).user.id, Number(req.query.offset), data) });
      } catch (err) {
        backupFail(res, err);
      }
    })
  );

  r.post(
    '/restore/:id/inspect',
    h(async (req, res) => {
      try {
        res.json(await inspectUpload(str(req.params.id, 64), ctxOf(req).user.id));
      } catch (err) {
        backupFail(res, err);
      }
    })
  );

  r.post('/restore/:id/apply', (req, res) => {
    if (str(req.body?.confirm, 40) !== 'بازیابی') {
      return res.status(400).json({ error: 'برای تأیید، کلمه «بازیابی» را بنویسید.', field: 'confirm' });
    }
    const who = actor(req);
    const ip = clientIp(req);
    try {
      res.json(
        applyUpload(str(req.params.id, 64), ctxOf(req).user.id, (result) => {
          // Written into the restored audit log, so the history shows the restore.
          audit(who, ip, 'backup.restore', `${result.counts.orgs} فضای کاری، ${result.counts.resumes} رزومه`, `${result.filesRestored} فایل بازیابی شد`);
        })
      );
    } catch (err) {
      backupFail(res, err);
    }
  });

  r.delete('/restore/:id', (req, res) => {
    try {
      cancelUpload(str(req.params.id, 64), ctxOf(req).user.id);
      res.json({ ok: true });
    } catch (err) {
      backupFail(res, err);
    }
  });

  return r;
}

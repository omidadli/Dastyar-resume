import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, hashPassword, isValidEmail, passwordProblem, requireRole } from '../auth';
import { makeDepartmentId } from '../../src/shared/departments';
import type { Department, Role, TeamMember } from '../../src/types/app';
import { aiStatus, testConnection } from '../ai/provider';
import { isEnvAdmin } from '../platform';
import { h, oneOf, str } from './util';
import { RetentionError, policyOf, preview, savePolicy, sweep } from '../retention';

function members(orgId: string, meId: string): TeamMember[] {
  return db.listMembers(orgId).map((u) => ({ ...db.publicUser(u), isYou: u.id === meId }));
}

export function orgRoutes(): express.Router {
  const r = express.Router();

  r.get('/org', (req, res) => {
    const { org, user } = ctxOf(req);
    res.json({ org, members: members(org.id, user.id) });
  });

  r.patch('/org', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const name = str(req.body?.name, 80);
    if (req.body?.name !== undefined && name.length < 2) return res.status(400).json({ error: 'نام سازمان خیلی کوتاه است.' });
    const blind = typeof req.body?.blindScreening === 'boolean' ? req.body.blindScreening : undefined;
    // Read it before updateOrg mutates the very same record.
    const was = Boolean(org.blindScreening);
    const wasApproval = Boolean(org.offerApproval?.enabled);

    // «گردش تأیید پیشنهاد»: only real members may approve, and an enabled chain
    // without an approver is refused — a silent no-op here would look like a
    // control that does not exist.
    let offerApproval: any = undefined;
    if (req.body?.offerApproval !== undefined) {
      const membersList = db.listMembers(org.id);
      const memberIds = new Set(membersList.map((m) => m.id));
      const rawSteps = Array.isArray(req.body.offerApproval?.steps) ? req.body.offerApproval.steps : [];
      const steps = rawSteps
        .slice(0, 5)
        .map((raw: any, i: number) => ({
          id: str(raw?.id, 40) || `apv-${i + 1}`,
          label: str(raw?.label, 60) || '',
          approverId: str(raw?.approverId, 80) || '',
        }))
        .filter((x: { approverId: string }) => memberIds.has(x.approverId));
      const enabled = Boolean(req.body.offerApproval?.enabled);
      if (enabled && !steps.length) {
        return res.status(400).json({ error: 'برای روشن‌کردن گردش تأیید، دست‌کم یک تأییدکننده از اعضای تیم انتخاب کنید.', code: 'APPROVAL_STEPS_REQUIRED' });
      }
      if (new Set(steps.map((s: { approverId: string }) => s.approverId)).size !== steps.length) {
        return res.status(400).json({ error: 'یک نفر نمی‌تواند در دو مرحلهٔ پیاپی تأیید کند؛ ترتیب را یک‌نفره بچینید.', code: 'APPROVAL_DUPLICATE' });
      }
      offerApproval = { enabled, steps };
    }

    const updated = db.updateOrg(org.id, {
      ...(name ? { name } : {}),
      ...(typeof req.body?.messageSignature === 'string' ? { messageSignature: str(req.body.messageSignature, 400) } : {}),
      ...(blind === undefined ? {} : { blindScreening: blind }),
      ...(offerApproval === undefined ? {} : { offerApproval }),
    });
    if (offerApproval !== undefined && offerApproval.enabled !== wasApproval) {
      db.logActivity(
        org.id,
        actorOf(req),
        'settings.changed',
        offerApproval.enabled
          ? `«گردش تأیید پیشنهاد» را روشن کرد (${offerApproval.steps.length.toLocaleString('fa-IR')} مرحله)`
          : '«گردش تأیید پیشنهاد» را خاموش کرد'
      );
    }
    if (blind !== undefined && blind !== was) {
      db.logActivity(
        org.id,
        actorOf(req),
        'settings.changed',
        blind ? '«غربالگری بی‌طرف» را روشن کرد؛ نام، تماس و فایل کارجو تا آشکارسازی پنهان می‌ماند' : '«غربالگری بی‌طرف» را خاموش کرد'
      );
    }
    res.json({ org: updated });
  });

  // ------------------------------------------------------- داده و حریم خصوصی --

  r.get('/org/retention', (req, res) => {
    const { org } = ctxOf(req);
    const policy = policyOf(org.id);
    res.json({ policy, preview: policy.days > 0 ? preview(org.id) : { days: 0, action: policy.action, items: [] } });
  });

  r.put(
    '/org/retention',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      try {
        const policy = savePolicy(org.id, { days: req.body?.days, action: req.body?.action });
        db.logActivity(
          org.id,
          actorOf(req),
          'settings.changed',
          policy.days === 0 ? 'سیاست نگه‌داری داده را خاموش کرد' : `سیاست نگه‌داری داده را روی ${policy.days.toLocaleString('fa-IR')} روز گذاشت`
        );
        res.json({ policy, preview: policy.days > 0 ? preview(org.id) : { days: 0, action: policy.action, items: [] } });
      } catch (err) {
        if (!(err instanceof RetentionError)) throw err;
        res.status(err.status).json({ error: err.message, code: err.code });
      }
    })
  );

  r.post(
    '/org/retention/run',
    requireRole('admin'),
    h(async (req, res) => {
      const { org } = ctxOf(req);
      const days = req.body?.days === undefined ? undefined : Number(req.body.days);
      const dryRun = req.body?.dryRun === true;
      if (!dryRun && policyOf(org.id).days === 0 && days === undefined) {
        return res.status(400).json({ error: 'اول سیاست نگه‌داری را روشن کنید یا تعداد روز را مشخص کنید.', code: 'POLICY_OFF' });
      }
      const result = sweep(org.id, { days, dryRun, actor: actorOf(req) });
      res.json({ result, policy: policyOf(org.id) });
    })
  );

  r.put('/org/departments', requireRole('admin'), (req, res) => {
    const { org } = ctxOf(req);
    const input = Array.isArray(req.body?.departments) ? req.body.departments : null;
    if (!input || input.length === 0) return res.status(400).json({ error: 'دست‌کم یک دپارتمان لازم است.' });
    if (input.length > 40) return res.status(400).json({ error: 'حداکثر ۴۰ دپارتمان مجاز است.' });
    const next: Department[] = [];
    for (const raw of input) {
      const name = str(raw?.name, 60);
      if (name.length < 2) return res.status(400).json({ error: 'نام هر دپارتمان باید دست‌کم ۲ حرف باشد.' });
      if (next.some((d) => d.name === name)) return res.status(400).json({ error: `نام «${name}» تکراری است.` });
      // An existing id keeps its department — once: a repeated id gets a fresh one (ids must stay unique).
      const existingId =
        typeof raw?.id === 'string' && org.departments.some((d) => d.id === raw.id) && !next.some((d) => d.id === raw.id) ? raw.id : null;
      next.push({ id: existingId || makeDepartmentId(name, [...org.departments, ...next]), name, hint: str(raw?.hint, 300) });
    }
    res.json({ org: db.updateOrg(org.id, { departments: next }) });
  });

  r.post(
    '/org/members',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const name = str(req.body?.name, 80);
      const email = str(req.body?.email, 120).toLowerCase();
      const title = str(req.body?.title, 80);
      const role = oneOf<Role>(req.body?.role, ['admin', 'member'], 'member');
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (name.length < 2) return res.status(400).json({ error: 'نام عضو را وارد کنید.', field: 'name' });
      if (!isValidEmail(email)) return res.status(400).json({ error: 'ایمیل معتبر نیست.', field: 'email' });
      const weak = passwordProblem(password);
      if (weak) return res.status(400).json({ error: weak, field: 'password' });
      if (role === 'admin' && user.role !== 'owner') return res.status(403).json({ error: 'فقط مالک فضای کاری می‌تواند مدیر تعیین کند.', field: 'role' });
      if (db.findUserByEmail(email)) return res.status(409).json({ error: 'این ایمیل قبلاً در هویدا ثبت شده است.', field: 'email' });
      // ADMIN_EMAILS grants platform-admin rights: such an account must be
      // created by its owner (sign-up), never by someone who then knows its password.
      if (isEnvAdmin({ email })) {
        return res.status(409).json({ error: 'این ایمیل برای مدیر سامانه رزرو شده است؛ صاحب آن باید خودش ثبت‌نام کند.', field: 'email' });
      }
      if (db.listMembers(org.id).length >= 50) return res.status(400).json({ error: 'سقف ۵۰ عضو برای هر فضای کاری پر شده است.' });
      const passwordHash = await hashPassword(password);
      // Re-check after the (async) hash: a parallel request may have used the address.
      if (db.findUserByEmail(email)) return res.status(409).json({ error: 'این ایمیل قبلاً در هویدا ثبت شده است.', field: 'email' });
      if (db.listMembers(org.id).length >= 50) return res.status(400).json({ error: 'سقف ۵۰ عضو برای هر فضای کاری پر شده است.' });
      const member = db.createUser({ orgId: org.id, name, email, title, role, passwordHash });
      db.logActivity(org.id, actorOf(req), 'member.added', `«${member.name}» را به تیم اضافه کرد`);
      res.status(201).json({ member: { ...db.publicUser(member), isYou: false }, members: members(org.id, user.id) });
    })
  );

  r.patch('/org/members/:id', requireRole('admin'), (req, res) => {
    const { org, user } = ctxOf(req);
    const target = db.getUser(req.params.id);
    if (!target || target.orgId !== org.id) return res.status(404).json({ error: 'عضو یافت نشد.' });
    if (target.role === 'owner') return res.status(400).json({ error: 'نقش مالک فضای کاری قابل تغییر نیست.' });
    if (target.id === user.id) return res.status(400).json({ error: 'نقش خودتان را نمی‌توانید تغییر دهید.' });
    const role = oneOf<Role>(req.body?.role, ['admin', 'member'], target.role === 'admin' ? 'admin' : 'member');
    if ((target.role === 'admin' || role === 'admin') && user.role !== 'owner') {
      return res.status(403).json({ error: 'فقط مالک فضای کاری می‌تواند مدیران را تعیین یا تغییر دهد.' });
    }
    db.updateUser(target.id, { role });
    res.json({ members: members(org.id, user.id) });
  });

  r.delete('/org/members/:id', requireRole('admin'), (req, res) => {
    const { org, user } = ctxOf(req);
    const target = db.getUser(req.params.id);
    if (!target || target.orgId !== org.id) return res.status(404).json({ error: 'عضو یافت نشد.' });
    if (target.role === 'owner') return res.status(400).json({ error: 'مالک فضای کاری قابل حذف نیست.' });
    if (target.id === user.id) return res.status(400).json({ error: 'برای خروج از فضای کاری از مدیر بخواهید شما را حذف کند.' });
    if (target.role === 'admin' && user.role !== 'owner') return res.status(403).json({ error: 'فقط مالک فضای کاری می‌تواند مدیران را حذف کند.' });
    db.deleteUser(target.id);
    db.logActivity(org.id, actorOf(req), 'member.removed', `«${target.name}» را از تیم حذف کرد`);
    res.json({ members: members(org.id, user.id) });
  });

  /**
   * «قفل‌شده‌ام»: a member who lost both phone and recovery codes asks an admin.
   * The second factor is removed (not the password), their other sessions end,
   * and the whole organization sees who did it and when — in the activity log.
   */
  r.post(
    '/org/members/:id/2fa-reset',
    requireRole('admin'),
    h(async (req, res) => {
      const { org, user } = ctxOf(req);
      const target = db.getUser(req.params.id);
      if (!target || target.orgId !== org.id) return res.status(404).json({ error: 'عضو یافت نشد.' });
      // An admin cannot strip a second factor from someone more privileged than
      // themselves: only the owner may reset another admin, and never the owner.
      if (target.role === 'owner') return res.status(403).json({ error: 'ورود دومرحله‌ای مالک فضای کاری را فقط مدیر سامانه می‌تواند بازنشانی کند.' });
      if (target.role === 'admin' && user.role !== 'owner') {
        return res.status(403).json({ error: 'فقط مالک فضای کاری می‌تواند ورود دومرحله‌ای یک مدیر را بازنشانی کند.' });
      }
      const record = db.getTwoFactor(target.id);
      if (!record) return res.status(409).json({ error: 'ورود دومرحله‌ای این عضو روشن نیست.', code: 'NOT_ENABLED' });
      db.setTwoFactor(target.id, null);
      db.deleteSessionsOfUser(target.id);
      db.logActivity(org.id, actorOf(req), 'member.updated', `ورود دومرحله‌ای «${target.name}» را بازنشانی کرد`);
      res.json({ members: members(org.id, user.id) });
    })
  );

  r.get('/ai/status', (_req, res) => res.json(aiStatus()));

  r.post(
    '/ai/test',
    requireRole('admin'),
    h(async (_req, res) => {
      const result = await testConnection();
      res.json({ ...result, status: aiStatus() });
    })
  );

  return r;
}

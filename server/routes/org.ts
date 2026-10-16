import express from 'express';
import * as db from '../db';
import { actorOf, ctxOf, hashPassword, isValidEmail, passwordProblem, requireRole } from '../auth';
import { makeDepartmentId } from '../../src/shared/departments';
import type { Department, Role, TeamMember } from '../../src/types/app';
import { aiStatus, testConnection } from '../ai/provider';
import { isEnvAdmin } from '../platform';
import { h, oneOf, str } from './util';

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
    const updated = db.updateOrg(org.id, {
      ...(name ? { name } : {}),
      ...(typeof req.body?.messageSignature === 'string' ? { messageSignature: str(req.body.messageSignature, 400) } : {}),
    });
    res.json({ org: updated });
  });

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
      const existingId = typeof raw?.id === 'string' && org.departments.some((d) => d.id === raw.id) ? raw.id : null;
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

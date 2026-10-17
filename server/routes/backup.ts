/**
 * Backup endpoints mounted WITHOUT requireAuth:
 *  - GET /api/backup/download — the full-backup ZIP; access by the HMAC-signed
 *    10-minute link from /admin (a plain link, so the browser streams a large
 *    file straight to disk instead of holding it in memory).
 *  - GET /api/restore-status/:id — progress of a restore. A restore ends every
 *    sign-in session, so the admin's tab follows it by the upload's
 *    unguessable id instead.
 */
import express from 'express';
import * as db from '../db';
import { clientIp, verifyBackupSignature } from '../auth';
import { audit, isPlatformAdmin } from '../platform';
import { BackupError, backupFileName, restoreStatus, writeBackup } from '../backup';
import { appVersion } from '../version';
import { h, str } from './util';

export function backupPublicRoutes(): express.Router {
  const r = express.Router();

  r.get(
    '/backup/download',
    h(async (req, res) => {
      const uid = str(req.query.uid, 80);
      if (!verifyBackupSignature(uid, Number(req.query.exp), str(req.query.sig, 200))) {
        return res.status(403).json({ error: 'پیوند دریافت پشتیبان منقضی شده است؛ از پنل مدیریت دوباره «دریافت فایل پشتیبان» را بزنید.' });
      }
      const user = db.getUser(uid);
      if (!user || user.disabled || !isPlatformAdmin(user)) return res.status(403).json({ error: 'دریافت پشتیبان فقط برای مدیران سامانه است.' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${backupFileName()}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      try {
        const out = await writeBackup(res, { createdBy: `${user.name} (${user.email})`, appVersion: appVersion() });
        res.end();
        audit({ id: user.id, name: `${user.name} (${user.email})` }, clientIp(req), 'backup.download', `${out.files} فایل رزومه`, out.missing ? `${out.missing} فایل روی سرور پیدا نشد` : '');
      } catch (err) {
        if (!res.headersSent) {
          res.removeHeader('Content-Disposition');
          if (err instanceof BackupError) return res.status(err.status).json({ error: err.message });
          console.error('[backup] download failed:', err);
          return res.status(500).json({ error: 'ساخت فایل پشتیبان ممکن نشد؛ دوباره تلاش کنید.' });
        }
        console.error('[backup] download interrupted:', (err as Error)?.message || err);
        res.destroy();
      }
    })
  );

  r.get('/restore-status/:id', (req, res) => {
    const status = restoreStatus(str(req.params.id, 64));
    if (!status) return res.status(404).json({ error: 'بازیابی پیدا نشد.' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(status);
  });

  return r;
}

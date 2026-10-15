/**
 * HOVIDA («هویدا») — intelligent resume screening for HR teams.
 * Express API (multi-tenant workspaces) + Vite dev middleware / static SPA.
 */
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import * as db from './server/db';
import { maintenanceGate, requireAuth } from './server/auth';
import { initPlatform, systemSettings } from './server/platform';
import { adminRoutes } from './server/routes/admin';
import { aiStatus } from './server/ai/provider';
import { authRoutes } from './server/routes/auth';
import { orgRoutes } from './server/routes/org';
import { jobRoutes } from './server/routes/jobs';
import { fileRoutes, resumeRoutes } from './server/routes/resumes';
import { insightRoutes } from './server/routes/insights';

dotenv.config({ override: true });

async function startServer() {
  await db.initStore();
  db.purgeExpired();
  initPlatform();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 40mb fits the largest allowed resume (25mb, /admin › تنظیمات سامانه) as base64.
  app.use(express.json({ limit: '40mb' }));
  // A rejected body (too large / malformed) must come back as JSON.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      const mb = systemSettings().maxFileMb.toLocaleString('fa-IR');
      return res.status(413).json({ error: `حجم فایل بیش از حد مجاز است؛ هر رزومه حداکثر ${mb} مگابایت.` });
    }
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      return res.status(400).json({ error: 'درخواست قابل خواندن نیست.' });
    }
    return next(err);
  });
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // ---------------- Public API ----------------
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', app: 'HOVIDA', ai: aiStatus().available });
  });
  app.use('/api/auth', authRoutes());
  app.use('/api', fileRoutes()); // HMAC-signed, no bearer token needed

  // ---------------- Authenticated API ----------------
  app.use('/api', requireAuth);
  app.use('/api/admin', adminRoutes()); // platform admins — also during maintenance
  app.use('/api', maintenanceGate);
  app.use('/api', orgRoutes());
  app.use('/api', jobRoutes());
  app.use('/api', resumeRoutes());
  app.use('/api', insightRoutes());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر API یافت نشد.' }));

  // ---------------- Frontend ----------------
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Long-lived cached assets, but never the HTML shell (a stale shell after a
    // deploy would keep loading old bundles).
    app.use(
      express.static(distPath, {
        index: false,
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
          else if (/[\\/]assets[\\/]/.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          else res.setHeader('Cache-Control', 'public, max-age=86400');
        },
      })
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error('Unhandled error:', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'خطای داخلی سرور' });
  });

  // Housekeeping: expired sessions and demo workspaces.
  setInterval(() => db.purgeExpired(), 15 * 60_000).unref();

  const PORT = Number(process.env.PORT) || 3000;
  const server = app.listen(PORT, '0.0.0.0', () => {
    const ai = aiStatus();
    console.log(`هویدا روی پورت ${PORT} آماده است — هوش مصنوعی: ${ai.available ? ai.label : 'غیرفعال (موتور محلی)'}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received — flushing data and closing.`);
    db.flushSaveSync();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

startServer();

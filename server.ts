/**
 * HOVIDA («هویدا») — intelligent resume screening for HR teams.
 * Express API (multi-tenant workspaces) + Vite dev middleware / static SPA.
 */
import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import * as db from './server/db';
import { initAppSecret } from './server/secret';
import { storage } from './server/storage';
import { maintenanceGate, requireAuth } from './server/auth';
import { initPlatform, systemSettings } from './server/platform';
import { adminRoutes } from './server/routes/admin';
import { aiStatus, flushAiState } from './server/ai/provider';
import { authRoutes } from './server/routes/auth';
import { orgRoutes } from './server/routes/org';
import { jobRoutes } from './server/routes/jobs';
import { fileRoutes, resumeRoutes } from './server/routes/resumes';
import { insightRoutes } from './server/routes/insights';
import { integrationPublicRoutes, integrationRoutes } from './server/routes/integrations';
import { automationRoutes } from './server/routes/automation';
import { careerPublicRoutes, careerRoutes } from './server/routes/careers';
import { backupPublicRoutes } from './server/routes/backup';
import { remindersEnabled, runRemindersQuietly } from './server/reminders';

dotenv.config({ override: true });

/** Set on SIGTERM: new API calls get «restarting», running ones may finish. */
let shuttingDown = false;
let inflight = 0;

async function startServer() {
  await db.initStore();
  await initAppSecret();
  db.purgeExpired();
  initPlatform();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((req, res, next) => {
    if (shuttingDown && req.path.startsWith('/api/') && req.path !== '/api/health') {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'هویدا در حال به‌روزرسانی است؛ چند ثانیه دیگر دوباره تلاش کنید.', code: 'RESTARTING' });
    }
    inflight++;
    let done = false;
    res.on('close', () => {
      if (!done) {
        done = true;
        inflight--;
      }
    });
    next();
  });

  // 70mb fits the largest allowed resume (50mb, /admin › تنظیمات سامانه) as base64.
  app.use(express.json({ limit: '70mb' }));
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
    res.json({ status: shuttingDown ? 'stopping' : 'ok', app: 'HOVIDA', ai: aiStatus().available, storage: storage().driver });
  });
  app.use('/api/auth', authRoutes());
  app.use('/api', fileRoutes()); // HMAC-signed, no bearer token needed
  app.use('/api', backupPublicRoutes()); // signed backup download + restore progress
  app.use('/api', integrationPublicRoutes()); // Google Calendar OAuth callback
  app.use('/api', careerPublicRoutes()); // public career portal (no session)

  // ---------------- Authenticated API ----------------
  app.use('/api', requireAuth);
  app.use('/api/admin', adminRoutes()); // platform admins — also during maintenance
  app.use('/api', maintenanceGate);
  app.use('/api', orgRoutes());
  app.use('/api', jobRoutes());
  app.use('/api', resumeRoutes());
  app.use('/api', insightRoutes());
  app.use('/api', integrationRoutes());
  app.use('/api', automationRoutes());
  app.use('/api', careerRoutes());
  app.use('/api', (_req, res) => res.status(404).json({ error: 'مسیر API یافت نشد.' }));

  // ---------------- Frontend ----------------
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // The server bundle and its source map are built into dist/ as well: never
    // publish the server's code (nor any source map, nor the Cloudflare-only
    // _headers rules) as a static file.
    app.use((req, res, next) => {
      if (/^\/(server\.cjs|_headers$)/i.test(req.path) || /\.map$/i.test(req.path)) return res.status(404).type('text/plain').send('Not found');
      next();
    });
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
    // A bundle file the current build doesn't have (a tab opened before a
    // deploy) must fail as a 404 — never come back as the HTML shell, which
    // the browser would try to run as JavaScript.
    app.use('/assets', (_req, res) => res.status(404).type('text/plain').send('Not found'));
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    // Client mistakes — e.g. a malformed %-escape in the address (URIError,
    // status 400) — are not server faults: answer with the client status, and
    // give page addresses the app shell so the user sees «این صفحه پیدا نشد».
    const status = Number(err?.status ?? err?.statusCode);
    const clientError = err instanceof URIError || (Number.isInteger(status) && status >= 400 && status < 500);
    if (clientError) {
      const code = Number.isInteger(status) && status >= 400 && status < 500 ? status : 400;
      const url = req.originalUrl || '';
      if (url.startsWith('/api')) return res.status(code).json({ error: 'آدرس درخواست نامعتبر است.' });
      if (process.env.NODE_ENV === 'production' && req.method === 'GET' && !url.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        return res.status(404).sendFile(path.join(process.cwd(), 'dist', 'index.html'));
      }
      return res.status(code).type('text/plain').send('Bad request');
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'خطای داخلی سرور' });
  });

  // Housekeeping: expired sessions and demo workspaces.
  setInterval(() => db.purgeExpired(), 15 * 60_000).unref();

  // «یادآوری مصاحبه»: once an hour, one day before each interview, from the
  // workspace's own mailbox. Every interview is reminded at most once.
  if (remindersEnabled()) {
    setTimeout(() => void runRemindersQuietly(), 60_000).unref();
    setInterval(() => void runRemindersQuietly(), 60 * 60_000).unref();
  }

  const PORT = Number(process.env.PORT) || 3000;
  const server = app.listen(PORT, '0.0.0.0', () => {
    const ai = aiStatus();
    console.log(`هویدا روی پورت ${PORT} آماده است — هوش مصنوعی: ${ai.available ? ai.label : 'غیرفعال (موتور محلی)'}`);
  });

  const remote = storage().driver === 'remote';
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received — finishing open requests, saving data and closing.`);
    // Cloudflare waits up to 15 minutes after SIGTERM, Render about 30 seconds.
    const graceMs = Number(process.env.SHUTDOWN_GRACE_MS) || (remote ? 120_000 : 5_000);
    const until = Date.now() + graceMs;
    // `inflight` drops as responses finish (see the middleware above).
    for (;;) {
      if (inflight <= 0 || Date.now() >= until) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
    }
    try {
      flushAiState();
    } catch {
      /* never block shutdown */
    }
    const saved = await db.flushSave(remote ? 90_000 : 10_000).catch(() => false);
    if (!saved) {
      db.flushSaveSync();
      console.error('[server] the last changes could not be confirmed as saved.');
    }
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Last-resort guards: a stray rejection is logged instead of killing the
// process mid-request; a truly unexpected exception still exits (the platform
// restarts the service) — but only after the data is saved.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception — saving data and exiting:', err);
  try {
    db.flushSaveSync();
  } catch {
    /* nothing more we can do */
  }
  if (storage().driver === 'fs') process.exit(1);
  setTimeout(() => process.exit(1), 30_000).unref();
  db.flushSave(25_000)
    .catch(() => false)
    .finally(() => process.exit(1));
});

startServer().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});

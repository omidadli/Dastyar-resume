import type express from 'express';

/** Wraps an async handler so rejections become JSON 500s instead of hanging requests. */
export function h(fn: (req: express.Request, res: express.Response) => Promise<unknown> | unknown) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      console.error(`[api] ${req.method} ${req.originalUrl} failed:`, err?.message || err);
      if (res.headersSent) return next(err);
      res.status(500).json({ error: 'خطای داخلی سرور؛ لطفاً دوباره تلاش کنید.' });
    });
  };
}

export function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

export function int(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

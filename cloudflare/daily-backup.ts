/**
 * Daily safety copy of HOVIDA's data snapshot inside the same R2 bucket
 * (Cron Trigger, see wrangler.jsonc): backups/daily/<YYYY-MM-DD>/hovida-store.json,
 * Tehran calendar day, the last `keepDays` days are kept.
 *
 * It covers the records (workspaces, users, jobs, candidates, decisions,
 * settings) — not the original resume files, which are never rewritten in
 * place. For a complete, portable copy use /admin › پشتیبان‌گیری و انتقال.
 */

const DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD of `now` in Tehran. */
export function tehranDay(now: Date): string {
  return DAY_FMT.format(now);
}

export async function dailyBackup(bucket: R2Bucket, dataPrefix = 'data/', keepDays = 30, now = new Date()) {
  const source = await bucket.get(`${dataPrefix}hovida-store.json`);
  if (!source) return { copied: null as string | null, pruned: 0 };
  const day = tehranDay(now);
  const target = `backups/daily/${day}/hovida-store.json`;
  await bucket.put(target, source.body, { httpMetadata: { contentType: 'application/json' } });

  const cutoff = tehranDay(new Date(now.getTime() - keepDays * 24 * 3600_000));
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: 'backups/daily/', cursor, limit: 1000 });
    for (const o of page.objects) {
      const d = o.key.slice('backups/daily/'.length, 'backups/daily/'.length + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) stale.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < stale.length; i += 1000) await bucket.delete(stale.slice(i, i + 1000));
  return { copied: target, pruned: stale.length };
}

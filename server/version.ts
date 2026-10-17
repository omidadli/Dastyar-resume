import fs from 'fs';
import path from 'path';

let cached = '';

/** HOVIDA version from package.json (shown in /admin and written into backups). */
export function appVersion(): string {
  if (cached) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version || '—';
  } catch {
    cached = '—';
  }
  return cached;
}

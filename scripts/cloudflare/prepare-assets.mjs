#!/usr/bin/env node
/**
 * Checks that dist/ is safe to publish as Workers static assets (run by
 * `npm run build:cloudflare` after `npm run build`). Both files come from
 * public/, so every build — Render, Docker or Cloudflare — carries them:
 *  - .assetsignore: the server bundle and source maps are never published;
 *  - _headers: caching and security headers for static files at the edge.
 * Hashed bundles (/assets/*) get their year-long cache from the Worker
 * (cloudflare/router.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const fail = (msg) => {
  console.error(`[cloudflare] ${msg}`);
  process.exit(1);
};
if (!fs.existsSync(path.join(dist, 'index.html'))) fail('dist/index.html is missing — run `npm run build` first.');
const ignore = fs.existsSync(path.join(dist, '.assetsignore')) ? fs.readFileSync(path.join(dist, '.assetsignore'), 'utf8') : '';
if (!/^server\.cjs$/m.test(ignore) || !/^\*\.map$/m.test(ignore)) fail('dist/.assetsignore must exclude server.cjs and *.map (see public/.assetsignore).');
if (!fs.existsSync(path.join(dist, '_headers'))) fail('dist/_headers is missing (see public/_headers).');
console.log('[cloudflare] dist/ is ready for Workers static assets (server bundle excluded, _headers present).');

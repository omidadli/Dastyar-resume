/**
 * Records pdf.js text items of sample PDFs as compact JSON fixtures for
 * scripts/unit.test.ts (no PDF binaries in git).
 * Usage: node scripts/fixtures/record-pdf-items.mjs <out-name> <file.pdf> [maxPages]
 */
import fs from 'fs';
import path from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const [, , name, file, maxPages = '2'] = process.argv;
if (!name || !file) {
  console.error('usage: node scripts/fixtures/record-pdf-items.mjs <out-name> <file.pdf> [maxPages]');
  process.exit(1);
}
const pdf = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true }).promise;
const pages = [];
for (let p = 1; p <= Math.min(pdf.numPages, Number(maxPages)); p++) {
  const page = await pdf.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const r = (n) => Math.round(n * 10) / 10;
  const items = content.items
    .filter((it) => 'str' in it && it.str.length > 0)
    .map((it) => [it.str, r(it.transform[4]), r(vp.height - it.transform[5]), r(it.width), r(it.height)]);
  pages.push({ width: r(vp.width), items });
}
const out = path.join(path.dirname(new URL(import.meta.url).pathname), 'pdf', `${name}.json`);
fs.writeFileSync(out, JSON.stringify({ source: path.basename(file), pages }));
console.log(`${out}: ${pages.length} page(s), ${pages.reduce((s, p) => s + p.items.length, 0)} items, ${fs.statSync(out).size} bytes`);

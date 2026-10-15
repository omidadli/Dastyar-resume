/**
 * Universal intake tests: every fixture is generated here (no binaries in
 * git) and pushed through ingestDocument() — format detection, text
 * extraction, attachments for the AI, and honest reasons for unreadable files.
 * Run with: npx tsx scripts/ingest.test.ts
 */
import zlib from 'zlib';
import { ingestDocument, sniff } from '../server/ingest';
import { assessText, decodeTextBytes, wordXmlToText } from '../src/lib/officeText';
import { decodeBmp } from '../server/ingest/images';
import { parseMime } from '../server/ingest/mime';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

async function lib(name: string): Promise<any> {
  const mod: any = await import(name);
  return mod.default && (typeof mod.default === 'object' || typeof mod.default === 'function') ? mod.default : mod;
}
async function xlsxLib(): Promise<any> {
  const mod: any = await import('xlsx');
  return mod.default?.read ? mod.default : mod;
}

const CV_FA = 'علی رضایی — کارشناس ارشد فروش — ali.rezaei@example.com — ۰۹۱۲۱۲۳۴۵۶۷';
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

async function makeDocx(): Promise<Buffer> {
  const JSZip = await lib('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  const body = [
    p('سوابق شغلی'),
    p('۱۳۹۸ تا اکنون: سرپرست فروش در شرکت آوا &amp; شرکا'),
    // tracked deletion + field code must disappear
    '<w:p><w:r><w:t>مهارت‌ها:</w:t></w:r><w:del><w:r><w:delText>متن حذف‌شده</w:delText></w:r></w:del><w:r><w:instrText>HYPERLINK "x"</w:instrText></w:r><w:r><w:tab/><w:t>مذاکره</w:t></w:r></w:p>',
    // a text box, repeated in the VML fallback (must appear once)
    `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>${p('درباره من: فروشنده پرتلاش')}</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p('درباره من: فروشنده پرتلاش')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`,
    `<w:tbl><w:tr><w:tc>${p('کارشناسی مدیریت بازرگانی')}</w:tc><w:tc>${p('دانشگاه تهران')}</w:tc></w:tr></w:tbl>`,
  ].join('');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`);
  zip.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${W_NS}>${p(CV_FA)}</w:hdr>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 13 Tf 50 790 Td ${lines.map((l, i) => `${i ? '0 -20 Td ' : ''}(${l.replace(/[()\\]/g, '\\$&')}) Tj`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function makeBmp24(w: number, h: number): Buffer {
  const row = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + row * h);
  buf.write('BM', 0, 'latin1');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf.writeUIntLE(x === 0 ? 0xff0000 : 0xffffff, 54 + y * row + x * 3, 3); // bytes B,G,R → red first column
  return buf;
}

async function main() {
  // ---------------- Word ----------------
  const docx = await makeDocx();
  const d = await ingestDocument(docx, 'cv.docx');
  assert(d.kind === 'docx' && d.label === 'Word (DOCX)', 'docx: detected', d.kind);
  assert(d.text.includes('ali.rezaei@example.com'), 'docx: header (contact line) is read', d.text.slice(0, 80));
  assert((d.text.match(/درباره من/g) || []).length === 1, 'docx: text box read exactly once (VML fallback skipped)');
  assert(!d.text.includes('متن حذف‌شده') && !d.text.includes('HYPERLINK'), 'docx: deleted revisions and field codes skipped');
  assert(d.text.includes('آوا & شرکا') && d.text.includes('دانشگاه تهران'), 'docx: entities decoded, table cells kept');
  assert(d.files.length === 0 && d.unreadable === null, 'docx with text: no attachments needed');
  const renamed = await ingestDocument(docx, 'resume.pdf');
  assert(renamed.kind === 'docx', 'content wins over a wrong extension (docx named .pdf)');
  assert(wordXmlToText('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:br/><w:t>b</w:t></w:r></w:p>') === 'a\nb', 'word xml: line breaks');

  // ---------------- PDF ----------------
  const pdf = makePdf(['Ali Rezaei - Senior Software Engineer', 'Email: ali@example.com  Phone: 09121234567', 'Experience: 8 years backend development with Node.js and Go']);
  const pr = await ingestDocument(pdf, 'cv.pdf');
  assert(pr.kind === 'pdf' && /Senior Software Engineer/.test(pr.text), 'pdf: text layer extracted on the server', pr.text.slice(0, 60));
  assert(pr.files.length === 1 && pr.files[0].mimeType === 'application/pdf', 'pdf: original kept for multimodal/deep review');
  assert(pr.label === 'PDF', 'pdf: label', pr.label);
  const scan = await ingestDocument(makePdf([' ']), 'scan.pdf');
  assert(scan.label === 'PDF اسکن‌شده' && scan.files.length === 1 && scan.unreadable === null, 'pdf without text → «PDF اسکن‌شده», goes to vision', scan.label);

  // ---------------- PowerPoint / OpenDocument / EPUB ----------------
  const JSZip = await lib('jszip');
  const pz = new JSZip();
  pz.file('ppt/presentation.xml', '<p:presentation/>');
  pz.file('ppt/slides/slide2.xml', '<p:sld><a:p><a:r><a:t>اسلاید دوم: پروژه‌ها</a:t></a:r></a:p></p:sld>');
  pz.file('ppt/slides/slide10.xml', '<p:sld><a:p><a:r><a:t>اسلاید دهم: تماس</a:t></a:r></a:p></p:sld>');
  pz.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>مریم احمدی</a:t></a:r><a:br/><a:r><a:t>طراح محصول</a:t></a:r></a:p></p:sld>');
  const pptx = await ingestDocument(await pz.generateAsync({ type: 'nodebuffer' }), 'portfolio.pptx');
  assert(pptx.kind === 'pptx', 'pptx: detected');
  assert(/مریم احمدی\nطراح محصول[\s\S]*دوم[\s\S]*دهم/.test(pptx.text), 'pptx: slides in numeric order, line breaks kept', JSON.stringify(pptx.text.slice(0, 80)));

  const oz = new JSZip();
  oz.file('mimetype', 'application/vnd.oasis.opendocument.text');
  oz.file('content.xml', '<office:document-content><office:body><office:text><text:h>رزومه</text:h><text:p>سابقه<text:s text:c="2"/>کار<text:tab/>۵ سال</text:p></office:text></office:body></office:document-content>');
  const odt = await ingestDocument(await oz.generateAsync({ type: 'nodebuffer' }), 'cv.odt');
  assert(odt.kind === 'odt' && /رزومه\nسابقه\s+کار\s+۵ سال/.test(odt.text), 'odt: headings, spaces and tabs', JSON.stringify(odt.text));

  const ez = new JSZip();
  ez.file('mimetype', 'application/epub+zip');
  ez.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  ez.file('OEBPS/content.opf', '<package><manifest><item id="b" href="b.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
  ez.file('OEBPS/a.xhtml', '<html><body><h1>فصل اول</h1><p>معرفی</p></body></html>');
  ez.file('OEBPS/b.xhtml', '<html><body><p>فصل دوم</p></body></html>');
  const epub = await ingestDocument(await ez.generateAsync({ type: 'nodebuffer' }), 'cv.epub');
  assert(epub.kind === 'epub' && epub.text.indexOf('فصل اول') < epub.text.indexOf('فصل دوم'), 'epub: spine order', JSON.stringify(epub.text));

  // ---------------- Spreadsheets ----------------
  const XLSX = await xlsxLib();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['نام', 'سمت', 'سابقه'], ['رضا کریمی', 'حسابدار ارشد', 7]]), 'سوابق');
  const xlsx = await ingestDocument(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'cv.xlsx');
  assert(xlsx.kind === 'xlsx' && /رضا کریمی \| حسابدار ارشد \| 7/.test(xlsx.text), 'xlsx: rows as « | » lines', JSON.stringify(xlsx.text));
  const xls = await ingestDocument(XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }), 'old.xls');
  assert(xls.kind === 'xls' && xls.text.includes('حسابدار ارشد'), 'xls (BIFF8 in an OLE container): detected and read', xls.kind);
  const ods = await ingestDocument(XLSX.write(wb, { type: 'buffer', bookType: 'ods' }), 'cv.ods');
  assert(ods.kind === 'ods' && ods.text.includes('رضا کریمی'), 'ods: read', ods.kind);

  // ---------------- Text encodings & markup ----------------
  const win1256 = Buffer.from([0xc7, 0xe1, 0xd3, 0xe1, 0xc7, 0xe3, 0x20, 0xda, 0xe1, 0xed]); // «السلام علی»
  const t1 = await ingestDocument(win1256, 'old.txt');
  assert(t1.text.includes('السلام'), 'txt: Windows-1256 Persian decoded', t1.text);
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('رزومه نیما سلطانی، برنامه‌نویس', 'utf16le')]);
  assert((await ingestDocument(u16, 'u16.txt')).text.includes('نیما سلطانی'), 'txt: UTF-16 with BOM');
  const html = await ingestDocument(Buffer.from('<!doctype html><html><head><style>.x{}</style><script>alert(1)</script></head><body><h1>سارا محمدی</h1><p>تحلیلگر داده<br>SQL و Python</p><a href="mailto:sara@example.com">ایمیل</a></body></html>'), 'cv.html');
  assert(html.kind === 'html' && /سارا محمدی\n+تحلیلگر داده\nSQL و Python/.test(html.text) && !html.text.includes('alert'), 'html: blocks → lines, scripts dropped', JSON.stringify(html.text));
  assert(html.text.includes('sara@example.com'), 'html: mailto links kept');
  const json = await ingestDocument(Buffer.from(JSON.stringify({ basics: { name: 'Neda Ahmadi', label: 'HR Manager', picture: 'x.png' }, work: [{ company: 'Mehregan', position: 'Recruiter' }] })), 'resume.json');
  assert(json.kind === 'json' && /name: Neda Ahmadi/.test(json.text) && /position: Recruiter/.test(json.text) && !json.text.includes('x.png'), 'json resume → readable lines', JSON.stringify(json.text));
  const xml = await ingestDocument(Buffer.from('<?xml version="1.0"?><SkillsPassport><FirstName>Omid</FirstName><Occupation>Civil Engineer</Occupation></SkillsPassport>'), 'europass.xml');
  assert(xml.kind === 'xml' && /Omid/.test(xml.text) && /Civil Engineer/.test(xml.text), 'xml (Europass-like): element text');
  const rtf = await ingestDocument(Buffer.from('{\\rtf1\\ansi{\\fonttbl\\f0 Arial;}\\f0 Kaveh Nouri\\par Mechanical Engineer}'), 'cv.rtf');
  assert(rtf.kind === 'rtf' && /Kaveh Nouri/.test(rtf.text), 'rtf: read');
  const svg = await ingestDocument(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text x="1" y="1">Parisa Kazemi — UX Designer with 6 years of experience in fintech</text><path d="M0 0L1 1"/></svg>'), 'cv.svg');
  assert(svg.kind === 'svg' && svg.text.includes('Parisa Kazemi'), 'svg: text elements', svg.kind);

  // ---------------- E-mail with an attached resume ----------------
  const eml = [
    'From: =?utf-8?B?2LnZhNuMINix2LbYp9uM24w=?= <ali@example.com>',
    'To: hr@example.com',
    'Subject: =?utf-8?Q?=D8=B1=D8=B2=D9=88=D9=85=D9=87?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '=D8=B3=D9=84=D8=A7=D9=85=D8=8C =D8=B1=D8=B2=D9=88=D9=85=D9=87 =D9=BE=DB=8C=D9=88=D8=B3=D8=AA =D8=A7=D8=B3=D8=AA.',
    '--XYZ',
    'Content-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document; name="cv.docx"',
    "Content-Disposition: attachment; filename*=utf-8''%D8%B1%D8%B2%D9%88%D9%85%D9%87.docx",
    'Content-Transfer-Encoding: base64',
    '',
    docx.toString('base64').replace(/.{76}/g, '$&\r\n'),
    '--XYZ--',
    '',
  ].join('\r\n');
  const m = parseMime(Buffer.from(eml));
  assert(m.subject === 'رزومه' && m.from.startsWith('علی رضایی'), 'mime: encoded-word subject and sender', `${m.subject} / ${m.from}`);
  assert(m.attachments.length === 1 && m.attachments[0].fileName === 'رزومه.docx', 'mime: RFC 2231 attachment name', m.attachments[0]?.fileName);
  const er = await ingestDocument(Buffer.from(eml), 'mail.eml');
  assert(er.kind === 'eml' && er.text.includes('رزومه پیوست است') && er.text.includes('ali.rezaei@example.com'), 'eml: body + attached DOCX text', er.text.slice(0, 120));

  // ---------------- Outlook .msg (OLE) ----------------
  const CFB = XLSX.CFB;
  const msg = CFB.utils.cfb_new();
  CFB.utils.cfb_add(msg, '__substg1.0_0037001F', Buffer.from('درخواست همکاری', 'utf16le'));
  CFB.utils.cfb_add(msg, '__substg1.0_1000001F', Buffer.from('رزومه من پیوست است.', 'utf16le'));
  CFB.utils.cfb_add(msg, '__attach_version1.0_#00000000/__substg1.0_3707001F', Buffer.from('cv.txt', 'utf16le'));
  CFB.utils.cfb_add(msg, '__attach_version1.0_#00000000/__substg1.0_37010102', Buffer.from('حمید رستمی — تکنسین برق صنعتی با ۶ سال سابقه', 'utf8'));
  const mr = await ingestDocument(Buffer.from(CFB.write(msg, { type: 'buffer' })), 'mail.msg');
  assert(mr.kind === 'msg' && mr.text.includes('درخواست همکاری') && mr.text.includes('حمید رستمی'), 'msg: subject, body and attachment', `${mr.kind}: ${mr.text.slice(0, 120)}`);

  // Legacy .doc the parser can't open → strings fallback still finds the text
  const doc = CFB.utils.cfb_new();
  CFB.utils.cfb_add(doc, 'WordDocument', Buffer.concat([Buffer.alloc(600), Buffer.from('Behnaz Karimi, Senior Accountant with IFRS experience', 'utf16le'), Buffer.alloc(200)]));
  const dr = await ingestDocument(Buffer.from(CFB.write(doc, { type: 'buffer' })), 'old.doc');
  assert(dr.kind === 'doc' && dr.text.includes('Behnaz Karimi'), 'doc: unreadable FIB → approximate text, not a failure', `${dr.kind}: ${dr.text.slice(0, 60)}`);

  // ---------------- Images ----------------
  const jpegLib = await lib('jpeg-js');
  const rgba = Buffer.alloc(40 * 30 * 4, 255);
  const jpg = Buffer.from(jpegLib.encode({ data: rgba, width: 40, height: 30 }, 80).data);
  const ji = await ingestDocument(jpg, 'photo.jpeg');
  assert(ji.kind === 'image' && ji.files[0]?.mimeType === 'image/jpeg' && ji.label === 'تصویر JPEG' && ji.unreadable === null, 'jpeg: passed to vision', ji.label);
  const bmp = makeBmp24(3, 2);
  const decoded = decodeBmp(bmp);
  assert(decoded.width === 3 && decoded.data[0] === 255 && decoded.data[1] === 0 && decoded.data[4] === 255 && decoded.data[5] === 255, 'bmp decoder: bottom-up rows, BGR → RGB');
  const bi = await ingestDocument(bmp, 'scan.bmp');
  assert(bi.files[0]?.mimeType === 'image/jpeg', 'bmp → JPEG for the AI');
  const { GifWriter } = await lib('omggif');
  const gifBuf = Buffer.alloc(1024);
  const gw = new GifWriter(gifBuf, 4, 4, { palette: [0xffffff, 0x000000] });
  gw.addFrame(0, 0, 4, 4, new Array(16).fill(1));
  const gi = await ingestDocument(gifBuf.subarray(0, gw.end()), 'cv.gif');
  assert(gi.files[0]?.mimeType === 'image/jpeg', 'gif → JPEG (Gemini has no GIF input)');
  const UTIF = await lib('utif2');
  const tif = Buffer.from(UTIF.encodeImage(new Uint8Array(8 * 6 * 4).fill(200), 8, 6));
  const ti = await ingestDocument(tif, 'fax.tiff');
  assert(ti.kind === 'image' && ti.files.length === 1 && ti.files[0].mimeType === 'image/jpeg', 'tiff → JPEG pages', `${ti.files.length} ${ti.unreadable}`);
  const avif = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from('ftypavif'), Buffer.alloc(40)]);
  const ai = await ingestDocument(avif, 'x.avif');
  assert(ai.unreadable !== null && /JPG یا PNG/.test(ai.unreadable), 'avif (server cannot decode): clear Persian advice', ai.unreadable || '');

  // ---------------- Audio / video résumés ----------------
  const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 7)]);
  const au = await ingestDocument(mp3, 'intro.mp3');
  assert(au.kind === 'audio' && au.files[0]?.mimeType === 'audio/mpeg' && au.warnings.some((w) => /Gemini/.test(w)), 'mp3 résumé → audio attachment (Gemini)');
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(100)]);
  assert((await ingestDocument(mp4, 'video-cv.mp4')).files[0]?.mimeType === 'video/mp4', 'mp4 résumé → video attachment');

  // ---------------- Archives ----------------
  const az = new JSZip();
  az.file('__MACOSX/._cv.docx', 'junk');
  az.file('certificates/award.txt', 'گواهی افتخار مسابقات ملی برنامه‌نویسی سال ۱۴۰۱');
  az.file('Resume-Ali.docx', docx);
  const ar = await ingestDocument(await az.generateAsync({ type: 'nodebuffer' }), 'package.zip');
  assert(ar.kind === 'zip' && ar.text.indexOf('Resume-Ali.docx') < ar.text.indexOf('award.txt') && !ar.text.includes('junk'), 'zip: resume first, junk skipped, all docs merged', ar.text.slice(0, 80));
  const tarHeader = Buffer.alloc(512);
  tarHeader.write('cv.txt', 0);
  tarHeader.write('0000644\0', 100);
  const body = Buffer.from('مهسا یزدانی — کارشناس کنترل کیفیت با ۴ سال سابقه در صنایع غذایی');
  tarHeader.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  tarHeader.write('0', 156);
  tarHeader.write('ustar', 257);
  const tar = Buffer.concat([tarHeader, body, Buffer.alloc(512 - (body.length % 512)), Buffer.alloc(1024)]);
  const tgz = await ingestDocument(zlib.gzipSync(tar), 'cv.tar.gz');
  assert(tgz.text.includes('مهسا یزدانی'), 'tar.gz: unpacked and read', tgz.kind);
  const rar = await ingestDocument(Buffer.concat([Buffer.from('Rar!\x1a\x07\x00', 'latin1'), Buffer.alloc(50)]), 'cv.rar');
  assert(rar.kind === 'rar' && /ZIP/.test(rar.unreadable || ''), 'rar: honest «convert to ZIP» message');

  // ---------------- Unknown / broken / empty ----------------
  const unknown = Buffer.concat([Buffer.from([0x00, 0x13, 0x37, 0x99, 0xfe]), Buffer.from('Farhad Moradi — Network Administrator, CCNA and MCSA certified, 9 years of experience running enterprise networks in Tehran', 'utf16le'), Buffer.alloc(300, 0x9c)]);
  const ur = await ingestDocument(unknown, 'cv.xyz');
  assert(ur.text.includes('Farhad Moradi') && ur.warnings.length > 0, 'unknown binary → «strings» fallback finds the resume text', ur.text.slice(0, 50));
  const junk = await ingestDocument(Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919) % 256)), 'noise.bin');
  assert(junk.unreadable !== null && junk.text === '', 'random bytes → unreadable with advice', junk.unreadable || '');
  const empty = await ingestDocument(Buffer.alloc(0), 'empty.pdf');
  assert(empty.kind === 'empty' && /خالی/.test(empty.unreadable || ''), 'empty file → reason');
  const broken = await ingestDocument(Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(100, 1)]), 'broken.docx');
  assert(broken.unreadable !== null, 'corrupt zip → unreadable, no crash', broken.unreadable || '');

  // ---------------- Sniffing & quality ----------------
  assert(sniff(Buffer.from('From: a@b.c\nTo: d@e.f\nSubject: hi\nDate: x\n\nbody'), 'x.txt').kind === 'eml', 'sniff: e-mail headers');
  assert(sniff(Buffer.from('BEGIN:VCARD\nFN:Ali\nEND:VCARD'), 'a.vcf').kind === 'vcf', 'sniff: vCard');
  assert(assessText('Ø³Ù„Ø§Ù… Ù…Ù† Ø¹Ù„ÛŒ Ù‡Ø³ØªÙ… Ø¨Ø±Ù†Ø§Ù…Ù‡ Ù†ÙˆÛŒØ³ Ø¨Ø§ ØªØ¬Ø±Ø¨Ù‡').garbled, 'quality: UTF-8 Persian read as Latin-1 is garbled');
  assert(assessText('\uE001\uE002\uE003 \uE004\uE005 '.repeat(20)).garbled, 'quality: private-use glyphs are garbled');
  assert(assessText('کارشناس فروش با ۵ سال سابقه در شرکت‌های پخش مواد غذایی، مسلط به مذاکره و مدیریت مشتریان کلیدی').usable, 'quality: normal Persian is usable');
  assert(decodeTextBytes(new Uint8Array(Buffer.from('سلام', 'utf8'))) === 'سلام', 'decode: strict UTF-8');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

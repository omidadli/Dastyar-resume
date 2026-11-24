#!/usr/bin/env node
/**
 * A tiny stand-in for a licensed LinkedIn-compatible sourcing provider, for
 * local demos and tests. It is NOT LinkedIn data: the people below are
 * fictional. Point the server at it:
 *
 *   node scripts/mock-linkedin.mjs --port 9911
 *   LINKEDIN_API_URL=http://127.0.0.1:9911/search LINKEDIN_ACCESS_TOKEN=demo npm run dev
 *
 * Contract: docs/CONNECT-LINKEDIN.md
 */
import http from 'http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT) || 9911;
const TOKEN = process.env.LINKEDIN_ACCESS_TOKEN || 'demo';

const PEOPLE = [
  {
    id: 'demo-li-1',
    fullName: 'مریم کاظمی',
    headline: 'کارشناس ارشد حسابداری صنعتی | SAP | بهای تمام‌شده',
    location: 'تهران، ایران',
    profileUrl: 'https://www.linkedin.com/in/maryam-kazemi-demo',
    openToWork: true,
    currentCompany: 'گروه صنعتی البرز',
    experiences: [
      { title: 'کارشناس ارشد حسابداری صنعتی', company: 'گروه صنعتی البرز', period: '۱۴۰۰ – اکنون', description: 'بهای تمام‌شده، انبار و گزارش‌های مدیریتی؛ پیاده‌سازی SAP FI/CO' },
      { title: 'حسابدار صنعتی', company: 'شرکت تولیدی پارس', period: '۱۳۹۷ – ۱۴۰۰', description: 'بستن ماهانه و مغایرت‌گیری انبار' },
    ],
    education: ['کارشناسی ارشد حسابداری — دانشگاه تهران'],
    skills: ['حسابداری صنعتی', 'SAP', 'بهای تمام‌شده', 'اکسل پیشرفته', 'IFRS'],
  },
  {
    id: 'demo-li-2',
    fullName: 'حسین رضایی',
    headline: 'کارشناس حسابداری | Oracle EBS',
    location: 'کرج، ایران',
    profileUrl: 'https://www.linkedin.com/in/hossein-rezaei-demo',
    openToWork: true,
    experiences: [
      { title: 'کارشناس حسابداری', company: 'شرکت تجهیزات صنعتی آریا', period: '۱۳۹۹ – اکنون', description: 'حسابداری انبار و بهای تمام‌شده' },
    ],
    education: ['کارشناسی حسابداری — دانشگاه آزاد کرج'],
    skills: ['حسابداری صنعتی', 'Oracle EBS', 'اکسل'],
  },
  {
    id: 'demo-li-3',
    fullName: 'سارا محمدی',
    headline: 'کارشناس فروش سازمانی | B2B',
    location: 'تهران، ایران',
    profileUrl: 'https://www.linkedin.com/in/sara-mohammadi-demo',
    openToWork: true,
    currentCompany: 'پخش سراسری آوا',
    experiences: [
      { title: 'کارشناس فروش سازمانی', company: 'پخش سراسری آوا', period: '۱۴۰۱ – اکنون', description: 'فروش B2B به فروشگاه‌های زنجیره‌ای' },
      { title: 'ویزیتور', company: 'پخش مواد غذایی', period: '۱۳۹۸ – ۱۴۰۱' },
    ],
    education: ['کارشناسی مدیریت بازرگانی — دانشگاه علامه'],
    skills: ['فروش B2B', 'مذاکره', 'CRM'],
  },
  {
    id: 'demo-li-4',
    fullName: 'امیر نوری',
    headline: 'مدیر منابع انسانی | جذب و توسعه',
    location: 'اصفهان، ایران',
    profileUrl: 'https://www.linkedin.com/in/amir-nouri-demo',
    openToWork: false,
    experiences: [
      { title: 'مدیر منابع انسانی', company: 'هولدینگ صنعتی', period: '۱۳۹۶ – اکنون', description: 'جذب، آموزش و روابط کار' },
    ],
    education: ['کارشناسی ارشد مدیریت منابع انسانی'],
    skills: ['جذب و استخدام', 'روابط کار', 'آموزش'],
  },
];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'POST only' }));
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid token' }));
    }
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'bad json' }));
    }
    const q = payload.query || {};
    const openOnly = q.openToWorkOnly !== false;
    const terms = [q.roleTitle, ...(q.skills || []), ...(q.locations || [])].filter(Boolean).map((t) => String(t).toLowerCase());
    const items = PEOPLE.filter((p) => (!openOnly || p.openToWork))
      .filter((p) => !terms.length || terms.some((t) => `${p.headline} ${p.location} ${(p.skills || []).join(' ')}`.toLowerCase().includes(t)))
      .slice(0, Math.min(25, Number(payload.limit) || 25));
    console.log(`[mock-linkedin] query=${q.booleanQuery || q.roleTitle} → ${items.length} profile(s)`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: items.length, items, nextCursor: null }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-linkedin] listening on http://127.0.0.1:${PORT}/search (token: ${TOKEN})`));

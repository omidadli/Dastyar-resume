#!/usr/bin/env node
/**
 * A local stand-in for the Apify platform running a HarvestAPI-style actor, so
 * the «Apify (HarvestAPI)» provider can be demonstrated without an account or
 * any scraping. The people below are fictional.
 *
 *   node scripts/mock-apify.mjs --port 9922
 *
 * Then in /admin › «اتصال‌ها»: نوع سرویس → Apify، آدرس API → http://127.0.0.1:9922/v2،
 * توکن → demo-apify-token، شناسهٔ Actor → harvestapi/linkedin-profile-search
 *
 * It answers the four endpoints the app uses:
 *   GET  /v2/users/me                            → the token check
 *   POST /v2/acts/<actor>/runs                   → start a run
 *   GET  /v2/actor-runs/<id>                     → RUNNING once, then SUCCEEDED
 *   GET  /v2/datasets/<id>/items                 → the finished profiles
 * The dataset mirrors HarvestAPI field names (openToWork, position, companyName…)
 * so the mapping code is exercised for real.
 */
import http from 'http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : process.env.PORT) || 9922;
const TOKEN = process.env.APIFY_MOCK_TOKEN || 'demo-apify-token';

const PROFILES = [
  {
    id: 'mock-ap-1',
    publicIdentifier: 'maryam-kazemi-demo',
    linkedinUrl: 'https://www.linkedin.com/in/maryam-kazemi-demo',
    firstName: 'مریم',
    lastName: 'کاظمی',
    headline: 'کارشناس ارشد حسابداری صنعتی | SAP | بهای تمام‌شده',
    openToWork: true,
    location: { linkedinText: 'Tehran, Tehran Province, Iran', parsed: { text: 'Tehran, Iran', city: 'Tehran' } },
    currentPosition: [{ companyName: 'گروه صنعتی البرز' }],
    experience: [
      { position: 'کارشناس ارشد حسابداری صنعتی', companyName: 'گروه صنعتی البرز', duration: '2 yrs', description: 'بهای تمام‌شده، انبار و گزارش‌های مدیریتی؛ پیاده‌سازی SAP FI/CO' },
      { position: 'حسابدار صنعتی', companyName: 'شرکت تولیدی پارس', duration: '3 yrs', description: 'بستن ماهانه و مغایرت‌گیری انبار' },
    ],
    education: [{ schoolName: 'دانشگاه تهران', degree: 'کارشناسی ارشد حسابداری' }],
    skills: ['حسابداری صنعتی', 'SAP', 'بهای تمام‌شده', 'اکسل پیشرفته'],
  },
  {
    id: 'mock-ap-2',
    publicIdentifier: 'hossein-rezaei-demo',
    linkedinUrl: 'https://www.linkedin.com/in/hossein-rezaei-demo',
    firstName: 'حسین',
    lastName: 'رضایی',
    headline: 'کارشناس حسابداری | Oracle EBS',
    openToWork: true,
    location: { linkedinText: 'Karaj, Alborz Province, Iran' },
    currentPosition: [{ companyName: 'شرکت تجهیزات صنعتی آریا' }],
    experience: [{ position: 'کارشناس حسابداری', companyName: 'شرکت تجهیزات صنعتی آریا', duration: '4 yrs', description: 'حسابداری انبار و بهای تمام‌شده' }],
    education: [{ schoolName: 'دانشگاه آزاد کرج', degree: 'کارشناسی حسابداری' }],
    skills: ['حسابداری صنعتی', 'Oracle EBS', 'اکسل'],
  },
  {
    id: 'mock-ap-3',
    publicIdentifier: 'amir-nouri-demo',
    linkedinUrl: 'https://www.linkedin.com/in/amir-nouri-demo',
    firstName: 'امیر',
    lastName: 'نوری',
    headline: 'مدیر مالی | IFRS',
    // Explicitly not looking: proves the filter keeps the reported ones only.
    openToWork: false,
    location: { linkedinText: 'Isfahan, Iran' },
    currentPosition: [{ companyName: 'هولدینگ صنعتی' }],
    experience: [{ position: 'مدیر مالی', companyName: 'هولدینگ صنعتی', duration: '6 yrs' }],
    education: [{ schoolName: 'دانشگاه اصفهان', degree: 'کارشناسی ارشد' }],
    skills: ['IFRS', 'بودجه‌ریزی'],
  },
];

let runSeq = 0;
const runs = new Map(); // runId → { polls, datasetId, input }

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.searchParams.get('token') !== TOKEN) return send(401, { error: { type: 'unauthorized', message: 'Invalid token' } });
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (url.pathname === '/v2/users/me') return send(200, { data: { username: 'mock-hovida' } });

    if (req.method === 'POST' && /^\/v2\/acts\/[^/]+\/runs$/.test(url.pathname)) {
      const input = JSON.parse(body || '{}');
      runSeq += 1;
      const id = `run-${runSeq}`;
      const datasetId = `ds-${runSeq}`;
      runs.set(id, { polls: 0, datasetId, input });
      console.log(`[mock-apify] run ${id} started — titles=${JSON.stringify(input.currentJobTitles || [])} locations=${JSON.stringify(input.locations || [])} maxItems=${input.maxItems}`);
      return send(201, { data: { id, defaultDatasetId: datasetId, status: 'RUNNING' } });
    }

    const runMatch = url.pathname.match(/^\/v2\/actor-runs\/([^/]+)$/);
    if (runMatch) {
      const run = runs.get(runMatch[1]);
      if (!run) return send(404, { error: { message: 'run not found' } });
      run.polls += 1;
      const status = run.polls <= 1 ? 'RUNNING' : 'SUCCEEDED';
      console.log(`[mock-apify] run ${runMatch[1]} polled → ${status}`);
      return send(200, { data: { id: runMatch[1], status, defaultDatasetId: run.datasetId } });
    }

    const dsMatch = url.pathname.match(/^\/v2\/datasets\/([^/]+)\/items$/);
    if (dsMatch) {
      const run = [...runs.values()].find((r) => r.datasetId === dsMatch[1]);
      const items = run ? PROFILES : PROFILES;
      console.log(`[mock-apify] dataset ${dsMatch[1]} → ${items.length} profiles (${items.filter((p) => p.openToWork === true).length} open to work)`);
      return send(200, items);
    }

    return send(404, { error: { message: `unknown path ${url.pathname}` } });
  });
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`[mock-apify] listening on http://127.0.0.1:${PORT}/v2 (token: ${TOKEN}) — fictional profiles, no scraping`)
);

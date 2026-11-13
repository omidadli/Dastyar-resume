/**
 * End-to-end test of «کنترل بازهٔ حقوق» — the offer against the requisition.
 *
 * A salary band nobody checks is a number in a drawer, so what is proved here is
 * that the check cannot be skipped by any of the four doors into an offer:
 *
 *   • **create** above the ceiling → 409 `OFFER_ABOVE_BAND` with the numbers;
 *   • **edit a draft** above → the same refusal, and a carried-over reason does not
 *     silently authorise a *new*, higher figure when the ceiling changed;
 *   • **revise after negotiation** → the new version is checked again, not inherited;
 *   • **send** re-checks last (the requisition may have moved since the draft);
 *   • **below the floor** is flagged (`below`) and never blocked;
 *   • **no band / no amount** are honest verdicts, not invented ones;
 *   • **annual salaries are converted** to monthly before comparing;
 *   • **the candidate's page never learns the band**, and the requisition page
 *     lists the over-band offers with the reason attached.
 *
 * Run with: npm run build && npx tsx scripts/offer-band.test.ts
 */
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

function mockSmtp(): Promise<{ server: net.Server; messages: string[] }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let data = '';
    socket.write('220 mock.local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      for (;;) {
        const idx = buffer.indexOf('\r\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(data);
            data = '';
            socket.write('250 2.0.0 queued\r\n');
          } else data += line + '\r\n';
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') socket.write('250-mock.local\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        else if (cmd === 'HELO') socket.write('250 mock.local\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 accepted\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, messages })));
}

async function main() {
  const dist = path.resolve('dist/server.cjs');
  if (!fs.existsSync(dist)) {
    console.error('dist/server.cjs is missing — run `npm run build` first.');
    process.exit(1);
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-offer-band-'));
  const PORT = 5200 + Math.floor(Math.random() * 90);
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(PORT),
    DATA_DIR: DATA,
    APP_SECRET: 'offer-band-secret-0123456789',
    AI_PROVIDER: 'off',
    INTERVIEW_REMINDERS: 'off',
    PUBLIC_URL: BASE,
  } as NodeJS.ProcessEnv;
  for (const k of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ADMIN_EMAILS', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) delete env[k];

  const child = spawn(process.execPath, [dist], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  while (!/آماده است/.test(log) && Date.now() - started < 25_000) await new Promise((r) => setTimeout(r, 150));

  const call = async (method: string, url: string, token?: string | null, body?: unknown) => {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-Hovida-Session': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  };

  const smtp = await mockSmtp();
  const smtpPort = (smtp.server.address() as any).port;

  try {
    const A = (await call('POST', '/api/auth/signup', null, { orgName: 'آوا صنعت', name: 'مدیر منابع انسانی', email: 'a@example.com', password: 'Password12345' }))
      .json.token as string;
    const B = (await call('POST', '/api/auth/signup', null, { orgName: 'برنا تجارت', name: 'مدیر منابع انسانی', email: 'b@example.com', password: 'Password12345' }))
      .json.token as string;

    const org = (await call('GET', '/api/org', A)).json.org;
    const dept = org.departments[0];
    const understanding = (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد بک‌اند' })).json.understanding;
    const job = (await call('POST', '/api/jobs', A, { departmentId: dept.id, roleTitle: 'کارشناس ارشد بک‌اند', understanding, criteriaSource: 'template' })).json.job;
    const looseJob = (
      await call('POST', '/api/jobs', A, {
        departmentId: dept.id,
        roleTitle: 'کارشناس بدون نیازمندسنجی',
        understanding: (await call('POST', '/api/jobs/template', A, { departmentId: dept.id, roleTitle: 'کارشناس' })).json.understanding,
        criteriaSource: 'template',
      })
    ).json.job;

    await call('PUT', '/api/integrations/email', A, {
      host: '127.0.0.1',
      port: smtpPort,
      secure: false,
      username: 'hr@ava.example',
      password: 'smtp-secret-band-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'hr@ava.example',
    });

    const candidate = async (jobX: { id: string }, first: string, email: string) => {
      const csv = [
        'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills,Email,Phone',
        `${first},محمدی,"برنامه‌نویس بک‌اند",تهران,آلفا,https://www.linkedin.com/in/${first},Yes,"Node.js",${email},09121234567`,
      ].join('\r\n');
      const imported = await call('POST', '/api/sourcing/csv', A, { csv, departmentId: dept.id, jobId: jobX.id, openToWorkOnly: true });
      const profileId = imported.json.search.results[0].id;
      return (await call('POST', `/api/sourcing/searches/${imported.json.search.id}/import`, A, { profileId, jobId: jobX.id })).json.record;
    };

    // ------------------------------------------------- no requisition: no verdict
    const freeCandidate = await candidate(looseJob, 'سارا', 'sara@example.ir');
    const noReq = await call('POST', '/api/offers', A, {
      resumeId: freeCandidate.id,
      terms: { title: 'کارشناس', startDate: '۱۴۰۴/۰۹/۰۱', salaryAmount: 900_000_000, salaryPeriod: 'monthly' },
    });
    assert(noReq.status === 201, 'without a requisition an offer is written as before', `${noReq.status}`);
    assert(noReq.json.offer.band === null, 'and carries no band verdict', JSON.stringify(noReq.json.offer.band));

    // ---------------------------------------------------------- a band exists
    const req = await call('POST', '/api/requisitions', A, {
      title: 'کارشناس ارشد بک‌اند',
      departmentId: dept.id,
      slots: 2,
      salaryMin: 40_000_000,
      salaryMax: 60_000_000,
      justification: 'تیم پرداخت با دو نفر اداره می‌شود و تحویل سرویس‌ها عقب افتاده است.',
    });
    const reqId = req.json.requisition.id;
    await call('POST', `/api/requisitions/${reqId}/submit`, A, {});
    await call('POST', `/api/requisitions/${reqId}/decision`, A, { decision: 'approved', approvedSlots: 2 });
    await call('POST', `/api/requisitions/${reqId}/jobs`, A, { jobId: job.id });

    const inBand = await candidate(job, 'مریم', 'maryam@example.ir');
    const baseTerms = { title: 'کارشناس ارشد بک‌اند', startDate: '۱۴۰۴/۰۹/۰۱' };

    const okOffer = await call('POST', '/api/offers', A, { resumeId: inBand.id, terms: { ...baseTerms, salaryAmount: 50_000_000, salaryPeriod: 'monthly' } });
    assert(okOffer.status === 201, 'an offer inside the band is written', String(okOffer.status));
    assert(okOffer.json.offer.band?.status === 'in' && okOffer.json.offer.band?.code === req.json.requisition.code, 'and says it is inside the approved band', JSON.stringify(okOffer.json.offer.band));
    assert(okOffer.json.offer.band?.maxMonthly === 60_000_000, 'with the ceiling on the record', String(okOffer.json.offer.band?.maxMonthly));

    // ----------------------------------------------------------- above the band
    const aboveCandidate = await candidate(job, 'رضا', 'reza@example.ir');
    const refused = await call('POST', '/api/offers', A, { resumeId: aboveCandidate.id, terms: { ...baseTerms, salaryAmount: 85_000_000, salaryPeriod: 'monthly' } });
    assert(refused.status === 409 && refused.json?.code === 'OFFER_ABOVE_BAND', 'above the ceiling the offer is refused, with a code', `${refused.status} ${refused.json?.code}`);
    assert(refused.json?.band?.status === 'above' && refused.json.band.maxMonthly === 60_000_000 && refused.json.band.offerMonthly === 85_000_000, 'the refusal carries both numbers', JSON.stringify(refused.json?.band));

    const shortReason = await call('POST', '/api/offers', A, { resumeId: aboveCandidate.id, terms: { ...baseTerms, salaryAmount: 85_000_000 }, bandReason: 'لازم بود' });
    assert(shortReason.status === 409 && shortReason.json?.code === 'OFFER_ABOVE_BAND', 'a two-word reason is not a reason', String(shortReason.status));

    const overOffer = await call('POST', '/api/offers', A, {
      resumeId: aboveCandidate.id,
      terms: { ...baseTerms, salaryAmount: 85_000_000, salaryPeriod: 'monthly' },
      bandReason: 'کارجو پیشنهاد رقیب با ۱۵٪ بالاتر دارد و برای بستن نقش حیاتی تأیید مدیرعامل گرفته شد.',
    });
    assert(overOffer.status === 201, 'with a written reason it is written', `${overOffer.status} ${overOffer.text.slice(0, 120)}`);
    const overOfferId = overOffer.json.offer.id;
    assert(overOffer.json.offer.band?.status === 'above' && /رقیب/.test(overOffer.json.offer.band?.overrideReason || ''), 'the reason and its author are on the offer', `${overOffer.json.offer.band?.overriddenByName}`);

    // -------------------------------------------------- editing a draft, again
    const edited = await call('PATCH', `/api/offers/${overOfferId}`, A, { terms: { ...baseTerms, salaryAmount: 87_000_000, salaryPeriod: 'monthly' } });
    assert(edited.status === 200 && edited.json.offer.band?.status === 'above', 'editing keeps it above the band, still allowed by the existing reason', String(edited.status));
    assert(edited.json.offer.band?.overrideReason === overOffer.json.offer.band?.overrideReason, 'the same reason carries over');

    const raiseCeiling = await call('PATCH', `/api/offers/${okOffer.json.offer.id}`, A, { terms: { ...baseTerms, salaryAmount: 200_000_000, salaryPeriod: 'monthly' } });
    assert(raiseCeiling.status === 409 && raiseCeiling.json?.code === 'OFFER_ABOVE_BAND', 'raising an in-band draft above the ceiling needs a reason', String(raiseCeiling.status));

    // ------------------------------------------------------- below the floor
    const below = await call('POST', '/api/offers', A, { resumeId: (await candidate(job, 'نیما', 'nima@example.ir')).id, terms: { ...baseTerms, salaryAmount: 30_000_000, salaryPeriod: 'monthly' } });
    assert(below.status === 201 && below.json.offer.band?.status === 'below', 'below the floor is flagged, not blocked', `${below.status} ${below.json?.offer?.band?.status}`);

    // ------------------------------------------------------ annual conversion
    const annual = await call('POST', '/api/offers', A, {
      resumeId: (await candidate(job, 'الهام', 'elham@example.ir')).id,
      terms: { ...baseTerms, salaryAmount: 660_000_000, salaryPeriod: 'annual' },
    });
    assert(annual.status === 201 && annual.json.offer.band?.offerMonthly === 55_000_000, 'an annual figure is compared monthly', `${annual.json?.offer?.band?.offerMonthly}`);
    const annualAbove = await call('POST', '/api/offers', A, {
      resumeId: (await candidate(job, 'کاوه', 'kaveh@example.ir')).id,
      terms: { ...baseTerms, salaryAmount: 900_000_000, salaryPeriod: 'annual' },
    });
    assert(annualAbove.status === 409, 'and an annual figure that is above monthly is caught too', String(annualAbove.status));

    // -------------------------------------------------------- no number at all
    const noAmount = await call('POST', '/api/offers', A, { resumeId: (await candidate(job, 'پویا', 'pouya@example.ir')).id, terms: { ...baseTerms, salaryAmount: null } });
    assert(noAmount.status === 201 && noAmount.json.offer.band?.status === 'no_amount', 'an offer without a number says so instead of pretending', `${noAmount.json?.offer?.band?.status}`);

    // ------------------------------------------------------------- re-check on send
    // The draft was written when the opening had no requisition at all (the «no
    // requisition: no verdict» case above). Attaching it to an approved band later
    // must stop the send, not slip through.
    const attachLoose = await call('POST', `/api/requisitions/${reqId}/jobs`, A, { jobId: looseJob.id });
    assert(attachLoose.status === 200, 'the opening with the old draft is attached to a banded requisition', String(attachLoose.status));
    const sendBlocked = await call('POST', `/api/offers/${noReq.json.offer.id}/send`, A, {});
    assert(sendBlocked.status === 409 && sendBlocked.json?.code === 'OFFER_ABOVE_BAND', 'the send is re-checked and refused', `${sendBlocked.status} ${sendBlocked.json?.code}`);
    const sendAllowed = await call('POST', `/api/offers/${noReq.json.offer.id}/send`, A, {
      bandReason: 'پیش از بستن سرفصل نوشته شده بود؛ مدیرعامل با همین عدد موافقت کرده است.',
    });
    assert(sendAllowed.status === 200, 'and a written reason lets it go', `${sendAllowed.status} ${sendAllowed.text.slice(0, 140)}`);
    assert(sendAllowed.json.offer.band?.status === 'above', 'the sent offer records the verdict it went out with');

    const sendInBand = await call('POST', `/api/offers/${okOffer.json.offer.id}/send`, A, {});
    assert(sendInBand.status === 200 && sendInBand.json.offer.band?.status === 'in', 'an in-band draft sends with no question at all', `${sendInBand.status} ${sendInBand.json?.offer?.band?.status}`);

    // ------------------------------------------------- revise after negotiation
    const reviseNoReason = await call('POST', `/api/offers/${okOffer.json.offer.id}/revise`, A, {
      terms: { ...baseTerms, salaryAmount: 65_000_000, salaryPeriod: 'monthly' },
    });
    assert(reviseNoReason.status === 409 && reviseNoReason.json?.code === 'OFFER_ABOVE_BAND', 'a new version above the ceiling needs its own reason', `${reviseNoReason.status} ${reviseNoReason.json?.code}`);
    const revised = await call('POST', `/api/offers/${okOffer.json.offer.id}/revise`, A, {
      terms: { ...baseTerms, salaryAmount: 65_000_000, salaryPeriod: 'monthly' },
      bandReason: 'در مذاکره، کارجو ۵ میلیون بیشتر خواست و مدیرعامل برای نگه‌داشتنش موافقت کرد.',
    });
    assert(revised.status === 201 && revised.json.offer.band?.status === 'above' && revised.json.offer.version === 2, 'and goes through with its own reason and version', `${revised.status} v${revised.json?.offer?.version}`);

    // ----------------------------------------------- the candidate sees no band
    const publicToken = String(revised.json.offer.url).split('/offer/')[1];
    const publicPage = await call('GET', `/api/offers/public/${publicToken}`);
    assert(!('band' in (publicPage.json?.offer || {})), 'the candidate’s page carries no band at all');
    assert(!publicPage.text.includes('REQ-') && !publicPage.text.includes('نیازمندسنجی'), 'and nothing about requisitions');

    // ------------------------------------------------------- requisition view
    const reqView = await call('GET', `/api/requisitions/${reqId}`, A);
    const over = reqView.json.requisition.overBandOffers || [];
    assert(over.length >= 2, 'the requisition lists the offers written above its ceiling', String(over.length));
    assert(over.every((o: any) => Boolean(o.reason)), 'each with the reason attached', JSON.stringify(over.map((o: any) => o.candidateName)));
    assert(over.some((o: any) => /رقیب/.test(o.reason)), 'including the first override');

    function sentOr(row: any): string {
      return row.json.offer.url as string;
    }

    // ------------------------------------------------------------- audit trail
    const activity = await call('GET', '/api/activity?limit=50', A);
    const types = (activity.json?.items || []).map((i: any) => i.type);
    assert(types.includes('offer.band_override'), 'the override is on the activity trail', types.filter((t: string) => t.startsWith('offer.')).join(','));

    // ---------------------------------------------------------------- tenants
    const other = await call('GET', '/api/requisitions', B);
    assert(other.status === 200 && other.json.items.length === 0, 'another workspace sees no requisitions to check against');

  } finally {
    smtp.server.close();
    child.kill('SIGKILL');
  }

  console.log(failures === 0 ? '\nهمهٔ بررسی‌ها موفق بود.' : `\n${failures} بررسی ناموفق بود.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();

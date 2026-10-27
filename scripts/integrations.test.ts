/**
 * Unit tests for the three outside connections (no network, no SMTP server):
 *  - e-mail settings validation/encryption, header-injection guard, error hints
 *  - Google Calendar OAuth state signing, redirect URIs, ICS invitations, Tehran time
 *  - sourcing: provider response mapping, local brief, boolean query sanitising
 * Run with: npx tsx scripts/integrations.test.ts
 */
process.env.APP_SECRET = 'integration-test-secret-0123456789';

import { cleanSubject, emailStatus, friendlySmtpError, isEmailConfigured, prepareEmailSettings } from '../server/mailer';
import { accessTokenFor, buildInviteIcs, CALENDAR_TIMEZONE, googleClient, redirectUriFor, signState, verifyState } from '../server/gcal';
import { apifyInput, buildLocalBrief, finishProfiles, normalizeProfile, profileToResumeText, sanitizeBrief, sourcingStatus } from '../server/linkedin';
import { csvSummary, parseCsv, profilesFromCsv, readCsv } from '../server/csv-import';
import { tehranIsoFromJalali, jalaliAndTehranTime } from '../server/tehran-time';
import type { OrgSecrets } from '../server/db';

let failures = 0;
function assert(cond: boolean, label: string, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// --------------------------------------------------------------- e-mail ----

{
  const email = prepareEmailSettings(
    {
      host: 'SMTP.Company.IR',
      port: 465,
      secure: true,
      username: 'hr@company.ir',
      password: 'app-password-123',
      fromName: 'واحد منابع انسانی',
      fromAddress: 'HR@Company.ir',
      replyTo: null,
    },
    undefined
  );
  const secrets: OrgSecrets = { email };
  assert(email.host === 'smtp.company.ir' && email.fromAddress === 'hr@company.ir', 'host/address are normalised');
  assert(email.passwordEnc.startsWith('v1:') && !email.passwordEnc.includes('app-password-123'), 'the SMTP password is stored encrypted');
  assert(isEmailConfigured(secrets) && emailStatus(secrets).configured, 'a complete configuration reports «configured»');
  assert(!JSON.stringify(emailStatus(secrets)).includes('app-password-123'), 'the public status never contains the password');

  // Editing without retyping the password keeps the stored one.
  const again = prepareEmailSettings(
    { host: 'smtp.company.ir', port: 587, secure: false, username: 'hr@company.ir', password: '', fromName: 'منابع انسانی', fromAddress: 'hr@company.ir', replyTo: 'jobs@company.ir' },
    email
  );
  assert(again.passwordEnc === email.passwordEnc && again.replyTo === 'jobs@company.ir', 'saving again without a new password keeps it');

  const rejects: Array<[string, () => unknown]> = [
    ['invalid host', () => prepareEmailSettings({ host: 'not a host', port: 587, secure: false, username: 'u', password: 'p', fromName: '', fromAddress: 'a@b.ir', replyTo: null }, undefined)],
    ['invalid port', () => prepareEmailSettings({ host: 'smtp.a.ir', port: 99999, secure: false, username: 'u', password: 'p', fromName: '', fromAddress: 'a@b.ir', replyTo: null }, undefined)],
    ['invalid sender', () => prepareEmailSettings({ host: 'smtp.a.ir', port: 587, secure: false, username: 'u', password: 'p', fromName: '', fromAddress: 'nope', replyTo: null }, undefined)],
    ['missing password on first save', () => prepareEmailSettings({ host: 'smtp.a.ir', port: 587, secure: false, username: 'u', password: '', fromName: '', fromAddress: 'a@b.ir', replyTo: null }, undefined)],
  ];
  for (const [label, fn] of rejects) {
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    }
    assert(threw, `${label} is refused`);
  }

  assert(cleanSubject('سلام\r\nBcc: evil@example.com') === 'سلام Bcc: evil@example.com', 'newlines are stripped from the subject (no header injection)');
  assert(friendlySmtpError({ code: 'EAUTH', response: '535 5.7.8 Username and Password not accepted' }).includes('App Password'), 'auth failures point at App Passwords');
  assert(friendlySmtpError({ code: 'ENOTFOUND' }).includes('پیدا نشد'), 'DNS failures are explained in Persian');
}

// ------------------------------------------------------------- calendar ----

{
  const state = signState({ orgId: 'org_1', userId: 'usr_1', redirectUri: 'https://hr.example.com/api/integrations/calendar/callback', exp: Date.now() + 60_000 });
  const parsed = verifyState(state);
  assert(parsed?.orgId === 'org_1' && parsed.userId === 'usr_1', 'a signed OAuth state round-trips the workspace');
  assert(verifyState(state.slice(0, -2) + 'xx') === null, 'a tampered state is rejected');
  const expired = signState({ orgId: 'org_1', userId: 'usr_1', redirectUri: 'x', exp: Date.now() - 1 });
  assert(verifyState(expired) === null, 'an expired state is rejected');

  delete process.env.GOOGLE_REDIRECT_URI;
  assert(
    redirectUriFor('https://hr.example.com/') === 'https://hr.example.com/api/integrations/calendar/callback',
    'the redirect URI is derived from the request origin',
    redirectUriFor('https://hr.example.com/')
  );
  // The redirect override only counts when a client is actually configured.
  process.env.GOOGLE_CLIENT_ID = '1234567890-test.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-test-secret';
  process.env.GOOGLE_REDIRECT_URI = 'https://fixed.example.com/cb';
  assert(redirectUriFor('https://other.example.com') === 'https://fixed.example.com/cb', 'GOOGLE_REDIRECT_URI overrides the origin');
  assert(googleClient()?.clientId === '1234567890-test.apps.googleusercontent.com', 'the environment client is used when nothing was saved in /admin');
  delete process.env.GOOGLE_REDIRECT_URI;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;

  const ics = buildInviteIcs({
    interview: {
      id: 'itv_1',
      title: 'مصاحبهٔ سارا محمدی — کارشناس فروش',
      notes: 'مصاحبهٔ فنی؛ لطفاً نمونه‌کار همراه داشته باشید.',
      startsAtISO: '2026-10-27T06:30:00.000Z',
      durationMin: 45,
      location: 'دفتر مرکزی، اتاق ۳',
      candidateName: 'سارا محمدی',
      jobTitle: 'کارشناس فروش',
    },
    organizer: { name: 'واحد منابع انسانی', email: 'hr@company.ir' },
    attendeeEmails: ['sara@example.com', 'manager@company.ir'],
  });
  assert(ics.startsWith('BEGIN:VCALENDAR') && ics.trim().endsWith('END:VCALENDAR'), 'ICS opens and closes correctly');
  assert(ics.includes(`DTSTART;TZID=${CALENDAR_TIMEZONE}:20261027T100000`), 'the start time is Tehran wall-clock (06:30Z → 10:00)', ics.split('\r\n').find((l) => l.startsWith('DTSTART')) || '');
  assert(ics.includes(`DTEND;TZID=${CALENDAR_TIMEZONE}:20261027T104500`), 'the end time honours the 45-minute duration');
  assert(ics.includes('ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:sara@example.com'), 'the candidate is an attendee');
  assert(ics.includes('ORGANIZER;CN=واحد منابع انسانی:mailto:hr@company.ir'), 'the organizer is the workspace mailbox');
  assert(!ics.includes('\n\n'), 'no bare blank lines (invalid ICS)');
}

// ------------------------------------------------------ Tehran wall clock ----

{
  assert(tehranIsoFromJalali('۱۴۰۵/۰۸/۰۵', '۱۰:۳۰') === '2026-10-27T07:00:00.000Z', 'Jalali date + time becomes the right UTC instant', String(tehranIsoFromJalali('۱۴۰۵/۰۸/۰۵', '۱۰:۳۰')));
  assert(tehranIsoFromJalali('1405/08/05', '9:05') === '2026-10-27T05:35:00.000Z', 'English digits and a single-digit hour are accepted');
  assert(tehranIsoFromJalali('۱۴۰۵/۱۳/۰۱', '۱۰:۳۰') === null, 'an impossible month is refused');
  assert(tehranIsoFromJalali('۱۴۰۵/۰۸/۰۵', '۲۵:۰۰') === null, 'an impossible hour is refused');
  assert(tehranIsoFromJalali('۱۴۰۵/۰۸/۰۵', '۱۰') === null, 'a time without minutes is refused');
  const back = jalaliAndTehranTime('2026-10-27T07:00:00.000Z');
  assert(back.date === '1405/08/05' && back.time === '10:30', 'the round-trip returns the same Jalali date/time', `${back.date} ${back.time}`);
}

// -------------------------------------------------------------- sourcing ----

{
  const profile = normalizeProfile(
    {
      id: 'li-42',
      fullName: 'مریم کاظمی',
      headline: 'کارشناس ارشد حسابداری صنعتی | SAP',
      location: 'تهران، ایران',
      profileUrl: 'https://www.linkedin.com/in/maryam-kazemi',
      openToWork: true,
      currentCompany: 'گروه صنعتی البرز',
      experiences: [
        { title: 'کارشناس حسابداری صنعتی', company: 'گروه صنعتی البرز', period: '۱۴۰۰ – اکنون', description: 'بهای تمام‌شده و گزارش‌های مدیریتی' },
        { role: 'حسابدار', companyName: 'شرکت تولیدی', dates: '۱۳۹۷ – ۱۴۰۰' },
      ],
      education: ['کارشناسی ارشد حسابداری — دانشگاه تهران'],
      skills: ['SAP', 'اکسل پیشرفته', { name: 'بهای تمام‌شده' }],
    },
    0
  )!;
  assert(profile.fullName === 'مریم کاظمی' && profile.openToWork === true, 'a profile is mapped with its open-to-work flag');
  assert(profile.experiences.length === 2 && profile.experiences[1].title === 'حسابدار' && profile.experiences[1].period === '۱۳۹۷ – ۱۴۰۰', 'experience aliases (role/companyName/dates) are understood');
  assert(profile.skills.length === 3 && profile.skills[2] === 'بهای تمام‌شده', 'skills as strings or objects both work');
  assert(normalizeProfile({ id: 'x' }, 0) === null, 'an entry without a name or URL is dropped (never invented)');
  const noFlag = normalizeProfile({ fullName: 'علی', profileUrl: 'https://l/in/x' }, 1)!;
  assert(noFlag.openToWork === false && noFlag.experiences.length === 0, 'missing fields stay empty, not fabricated');

  const text = profileToResumeText(profile);
  assert(text.includes('سابقهٔ کاری') && text.includes('SAP') && text.includes('LinkedIn'), 'the profile becomes readable resume text');
  assert(text.includes('آمادهٔ همکاری'), 'the open-to-work status travels with the text');

  const brief = buildLocalBrief('دنبال کارشناس ارشد حسابداری صنعتی با ۵ سال سابقه در تهران، مسلط به SAP', 'کارشناس حسابداری صنعتی', true);
  assert(brief.engine === 'local' && brief.locations.includes('تهران'), 'the local parser finds the city', brief.locations.join(','));
  assert(Boolean(brief.seniority?.includes('ارشد')), 'the local parser reads seniority', String(brief.seniority));
  assert(brief.skills.includes('SAP') && !brief.skills.includes('آماده'), 'the local parser keeps meaningful keywords and drops filler', brief.skills.join(','));
  assert(brief.booleanQuery.includes(' AND ') && brief.booleanQuery.includes('"کارشناس حسابداری صنعتی"'), 'the boolean query quotes multi-word roles', brief.booleanQuery);
  assert(!/دنبال|میگردم/.test(brief.booleanQuery), 'filler words never reach the query');

  const cleaned = sanitizeBrief({ roleTitle: 'مدیر مالی', locations: ['تهران', '', 42], skills: ['IFRS'], booleanQuery: '', openToWorkOnly: 'yes' }, brief);
  assert(cleaned.roleTitle === 'مدیر مالی' && cleaned.locations.join(',') === 'تهران' && cleaned.skills.join(',') === 'IFRS', 'model output is cleaned into usable lists');
  assert(cleaned.openToWorkOnly === true && cleaned.engine === 'ai', 'a non-boolean openToWorkOnly keeps the request value');

  // ------------------------------------------------- apify / harvestapi ----
  // A real HarvestAPI dataset item, trimmed to the fields HOVIDA reads.
  const apifyItem = (openToWork: boolean | null) => ({
    id: 'ACoAAAA',
    publicIdentifier: 'maryam-kazemi',
    linkedinUrl: 'https://www.linkedin.com/in/maryam-kazemi',
    firstName: 'مریم',
    lastName: 'کاظمی',
    headline: 'کارشناس ارشد حسابداری صنعتی | SAP',
    openToWork,
    location: { linkedinText: 'Tehran, Tehran Province, Iran', parsed: { text: 'Tehran, Iran', city: 'Tehran' } },
    currentPosition: [{ companyName: 'گروه صنعتی البرز' }],
    experience: [
      {
        position: 'کارشناس ارشد حسابداری صنعتی',
        companyName: 'گروه صنعتی البرز',
        duration: '1 yr 7 mos',
        startDate: { month: 'Jan', year: 2024, text: 'Jan 2024' },
        endDate: { text: 'Present' },
        description: 'بهای تمام‌شده و گزارش‌های مدیریتی',
      },
    ],
    education: [{ schoolName: 'دانشگاه تهران', degree: 'کارشناسی ارشد' }],
    skills: ['SAP', 'اکسل پیشرفته'],
  });

  const apifyBrief = buildLocalBrief('دنبال کارشناس حسابداری صنعتی مسلط به SAP در تهران', 'کارشناس حسابداری صنعتی', true);
  const apifyRunInput = apifyInput(apifyBrief, 100);
  assert(apifyRunInput.profileScraperMode === 'Full' && apifyRunInput.maxItems === 100, 'the Apify input asks for full profiles and the requested count');
  assert(apifyRunInput.takePages === 4, 'pages are derived from the requested profiles (25 per page)', String(apifyRunInput.takePages));
  assert(JSON.stringify(apifyRunInput.locations) === '["Tehran"]', 'Persian city names are translated for LinkedIn', JSON.stringify(apifyRunInput.locations));
  assert(apifyRunInput.currentJobTitles?.[0] === 'کارشناس حسابداری صنعتی', 'the role becomes a title filter, not a fuzzy word');
  assert(!('openToWorkOnly' in apifyRunInput) && !JSON.stringify(apifyRunInput).includes('openToWork'), 'the actor has no open-to-work filter and we never pretend it does');

  const apifyProfile = normalizeProfile(apifyItem(true), 0)!;
  assert(apifyProfile.fullName === 'مریم کاظمی' && apifyProfile.location === 'Tehran, Tehran Province, Iran', 'first/last name and the nested location are read', `${apifyProfile.fullName} / ${apifyProfile.location}`);
  assert(apifyProfile.experiences[0].title === 'کارشناس ارشد حسابداری صنعتی' && apifyProfile.experiences[0].company === 'گروه صنعتی البرز' && apifyProfile.experiences[0].period === '1 yr 7 mos', 'HarvestAPI experience fields (position/companyName/duration) map correctly');
  assert(apifyProfile.education[0] === 'دانشگاه تهران — کارشناسی ارشد' && apifyProfile.skills.length === 2, 'education keeps school + degree and skills stay a list');
  assert(apifyProfile.currentCompany === 'گروه صنعتی البرز' && apifyProfile.profileUrl.includes('/in/maryam-kazemi'), 'current company falls back to currentPosition');

  const onlyOpen = finishProfiles([apifyItem(true), apifyItem(false), apifyItem(null)], true, 25);
  assert(onlyOpen.state === 'done' && onlyOpen.items.length === 1 && onlyOpen.items[0].fullName === 'مریم کاظمی', 'only profiles the provider reports as open-to-work are kept');
  assert(/۳ پروفایل/.test(onlyOpen.notes || '') && /۱ نفر/.test(onlyOpen.notes || ''), 'the note says how many were checked and how many qualified', onlyOpen.notes || '');
  const withUnknown = finishProfiles([apifyItem(null)], true, 25);
  assert(withUnknown.items.length === 0, 'an unknown status is not treated as «open to work»');
  const everyone = finishProfiles([apifyItem(true), apifyItem(false), apifyItem(null)], false, 25);
  assert(everyone.items.length === 3 && everyone.items[1].openToWork === false, 'when the filter is off, unreported profiles still say «not open to work», never «yes»');
  const capped = finishProfiles([apifyItem(true), apifyItem(true), apifyItem(true)], true, 2);
  assert(capped.items.length === 2 && /۲ نفر/.test(capped.notes || ''), 'the display cap is reported, not silently applied', capped.notes || '');
  const noneReported = finishProfiles([apifyItem(false)], true, 25);
  assert(noneReported.items.length === 0 && /«آمادهٔ همکاری» را گزارش نکرد/.test(noneReported.notes || ''), 'a run without qualified people explains itself', noneReported.notes || '');

  delete process.env.LINKEDIN_API_URL;
  delete process.env.LINKEDIN_ACCESS_TOKEN;
  const status = sourcingStatus();
  assert(
    status.configured === false && status.setupHint.includes('اتصال‌ها'),
    'without credentials the status says exactly where to set them (admin panel)',
    status.setupHint
  );
}

// -------------------------------------------------- import a CSV file ----

{
  // Quoted cells with a comma, an escaped quote and an embedded newline.
  const tricky = parseCsv('a,b\r\n"x, y","he said ""hi""\nsecond line"\r\n');
  assert(tricky.rows.length === 2 && tricky.rows[1][0] === 'x, y', 'a quoted comma stays inside one cell', JSON.stringify(tricky.rows[1]?.[0]));
  assert(tricky.rows[1][1] === 'he said "hi"\nsecond line', 'escaped quotes and embedded newlines survive');
  assert(parseCsv('a;b;c\n1;2;3').separator === ';', 'a semicolon file is detected (Excel in fa-IR)');
  assert(parseCsv('a\tb\n1\t2').separator === '\t', 'a tab-separated file is detected');

  const fa = profilesFromCsv(
    '\uFEFFنام و نام خانوادگی,عنوان شغلی,شهر,شرکت,مهارت‌ها,تحصیلات,وضعیت همکاری,ایمیل\n' +
      'مریم کاظمی,کارشناس ارشد حسابداری صنعتی,تهران,گروه صنعتی البرز,"SAP، اکسل پیشرفته",کارشناسی ارشد حسابداری,بله,maryam@example.com\n' +
      'حسین رضایی,حسابدار,کرج,شرکت آریا,اکسل,کارشناسی حسابداری,خیر,\n' +
      ',بدون نام,شیراز,,,,\n'
  );
  assert(fa.profiles.length === 2 && fa.skippedRows === 1, 'Persian headers are understood and a nameless row is skipped', `${fa.profiles.length}/${fa.skippedRows}`);
  assert(fa.recognised.includes('نام') && fa.recognised.includes('مهارت‌ها') && fa.recognised.includes('وضعیت همکاری'), 'the recognised columns are reported in Persian', fa.recognised.join('، '));
  assert(fa.hasOpenToWorkColumn === true, 'the file reports the open-to-work status');
  assert(fa.profiles[0].openToWork === true && fa.profiles[1].openToWork === false, 'the status is read per person (بله/خیر)');
  assert(fa.profiles[0].skills.length === 2 && fa.profiles[0].skills[0] === 'SAP', 'a skills cell is split into a list', fa.profiles[0].skills.join('|'));
  assert(fa.profiles[0].email === 'maryam@example.com' && fa.profiles[1].email === null, 'a valid e-mail is kept, an empty cell is not invented');
  assert(fa.profiles[0].experiences[0].title === 'کارشناس ارشد حسابداری صنعتی' && fa.profiles[0].currentCompany === 'گروه صنعتی البرز', 'title and company become the experience row');

  const en = profilesFromCsv(
    'First Name,Last Name,Headline,Location,Current Company,Profile URL,Open to work,Skills\n' +
      'Sara,Ahmadi,Product Manager,Tehran,Acme,https://www.linkedin.com/in/sara-ahmadi,YES,roadmap; discovery\n' +
      'Sara,Ahmadi,Product Manager,Tehran,Acme,https://www.linkedin.com/in/sara-ahmadi,YES,roadmap\n' +
      'Reza,Karimi,Backend Developer,Isfahan,Behsazan,https://www.linkedin.com/in/reza-karimi,,Node.js\n'
  );
  assert(en.profiles.length === 2, 'a repeated person in the file is counted once', String(en.profiles.length));
  assert(en.profiles[0].fullName === 'Sara Ahmadi' && en.profiles[1].fullName === 'Reza Karimi', 'first + last name are joined');
  assert(en.profiles[1].openToWork === false, 'an empty status cell is not treated as «open to work»');
  assert(en.warnings.some((w) => w.includes('تکرار')), 'the duplicate is mentioned in the warnings', en.warnings.join(' | '));

  const noHeader = readCsv('مریم کاظمی,کارشناس حسابداری,تهران\nحسین رضایی,حسابدار,کرج');
  assert(noHeader.mapping.fullName === 0 && noHeader.mapping.headline === 1, 'a header-less file falls back to positions');
  assert(noHeader.warnings.some((w) => w.includes('عنوان ستون')), 'the fallback is disclosed, not silent');

  const noStatus = profilesFromCsv('Name,Headline\nمریم کاظمی,حسابدار');
  assert(noStatus.hasOpenToWorkColumn === false, 'a file without the status column is reported as such');
  assert(/ستون «آمادهٔ همکاری» در فایل نبود/.test(csvSummary(noStatus, 1, 0, true)), 'the summary explains why the filter was not applied');

  const filtered = profilesFromCsv('Name,Open to work\nمریم کاظمی,yes\nحسین رضایی,no');
  const summary = csvSummary(filtered, 1, 1, true);
  assert(/از ۲ ردیف فایل/.test(summary) && /۱ نفر در فایل «آمادهٔ همکاری» نبودند/.test(summary), 'the summary counts what was filtered out', summary);

  const empty = profilesFromCsv('');
  assert(empty.profiles.length === 0 && empty.warnings.length > 0, 'an empty file explains itself');
}

// ------------------------------------------- Google access-token refresh ----

/**
 * The stored access token lives one hour; after that the refresh token must be
 * used silently. A throwaway HTTP server stands in for Google's token endpoint
 * so this contract is checked without any real account.
 */
async function refreshBlock() {
  const http = await import('http');
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const params = new URLSearchParams(raw);
      seen.push(String(params.get('grant_type')));
      if (params.get('client_id') !== 'unit-client' || params.get('client_secret') !== 'unit-secret') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_client' }));
      }
      if (params.get('refresh_token') !== 'refresh-ok') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'fresh-access', expires_in: 3599, token_type: 'Bearer' }));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));

  process.env.GOOGLE_CLIENT_ID = 'unit-client';
  process.env.GOOGLE_CLIENT_SECRET = 'unit-secret';
  process.env.GOOGLE_TOKEN_URL = `http://127.0.0.1:${port}/token`;
  const decrypt = (v: string) => (v.startsWith('plain:') ? v.slice(6) : null);
  const encrypt = (v: string) => `plain:${v}`;

  const expired: OrgSecrets = {
    calendar: {
      accountEmail: 'hr@example.com',
      refreshTokenEnc: 'plain:refresh-ok',
      accessTokenEnc: 'plain:stale-access',
      expiresAt: Date.now() - 1000,
      calendarId: 'primary',
      connectedAtISO: new Date().toISOString(),
    },
  } as OrgSecrets;
  const token = await accessTokenFor(expired, decrypt, encrypt);
  assert(token === 'fresh-access', 'an expired access token is refreshed silently', token);
  assert(expired.calendar!.accessTokenEnc === 'plain:fresh-access', 'the new access token is stored encrypted');
  assert(expired.calendar!.expiresAt > Date.now() + 3_000_000, 'the new expiry is recorded');

  const stillValid: OrgSecrets = {
    calendar: {
      accountEmail: 'hr@example.com',
      refreshTokenEnc: 'plain:refresh-ok',
      accessTokenEnc: 'plain:live-access',
      expiresAt: Date.now() + 3600_000,
      calendarId: 'primary',
      connectedAtISO: new Date().toISOString(),
    },
  } as OrgSecrets;
  const before = seen.length;
  assert((await accessTokenFor(stillValid, decrypt, encrypt)) === 'live-access' && seen.length === before, 'a valid access token is reused without calling Google');

  const revoked: OrgSecrets = { calendar: { ...expired.calendar!, refreshTokenEnc: 'plain:revoked', accessTokenEnc: null, expiresAt: 0 } } as OrgSecrets;
  let message = '';
  try {
    await accessTokenFor(revoked, decrypt, encrypt);
  } catch (err: any) {
    message = err?.message || '';
  }
  assert(/دسترسی را نداد/.test(message), 'a revoked refresh token is reported in Persian, not swallowed', message);

  const missing: OrgSecrets = {} as OrgSecrets;
  let missingMessage = '';
  try {
    await accessTokenFor(missing, decrypt, encrypt);
  } catch (err: any) {
    missingMessage = err?.message || '';
  }
  assert(/وصل نیست/.test(missingMessage), 'without a connected account the error says so', missingMessage);

  server.close();
  delete process.env.GOOGLE_TOKEN_URL;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
}

await refreshBlock();

if (failures > 0) {
  console.error(`\n${failures} integration test(s) failed.`);
  process.exit(1);
}
console.log('\nAll integration unit tests passed.');

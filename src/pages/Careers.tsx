import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, BriefcaseBusiness, CheckCircle2, FileUp, Languages, MapPin, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, Select, TextArea, TextInput } from '../components/ui';
import { api } from '../lib/api';
import { Link, navigate, setQuery, useLocation } from '../lib/router';
import { useTitle } from '../lib/useTitle';
import { useAsync } from '../lib/useAsync';
import { PORTAL_DIR, portalNumber, t } from '../lib/portal-i18n';
import type { CareerApplicationInput, PortalLang, PublicJobDetail } from '../types/careers';
import type { EmploymentType } from '../types/screening';

const TYPE_LABEL: Record<PortalLang, Record<EmploymentType, string>> = {
  fa: {
    'full-time': 'تمام‌وقت',
    'part-time': 'پاره‌وقت',
    contract: 'پیمانی',
    remote: 'دورکاری',
    hybrid: 'ترکیبی',
    internship: 'کارآموزی',
  },
  en: {
    'full-time': 'Full-time',
    'part-time': 'Part-time',
    contract: 'Contract',
    remote: 'Remote',
    hybrid: 'Hybrid',
    internship: 'Internship',
  },
};

const MAX_MB = 8;

/**
 * «پورتال شغلی» — the page a stranger sees, with no account and no app.
 *
 * It is deliberately outside the workspace shell: a candidate should meet the
 * employer's brand, not HOVIDA's navigation. Everything it shows comes from the
 * public API, which returns only published openings.
 *
 * «دوزبانه»: the chrome follows `?lang=`, but the job text is the employer's own
 * — the English version when HR wrote one, the original otherwise, said plainly.
 */
export default function Careers({ slug, jobId }: { slug: string; jobId?: string }) {
  const pageQ = useAsync(() => api.careers.page(slug), [slug]);
  const { search } = useLocation();
  // A colleague's referral code must survive the step from the list to the job.
  const params = new URLSearchParams(search);
  const ref = params.get('ref') || '';
  const portal = pageQ.data?.portal;
  const asked = params.get('lang');
  const lang: PortalLang = portal?.languages.includes(asked as PortalLang) ? (asked as PortalLang) : portal?.defaultLang || 'fa';
  useTitle(jobId ? t(lang, 'portal') : pageQ.data?.org.name || t(lang, 'portal'));

  const shell = { lang, languages: portal?.languages || (['fa'] as PortalLang[]), orgName: pageQ.data?.org.name };

  if (pageQ.error) {
    return (
      <Shell {...shell}>
        <div className="hv-card p-10 text-center max-w-lg mx-auto">
          <BriefcaseBusiness className="w-8 h-8 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <h1 className="text-[17px] font-bold text-ink">{t(lang, 'notFoundTitle')}</h1>
          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">{pageQ.error}</p>
          <p className="text-[12px] text-ink-4 mt-3">{t(lang, 'notFoundNote')}</p>
        </div>
      </Shell>
    );
  }
  if (!pageQ.data) {
    return (
      <Shell {...shell}>
        <div className="space-y-4">
          <div className="hv-card h-32 animate-pulse" />
          <div className="hv-card h-24 animate-pulse" />
        </div>
      </Shell>
    );
  }

  const { org, jobs } = pageQ.data;
  if (jobId) return <JobPage slug={slug} jobId={jobId} orgName={org.name} lang={lang} languages={shell.languages} ref_={ref} />;

  const linkFor = (id: string) => {
    const qs = new URLSearchParams();
    if (ref) qs.set('ref', ref);
    if (lang !== (portal?.defaultLang || 'fa')) qs.set('lang', lang);
    const q = qs.toString();
    return `/careers/${slug}/jobs/${id}${q ? `?${q}` : ''}`;
  };

  return (
    <Shell {...shell}>
      <header className="mb-8">
        <p className="text-[12px] font-semibold text-brand-strong mb-2">{t(lang, 'portal')}</p>
        <h1 className="text-2xl sm:text-[28px] font-extrabold text-ink leading-tight">{org.name}</h1>
        {org.about && <p className="text-[14px] text-ink-2 mt-3 leading-relaxed max-w-2xl whitespace-pre-line">{org.about}</p>}
        <p className="text-[12.5px] text-ink-3 mt-4">
          {jobs.length ? t(lang, 'openRoles', { n: portalNumber(lang, jobs.length) }) : t(lang, 'noRolesHere')}
        </p>
      </header>

      {jobs.length === 0 ? (
        <div className="hv-card p-8 text-center">
          <Sparkles className="w-7 h-7 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <p className="text-[14px] font-semibold text-ink">{t(lang, 'noRolesTitle')}</p>
          <p className="text-[13px] text-ink-3 mt-1.5">{t(lang, 'noRolesNote')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link to={linkFor(j.id)} className="hv-card p-4 sm:p-5 flex items-start gap-4 hover:border-brand/40 transition-colors group">
                <span className="w-10 h-10 rounded-[12px] bg-brand-tint text-brand-strong flex items-center justify-center shrink-0">
                  <BriefcaseBusiness className="w-[18px] h-[18px]" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-bold text-ink group-hover:text-brand-stronger">
                    {lang === 'en' && j.titleEn ? j.titleEn : j.roleTitle}
                  </p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <Chip tone="outline">{j.departmentName}</Chip>
                    {j.location && (
                      <Chip tone="neutral" icon={MapPin}>
                        {j.location}
                      </Chip>
                    )}
                    {j.employmentType && <Chip tone="neutral">{TYPE_LABEL[lang][j.employmentType]}</Chip>}
                    {j.seniority && <Chip tone="neutral">{j.seniority}</Chip>}
                    {j.applyByJalali && <Chip tone="outline">{`${t(lang, 'deadline')}: ${j.applyByJalali}`}</Chip>}
                  </div>
                  {j.summary && <p className="text-[13px] text-ink-3 mt-2.5 leading-relaxed line-clamp-2">{j.summary}</p>}
                </div>
                <ArrowLeft className="w-4 h-4 text-ink-4 group-hover:text-brand-strong shrink-0 mt-1" strokeWidth={2} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function JobPage({
  slug,
  jobId,
  orgName,
  lang,
  languages,
  ref_,
}: {
  slug: string;
  jobId: string;
  orgName: string;
  lang: PortalLang;
  languages: PortalLang[];
  ref_: string;
}) {
  const jobQ = useAsync(() => api.careers.job(slug, jobId), [slug, jobId]);
  const job = jobQ.data?.job;
  const [sent, setSent] = useState<{ message: string } | null>(null);

  if (jobQ.error) {
    return (
      <Shell lang={lang} languages={languages} orgName={orgName}>
        <div className="hv-card p-8 text-center">
          <p className="text-[14px] font-bold text-ink">{t(lang, 'jobClosedTitle')}</p>
          <p className="text-[13px] text-ink-3 mt-2">{jobQ.error}</p>
          <Button variant="secondary" className="mt-4" onClick={() => navigate(`/careers/${slug}`)}>
            {t(lang, 'allRoles')}
          </Button>
        </div>
      </Shell>
    );
  }
  if (!job) {
    return (
      <Shell lang={lang} languages={languages} orgName={orgName}>
        <div className="hv-card h-64 animate-pulse" />
      </Shell>
    );
  }

  const title = lang === 'en' && job.titleEn ? job.titleEn : job.roleTitle;
  // The employer's words, or their original language with an honest note.
  const body = lang === 'en' ? job.descriptionEn || job.description || job.summary : job.description || job.summary;
  const needsNotice = lang === 'en' && !job.titleEn && !job.descriptionEn;

  return (
    <Shell lang={lang} languages={languages} orgName={orgName}>
      <button
        type="button"
        onClick={() => navigate(`/careers/${slug}`)}
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4"
      >
        <ArrowRight className="w-4 h-4" strokeWidth={2} />
        {t(lang, 'allRoles')}
      </button>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <article className="hv-card p-5 sm:p-6">
          <h1 className="text-xl sm:text-[24px] font-extrabold text-ink leading-snug">{title}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Chip tone="outline">{job.departmentName}</Chip>
            {job.location && (
              <Chip tone="neutral" icon={MapPin}>
                {job.location}
              </Chip>
            )}
            {job.employmentType && <Chip tone="neutral">{TYPE_LABEL[lang][job.employmentType]}</Chip>}
            {job.seniority && <Chip tone="neutral">{job.seniority}</Chip>}
            {job.applyByJalali && !job.expired && <Chip tone="warning">{`${t(lang, 'applyBy')}: ${job.applyByJalali}`}</Chip>}
          </div>

          {needsNotice && <Callout tone="warning" className="mt-4">{t(lang, 'originalNotice')}</Callout>}

          <section className="mt-6">
            <h2 className="text-[14px] font-bold text-ink mb-2">{t(lang, 'aboutRole')}</h2>
            <p className="text-[13.5px] text-ink-2 leading-relaxed whitespace-pre-line">{body || t(lang, 'descriptionFallback')}</p>
          </section>

          {job.requirements.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[14px] font-bold text-ink mb-2.5">{t(lang, 'requirements')}</h2>
              <ul className="space-y-2">
                {job.requirements.map((r) => (
                  <li key={r} className="flex items-start gap-2 text-[13.5px] text-ink-2 leading-relaxed">
                    <CheckCircle2 className="w-[17px] h-[17px] text-brand-strong shrink-0 mt-0.5" strokeWidth={1.9} />
                    {r}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <Callout tone="info" className="mt-6" icon={ShieldCheck} title={t(lang, 'processTitle')}>
            {t(lang, 'processBody')}
          </Callout>
        </article>

        <div className="hv-card p-5 sm:p-6 lg:sticky lg:top-6">
          {sent ? (
            <div className="text-center py-6">
              <span className="w-12 h-12 rounded-full bg-brand-soft text-brand-strong flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-6 h-6" strokeWidth={2} />
              </span>
              <p className="text-[15px] font-bold text-ink">{t(lang, 'sentTitle')}</p>
              <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">{sent.message}</p>
              <button type="button" onClick={() => setSent(null)} className="text-[12.5px] text-brand-strong mt-4 hover:underline">
                {t(lang, 'sendAnother')}
              </button>
            </div>
          ) : job.expired ? (
            <div className="text-center py-4">
              <span className="w-12 h-12 rounded-full bg-review-soft text-review-ink flex items-center justify-center mx-auto mb-3">
                <AlertTriangle className="w-6 h-6" strokeWidth={2} />
              </span>
              <p className="text-[15px] font-bold text-ink">{t(lang, 'expiredTitle')}</p>
              <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">
                {job.applyByJalali ? t(lang, 'expiredWithDate', { date: job.applyByJalali }) : t(lang, 'expiredNoDate')} {t(lang, 'expiredLookAround')}
              </p>
              <Button variant="secondary" className="mt-4" onClick={() => navigate(`/careers/${slug}`)}>
                {t(lang, 'allRoles')}
              </Button>
            </div>
          ) : (
            <ApplyForm slug={slug} job={job} lang={lang} refCode={ref_} onSent={(message) => setSent({ message })} />
          )}
        </div>
      </div>
    </Shell>
  );
}

function ApplyForm({
  slug,
  job,
  lang,
  refCode,
  onSent,
}: {
  slug: string;
  job: PublicJobDetail;
  lang: PortalLang;
  refCode: string;
  onSent: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [message, setMessage] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileBase64, setFileBase64] = useState('');
  const [pasted, setPasted] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [heardFrom, setHeardFrom] = useState('');
  // A colleague's referral link lands here as ?ref=… — recorded on the application.
  const ref = refCode;

  async function pickFile(f: File | null) {
    setError(null);
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(t(lang, 'errSize', { n: MAX_MB }));
      return;
    }
    const buf = await f.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    setFileBase64(btoa(binary));
    setFileName(f.name);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!consent) return setError(t(lang, 'errConsent'));
    if (!fileBase64 && pasted.trim().length < 50) return setError(t(lang, 'errResume'));
    setBusy(true);
    try {
      const body: CareerApplicationInput = {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        city: city.trim(),
        message: message.trim(),
        fileName: fileName || undefined,
        fileBase64: fileBase64 || undefined,
        text: fileBase64 ? undefined : pasted,
        consent: true,
        answers,
        heardFrom: heardFrom || undefined,
        ref: ref || undefined,
      };
      const res = await api.careers.apply(slug, job.id, body);
      onSent(res.message);
    } catch (err: any) {
      setError(err?.message || t(lang, 'errGeneric'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <div>
        <h2 className="text-[15px] font-bold text-ink">{t(lang, 'applyTitle')}</h2>
        <p className="text-[12px] text-ink-3 mt-1">{t(lang, 'applyNote')}</p>
      </div>

      <TextInput label={t(lang, 'name')} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
      <TextInput
        label={t(lang, 'email')}
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        latin
        autoComplete="email"
        hint={t(lang, 'emailHint')}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextInput label={t(lang, 'phone')} value={phone} onChange={(e) => setPhone(e.target.value)} latin placeholder="09121234567" autoComplete="tel" />
        <TextInput label={t(lang, 'city')} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
      </div>

      <div className="rounded-[12px] border border-dashed border-line-strong px-3.5 py-3 bg-canvas">
        <label className="flex items-center gap-2 cursor-pointer text-[13px] font-semibold text-ink-2">
          <FileUp className="w-[18px] h-[18px] text-brand-strong" strokeWidth={1.9} />
          {fileName ? t(lang, 'fileChosen', { name: fileName }) : t(lang, 'fileChoose')}
          <input
            type="file"
            className="sr-only"
            accept=".pdf,.doc,.docx,.odt,.rtf,.txt,.md,.png,.jpg,.jpeg,.webp"
            onChange={(e) => void pickFile(e.target.files?.[0] || null)}
          />
        </label>
        {fileName && (
          <button
            type="button"
            className="text-[12px] text-ink-3 hover:text-low-ink mt-1.5"
            onClick={() => {
              setFileName('');
              setFileBase64('');
            }}
          >
            {t(lang, 'fileRemove')}
          </button>
        )}
        {!fileName && <TextArea className="mt-3" rows={3} placeholder={t(lang, 'pastePlaceholder')} value={pasted} onChange={(e) => setPasted(e.target.value)} />}
      </div>

      <TextArea
        label={t(lang, 'aboutYourself')}
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        hint={t(lang, 'aboutYourselfHint')}
      />

      <Select
        label={t(lang, 'heardFrom')}
        value={heardFrom}
        onChange={(e) => setHeardFrom(e.target.value)}
        placeholder={t(lang, 'heardFromOptional')}
        options={[
          { value: 'پورتال شغلی', label: t(lang, 'fromPortal') },
          { value: 'معرفی همکار', label: t(lang, 'fromReferral') },
          { value: 'شبکه‌های اجتماعی', label: t(lang, 'fromSocial') },
          { value: 'سایت سازمان', label: t(lang, 'fromSite') },
          { value: 'سایر', label: t(lang, 'fromOther') },
        ]}
        optional
        hint={ref ? t(lang, 'refNote', { ref }) : undefined}
      />

      {job.questions.slice(0, 4).map((q) =>
        q.options?.length ? (
          <Select
            key={q.id}
            label={q.label}
            value={answers[q.id] || ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            placeholder={t(lang, 'heardFromOptional')}
            options={q.options.map((o) => ({ value: o, label: o }))}
            optional
          />
        ) : (
          <TextInput key={q.id} label={q.label} value={answers[q.id] || ''} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} optional />
        )
      )}

      <label className="flex items-start gap-2 text-[12.5px] text-ink-2 leading-relaxed cursor-pointer">
        <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[var(--brand)]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        {t(lang, 'consent')}
      </label>

      {error && (
        <p role="alert" className="text-[12.5px] text-low-ink font-medium leading-relaxed">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" loading={busy} disabled={busy}>
        <Send className="w-4 h-4" /> {t(lang, 'submit')}
      </Button>
      <p className="text-[11.5px] text-ink-4 text-center leading-relaxed">{t(lang, 'submitNote')}</p>
    </form>
  );
}

function Shell({
  children,
  orgName,
  lang,
  languages,
}: {
  children: React.ReactNode;
  orgName?: string;
  lang: PortalLang;
  languages: PortalLang[];
}) {
  useEffect(() => {
    document.documentElement.dir = PORTAL_DIR[lang];
    document.documentElement.lang = lang;
  }, [lang]);
  const canSwitch = languages.includes('en');
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface/90 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <HovidaLogo className="h-6 w-auto shrink-0" />
            <span className="text-[12px] text-ink-3 hidden sm:inline">{t(lang, 'portal')}</span>
          </div>
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-[13px] font-semibold text-ink-2 truncate">{orgName || ''}</span>
            {canSwitch && (
              <button
                type="button"
                onClick={() => setQuery({ lang: lang === 'fa' ? 'en' : 'fa' })}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:border-line-strong"
                title={lang === 'fa' ? 'Read this page in English' : 'این صفحه را فارسی بخوانید'}
              >
                <Languages className="w-3.5 h-3.5" />
                {t(lang, 'switchTo')}
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">{children}</main>
      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 text-[11.5px] text-ink-4">{t(lang, 'footer', { org: orgName || '' })}</footer>
    </div>
  );
}

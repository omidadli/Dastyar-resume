import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, BriefcaseBusiness, CheckCircle2, FileUp, Loader2, MapPin, Send, ShieldCheck, Sparkles } from 'lucide-react';
import { HovidaLogo } from '../components/brand/Logo';
import { Button, Callout, Chip, Field, Select, TextArea, TextInput, toast } from '../components/ui';
import { api } from '../lib/api';
import { Link, navigate } from '../lib/router';
import { useTitle } from '../lib/useTitle';
import { useAsync } from '../lib/useAsync';
import type { CareerApplicationInput, PublicJobDetail } from '../types/careers';
import type { EmploymentType } from '../types/screening';

const TYPE_LABEL: Record<EmploymentType, string> = {
  'full-time': 'تمام‌وقت',
  'part-time': 'پاره‌وقت',
  contract: 'پیمانی',
  remote: 'دورکاری',
  hybrid: 'ترکیبی',
  internship: 'کارآموزی',
};

const MAX_MB = 8;

/**
 * «پورتال شغلی» — the page a stranger sees, with no account and no app.
 *
 * It is deliberately outside the workspace shell: a candidate should meet the
 * employer's brand, not HOVIDA's navigation. Everything it shows comes from the
 * public API, which returns only published openings.
 */
export default function Careers({ slug, jobId }: { slug: string; jobId?: string }) {
  const pageQ = useAsync(() => api.careers.page(slug), [slug]);
  useTitle(jobId ? 'درخواست همکاری' : pageQ.data?.org.name || 'فرصت‌های شغلی');

  if (pageQ.error) {
    return (
      <Shell>
        <div className="hv-card p-10 text-center max-w-lg mx-auto">
          <BriefcaseBusiness className="w-8 h-8 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <h1 className="text-[17px] font-bold text-ink">این صفحهٔ استخدام در دسترس نیست</h1>
          <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">{pageQ.error}</p>
          <p className="text-[12px] text-ink-4 mt-3">نشانی را بررسی کنید یا با واحد منابع انسانی سازمان تماس بگیرید.</p>
        </div>
      </Shell>
    );
  }
  if (!pageQ.data) {
    return (
      <Shell>
        <div className="space-y-4">
          <div className="hv-card h-32 animate-pulse" />
          <div className="hv-card h-24 animate-pulse" />
        </div>
      </Shell>
    );
  }

  const { org, jobs } = pageQ.data;
  if (jobId) return <JobPage slug={slug} jobId={jobId} orgName={org.name} />;

  return (
    <Shell orgName={org.name}>
      <header className="mb-8">
        <p className="text-[12px] font-semibold text-brand-strong mb-2">فرصت‌های شغلی</p>
        <h1 className="text-2xl sm:text-[28px] font-extrabold text-ink leading-tight">{org.name}</h1>
        {org.about && <p className="text-[14px] text-ink-2 mt-3 leading-relaxed max-w-2xl whitespace-pre-line">{org.about}</p>}
        <p className="text-[12.5px] text-ink-3 mt-4">
          {jobs.length ? `${jobs.length} فرصت شغلی منتشرشده` : 'در حال حاضر فرصت شغلی منتشرشده‌ای نداریم.'}
        </p>
      </header>

      {jobs.length === 0 ? (
        <div className="hv-card p-8 text-center">
          <Sparkles className="w-7 h-7 text-ink-4 mx-auto mb-3" strokeWidth={1.6} />
          <p className="text-[14px] font-semibold text-ink">به‌زودی فرصت‌های تازه این‌جا منتشر می‌شود</p>
          <p className="text-[13px] text-ink-3 mt-1.5">می‌توانید بعداً دوباره سر بزنید.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                to={`/careers/${slug}/jobs/${j.id}`}
                className="hv-card p-4 sm:p-5 flex items-start gap-4 hover:border-brand/40 transition-colors group"
              >
                <span className="w-10 h-10 rounded-[12px] bg-brand-tint text-brand-strong flex items-center justify-center shrink-0">
                  <BriefcaseBusiness className="w-[18px] h-[18px]" strokeWidth={1.9} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-bold text-ink group-hover:text-brand-stronger">{j.roleTitle}</p>
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    <Chip tone="outline">{j.departmentName}</Chip>
                    {j.location && (
                      <Chip tone="neutral" icon={MapPin}>
                        {j.location}
                      </Chip>
                    )}
                    {j.employmentType && <Chip tone="neutral">{TYPE_LABEL[j.employmentType]}</Chip>}
                    {j.seniority && <Chip tone="neutral">{j.seniority}</Chip>}
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

function JobPage({ slug, jobId, orgName }: { slug: string; jobId: string; orgName: string }) {
  const jobQ = useAsync(() => api.careers.job(slug, jobId), [slug, jobId]);
  const job = jobQ.data?.job;
  const [sent, setSent] = useState<{ message: string } | null>(null);

  if (jobQ.error) {
    return (
      <Shell orgName={orgName}>
        <div className="hv-card p-8 text-center">
          <p className="text-[14px] font-bold text-ink">این فرصت شغلی منتشر نشده است</p>
          <p className="text-[13px] text-ink-3 mt-2">{jobQ.error}</p>
          <Button variant="secondary" className="mt-4" onClick={() => navigate(`/careers/${slug}`)}>
            همهٔ فرصت‌ها
          </Button>
        </div>
      </Shell>
    );
  }
  if (!job) {
    return (
      <Shell orgName={orgName}>
        <div className="hv-card h-64 animate-pulse" />
      </Shell>
    );
  }

  return (
    <Shell orgName={orgName}>
      <button
        type="button"
        onClick={() => navigate(`/careers/${slug}`)}
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink-2 mb-4"
      >
        <ArrowRight className="w-4 h-4" strokeWidth={2} />
        همهٔ فرصت‌ها
      </button>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_380px] gap-6 items-start">
        <article className="hv-card p-5 sm:p-6">
          <h1 className="text-xl sm:text-[24px] font-extrabold text-ink leading-snug">{job.roleTitle}</h1>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Chip tone="outline">{job.departmentName}</Chip>
            {job.location && (
              <Chip tone="neutral" icon={MapPin}>
                {job.location}
              </Chip>
            )}
            {job.employmentType && <Chip tone="neutral">{TYPE_LABEL[job.employmentType]}</Chip>}
            {job.seniority && <Chip tone="neutral">{job.seniority}</Chip>}
          </div>

          <section className="mt-6">
            <h2 className="text-[14px] font-bold text-ink mb-2">دربارهٔ این نقش</h2>
            <p className="text-[13.5px] text-ink-2 leading-relaxed whitespace-pre-line">
              {job.description || job.summary || 'توضیحات این فرصت شغلی به‌زودی کامل می‌شود.'}
            </p>
          </section>

          {job.requirements.length > 0 && (
            <section className="mt-6">
              <h2 className="text-[14px] font-bold text-ink mb-2.5">آنچه مهم است</h2>
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

          <Callout tone="info" className="mt-6" icon={ShieldCheck} title="دربارهٔ روند بررسی">
            رزومهٔ شما با هوش مصنوعی و بر پایهٔ نیازهای همین نقش بررسی می‌شود؛ هیچ تصمیمی بدون بازبینی همکاران منابع انسانی
            گرفته نمی‌شود. اگر هم‌خوانی باشد، برای هماهنگی مصاحبه با شما تماس می‌گیریم.
          </Callout>
        </article>

        <div className="hv-card p-5 sm:p-6 lg:sticky lg:top-6">
          {sent ? (
            <div className="text-center py-6">
              <span className="w-12 h-12 rounded-full bg-brand-soft text-brand-strong flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="w-6 h-6" strokeWidth={2} />
              </span>
              <p className="text-[15px] font-bold text-ink">درخواست شما ثبت شد</p>
              <p className="text-[13px] text-ink-2 mt-2 leading-relaxed">{sent.message}</p>
              <button type="button" onClick={() => setSent(null)} className="text-[12.5px] text-brand-strong mt-4 hover:underline">
                ارسال درخواست دیگر
              </button>
            </div>
          ) : (
            <ApplyForm slug={slug} job={job} onSent={(message) => setSent({ message })} />
          )}
        </div>
      </div>
    </Shell>
  );
}

function ApplyForm({ slug, job, onSent }: { slug: string; job: PublicJobDetail; onSent: (message: string) => void }) {
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

  async function pickFile(f: File | null) {
    setError(null);
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`حجم فایل بیش از ${MAX_MB} مگابایت است؛ فایل کوچک‌تری انتخاب کنید.`);
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
    if (!consent) return setError('برای ارسال درخواست، تأیید نگه‌داری اطلاعات الزامی است.');
    if (!fileBase64 && pasted.trim().length < 50) return setError('رزومهٔ خود را بارگذاری کنید یا متن آن را بچسبانید.');
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
      };
      const res = await api.careers.apply(slug, job.id, body);
      onSent(res.message);
    } catch (err: any) {
      setError(err?.message || 'ارسال درخواست ممکن نشد؛ کمی بعد دوباره تلاش کنید.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3.5">
      <div>
        <h2 className="text-[15px] font-bold text-ink">ارسال درخواست</h2>
        <p className="text-[12px] text-ink-3 mt-1">چند دقیقه وقت می‌گیرد. اطلاعات فقط برای همین فرصت شغلی بررسی می‌شود.</p>
      </div>

      <TextInput label="نام و نام خانوادگی" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
      <TextInput label="ایمیل" type="email" value={email} onChange={(e) => setEmail(e.target.value)} latin autoComplete="email" hint="برای پاسخ، دست‌کم ایمیل یا موبایل لازم است." />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <TextInput label="موبایل" value={phone} onChange={(e) => setPhone(e.target.value)} latin placeholder="09121234567" autoComplete="tel" />
        <TextInput label="شهر" value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
      </div>

      <div className="rounded-[12px] border border-dashed border-line-strong px-3.5 py-3 bg-canvas">
        <label className="flex items-center gap-2 cursor-pointer text-[13px] font-semibold text-ink-2">
          <FileUp className="w-[18px] h-[18px] text-brand-strong" strokeWidth={1.9} />
          {fileName ? `فایل انتخاب‌شده: ${fileName}` : 'انتخاب فایل رزومه (PDF، Word، تصویر، حداکثر ۸ مگابایت)'}
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
            برداشتن فایل
          </button>
        )}
        {!fileName && (
          <TextArea
            className="mt-3"
            rows={3}
            placeholder="یا متن رزومه را این‌جا بچسبانید…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        )}
      </div>

      <TextArea
        label="چند خط دربارهٔ خودتان (اختیاری)"
        rows={3}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        hint="مثلاً چرا این نقش برای شما جذاب است یا بازهٔ زمانی شروع همکاری."
      />

      {job.questions.slice(0, 4).map((q) =>
        q.options?.length ? (
          <Select
            key={q.id}
            label={q.label}
            value={answers[q.id] || ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            placeholder="انتخاب کنید"
            options={q.options.map((o) => ({ value: o, label: o }))}
            optional
          />
        ) : (
          <TextInput
            key={q.id}
            label={q.label}
            value={answers[q.id] || ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            optional
          />
        )
      )}

      <label className="flex items-start gap-2 text-[12.5px] text-ink-2 leading-relaxed cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 w-4 h-4 accent-[var(--brand)]"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        موافقم رزومه‌ام برای بررسی همین فرصت شغلی نگه‌داری شود و در صورت نیاز همکاران منابع انسانی با من تماس بگیرند.
      </label>

      {error && (
        <p role="alert" className="text-[12.5px] text-low-ink font-medium leading-relaxed">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" loading={busy} disabled={busy}>
        <Send className="w-4 h-4" /> ارسال درخواست
      </Button>
      <p className="text-[11.5px] text-ink-4 text-center leading-relaxed">
        رزومهٔ شما بلافاصله بررسی می‌شود؛ نتیجهٔ بررسی برای تیم منابع انسانی سازمان نمایش داده می‌شود.
      </p>
    </form>
  );
}

function Shell({ children, orgName }: { children: React.ReactNode; orgName?: string }) {
  useEffect(() => {
    document.documentElement.dir = 'rtl';
  }, []);
  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-surface/90 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <HovidaLogo className="h-6 w-auto shrink-0" />
            <span className="text-[12px] text-ink-3 hidden sm:inline">پورتال شغلی</span>
          </div>
          <span className="text-[13px] font-semibold text-ink-2 truncate">{orgName || ''}</span>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-10">{children}</main>
      <footer className="max-w-5xl mx-auto px-4 sm:px-6 py-8 text-[11.5px] text-ink-4">
        این صفحه با HOVIDA ساخته شده است؛ درخواست شما فقط به واحد منابع انسانی {orgName || 'این سازمان'} می‌رسد.
      </footer>
    </div>
  );
}

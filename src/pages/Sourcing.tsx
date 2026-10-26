import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Briefcase,
  CheckCircle2,
  Clock3,
  Copy,
  ExternalLink,
  Filter,
  Link2,
  MapPin,
  Search,
  Sparkles,
  Trash2,
  UserPlus,
  Users,
  Wand2,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Chip,
  EmptyState,
  ErrorState,
  IconButton,
  Select,
  Skeleton,
  Switch,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { copyText } from '../lib/clipboard';
import { emitChange } from '../lib/events';
import { faDate, toPersianDigits } from '../lib/format';
import { navigate, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { SourcingBrief, SourcingProfile, SourcingSearch } from '../types/integrations';

/**
 * «جست‌وجوی استعداد» — describe the specialist you need; the AI turns it into
 * a search brief, the connected LinkedIn provider returns candidates who match
 * and are open to work, and any of them can be added to an opening to be
 * screened by the same engine as an uploaded resume.
 */
export default function Sourcing() {
  useTitle('جست‌وجوی استعداد');
  const { org } = useAuth();
  const { query } = useLocation();
  const jobsQ = useAsync(() => api.jobs.list(), []);
  const statusQ = useAsync(() => api.sourcing.status(), []);
  const historyQ = useAsync(() => api.sourcing.list(), []);

  const [departmentId, setDepartmentId] = useState('');
  const [jobId, setJobId] = useState(query.get('job') || '');
  const [prompt, setPrompt] = useState('');
  const [roleTitle, setRoleTitle] = useState('');
  const [openToWorkOnly, setOpenToWorkOnly] = useState(true);
  const [brief, setBrief] = useState<SourcingBrief | null>(null);
  const [briefing, setBriefing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState<SourcingSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetJobId, setTargetJobId] = useState('');
  const [importing, setImporting] = useState<string | null>(null);

  const departments = org?.departments || [];
  const jobs = jobsQ.data?.items || [];

  useEffect(() => {
    if (!departmentId && departments.length) setDepartmentId(departments[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departments.length]);

  // The chosen opening drives the department (and vice versa).
  useEffect(() => {
    if (!jobId) return;
    const job = jobs.find((j) => j.id === jobId);
    if (job) {
      setRoleTitle(job.roleTitle);
      setTargetJobId(job.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobs.length]);

  const deptJobs = useMemo(() => jobs.filter((j) => !departmentId || j.departmentId === departmentId), [jobs, departmentId]);
  const targetJob = jobs.find((j) => j.id === (targetJobId || jobId)) || null;

  const openSearch = async (id: string) => {
    try {
      const { search: found } = await api.sourcing.get(id);
      setSearch(found);
      setBrief(found.brief);
      setDepartmentId(found.departmentId);
      setJobId(found.jobId || '');
      setTargetJobId(found.jobId || '');
      setPrompt(found.prompt);
      setRoleTitle(found.brief.roleTitle);
      setError(found.status === 'not_configured' || found.status === 'error' ? found.message : null);
      navigate(`/app/sourcing?search=${found.id}`, { keepScroll: false, replace: true });
    } catch (e: any) {
      toast(e?.message || 'این جست‌وجو باز نشد.', 'error');
    }
  };

  useEffect(() => {
    const id = query.get('search');
    if (id) void openSearch(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.get('search')]);

  const makeBrief = async () => {
    setBriefing(true);
    setError(null);
    try {
      const { brief: made } = await api.sourcing.brief({
        departmentId,
        jobId: jobId || null,
        prompt,
        roleTitle,
        openToWorkOnly,
      });
      setBrief(made);
      toast(made.engine === 'ai' ? 'شرایط جست‌وجو آماده شد؛ می‌توانید کوئری را ویرایش کنید.' : 'شرایط سادهٔ جست‌وجو ساخته شد (هوش مصنوعی در دسترس نبود).', 'info');
    } catch (e: any) {
      setError(e?.message || 'ساخت شرایط جست‌وجو ممکن نشد.');
    } finally {
      setBriefing(false);
    }
  };

  const runSearch = async () => {
    if (!departmentId) return toast('ابتدا دپارتمان را انتخاب کنید.', 'error');
    if (!prompt.trim() && !roleTitle.trim() && !brief) return toast('بنویسید دنبال چه متخصصی هستید.', 'error');
    setSearching(true);
    setError(null);
    setSearch(null);
    try {
      const { search: found } = await api.sourcing.run({
        departmentId,
        jobId: jobId || null,
        prompt,
        roleTitle,
        openToWorkOnly,
        brief: brief || undefined,
      });
      setSearch(found);
      setBrief(found.brief);
      setTargetJobId(found.jobId || targetJobId);
      historyQ.refresh();
      if (found.message) setError(found.message);
      else if (found.results.length) toast(`${toPersianDigits(found.results.length)} پروفایل پیدا شد.`, 'success');
    } catch (e: any) {
      setError(e?.message || 'جست‌وجو انجام نشد.');
      // The failed search is still stored on the server: show it in the history.
      historyQ.refresh();
      if ((e as any)?.data?.search) setSearch((e as any).data.search);
    } finally {
      setSearching(false);
    }
  };

  const importProfile = async (profile: SourcingProfile) => {
    if (!search) return;
    const jobForProfile = targetJobId || jobId || search.jobId;
    if (!jobForProfile) return toast('فرصت شغلی مقصد را انتخاب کنید.', 'error');
    setImporting(profile.id);
    try {
      const res = await api.sourcing.import(search.id, profile.id, jobForProfile);
      setSearch((cur) =>
        cur ? { ...cur, imported: { ...cur.imported, [profile.id]: res.record.id } } : cur
      );
      emitChange('resumes', jobForProfile);
      emitChange('activity');
      toast(
        res.alreadyImported
          ? `«${profile.fullName}» پیش‌تر به این فرصت اضافه شده بود.`
          : `«${profile.fullName}» به کاندیداهای «${targetJob?.roleTitle || 'فرصت انتخابی'}» اضافه و تحلیل شد.`,
        'success'
      );
    } catch (e: any) {
      toast(e?.message || 'افزودن این پروفایل ممکن نشد.', 'error');
    } finally {
      setImporting(null);
    }
  };

  const removeSearch = async (id: string) => {
    try {
      await api.sourcing.remove(id);
      if (search?.id === id) {
        setSearch(null);
        setBrief(null);
        navigate('/app/sourcing', { replace: true });
      }
      historyQ.refresh();
      toast('این جست‌وجو از تاریخچه حذف شد.');
    } catch (e: any) {
      toast(e?.message || 'حذف ممکن نشد.', 'error');
    }
  };

  const copyQuery = async () => {
    if (!brief?.booleanQuery) return;
    if (await copyText(brief.booleanQuery)) toast('کوئری کپی شد؛ می‌توانید در LinkedIn هم اجرا کنید.');
    else toast('کپی خودکار ممکن نشد.', 'error');
  };

  const sourcing = statusQ.data?.sourcing;
  const results = search?.results || [];

  return (
    <div>
      <PageHeader
        title="جست‌وجوی استعداد"
        subtitle="بگویید دنبال چه متخصصی با چه شرایطی هستید؛ افراد واجد شرایط و Open to work را پیدا کنید و به فرصت شغلی اضافه کنید"
        actions={
          <ButtonLink to="/app/settings/integrations" variant="secondary" icon={Link2}>
            وضعیت اتصال لینکدین
          </ButtonLink>
        }
      />

      {statusQ.loading ? (
        <Skeleton className="h-24 rounded-card mb-5" />
      ) : sourcing && !sourcing.configured ? (
        <Callout tone="warning" icon={AlertTriangle} className="mb-5" title="جست‌وجوی LinkedIn در این نصب فعال نیست">
          {sourcing.setupHint}
          <span className="block mt-1 text-[12px]">
            مدیر سامانه می‌تواند آدرس و توکن سرویس را در «پنل مدیریت ← اتصال‌ها» ثبت کند. مستند اتصال:{' '}
            <span dir="ltr" className="font-mono">{sourcing.docPath}</span>
          </span>
        </Callout>
      ) : (
        sourcing && (
          <Callout tone="brand" icon={CheckCircle2} className="mb-5">
            جست‌وجو از طریق {sourcing.providerLabel}
            {sourcing.endpointHost ? <span dir="ltr" className="font-mono"> ({sourcing.endpointHost})</span> : null} انجام می‌شود و فقط افرادی برمی‌گردند که
            سرویس شما آن‌ها را واجد شرایط می‌داند.
          </Callout>
        )
      )}

      <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
        <div className="flex flex-col gap-5 min-w-0">
          <Card>
            <CardHeader
              icon={Wand2}
              title="دنبال چه کسی هستید؟"
              subtitle="دپارتمان، فرصت شغلی (اختیاری) و توضیح خودتان؛ هویدا شرایط را به کوئری جست‌وجو تبدیل می‌کند."
            />
            <div className="flex flex-col gap-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <Select
                  label="دپارتمان"
                  value={departmentId}
                  onChange={(e) => {
                    setDepartmentId(e.target.value);
                    setJobId('');
                    setTargetJobId('');
                  }}
                  options={departments.map((d) => ({ value: d.id, label: d.name }))}
                  disabled={!departments.length}
                />
                <Select
                  label="فرصت شغلی (اختیاری)"
                  value={jobId}
                  onChange={(e) => setJobId(e.target.value)}
                  options={[{ value: '', label: 'بدون فرصت مشخص' }, ...deptJobs.map((j) => ({ value: j.id, label: `${j.roleTitle} · ${j.departmentName}` }))]}
                />
              </div>
              {!jobId && (
                <TextInput
                  label="عنوان تخصص / نقش"
                  placeholder="مثال: کارشناس ارشد حسابداری صنعتی"
                  value={roleTitle}
                  onChange={(e) => setRoleTitle(e.target.value)}
                />
              )}
              <TextArea
                label="توضیح شرایط"
                rows={4}
                placeholder="مثال: کارشناس ارشد حسابداری صنعتی با حداقل ۵ سال سابقه در شرکت تولیدی، مسلط به بهای تمام‌شده و SAP، ساکن تهران یا کرج، آمادهٔ همکاری."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                hint="هرچه دقیق‌تر بنویسید، کوئری جست‌وجو بهتر می‌شود. شرایط غیرقابل‌گذشت را هم بنویسید."
              />
              <Switch
                checked={openToWorkOnly}
                onChange={setOpenToWorkOnly}
                label="فقط افراد Open to work"
                description="از سرویس جست‌وجو می‌خواهیم فقط پروفایل‌هایی را برگرداند که وضعیت آمادهٔ همکاری دارند."
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" icon={Sparkles} onClick={makeBrief} loading={briefing} disabled={!departmentId}>
                  ساخت شرایط جست‌وجو
                </Button>
                <Button icon={Search} onClick={runSearch} loading={searching} disabled={!departmentId || searching}>
                  جست‌وجو در LinkedIn
                </Button>
                {brief && <span className="text-[12px] text-ink-3">{brief.engine === 'ai' ? 'شرایط ساخته‌شده با هوش مصنوعی' : 'شرایط ساده (بدون هوش مصنوعی)'}</span>}
              </div>
            </div>
          </Card>

          {brief && (
            <Card>
              <CardHeader
                icon={Filter}
                title="شرایط جست‌وجو"
                subtitle="این‌ها همان چیزی است که به سرویس لینکدین فرستاده می‌شود."
                action={
                  <Button size="sm" variant="secondary" icon={Copy} onClick={copyQuery} disabled={!brief.booleanQuery}>
                    کپی کوئری
                  </Button>
                }
              />
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Chip tone="brand">{brief.roleTitle || 'بدون عنوان'}</Chip>
                  {brief.seniority && <Chip>{brief.seniority}</Chip>}
                  {brief.locations.map((l) => (
                    <Chip key={l} icon={MapPin}>
                      {l}
                    </Chip>
                  ))}
                  {brief.openToWorkOnly && <Chip tone="warning">Open to work</Chip>}
                </div>
                {brief.skills.length > 0 && (
                  <p className="text-[13px] text-ink-2">
                    <span className="font-semibold">مهارت‌ها: </span>
                    {brief.skills.join('، ')}
                  </p>
                )}
                {brief.mustHave.length > 0 && (
                  <p className="text-[13px] text-ink-2">
                    <span className="font-semibold">الزام‌ها: </span>
                    {brief.mustHave.join('، ')}
                  </p>
                )}
                {brief.notes && <p className="text-[12.5px] text-ink-3 leading-relaxed">{brief.notes}</p>}
                <div className="rounded-[10px] bg-canvas border border-line-2 p-3">
                  <p className="text-[11.5px] text-ink-4 mb-1">کوئری بولی</p>
                  <code dir="ltr" className="text-[12px] text-ink-2 break-words leading-relaxed">
                    {brief.booleanQuery || '—'}
                  </code>
                </div>
              </div>
            </Card>
          )}

          {error && !search && (
            <Callout tone="warning" icon={AlertTriangle}>
              {error}
            </Callout>
          )}

          {search && (
            <Card padded={false}>
              <div className="p-4 sm:p-5 border-b border-line-2 flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-bold text-ink">نتایج جست‌وجو</p>
                  <p className="text-[12.5px] text-ink-3 mt-0.5">
                    {search.departmentName}
                    {search.jobTitle ? ` · ${search.jobTitle}` : ''}، {faDate(search.createdAtISO)}،{' '}
                    {toPersianDigits(results.length)} پروفایل
                    {search.message && search.status !== 'done' ? ` · ${search.message}` : ''}
                  </p>
                </div>
                <Select
                  compact
                  aria-label="فرصت شغلی مقصد"
                  className="max-w-[240px]"
                  value={targetJobId || search.jobId || ''}
                  onChange={(e) => setTargetJobId(e.target.value)}
                  options={[{ value: '', label: 'فرصت مقصد را انتخاب کنید' }, ...jobs.map((j) => ({ value: j.id, label: j.roleTitle }))]}
                />
              </div>

              {search.status === 'not_configured' && (
                <div className="p-5">
                  <Callout tone="warning" icon={AlertTriangle} title="اتصال LinkedIn تنظیم نشده است">
                    {search.message || sourcing?.setupHint}
                  </Callout>
                </div>
              )}
              {search.status === 'error' && (
                <div className="p-5">
                  <Callout tone="danger" icon={AlertTriangle} title="جست‌وجو انجام نشد">
                    {search.message || 'سرویس جست‌وجو پاسخ نداد.'}
                  </Callout>
                </div>
              )}
              {search.status === 'done' && results.length === 0 && (
                <EmptyState
                  icon={Users}
                  title="پروفایلی پیدا نشد"
                  description="شرایط را کمی بازتر کنید: یک شهر یا یک مهارت را بردارید، یا گزینهٔ «فقط Open to work» را موقتاً خاموش کنید."
                />
              )}

              {results.length > 0 && (
                <div className="divide-y divide-line-2">
                  {results.map((p) => {
                    const importedId = search.imported[p.id];
                    return (
                      <div key={p.id} className="p-4 sm:p-5">
                        <div className="flex flex-wrap items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-[14px] font-bold text-ink" dir="auto">
                                {p.fullName}
                              </p>
                              {p.openToWork ? (
                                <Chip tone="brand" icon={CheckCircle2}>
                                  Open to work
                                </Chip>
                              ) : (
                                <Chip title="سرویس جست‌وجو وضعیت آمادهٔ همکاری را برای این فرد گزارش نکرده است.">وضعیت همکاری نامشخص</Chip>
                              )}
                              {importedId && <Chip tone="warning" icon={UserPlus}>افزوده‌شده</Chip>}
                            </div>
                            <p className="text-[13px] text-ink-2 mt-1 leading-snug" dir="auto">
                              {p.headline || '—'}
                            </p>
                            <p className="text-[12px] text-ink-3 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                              {p.location && (
                                <span className="inline-flex items-center gap-1">
                                  <MapPin className="w-3.5 h-3.5" /> {p.location}
                                </span>
                              )}
                              {p.currentCompany && (
                                <span className="inline-flex items-center gap-1">
                                  <Briefcase className="w-3.5 h-3.5" /> {p.currentCompany}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {importedId ? (
                              <ButtonLink to={`/app/candidates/${importedId}`} variant="secondary" size="sm" icon={ArrowLeft}>
                                مشاهدهٔ کاندید
                              </ButtonLink>
                            ) : (
                              <Button
                                size="sm"
                                icon={UserPlus}
                                onClick={() => void importProfile(p)}
                                loading={importing === p.id}
                                disabled={!targetJobId && !search.jobId}
                                title={!targetJobId && !search.jobId ? 'ابتدا فرصت شغلی مقصد را انتخاب کنید' : undefined}
                              >
                                افزودن به فرصت
                              </Button>
                            )}
                            {p.profileUrl && (
                              <IconButton
                                icon={ExternalLink}
                                label="پروفایل لینکدین"
                                size="sm"
                                className="border border-line"
                                onClick={() => window.open(p.profileUrl, '_blank', 'noreferrer')}
                              />
                            )}
                          </div>
                        </div>

                        {p.experiences.length > 0 && (
                          <div className="mt-3 rounded-[10px] border border-line-2 bg-canvas p-3">
                            <p className="text-[11.5px] font-semibold text-ink-3 mb-1.5">کجاها بوده</p>
                            <ul className="flex flex-col gap-1.5">
                              {p.experiences.map((e, i) => (
                                <li key={i} className="text-[12.5px] text-ink-2 flex flex-wrap items-baseline gap-x-2">
                                  <span className="font-semibold">{e.title || '—'}</span>
                                  {e.company && <span>در {e.company}</span>}
                                  {e.period && <span className="text-ink-4">({e.period})</span>}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {(p.skills.length > 0 || p.education.length > 0) && (
                          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                            {p.skills.slice(0, 8).map((s) => (
                              <Chip key={s} tone="outline">
                                {s}
                              </Chip>
                            ))}
                            {p.education.slice(0, 2).map((e) => (
                              <Chip key={e} tone="neutral">
                                {e}
                              </Chip>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          )}
        </div>

        {/* ---------- history ---------- */}
        <Card padded={false} className="xl:sticky xl:top-[88px]">
          <div className="p-4 border-b border-line-2">
            <p className="text-[13.5px] font-bold text-ink">جست‌وجوهای قبلی</p>
            <p className="text-[11.5px] text-ink-3 mt-0.5">نتایج ذخیره می‌شوند تا بعداً هم قابل استفاده باشند.</p>
          </div>
          {historyQ.loading ? (
            <div className="p-4 flex flex-col gap-2">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : historyQ.error ? (
            <ErrorState message={historyQ.error} onRetry={historyQ.reload} />
          ) : (historyQ.data?.items.length || 0) === 0 ? (
            <p className="p-4 text-[12.5px] text-ink-3">هنوز جست‌وجویی انجام نشده است.</p>
          ) : (
            <ul className="divide-y divide-line-2 max-h-[560px] overflow-y-auto hv-scroll">
              {historyQ.data!.items.map((h) => (
                <li key={h.id} className="flex items-start gap-1 p-2">
                  <button
                    type="button"
                    onClick={() => void openSearch(h.id)}
                    className={`flex-1 min-w-0 text-right rounded-[8px] px-2 py-1.5 hover:bg-canvas ${search?.id === h.id ? 'bg-brand-tint' : ''}`}
                  >
                    <p className="text-[12.5px] font-semibold text-ink truncate">{h.brief.roleTitle || h.prompt || 'جست‌وجو'}</p>
                    <p className="text-[11.5px] text-ink-4 flex items-center gap-1.5 mt-0.5">
                      <Clock3 className="w-3 h-3" />
                      {faDate(h.createdAtISO)}، {toPersianDigits(h.resultCount)} نفر
                    </p>
                    {h.status !== 'done' && (
                      <p className="text-[11px] text-low-ink mt-0.5">{h.status === 'not_configured' ? 'اتصال تنظیم نشده' : 'ناموفق'}</p>
                    )}
                  </button>
                  <IconButton icon={Trash2} label="حذف این جست‌وجو" size="sm" tone="danger" onClick={() => void removeSearch(h.id)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

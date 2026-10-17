import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileStack, ListChecks, RefreshCw, Sparkles, UploadCloud } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { CriteriaEditor, QuestionsEditor, criterionTitleOk } from '../components/jobs/JobEditors';
import { UploadDropzone } from '../components/jobs/UploadDropzone';
import { Button, Callout, Card, CardHeader, Chip, Select, Skeleton, Spinner, TextArea, TextInput, toast } from '../components/ui';
import { api, type JobInput } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAnalysis } from '../lib/analysis';
import { emitChange } from '../lib/events';
import { departmentIcon } from '../lib/departmentIcons';
import { EMPLOYMENT_LABELS } from '../lib/match';
import { toPersianDigits } from '../lib/format';
import { navigate, useLeaveGuard } from '../lib/router';
import { useTitle } from '../lib/useTitle';
import type { CriteriaSource, EmploymentType, JobUnderstanding, ScreeningAnswers } from '../types/screening';

type Step = 1 | 2 | 3;

function Stepper({ step }: { step: Step }) {
  const steps = [
    { n: 1, label: 'اطلاعات فرصت شغلی' },
    { n: 2, label: 'معیارها و پرسش‌نامه' },
    { n: 3, label: 'بارگذاری رزومه‌ها' },
  ];
  return (
    <ol className="flex items-center gap-2 sm:gap-3 mb-6 overflow-x-auto hv-scroll pb-1" aria-label="مراحل ساخت فرصت شغلی">
      {steps.map((s, i) => {
        const done = step > s.n;
        const active = step === s.n;
        return (
          // Only <li> may sit directly in a list: the connector line lives inside the step.
          <li key={s.n} className="relative flex items-center gap-2 sm:gap-3 shrink-0" aria-current={active ? 'step' : undefined}>
            {i > 0 && <span aria-hidden className={`h-px w-6 sm:w-12 shrink-0 ${done || active ? 'bg-brand' : 'bg-line-strong'}`} />}
            <span className="flex items-center gap-2">
              <span
                className={`w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-extrabold hv-num ${
                  done ? 'bg-brand-strong text-white' : active ? 'bg-brand-soft text-brand-stronger ring-2 ring-brand/40' : 'bg-line-2 text-ink-3'
                }`}
              >
                {done ? (
                  <>
                    <Check className="w-4 h-4" strokeWidth={3} aria-hidden />
                    <span className="sr-only">انجام‌شده:</span>
                  </>
                ) : (
                  toPersianDigits(s.n)
                )}
              </span>
              {/* On phones only the current step shows its name; the others stay readable for screen readers. */}
              <span className={`text-[13px] font-semibold ${active ? 'text-ink' : 'text-ink-3 max-sm:sr-only'}`}>{s.label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function JobNew() {
  useTitle('فرصت شغلی تازه');
  const { org, ai } = useAuth();
  const analysis = useAnalysis();
  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<JobInput>({ departmentId: '', roleTitle: '', extraNotes: '', location: '', employmentType: null });
  const [understanding, setUnderstanding] = useState<JobUnderstanding | null>(null);
  const [source, setSource] = useState<CriteriaSource>('ai');
  const [answers, setAnswers] = useState<ScreeningAnswers>({});
  const [loadingU, setLoadingU] = useState(false);
  const [uError, setUError] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [creating, setCreating] = useState(false);
  const [touched, setTouched] = useState(false);
  const lastKey = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  // Typed details, chosen files or a later step would be lost by leaving: ask first.
  useLeaveGuard(step > 1 || files.length > 0 || [form.roleTitle, form.extraNotes, form.location].some((v) => (v || '').trim() !== ''));

  const departments = org?.departments || [];
  const step1Valid = Boolean(form.departmentId && form.roleTitle.trim().length >= 2);
  const criteriaValid = Boolean(understanding?.criteria.every(criterionTitleOk));

  // Leaving the page cancels a pending suggestion (it would only cost AI quota).
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancelSuggestion = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    lastKey.current = ''; // «ادامه» asks again next time
    setLoadingU(false);
    setStep(1);
  };

  /** Radio-group keyboard pattern: arrows move the choice, Tab leaves the group. */
  const onDeptKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const keys: Record<string, number> = { ArrowLeft: 1, ArrowDown: 1, ArrowRight: -1, ArrowUp: -1 }; // RTL: left = next
    const step = keys[e.key];
    if (!step || !departments.length) return;
    e.preventDefault();
    const next = departments[(index + step + departments.length) % departments.length];
    setForm((f) => ({ ...f, departmentId: next.id }));
    const group = e.currentTarget.parentElement;
    window.requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>(`[data-dept="${next.id}"]`)?.focus());
  };

  const fetchUnderstanding = async (force = false) => {
    const key = JSON.stringify(form);
    if (!force && understanding && key === lastKey.current) {
      setStep(2);
      return;
    }
    lastKey.current = key;
    abortRef.current?.abort();
    // No AI on this server: go straight to the ready-made template rather
    // than showing a failure screen on every new job opening.
    if (ai && !ai.available) {
      setStep(2);
      setUnderstanding(null);
      await loadTemplate();
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStep(2);
    setLoadingU(true);
    setUError(null);
    setUnderstanding(null);
    setAnswers({});
    try {
      const res = await api.jobs.understand(form, { signal: controller.signal });
      setUnderstanding(res.understanding);
      setSource('ai');
    } catch (e: any) {
      if (e?.name === 'AbortError') return;
      setUError(e?.message || 'پیشنهاد معیارها ممکن نشد.');
    } finally {
      if (!controller.signal.aborted) setLoadingU(false);
    }
  };

  const loadTemplate = async () => {
    setLoadingU(true);
    setUError(null);
    try {
      const res = await api.jobs.template({ departmentId: form.departmentId, roleTitle: form.roleTitle });
      setUnderstanding(res.understanding);
      setSource('template');
      setAnswers({});
    } catch (e: any) {
      setUError(e?.message || 'بارگذاری الگو ممکن نشد.');
    } finally {
      setLoadingU(false);
    }
  };

  const create = async () => {
    if (!understanding) return;
    setCreating(true);
    try {
      const { job } = await api.jobs.create({ ...form, roleTitle: form.roleTitle.trim(), understanding, answers, criteriaSource: source });
      emitChange('jobs');
      emitChange('activity');
      if (files.length) analysis.start(job, files);
      toast(files.length ? `«${job.roleTitle}» ساخته شد و تحلیل ${toPersianDigits(files.length)} رزومه آغاز شد.` : `«${job.roleTitle}» ساخته شد.`);
      navigate(`/app/jobs/${job.id}`, { replace: true, force: true }); // created: nothing is lost
    } catch (e: any) {
      toast(e?.message || 'ساخت فرصت شغلی ممکن نشد.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const dept = departments.find((d) => d.id === form.departmentId);

  return (
    <div className="max-w-[880px]">
      <PageHeader title="ایجاد فرصت شغلی" breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }, { label: 'فرصت تازه' }]} />
      <Stepper step={step} />

      {step === 1 && (
        <Card>
          <CardHeader title="درباره این فرصت شغلی" subtitle="هرچه دقیق‌تر بنویسید، معیارهای پیشنهادی هویدا به نیاز شما نزدیک‌تر است." />
          <div className="flex flex-col gap-5">
            <div>
              <p className="text-[13px] font-semibold text-ink-2 mb-2">
                دپارتمان <span className="text-low-ink">*</span>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="دپارتمان">
                {departments.map((d, i) => {
                  const Icon = departmentIcon(d.id);
                  const active = form.departmentId === d.id;
                  const focusable = active || (!form.departmentId && i === 0);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      data-dept={d.id}
                      tabIndex={focusable ? 0 : -1}
                      onKeyDown={(e) => onDeptKey(e, i)}
                      onClick={() => setForm({ ...form, departmentId: d.id })}
                      className={`flex items-center gap-2.5 p-3 rounded-[12px] border text-right transition-colors ${
                        active ? 'border-brand/50 bg-brand-tint ring-1 ring-brand/30' : 'border-line hover:border-line-strong bg-surface'
                      }`}
                    >
                      <span className={`w-8 h-8 rounded-[9px] flex items-center justify-center shrink-0 ${active ? 'bg-brand-strong text-white' : 'bg-line-2 text-ink-3'}`}>
                        <Icon className="w-4 h-4" strokeWidth={1.8} />
                      </span>
                      <span className={`text-[13px] font-semibold leading-snug ${active ? 'text-brand-stronger' : 'text-ink-2'}`}>{d.name}</span>
                    </button>
                  );
                })}
              </div>
              {touched && !form.departmentId && <p className="text-xs text-low-ink font-medium mt-1.5">دپارتمان را انتخاب کنید.</p>}
            </div>
            <TextInput
              label="عنوان فرصت شغلی"
              required
              value={form.roleTitle}
              onChange={(e) => setForm({ ...form, roleTitle: e.target.value })}
              placeholder="مثلاً کارشناس فروش حضوری"
              error={touched && form.roleTitle.trim().length < 2 ? 'عنوان فرصت شغلی را وارد کنید.' : null}
            />
            <div className="grid sm:grid-cols-2 gap-4">
              <TextInput label="محل کار" optional value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="مثلاً تهران" />
              <Select
                label="نوع همکاری"
                optional
                value={form.employmentType || ''}
                onChange={(e) => setForm({ ...form, employmentType: (e.target.value || null) as EmploymentType | null })}
                placeholder="انتخاب کنید"
                options={(Object.keys(EMPLOYMENT_LABELS) as EmploymentType[]).map((k) => ({ value: k, label: EMPLOYMENT_LABELS[k] }))}
              />
            </div>
            <TextArea
              label="شرح شغل و نکات مهم"
              optional
              rows={5}
              value={form.extraNotes}
              onChange={(e) => setForm({ ...form, extraNotes: e.target.value })}
              placeholder="مثلاً: آشنایی با نرم‌افزار سپیدار الزامی است؛ سابقه کار در صنعت غذایی امتیاز دارد؛ ساعت کاری ۸ تا ۱۶."
              hint="می‌توانید متن آگهی شغلی را هم اینجا بچسبانید."
            />
          </div>
          <div className="flex justify-end mt-6 pt-5 border-t border-line-2">
            <Button
              iconEnd={ArrowLeft}
              onClick={() => {
                setTouched(true);
                if (step1Valid) void fetchUnderstanding();
              }}
            >
              ادامه: پیشنهاد معیارها
            </Button>
          </div>
        </Card>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          {loadingU && (
            <Card>
              <div className="flex items-center gap-3 mb-5">
                <Spinner />
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-bold text-ink">هویدا در حال تدوین معیارهای «{form.roleTitle.trim()}» است…</p>
                  <p className="text-[12.5px] text-ink-3">معمولاً کمتر از نیم دقیقه طول می‌کشد.</p>
                </div>
                <Button variant="ghost" size="sm" icon={ArrowRight} onClick={cancelSuggestion}>
                  بازگشت
                </Button>
              </div>
              <div className="flex flex-col gap-2.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-[58px] rounded-[12px]" />
                ))}
              </div>
            </Card>
          )}

          {!loadingU && uError && (
            <Card>
              <Callout tone="warning" title="پیشنهاد هوشمند معیارها فعلاً ممکن نشد">
                {uError}
              </Callout>
              <div className="mt-5 grid sm:grid-cols-2 gap-3">
                <div className="rounded-[14px] border border-line p-4">
                  <p className="text-[14px] font-bold text-ink flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 text-ink-3" />
                    دوباره تلاش کنید
                  </p>
                  <p className="text-[12.5px] text-ink-3 mt-1.5 leading-relaxed">اگر مشکل موقتی بوده، چند لحظه بعد دوباره امتحان کنید.</p>
                  <Button variant="secondary" size="sm" className="mt-3" onClick={() => fetchUnderstanding(true)} disabled={ai ? !ai.available : false}>
                    تلاش دوباره
                  </Button>
                </div>
                <div className="rounded-[14px] border border-line p-4">
                  <p className="text-[14px] font-bold text-ink flex items-center gap-2">
                    <FileStack className="w-4 h-4 text-ink-3" />
                    الگوی آماده دپارتمان
                  </p>
                  <p className="text-[12.5px] text-ink-3 mt-1.5 leading-relaxed">
                    معیارهای رایج این نوع شغل (بر اساس عنوان و دپارتمان «{dept?.name}») را بارگذاری و در صورت نیاز ویرایش کنید. این فرصت با برچسب «الگوی آماده» مشخص می‌شود.
                  </p>
                  <Button size="sm" className="mt-3" onClick={loadTemplate}>
                    استفاده از الگو
                  </Button>
                </div>
              </div>
              <div className="flex justify-start mt-5 pt-4 border-t border-line-2">
                <Button variant="ghost" icon={ArrowRight} onClick={() => setStep(1)}>
                  بازگشت
                </Button>
              </div>
            </Card>
          )}

          {!loadingU && understanding && (
            <>
              <Callout tone="brand" icon={source === 'ai' ? Sparkles : FileStack} title={source === 'ai' ? 'پیشنهاد هویدا برای این فرصت شغلی' : 'الگوی آماده'}>
                {understanding.plainExplanation}
                {source === 'template' && ai && !ai.available && (
                  <span className="block mt-1">هوش مصنوعی روی این سرور فعال نیست؛ این معیارها از الگوی آماده ساخته شده‌اند — آن‌ها را با نیاز خود تطبیق دهید.</span>
                )}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Chip tone="outline">سطح نقش: {understanding.seniority}</Chip>
                  <Chip tone="outline">
                    تطابق بالا از {toPersianDigits(understanding.thresholds.interview)}٪ · بررسی از {toPersianDigits(understanding.thresholds.review)}٪
                  </Chip>
                </div>
              </Callout>
              <Card>
                <CardHeader icon={ListChecks} title="معیارهای ارزیابی" subtitle="وزن هر معیار سهم آن در درصد تطابق است. معیارهای «الزامی» در صورت نبود شاهد، سقف امتیاز را پایین می‌آورند." />
                <CriteriaEditor understanding={understanding} onChange={setUnderstanding} />
              </Card>
              <Card>
                <CardHeader icon={Check} title="پرسش‌نامه" subtitle="چه چیزهایی برای شما مهم است؟ تیک بزنید؛ «شرط اصلی»ها در تحلیل جدی‌تر گرفته می‌شوند." />
                <QuestionsEditor questions={understanding.questions} answers={answers} onChange={setAnswers} />
              </Card>
              <div className="flex items-center justify-between gap-3">
                <Button variant="ghost" icon={ArrowRight} onClick={() => setStep(1)}>
                  بازگشت
                </Button>
                <div className="flex gap-2">
                  {source === 'ai' && (
                    <Button variant="secondary" icon={RefreshCw} onClick={() => fetchUnderstanding(true)}>
                      پیشنهاد دوباره
                    </Button>
                  )}
                  <Button
                    iconEnd={ArrowLeft}
                    onClick={() => setStep(3)}
                    disabled={!criteriaValid}
                    title={criteriaValid ? undefined : 'عنوان همه معیارها را بنویسید'}
                  >
                    ادامه
                  </Button>
                </div>
              </div>
              {!criteriaValid && <p className="text-[12.5px] text-low-ink font-medium -mt-1 text-left">برای ادامه، عنوان همه معیارها را بنویسید (دست‌کم دو حرف).</p>}
            </>
          )}
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader
            icon={UploadCloud}
            title="رزومه‌ها را بارگذاری کنید"
            subtitle="اختیاری است؛ هر زمان بعداً هم می‌توانید رزومه اضافه کنید. تحلیل در پس‌زمینه انجام می‌شود و می‌توانید در این مدت کار دیگری انجام دهید."
          />
          <UploadDropzone files={files} onChange={setFiles} disabled={creating} />
          {ai && !ai.available && files.length > 0 && (
            <Callout tone="warning" className="mt-4">
              هوش مصنوعی روی سرور فعال نیست؛ این رزومه‌ها با موتور محلی (کلیدواژه‌ای) و با برچسب «تحلیل محلی» بررسی می‌شوند.
            </Callout>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 mt-6 pt-5 border-t border-line-2">
            <Button variant="ghost" icon={ArrowRight} onClick={() => setStep(2)} disabled={creating}>
              بازگشت
            </Button>
            <Button onClick={create} loading={creating} iconEnd={ArrowLeft}>
              {files.length ? `ساخت و شروع تحلیل ${toPersianDigits(files.length)} رزومه` : 'ساخت فرصت شغلی'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

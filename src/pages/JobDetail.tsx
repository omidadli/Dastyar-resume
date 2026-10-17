import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Clock3,
  Columns3,
  Download,
  FileStack,
  ListChecks,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  SearchX,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  UploadCloud,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { CandidatePanel } from '../components/candidates/CandidatePanel';
import { CandidateTable } from '../components/candidates/CandidateTable';
import { AnalysisProgress } from '../components/jobs/AnalysisProgress';
import { CriteriaEditor, QuestionsEditor } from '../components/jobs/JobEditors';
import { UploadDropzone } from '../components/jobs/UploadDropzone';
import {
  Button,
  ButtonLink,
  Callout,
  Card,
  CardHeader,
  Chip,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorState,
  IconButton,
  JobStatusPill,
  Menu,
  Modal,
  Pagination,
  SearchInput,
  Segmented,
  Select,
  Skeleton,
  Stat,
  Tabs,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { RejectModal } from '../components/candidates/CandidateModals';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAnalysis } from '../lib/analysis';
import { clearCompare, forgetCompareJob, removeFromCompare, toggleCompare } from '../lib/compare';
import { emitChange, useOnChange } from '../lib/events';
import { exportJobToExcel } from '../lib/excelExport';
import { EMPLOYMENT_LABELS, MATCH_FILTERS } from '../lib/match';
import { candidateName, faDate, faNumber, toPersianDigits } from '../lib/format';
import { navigate, setQuery, useLocation } from '../lib/router';
import { useAsync, useDebounced, useMediaQuery } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import type { DecisionFilter, DecisionStatus, Job, MatchFilter, ResumeListItem, ResumeSort } from '../types/screening';

type JobTab = 'candidates' | 'criteria';

function EditJobModal({ job, open, onClose, onSaved }: { job: Job; open: boolean; onClose: () => void; onSaved: (j: Job) => void }) {
  const [roleTitle, setRoleTitle] = useState(job.roleTitle);
  const [location, setLocation] = useState(job.location);
  const [extraNotes, setExtraNotes] = useState(job.extraNotes);
  const [saving, setSaving] = useState(false);
  const jobRef = useRef(job);
  jobRef.current = job;
  // Seed the form when it opens — not on every background refresh of the job
  // (those arrive every few seconds during an analysis and would wipe typing).
  useEffect(() => {
    if (open) {
      setRoleTitle(jobRef.current.roleTitle);
      setLocation(jobRef.current.location);
      setExtraNotes(jobRef.current.extraNotes);
    }
  }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      const { job: updated } = await api.jobs.update(job.id, { roleTitle: roleTitle.trim(), location: location.trim(), extraNotes });
      onSaved(updated);
      emitChange('jobs', job.id);
      toast('اطلاعات فرصت شغلی به‌روز شد.');
      onClose();
    } catch (e: any) {
      toast(e?.message || 'ذخیره ممکن نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="ویرایش اطلاعات فرصت شغلی"
      description="معیارهای ارزیابی پس از شروع تحلیل ثابت می‌مانند تا امتیاز کاندیداها قابل مقایسه بماند."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={save} loading={saving} disabled={roleTitle.trim().length < 2}>
            ذخیره
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <TextInput label="عنوان" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
        <TextInput label="محل کار" optional value={location} onChange={(e) => setLocation(e.target.value)} />
        <TextArea label="شرح شغل و نکات مهم" optional rows={5} value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} />
      </div>
    </Modal>
  );
}

export default function JobDetail({ id }: { id: string }) {
  const { query } = useLocation();
  const { user } = useAuth();
  const analysis = useAnalysis();
  const run = analysis.runFor(id);
  const isWide = useMediaQuery('(min-width: 1280px)');

  const jobQ = useAsync((signal) => api.jobs.get(id, { signal }), [id]);
  const job = jobQ.data?.job || null;
  useTitle(job?.roleTitle || 'فرصت شغلی');

  const [tab, setTab] = useState<JobTab>('candidates');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [decision, setDecision] = useState<DecisionFilter>('all');
  const [minYears, setMinYears] = useState(0);
  const [sort, setSort] = useState<ResumeSort>('match');
  const [qInput, setQInput] = useState('');
  const q = useDebounced(qInput, 250);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [match, decision, minYears, sort, q]);

  const listQ = useAsync(
    (signal) => api.resumes.list({ jobId: id, match, decision, minYears: minYears || undefined, sort, q, page, pageSize: 10 }, { signal }),
    [id, match, decision, minYears, sort, q, page]
  );
  const items = listQ.data?.items || [];
  const counts = listQ.data?.counts;
  // The server clamps an out-of-range page (the last page emptied by a
  // delete): follow it, or a later refresh would jump to the stale number.
  useEffect(() => {
    if (listQ.data && listQ.data.page !== page) setPage(listQ.data.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listQ.data]);

  useOnChange(['resumes', 'jobs'], (d) => {
    if (d.jobId && d.jobId !== id) return;
    listQ.refresh();
    jobQ.refresh();
  });

  // Selected candidate (?c=) — from the current page, or fetched directly.
  const selectedId = query.get('c');
  const [selected, setSelected] = useState<ResumeListItem | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const fetchingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    const inList = items.find((r) => r.id === selectedId);
    if (inList) {
      setSelected(inList);
      return;
    }
    if (selected?.id === selectedId || fetchingRef.current === selectedId) return;
    fetchingRef.current = selectedId;
    api.resumes
      .get(selectedId)
      .then(({ record }) => {
        if (selectedIdRef.current !== record.id) return; // another candidate was opened meanwhile
        if (record.jobId !== id) {
          // A link to a candidate of another opening: show it where it belongs.
          navigate(`/app/jobs/${record.jobId}?c=${record.id}`, { replace: true });
          return;
        }
        const { extractedText: _t, ...item } = record;
        setSelected(item);
      })
      .catch((err) => {
        if (selectedIdRef.current !== selectedId) return;
        toast(err?.status === 404 ? 'این کاندید حذف شده است.' : err?.message || 'باز کردن کاندید ممکن نشد.', err?.status === 404 ? 'info' : 'error');
        setQuery({ c: null });
      })
      .finally(() => {
        if (fetchingRef.current === selectedId) fetchingRef.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, listQ.data]);

  const openCandidate = (r: ResumeListItem) => setQuery({ c: r.id }, { replace: false });
  const closeCandidate = () => setQuery({ c: null });

  const updateItem = (r: ResumeListItem) => {
    setSelected((s) => (s && s.id === r.id ? r : s));
    listQ.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? r : x)) } : d));
  };

  // Bulk selection
  const [sel, setSel] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [id, match, decision, minYears, sort, q, page]);
  const toggle = (rid: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(rid)) n.delete(rid);
      else n.add(rid);
      return n;
    });
  const toggleAll = () => setSel((s) => (items.every((i) => s.has(i.id)) ? new Set() : new Set(items.map((i) => i.id))));
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReject, setBulkReject] = useState(false);
  const [bulkDelete, setBulkDelete] = useState(false);

  const bulkDecide = async (status: DecisionStatus, note?: string) => {
    setBulkBusy(true);
    try {
      const { updated } = await api.resumes.bulk(Array.from(sel), 'decision', status, note);
      toast(`وضعیت ${faNumber(updated)} کاندید ثبت شد.`);
      setSel(new Set());
      setBulkReject(false);
      emitChange('resumes', id);
      emitChange('activity');
    } catch (e: any) {
      toast(e?.message || 'انجام نشد.', 'error');
    } finally {
      setBulkBusy(false);
    }
  };
  const doBulkDelete = async () => {
    setBulkBusy(true);
    try {
      const ids = Array.from(sel);
      const { updated } = await api.resumes.bulk(ids, 'delete');
      toast(`${faNumber(updated)} رزومه برای همیشه حذف شد.`);
      removeFromCompare(...ids);
      setSel(new Set());
      setBulkDelete(false);
      if (selectedId && sel.has(selectedId)) closeCandidate();
      emitChange('resumes', id);
    } catch (e: any) {
      toast(e?.message || 'حذف ممکن نشد.', 'error');
    } finally {
      setBulkBusy(false);
    }
  };
  const bulkCompare = () => {
    const chosen = items.filter((i) => sel.has(i.id)).slice(0, 4);
    if (chosen.length < 2) return toast('برای مقایسه دست‌کم دو کاندید انتخاب کنید.', 'info');
    clearCompare();
    chosen.forEach((r) => toggleCompare(id, job?.roleTitle || '', { id: r.id, name: candidateName(r), score: r.score, category: r.category }));
    navigate(`/app/compare?ids=${chosen.map((c) => c.id).join(',')}`);
  };

  // Upload / job actions
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const running = run?.status === 'running';

  const startUpload = (files: File[]) => {
    if (!job) return;
    if (analysis.start(job, files)) {
      setUploadOpen(false);
      setUploadFiles([]);
    }
  };

  const setStatus = async (status: Job['status']) => {
    if (!job) return;
    try {
      // A closed opening accepts no more resumes: stop this tab's run first.
      if (status === 'closed' && running) analysis.cancel(id);
      const { job: updated } = await api.jobs.update(job.id, { status });
      jobQ.setData({ job: updated });
      emitChange('jobs', job.id);
      emitChange('activity');
      toast(status === 'open' ? 'فرصت شغلی دوباره باز شد.' : status === 'paused' ? 'فرصت شغلی متوقف شد.' : 'فرصت شغلی بسته شد.');
    } catch (e: any) {
      toast(e?.message || 'انجام نشد.', 'error');
    }
  };

  const doDeleteJob = async () => {
    if (!job) return;
    try {
      if (running) analysis.cancel(id);
      await api.jobs.remove(job.id);
      forgetCompareJob(job.id);
      emitChange('jobs');
      toast('فرصت شغلی و همه رزومه‌هایش حذف شد.');
      navigate('/app/jobs', { replace: true, force: true });
    } catch (e: any) {
      toast(e?.message || 'حذف ممکن نشد.', 'error');
    }
  };

  const doExport = async () => {
    if (!job) return;
    setExporting(true);
    try {
      const n = await exportJobToExcel(job);
      toast(`فایل اکسل با ${faNumber(n)} کاندید آماده شد.`);
    } catch (e: any) {
      toast(e?.message || 'ساخت فایل اکسل ممکن نشد.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const canDelete = job && user && (user.role !== 'member' || job.createdBy === user.id);

  const subtitle = useMemo(() => {
    if (!job) return null;
    const parts = [job.departmentName, job.location, job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : null, `ایجاد ${faDate(job.createdAtISO)}`];
    if (job.createdByName) parts.push(`توسط ${job.createdByName}`);
    return parts.filter(Boolean).join('، ');
  }, [job]);

  // A hiccup while the opening is already on screen (after an action, say)
  // keeps the page; a 4xx — deleted, no access — replaces it.
  if (jobQ.error && (!job || (jobQ.errorStatus !== null && jobQ.errorStatus >= 400 && jobQ.errorStatus < 500))) {
    // Deleted or never existed: «try again» cannot help — offer the way back instead.
    if (jobQ.errorStatus === 404) {
      return (
        <div className="hv-card mt-6">
          <EmptyState
            icon={SearchX}
            titleAs="h1"
            title="این فرصت شغلی پیدا نشد"
            description="ممکن است حذف شده باشد یا پیوند اشتباه باشد."
            action={<ButtonLink to="/app/jobs">بازگشت به فرصت‌های شغلی</ButtonLink>}
          />
        </div>
      );
    }
    return (
      <div>
        <PageHeader breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }]} title="فرصت شغلی" />
        <div className="hv-card">
          <ErrorState message={jobQ.error} onRetry={jobQ.reload} />
        </div>
      </div>
    );
  }
  if (!job) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-72" />
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-card" />
          ))}
        </div>
        <Skeleton className="h-[420px] rounded-card" />
      </div>
    );
  }

  const s = job.stats;
  const closed = job.status === 'closed';
  const panelOpen = Boolean(selected);
  const sidePanel = selected && (
    <CandidatePanel
      key={selected.id}
      record={selected}
      jobTitle={job.roleTitle}
      criteria={job.understanding.criteria}
      onChange={updateItem}
      onDeleted={() => {
        const goneId = selected.id;
        closeCandidate();
        listQ.setData((d) => (d ? { ...d, items: d.items.filter((x) => x.id !== goneId) } : d));
        listQ.refresh();
        jobQ.refresh();
      }}
      onClose={closeCandidate}
    />
  );

  return (
    <div>
      <PageHeader
        breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }, { label: job.roleTitle }]}
        title={
          <span className="inline-flex flex-wrap items-center gap-2.5">
            {job.roleTitle}
            <JobStatusPill status={job.status} />
            {job.criteriaSource === 'template' && (
              <Chip tone="outline" icon={FileStack} title="معیارهای این فرصت از الگوی آماده دپارتمان ساخته شده است">
                الگوی آماده
              </Chip>
            )}
          </span>
        }
        subtitle={subtitle}
        actions={
          <>
            <Button icon={UploadCloud} onClick={() => setUploadOpen(true)} disabled={closed || running} title={closed ? 'فرصت بسته است' : undefined}>
              افزودن رزومه
            </Button>
            <Button variant="secondary" icon={Download} onClick={doExport} loading={exporting} disabled={!s.total} className="max-sm:hidden">
              خروجی اکسل
            </Button>
            <Menu
              align="end"
              width={220}
              items={[
                { label: 'ویرایش اطلاعات', icon: Pencil, onClick: () => setEditOpen(true) },
                { label: exporting ? 'در حال ساخت فایل اکسل…' : 'خروجی اکسل', icon: Download, onClick: () => void doExport(), disabled: !s.total || exporting },
                'divider',
                job.status !== 'open'
                  ? { label: 'باز کردن دوباره', icon: Play, onClick: () => void setStatus('open') }
                  : { label: 'توقف موقت', icon: Pause, onClick: () => void setStatus('paused') },
                ...(job.status !== 'closed' ? [{ label: 'بستن فرصت شغلی', icon: XCircle, onClick: () => void setStatus('closed') }] : []),
                'divider',
                { label: 'حذف فرصت شغلی', icon: Trash2, tone: 'danger', onClick: () => setDeleteOpen(true), disabled: !canDelete },
              ]}
              trigger={({ toggle }) => <IconButton icon={MoreHorizontal} label="کارهای بیشتر" onClick={toggle} className="border border-line bg-surface" />}
            />
          </>
        }
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <Stat icon={Users} label="کل رزومه‌ها" value={faNumber(s.total)} note={s.avgScore ? `میانگین تطابق ${toPersianDigits(s.avgScore)}٪` : undefined} />
        <Stat icon={CheckCircle2} label="تطابق بالا" value={faNumber(s.interview)} note={`${faNumber(s.review)} نیازمند بررسی`} tone="high" />
        <Stat icon={Clock3} label="در انتظار تصمیم" value={faNumber(s.undecided)} note="بدون تصمیم ثبت‌شده" tone="review" />
        <Stat icon={ThumbsUp} label="تأییدشده" value={faNumber(s.approved)} note={`${faNumber(s.rejected)} رد شده`} tone="brand" />
      </div>

      {run && (
        <div className="mb-5">
          <AnalysisProgress run={run} onCancel={() => analysis.cancel(id)} onDismiss={() => analysis.dismiss(id)} />
        </div>
      )}
      {!run && job.analysisStatus === 'processing' && (
        <Callout tone="info" className="mb-5">
          یکی از اعضای تیم در حال تحلیل رزومه‌های این فرصت است؛ نتایج به‌محض آماده شدن در فهرست ظاهر می‌شوند.
        </Callout>
      )}

      <Tabs<JobTab>
        className="mb-5"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'candidates', label: 'کاندیداها', count: s.total },
          { id: 'criteria', label: 'معیارها و پرسش‌نامه', icon: ListChecks },
        ]}
      />

      {tab === 'criteria' && (
        <div className="grid lg:grid-cols-2 gap-5">
          <Card>
            <CardHeader
              title="معیارهای ارزیابی"
              subtitle={job.criteriaSource === 'template' ? 'ساخته‌شده از الگوی آماده دپارتمان' : 'پیشنهاد هویدا، تأییدشده هنگام ساخت فرصت'}
              icon={job.criteriaSource === 'template' ? FileStack : Sparkles}
            />
            <p className="text-[13px] text-ink-2 leading-relaxed mb-4">{job.understanding.plainExplanation}</p>
            <CriteriaEditor understanding={job.understanding} readOnly />
            <p className="text-[12px] text-ink-3 mt-4">
              تطابق بالا از {toPersianDigits(job.understanding.thresholds.interview)}٪ و نیازمند بررسی از {toPersianDigits(job.understanding.thresholds.review)}٪ · سطح نقش:{' '}
              {job.understanding.seniority}
            </p>
          </Card>
          <div className="flex flex-col gap-5">
            <Card>
              <CardHeader title="پرسش‌نامه" subtitle="پاسخ‌های ثبت‌شده هنگام ساخت فرصت شغلی" icon={ListChecks} />
              <QuestionsEditor questions={job.understanding.questions} answers={job.answers} readOnly />
            </Card>
            {job.extraNotes && (
              <Card>
                <CardHeader title="شرح شغل و نکات مهم" />
                <p className="text-[13.5px] text-ink-2 leading-[1.9] whitespace-pre-wrap">{job.extraNotes}</p>
              </Card>
            )}
          </div>
        </div>
      )}

      {tab === 'candidates' && (
        <div className={`grid gap-5 ${panelOpen && isWide ? 'grid-cols-[minmax(0,1fr)_440px]' : 'grid-cols-1'}`}>
          <Card padded={false} className="min-w-0">
            <div className="p-4 sm:p-5 border-b border-line-2 flex flex-col gap-3">
              {/* One row only from xl: below it the three filters would wrap one by one beside the search box. */}
              <div className={`flex flex-col gap-3 ${panelOpen && isWide ? '' : 'xl:flex-row xl:items-center'}`}>
                <SearchInput value={qInput} onChange={setQInput} placeholder="جست‌وجوی نام، مهارت، شهر…" className={panelOpen && isWide ? '' : 'xl:w-[260px]'} size="sm" />
                <div className={`flex flex-wrap items-center gap-2 ${panelOpen && isWide ? '' : 'xl:mr-auto'}`}>
                  <Select
                    compact
                    aria-label="تصمیم"
                    value={decision}
                    onChange={(e) => setDecision(e.target.value as DecisionFilter)}
                    options={[
                      { value: 'all', label: 'همه تصمیم‌ها' },
                      { value: 'undecided', label: `بدون تصمیم (${toPersianDigits(counts?.undecided ?? 0)})` },
                      { value: 'approved', label: `تأیید شده (${toPersianDigits(counts?.approved ?? 0)})` },
                      { value: 'review', label: `نیاز به بررسی (${toPersianDigits(counts?.reviewDecision ?? 0)})` },
                      { value: 'rejected', label: `رد شده (${toPersianDigits(counts?.rejected ?? 0)})` },
                    ]}
                  />
                  <Select
                    compact
                    aria-label="سابقه کار"
                    value={String(minYears)}
                    onChange={(e) => setMinYears(Number(e.target.value))}
                    options={[
                      { value: '0', label: 'هر میزان سابقه' },
                      { value: '1', label: 'دست‌کم ۱ سال' },
                      { value: '3', label: 'دست‌کم ۳ سال' },
                      { value: '5', label: 'دست‌کم ۵ سال' },
                    ]}
                  />
                  <Select
                    compact
                    aria-label="مرتب‌سازی"
                    value={sort}
                    onChange={(e) => setSort(e.target.value as ResumeSort)}
                    options={[
                      { value: 'match', label: 'بیشترین تطابق' },
                      { value: 'newest', label: 'جدیدترین' },
                      { value: 'experience', label: 'بیشترین سابقه' },
                      { value: 'name', label: 'نام' },
                    ]}
                  />
                </div>
              </div>
              <Segmented<MatchFilter>
                size="sm"
                value={match}
                onChange={setMatch}
                items={MATCH_FILTERS.map((m) => ({ id: m.id, label: m.label, count: counts ? counts[m.id === 'all' ? 'all' : m.id] : undefined }))}
              />
            </div>

            {sel.size > 0 && (
              <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-2.5 bg-brand-tint border-b border-brand/15 animate-fade-in">
                <span className="text-[13px] font-bold text-brand-stronger ml-2">{toPersianDigits(sel.size)} مورد انتخاب شد</span>
                <Button size="sm" icon={ThumbsUp} onClick={() => bulkDecide('approved')} loading={bulkBusy}>
                  تأیید
                </Button>
                <Button size="sm" variant="secondary" icon={Clock3} onClick={() => bulkDecide('review')} disabled={bulkBusy}>
                  نیاز به بررسی
                </Button>
                <Button size="sm" variant="secondary" icon={ThumbsDown} onClick={() => setBulkReject(true)} disabled={bulkBusy}>
                  رد
                </Button>
                <Button size="sm" variant="secondary" icon={Columns3} onClick={bulkCompare} disabled={sel.size < 2 || sel.size > 4} title="۲ تا ۴ کاندید">
                  مقایسه
                </Button>
                <Button size="sm" variant="danger-soft" icon={Trash2} onClick={() => setBulkDelete(true)} disabled={bulkBusy}>
                  حذف
                </Button>
                <IconButton icon={X} label="لغو انتخاب" size="sm" onClick={() => setSel(new Set())} className="mr-auto" />
              </div>
            )}

            <div className="p-2 sm:p-0">
              {listQ.error ? (
                <ErrorState message={listQ.error} onRetry={listQ.reload} />
              ) : (
                <CandidateTable
                  items={items}
                  loading={listQ.loading}
                  activeId={selected?.id}
                  onOpen={openCandidate}
                  selected={sel}
                  onToggle={toggle}
                  onToggleAll={toggleAll}
                  compact={panelOpen && isWide}
                  emptyState={
                    s.total === 0 && !running ? (
                      <div className="p-5 sm:p-8">
                        <EmptyState
                          icon={UploadCloud}
                          title="هنوز رزومه‌ای برای این فرصت ثبت نشده است"
                          description={closed ? 'این فرصت بسته شده است؛ برای افزودن رزومه آن را دوباره باز کنید.' : 'رزومه‌ها را بارگذاری کنید تا هویدا آن‌ها را با معیارهای این فرصت بسنجد.'}
                          compact
                        />
                        {!closed && (
                          <div className="max-w-[640px] mx-auto">
                            <UploadDropzone files={uploadFiles} onChange={setUploadFiles} compact />
                            {uploadFiles.length > 0 && (
                              <div className="flex justify-end mt-3">
                                <Button icon={Play} onClick={() => startUpload(uploadFiles)}>
                                  شروع تحلیل {toPersianDigits(uploadFiles.length)} رزومه
                                </Button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <EmptyState icon={Users} title="کاندیدایی با این فیلترها پیدا نشد" description="فیلترها یا عبارت جست‌وجو را تغییر دهید." compact />
                    )
                  }
                />
              )}
            </div>
            {listQ.data && listQ.data.total > 0 && (
              <div className="px-4 sm:px-5 py-3.5 border-t border-line-2">
                <Pagination page={listQ.data.page} totalPages={listQ.data.totalPages} total={listQ.data.total} pageSize={listQ.data.pageSize} onChange={setPage} />
              </div>
            )}
          </Card>

          {panelOpen && isWide && (
            <aside aria-label="جزئیات کاندید" className="hv-card sticky top-[88px] h-[calc(100vh-108px)] overflow-hidden animate-fade-in">
              {sidePanel}
            </aside>
          )}
        </div>
      )}

      {!isWide && (
        <Drawer open={panelOpen} onClose={closeCandidate} width={520} label="جزئیات کاندید">
          {sidePanel}
        </Drawer>
      )}

      <Modal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        size="lg"
        icon={<UploadCloud className="w-5 h-5 text-brand-strong" />}
        title={`افزودن رزومه به «${job.roleTitle}»`}
        description="رزومه‌های تازه با همان معیارهای این فرصت سنجیده می‌شوند و کنار کاندیداهای قبلی رتبه می‌گیرند."
        footer={
          <>
            <Button variant="secondary" onClick={() => setUploadOpen(false)}>
              انصراف
            </Button>
            <Button icon={Play} disabled={!uploadFiles.length} onClick={() => startUpload(uploadFiles)}>
              {uploadFiles.length ? `شروع تحلیل ${toPersianDigits(uploadFiles.length)} رزومه` : 'شروع تحلیل'}
            </Button>
          </>
        }
      >
        <UploadDropzone files={uploadFiles} onChange={setUploadFiles} />
      </Modal>

      <EditJobModal job={job} open={editOpen} onClose={() => setEditOpen(false)} onSaved={(j) => jobQ.setData({ job: j })} />
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={doDeleteJob}
        title="حذف فرصت شغلی؟"
        description={`«${job.roleTitle}» همراه با ${faNumber(s.total)} رزومه و فایل‌های اصلی‌شان برای همیشه حذف می‌شود. اگر فقط می‌خواهید دریافت رزومه متوقف شود، فرصت را «بسته» کنید.`}
        confirmLabel="حذف دائمی"
      />
      <ConfirmDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        onConfirm={doBulkDelete}
        loading={bulkBusy}
        title={`حذف ${toPersianDigits(sel.size)} رزومه؟`}
        description="رزومه‌های انتخاب‌شده و فایل‌های اصلی‌شان برای همیشه حذف می‌شوند."
        confirmLabel="حذف دائمی"
      />
      <RejectModal
        open={bulkReject}
        name={`${toPersianDigits(sel.size)} کاندید`}
        onClose={() => setBulkReject(false)}
        onConfirm={(note) => bulkDecide('rejected', note)}
        loading={bulkBusy}
      />
    </div>
  );
}

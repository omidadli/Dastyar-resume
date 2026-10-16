import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveX,
  BadgeCheck,
  Briefcase,
  CheckCircle2,
  Clock3,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GraduationCap,
  History,
  Lightbulb,
  Mail,
  MapPin,
  MessageSquareText,
  MoreHorizontal,
  Phone,
  RefreshCw,
  ScanSearch,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { Criterion, DecisionStatus, EvidencePoint, ResumeListItem } from '../../types/screening';
import { api, openResumeFile } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { copyText } from '../../lib/clipboard';
import { isInCompare, removeFromCompare, toggleCompare, useCompare } from '../../lib/compare';
import { toEnglishDigits } from '../../lib/normalizeFa';
import { navigate } from '../../lib/router';
import { candidateName, faDate, faNumber, faRelative, toPersianDigits } from '../../lib/format';
import { DECISION_META, matchMeta } from '../../lib/match';
import {
  Button,
  Callout,
  Chip,
  ConfidenceBadge,
  ConfirmDialog,
  EngineBadge,
  IconButton,
  MatchPill,
  Menu,
  Monogram,
  ScoreBadge,
  Tabs,
  toast,
} from '../ui';
import { MessageModal, RejectModal, TalentModal } from './CandidateModals';

type PanelTab = 'summary' | 'skills' | 'experience' | 'more';

export interface CandidatePanelProps {
  record: ResumeListItem;
  jobTitle?: string;
  criteria?: Criterion[];
  onChange: (r: ResumeListItem) => void;
  onDeleted?: (id: string) => void;
  onClose?: () => void;
  /** `page` hides the "view full" action and uses roomier spacing. */
  variant?: 'panel' | 'page';
}

// --------------------------------------------------------------- sections ----

function SectionTitle({ icon: Icon, children, tone = 'neutral', count }: { icon: LucideIcon; children: React.ReactNode; tone?: 'neutral' | 'high' | 'review' | 'low'; count?: number }) {
  const cls = { neutral: 'text-ink-3', high: 'text-high-ink', review: 'text-review-ink', low: 'text-low-ink' }[tone];
  return (
    <h4 className="flex items-center gap-2 text-[13.5px] font-bold text-ink mb-2.5">
      <Icon className={`w-[17px] h-[17px] ${cls}`} strokeWidth={2} />
      {children}
      {count !== undefined && <span className="text-[12px] font-semibold text-ink-4 hv-num">{toPersianDigits(count)}</span>}
    </h4>
  );
}

function Quote({ text }: { text: string }) {
  const none = /اشاره نشده|ثبت نشده|یافت نشد/.test(text);
  return (
    <p className={`mt-1 text-[12.5px] leading-relaxed ${none ? 'text-ink-4 italic' : 'text-ink-3'}`} dir="auto">
      {none ? text : text.startsWith('«') ? text : `«${text}»`}
    </p>
  );
}

function EvidenceList({ items, kind }: { items: EvidencePoint[]; kind: 'strength' | 'weakness' }) {
  if (!items.length) {
    return <p className="text-[13px] text-ink-4">{kind === 'strength' ? 'نقطه قوت مشخصی با شاهد ثبت نشده است.' : 'نکته قابل بررسی ثبت نشده است.'}</p>;
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((it, i) => {
        const knockout = kind === 'weakness' && it.severity === 'knockout';
        const Icon = kind === 'strength' ? CheckCircle2 : knockout ? ShieldAlert : AlertTriangle;
        const color = kind === 'strength' ? 'text-high' : knockout ? 'text-low' : 'text-review';
        return (
          <li key={i} className="flex items-start gap-2.5">
            <Icon className={`w-[17px] h-[17px] mt-[3px] shrink-0 ${color}`} strokeWidth={2.1} />
            <div className="min-w-0">
              <p className="text-[13.5px] font-semibold text-ink leading-relaxed">
                {it.point}
                {knockout && <span className="mr-1.5 align-middle text-[11px] font-bold text-low-ink bg-low-soft rounded px-1.5 py-0.5">شرط اصلی</span>}
              </p>
              <Quote text={it.evidence} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function CriteriaBars({ record, criteria }: { record: ResumeListItem; criteria?: Criterion[] }) {
  if (!record.criterionScores.length) return <p className="text-[13px] text-ink-4">برای این رزومه سنجش معیار به معیار ثبت نشده است.</p>;
  return (
    <ul className="flex flex-col gap-4">
      {record.criterionScores.map((cs) => {
        const c = criteria?.find((x) => x.id === cs.criterionId);
        const level = cs.score >= 70 ? 'bg-high' : cs.score >= 45 ? 'bg-review' : 'bg-low';
        return (
          <li key={cs.criterionId}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-[13px] font-semibold text-ink leading-relaxed">
                {cs.title || c?.title}
                {c?.mustHave && <span className="mr-1.5 text-[11px] font-bold text-ink-3 bg-line-2 rounded px-1.5 py-0.5 align-middle">الزامی</span>}
              </p>
              <span className="text-[12.5px] font-bold text-ink-2 hv-num shrink-0">
                {toPersianDigits(cs.score)}
                <span className="text-ink-4 font-medium">/۱۰۰</span>
              </span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-full bg-line-2 overflow-hidden">
              <div className={`h-full rounded-full ${level}`} style={{ width: `${cs.score}%`, marginInlineStart: 0 }} />
            </div>
            <p className="text-[12.5px] text-ink-2 mt-1.5 leading-relaxed">{cs.rationale}</p>
            <Quote text={cs.evidence} />
            {c && <p className="text-[11px] text-ink-4 mt-1">وزن این معیار: {toPersianDigits(c.weight)}٪</p>}
          </li>
        );
      })}
    </ul>
  );
}

function FactRow({ icon: Icon, label, value, latin }: { icon: LucideIcon; label: string; value: React.ReactNode; latin?: boolean }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-line-2 last:border-0">
      <Icon className="w-[17px] h-[17px] text-ink-4 mt-0.5 shrink-0" strokeWidth={1.8} />
      <span className="text-[12.5px] text-ink-3 w-24 shrink-0 pt-px">{label}</span>
      <span className={`text-[13.5px] font-semibold text-ink min-w-0 break-words ${latin ? 'hv-latin text-right' : ''}`} dir={latin ? 'ltr' : 'auto'}>
        {value || <span className="text-ink-4 font-normal">ذکر نشده</span>}
      </span>
    </div>
  );
}

// ----------------------------------------------------------- decision bar ----

export function DecisionBar({ record, onChange, compact, short }: { record: ResumeListItem; onChange: (r: ResumeListItem) => void; compact?: boolean; short?: boolean }) {
  const [busy, setBusy] = useState<DecisionStatus | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const current = record.decisionStatus;

  const decide = async (status: DecisionStatus, note?: string) => {
    const prev = record;
    setBusy(status);
    try {
      const { record: updated } = await api.resumes.decide(record.id, status, note ?? null);
      onChange(updated);
      setRejectOpen(false); // only on success — a failed request keeps the typed note
      emitChange('resumes', record.jobId);
      emitChange('activity');
      if (status !== 'none') {
        toast(`«${candidateName(record)}» ${DECISION_META[status].label} ثبت شد.`, 'success', {
          label: 'بازگردانی',
          onClick: () => {
            api.resumes
              .decide(prev.id, prev.decisionStatus, prev.decisionNote)
              .then(({ record: restored }) => {
                onChange(restored);
                emitChange('resumes', prev.jobId);
                emitChange('activity');
              })
              .catch((e: any) => toast(e?.message || 'بازگردانی تصمیم ممکن نشد.', 'error'));
          },
        });
      }
    } catch (e: any) {
      toast(e?.message || 'ثبت تصمیم ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const btn = (status: DecisionStatus, label: string, Icon: LucideIcon, activeCls: string) => {
    const active = current === status;
    return (
      <button
        onClick={() => (status === 'rejected' && !active ? setRejectOpen(true) : decide(active ? 'none' : status))}
        disabled={busy !== null}
        aria-pressed={active}
        className={`flex-1 inline-flex items-center justify-center gap-1.5 ${compact ? 'h-9 text-[13px]' : 'h-10 text-[13.5px]'} rounded-[10px] border font-bold transition-colors disabled:opacity-60 ${
          active ? activeCls : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:bg-canvas'
        }`}
        title={active ? 'برای برداشتن تصمیم دوباره بزنید' : undefined}
      >
        <Icon className="w-4 h-4" strokeWidth={2} />
        {label}
      </button>
    );
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[12.5px] font-bold text-ink-2">تصمیم شما</span>
        {current !== 'none' && record.decidedAtISO && (
          <span className="text-[11.5px] text-ink-3">
            {record.decidedByName ? `${record.decidedByName} · ` : ''}
            {faRelative(record.decidedAtISO)}
          </span>
        )}
      </div>
      <div className="flex gap-2">
        {btn('approved', 'تأیید', ThumbsUp, 'bg-brand-strong border-brand-strong text-white')}
        {btn('review', short ? 'بررسی' : 'نیاز به بررسی', Clock3, 'bg-review-soft border-review/40 text-review-ink')}
        {btn('rejected', 'رد', ThumbsDown, 'bg-low-soft border-low/40 text-low-ink')}
      </div>
      {record.decisionNote && current !== 'none' && (
        <p className="mt-2 text-[12.5px] text-ink-3 leading-relaxed">
          <span className="font-semibold text-ink-2">یادداشت: </span>
          {record.decisionNote}
        </p>
      )}
      <RejectModal
        open={rejectOpen}
        name={candidateName(record)}
        onClose={() => setRejectOpen(false)}
        onConfirm={(note) => decide('rejected', note)}
        loading={busy === 'rejected'}
      />
    </div>
  );
}

// ------------------------------------------------------------------ panel ----

export function CandidatePanel({ record, jobTitle, criteria, onChange, onDeleted, onClose, variant = 'panel' }: CandidatePanelProps) {
  const [tab, setTab] = useState<PanelTab>('summary');
  const [messageOpen, setMessageOpen] = useState(false);
  const [talentOpen, setTalentOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rerunning, setRerunning] = useState<'standard' | 'deep' | null>(null);
  useCompare(); // re-render when the tray changes
  const inCompare = isInCompare(record.id);
  const meta = matchMeta(record.category);
  const name = candidateName(record);
  const insufficient = meta.level === 'insufficient';

  useEffect(() => setTab('summary'), [record.id]);

  // Opened outside its job page (رزومه‌ها، بانک استعداد): fetch the opening's
  // criteria so weights and «الزامی» marks still show.
  const [fetchedCriteria, setFetchedCriteria] = useState<Criterion[] | undefined>(undefined);
  useEffect(() => {
    if (criteria) return;
    let alive = true;
    api.jobs
      .get(record.jobId)
      .then(({ job }) => {
        if (alive) setFetchedCriteria(job.understanding.criteria);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [criteria, record.jobId]);
  const jobCriteria = criteria ?? fetchedCriteria;

  const rerun = async (mode: 'standard' | 'deep') => {
    if (rerunning) return; // one re-analysis at a time
    setRerunning(mode);
    try {
      const res = mode === 'deep' ? await api.resumes.deepRerun(record.id) : await api.resumes.rerun(record.id);
      const { extractedText: _t, ...item } = res.record;
      onChange(item);
      emitChange('resumes', record.jobId);
      if (res.engine === 'local') {
        toast('هوش مصنوعی در دسترس نبود؛ نتیجه با موتور محلی به‌روز شد و دقت کمتری دارد.', 'info');
      } else {
        toast(mode === 'deep' ? 'بازبینی دقیق انجام شد و یافته‌های تازه اضافه شد.' : 'تحلیل دوباره انجام شد.');
      }
    } catch (e: any) {
      toast(e?.message || 'تحلیل دوباره ممکن نشد.', 'error');
    } finally {
      setRerunning(null);
    }
  };

  const removeTalent = async () => {
    try {
      const { record: updated } = await api.resumes.removeTalent(record.id);
      onChange(updated);
      emitChange('talent');
      toast('از بانک استعداد خارج شد.');
    } catch (e: any) {
      toast(e?.message || 'انجام نشد.', 'error');
    }
  };

  const doDelete = async () => {
    try {
      await api.resumes.remove(record.id);
      removeFromCompare(record.id);
      emitChange('resumes', record.jobId);
      toast('رزومه و فایل اصلی آن برای همیشه حذف شد.');
      setConfirmDelete(false);
      onDeleted?.(record.id);
    } catch (e: any) {
      toast(e?.message || 'حذف ممکن نشد.', 'error');
    }
  };

  const download = async () => {
    try {
      const ok = await openResumeFile(record.id, 'download');
      if (!ok) toast('فایل اصلی این رزومه روی سرور ذخیره نشده است.', 'info');
    } catch (e: any) {
      toast(e?.message || 'دانلود ممکن نشد.', 'error');
    }
  };

  const compareClick = () => {
    const res = toggleCompare(record.jobId, jobTitle || record.roleTitle || record.departmentName, {
      id: record.id,
      name,
      score: record.score,
      category: record.category,
    });
    if (res === 'full') toast('حداکثر ۴ کاندید را می‌توانید هم‌زمان مقایسه کنید.', 'info');
    else if (res === 'replaced-job') toast('مقایسه فقط بین کاندیداهای یک فرصت شغلی ممکن است؛ فهرست مقایسه از نو شروع شد.', 'info');
    else if (res === 'added') toast('به فهرست مقایسه اضافه شد.');
  };

  const pad = variant === 'page' ? 'px-5 sm:px-6' : 'px-5';
  const facts = record.facts;

  return (
    <div className="flex flex-col min-h-0 h-full overflow-y-auto hv-scroll">
      {/* Header */}
      <div className={`${pad} pt-5 pb-4`}>
        <div className="flex items-start gap-3.5">
          <Monogram name={name} size={52} />
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-extrabold text-ink leading-snug break-words" dir="auto">
              {name}
            </h2>
            <p className="text-[12.5px] text-ink-3 mt-0.5 leading-relaxed">
              {facts?.lastRole || 'سمت ذکر نشده'}
              {facts?.yearsExperience != null && ` · ${toPersianDigits(facts.yearsExperience)} سال سابقه`}
            </p>
            {!record.candidateName && <p className="text-[11.5px] text-ink-4 mt-0.5">نام در رزومه پیدا نشد؛ نام فایل نمایش داده می‌شود.</p>}
          </div>
          <ScoreBadge score={record.score} category={record.category} size={58} />
          {onClose && <IconButton icon={X} label="بستن" size="sm" onClick={onClose} className="-ml-2 -mt-1" />}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3.5">
          <MatchPill category={record.category} />
          <EngineBadge engine={record.engine} />
          <ConfidenceBadge confidence={record.confidence} />
          {record.inBank && <Chip tone="brand" icon={Archive}>بانک استعداد</Chip>}
          {record.analysisMeta?.format && (
            <Chip tone="outline" icon={FileText} title="قالب فایلی که هویدا خواند">
              {record.analysisMeta.format}
            </Chip>
          )}
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Button variant={inCompare ? 'soft' : 'secondary'} size="sm" icon={Columns3} onClick={compareClick} className="flex-1">
            {inCompare ? 'در فهرست مقایسه' : 'افزودن به مقایسه'}
          </Button>
          {variant === 'panel' && (
            <Button variant="secondary" size="sm" icon={ExternalLink} onClick={() => navigate(`/app/candidates/${record.id}`)} className="flex-1">
              مشاهده رزومه کامل
            </Button>
          )}
          <Menu
            align="end"
            width={232}
            items={[
              { label: 'ارسال پیام', icon: MessageSquareText, onClick: () => setMessageOpen(true) },
              record.inBank
                ? { label: 'خروج از بانک استعداد', icon: ArchiveX, onClick: () => void removeTalent() }
                : { label: 'افزودن به بانک استعداد', icon: Archive, onClick: () => setTalentOpen(true) },
              { label: 'دانلود فایل اصلی', icon: Download, onClick: () => void download(), disabled: !record.filePath },
              'divider',
              { label: 'تحلیل دوباره', icon: RefreshCw, onClick: () => void rerun('standard'), disabled: rerunning !== null },
              { label: 'بازبینی دقیق', icon: ScanSearch, onClick: () => void rerun('deep'), hint: 'کندتر', disabled: rerunning !== null },
              'divider',
              { label: 'حذف رزومه', icon: Trash2, tone: 'danger', onClick: () => setConfirmDelete(true) },
            ]}
            trigger={({ toggle }) => <IconButton icon={MoreHorizontal} label="کارهای بیشتر" size="sm" onClick={toggle} className="border border-line" />}
          />
        </div>
      </div>

      <div className={`${pad} pb-4`}>
        <div className="rounded-[12px] bg-canvas border border-line-2 p-3">
          <DecisionBar record={record} onChange={onChange} compact />
        </div>
      </div>

      {rerunning && (
        <div className={`${pad} pb-3`}>
          <Callout tone="brand" icon={rerunning === 'deep' ? ScanSearch : RefreshCw}>
            {rerunning === 'deep' ? 'هویدا رزومه را بند به بند و همراه فایل اصلی دوباره می‌خواند؛ ممکن است تا یک دقیقه طول بکشد…' : 'در حال تحلیل دوباره…'}
          </Callout>
        </div>
      )}

      <Tabs<PanelTab>
        className={`${pad} shrink-0 sticky top-0 z-10 bg-surface`}
        size="sm"
        value={tab}
        onChange={setTab}
        items={[
          { id: 'summary', label: 'خلاصه' },
          { id: 'skills', label: 'مهارت‌ها' },
          { id: 'experience', label: 'تجربه' },
          { id: 'more', label: 'اطلاعات بیشتر' },
        ]}
      />

      <div className={`${pad} py-5`}>
        {tab === 'summary' && (
          <div className="flex flex-col gap-6">
            {record.flags?.multipleCandidates && (
              <Callout tone="warning" title="چند رزومه در یک فایل">
                این فایل رزومه بیش از یک نفر را دارد؛ هویدا رزومه اول (اصلی) را ارزیابی کرد. برای سنجش بقیه، هر رزومه را جداگانه بارگذاری کنید.
              </Callout>
            )}
            {record.flags?.partiallyReadable && (
              <Callout tone="info" title="بخشی از سند خوانا نبود">
                کیفیت اسکن یا عکس در بخش‌هایی پایین بود؛ اطمینان این تحلیل کمتر است. فایل اصلی را هم نگاه کنید.
              </Callout>
            )}
            {insufficient ? (
              <Callout tone="warning" title={meta.label}>
                {record.unjudgeableReason || record.errorMessage || meta.hint}
                <div className="mt-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={RefreshCw}
                    loading={rerunning === 'standard'}
                    disabled={rerunning === 'deep'}
                    onClick={() => void rerun('standard')}
                  >
                    تلاش دوباره برای تحلیل
                  </Button>
                </div>
              </Callout>
            ) : (
              <section>
                <SectionTitle icon={Lightbulb}>جمع‌بندی هویدا</SectionTitle>
                <p className="text-[13.5px] text-ink-2 leading-[1.95]">{record.summary}</p>
                {record.whyCategory && record.whyCategory !== record.summary && (
                  <p className="text-[13px] text-ink-3 mt-2 leading-relaxed">
                    <span className="font-semibold text-ink-2">چرا «{meta.label}»؟ </span>
                    {record.whyCategory}
                  </p>
                )}
              </section>
            )}
            {!insufficient && (
              <>
                <section>
                  <SectionTitle icon={CheckCircle2} tone="high" count={record.strengths.length}>
                    دلایل تطابق
                  </SectionTitle>
                  <EvidenceList items={record.strengths} kind="strength" />
                </section>
                <section>
                  <SectionTitle icon={AlertTriangle} tone="review" count={record.weaknesses.length}>
                    نکات قابل بررسی
                  </SectionTitle>
                  <EvidenceList items={record.weaknesses} kind="weakness" />
                </section>
              </>
            )}
            {record.deepFindings && (
              <section className="rounded-[12px] border border-line p-4">
                <SectionTitle icon={ScanSearch}>یافته‌های بازبینی دقیق</SectionTitle>
                {record.deepFindings.focusPoints.length > 0 && (
                  <ul className="list-disc pr-5 text-[13px] text-ink-2 leading-relaxed space-y-1 mb-3">
                    {record.deepFindings.focusPoints.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
                {record.deepFindings.interviewQuestions.length > 0 && (
                  <>
                    <p className="text-[12.5px] font-bold text-ink-2 mb-1.5">پرسش‌های پیشنهادی برای مصاحبه</p>
                    <ol className="list-decimal pr-5 text-[13px] text-ink-2 leading-relaxed space-y-1 mb-3">
                      {record.deepFindings.interviewQuestions.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ol>
                  </>
                )}
                {record.deepFindings.risks.length > 0 && (
                  <>
                    <p className="text-[12.5px] font-bold text-review-ink mb-1.5">ریسک‌ها و ابهام‌ها</p>
                    <ul className="list-disc pr-5 text-[13px] text-ink-2 leading-relaxed space-y-1">
                      {record.deepFindings.risks.map((f, i) => (
                        <li key={i}>{f}</li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
            <p className="text-[11.5px] text-ink-4 leading-relaxed border-t border-line-2 pt-3">
              این تحلیل پیشنهاد هوش مصنوعی و مبتنی بر متن رزومه است؛ نام، جنسیت و سن در امتیاز اثری ندارند و تصمیم نهایی با شماست.
            </p>
          </div>
        )}

        {tab === 'skills' && (
          <div className="flex flex-col gap-6">
            <section>
              <SectionTitle icon={BadgeCheck}>مهارت‌های کلیدی</SectionTitle>
              {facts?.skills?.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {facts.skills.map((s) => (
                    <Chip key={s} tone="outline">
                      {s}
                    </Chip>
                  ))}
                </div>
              ) : (
                <p className="text-[13px] text-ink-4">مهارتی استخراج نشده است.</p>
              )}
            </section>
            <section>
              <SectionTitle icon={Columns3}>سنجش معیارهای فرصت شغلی</SectionTitle>
              <CriteriaBars record={record} criteria={jobCriteria} />
            </section>
            {record.tags.length > 0 && (
              <section>
                <SectionTitle icon={Archive}>برچسب‌ها</SectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {record.tags.map((t) => (
                    <Chip key={t}>{t}</Chip>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === 'experience' && (
          <div className="flex flex-col gap-6">
            <section>
              <FactRow icon={Briefcase} label="آخرین سمت" value={facts?.lastRole} />
              <FactRow icon={Clock3} label="سابقه کار" value={facts?.yearsExperience != null ? `${toPersianDigits(facts.yearsExperience)} سال` : null} />
              <FactRow icon={GraduationCap} label="تحصیلات" value={facts?.education} />
              <FactRow icon={Wallet} label="حقوق درخواستی" value={facts?.expectedSalary} />
              <FactRow icon={MapPin} label="محل سکونت" value={record.contact?.city} />
            </section>
            {record.knockoutMisses.length > 0 && (
              <Callout tone="danger" title="شرط‌های اصلی احرازنشده">
                <ul className="list-disc pr-4 space-y-0.5">
                  {record.knockoutMisses.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {record.analysisHistory.length > 0 && (
              <section>
                <SectionTitle icon={History}>تاریخچه تحلیل</SectionTitle>
                <ol className="relative border-r border-line pr-4 flex flex-col gap-3">
                  {record.analysisHistory
                    .slice()
                    .reverse()
                    .map((h, i) => (
                      <li key={i} className="relative">
                        <span className="absolute -right-[21px] top-1.5 w-2.5 h-2.5 rounded-full bg-surface border-2 border-brand" />
                        <p className="text-[13px] font-semibold text-ink">
                          {{ initial: 'تحلیل اولیه', rerun: 'تحلیل دوباره', deep: 'بازبینی دقیق', calibration: 'هم‌سنجی با سایر کاندیداها' }[h.reason]}
                          <span className="hv-num text-ink-2 font-bold mr-2">{toPersianDigits(h.score)}٪</span>
                        </p>
                        <p className="text-[11.5px] text-ink-3">
                          {h.atISO ? faDate(h.atISO) : h.atJalali} · {h.engine === 'local' ? 'موتور محلی' : 'هوش مصنوعی'}
                        </p>
                      </li>
                    ))}
                </ol>
              </section>
            )}
          </div>
        )}

        {tab === 'more' && (
          <div className="flex flex-col gap-6">
            <section>
              <SectionTitle icon={Phone}>اطلاعات تماس</SectionTitle>
              <ContactRow icon={Phone} value={record.contact?.phone} href={telHref(record.contact?.phone)} />
              <ContactRow icon={Mail} value={record.contact?.email} href={record.contact?.email ? `mailto:${record.contact.email}` : undefined} />
              <div className="mt-3">
                <Button size="sm" variant="secondary" icon={MessageSquareText} onClick={() => setMessageOpen(true)}>
                  {record.messageStatus === 'sent' ? 'پیام دیگر' : 'نوشتن پیام'}
                </Button>
                {record.messageStatus === 'sent' && (
                  <span className="text-[12px] text-ink-3 mr-3">آخرین پیام: {record.lastMessagedAtJalali}</span>
                )}
              </div>
            </section>
            <section>
              <SectionTitle icon={FileText}>فایل رزومه</SectionTitle>
              <div className="flex items-center gap-3 rounded-[12px] border border-line p-3">
                <span className="w-10 h-10 rounded-[10px] bg-line-2 flex items-center justify-center shrink-0">
                  <FileText className="w-5 h-5 text-ink-3" strokeWidth={1.7} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink truncate text-right" dir="auto" title={record.fileName}>
                    {record.fileName}
                  </p>
                  <p className="text-[11.5px] text-ink-3">
                    {record.fileSize ? `${faNumber(Math.max(1, Math.round(record.fileSize / 1024)))} کیلوبایت · ` : ''}
                    دریافت {faRelative(record.createdAtISO)}
                  </p>
                </div>
                <IconButton icon={Download} label="دانلود" size="sm" onClick={download} disabled={!record.filePath} />
              </div>
              {record.analysisMeta && (record.analysisMeta.format || record.analysisMeta.industry || record.analysisMeta.warnings.length > 0) && (
                <div className="mt-3 rounded-[12px] bg-canvas border border-line-2 p-3 text-[12.5px] text-ink-2 leading-relaxed">
                  <p className="font-bold text-ink mb-1">نحوه خواندن و تحلیل</p>
                  {record.analysisMeta.format && <p>قالب: {record.analysisMeta.format}</p>}
                  {record.analysisMeta.industry && <p>راهنمای تخصصی به‌کاررفته: {record.analysisMeta.industry}</p>}
                  {record.analysisMeta.behaviorVersion && <p className="text-ink-3">نسخه دستورالعمل هوش مصنوعی: {faNumber(record.analysisMeta.behaviorVersion)}</p>}
                  {record.analysisMeta.warnings.map((w, i) => (
                    <p key={i} className="text-ink-3">• {w}</p>
                  ))}
                </div>
              )}
            </section>
            <section>
              <SectionTitle icon={Archive}>بانک استعداد</SectionTitle>
              {record.inBank ? (
                <div className="text-[13px] text-ink-2 leading-relaxed">
                  در بانک استعداد نگهداری می‌شود{record.addedToBankAtISO ? ` (از ${faDate(record.addedToBankAtISO)})` : ''}.
                  {record.bankNote && <p className="text-ink-3 mt-1">«{record.bankNote}»</p>}
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setTalentOpen(true)}>
                      ویرایش
                    </Button>
                    <Button size="sm" variant="danger-soft" icon={ArchiveX} onClick={removeTalent}>
                      خروج از بانک
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-[13px] text-ink-3 mb-2">
                    {record.bankSuggested ? 'هویدا پیشنهاد می‌کند این کاندید برای فرصت‌های آینده نگه داشته شود.' : 'برای فرصت‌های آینده نگهش دارید.'}
                  </p>
                  <Button size="sm" variant="secondary" icon={Archive} onClick={() => setTalentOpen(true)}>
                    افزودن به بانک استعداد
                  </Button>
                </div>
              )}
            </section>
            <section className="flex flex-wrap gap-2 pt-1">
              <Button
                size="sm"
                variant="secondary"
                icon={RefreshCw}
                loading={rerunning === 'standard'}
                disabled={rerunning === 'deep'}
                onClick={() => void rerun('standard')}
              >
                تحلیل دوباره
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={ScanSearch}
                loading={rerunning === 'deep'}
                disabled={rerunning === 'standard'}
                onClick={() => void rerun('deep')}
              >
                بازبینی دقیق
              </Button>
              <Button size="sm" variant="danger-soft" icon={Trash2} onClick={() => setConfirmDelete(true)}>
                حذف رزومه
              </Button>
            </section>
          </div>
        )}
      </div>

      {messageOpen && <MessageModal record={record} onClose={() => setMessageOpen(false)} onSent={onChange} />}
      {talentOpen && <TalentModal record={record} onClose={() => setTalentOpen(false)} onSaved={onChange} />}
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        title="حذف دائمی رزومه؟"
        description={`رزومه «${name}» و فایل اصلی آن برای همیشه حذف می‌شود و قابل بازگردانی نیست.`}
        confirmLabel="حذف دائمی"
      />
    </div>
  );
}

/** `tel:` links need Latin digits and nothing but digits and a leading «+». */
function telHref(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = toEnglishDigits(phone)
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '');
  return digits.replace(/\+/g, '').length >= 5 ? `tel:${digits}` : undefined;
}

function ContactRow({ icon: Icon, value, href }: { icon: LucideIcon; value: string | null | undefined; href?: string }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-line-2 last:border-0">
      <Icon className="w-4 h-4 text-ink-4 shrink-0" strokeWidth={1.8} />
      {value ? (
        <>
          <a href={href} className="text-[13.5px] font-semibold text-ink hover:text-brand-ink hv-latin flex-1 text-right truncate" dir="ltr">
            {value}
          </a>
          <IconButton
            icon={Copy}
            label="کپی"
            size="sm"
            onClick={async () => {
              const ok = await copyText(value);
              toast(ok ? 'کپی شد.' : 'کپی ممکن نشد؛ متن را دستی انتخاب کنید.', ok ? 'success' : 'error');
            }}
          />
        </>
      ) : (
        <span className="text-[13px] text-ink-4">در رزومه ذکر نشده</span>
      )}
    </div>
  );
}


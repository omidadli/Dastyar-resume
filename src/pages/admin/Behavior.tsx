import React, { useEffect, useMemo, useState } from 'react';
import {
  BrainCircuit,
  ChevronDown,
  FileUp,
  FlaskConical,
  History,
  Layers,
  Plus,
  RotateCcw,
  Save,
  ScrollText,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, ConfirmDialog, ErrorState, SearchInput, Segmented, Select, Skeleton, Switch, Tabs, TextArea, TextInput, toast } from '../../components/ui';
import { adminApi, fileToBase64 } from '../../lib/api';
import { normalizeImageFile } from '../../lib/extractText';
import { useLeaveGuard } from '../../lib/router';
import { useAsync } from '../../lib/useAsync';
import { faNumber } from '../../lib/format';
import { matchesSearch } from '../../lib/normalizeFa';
import type { BehaviorConfig, BehaviorPayload, BehaviorSectionKey, IndustryProfile, LabResult, Strictness } from '../../types/admin';
import type { CandidateEvaluation } from '../../types/screening';
import { AdminHeader, faDateTime, useDebounced } from './shared';

type Tab = 'rules' | 'industries' | 'lab' | 'history';

const SECTIONS: Array<{ key: BehaviorSectionKey; title: string; hint: string; rows: number }> = [
  { key: 'identity', title: 'هویت و مأموریت', hint: 'هوش مصنوعی خودش را چه می‌داند و نقشش در تصمیم‌گیری چیست.', rows: 4 },
  { key: 'principles', title: 'اصول بنیادین', hint: 'قوانین نقض‌ناپذیر: فقط شاهد، بدون حدس، نقل‌قول واقعی، صداقت درباره محدودیت.', rows: 10 },
  { key: 'rubric', title: 'روش امتیازدهی', hint: 'معنای هر بازه امتیاز، قوانین سقف و معنای «اطمینان».', rows: 9 },
  { key: 'documents', title: 'خواندن انواع سند و رزومه', hint: 'اسکن و عکس، دوستونه، سایت‌های کاریابی، تاریخ شمسی/میلادی، ایمیل، صوت و ویدیو، فایل غیررزومه، چند رزومه در یک فایل.', rows: 12 },
  { key: 'fairness', title: 'انصاف و منع تبعیض', hint: 'ویژگی‌هایی که هرگز نباید در امتیاز یا لحن اثر بگذارند.', rows: 6 },
  { key: 'seniority', title: 'راهنمای سطح نقش', hint: 'از کارآموز تا مدیر ارشد: در هر سطح چه چیزی سنجیده شود.', rows: 7 },
  { key: 'deep', title: 'بازبینی دقیق', hint: 'روشی که هنگام درخواست «بازبینی دقیق» یک رزومه دنبال می‌شود.', rows: 8 },
  { key: 'output', title: 'قالب و لحن خروجی', hint: 'زبان، لحن، طول خلاصه و قواعد نگارش.', rows: 6 },
  {
    key: 'custom',
    title: 'دستورالعمل‌های اختصاصی شما',
    hint: 'قاعده‌های مخصوص سامانه شما با اولویت بالا (مگر در تعارض با انصاف یا صداقت). مثال: «برای نقش‌های فروش، سابقه کار در صنایع غذایی را مزیت مهم بدان.»',
    rows: 5,
  },
];

const STRICTNESS_HELP: Record<Strictness, string> = {
  lenient: 'تجربه‌های مرتبطِ ضمنی و مهارت‌های قابل انتقال سخاوتمندانه‌تر پذیرفته می‌شوند؛ موارد مرزی به «نیازمند بررسی» می‌روند.',
  balanced: 'شواهد صریح کامل و شواهد ضمنی نسبی پذیرفته می‌شوند (توصیه‌شده).',
  strict: 'فقط شواهد صریح پذیرفته می‌شود؛ ادعای بدون مثال حداکثر ۴۰ می‌گیرد و موارد مرزی پایین‌تر سنجیده می‌شوند.',
};

const lines = (v: string[]) => v.join('\n');
const parseLines = (v: string) =>
  v
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * «One item per line» editor. Keeps the raw text while typing — deriving the
 * value from the parsed list would swallow a trailing space or a fresh empty
 * line, making multi-word items and new lines impossible to type.
 */
function LinesArea({ label, rows, value, onChange }: { label: string; rows: number; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(() => lines(value));
  useEffect(() => {
    // Follow outside changes (reset to default, restore) only.
    setText((t) => (JSON.stringify(parseLines(t)) === JSON.stringify(value) ? t : lines(value)));
  }, [value]);
  return (
    <TextArea
      label={label}
      rows={rows}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseLines(e.target.value));
      }}
    />
  );
}

export default function Behavior() {
  const { data, error, reload, setData } = useAsync(() => adminApi.behavior(), []);
  const [tab, setTab] = useState<Tab>('rules');
  const [draft, setDraft] = useState<BehaviorConfig | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);

  useEffect(() => {
    if (data && !draft) setDraft(data.config);
  }, [data, draft]);

  const dirty = useMemo(() => Boolean(data && draft && JSON.stringify(draft) !== JSON.stringify(data.config)), [data, draft]);

  // Unsaved behaviour edits: leaving the page (or the tab) asks first.
  useLeaveGuard(dirty);

  if (error && !data) {
    return (
      <div>
        <AdminHeader title="رفتار هوش مصنوعی" />
        <div className="hv-card">
          <ErrorState message={error} onRetry={reload} />
        </div>
      </div>
    );
  }
  if (!data || !draft) return <Skeleton className="h-[480px] rounded-card" />;

  const accept = (p: BehaviorPayload, message: string) => {
    setData(p);
    setDraft(p.config);
    setNote('');
    toast(message);
  };

  const save = async () => {
    setSaving(true);
    try {
      accept(await adminApi.saveBehavior(draft, note.trim()), 'رفتار هوش مصنوعی ذخیره شد؛ از رزومه بعدی اعمال می‌شود.');
    } catch (err: any) {
      toast(err?.message || 'ذخیره نشد.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={dirty ? 'pb-24' : ''}>
      <AdminHeader
        title="رفتار هوش مصنوعی"
        subtitle={`هر چیزی که شیوه خواندن و قضاوت رزومه‌ها را شکل می‌دهد — اصول، روش امتیازدهی، قواعد خواندن هر نوع سند، انصاف و راهنمای تخصصی ${faNumber(
          draft.industries.length
        )} صنعت — اینجا قابل ویرایش، نسخه‌دار و آزمایش‌پذیر است.`}
        actions={
          <Chip tone="brand" icon={Layers}>
            نسخه فعال: {faNumber(data.config.version)}
          </Chip>
        }
      />

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        className="mb-5"
        items={[
          { id: 'rules', label: 'دستورالعمل‌ها', icon: ScrollText },
          { id: 'industries', label: 'صنایع', icon: BrainCircuit, count: draft.industries.length },
          { id: 'lab', label: 'آزمایشگاه', icon: FlaskConical },
          { id: 'history', label: 'تاریخچه نسخه‌ها', icon: History, count: data.history.length },
        ]}
      />

      {tab === 'rules' && <RulesTab draft={draft} defaults={data.defaults} onChange={setDraft} />}
      {tab === 'industries' && <IndustriesTab draft={draft} defaults={data.defaults} onChange={setDraft} />}
      {tab === 'lab' && <LabTab draft={draft} dirty={dirty} />}
      {tab === 'history' && (
        <HistoryTab payload={data} onRestore={setRestoreVersion} onResetAll={() => setConfirmReset(true)} />
      )}

      {dirty && (
        <div className="fixed bottom-0 inset-x-0 lg:pr-[252px] z-20">
          <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 pb-4">
            <div className="hv-card shadow-pop px-4 py-3 flex flex-wrap items-center gap-3 border-brand/30">
              <span className="text-[13px] font-bold text-ink flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-review animate-pulse" />
                تغییرات ذخیره‌نشده
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                aria-label="یادداشت این نسخه"
                maxLength={160}
                placeholder="یادداشت این نسخه (اختیاری)"
                className="flex-1 min-w-[180px] h-9 rounded-[10px] border border-line bg-surface px-3 text-[13px] focus:outline-none focus:border-brand"
              />
              <Button variant="ghost" size="sm" onClick={() => setDraft(data.config)}>
                لغو تغییرات
              </Button>
              <Button size="sm" icon={Save} loading={saving} onClick={() => void save()}>
                ذخیره نسخه {faNumber(data.config.version + 1)}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="بازگردانی کامل به تنظیمات پیش‌فرض"
        description={`همه دستورالعمل‌ها و فهرست صنایع به حالت اولیه هویدا برمی‌گردند (به‌صورت یک نسخه تازه؛ نسخه‌های قبلی در تاریخچه می‌مانند).${
          dirty ? ' تغییرات ذخیره‌نشده شما هم کنار گذاشته می‌شود.' : ''
        }`}
        confirmLabel="بازگردانی"
        tone="primary"
        onConfirm={async () => {
          try {
            accept(await adminApi.resetBehavior(), 'تنظیمات پیش‌فرض بازگردانده شد.');
            setConfirmReset(false);
          } catch (err: any) {
            toast(err?.message || 'انجام نشد.', 'error');
          }
        }}
      />
      <ConfirmDialog
        open={restoreVersion !== null}
        onClose={() => setRestoreVersion(null)}
        title={`بازگردانی نسخه ${faNumber(restoreVersion ?? 0)}`}
        description={`محتوای این نسخه به‌صورت نسخه‌ای تازه فعال می‌شود و از رزومه بعدی اعمال می‌شود.${
          dirty ? ' تغییرات ذخیره‌نشده شما کنار گذاشته می‌شود.' : ''
        }`}
        confirmLabel="بازگردانی"
        tone={dirty ? 'danger' : 'primary'}
        onConfirm={async () => {
          if (restoreVersion === null) return;
          try {
            accept(await adminApi.restoreBehavior(restoreVersion), `نسخه ${faNumber(restoreVersion)} بازگردانده شد.`);
            setRestoreVersion(null);
          } catch (err: any) {
            toast(err?.message || 'بازگردانی نشد.', 'error');
          }
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ rules ----

function RulesTab({ draft, defaults, onChange }: { draft: BehaviorConfig; defaults: BehaviorConfig; onChange: (c: BehaviorConfig) => void }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="سطح سخت‌گیری و تشخیص صنعت" icon={Wand2} />
        <div className="grid lg:grid-cols-2 gap-6 mt-4">
          <div>
            <Segmented<Strictness>
              value={draft.strictness}
              onChange={(v) => onChange({ ...draft, strictness: v })}
              items={[
                { id: 'lenient', label: 'حمایتی' },
                { id: 'balanced', label: 'متعادل' },
                { id: 'strict', label: 'سخت‌گیرانه' },
              ]}
            />
            <p className="text-[12.5px] text-ink-3 mt-2 leading-relaxed">{STRICTNESS_HELP[draft.strictness]}</p>
          </div>
          <Switch
            checked={draft.autoIndustry}
            onChange={(v) => onChange({ ...draft, autoIndustry: v })}
            label="تشخیص خودکار صنعت هر فرصت شغلی"
            description="عنوان شغل، دپارتمان و شرح شغل با کلیدواژه‌های صنایع سنجیده می‌شود و راهنمای تخصصی همان صنعت (شایستگی‌ها، مدارک معتبر، نشانه‌های هشدار) به دستور هوش مصنوعی افزوده می‌شود."
          />
        </div>
      </Card>

      {SECTIONS.map((s) => {
        const value = draft.sections[s.key];
        const changed = value !== defaults.sections[s.key];
        return (
          <Card key={s.key}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[15px] font-extrabold text-ink flex items-center gap-2">
                  {s.title}
                  {changed && <Chip tone="warning">ویرایش‌شده</Chip>}
                </h2>
                <p className="text-[12.5px] text-ink-3 mt-1 leading-relaxed">{s.hint}</p>
              </div>
              {changed && (
                <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onChange({ ...draft, sections: { ...draft.sections, [s.key]: defaults.sections[s.key] } })}>
                  پیش‌فرض این بخش
                </Button>
              )}
            </div>
            <TextArea
              aria-label={s.title}
              value={value}
              onChange={(e) => onChange({ ...draft, sections: { ...draft.sections, [s.key]: e.target.value } })}
              rows={s.rows}
              wrapperClassName="mt-3"
              className="leading-[1.9] text-[13.5px]"
              placeholder={s.key === 'custom' ? 'خالی = بدون دستور اختصاصی' : undefined}
            />
            <p className="text-[11px] text-ink-4 mt-1 text-left hv-num">{faNumber(value.length)} نویسه</p>
          </Card>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------- industries ----

function IndustriesTab({ draft, defaults, onChange }: { draft: BehaviorConfig; defaults: BehaviorConfig; onChange: (c: BehaviorConfig) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [role, setRole] = useState('');
  const [dept, setDept] = useState('');
  const debRole = useDebounced(role, 400);
  const debDept = useDebounced(dept, 400);
  const [detected, setDetected] = useState<{ name: string; score: number } | null | undefined>(undefined);

  useEffect(() => {
    if (!debRole.trim() && !debDept.trim()) {
      setDetected(undefined);
      return;
    }
    let alive = true;
    adminApi
      .previewBehavior({ config: draft, roleTitle: debRole, departmentName: debDept })
      .then((r) => alive && setDetected(r.industry))
      .catch(() => alive && setDetected(undefined));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debRole, debDept, JSON.stringify(draft.industries), draft.autoIndustry]);

  const update = (id: string, patch: Partial<IndustryProfile>) => onChange({ ...draft, industries: draft.industries.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  const filtered = draft.industries.filter((i) => !q.trim() || matchesSearch([i.name, ...i.keywords], q));

  const addCustom = () => {
    const id = `custom-${Date.now().toString(36)}`;
    setQ(''); // the new entry must not be hidden by the current search
    onChange({
      ...draft,
      industries: [{ id, name: 'صنعت تازه', enabled: true, builtin: false, keywords: [], competencies: [], evidence: [], credentials: [], redFlags: [], notes: '' }, ...draft.industries],
    });
    setOpen(id);
  };

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader title="آزمون تشخیص صنعت" subtitle="ببینید یک عنوان شغلی با تنظیمات فعلی (حتی ذخیره‌نشده) به کدام صنعت نسبت داده می‌شود." icon={Search} />
        <div className="grid sm:grid-cols-[1fr_1fr_auto] gap-3 mt-3 items-end">
          <TextInput label="عنوان شغلی" value={role} onChange={(e) => setRole(e.target.value)} placeholder="مثلاً: مسئول فنی کارخانه لبنیات" />
          <TextInput label="دپارتمان" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="مثلاً: تولید" />
          <div className="h-11 flex items-center">
            {detected === undefined ? (
              <span className="text-[12.5px] text-ink-4">—</span>
            ) : detected ? (
              <Chip tone="brand" icon={Sparkles}>
                {detected.name}
              </Chip>
            ) : (
              <Chip tone="neutral">بدون صنعت مشخص (راهنمای عمومی)</Chip>
            )}
          </div>
        </div>
        {!draft.autoIndustry && <p className="text-[12px] text-review-ink mt-2">تشخیص خودکار صنعت در «دستورالعمل‌ها» خاموش است.</p>}
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SearchInput value={q} onChange={setQ} placeholder="جست‌وجوی صنعت یا کلیدواژه…" className="w-full sm:w-[300px]" />
        <Button size="sm" icon={Plus} onClick={addCustom}>
          صنعت تازه
        </Button>
      </div>
      <Callout tone="info">
        کلیدواژه‌ها در عنوان شغل (وزن ۳)، دپارتمان (۲) و شرح شغل (۱) جست‌وجو می‌شوند. کلیدواژه عمومی را با <b className="hv-latin">~</b> شروع کنید (مثل «~کارخانه») تا وزن کمتری بگیرد.
      </Callout>

      <div className="grid gap-2">
        {filtered.map((ind) => {
          const isOpen = open === ind.id;
          const def = defaults.industries.find((d) => d.id === ind.id);
          const changed = def ? JSON.stringify({ ...def, enabled: ind.enabled }) !== JSON.stringify(ind) : false;
          return (
            <div key={ind.id} className={`hv-card ${ind.enabled ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => setOpen(isOpen ? null : ind.id)} className="flex-1 min-w-0 flex items-center gap-2 text-right" aria-expanded={isOpen}>
                  <ChevronDown className={`w-4 h-4 text-ink-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  <span className="font-bold text-ink text-[14px] truncate">{ind.name}</span>
                  {!ind.builtin && <Chip tone="brand">سفارشی</Chip>}
                  {changed && <Chip tone="warning">ویرایش‌شده</Chip>}
                  <span className="text-[11.5px] text-ink-4 hidden sm:inline truncate">
                    {ind.keywords.slice(0, 4).join('، ')}
                    {ind.keywords.length > 4 ? '…' : ''}
                  </span>
                </button>
                <Switch checked={ind.enabled} onChange={(v) => update(ind.id, { enabled: v })} ariaLabel={`فعال بودن صنعت «${ind.name}»`} />
              </div>
              {isOpen && (
                <div className="px-4 pb-4 pt-1 border-t border-line-2 grid gap-3">
                  <div className="grid sm:grid-cols-2 gap-3 mt-3">
                    <TextInput label="نام صنعت" value={ind.name} onChange={(e) => update(ind.id, { name: e.target.value })} />
                    <LinesArea label="کلیدواژه‌ها (هر خط یک مورد)" rows={3} value={ind.keywords} onChange={(v) => update(ind.id, { keywords: v })} />
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <LinesArea label="شایستگی‌های کلیدی" rows={5} value={ind.competencies} onChange={(v) => update(ind.id, { competencies: v })} />
                    <LinesArea label="شاهدهای معتبر" rows={5} value={ind.evidence} onChange={(v) => update(ind.id, { evidence: v })} />
                    <LinesArea label="مدارک و گواهی‌های رایج" rows={4} value={ind.credentials} onChange={(v) => update(ind.id, { credentials: v })} />
                    <LinesArea label="نشانه‌های نیازمند بررسی" rows={4} value={ind.redFlags} onChange={(v) => update(ind.id, { redFlags: v })} />
                  </div>
                  <TextArea label="نکته تکمیلی" optional rows={2} value={ind.notes} onChange={(e) => update(ind.id, { notes: e.target.value })} />
                  <div className="flex flex-wrap gap-2 justify-end">
                    {def && changed && (
                      <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => update(ind.id, { ...def, enabled: ind.enabled })}>
                        پیش‌فرض این صنعت
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="danger-soft"
                      icon={Trash2}
                      onClick={() => {
                        onChange({ ...draft, industries: draft.industries.filter((i) => i.id !== ind.id) });
                        setOpen(null);
                      }}
                    >
                      حذف صنعت
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- lab ----

const REC_LABEL: Record<string, string> = { INTERVIEW: 'تطابق بالا', REVIEW: 'نیازمند بررسی', REJECT: 'تطابق پایین' };

function LabTab({ draft, dirty }: { draft: BehaviorConfig; dirty: boolean }) {
  const jobs = useAsync(() => adminApi.jobs(), []);
  const [jobId, setJobId] = useState('');
  const [roleTitle, setRoleTitle] = useState('کارشناس فروش');
  const [departmentName, setDepartmentName] = useState('فروش');
  const [extraNotes, setExtraNotes] = useState('');
  const [resumeText, setResumeText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<'standard' | 'deep'>('standard');
  const [useDraft, setUseDraft] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LabResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      let fileBase64: string | undefined;
      let fileName: string | undefined;
      if (file) {
        const ready = await normalizeImageFile(file);
        fileBase64 = await fileToBase64(ready);
        fileName = ready.name;
      }
      setResult(
        await adminApi.lab({
          ...(useDraft ? { config: draft } : {}),
          ...(jobId ? { jobId } : { roleTitle, departmentName, extraNotes }),
          resumeText,
          fileBase64,
          fileName,
          mode,
        })
      );
    } catch (err: any) {
      setError(err?.message || 'آزمایش انجام نشد.');
    } finally {
      setRunning(false);
    }
  };

  const ev = result?.evaluation as CandidateEvaluation | undefined;
  const unjudgeable = ev && (ev.flags.insufficientInfo || ev.flags.scannedNoText || ev.flags.notResume || ev.flags.needsAi);

  return (
    <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] gap-4 items-start">
      <Card>
        <CardHeader title="آزمایش یک رزومه" subtitle="هر رزومه‌ای را با هر قالبی به فرصت شغلی واقعی یا فرضی بدهید و نتیجه و دستور دقیق ارسالی را ببینید." icon={FlaskConical} />
        <div className="grid gap-4 mt-4">
          <Select
            label="فرصت شغلی"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            options={[{ value: '', label: 'فرصت فرضی (پایین تعریف کنید)' }, ...(jobs.data?.items || []).map((j) => ({ value: j.id, label: `${j.title} — ${j.orgName}` }))]}
          />
          {!jobId && (
            <div className="grid sm:grid-cols-2 gap-3">
              <TextInput label="عنوان شغلی" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} />
              <TextInput label="دپارتمان" value={departmentName} onChange={(e) => setDepartmentName(e.target.value)} />
              <TextArea label="شرح شغل" optional rows={2} wrapperClassName="sm:col-span-2" value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} />
            </div>
          )}
          <TextArea label="متن رزومه" optional={Boolean(file)} rows={7} value={resumeText} onChange={(e) => setResumeText(e.target.value)} placeholder="متن رزومه را اینجا بچسبانید، یا فایل انتخاب کنید." />
          <label className="relative flex items-center gap-3 rounded-[12px] border border-dashed border-line-strong px-4 py-3 cursor-pointer hover:border-brand/50 focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15">
            <FileUp className="w-5 h-5 text-brand-strong" />
            <span className="flex-1 min-w-0 text-[13px] text-ink-2 truncate">{file ? file.name : 'انتخاب فایل رزومه (هر قالبی)'}</span>
            {file && (
              <button
                type="button"
                className="text-[12px] text-ink-3 hover:text-low-ink"
                onClick={(e) => {
                  e.preventDefault();
                  setFile(null);
                }}
              >
                حذف
              </button>
            )}
            {/* sr-only, not hidden: the picker must be reachable with the keyboard. */}
            <input
              type="file"
              className="sr-only"
              onChange={(e) => {
                setFile(e.target.files?.[0] || null);
                e.target.value = ''; // picking the same file again still fires onChange
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-4 justify-between">
            <Segmented
              value={mode}
              onChange={setMode}
              size="sm"
              items={[
                { id: 'standard', label: 'تحلیل عادی' },
                { id: 'deep', label: 'بازبینی دقیق' },
              ]}
            />
            <Switch checked={useDraft} onChange={setUseDraft} label={dirty ? 'با تغییرات ذخیره‌نشده' : 'با پیش‌نویس فعلی'} />
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
          <Button icon={FlaskConical} loading={running} onClick={() => void run()} disabled={!resumeText.trim() && !file}>
            اجرای آزمایش
          </Button>
        </div>
      </Card>

      <div className="grid gap-4">
        {!result ? (
          <Card>
            <div className="py-10 text-center text-ink-3 text-[13px]">نتیجه آزمایش اینجا نمایش داده می‌شود.</div>
          </Card>
        ) : (
          <>
            <Card>
              <div className="flex flex-wrap items-center gap-3">
                <div
                  className={`w-16 h-16 rounded-full flex items-center justify-center text-[20px] font-black hv-num ${
                    unjudgeable ? 'bg-line-2 text-ink-3' : ev?.recommendation === 'INTERVIEW' ? 'bg-high-soft text-high-ink' : ev?.recommendation === 'REVIEW' ? 'bg-review-soft text-review-ink' : 'bg-low-soft text-low-ink'
                  }`}
                >
                  {unjudgeable ? '—' : faNumber(ev?.score ?? 0)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-extrabold text-ink">{unjudgeable ? 'اطلاعات ناکافی' : REC_LABEL[ev?.recommendation || 'REJECT']}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    <Chip tone={result.engine === 'ai' ? 'brand' : 'warning'}>{result.engine === 'ai' ? 'پیشنهاد هویدا (هوش مصنوعی)' : 'تحلیل محلی'}</Chip>
                    {result.industry && <Chip tone="outline">صنعت: {result.industry.name}</Chip>}
                    {result.format && <Chip tone="outline">قالب: {result.format}</Chip>}
                    {ev?.meta?.documentType && ev.meta.documentType !== 'resume' && <Chip tone="warning">نوع سند: {ev.meta.documentType}</Chip>}
                    <Chip tone="neutral">{faNumber(result.latencyMs)} میلی‌ثانیه</Chip>
                  </div>
                </div>
              </div>
              {result.engine === 'local' && (
                <Callout tone="warning" className="mt-3">
                  هوش مصنوعی پاسخ نداد (کلید فعال یا آماده‌ای نبود)؛ نتیجه با موتور محلی است و دستورالعمل‌ها روی آن اثری ندارند.
                </Callout>
              )}
              {result.warnings.length > 0 && (
                <ul className="mt-3 text-[12px] text-ink-3 list-disc pr-5 space-y-0.5">
                  {result.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {ev && (
                <>
                  <p className="mt-3 text-[13.5px] text-ink-2 leading-[1.9]">{ev.summary}</p>
                  {ev.criterionScores.length > 0 && (
                    <div className="mt-4 grid gap-2.5">
                      {ev.criterionScores.map((c) => (
                        <div key={c.criterionId}>
                          <div className="flex justify-between text-[12.5px]">
                            <span className="font-semibold text-ink-2">{c.title}</span>
                            <span className="hv-num text-ink-3">{faNumber(c.score)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-line-2 overflow-hidden mt-1">
                            <div className="h-full bg-brand rounded-full" style={{ width: `${c.score}%` }} />
                          </div>
                          {c.evidence && <p className="text-[11.5px] text-ink-3 mt-1 leading-relaxed">«{c.evidence}»</p>}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid sm:grid-cols-2 gap-3 mt-4">
                    <EvidenceList title="نقاط قوت" items={ev.strengths} tone="high" />
                    <EvidenceList title="نقاط نیازمند بررسی" items={ev.weaknesses} tone="low" />
                  </div>
                </>
              )}
            </Card>
            <PromptBox title="دستور سیستمی (رفتار)" text={result.systemPrompt} />
            <PromptBox title="درخواست ارسالی (شغل و رزومه)" text={result.userPrompt} />
          </>
        )}
      </div>
    </div>
  );
}

function EvidenceList({ title, items, tone }: { title: string; items: Array<{ point: string; evidence: string }>; tone: 'high' | 'low' }) {
  return (
    <div className="rounded-[12px] border border-line p-3">
      <p className={`text-[12.5px] font-bold mb-2 ${tone === 'high' ? 'text-high-ink' : 'text-low-ink'}`}>{title}</p>
      {items.length ? (
        <ul className="grid gap-2">
          {items.map((it, i) => (
            <li key={i} className="text-[12.5px] leading-relaxed">
              <p className="font-semibold text-ink-2">{it.point}</p>
              {it.evidence && <p className="text-ink-3 text-[11.5px]">«{it.evidence}»</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-ink-4">—</p>
      )}
    </div>
  );
}

function PromptBox({ title, text }: { title: string; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="hv-card">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center justify-between px-4 py-3 text-right">
        <span className="font-bold text-ink text-[13.5px]">{title}</span>
        <span className="flex items-center gap-2 text-[12px] text-ink-3">
          {faNumber(text.length)} نویسه
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && <pre className="px-4 pb-4 text-[12px] leading-[1.9] text-ink-2 whitespace-pre-wrap font-[inherit] max-h-[520px] overflow-y-auto hv-scroll">{text}</pre>}
    </div>
  );
}

// ---------------------------------------------------------------- history ----

function HistoryTab({ payload, onRestore, onResetAll }: { payload: BehaviorPayload; onRestore: (v: number) => void; onResetAll: () => void }) {
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader
          title="نسخه‌های ذخیره‌شده"
          subtitle="هر ذخیره یک نسخه تازه می‌سازد. بازگردانی هم نسخه تازه‌ای با همان محتوا می‌سازد، پس هیچ تغییری گم نمی‌شود."
          icon={History}
          action={
            <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onResetAll}>
              بازگردانی به پیش‌فرض
            </Button>
          }
        />
        {payload.history.length ? (
          <ul className="mt-3 divide-y divide-line-2">
            {payload.history.map((h) => (
              <li key={`${h.version}-${h.savedAtISO}`} className="py-3 flex flex-wrap items-center gap-3">
                <span className="w-10 h-10 rounded-[11px] bg-line-2 text-ink font-extrabold flex items-center justify-center hv-num">{faNumber(h.version)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[13.5px] font-bold text-ink">{h.note || 'بدون یادداشت'}</p>
                  <p className="text-[12px] text-ink-3">
                    {faDateTime(h.savedAtISO)}، <bdi>{h.savedBy || '—'}</bdi>
                  </p>
                </div>
                {h.version === payload.config.version ? (
                  <Chip tone="brand">نسخه فعال</Chip>
                ) : (
                  <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => onRestore(h.version)}>
                    بازگردانی
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-3 mt-3">هنوز تغییری ذخیره نشده است؛ تنظیمات پیش‌فرض هویدا فعال است.</p>
        )}
      </Card>
    </div>
  );
}

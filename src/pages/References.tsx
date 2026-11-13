/**
 * «استعلام مرجع» — the hiring team's side.
 *
 * The page is built around one rule, in this order:
 *   1. **Consent** — until the candidate has agreed, nothing can be sent and the
 *      page says why instead of quietly disabling a button;
 *   2. **Who** — two or three referees, each with a relation and a channel;
 *   3. **Ask** — an e-mail with a private link, or a phone call whose answers HR
 *      types in and which is labelled as such;
 *   4. **Read** — averages and the referees' own words, ending in a human
 *      decision. Nothing here moves the candidate's stage.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Mail,
  Phone,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  UserRoundCheck,
  Users,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import {
  Button,
  Callout,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Modal,
  Select,
  Skeleton,
  TextArea,
  TextInput,
  toast,
} from '../components/ui';
import { api, ApiError } from '../lib/api';
import { candidateName, toPersianDigits } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import {
  RELATION_LABEL,
  STATUS_LABEL,
  type ReferenceCase,
  type Referee,
  type RefereeRelation,
  type RefereeStatus,
} from '../types/references';

const STATUS_TONE: Record<RefereeStatus, string> = {
  pending: 'bg-canvas text-ink-3 border-line',
  sent: 'bg-[#EAF2F7] text-[#24485E] border-[#D5E3EC]',
  opened: 'bg-review-soft text-review-ink border-review/25',
  completed: 'bg-brand-tint text-brand-stronger border-brand/20',
  declined: 'bg-na-soft text-na-ink border-line',
  expired: 'bg-low-soft text-low-ink border-low/20',
};

const RELATIONS: RefereeRelation[] = ['manager', 'colleague', 'subordinate', 'client', 'other'];

function Stars({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[12px] text-ink-4">—</span>;
  return (
    <span className="text-[12.5px] font-bold text-ink hv-num">
      {toPersianDigits(value)} <span className="text-ink-4 font-normal">از ۵</span>
    </span>
  );
}

export default function References({ resumeId }: { resumeId: string }) {
  const q = useAsync(() => api.references.get(resumeId), [resumeId]);
  const [data, setData] = useState<ReferenceCase | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [recording, setRecording] = useState<Referee | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) setData(q.data);
  }, [q.data]);

  useTitle(data ? `استعلام مرجع · ${data.candidateName}` : 'استعلام مرجع');

  if (q.error) {
    return (
      <div>
        <PageHeader breadcrumb={[{ label: 'رزومه‌ها', to: '/app/candidates' }]} title="استعلام مرجع" />
        <Card>
          <p className="text-[13px] text-low-ink">{q.error}</p>
        </Card>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const refresh = async () => {
    try {
      setData(await api.references.get(resumeId));
    } catch {
      /* the page keeps what it has */
    }
  };

  const act = async (id: string, fn: () => Promise<unknown>, okMessage: string) => {
    setBusyId(id);
    try {
      await fn();
      await refresh();
      toast(okMessage);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'انجام این کار ممکن نشد.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const consented = Boolean(data.consentAtISO);

  return (
    <div className="max-w-[980px]">
      <PageHeader
        breadcrumb={[
          { label: 'رزومه‌ها', to: '/app/candidates' },
          { label: data.candidateName, to: `/app/candidates/${resumeId}` },
          { label: 'استعلام مرجع' },
        ]}
        title={`استعلام مرجع — ${data.candidateName}`}
        subtitle={data.jobTitle ? `برای «${data.jobTitle}»` : undefined}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => void refresh()}>
            به‌روزرسانی
          </Button>
        }
      />

      {/* ---------------------------------------------------------- consent --- */}
      {!consented ? (
        <ConsentGate
          onRecorded={async (note) => {
            try {
              setData(await api.references.consent(resumeId, { note }));
              toast('رضایت ثبت شد؛ حالا می‌توانید مراجع را اضافه کنید.');
            } catch (err) {
              toast(err instanceof ApiError ? err.message : 'ثبت رضایت ممکن نشد.', 'error');
            }
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-3 mb-4">
          <span className="inline-flex items-center gap-1.5 text-brand-ink font-semibold">
            <ShieldCheck className="w-4 h-4" /> رضایت کارجو ثبت شده
          </span>
          <span>{data.consentAtJalali}</span>
          {data.consentByName && <span>— ثبت توسط {data.consentByName}</span>}
          {data.consentNote && <span className="text-ink-4">«{data.consentNote}»</span>}
        </div>
      )}

      {/* ----------------------------------------------------------- summary --- */}
      {data.summary.completed > 0 && (
        <Card className="mb-4">
          <CardHeader
            title="جمع‌بندی پاسخ‌ها"
            subtitle="این عددها فقط برای تصمیم انسانی‌اند؛ هیچ مرحله‌ای خودکار تغییر نمی‌کند."
            icon={UserRoundCheck}
          />
          <p className={`text-[13.5px] leading-relaxed ${data.summary.needsReview ? 'text-review-ink font-semibold' : 'text-ink-2'}`}>
            {data.summary.needsReview && <AlertTriangle className="w-4 h-4 inline ml-1.5 -mt-0.5" />}
            {data.summary.headline}
          </p>
          <div className="grid sm:grid-cols-4 gap-3 mt-4">
            {[
              { label: 'تمایل به همکاری دوباره', value: data.summary.wouldRehire },
              { label: 'کیفیت کار', value: data.summary.average.performance },
              { label: 'کار تیمی', value: data.summary.average.collaboration },
              { label: 'تعهد و وقت‌شناسی', value: data.summary.average.reliability },
            ].map((s) => (
              <div key={s.label} className="rounded-control border border-line-2 bg-canvas px-3 py-2">
                <p className="text-[11px] text-ink-3">{s.label}</p>
                <Stars value={s.value} />
              </div>
            ))}
          </div>
          <p className="text-[11.5px] text-ink-4 mt-3">
            {toPersianDigits(data.summary.completed)} پاسخ از {toPersianDigits(data.summary.invited)} مرجع
            {data.summary.declined > 0 ? ` ، ${toPersianDigits(data.summary.declined)} نفر عذر خواست` : ''}
          </p>
        </Card>
      )}

      {/* ---------------------------------------------------------- referees --- */}
      <Card>
        <CardHeader
          title="مراجع"
          subtitle="دو یا سه نفر کافی است؛ هرچه بیشتر، پاسخ کمتر."
          icon={Users}
          action={
            <Button size="sm" icon={Plus} onClick={() => setAddOpen(true)} disabled={!consented}>
              افزودن مرجع
            </Button>
          }
        />
        {data.referees.length === 0 ? (
          <EmptyState
            icon={Users}
            title="هنوز مرجعی اضافه نشده"
            description={
              consented
                ? 'نام، نسبت و راه تماس دو یا سه نفر را وارد کنید؛ برای هرکس یک لینک خصوصی ساخته می‌شود.'
                : 'اول رضایت کارجو را ثبت کنید، بعد مراجع را اضافه کنید.'
            }
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {data.referees.map((r) => (
              <li key={r.id} className="rounded-control border border-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-bold text-ink">
                      {r.name}
                      <span className="text-[11.5px] font-normal text-ink-3 mr-2">{RELATION_LABEL[r.relation]}</span>
                    </p>
                    <p className="text-[11.5px] text-ink-3 truncate">
                      {[r.title, r.company].filter(Boolean).join(' · ') || '—'}
                      {r.email ? ` · ${r.email}` : ''}
                      {r.phone ? ` · ${r.phone}` : ''}
                    </p>
                  </div>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                </div>

                {r.status === 'completed' && (
                  <div className="mt-2.5 rounded-[10px] bg-canvas border border-line-2 p-2.5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
                      <span>
                        همکاری دوباره: <b className="text-ink-2 hv-num">{r.answers.wouldRehire ? toPersianDigits(r.answers.wouldRehire) : '—'}/۵</b>
                      </span>
                      <span>کیفیت کار: {toPersianDigits(r.answers.performance || 0)}/۵</span>
                      <span>تیمی: {toPersianDigits(r.answers.collaboration || 0)}/۵</span>
                      <span>تعهد: {toPersianDigits(r.answers.reliability || 0)}/۵</span>
                      {r.answers.duration && <span>مدت آشنایی: {r.answers.duration}</span>}
                      {r.source === 'phone' && (
                        <span className="inline-flex items-center gap-1 text-review-ink font-semibold">
                          <Phone className="w-3 h-3" /> ثبت تلفنی توسط {r.recordedByName || 'همکار'}
                        </span>
                      )}
                    </div>
                    {r.answers.strengths && <p className="text-[12.5px] text-ink-2 mt-1.5 leading-relaxed">«{r.answers.strengths}»</p>}
                    {r.answers.concerns && <p className="text-[12.5px] text-ink-3 mt-1 leading-relaxed">نکتهٔ قابل بررسی: «{r.answers.concerns}»</p>}
                  </div>
                )}
                {r.status === 'declined' && r.declinedReason && <p className="text-[11.5px] text-ink-3 mt-2">دلیل: {r.declinedReason}</p>}

                <div className="flex flex-wrap items-center gap-2 mt-2.5">
                  {(r.status === 'pending' || r.status === 'expired') && (
                    <Button
                      size="sm"
                      icon={Mail}
                      loading={busyId === r.id}
                      onClick={() => void act(r.id, () => api.references.send(r.id), 'درخواست معرفی فرستاده شد.')}
                    >
                      فرستادن لینک
                    </Button>
                  )}
                  {(r.status === 'sent' || r.status === 'opened') && r.remindCount === 0 && (
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={Mail}
                      loading={busyId === r.id}
                      onClick={() => void act(r.id, () => api.references.remind(r.id), 'یادآوری فرستاده شد.')}
                    >
                      یادآوری
                    </Button>
                  )}
                  {r.status !== 'completed' && (
                    <Button size="sm" variant="secondary" icon={Phone} onClick={() => setRecording(r)} disabled={!consented}>
                      ثبت پاسخ تلفنی
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Copy}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(r.url || '');
                        toast('لینک کپی شد؛ می‌توانید در واتساپ یا پیامک بفرستید.');
                      } catch {
                        toast('کپی ممکن نشد؛ لینک را از کادر زیر بردارید.', 'error');
                      }
                    }}
                  >
                    کپی لینک
                  </Button>
                  {r.status !== 'completed' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Trash2}
                      className="text-low-ink"
                      onClick={() => void act(r.id, () => api.references.remove(r.id), 'مرجع حذف شد.')}
                    >
                      حذف
                    </Button>
                  )}
                </div>
                <p className="hv-latin text-[10.5px] text-ink-4 mt-1.5 truncate" dir="ltr">
                  {r.url}
                </p>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11.5px] text-ink-4 mt-3 leading-relaxed">
          پاسخ‌ها هرگز به کارجو نشان داده نمی‌شوند. «ثبت پاسخ تلفنی» یعنی آنچه شنیده‌اید را خودتان وارد می‌کنید و نام شما روی آن می‌ماند.
        </p>
      </Card>

      <AddRefereeModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={async (payload) => {
          try {
            setData(await api.references.add(resumeId, payload));
            setAddOpen(false);
            toast('مرجع اضافه شد؛ حالا لینک را بفرستید.');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'افزودن مرجع ممکن نشد.', 'error');
          }
        }}
      />

      <PhoneRecordModal
        referee={recording}
        onClose={() => setRecording(null)}
        onSubmit={async (payload) => {
          if (!recording) return;
          try {
            await api.references.record(recording.id, payload);
            await refresh();
            setRecording(null);
            toast('پاسخ تلفنی ثبت شد و به‌عنوان «ثبت تلفنی» علامت خورد.');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'ثبت پاسخ ممکن نشد.', 'error');
          }
        }}
      />
    </div>
  );
}

function ConsentGate({ onRecorded }: { onRecorded: (note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Card className="mb-4">
      <CardHeader title="رضایت کارجو" subtitle="پیش از هر تماس، این را ثبت کنید" icon={ShieldCheck} />
      <Callout tone="warning" title="بدون رضایت، هیچ درخواستی فرستاده نمی‌شود">
        اطلاعات مرجع، اطلاعات شخصی کارجوست و در بسیاری از موارد خودِ مرجع هم بی‌خبر است. پیش از این کادر، از کارجو اجازهٔ تماس بگیرید (شفاهی کافی است) و
        اینجا ثبت کنید که چه زمانی و چگونه گرفتید.
      </Callout>
      <div className="mt-4 flex flex-col gap-3">
        <Field label="چگونه و کِی رضایت گرفتید؟" optional hint="مثلاً «تلفنی، ۱۴۰۳/۰۵/۱۲ — گفت با دو مرجع تماس بگیریم».">
          <TextArea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} />
        </Field>
        <label className="flex items-start gap-2.5 text-[12.5px] text-ink-2">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-1 accent-[var(--color-brand)]" />
          <span>تأیید می‌کنم کارجو با تماس با این مراجع موافقت کرده است.</span>
        </label>
        <div>
          <Button
            icon={ShieldCheck}
            disabled={!confirmed}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onRecorded(note.trim());
              } finally {
                setBusy(false);
              }
            }}
          >
            ثبت رضایت و ادامه
          </Button>
        </div>
      </div>
    </Card>
  );
}

function AddRefereeModal({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (b: { name: string; title: string; company: string; email: string; phone: string; relation: RefereeRelation }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [relation, setRelation] = useState<RefereeRelation>('manager');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setTitle('');
      setCompany('');
      setEmail('');
      setPhone('');
      setRelation('manager');
    }
  }, [open]);

  const canSave = name.trim().length >= 2 && (email.trim() || phone.trim());

  return (
    <Modal open={open} onClose={onClose} title="افزودن مرجع" size="md">
      <div className="flex flex-col gap-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <TextInput label="نام و نام خانوادگی" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          <Field label="نسبت با کارجو">
            <Select
              value={relation}
              onChange={(e) => setRelation(e.target.value as RefereeRelation)}
              options={RELATIONS.map((r) => ({ value: r, label: RELATION_LABEL[r] }))}
            />
          </Field>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <TextInput label="سمت" optional value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          <TextInput label="سازمان" optional value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} />
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <TextInput label="ایمیل" optional latin value={email} onChange={(e) => setEmail(e.target.value)} hint="برای فرستادن لینک لازم است." />
          <TextInput label="شمارهٔ تماس" optional latin value={phone} onChange={(e) => setPhone(e.target.value)} hint="اگر ایمیل ندارد، پاسخ را تلفنی ثبت می‌کنید." />
        </div>
        {!canSave && (email || phone || name) && (
          <p className="text-[11.5px] text-ink-3">نام کامل و دست‌کم یکی از راه‌های تماس لازم است.</p>
        )}
        <div className="flex justify-end gap-2 mt-1">
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button
            loading={busy}
            disabled={!canSave}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({ name: name.trim(), title: title.trim(), company: company.trim(), email: email.trim(), phone: phone.trim(), relation });
              } finally {
                setBusy(false);
              }
            }}
          >
            افزودن
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PhoneRecordModal({
  referee,
  onClose,
  onSubmit,
}: {
  referee: Referee | null;
  onClose: () => void;
  onSubmit: (b: {
    performance?: number;
    collaboration?: number;
    reliability?: number;
    wouldRehire?: number;
    duration?: string;
    strengths?: string;
    concerns?: string;
  }) => Promise<void>;
}) {
  const [scores, setScores] = useState<Record<string, number | null>>({ performance: null, collaboration: null, reliability: null, wouldRehire: null });
  const [duration, setDuration] = useState('');
  const [strengths, setStrengths] = useState('');
  const [concerns, setConcerns] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setScores({ performance: null, collaboration: null, reliability: null, wouldRehire: null });
    setDuration('');
    setStrengths('');
    setConcerns('');
  }, [referee?.id]);

  const rows = useMemo(
    () => [
      { id: 'wouldRehire', label: 'دوباره همکاری می‌کرد؟', hint: '۱ = هرگز، ۵ = حتماً' },
      { id: 'performance', label: 'کیفیت کار', hint: '' },
      { id: 'collaboration', label: 'کار تیمی', hint: '' },
      { id: 'reliability', label: 'تعهد و وقت‌شناسی', hint: '' },
    ],
    []
  );

  return (
    <Modal open={Boolean(referee)} onClose={onClose} title={`ثبت پاسخ تلفنی — ${referee?.name || ''}`} size="md">
      <div className="flex flex-col gap-4">
        <Callout tone="info">
          هرچه از زبان مرجع می‌شنوید همین‌جا وارد کنید؛ نام شما روی این پاسخ ثبت می‌شود تا بعداً کسی آن را با پاسخ کتبی مرجع اشتباه نگیرد.
        </Callout>
        {rows.map((row) => (
          <div key={row.id}>
            <p className="text-[13px] font-semibold text-ink-2">
              {row.label} {row.hint && <span className="text-[11px] text-ink-4 font-normal">({row.hint})</span>}
            </p>
            <div className="flex gap-1.5 mt-1.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setScores((s) => ({ ...s, [row.id]: n }))}
                  aria-pressed={scores[row.id] === n}
                  className={`w-9 h-9 rounded-control border text-[12.5px] font-bold transition-colors ${
                    scores[row.id] === n ? 'border-brand bg-brand-soft text-brand-stronger' : 'border-line text-ink-4 hover:border-line-strong'
                  }`}
                >
                  {toPersianDigits(n)}
                </button>
              ))}
            </div>
          </div>
        ))}
        <TextInput label="مدت آشنایی" optional value={duration} onChange={(e) => setDuration(e.target.value)} maxLength={120} placeholder="مثلاً دو سال" />
        <TextArea label="نقاط قوت (به زبان خودش)" optional rows={2} value={strengths} onChange={(e) => setStrengths(e.target.value)} maxLength={1200} />
        <TextArea label="نکتهٔ قابل بررسی" optional rows={2} value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={1200} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button
            loading={busy}
            disabled={scores.wouldRehire === null}
            onClick={async () => {
              setBusy(true);
              try {
                await onSubmit({
                  wouldRehire: scores.wouldRehire ?? undefined,
                  performance: scores.performance ?? undefined,
                  collaboration: scores.collaboration ?? undefined,
                  reliability: scores.reliability ?? undefined,
                  duration: duration.trim() || undefined,
                  strengths: strengths.trim() || undefined,
                  concerns: concerns.trim() || undefined,
                });
              } finally {
                setBusy(false);
              }
            }}
          >
            ثبت پاسخ
          </Button>
        </div>
      </div>
    </Modal>
  );
}

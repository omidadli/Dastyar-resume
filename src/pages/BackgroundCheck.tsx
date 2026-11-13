/**
 * «استعلام سوءپیشینه» — the hiring team's side of a paper process.
 *
 * The page is a sequence, not a form dump, because each step has a precondition:
 *
 *   1. **چرا و از کجا** — the office and the reason. The reason is printed on the
 *      candidate's notice, so it cannot be a placeholder.
 *   2. **رضایت** — the link (the candidate's own click) or a signed form filed by
 *      a named person. Nothing can be requested before this.
 *   3. **درخواست** — the reference number from the office.
 *   4. **نتیجه** — what the certificate says, quoted. Plus the scanned page.
 *   5. **تصمیم** — a human, in writing. No outcome is automatic.
 *
 * Members see the state and are told plainly that the paper is admin-only.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Download,
  FileText,
  KeyRound,
  Lock,
  Mail,
  Send,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, Callout, Card, CardHeader, Chip, Field, Modal, Select, Skeleton, TextArea, TextInput, toast } from '../components/ui';
import { api, ApiError, SESSION_HEADER, getToken } from '../lib/api';
import { faDate, toPersianDigits } from '../lib/format';
import { copyText } from '../lib/clipboard';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import {
  BACKGROUND_STATUS_LABEL,
  BACKGROUND_VERDICT_LABEL,
  CONSENT_METHOD_LABEL,
  DECLINED_NOTE,
  OUTCOME_LABEL,
  type BackgroundCheck as Check,
  type BackgroundOutcome,
  type BackgroundPayload,
  type BackgroundVerdict,
} from '../types/background-check';

const STEPS = ['ساخت', 'رضایت', 'درخواست', 'نتیجه', 'تصمیم'] as const;

function stepIndex(check: Check | null): number {
  if (!check) return 0;
  if (check.decision) return 5;
  if (check.status === 'completed') return 4;
  if (check.status === 'requested') return 3;
  if (check.consent) return 2;
  if (check.status === 'consent_pending') return 1;
  return 1;
}

const VERDICT_TONE: Record<BackgroundVerdict, 'brand' | 'warning' | 'neutral'> = {
  clear: 'brand',
  record_found: 'warning',
  inconclusive: 'neutral',
};

export default function BackgroundCheck({ resumeId }: { resumeId: string }) {
  const q = useAsync<BackgroundPayload>(() => api.background.get(resumeId), [resumeId]);
  const [data, setData] = useState<BackgroundPayload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);

  useEffect(() => {
    if (q.data) setData(q.data);
  }, [q.data]);

  useTitle(data?.check ? `سوءپیشینه · ${data.check.candidateName || 'کارجو'}` : 'استعلام سوءپیشینه');

  const refresh = async () => {
    try {
      setData(await api.background.get(resumeId));
    } catch {
      /* keep what is on screen */
    }
  };

  const act = async (key: string, fn: () => Promise<unknown>, message: string) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
      toast(message);
      return true;
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'انجام این کار ممکن نشد.', 'error');
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (q.error) {
    return (
      <div>
        <PageHeader breadcrumb={[{ label: 'رزومه‌ها', to: '/app/candidates' }]} title="استعلام سوءپیشینه" />
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

  const check = data.check;
  const step = stepIndex(check);
  const canManage = data.canManage;

  return (
    <div className="max-w-[1000px] pb-10">
      <PageHeader
        breadcrumb={[
          { label: 'رزومه‌ها', to: '/app/candidates' },
          { label: check?.candidateName || 'کارجو', to: `/app/candidates/${resumeId}` },
          { label: 'استعلام سوءپیشینه' },
        ]}
        title={`استعلام سوءپیشینه${check?.candidateName ? ` — ${check.candidateName}` : ''}`}
        subtitle={check?.jobTitle ? `برای «${check.jobTitle}»` : undefined}
        actions={
          check && (check.status === 'draft' || check.status === 'consent_pending') && canManage ? (
            <Button variant="ghost" size="sm" loading={busy === 'cancel'} onClick={() => act('cancel', () => api.background.cancel(check.id), 'استعلام لغو شد.')}>
              لغو استعلام
            </Button>
          ) : undefined
        }
      />

      <Callout tone="info" icon={ShieldCheck} title="این پرونده دفتر ثبت دستی است، نه اتصال به مرجع">
        هیچ سامانهٔ استعلام سوءپیشینه‌ای در ایران API عمومی برای هویدا ندارد و این ماژول هم ادعای اتصال نمی‌کند. شما گواهی را از مرجع
        می‌گیرید؛ هویدا رضایت، شمارهٔ نامه، تصویر گواهی و تصمیم انسانی را کنار هم نگه می‌دارد.
      </Callout>

      {!canManage && (
        <Callout tone="warning" icon={Lock} title="نتیجهٔ گواهی فقط برای مدیران نمایش داده می‌شود">
          شما وضعیت این استعلام را می‌بینید؛ متن نتیجه، تصویر گواهی و یادداشت تصمیم در دسترس مدیران فضای کاری است. اگر برای تصمیم‌گیری به
          آن نیاز دارید، از مدیر بخواهید.
        </Callout>
      )}

      {!check ? (
        <Card>
          <CardHeader icon={FileText} title="هنوز استعلامی برای این کارجو ثبت نشده" subtitle="استعلام فقط برای نقش‌هایی که واقعاً لازم است؛ دلیلش روی اطلاعیهٔ کارجو چاپ می‌شود." />
          <ul className="text-[12.5px] text-ink-2 leading-relaxed space-y-1.5 mb-4 pr-4 list-disc">
            {data.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <Button variant="primary" icon={ShieldCheck} onClick={() => setCreateOpen(true)} disabled={!canManage}>
            آغاز استعلام
          </Button>
          {!canManage && <p className="mt-2 text-[11.5px] text-ink-4">آغاز استعلام نیازمند دسترسی مدیر است.</p>}
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader
              icon={ShieldCheck}
              title="مسیر استعلام"
              subtitle={BACKGROUND_STATUS_LABEL[check.status]}
              action={<Chip tone={check.status === 'completed' ? 'brand' : check.status === 'declined' ? 'neutral' : 'outline'}>{BACKGROUND_STATUS_LABEL[check.status]}</Chip>}
            />
            <ol className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-4">
              {STEPS.map((label, i) => {
                const done = i < step;
                const active = i === step;
                return (
                  <li key={label} className="flex items-center gap-1.5">
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${
                        done ? 'bg-brand-strong text-white' : active ? 'bg-brand-soft text-brand-ink border border-brand/30' : 'bg-canvas text-ink-4 border border-line'
                      }`}
                    >
                      {done ? '✓' : toPersianDigits(i + 1)}
                    </span>
                    <span className={`text-[11.5px] ${done || active ? 'text-ink' : 'text-ink-4'}`}>{label}</span>
                  </li>
                );
              })}
            </ol>

            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 text-[12.5px]">
              <div>
                <dt className="text-ink-4">مرجع</dt>
                <dd className="text-ink font-semibold">{check.authority}</dd>
              </div>
              <div>
                <dt className="text-ink-4">شمارهٔ نامه / پیگیری</dt>
                <dd className="text-ink hv-latin" dir="auto">
                  {check.reference || '—'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-ink-4">دلیل (همین متن به کارجو نشان داده شد)</dt>
                <dd className="text-ink-2 leading-relaxed">{check.purpose}</dd>
              </div>
              {check.requestedAtISO && (
                <div>
                  <dt className="text-ink-4">تاریخ درخواست</dt>
                  <dd className="text-ink-2">{check.requestedAtJalali || faDate(check.requestedAtISO)}</dd>
                </div>
              )}
              {check.dueAtISO && (
                <div>
                  <dt className="text-ink-4">مهلت اعلام‌شده</dt>
                  <dd className="text-ink-2">{check.dueAtJalali || faDate(check.dueAtISO)}</dd>
                </div>
              )}
            </dl>
          </Card>

          {/* ------------------------------------------------------- consent */}
          <Card>
            <CardHeader
              icon={KeyRound}
              title="رضایت کارجو"
              subtitle="تا رضایت ثبت نشود، درخواست به مرجع ممکن نیست — و رضایت بی‌نام، رضایت نیست."
              action={
                check.consent ? (
                  <Chip tone="brand" icon={CheckCircle2}>
                    ثبت‌شده
                  </Chip>
                ) : (
                  <Chip tone="warning">در انتظار</Chip>
                )
              }
            />
            {check.consent ? (
              <div className="text-[12.5px] leading-relaxed space-y-1">
                <p className="text-ink">
                  <b>{CONSENT_METHOD_LABEL[check.consent.method]}</b> — {check.consent.atJalali} — به نام «{check.consent.byName}»
                </p>
                {check.consent.note && <p className="text-ink-3">{check.consent.note}</p>}
                <p className="text-[11.5px] text-ink-4">نسخهٔ اطلاعیه‌ای که پذیرفته شد: {check.consent.noticeVersion}</p>
                {!check.consent.selfGiven && (
                  <p className="text-[11.5px] text-ink-4">این رضایت توسط منابع انسانی ثبت شده است، نه با کلیک خود کارجو.</p>
                )}
              </div>
            ) : check.status === 'declined' ? (
              <Callout tone="warning" icon={AlertTriangle} title="کارجو رضایت نداد">
                {DECLINED_NOTE}
                {check.declinedReason && <p className="mt-1.5">دلیل اعلام‌شده: {check.declinedReason}</p>}
              </Callout>
            ) : (
              <div className="space-y-3">
                <p className="text-[12.5px] text-ink-3 leading-relaxed">
                  یکی از دو راه را انتخاب کنید: لینک اختصاصی را برای خود کارجو بفرستید (محکم‌ترین شکل رضایت)، یا فرم امضاشده/حضوری را با نام و
                  تاریخ این‌جا ثبت کنید.
                </p>
                {check.consentUrl && (
                  <div className="flex flex-wrap items-center gap-2">
                    <code dir="ltr" className="text-[11px] font-mono text-ink-3 flex-1 min-w-[220px] truncate bg-canvas border border-line rounded-md px-2 py-1.5">
                      {check.consentUrl}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Copy}
                      onClick={() => copyText(check.consentUrl || '').then((ok) => toast(ok ? 'کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error'))}
                    >
                      کپی
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    icon={Mail}
                    loading={busy === 'link'}
                    disabled={!canManage}
                    onClick={() =>
                      act(
                        'link',
                        async () => {
                          const r = await api.background.sendConsentLink(check.id);
                          if (!r.emailed && r.error) toast(r.error, 'error');
                          return r;
                        },
                        'لینک رضایت ساخته شد.'
                      )
                    }
                  >
                    ارسال لینک رضایت
                  </Button>
                  <Button size="sm" variant="secondary" icon={FileText} disabled={!canManage} onClick={() => setConsentOpen(true)}>
                    ثبت رضایت کتبی
                  </Button>
                </div>
              </div>
            )}
          </Card>

          {/* -------------------------------------------------------- request */}
          <Card>
            <CardHeader
              icon={Send}
              title="درخواست به مرجع"
              subtitle="شمارهٔ نامه یا کد پیگیری مرجع را ثبت کنید؛ بدون آن، این استعلام قابل ردیابی نیست."
              action={check.status === 'requested' ? <Chip tone="brand">ثبت شد</Chip> : check.requestedAtISO ? <Chip tone="neutral">ثبت‌شده</Chip> : undefined}
            />
            <Button
              size="sm"
              variant={check.status === 'requested' ? 'ghost' : 'primary'}
              disabled={!canManage || !check.consent || check.status === 'declined' || check.status === 'completed'}
              onClick={() => setRequestOpen(true)}
            >
              {check.requestedAtISO ? 'ویرایش شمارهٔ نامه' : 'ثبت درخواست'}
            </Button>
            {!check.consent && <p className="mt-2 text-[11.5px] text-ink-4">تا رضایت کارجو ثبت نشود، این دکمه فعال نمی‌شود.</p>}
          </Card>

          {/* --------------------------------------------------------- result */}
          <Card>
            <CardHeader
              icon={FileText}
              title="نتیجهٔ گواهی"
              subtitle="همان چیزی که برگه می‌گوید؛ هویدا آن را تفسیر یا امتیازدهی نمی‌کند."
              action={check.result ? <Chip tone={VERDICT_TONE[check.result.verdict]}>{BACKGROUND_VERDICT_LABEL[check.result.verdict]}</Chip> : undefined}
            />
            {!check.result && check.restricted ? (
              <p className="text-[12.5px] text-ink-3">نتیجه (اگر ثبت شده باشد) فقط برای مدیران نمایش داده می‌شود.</p>
            ) : check.result ? (
              <div className="space-y-2 text-[12.5px] leading-relaxed">
                <p className="text-ink font-semibold">{BACKGROUND_VERDICT_LABEL[check.result.verdict]}</p>
                <p className="text-ink-3">
                  صادرکننده: {check.result.issuedBy || check.authority}
                  {check.result.issuedAtJalali ? ` — تاریخ گواهی: ${check.result.issuedAtJalali}` : ''}
                </p>
                {check.result.note && <p className="text-ink-2">{check.result.note}</p>}
                <p className="text-[11.5px] text-ink-4">
                  ثبت‌شده توسط {check.result.recordedByName} — {check.result.recordedAtJalali}
                </p>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!canManage || check.status !== 'requested'}
                  onClick={() => setResultOpen(true)}
                >
                  ثبت نتیجه
                </Button>
                {check.status !== 'requested' && (
                  <span className="text-[11.5px] text-ink-4">نتیجه پس از ثبت درخواست در مرجع ثبت می‌شود.</span>
                )}
              </div>
            )}

            {canManage && (
              <div className="mt-4 border-t border-line-2 pt-3">
                <p className="text-[12px] font-semibold text-ink-2 mb-2">
                  تصویر گواهی {check.documents.length > 0 && <span className="text-ink-4 font-normal">({toPersianDigits(check.documents.length)} فایل)</span>}
                </p>
                <DocumentUpload check={check} onDone={refresh} />
                <ul className="mt-2 space-y-1.5">
                  {check.documents.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                      <FileText className="w-3.5 h-3.5 text-ink-4" />
                      <span className="text-ink-2">{d.fileName}</span>
                      <span className="text-ink-4">
                        {toPersianDigits(Math.max(1, Math.round(d.size / 1024)))} کیلوبایت — {d.uploadedAtJalali}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Download}
                        onClick={async () => {
                          try {
                            const token = getToken();
                            const res = await fetch(api.background.documentUrl(check.id, d.id), {
                              headers: token ? { [SESSION_HEADER]: token } : {},
                            });
                            if (!res.ok) throw new Error('دانلود ممکن نشد.');
                            const blob = await res.blob();
                            const url = URL.createObjectURL(blob);
                            window.open(url, '_blank', 'noopener');
                          } catch {
                            toast('دانلود فایل ممکن نشد.', 'error');
                          }
                        }}
                      >
                        دیدن
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Trash2}
                        loading={busy === `doc-${d.id}`}
                        onClick={() => act(`doc-${d.id}`, () => api.background.removeDocument(check.id, d.id), 'فایل حذف شد.')}
                      >
                        حذف
                      </Button>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-ink-4">حذف فایل، آن را از فضای ذخیره‌سازی هم پاک می‌کند.</p>
              </div>
            )}
          </Card>

          {/* ------------------------------------------------------- decision */}
          <Card>
            <CardHeader
              icon={CheckCircle2}
              title="تصمیم انسانی"
              subtitle="پس از هر نتیجه — پاک یا سابقه‌دار — یک انسان با دلیل نوشته‌شده تصمیم می‌گیرد. تصمیم خودکار وجود ندارد."
              action={check.decision ? <Chip tone="brand">{OUTCOME_LABEL[check.decision.outcome]}</Chip> : undefined}
            />
            {check.decision ? (
              <div className="text-[12.5px] leading-relaxed space-y-1">
                <p className="text-ink font-semibold">{OUTCOME_LABEL[check.decision.outcome]}</p>
                <p className="text-ink-2">{check.decision.note}</p>
                <p className="text-[11.5px] text-ink-4">
                  {check.decision.byName} — {check.decision.atJalali}
                </p>
              </div>
            ) : (
              <>
                <Button size="sm" variant="secondary" disabled={!canManage || check.status !== 'completed'} onClick={() => setDecisionOpen(true)}>
                  ثبت تصمیم
                </Button>
                {check.status !== 'completed' && <p className="mt-2 text-[11.5px] text-ink-4">تصمیم پس از ثبت نتیجه گرفته می‌شود.</p>}
              </>
            )}
          </Card>

          <Card>
            <CardHeader as="h3" title="قاعده‌های این ماژول" subtitle="همان چیزی که کد تضمین می‌کند، نه شعار." />
            <ul className="text-[12px] text-ink-2 leading-relaxed space-y-1.5 pr-4 list-disc">
              {data.rules.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {/* --------------------------------------------------------- dialogs */}
      {createOpen && (
        <CreateDialog
          onClose={() => setCreateOpen(false)}
          onSubmit={async (values) => {
            const ok = await act('create', () => api.background.create(resumeId, values), 'استعلام آغاز شد؛ قدم بعد، گرفتن رضایت است.');
            if (ok) setCreateOpen(false);
          }}
          busy={busy === 'create'}
          noticeHint={data.notice}
        />
      )}

      {check && consentOpen && (
        <ConsentDialog
          onClose={() => setConsentOpen(false)}
          busy={busy === 'consent-hr'}
          onSubmit={async (method, note) => {
            const ok = await act('consent-hr', () => api.background.recordConsent(check.id, { method, note }), 'رضایت ثبت شد.');
            if (ok) setConsentOpen(false);
          }}
        />
      )}

      {check && requestOpen && (
        <RequestDialog
          onClose={() => setRequestOpen(false)}
          busy={busy === 'request'}
          initial={{ reference: check.reference, requestedAtISO: check.requestedAtISO, dueAtISO: check.dueAtISO }}
          onSubmit={async (values) => {
            const ok = await act('request', () => api.background.request(check.id, values), 'درخواست ثبت شد.');
            if (ok) setRequestOpen(false);
          }}
        />
      )}

      {check && resultOpen && (
        <ResultDialog
          onClose={() => setResultOpen(false)}
          busy={busy === 'result'}
          authority={check.authority}
          onSubmit={async (values) => {
            const ok = await act('result', () => api.background.result(check.id, values), 'نتیجه ثبت شد.');
            if (ok) setResultOpen(false);
          }}
        />
      )}

      {check && decisionOpen && (
        <DecisionDialog
          onClose={() => setDecisionOpen(false)}
          busy={busy === 'decision'}
          verdict={check.result?.verdict || 'inconclusive'}
          onSubmit={async (values) => {
            const ok = await act('decision', () => api.background.decide(check.id, values), 'تصمیم ثبت شد.');
            if (ok) setDecisionOpen(false);
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- dialogs ----

function CreateDialog({
  onClose,
  onSubmit,
  busy,
  noticeHint,
}: {
  onClose: () => void;
  onSubmit: (values: { authority: string; purpose: string; reference: string }) => void;
  busy: boolean;
  noticeHint: string;
}) {
  const [authority, setAuthority] = useState('');
  const [purpose, setPurpose] = useState('');
  const [reference, setReference] = useState('');
  const [preview, setPreview] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      title="آغاز استعلام سوءپیشینه"
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit({ authority: authority.trim(), purpose: purpose.trim(), reference: reference.trim() })}>
            ساخت پرونده
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout tone="info" icon={ShieldCheck}>
          این کار هیچ درخواستی به جایی نمی‌فرستد. فقط پرونده و اطلاعیهٔ کارجو ساخته می‌شود؛ ارسال و درخواست، قدم‌های بعدی و با رضایت او هستند.
        </Callout>
        <TextInput
          label="مرجع صادرکنندهٔ گواهی"
          required
          value={authority}
          onChange={(e) => setAuthority(e.target.value)}
          placeholder="ادارهٔ تشخیص هویت / مرجع معرفی‌شده در قرارداد"
          hint="در واژه‌های خودتان؛ هیچ فهرستی از طرف هویدا نمی‌آید."
        />
        <TextArea
          label="دلیل این استعلام برای این نقش"
          required
          rows={3}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="مثلاً: این نقش دسترسی به وجوه نقد و امضای اسناد مالی دارد؛ سیاست سازمان برای چنین نقش‌هایی این استعلام را لازم می‌داند."
          hint="همین جمله روی اطلاعیهٔ کارجو چاپ می‌شود — کوتاه و واقعی بنویسید."
        />
        <TextInput
          label="شمارهٔ نامه / پیگیری (اگر از قبل دارید)"
          optional
          latin
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <button type="button" className="text-[12px] text-brand-ink underline" onClick={() => setPreview((v) => !v)}>
          {preview ? 'بستن پیش‌نمایش اطلاعیه' : 'دیدن اطلاعیه‌ای که کارجو می‌خواند'}
        </button>
        {preview && (
          <pre className="whitespace-pre-wrap text-[11.5px] leading-relaxed text-ink-2 bg-canvas border border-line rounded-lg p-3 max-h-64 overflow-auto">
            {noticeHint
              .replace('برای این نقش ضروری تشخیص داده شده است.', purpose.trim() || 'برای این نقش ضروری تشخیص داده شده است.')
              .replace('«مرجع مربوط»', authority.trim() ? `«${authority.trim()}»` : '«مرجع مربوط»')}
          </pre>
        )}
      </div>
    </Modal>
  );
}

function ConsentDialog({
  onClose,
  onSubmit,
  busy,
}: {
  onClose: () => void;
  onSubmit: (method: 'signed_form' | 'in_person', note: string) => void;
  busy: boolean;
}) {
  const [method, setMethod] = useState<'signed_form' | 'in_person'>('signed_form');
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="ثبت رضایت کتبی"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onSubmit(method, note.trim())}>
            ثبت رضایت
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout tone="warning" icon={AlertTriangle}>
          فقط وقتی این را ثبت کنید که برگهٔ امضاشده را دیده‌اید. رضایت شفاهی یا فرضی، رضایت نیست و در این پرونده جایی ندارد.
        </Callout>
        <Select
          label="شکل رضایت"
          value={method}
          onChange={(e) => setMethod(e.target.value as 'signed_form' | 'in_person')}
          options={[
            { value: 'signed_form', label: 'فرم امضاشده (کاغذی یا اسکن)' },
            { value: 'in_person', label: 'حضوری، با شاهد' },
          ]}
        />
        <TextArea
          label="شرح"
          required
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="تاریخ فرم، شمارهٔ نامه یا نام شاهد — مثلاً «فرم ۱۴۰۵/۰۸/۱۲، بایگانی شمارهٔ ۴۱۲»."
        />
      </div>
    </Modal>
  );
}

function RequestDialog({
  onClose,
  onSubmit,
  busy,
  initial,
}: {
  onClose: () => void;
  onSubmit: (values: { reference: string; requestedAtISO: string | null; dueAtISO: string | null }) => void;
  busy: boolean;
  initial: { reference: string; requestedAtISO: string | null; dueAtISO: string | null };
}) {
  const [reference, setReference] = useState(initial.reference);
  const [requestedAt, setRequestedAt] = useState(initial.requestedAtISO ? initial.requestedAtISO.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const [dueAt, setDueAt] = useState(initial.dueAtISO ? initial.dueAtISO.slice(0, 10) : '');
  return (
    <Modal
      open
      onClose={onClose}
      title="ثبت درخواست در مرجع"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              onSubmit({
                reference: reference.trim(),
                requestedAtISO: requestedAt ? new Date(`${requestedAt}T09:00:00Z`).toISOString() : null,
                dueAtISO: dueAt ? new Date(`${dueAt}T09:00:00Z`).toISOString() : null,
              })
            }
          >
            ثبت
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextInput label="شمارهٔ نامه یا کد پیگیری" required value={reference} onChange={(e) => setReference(e.target.value)} latin />
        <Field label="تاریخ درخواست (میلادی؛ تاریخ شمسی در پرونده نمایش داده می‌شود)" hint="اگر امروز است، خالی نگذارید — همین تاریخ در پرونده می‌ماند.">
          <TextInput type="date" latin value={requestedAt} onChange={(e) => setRequestedAt(e.target.value)} />
        </Field>
        <Field label="مهلت اعلام‌شده (اختیاری)">
          <TextInput type="date" latin value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function ResultDialog({
  onClose,
  onSubmit,
  busy,
  authority,
}: {
  onClose: () => void;
  onSubmit: (values: { verdict: BackgroundVerdict; issuedAtISO: string | null; issuedBy: string; note: string }) => void;
  busy: boolean;
  authority: string;
}) {
  const [verdict, setVerdict] = useState<BackgroundVerdict>('clear');
  const [issuedAt, setIssuedAt] = useState('');
  const [issuedBy, setIssuedBy] = useState(authority);
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="ثبت نتیجهٔ گواهی"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() =>
              onSubmit({
                verdict,
                issuedAtISO: issuedAt ? new Date(`${issuedAt}T09:00:00Z`).toISOString() : null,
                issuedBy: issuedBy.trim(),
                note: note.trim(),
              })
            }
          >
            ثبت نتیجه
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout tone="info">
          نتیجه را همان‌طور که برگه می‌گوید ثبت کنید. این عدد وارد امتیاز یا مرحلهٔ کارجو نمی‌شود؛ تصمیم بعدی با انسان است.
        </Callout>
        <Select
          label="آنچه گواهی اعلام می‌کند"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value as BackgroundVerdict)}
          options={[
            { value: 'clear', label: 'پاک — سابقه‌ای اعلام نشده' },
            { value: 'record_found', label: 'سابقه اعلام شده' },
            { value: 'inconclusive', label: 'نیازمند بررسی — پاسخ روشن نبود' },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="تاریخ گواهی">
            <TextInput type="date" latin value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
          </Field>
          <TextInput label="صادرکننده" optional value={issuedBy} onChange={(e) => setIssuedBy(e.target.value)} />
        </div>
        <TextArea
          label="یادداشت (اختیاری)"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="مثلاً: گواهی با مهر برجسته، تاریخ ۱۴۰۵/۰۸/۲۰، تحویل حضوری."
        />
      </div>
    </Modal>
  );
}

function DecisionDialog({
  onClose,
  onSubmit,
  busy,
  verdict,
}: {
  onClose: () => void;
  onSubmit: (values: { outcome: BackgroundOutcome; note: string }) => void;
  busy: boolean;
  verdict: BackgroundVerdict;
}) {
  const [outcome, setOutcome] = useState<BackgroundOutcome>(verdict === 'clear' ? 'proceed' : 'hold');
  const [note, setNote] = useState('');
  const tooShort = note.trim().length < 10;
  return (
    <Modal
      open
      onClose={onClose}
      title="تصمیم پس از نتیجه"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button variant="primary" loading={busy} disabled={tooShort} onClick={() => onSubmit({ outcome, note: note.trim() })}>
            ثبت تصمیم
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Callout tone={verdict === 'clear' ? 'info' : 'warning'} icon={AlertTriangle}>
          {verdict === 'clear'
            ? 'نتیجه پاک است؛ تصمیم را ثبت کنید تا پرونده کامل شود.'
            : 'سابقه اعلام‌شده یا نتیجهٔ نامشخص، به‌خودی‌خود «رد» نیست. تصمیم باید با نقش، قوانین و سیاست سازمان سنجیده شود و دلیل مکتوب داشته باشد.'}
        </Callout>
        <Select
          label="تصمیم"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as BackgroundOutcome)}
          options={[
            { value: 'proceed', label: OUTCOME_LABEL.proceed },
            { value: 'hold', label: OUTCOME_LABEL.hold },
            { value: 'withdraw', label: OUTCOME_LABEL.withdraw },
          ]}
        />
        <TextArea
          label="دلیل (حداقل ۱۰ نویسه)"
          required
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="چه چیزی را دیدید و چرا این تصمیم را گرفتید…"
          error={note.length > 0 && tooShort ? 'دلیل کوتاه است؛ پرونده به یک جملهٔ روشن نیاز دارد.' : null}
        />
      </div>
    </Modal>
  );
}

function DocumentUpload({ check, onDone }: { check: Check; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('read failed'));
        reader.readAsDataURL(file);
      });
      await api.background.upload(check.id, { fileName: file.name, fileBase64: base64 });
      toast('تصویر گواهی بارگذاری شد.');
      onDone();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'بارگذاری ممکن نشد.', 'error');
    } finally {
      setBusy(false);
      if (ref.current) ref.current.value = '';
    }
  };
  return (
    <div>
      <input
        ref={ref}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.webp"
        className="hidden"
        onChange={(e) => pick(e.target.files?.[0] || null)}
      />
      <Button size="sm" variant="ghost" icon={Upload} loading={busy} onClick={() => ref.current?.click()} disabled={check.status === 'draft'}>
        بارگذاری تصویر یا PDF
      </Button>
      <span className="text-[11px] text-ink-4 mr-2">حداکثر ۸ مگابایت، تا ۵ فایل.</span>
    </div>
  );
}

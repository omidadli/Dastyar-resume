/**
 * «تنظیمات ← انطباق و شواهد»
 *
 * The screen is built to be believed, not to impress:
 *   • every control shows **why** it holds the state it holds, with the numbers
 *     that produced it;
 *   • a product control is never marked green by hand — its state is recomputed
 *     from the workspace on every load;
 *   • a customer control stays «سند ارسال نشده» until a file or a signed
 *     statement is actually there;
 *   • the pack is issued with a SHA-256 printed on its cover, and the screen says
 *     in the first sentence that it is evidence, not a certificate.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Download,
  FileCheck2,
  FileText,
  Lock,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, Modal, Segmented, Skeleton, TextArea, toast } from '../../components/ui';
import { api, ApiError, SESSION_HEADER, getToken } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import { navigate } from '../../lib/router';
import type { AccessReview, ComplianceControl, CompliancePayload, ControlState, Framework, IssuedPack } from '../../types/compliance';
import { FRAMEWORK_LABEL, STATE_LABEL } from '../../types/compliance';

const STATE_TONE: Record<ControlState, 'brand' | 'warning' | 'danger' | 'neutral'> = {
  met: 'brand',
  partial: 'warning',
  gap: 'danger',
  missing_evidence: 'neutral',
};

const STATE_ICON: Record<ControlState, typeof CheckCircle2> = {
  met: CheckCircle2,
  partial: AlertTriangle,
  gap: AlertTriangle,
  missing_evidence: FileText,
};

/** Authenticated download: the pack endpoints need the session header. */
async function downloadWithAuth(url: string, fileName: string) {
  const token = getToken();
  const res = await fetch(url, { headers: token ? { [SESSION_HEADER]: token } : {} });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as any)?.error || 'دانلود ممکن نشد.', res.status, data);
  }
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="h-2 rounded-full bg-line-2 overflow-hidden" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100}>
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.max(2, Math.min(100, score))}%`, background: score >= 80 ? 'var(--hv-brand)' : score >= 50 ? '#D97706' : '#DC2626' }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ header ----

function HeaderCard({
  data,
  framework,
  onFramework,
  onIssue,
}: {
  data: CompliancePayload;
  framework: Framework;
  onFramework: (f: Framework) => void;
  onIssue: () => void;
}) {
  const s = data.summary;
  const readiness =
    s.readiness === 'ready' ? 'آمادهٔ ارائه به حسابرس' : s.readiness === 'nearly' ? 'در حال تکمیل' : 'نقطهٔ شروع';
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-[17px] font-extrabold text-ink">بستهٔ شواهد انطباق</h2>
          <p className="text-[12.5px] text-ink-3 mt-1 leading-relaxed max-w-[62ch]">
            هر کنترل از وضعیت واقعی همین فضا سنجیده می‌شود؛ اسنادی که فقط سازمان می‌تواند بدهد، تا بارگذاری‌نشدن «ارسال‌نشده» می‌مانند.
          </p>
        </div>
        <Segmented<Framework>
          value={framework}
          onChange={onFramework}
          items={[
            { id: 'iso27001', label: 'ISO 27001' },
            { id: 'soc2', label: 'SOC 2' },
          ]}
          size="sm"
        />
      </div>

      <div className="rounded-control border border-line-2 bg-canvas p-3.5">
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <p className="text-[11.5px] text-ink-3">آمادگی وزنی — {FRAMEWORK_LABEL[framework]}</p>
            <p className="text-[24px] font-extrabold text-ink leading-none mt-1">
              {toPersianDigits(s.score)}٪ <span className="text-[12px] font-semibold text-ink-3">· {readiness}</span>
            </p>
          </div>
          <p className="text-[11px] text-ink-4">{s.lastMeasuredJalali} ، {toPersianDigits(s.total)} کنترل</p>
        </div>
        <ScoreBar score={s.score} />
        <div className="flex flex-wrap items-center gap-1.5 mt-3">
          {(['met', 'partial', 'gap', 'missing_evidence'] as ControlState[]).map((st) => (
            <Chip key={st} tone={STATE_TONE[st]} icon={STATE_ICON[st]}>
              {STATE_LABEL[st]} {toPersianDigits(s.counts[st])}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        <Button variant="primary" icon={ShieldCheck} onClick={onIssue}>
          صدور بستهٔ شواهد
        </Button>
        <span className="text-[11.5px] text-ink-4">
          {data.packs.length ? `آخرین بسته: ${data.packs[0].issuedAtJalali}` : 'هنوز بسته‌ای صادر نشده'}
        </span>
      </div>

      <Callout tone="warning" className="mt-4">
        این بسته <strong>شاهد</strong> است، نه گواهی: {s.limits[0]}
      </Callout>

      {s.gaps.length > 0 && (
        <details className="mt-3">
          <summary className="text-[12.5px] font-semibold text-ink-2 cursor-pointer select-none">
            {toPersianDigits(s.gaps.length)} جای خالی/سند ارسال‌نشده — اول این‌ها را ببینید
          </summary>
          <ul className="mt-2 space-y-1.5">
            {s.gaps.map((g) => (
              <li key={g.id} className="text-[12px] text-ink-2 leading-relaxed">
                <span className="font-semibold text-ink">{g.id} — {g.title}:</span> {g.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

// ----------------------------------------------------------- access review ----

const ROLE_LABEL: Record<string, string> = { owner: 'مالک', admin: 'مدیر', member: 'عضو' };
const FLAG_LABEL: Record<string, string> = { admin: 'دسترسی مدیریتی', no_2fa: 'بدون ورود دومرحله‌ای', inactive: 'بدون ورود ۹۰ روز' };

function ReviewCard({ data, onChanged }: { data: CompliancePayload; onChanged: () => void }) {
  const open = data.reviews.find((r) => r.status === 'open') || null;
  const last = data.reviews.find((r) => r.status === 'completed') || null;
  const [busy, setBusy] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [note, setNote] = useState('');
  const [completing, setCompleting] = useState(false);
  const [closingNote, setClosingNote] = useState('');

  const confirm = async (userId: string, confirmed: boolean) => {
    if (!open) return;
    setBusy(userId);
    try {
      await api.compliance.confirmMember(open.id, { userId, confirmed });
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const start = async () => {
    setBusy('start');
    try {
      await api.compliance.startReview({ framework: data.summary.framework, note });
      setStarting(false);
      setNote('');
      toast('بازنگری آغاز شد؛ فهرست همین حالا منجمد شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'آغاز بازنگری ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const complete = async () => {
    if (!open) return;
    setBusy('complete');
    try {
      await api.compliance.completeReview(open.id, closingNote);
      setCompleting(false);
      setClosingNote('');
      toast('بازنگری بسته شد و در بستهٔ شواهد می‌آید.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'بستن بازنگری ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div id="review">
    <Card className="mb-4">
      <CardHeader
        icon={ClipboardCheck}
        title="بازنگری دسترسی"
        subtitle="فهرست اعضا در لحظهٔ شروع منجمد می‌شود؛ تصمیم هر عضو با نام و تاریخ می‌ماند."
        action={
          !open ? (
            <Button size="sm" variant="secondary" onClick={() => setStarting(true)}>
              شروع بازنگری
            </Button>
          ) : undefined
        }
      />

      {open ? (
        <>
          <p className="text-[12px] text-ink-3 mb-3">
            آغاز: {open.startedAtJalali} توسط {open.startedByName} — {toPersianDigits(open.members.filter((m) => m.confirmed).length)} از{' '}
            {toPersianDigits(open.members.length)} تأیید شده
          </p>
          <div className="overflow-x-auto hv-scroll -mx-1">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="text-ink-3 text-right">
                  <th className="font-semibold p-2">نام</th>
                  <th className="font-semibold p-2">نقش</th>
                  <th className="font-semibold p-2">۲FA</th>
                  <th className="font-semibold p-2">آخرین ورود</th>
                  <th className="font-semibold p-2">تأیید</th>
                </tr>
              </thead>
              <tbody>
                {open.members.map((m) => (
                  <tr key={m.userId} className="border-t border-line-2">
                    <td className="p-2">
                      <p className="font-semibold text-ink">{m.name}</p>
                      <p className="text-[11px] text-ink-4">{m.email}</p>
                      {m.flag && <p className="text-[11px] text-warning-ink mt-0.5">{FLAG_LABEL[m.flag]}</p>}
                    </td>
                    <td className="p-2 text-ink-2">{ROLE_LABEL[m.role] || m.role}</td>
                    <td className="p-2">{m.twoFactor ? <Chip tone="brand">فعال</Chip> : <Chip tone="neutral">خاموش</Chip>}</td>
                    <td className="p-2 text-ink-3">{m.lastLoginISO ? m.lastLoginISO.slice(0, 10) : '—'}</td>
                    <td className="p-2">
                      {m.confirmed ? (
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 text-brand-strong" />
                          <button className="text-[11.5px] text-ink-3 underline" onClick={() => confirm(m.userId, false)} disabled={busy === m.userId}>
                            لغو
                          </button>
                        </div>
                      ) : (
                        <Button size="sm" variant="ghost" loading={busy === m.userId} onClick={() => confirm(m.userId, true)}>
                          تأیید دسترسی
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <Button size="sm" variant="primary" onClick={() => setCompleting(true)} disabled={open.members.some((m) => !m.confirmed)}>
              بستن بازنگری
            </Button>
            {open.members.some((m) => !m.confirmed) && (
              <span className="text-[11.5px] text-ink-4">تا تأیید همهٔ اعضا، بستن ممکن نیست.</span>
            )}
          </div>
        </>
      ) : last ? (
        <div className="text-[12.5px] text-ink-2 leading-relaxed">
          <p>
            آخرین بازنگری: <span className="font-semibold text-ink">{last.completedAtJalali}</span> توسط {last.completedByName} — {last.summary}
          </p>
          <p className="text-[11.5px] text-ink-4 mt-1 whitespace-pre-line">{last.note}</p>
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3 leading-relaxed">
          هیچ بازنگری دسترسی ثبت نشده است. حسابرس معمولاً فهرست اعضا با نقش، وضعیت ۲FA و امضای بازبین می‌خواهد — همین کار، همین‌جا.
        </p>
      )}

      <Modal
        open={starting}
        onClose={() => setStarting(false)}
        title="شروع بازنگری دسترسی"
        description="فهرست فعلی اعضا با نقش و وضعیت ورود دومرحله‌ای منجمد می‌شود. برای هر عضو باید تصمیم بگیرید."
        footer={
          <>
            <Button variant="ghost" onClick={() => setStarting(false)}>انصراف</Button>
            <Button variant="primary" loading={busy === 'start'} onClick={start}>شروع</Button>
          </>
        }
      >
        <TextArea label="یادداشت آغاز (اختیاری)" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: بازنگری پایان فصل، پیش از حسابرسی ۱۴۰۵" />
      </Modal>

      <Modal
        open={completing}
        onClose={() => setCompleting(false)}
        title="بستن بازنگری دسترسی"
        description="این تصمیم با نام شما و تاریخ در بستهٔ شواهد می‌آید."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCompleting(false)}>انصراف</Button>
            <Button variant="primary" loading={busy === 'complete'} onClick={complete} disabled={closingNote.trim().length < 10}>
              ثبت و بستن
            </Button>
          </>
        }
      >
        <TextArea
          label="چه تصمیمی گرفته شد؟ (حداقل ۱۰ نویسه)"
          rows={3}
          required
          value={closingNote}
          onChange={(e) => setClosingNote(e.target.value)}
          placeholder="مثلاً: همهٔ دسترسی‌ها لازم است؛ دو حساب غیرفعال حذف شد."
        />
      </Modal>
    </Card>
    </div>
  );
}

// -------------------------------------------------------------- a control ----

function ControlRow({ control, onChanged }: { control: ComplianceControl; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [declaring, setDeclaring] = useState(false);
  const [text, setText] = useState(control.declaration?.text || '');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const Icon = STATE_ICON[control.state];

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const fileBase64 = await fileToBase64(file);
      await api.compliance.uploadEvidence(control.id, { fileName: file.name, fileBase64 });
      toast('شاهد بارگذاری شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'بارگذاری ممکن نشد.', 'error');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const declare = async () => {
    setBusy(true);
    try {
      await api.compliance.declare(control.id, text);
      setDeclaring(false);
      toast('اعلام کتبی ثبت شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ثبت اعلام ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeDeclaration = async () => {
    setBusy(true);
    try {
      await api.compliance.clearDeclaration(control.id);
      toast('اعلام حذف شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'حذف ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openAttachment = async (id: string) => {
    try {
      const token = getToken();
      const res = await fetch(api.compliance.evidenceUrl(id), { headers: token ? { [SESSION_HEADER]: token } : {} });
      if (!res.ok) throw new Error('open failed');
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      window.open(href, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
    } catch {
      toast('باز کردن سند ممکن نشد.', 'error');
    }
  };

  const removeAttachment = async (id: string) => {
    setBusy(true);
    try {
      await api.compliance.deleteEvidence(control.id, id);
      toast('سند حذف شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'حذف ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-line-2 rounded-control bg-surface">
      <button type="button" onClick={() => setOpen((v) => !v)} className="w-full flex items-start gap-2.5 p-3 text-right" aria-expanded={open}>
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${control.state === 'met' ? 'text-brand-strong' : control.state === 'partial' ? 'text-warning-ink' : 'text-ink-4'}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-bold text-ink">{control.id}</span>
            <span className="text-[13px] font-semibold text-ink">{control.title}</span>
            <Chip tone={STATE_TONE[control.state]}>
              {STATE_LABEL[control.state]}
            </Chip>
            {control.source === 'customer' && (
              <Chip tone="neutral" icon={FileText}>
                سند سازمان
              </Chip>
            )}
          </span>
          <span className="block text-[11.5px] text-ink-3 mt-1 leading-relaxed">{control.reason}</span>
        </span>
        <ChevronDown className={`w-4 h-4 mt-1 shrink-0 text-ink-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3.5 pt-0 space-y-3">
          <div className="grid gap-2 text-[12px] leading-relaxed">
            <p className="text-ink-2">
              <span className="font-semibold text-ink">مرجع: </span>
              {control.refs.join(' · ')}
            </p>
            <p className="text-ink-2">
              <span className="font-semibold text-ink">حسابرس چه می‌خواهد: </span>
              {control.requirement}
            </p>
            <p className="text-ink-2">
              <span className="font-semibold text-ink">این محصول چه می‌کند: </span>
              {control.howWeHelp}
            </p>
          </div>

          {control.evidence.length > 0 && (
            <div className="rounded-control border border-line-2 bg-canvas p-2.5">
              <p className="text-[11px] font-semibold text-ink-3 mb-1.5">شاهد اندازه‌گیری‌شده</p>
              <ul className="space-y-1">
                {control.evidence.map((e, i) => (
                  <li key={i} className="text-[11.5px] text-ink-2 leading-relaxed">
                    <span className="text-ink-3">{e.label}: </span>
                    <span className="whitespace-pre-line">{e.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {control.attachments.length > 0 && (
            <ul className="space-y-1.5">
              {control.attachments.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-2">
                  <FileCheck2 className="w-3.5 h-3.5 text-brand-strong" />
                  <button className="underline font-semibold" onClick={() => openAttachment(a.id)}>
                    {a.fileName}
                  </button>
                  <span className="text-ink-4">
                    {a.uploadedAtJalali} ، {a.uploadedByName} ، {toPersianDigits(a.bytes.toLocaleString('fa-IR'))} بایت ، SHA-256 {a.sha256.slice(0, 10)}…
                  </span>
                  <button className="text-danger-ink hover:underline" onClick={() => removeAttachment(a.id)} disabled={busy} aria-label="حذف سند">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {control.declaration && (
            <div className="rounded-control border border-line-2 bg-canvas p-2.5">
              <p className="text-[11px] font-semibold text-ink-3 mb-1">اعلام کتبی</p>
              <p className="text-[11.5px] text-ink-2 leading-relaxed whitespace-pre-line">{control.declaration.text}</p>
              <p className="text-[11px] text-ink-4 mt-1">
                {control.declaration.byName} — {control.declaration.atJalali}
                {control.stale && ' · بیش از یک سال قدمت دارد'}
              </p>
            </div>
          )}

          {control.customerAction && <Callout tone="info">{control.customerAction}</Callout>}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.md,.csv,.docx,.xlsx"
              onChange={(e) => upload(e.target.files?.[0] || null)}
            />
            <Button size="sm" variant="secondary" icon={Upload} loading={busy} onClick={() => fileRef.current?.click()}>
              بارگذاری سند
            </Button>
            <Button size="sm" variant="ghost" icon={FileText} onClick={() => setDeclaring(true)}>
              {control.declaration ? 'ویرایش اعلام کتبی' : 'اعلام کتبی'}
            </Button>
            {control.declaration && (
              <Button size="sm" variant="ghost" icon={Trash2} loading={busy} onClick={removeDeclaration}>
                حذف اعلام
              </Button>
            )}
            {control.action && (
              <Button size="sm" variant="ghost" onClick={() => navigate(control.action!.to)}>
                {control.action.label}
              </Button>
            )}
          </div>
        </div>
      )}

      <Modal
        open={declaring}
        onClose={() => setDeclaring(false)}
        title={`اعلام کتبی — ${control.id}`}
        description="این متن با نام و تاریخ شما در بستهٔ شواهد چاپ می‌شود؛ بگویید چه چیزی، کجا و توسط چه کسی تصویب شده است."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeclaring(false)}>انصراف</Button>
            <Button variant="primary" loading={busy} onClick={declare} disabled={text.trim().length < 20}>
              ثبت اعلام
            </Button>
          </>
        }
      >
        <TextArea
          label="متن اعلام (حداقل ۲۰ نویسه)"
          rows={4}
          required
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="مثلاً: خط‌مشی امنیت اطلاعات در جلسهٔ ۱۴۰۵/۰۷/۱۲ هیئت‌مدیره تصویب و به همهٔ کارکنان ابلاغ شد."
        />
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------ issued packs ----

function PacksCard({ packs, onChanged }: { packs: IssuedPack[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (pack: IssuedPack, format: 'md' | 'json' | 'zip') => {
    setBusy(`${pack.id}:${format}`);
    try {
      await downloadWithAuth(api.compliance.packUrl(pack.id, format), `hovida-evidence-${pack.id}.${format}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'دانلود ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (pack: IssuedPack) => {
    setBusy(pack.id);
    try {
      await api.compliance.deletePack(pack.id);
      toast('بسته حذف شد.');
      onChanged();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'حذف ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  if (!packs.length) {
    return (
      <Card className="mb-4">
        <CardHeader icon={ShieldCheck} title="بسته‌های صادرشده" subtitle="هر بسته با هش خودش منجمد می‌شود؛ بعداً هم همان فایل قابل ارائه است." />
        <p className="text-[12.5px] text-ink-3">هنوز بسته‌ای صادر نشده است.</p>
      </Card>
    );
  }

  return (
    <Card className="mb-4">
      <CardHeader icon={ShieldCheck} title="بسته‌های صادرشده" subtitle="هر بسته با هش خودش منجمد می‌شود؛ بعداً هم همان فایل قابل ارائه است." />
      <ul className="space-y-2">
        {packs.map((p) => (
          <li key={p.id} className="rounded-control border border-line-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[12.5px] font-bold text-ink">
                  {FRAMEWORK_LABEL[p.framework]} — {p.issuedAtJalali}
                </p>
                <p className="text-[11px] text-ink-4 mt-0.5">
                  {p.issuedByName} · {p.counts.met} پوشش‌داده‌شده · {p.counts.gap} جای خالی · {p.counts.missing_evidence} سند ارسال‌نشده ·{' '}
                  {toPersianDigits(p.attachments)} پیوست
                </p>
                <p className="text-[10.5px] text-ink-4 font-mono mt-1 break-all">SHA-256 {p.sha256}</p>
                {p.scopeNote && <p className="text-[11.5px] text-ink-2 mt-1">دامنه: {p.scopeNote}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="secondary" icon={Download} loading={busy === `${p.id}:zip`} onClick={() => download(p, 'zip')}>
                  ZIP
                </Button>
                <Button size="sm" variant="ghost" loading={busy === `${p.id}:md`} onClick={() => download(p, 'md')}>
                  گزارش
                </Button>
                <Button size="sm" variant="ghost" loading={busy === `${p.id}:json`} onClick={() => download(p, 'json')}>
                  JSON
                </Button>
                <button className="text-danger-ink hover:underline p-1" onClick={() => remove(p)} disabled={busy === p.id} aria-label="حذف بسته">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ------------------------------------------------------------------- page ----

export default function ComplianceTab() {
  const [framework, setFramework] = useState<Framework>('iso27001');
  const [data, setData] = useState<CompliancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    api.compliance
      .load(framework)
      .then((d) => setData(d))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'بارگذاری ممکن نشد.'))
      .finally(() => setLoading(false));
  }, [framework]);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const out = new Map<string, ComplianceControl[]>();
    for (const c of data?.controls || []) {
      const list = out.get(c.group) || [];
      list.push(c);
      out.set(c.group, list);
    }
    return Array.from(out.entries());
  }, [data]);

  const issue = async () => {
    setBusy(true);
    try {
      const r = await api.compliance.issuePack({ framework, scopeNote: scope });
      setIssuing(false);
      setScope('');
      toast(`بسته صادر شد — هش ${r.pack.sha256.slice(0, 12)}…`);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'صدور بسته ممکن نشد.', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (error && !data) {
    return (
      <Card>
        <CardHeader icon={Lock} title="دسترسی به بستهٔ شواهد" subtitle={error} />
        <p className="text-[12.5px] text-ink-3">این بخش فهرست اعضا و وضعیت دسترسی را نشان می‌دهد و فقط برای مالک یا مدیر فضای کاری باز است.</p>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <div>
      <HeaderCard data={data} framework={framework} onFramework={setFramework} onIssue={() => setIssuing(true)} />
      <ReviewCard data={data} onChanged={load} />

      <Card className="mb-4">
        <CardHeader
          icon={ShieldCheck}
          title="کنترل‌ها"
          subtitle="روی هر کنترل بزنید: خواستهٔ حسابرس، شاهد اندازه‌گیری‌شده و جای بارگذاری سند."
        />
        <div className="space-y-4">
          {groups.map(([group, items]) => (
            <div key={group}>
              <p className="text-[11.5px] font-bold text-ink-3 mb-2">{group}</p>
              <div className="space-y-2">
                {items.map((c) => (
                  <ControlRow key={c.id} control={c} onChanged={load} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <PacksCard packs={data.packs} onChanged={load} />

      <Card>
        <CardHeader icon={AlertTriangle} title="آنچه این بسته نمی‌گوید" subtitle="خواندنش پیش از فرستادن به حسابرس، وقت شما را نجات می‌دهد." />
        <ul className="space-y-1.5">
          {data.summary.limits.map((l, i) => (
            <li key={i} className="text-[12px] text-ink-2 leading-relaxed">• {l}</li>
          ))}
        </ul>
      </Card>

      <Modal
        open={issuing}
        onClose={() => setIssuing(false)}
        title="صدور بستهٔ شواهد"
        description="وضعیت همین لحظه منجمد می‌شود؛ تغییرهای بعدی در بسته‌های بعدی می‌آید."
        footer={
          <>
            <Button variant="ghost" onClick={() => setIssuing(false)}>انصراف</Button>
            <Button variant="primary" loading={busy} onClick={issue}>
              صدور
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="rounded-control border border-line-2 bg-canvas p-3 text-[12px] text-ink-2 leading-relaxed">
            <p className="font-semibold text-ink mb-1">{FRAMEWORK_LABEL[framework]}</p>
            <p>
              {toPersianDigits(data.summary.counts.met)} پوشش‌داده‌شده ، {toPersianDigits(data.summary.counts.partial)} پوشش جزئی ،{' '}
              {toPersianDigits(data.summary.counts.gap)} جای خالی ، {toPersianDigits(data.summary.counts.missing_evidence)} سند ارسال‌نشده
            </p>
            <p className="text-[11.5px] text-ink-4 mt-1">جای خالی مانع صدور نیست؛ در بسته صادقانه نوشته می‌شود.</p>
          </div>
          <TextArea
            label="دامنه (اختیاری، در جلد بسته چاپ می‌شود)"
            rows={2}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="مثلاً: فرایند جذب و استخدام — دفتر تهران، مهر ۱۴۰۵"
          />
        </div>
      </Modal>
    </div>
  );
}

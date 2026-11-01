import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ClipboardList, Copy, ExternalLink, Mail, Send, Trash2 } from 'lucide-react';
import type { ResumeListItem } from '../../types/screening';
import type { AssessmentInvite, AssessmentTemplateSummary } from '../../types/assessment';
import { ASSESSMENT_BAND_LABEL, ASSESSMENT_KIND_LABEL, ASSESSMENT_STATUS_LABEL } from '../../types/assessment';
import { api } from '../../lib/api';
import { emitChange } from '../../lib/events';
import { copyText } from '../../lib/clipboard';
import { faDate, faRelative, toPersianDigits } from '../../lib/format';
import { Button, Callout, Chip, Modal, Spinner, toast } from '../ui';

/**
 * «آزمون و ارزیابی» — pick a template, make the link, send it or copy it, and
 * read the result. Nothing leaves the app until the send button, and the
 * reading rule of the template is shown before sending, not after.
 */
export function AssessmentModal({
  record,
  jobTitle,
  onClose,
}: {
  record: ResumeListItem | null;
  jobTitle?: string;
  onClose: () => void;
}) {
  const [templates, setTemplates] = useState<AssessmentTemplateSummary[]>([]);
  const [suggestedId, setSuggestedId] = useState<string>('');
  const [items, setItems] = useState<AssessmentInvite[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'create' | 'send' | 'cancel' | null>(null);

  const load = () => {
    if (!record) return;
    setLoading(true);
    Promise.all([api.assessments.templates(jobTitle), api.assessments.list({ resumeId: record.id })])
      .then(([t, l]) => {
        setTemplates(t.templates);
        setSuggestedId(t.suggestedId);
        setItems(l.items);
        setSelected((prev) => prev || t.suggestedId || t.templates[0]?.id || '');
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  useEffect(load, [record?.id]);

  const chosen = useMemo(() => templates.find((t) => t.id === selected) || null, [templates, selected]);
  const active = items.find((a) => a.status === 'sent' || a.status === 'started') || null;
  const completed = items.filter((a) => a.status === 'completed');

  const create = async () => {
    if (!record || !selected) return;
    setBusy('create');
    try {
      const r = await api.assessments.create({ resumeId: record.id, templateId: selected, jobId: record.jobId });
      setItems((prev) => [r.assessment, ...prev]);
      toast('لینک آزمون ساخته شد؛ هنوز چیزی فرستاده نشده است.', 'success');
      emitChange('activity');
    } catch (err: any) {
      toast(err?.message || 'ساخت آزمون ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const send = async (id: string) => {
    setBusy('send');
    try {
      const r = await api.assessments.send(id);
      setItems((prev) => prev.map((a) => (a.id === id ? r.assessment : a)));
      toast('لینک آزمون از صندوق سازمان فرستاده شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'ارسال ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    setBusy('cancel');
    try {
      const r = await api.assessments.cancel(id);
      setItems((prev) => prev.map((a) => (a.id === id ? r.assessment : a)));
      toast('آزمون لغو شد.', 'success');
    } catch (err: any) {
      toast(err?.message || 'لغو ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={Boolean(record)} onClose={onClose} icon={<ClipboardList className="w-5 h-5 text-brand-ink" />} title="آزمون و ارزیابی" size="lg">
      {record && (
        <div className="flex flex-col gap-4">
          <Callout tone="info" icon={CheckCircle2}>
            این آزمون‌ها <b>ارزیابی ساختاریافتهٔ داخلی</b> هستند — نمونه‌کار و قضاوت موقعیتی با کلید امتیاز روشن. آزمون روان‌سنجیِ
            هنجارشده نیستند و امتیازشان جای مصاحبه و نمونه‌کار را نمی‌گیرد.
          </Callout>

          {loading ? (
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div>
                <p className="text-[12.5px] font-semibold text-ink mb-2">انتخاب آزمون</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {templates.map((t) => {
                    const on = t.id === selected;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelected(t.id)}
                        className={`text-right rounded-[12px] border px-3.5 py-3 transition-colors ${
                          on ? 'border-brand-strong bg-brand-soft' : 'border-line-2 bg-surface hover:bg-canvas'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[13px] font-bold text-ink">{t.name}</span>
                          {t.id === suggestedId && <Chip tone="brand">پیشنهاد برای این نقش</Chip>}
                        </span>
                        <span className="mt-1 block text-[11.5px] text-ink-3 leading-relaxed">{t.summary}</span>
                        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-4">
                          <Chip tone="outline">{ASSESSMENT_KIND_LABEL[t.kind]}</Chip>
                          <span>{toPersianDigits(t.questionCount)} سؤال</span>
                          <span>·</span>
                          <span>حدود {toPersianDigits(t.durationMinutes)} دقیقه</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {chosen && (
                  <p className="mt-2 text-[11.5px] text-ink-3 leading-relaxed">
                    <b className="text-ink-2">نحوهٔ خواندن نتیجه: </b>
                    {chosen.reading}
                  </p>
                )}
              </div>

              {active ? (
                <div className="rounded-[12px] border border-line-2 bg-canvas px-3.5 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone="brand">{ASSESSMENT_STATUS_LABEL[active.status]}</Chip>
                    <span className="text-[12.5px] font-semibold text-ink">{active.templateName}</span>
                    <span className="text-[11.5px] text-ink-3">
                      {active.sentAtISO ? `فرستاده‌شده ${faRelative(active.sentAtISO)}` : 'هنوز فرستاده نشده'}
                    </span>
                  </div>
                  {active.url && (
                    <div className="mt-2 flex items-center gap-2">
                      <code dir="ltr" className="text-[11px] font-mono text-ink-3 flex-1 truncate">
                        {active.url}
                      </code>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={Copy}
                        onClick={() => copyText(active.url || '').then((ok) => toast(ok ? 'کپی شد.' : 'کپی ممکن نشد.', ok ? 'success' : 'error'))}
                      >
                        کپی
                      </Button>
                    </div>
                  )}
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button size="sm" icon={Send} loading={busy === 'send'} onClick={() => send(active.id)}>
                      {active.sentAtISO ? 'ارسال دوباره با ایمیل' : 'ارسال با ایمیل سازمان'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={Trash2} loading={busy === 'cancel'} onClick={() => cancel(active.id)}>
                      لغو
                    </Button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-ink-4">
                    مهلت پاسخ تا {faDate(active.expiresAtISO)}. اگر صندوق سازمان وصل نباشد، همان لینک را کپی کنید و از صندوق خودتان بفرستید.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button icon={ClipboardList} loading={busy === 'create'} onClick={create} disabled={!selected}>
                    ساخت لینک آزمون
                  </Button>
                  <span className="text-[11.5px] text-ink-4">لینک ساخته می‌شود؛ فرستادن قدم بعدی است.</span>
                </div>
              )}

              {completed.length > 0 && (
                <div>
                  <p className="text-[12.5px] font-semibold text-ink mb-2">نتیجه‌ها</p>
                  <div className="flex flex-col gap-2">
                    {completed.map((a) => (
                      <div key={a.id} className="rounded-[12px] border border-line-2 bg-surface px-3.5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Chip tone="brand">تکمیل‌شده</Chip>
                          <span className="text-[12.5px] font-semibold text-ink">{a.templateName}</span>
                          {a.source === 'external' && <Chip tone="outline">نتیجهٔ ارائه‌دهندهٔ بیرونی</Chip>}
                          {a.score !== null && <span className="text-[13px] font-extrabold text-ink hv-num">{toPersianDigits(a.score)} از ۱۰۰</span>}
                          {a.score !== null && a.band && <Chip tone="neutral">{ASSESSMENT_BAND_LABEL[a.band]}</Chip>}
                          <span className="text-[11.5px] text-ink-4 mr-auto">
                            {a.completedAtISO ? faRelative(a.completedAtISO) : ''}
                          </span>
                        </div>

                        {a.dimensions && a.dimensions.length > 0 && (
                          <div className="mt-2.5 flex flex-col gap-1.5">
                            {a.dimensions.map((d) => (
                              <div key={d.id} className="flex items-center gap-2">
                                <span className="text-[11.5px] text-ink-3 w-28 shrink-0">{d.label}</span>
                                <span className="flex-1 h-1.5 rounded-full bg-line-2 overflow-hidden">
                                  <span className="block h-full bg-brand-strong" style={{ width: `${Math.max(0, Math.min(100, d.score))}%` }} />
                                </span>
                                <span className="text-[11px] text-ink-3 hv-num w-8 text-left">{toPersianDigits(d.score)}</span>
                              </div>
                            ))}
                            <p className="text-[11px] text-ink-4 mt-0.5">
                              نمایه است، نه نمرهٔ کلی: بُعد پایین موضوع گفت‌وگو در مصاحبه است، نه دلیل رد.
                            </p>
                          </div>
                        )}

                        {a.note && <p className="mt-2 text-[11.5px] text-ink-3 leading-relaxed">یادداشت: {a.note}</p>}
                        {a.url && (
                          <div className="mt-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={ExternalLink}
                              onClick={() => window.open(a.url, '_blank', 'noopener')}
                            >
                              دیدن صفحهٔ آزمون
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {items.some((a) => a.status === 'expired') && (
                <p className="text-[11.5px] text-ink-4">
                  {toPersianDigits(items.filter((a) => a.status === 'expired').length)} لینک منقضی شده است؛ لینک تازه بسازید تا دوباره فرستاده شود.
                </p>
              )}

              {!record.contact?.email && (
                <Callout tone="warning" icon={Mail}>
                  برای این کارجو ایمیل ثبت نشده است؛ لینک را کپی کنید و از صندوق خودتان بفرستید.
                </Callout>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

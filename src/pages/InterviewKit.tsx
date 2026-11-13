/**
 * «کیت مصاحبه» — the page an interviewer opens on a phone or prints before a
 * session: the questions this job needs, with what a good answer sounds like
 * and what a thin one sounds like.
 *
 * It is a page, not a modal, because it is read on paper: `window.print()` gives
 * a clean sheet (the app chrome is hidden by the print rules in index.css), and
 * the «کپی متن» button produces plain text for an e-mail or a doc.
 */
import React, { useEffect, useState } from 'react';
import { ArrowRight, BadgeCheck, Check, ClipboardCopy, Clock3, EyeOff, HelpCircle, Printer, TriangleAlert, Users } from 'lucide-react';
import { PageHeader } from '../components/layout/AppShell';
import { Button, ButtonLink, Callout, Card, CardHeader, Chip, ErrorState, Skeleton, toast } from '../components/ui';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { navigate, useLocation } from '../lib/router';
import { useAsync } from '../lib/useAsync';
import { useTitle } from '../lib/useTitle';
import { toPersianDigits } from '../lib/format';
import type { InterviewKit as Kit } from '../types/interview-kit';

/** The kit as plain text: what people actually paste into an e-mail or a doc. */
function asText(kit: Kit): string {
  const lines: string[] = [];
  lines.push(`کیت مصاحبه: ${kit.roleTitle}${kit.seniority ? ` (${kit.seniority})` : ''}`);
  lines.push(`${kit.departmentName}، حدود ${kit.durationMin} دقیقه`);
  if (kit.candidate) lines.push(`کارجو: ${kit.candidate.label}`);
  lines.push('');
  kit.howTo.forEach((h) => lines.push(`- ${h}`));
  for (const section of kit.sections) {
    lines.push('');
    lines.push(`## ${section.title} (${section.minutes} دقیقه)`);
    if (section.why) lines.push(section.why);
    section.questions.forEach((q, i) => {
      lines.push('');
      lines.push(`${i + 1}. ${q.text}`);
      lines.push(`   خوب: ${q.listen}`);
      lines.push(`   هشدار: ${q.red}`);
    });
  }
  lines.push('');
  lines.push('## پایان جلسه');
  kit.closing.forEach((c) => lines.push(`- ${c}`));
  return lines.join('\n');
}

export default function InterviewKitPage({ id }: { id: string }) {
  const { query } = useLocation();
  const resumeId = query.get('c') || undefined;
  const state = useAsync(() => api.jobs.interviewKit(id, resumeId), [id, resumeId]);
  const kit = state.data?.kit ?? null;
  const [copied, setCopied] = useState(false);
  useTitle(`کیت مصاحبه`);

  useEffect(() => {
    if (state.error) toast(state.error, 'error');
  }, [state.error]);

  if (state.error && !kit) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader breadcrumb={[{ label: 'فرصت‌های شغلی', to: '/app/jobs' }]} title="کیت مصاحبه" />
        <Card>
          <ErrorState message={state.error} onRetry={state.reload} />
        </Card>
      </div>
    );
  }

  if (!kit) {
    return (
      <div className="flex flex-col gap-4 max-w-[900px]">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-40" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const k = kit;
  const criteriaById = new Map(k.criteria.map((c) => [c.id, c]));
  const mustHave = k.criteria.filter((c) => c.mustHave);

  const copy = async () => {
    const ok = await copyText(asText(k));
    setCopied(ok);
    toast(ok ? 'متن کیت کپی شد؛ می‌توانید در ایمیل یا سند بچسبانید.' : 'کپی ممکن نشد؛ از دکمهٔ چاپ استفاده کنید.', ok ? 'success' : 'error');
  };

  return (
    <div className="max-w-[980px]">
      <PageHeader
        breadcrumb={[
          { label: 'فرصت‌های شغلی', to: '/app/jobs' },
          { label: k.roleTitle, to: `/app/jobs/${k.jobId}` },
          { label: 'کیت مصاحبه' },
        ]}
        title="کیت مصاحبه"
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-ink-2">{k.roleTitle}</span>
            <span aria-hidden>،</span>
            <span>{k.departmentName}</span>
            <span aria-hidden>،</span>
            <span>حدود {toPersianDigits(k.durationMin)} دقیقه</span>
            {k.seniority && (
              <>
                <span aria-hidden>،</span>
                <span>{k.seniority}</span>
              </>
            )}
          </span>
        }
        className="print-hide"
        actions={
          <>
            <Button variant="secondary" icon={ArrowRight} onClick={() => navigate(`/app/jobs/${k.jobId}`)}>
              بازگشت به فرصت
            </Button>
            <Button variant="secondary" icon={copied ? Check : ClipboardCopy} onClick={() => void copy()}>
              کپی متن
            </Button>
            <Button icon={Printer} onClick={() => window.print()}>
              چاپ
            </Button>
          </>
        }
      />

      {/* The printed sheet gets its own heading: the app header is hidden. */}
      <div className="hidden print:block mb-4">
        <p className="text-[18px] font-extrabold text-ink">کیت مصاحبه: {k.roleTitle}</p>
        <p className="text-[12px] text-ink-3">
          {k.departmentName}، حدود {toPersianDigits(k.durationMin)} دقیقه
          {k.candidate ? `، کارجو: ${k.candidate.label}` : ''}
        </p>
      </div>

      {k.candidate && (
        <Callout
          tone="brand"
          className="mb-4"
          icon={Users}
          title={`این کیت برای «${k.candidate.label}» ساخته شده`}
          action={
            <ButtonLink to={`/app/candidates/${k.candidate.resumeId}`} variant="secondary" size="sm">
              پروندهٔ کارجو
            </ButtonLink>
          }
        >
          امتیاز تطبیق {toPersianDigits(k.candidate.score)} از ۱۰۰. بخش «پرسش از خود این رزومه» از بازبینی دقیق و نقاط ضعف همین رزومه ساخته
          شده است.
        </Callout>
      )}

      <div className="grid lg:grid-cols-[1fr_290px] gap-5 items-start">
        <div className="flex flex-col gap-4">
          {k.sections.map((section, si) => (
            <Card key={section.id} className="print-break">
              <CardHeader
                icon={si === k.sections.length - 1 ? BadgeCheck : HelpCircle}
                title={
                  <span className="inline-flex flex-wrap items-center gap-2">
                    {section.title}
                    <Chip tone="neutral" icon={Clock3}>
                      {toPersianDigits(section.minutes)} دقیقه
                    </Chip>
                  </span>
                }
                subtitle={section.why}
              />
              <ol className="flex flex-col gap-3.5">
                {section.questions.map((q, qi) => {
                  const criterion = q.criterionId ? criteriaById.get(q.criterionId) : null;
                  return (
                    <li key={q.id} className="rounded-[12px] border border-line-2 bg-canvas/60 p-3.5">
                      <div className="flex items-start gap-2.5">
                        <span className="shrink-0 mt-0.5 w-6 h-6 rounded-full bg-surface border border-line text-[12px] font-bold text-ink-3 flex items-center justify-center">
                          {toPersianDigits(qi + 1)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[14px] font-bold text-ink leading-relaxed" dir="auto">
                            {q.text}
                          </p>
                          <div className="mt-2 grid sm:grid-cols-2 gap-2">
                            <p className="text-[12.5px] text-ink-2 leading-relaxed flex gap-1.5">
                              <Check className="w-4 h-4 text-brand-strong shrink-0 mt-0.5" aria-hidden />
                              <span>
                                <span className="font-semibold">بشنوید: </span>
                                {q.listen}
                              </span>
                            </p>
                            <p className="text-[12.5px] text-ink-2 leading-relaxed flex gap-1.5">
                              <TriangleAlert className="w-4 h-4 text-review-ink shrink-0 mt-0.5" aria-hidden />
                              <span>
                                <span className="font-semibold">علامت هشدار: </span>
                                {q.red}
                              </span>
                            </p>
                          </div>
                          {(criterion || q.source === 'resume') && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                              {criterion && (
                                <Chip tone={criterion.mustHave ? 'warning' : 'outline'}>
                                  معیار: {criterion.title} ({toPersianDigits(criterion.weight)}٪)
                                </Chip>
                              )}
                              {q.source === 'resume' && <Chip tone="brand">از این رزومه</Chip>}
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          ))}

          <Card className="print-break">
            <CardHeader icon={BadgeCheck} title="پایان جلسه" subtitle="دو دقیقه آخر، که تجربهٔ کارجو را تعیین می‌کند." />
            <ul className="flex flex-col gap-2">
              {k.closing.map((c) => (
                <li key={c} className="flex gap-2 text-[13px] text-ink-2 leading-relaxed">
                  <Check className="w-4 h-4 text-brand-strong shrink-0 mt-0.5" aria-hidden />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <div className="flex flex-col gap-4 print-hide">
          <Card>
            <CardHeader icon={HelpCircle} title="چطور از این کیت استفاده کنیم" />
            <ul className="flex flex-col gap-2">
              {k.howTo.map((h) => (
                <li key={h} className="text-[12.5px] text-ink-2 leading-relaxed flex gap-2">
                  <span className="text-brand-strong" aria-hidden>
                    •
                  </span>
                  {h}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader icon={BadgeCheck} title="معیارهای این فرصت" subtitle="همان معیارهایی که امتیاز رزومه بر آن‌ها حساب شده است." />
            <ul className="flex flex-col gap-2">
              {k.criteria.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-2 text-[12.5px]">
                  <span className="text-ink-2 leading-relaxed">{c.title}</span>
                  <span className="shrink-0 inline-flex items-center gap-1">
                    {c.mustHave && <Chip tone="warning">الزامی</Chip>}
                    <span className="text-ink-3 hv-num">{toPersianDigits(c.weight)}٪</span>
                  </span>
                </li>
              ))}
            </ul>
            {mustHave.length > 0 && (
              <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
                اگر وقت کم بود، بخش‌های مربوط به معیارهای الزامی را نگه دارید و بقیه را به جلسهٔ دوم بسپارید.
              </p>
            )}
          </Card>

          {k.matched.length > 0 && (
            <Card>
              <CardHeader icon={EyeOff} title="این کیت چطور چیده شد" subtitle="بانک پرسش بر اساس معیارها و نقش انتخاب شده است." />
              <div className="flex flex-wrap gap-1.5">
                {k.matched.map((m) => (
                  <Chip key={m} tone="outline">
                    {m}
                  </Chip>
                ))}
              </div>
              <p className="text-[12px] text-ink-3 mt-3 leading-relaxed">
                هر سؤال با «بشنوید» و «علامت هشدار» آمده تا قضاوت یکدست باشد. این کیت جای مصاحبه‌گر را نمی‌گیرد.
              </p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

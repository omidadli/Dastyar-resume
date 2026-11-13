/**
 * «تنظیمات ← بازارچهٔ آزمون» — connecting an outside test service.
 *
 * The screen is deliberately blunt about state:
 *   • nothing is pre-installed — an empty workspace reads an empty state, and
 *     every provider is one the customer typed in;
 *   • «آماده» only appears after a real check answered 2xx; until then it reads
 *     «تنظیم‌نشده» with the missing piece named;
 *   • the API key is write-only: the form says «ذخیره شده» and asks for a new
 *     one to replace it, never echoes the old;
 *   • the HTTP contract is printed on the page, so a vendor's developer can
 *     implement it without asking us anything.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, FlaskConical, KeyRound, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Button, Callout, Card, CardHeader, Chip, Field, Modal, Select, Skeleton, TextInput, toast } from '../../components/ui';
import { api, ApiError } from '../../lib/api';
import { toPersianDigits } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import type { AssessmentProviderPublic, ProviderInput, ProviderMode } from '../../types/assessment-provider';
import { PROVIDER_MODE_LABEL } from '../../types/assessment-provider';

type Draft = {
  id: string | null;
  name: string;
  mode: ProviderMode;
  baseUrl: string;
  sessionPath: string;
  checkPath: string;
  apiKey: string;
  tests: Array<{ id?: string; name: string; externalId: string; kind: 'situational' | 'work-sample' | 'behavioral'; durationMinutes: string; dimensions: string; scoring: 'score' | 'profile' }>;
};

const EMPTY: Draft = {
  id: null,
  name: '',
  mode: 'api',
  baseUrl: '',
  sessionPath: '/sessions',
  checkPath: '/health',
  apiKey: '',
  tests: [{ name: '', externalId: '', kind: 'situational', durationMinutes: '20', dimensions: '', scoring: 'score' }],
};

const KIND_OPTIONS = [
  { value: 'situational', label: 'قضاوت موقعیتی' },
  { value: 'work-sample', label: 'نمونه‌کار' },
  { value: 'behavioral', label: 'رفتار کاری' },
];

function StateChip({ provider }: { provider: AssessmentProviderPublic }) {
  if (provider.state === 'ready') return <Chip tone="brand" icon={CheckCircle2}>آماده</Chip>;
  if (provider.state === 'degraded') return <Chip tone="warning" icon={XCircle}>نیازمند بررسی</Chip>;
  if (provider.state === 'unchecked') return <Chip tone="neutral">بررسی‌نشده</Chip>;
  return <Chip tone="neutral">تنظیم‌نشده</Chip>;
}

export default function AssessmentsTab() {
  const q = useAsync<Awaited<ReturnType<typeof api.assessmentProviders.list>>>(() => api.assessmentProviders.list(), []);
  const [items, setItems] = useState<AssessmentProviderPublic[]>([]);
  const [contract, setContract] = useState<{ check: string; session: string; result: string; scope: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'check' | null>(null);
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setItems(q.data.items);
    setContract(q.data.contract);
  }, [q.data]);

  const openNew = () => setDraft({ ...EMPTY, tests: [{ ...EMPTY.tests[0] }] });
  const openEdit = (p: AssessmentProviderPublic) =>
    setDraft({
      id: p.id,
      name: p.name,
      mode: p.mode,
      baseUrl: p.endpointHost ? `https://${p.endpointHost}` : '',
      sessionPath: p.sessionPath,
      checkPath: p.checkPath,
      apiKey: '',
      tests: p.tests.length
        ? p.tests.map((t) => ({
            id: t.id,
            name: t.name,
            externalId: t.externalId || '',
            kind: t.kind,
            durationMinutes: String(t.durationMinutes),
            dimensions: t.dimensions.join('، '),
            scoring: t.scoring,
          }))
        : [{ name: '', externalId: '', kind: 'situational', durationMinutes: '20', dimensions: '', scoring: 'score' }],
    });

  const save = async () => {
    if (!draft) return;
    setBusy('save');
    try {
      const payload: ProviderInput = {
        name: draft.name.trim(),
        mode: draft.mode,
        baseUrl: draft.baseUrl.trim(),
        sessionPath: draft.sessionPath.trim(),
        checkPath: draft.checkPath.trim(),
        apiKey: draft.apiKey.trim(),
        tests: draft.tests
          .filter((t) => t.name.trim().length >= 2)
          .map((t) => ({
            id: t.id,
            name: t.name.trim(),
            externalId: t.externalId.trim() || null,
            kind: t.kind,
            durationMinutes: Number(t.durationMinutes) || 20,
            dimensions: t.dimensions,
            scoring: t.scoring,
          })),
      };
      const r = draft.id
        ? await api.assessmentProviders.update(draft.id, payload)
        : await api.assessmentProviders.create(payload);
      setItems((prev) => (draft.id ? prev.map((p) => (p.id === r.provider.id ? r.provider : p)) : [...prev, r.provider]));
      setDraft(null);
      toast(
        r.provider.state === 'ready'
          ? 'سرویس ذخیره شد.'
          : 'سرویس ذخیره شد؛ تا وقتی «بررسی اتصال» موفق نشود، ارسال از آن انجام نمی‌شود.',
        'success'
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'ذخیرهٔ سرویس ممکن نشد.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const check = async (id: string) => {
    setChecking(id);
    try {
      const r = await api.assessmentProviders.check(id);
      setItems((prev) => prev.map((p) => (p.id === id ? r.provider : p)));
      const c = r.provider.lastCheck;
      if (c?.ok) toast(`اتصال سالم است — ${toPersianDigits(c.latencyMs ?? 0)} میلی‌ثانیه.`, 'success');
      else toast(c?.error || 'اتصال برقرار نشد.', 'error');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'بررسی اتصال ممکن نشد.', 'error');
    } finally {
      setChecking(null);
    }
  };

  const remove = async (p: AssessmentProviderPublic) => {
    const used = p.invites > 0 ? ` ${toPersianDigits(p.invites)} دعوت و ${toPersianDigits(p.completed)} نتیجه به این سرویس گره خورده‌اند؛ نتیجه‌ها می‌مانند.` : '';
    if (!window.confirm(`سرویس «${p.name}» از فهرست برداشته شود؟${used} کلید ذخیره‌شده هم پاک می‌شود.`)) return;
    try {
      await api.assessmentProviders.remove(p.id);
      setItems((prev) => prev.filter((x) => x.id !== p.id));
      toast('سرویس برداشته شد.');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'برداشتن سرویس ممکن نشد.', 'error');
    }
  };

  if (q.loading) return <Skeleton className="h-64" />;
  if (q.error) return <Callout tone="warning" title="فهرست سرویس‌ها خوانده نشد">{q.error}</Callout>;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={FlaskConical}
          title="بازارچهٔ آزمون"
          subtitle="آزمون‌هایی که بیرون از هویدا برگزار می‌شوند: سرویس شخصیت، زبان، کدنویسی با ناظر. هویدا دعوت را می‌فرستد و نتیجه را در پروندهٔ کارجو نگه می‌دارد."
          action={
            <Button variant="primary" size="sm" icon={Plus} onClick={openNew}>
              افزودن سرویس
            </Button>
          }
        />
        <Callout tone="info" title="چه چیزی این‌جا نمی‌بینید">
          هیچ سرویسی از پیش نصب نشده و هیچ فهرست آزمونی از طرف ما نمی‌آید. اگر با سرویسی قرارداد دارید، نشانی و کلیدش را وارد کنید؛ اگر
          سرویس API ندارد، حالت «لینک» را انتخاب کنید و نتیجه را دستی ثبت کنید. آزمون بدون دکمهٔ «ارسال» جایی نمی‌رود.
        </Callout>
      </Card>

      {items.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <FlaskConical className="w-10 h-10 mx-auto text-ink-4" strokeWidth={1.5} />
            <p className="mt-3 text-sm font-semibold text-ink">هنوز سرویس آزمون بیرونی وصل نیست</p>
            <p className="mt-1 text-xs text-ink-3 max-w-md mx-auto leading-relaxed">
              آزمون‌های خود هویدا (قضاوت موقعیتی، نمونه‌کار، رفتار کاری) بدون هیچ تنظیمی کار می‌کنند. این صفحه برای وقتی است که
              آزمونِ سازمان شما جای دیگری برگزار می‌شود.
            </p>
            <Button className="mt-4" variant="secondary" size="sm" icon={Plus} onClick={openNew}>
              افزودن اولین سرویس
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {items.map((p) => (
            <Card key={p.id}>
              <CardHeader
                as="h3"
                title={p.name}
                subtitle={PROVIDER_MODE_LABEL[p.mode]}
                action={<StateChip provider={p} />}
              />
              {p.reason && <p className="text-xs text-ink-3 leading-relaxed mb-2">{p.reason}</p>}
              <dl className="text-xs text-ink-3 space-y-1 mb-3">
                {p.endpointHost && (
                  <div className="flex gap-1">
                    <dt>نشانی:</dt>
                    <dd className="hv-latin text-ink-2" dir="ltr">
                      {p.endpointHost}
                      {p.sessionPath}
                    </dd>
                  </div>
                )}
                {p.mode === 'api' && (
                  <div className="flex items-center gap-1">
                    <dt>کلید:</dt>
                    <dd>{p.hasKey ? <span className="hv-latin" dir="ltr">••••{p.keyHint}</span> : 'ثبت نشده'}</dd>
                  </div>
                )}
                <div className="flex gap-1">
                  <dt>دعوت‌ها:</dt>
                  <dd>
                    {toPersianDigits(p.invites)} دعوت ، {toPersianDigits(p.completed)} نتیجه
                  </dd>
                </div>
                {p.lastCheck && (
                  <div className="flex gap-1">
                    <dt>آخرین بررسی:</dt>
                    <dd>
                      {p.lastCheck.ok ? 'سالم' : 'ناموفق'} — {p.lastCheck.atJalali}
                      {p.lastCheck.latencyMs !== null ? ` (${toPersianDigits(p.lastCheck.latencyMs)}ms)` : ''}
                    </dd>
                  </div>
                )}
              </dl>
              {p.tests.length > 0 && (
                <ul className="flex flex-wrap gap-1.5 mb-3">
                  {p.tests.map((t) => (
                    <li key={t.id}>
                      <Chip tone="outline">{t.name}</Chip>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={RefreshCw} loading={checking === p.id} onClick={() => check(p.id)}>
                  بررسی اتصال
                </Button>
                <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                  ویرایش
                </Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(p)}>
                  برداشتن
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {contract && (
        <Card>
          <CardHeader as="h3" icon={KeyRound} title="قرارداد سرویس" subtitle="این را به توسعه‌دهندهٔ سرویس بدهید؛ همین سه مسیر کافی است." />
          <ol className="space-y-2 text-xs text-ink-2 leading-relaxed list-decimal pr-4">
            <li>
              بررسی سلامت — <code className="hv-latin" dir="ltr">{contract.check}</code>
            </li>
            <li>
              ساخت جلسه — <code className="hv-latin" dir="ltr">{contract.session}</code>؛ پاسخ باید JSON با <code dir="ltr">url</code> باشد.
            </li>
            <li>
              ثبت نتیجه — <code className="hv-latin" dir="ltr">{contract.result}</code>؛ کلید با دسترسی{' '}
              <code dir="ltr">{contract.scope}</code>.
            </li>
          </ol>
          <p className="mt-2 text-[11px] text-ink-4 leading-relaxed">
            هویدا هیچ‌وقت متن رزومه یا دادهٔ تماس اضافه نمی‌فرستد: نام، ایمیل، شناسهٔ دعوت و مهلت — همین.
          </p>
        </Card>
      )}

      {draft && (
        <Modal
          open
          onClose={() => setDraft(null)}
          title={draft.id ? 'ویرایش سرویس آزمون' : 'افزودن سرویس آزمون'}
          size="lg"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                انصراف
              </Button>
              <Button variant="primary" loading={busy === 'save'} onClick={save}>
                ذخیره
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput
                label="نام سرویس"
                required
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="آزمون زبان سازمانی"
              />
              <Select
                label="نحوهٔ اتصال"
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as ProviderMode })}
                options={[
                  { value: 'api', label: 'API — خودِ هویدا جلسه می‌سازد' },
                  { value: 'link', label: 'لینک — منابع انسانی نتیجه را ثبت می‌کند' },
                ]}
              />
            </div>
            {draft.mode === 'api' ? (
              <>
                <TextInput
                  label="نشانی سرویس"
                  required
                  latin
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  placeholder="https://tests.example.com"
                  hint="فقط https؛ کلید روی http فرستاده نمی‌شود."
                />
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextInput
                    label="مسیر ساخت جلسه"
                    latin
                    value={draft.sessionPath}
                    onChange={(e) => setDraft({ ...draft, sessionPath: e.target.value })}
                    placeholder="/sessions"
                  />
                  <TextInput
                    label="مسیر بررسی سلامت"
                    latin
                    value={draft.checkPath}
                    onChange={(e) => setDraft({ ...draft, checkPath: e.target.value })}
                    placeholder="/health"
                  />
                </div>
                <TextInput
                  label="کلید API سرویس"
                  type="password"
                  latin
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  placeholder={draft.id ? 'برای نگه‌داشتن کلید فعلی خالی بگذارید' : 'sk_live_…'}
                  hint="رمزنگاری‌شده ذخیره می‌شود و هیچ‌وقت دوباره نمایش داده نمی‌شود."
                />
              </>
            ) : (
              <Callout tone="info" title="در حالت لینک چه می‌شود">
                هنگام ساخت دعوت، نشانی آزمون آن کارجو را وارد می‌کنید؛ هویدا همان لینک را از صندوق سازمان می‌فرستد و وقتی نتیجه
                رسید، شما نمره یا یادداشتش را ثبت می‌کنید. پرونده می‌گوید «نتیجهٔ بیرونی» و نام سرویس را می‌نویسد.
              </Callout>
            )}

            <Field label="آزمون‌های این سرویس" hint="هر آزمون یک نام دارد؛ در حالت API شناسهٔ سرویس هم لازم است.">
              <div className="space-y-2">
                {draft.tests.map((t, i) => (
                  <div key={i} className="rounded-lg border border-line p-3 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <TextInput
                        placeholder="نام آزمون (مثلاً «شخصیت کاری — نسخهٔ سازمانی»)"
                        value={t.name}
                        onChange={(e) => {
                          const next = [...draft.tests];
                          next[i] = { ...t, name: e.target.value };
                          setDraft({ ...draft, tests: next });
                        }}
                      />
                      <TextInput
                        latin
                        placeholder="شناسه در سرویس (اختیاری)"
                        value={t.externalId}
                        onChange={(e) => {
                          const next = [...draft.tests];
                          next[i] = { ...t, externalId: e.target.value };
                          setDraft({ ...draft, tests: next });
                        }}
                      />
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Select
                        value={t.kind}
                        onChange={(e) => {
                          const next = [...draft.tests];
                          next[i] = { ...t, kind: e.target.value as typeof t.kind };
                          setDraft({ ...draft, tests: next });
                        }}
                        options={KIND_OPTIONS}
                      />
                      <TextInput
                        latin
                        placeholder="دقیقه"
                        value={t.durationMinutes}
                        onChange={(e) => {
                          const next = [...draft.tests];
                          next[i] = { ...t, durationMinutes: e.target.value };
                          setDraft({ ...draft, tests: next });
                        }}
                      />
                      <Select
                        value={t.scoring}
                        onChange={(e) => {
                          const next = [...draft.tests];
                          next[i] = { ...t, scoring: e.target.value as typeof t.scoring };
                          setDraft({ ...draft, tests: next });
                        }}
                        options={[
                          { value: 'score', label: 'یک نمرهٔ ۰–۱۰۰' },
                          { value: 'profile', label: 'چند بُعد' },
                        ]}
                      />
                    </div>
                    <TextInput
                      placeholder="ابعاد با ویرگول (اختیاری): ثبات، دقت، همکاری"
                      value={t.dimensions}
                      onChange={(e) => {
                        const next = [...draft.tests];
                        next[i] = { ...t, dimensions: e.target.value };
                        setDraft({ ...draft, tests: next });
                      }}
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Plus}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      tests: [...draft.tests, { name: '', externalId: '', kind: 'situational', durationMinutes: '20', dimensions: '', scoring: 'score' }],
                    })
                  }
                >
                  آزمون دیگر
                </Button>
              </div>
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

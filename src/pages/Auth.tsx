import React, { useEffect, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, Mail, Sparkles, UserRound } from 'lucide-react';
import { HovidaLogo, HovidaMark } from '../components/brand/Logo';
import { Button, Callout, TextInput } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Link, navigate, useLocation } from '../lib/router';
import { useDemoLogin } from '../lib/useDemo';
import { useTitle } from '../lib/useTitle';

function AuthLayout({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1fr_1.05fr] bg-surface" dir="rtl">
      <div className="flex flex-col px-5 sm:px-10 py-8">
        <Link to="/" aria-label="بازگشت به صفحه اصلی هویدا" className="self-start">
          <HovidaLogo height={32} />
        </Link>
        <div className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-[400px]">
            <h1 className="text-[26px] font-extrabold text-ink leading-snug">{title}</h1>
            <p className="text-[14px] text-ink-3 mt-2 leading-relaxed">{subtitle}</p>
            <div className="mt-8">{children}</div>
          </div>
        </div>
        <p className="text-[12px] text-ink-4 text-center">هویدا • تحلیل دقیق‌تر، تصمیم بهتر</p>
      </div>
      <div className="hidden lg:flex relative overflow-hidden bg-brand-soft items-center justify-center p-12">
        <div className="absolute -top-24 -left-24 w-[420px] h-[420px] rounded-full bg-white/50" />
        <div className="absolute -bottom-32 -right-20 w-[360px] h-[360px] rounded-full bg-[#dcebe0]" />
        <div className="relative max-w-[440px]">
          <HovidaMark size={84} />
          <p className="mt-8 text-[34px] font-black text-ink leading-[1.4]">
            آنچه مهم است،
            <br />
            روشن می‌شود.
          </p>
          <p className="mt-4 text-[15px] text-ink-2 leading-[1.95]">تحلیل هوشمند رزومه‌ها برای تصمیم‌های بهتر در منابع انسانی.</p>
          <ul className="mt-8 flex flex-col gap-3.5">
            {['هر امتیاز همراه با شاهدی از متن رزومه', 'تصمیم نهایی همیشه با شماست', 'فضای کاری اختصاصی و جداگانه برای سازمان شما'].map((t) => (
              <li key={t} className="flex items-center gap-2.5 text-[14px] font-semibold text-ink-2">
                <CheckCircle2 className="w-5 h-5 text-brand-strong" />
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function DemoButton() {
  const demo = useDemoLogin();
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    api.auth
      .config()
      .then((c) => setEnabled(c.demo))
      .catch(() => {});
  }, []);
  if (!enabled) return null;
  return (
    <>
      <div className="flex items-center gap-3 my-6 text-[12px] text-ink-4">
        <span className="flex-1 h-px bg-line" />
        یا
        <span className="flex-1 h-px bg-line" />
      </div>
      <Button variant="secondary" block size="lg" icon={Sparkles} onClick={demo.start} loading={demo.loading}>
        ورود به نسخه نمایشی
      </Button>
      <p className="text-[12px] text-ink-3 text-center mt-2.5 leading-relaxed">یک فضای کاری نمونه با داده‌های ساختگی که پس از ۲۴ ساعت پاک می‌شود.</p>
    </>
  );
}

export function LoginPage() {
  useTitle('ورود');
  const { signIn, notice, clearNotice } = useAuth();
  const { query } = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = await api.auth.login({ email: email.trim(), password });
      clearNotice();
      signIn(payload);
      const next = query.get('next');
      navigate(next && next.startsWith('/app') ? next : '/app', { replace: true });
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'ورود ممکن نشد.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      title="ورود به هویدا"
      subtitle={
        <>
          حساب ندارید؟{' '}
          <Link to="/signup" className="font-bold text-brand-ink hover:underline">
            فضای کاری سازمان را بسازید
          </Link>
        </>
      }
    >
      {notice && !error && (
        <Callout tone="warning" className="mb-5">
          {notice}
        </Callout>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextInput label="ایمیل کاری" type="email" icon={Mail} latin autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@company.ir" />
        <TextInput label="رمز عبور" type="password" latin autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" size="lg" block loading={loading} iconEnd={ArrowLeft} disabled={!email || !password}>
          ورود
        </Button>
      </form>
      <DemoButton />
    </AuthLayout>
  );
}

export function SignupPage() {
  useTitle('ساخت فضای کاری');
  const { signIn } = useAuth();
  const [form, setForm] = useState({ orgName: '', name: '', email: '', password: '' });
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const strength = (() => {
    const p = form.password;
    let s = 0;
    if (p.length >= 8) s++;
    if (/[A-Za-z\u0600-\u06FF]/.test(p) && /[0-9۰-۹]/.test(p)) s++;
    if (p.length >= 12 || /[^A-Za-z0-9\u0600-\u06FF]/.test(p)) s++;
    return s;
  })();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const payload = await api.auth.signup({ ...form, email: form.email.trim() });
      signIn(payload);
      navigate('/app?welcome=1', { replace: true });
    } catch (err: any) {
      setError({ message: err?.message || 'ساخت حساب ممکن نشد.', field: err?.field });
    } finally {
      setLoading(false);
    }
  };

  const fieldError = (f: string) => (error?.field === f ? error.message : null);

  return (
    <AuthLayout
      title="فضای کاری سازمان را بسازید"
      subtitle={
        <>
          قبلاً ثبت‌نام کرده‌اید؟{' '}
          <Link to="/login" className="font-bold text-brand-ink hover:underline">
            وارد شوید
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextInput label="نام سازمان" icon={Building2} value={form.orgName} onChange={set('orgName')} required placeholder="مثلاً شرکت آریا صنعت" error={fieldError('orgName')} />
        <TextInput label="نام و نام خانوادگی" icon={UserRound} value={form.name} onChange={set('name')} required autoComplete="name" error={fieldError('name')} />
        <TextInput label="ایمیل کاری" type="email" icon={Mail} latin autoComplete="email" value={form.email} onChange={set('email')} required placeholder="name@company.ir" error={fieldError('email')} />
        <div>
          <TextInput
            label="رمز عبور"
            type="password"
            latin
            autoComplete="new-password"
            value={form.password}
            onChange={set('password')}
            required
            hint="دست‌کم ۸ کاراکتر، ترکیبی از حروف و عدد"
            error={fieldError('password')}
          />
          {form.password && (
            <div className="flex gap-1 mt-2" aria-label="قدرت رمز عبور">
              {[1, 2, 3].map((i) => (
                <span key={i} className={`h-1 flex-1 rounded-full ${i <= strength ? (strength >= 3 ? 'bg-brand' : strength === 2 ? 'bg-review' : 'bg-low') : 'bg-line'}`} />
              ))}
            </div>
          )}
        </div>
        {error && !error.field && <Callout tone="danger">{error.message}</Callout>}
        <Button type="submit" size="lg" block loading={loading} iconEnd={ArrowLeft}>
          ساخت فضای کاری
        </Button>
        <p className="text-[12px] text-ink-3 leading-relaxed text-center">
          شما مالک این فضای کاری خواهید بود و می‌توانید اعضای تیم را از بخش تنظیمات اضافه کنید.
        </p>
      </form>
      <DemoButton />
    </AuthLayout>
  );
}

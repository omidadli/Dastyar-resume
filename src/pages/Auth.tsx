import React, { useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, KeyRound, Mail, ShieldCheck, Sparkles, UserRound, Workflow } from 'lucide-react';
import { HovidaLogo, HovidaMark } from '../components/brand/Logo';
import { Button, Callout, TextInput } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { AuthPayload } from '../types/app';
import { useAuth } from '../lib/auth';
import { usePublicConfig } from '../lib/config';
import { Link, navigate, useLocation } from '../lib/router';
import { useDemoLogin } from '../lib/useDemo';
import { useTitle } from '../lib/useTitle';

function AuthLayout({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: React.ReactNode }) {
  return (
    <div className="min-h-screen grid lg:grid-cols-[1fr_1.05fr] bg-surface" dir="rtl">
      <div className="flex flex-col px-5 sm:px-10 py-8">
        <header className="self-start">
          <Link to="/" aria-label="بازگشت به صفحه اصلی هویدا" className="inline-flex">
            <HovidaLogo height={32} />
          </Link>
        </header>
        <main className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-[400px]">
            <h1 className="text-[26px] font-extrabold text-ink leading-snug">{title}</h1>
            <p className="text-[14px] text-ink-3 mt-2 leading-relaxed">{subtitle}</p>
            <div className="mt-8">{children}</div>
          </div>
        </main>
        <footer>
          <p className="text-[12px] text-ink-4 text-center">هویدا، تحلیل دقیق‌تر، تصمیم بهتر</p>
        </footer>
      </div>
      <aside aria-label="درباره هویدا" className="hidden lg:flex relative overflow-hidden bg-brand-soft items-center justify-center p-12">
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
      </aside>
    </div>
  );
}

function DemoButton() {
  const demo = useDemoLogin();
  const { demo: enabled, demoHours } = usePublicConfig();
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
      <p className="text-[12px] text-ink-3 text-center mt-2.5 leading-relaxed">
        یک فضای کاری نمونه با داده‌های ساختگی که پس از {demoHours.toLocaleString('fa-IR')} ساعت پاک می‌شود.
      </p>
    </>
  );
}

const SSO_NOTICE: Record<string, { text: string; tone: 'warning' | 'danger' }> = {
  none: { text: 'برای این ایمیل، ورود سازمانی روی هیچ فضای کاری تنظیم نشده است؛ با رمز عبور وارد شوید.', tone: 'warning' },
  misconfigured: { text: 'ورود سازمانی این سازمان ناقص تنظیم شده است؛ با مدیر فضای کاری تماس بگیرید.', tone: 'danger' },
  provider: { text: 'سرویس ورود سازمانی پاسخ نداد؛ کمی بعد دوباره تلاش کنید یا با رمز وارد شوید.', tone: 'danger' },
  expired: { text: 'این ورود منقضی شده است (بیش از ده دقیقه). یک‌بار دیگر روی «ورود سازمانی» بزنید.', tone: 'warning' },
  off: { text: 'ورود سازمانی این فضای کاری خاموش شده است.', tone: 'warning' },
  cancelled: { text: 'ورود سازمانی لغو شد.', tone: 'warning' },
  code: { text: 'سرویس سازمانی کد ورود را برنگرداند؛ دوباره تلاش کنید.', tone: 'danger' },
  denied: { text: 'این حساب اجازهٔ ورود به این فضای کاری را ندارد (ایمیل تأییدنشده، دامنهٔ دیگر، یا عضویت نداشتن).', tone: 'danger' },
  failed: { text: 'ورود سازمانی کامل نشد؛ دوباره تلاش کنید یا با رمز عبور وارد شوید.', tone: 'danger' },
};

/** «ورود سازمانی»: the browser leaves for the provider, so this is a plain navigation. */
function SsoBox({ initialEmail }: { initialEmail: string }) {
  const { query } = useLocation();
  const [email, setEmail] = useState(initialEmail);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<{ orgName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reason = query.get('sso');
  const notice = reason ? SSO_NOTICE[reason] : null;

  const start = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const em = email.trim();
    if (!em) return setError('ایمیل کاری سازمانی خود را وارد کنید.');
    setError(null);
    setLooking(true);
    try {
      const res = await api.auth.ssoLookup(em);
      if (!res.available) {
        setFound(null);
        setError('برای این ایمیل، ورود سازمانی تنظیم نشده است؛ با رمز عبور وارد شوید.');
        return;
      }
      setFound({ orgName: res.orgName });
      const next = query.get('next');
      // A real navigation: the provider's page takes over from here.
      window.location.assign(`/api/auth/sso/start?email=${encodeURIComponent(em)}${next && next.startsWith('/app') ? `&next=${encodeURIComponent(next)}` : ''}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'بررسی ورود سازمانی ممکن نشد.');
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="mt-7">
      {notice && (
        <Callout tone={notice.tone} className="mb-4">
          {notice.text}
        </Callout>
      )}
      <div className="flex items-center gap-3 mb-4 text-[12px] text-ink-4">
        <span className="flex-1 h-px bg-line" />
        ورود سازمانی
        <span className="flex-1 h-px bg-line" />
      </div>
      <form onSubmit={start} className="flex flex-col gap-3">
        <TextInput
          label="ایمیل سازمانی"
          name="sso-email"
          type="email"
          icon={Workflow}
          latin
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@company.ir"
          hint="اگر سازمان شما ورود با Google Workspace یا Microsoft را فعال کرده باشد، اینجا به صفحهٔ سازمان می‌روید."
        />
        {error && <p className="text-[12.5px] text-low-ink font-medium" role="alert">{error}</p>}
        {found?.orgName && !error && (
          <p className="text-[12.5px] text-brand-ink font-medium">در حال رفتن به صفحهٔ ورود «{found.orgName}»…</p>
        )}
        <Button type="submit" variant="secondary" size="lg" block loading={looking} icon={Workflow}>
          ادامه با حساب سازمانی
        </Button>
      </form>
    </div>
  );
}

export function LoginPage() {
  useTitle('ورود');
  const { signIn, notice, noticeTone, clearNotice } = useAuth();
  const { query } = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Set once the password is right and the account has «ورود دومرحله‌ای» on. */
  const [challenge, setChallenge] = useState<{ token: string; hint: string; email: string } | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const finish = (payload: AuthPayload) => {
    clearNotice();
    signIn(payload);
    const next = query.get('next');
    navigate(next && next.startsWith('/app') ? next : '/app', { replace: true });
  };

  const verify = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!challenge) return;
    const value = code.trim();
    if (!value) {
      setError(useRecovery ? 'یکی از کدهای بازیابی را وارد کنید.' : 'کد ۶ رقمی را وارد کنید.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      finish(await api.auth.twoFactor({ challenge: challenge.token, [useRecovery ? 'recoveryCode' : 'code']: value }));
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'تأیید کد ممکن نشد.');
      // An expired challenge cannot be retried: send the person back to the password.
      if (err instanceof ApiError && /منقضی/.test(err.message)) setChallenge(null);
    } finally {
      setLoading(false);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // Read the fields themselves: a browser-autofilled password can reach the
    // DOM without an input event, so React state may still be empty.
    const fd = new FormData(e.currentTarget);
    const field = (k: string, fallback: string) => {
      const v = fd.get(k);
      return typeof v === 'string' ? v : fallback;
    };
    const em = field('email', email).trim();
    const pw = field('password', password);
    if (!em || !pw) {
      setError('ایمیل و رمز عبور را وارد کنید.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const payload = await api.auth.login({ email: em, password: pw });
      if ('twoFactorRequired' in payload) {
        setChallenge({ token: payload.challenge, hint: payload.hint, email: em });
        setCode('');
        setUseRecovery(false);
        return;
      }
      finish(payload);
    } catch (err: any) {
      setError(err instanceof ApiError ? err.message : 'ورود ممکن نشد.');
    } finally {
      setLoading(false);
    }
  };

  if (challenge) {
    return (
      <AuthLayout
        title="تأیید دومرحله‌ای"
        subtitle={
          <>
            رمز <span className="hv-latin font-semibold">{challenge.email}</span> درست بود. برای کامل‌شدن ورود،{' '}
            {useRecovery ? 'یکی از کدهای بازیابی' : 'کد ۶ رقمی برنامهٔ احراز هویت'} را وارد کنید.
          </>
        }
      >
        <form onSubmit={verify} className="flex flex-col gap-4" noValidate>
          <TextInput
            label={useRecovery ? 'کد بازیابی' : 'کد تأیید'}
            name={useRecovery ? 'recoveryCode' : 'code'}
            icon={useRecovery ? KeyRound : ShieldCheck}
            latin
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={useRecovery ? 'ABCD-EFGH' : '۱۲۳۴۵۶'}
            hint={useRecovery ? 'هر کد بازیابی فقط یک‌بار کار می‌کند.' : challenge.hint}
          />
          {error && <Callout tone="danger">{error}</Callout>}
          <Button type="submit" size="lg" block loading={loading} iconEnd={ArrowLeft}>
            تأیید و ورود
          </Button>
          <div className="flex items-center justify-between text-[13px]">
            <button
              type="button"
              className="font-bold text-brand-ink hover:underline"
              onClick={() => {
                setUseRecovery((v) => !v);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'کد برنامهٔ احراز هویت را دارم' : 'به گوشی‌ام دسترسی ندارم'}
            </button>
            <button
              type="button"
              className="text-ink-3 hover:underline"
              onClick={() => {
                setChallenge(null);
                setCode('');
                setError(null);
              }}
            >
              بازگشت
            </button>
          </div>
        </form>
      </AuthLayout>
    );
  }

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
        <Callout tone={noticeTone === 'success' ? 'brand' : 'warning'} className="mb-5">
          {notice}
        </Callout>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <TextInput label="ایمیل کاری" name="email" type="email" icon={Mail} latin autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="name@company.ir" />
        <TextInput label="رمز عبور" name="password" type="password" latin autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Callout tone="danger">{error}</Callout>}
        <Button type="submit" size="lg" block loading={loading} iconEnd={ArrowLeft}>
          ورود
        </Button>
      </form>
      <SsoBox initialEmail={email} />
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

  // Mirrors the server rule (≥ 8 characters, letters + digits): a password the
  // server would refuse never looks "medium" here.
  const { strength, strengthLabel } = (() => {
    const p = form.password;
    const acceptable = p.length >= 8 && p.length <= 128 && /[A-Za-z\u0600-\u06FF]/.test(p) && /[0-9۰-۹]/.test(p);
    if (!acceptable) return { strength: 1, strengthLabel: p.length < 8 ? 'کوتاه است' : 'حروف و عدد را ترکیب کنید' };
    const strong = p.length >= 12 || /[^A-Za-z0-9\u0600-\u06FF]/.test(p);
    return strong ? { strength: 3, strengthLabel: 'قوی' } : { strength: 2, strengthLabel: 'قابل قبول' };
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
  const { signup: signupOpen, supportEmail } = usePublicConfig();

  if (!signupOpen) {
    return (
      <AuthLayout
        title="ثبت‌نام فعلاً بسته است"
        subtitle={
          <>
            ساخت فضای کاری تازه موقتاً متوقف شده است. اگر حساب دارید{' '}
            <Link to="/login" className="font-bold text-brand-ink hover:underline">
              وارد شوید
            </Link>
            .
          </>
        }
      >
        <Callout tone="info" title="دریافت دسترسی">
          برای ساخت فضای کاری سازمان خود
          {supportEmail ? (
            <>
              {' '}به{' '}
              <a href={`mailto:${supportEmail}`} className="font-bold underline hv-latin">
                {supportEmail}
              </a>{' '}
              پیام دهید.
            </>
          ) : (
            ' با تیم هویدا تماس بگیرید.'
          )}
        </Callout>
        <DemoButton />
      </AuthLayout>
    );
  }

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
        <TextInput label="نام سازمان" icon={Building2} value={form.orgName} onChange={set('orgName')} required autoComplete="organization" placeholder="مثلاً شرکت آریا صنعت" error={fieldError('orgName')} />
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
            <div className="flex items-center gap-2.5 mt-2">
              <div className="flex gap-1 flex-1" aria-hidden>
                {[1, 2, 3].map((i) => (
                  <span key={i} className={`h-1 flex-1 rounded-full ${i <= strength ? (strength >= 3 ? 'bg-brand' : strength === 2 ? 'bg-review' : 'bg-low') : 'bg-line'}`} />
                ))}
              </div>
              <span
                className={`text-[11.5px] font-semibold shrink-0 ${strength >= 3 ? 'text-brand-ink' : strength === 2 ? 'text-review-ink' : 'text-low-ink'}`}
                aria-live="polite"
              >
                قدرت رمز: {strengthLabel}
              </span>
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

import React from 'react';
import {
  Archive,
  ArrowLeft,
  BarChart3,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  Columns3,
  FileCheck2,
  KeyRound,
  Languages,
  ListChecks,
  Lock,
  MessageSquareText,
  Scale,
  ShieldCheck,
  Sparkles,
  Target,
  Timer,
  Trash2,
  UploadCloud,
  Users,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { HovidaLogo, HovidaMark } from '../components/brand/Logo';
import { Button, ButtonLink, Chip, MatchMeter, MatchPill, Monogram, ScoreBadge } from '../components/ui';
import { Link } from '../lib/router';
import { useAuth } from '../lib/auth';
import { useDemoLogin } from '../lib/useDemo';
import { useTitle } from '../lib/useTitle';
import type { ResumeCategory } from '../types/screening';

const MOCK_ROWS: { name: string; role: string; score: number; cat: ResumeCategory; skills: string[] }[] = [
  { name: 'سارا محمدی', role: 'کارشناس ارشد جذب', score: 88, cat: 'INTERVIEW', skills: ['مصاحبه شایستگی‌محور', 'ATS'] },
  { name: 'امیر رضایی', role: 'کارشناس منابع انسانی', score: 81, cat: 'INTERVIEW', skills: ['کارگزینی', 'بیمه'] },
  { name: 'نگار کریمی', role: 'سرپرست جذب', score: 74, cat: 'REVIEW', skills: ['کانون ارزیابی'] },
  { name: 'محمد حسینی', role: 'کارشناس آموزش', score: 62, cat: 'REVIEW', skills: ['نیازسنجی'] },
];

function ProductMock() {
  return (
    <div className="relative" aria-hidden>
      <div className="absolute -inset-6 sm:-inset-10 rounded-[40px] bg-gradient-to-br from-brand-soft via-[#f1f7f2] to-transparent" />
      <div className="relative hv-card shadow-pop p-4 sm:p-5 rounded-[20px]">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div>
            <p className="text-[11px] text-ink-3">فرصت شغلی · منابع انسانی و اداری</p>
            <p className="text-[15px] font-extrabold text-ink">کارشناس جذب و استخدام</p>
          </div>
          <span className="inline-flex items-center gap-1 h-6 px-2.5 rounded-full bg-brand-soft text-brand-stronger text-[11px] font-bold">
            <span className="w-1.5 h-1.5 rounded-full bg-brand" />
            باز
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            ['کل رزومه‌ها', '۸'],
            ['در انتظار تصمیم', '۳'],
            ['تطابق بالا', '۲'],
          ].map(([l, v]) => (
            <div key={l} className="rounded-[12px] border border-line-2 bg-canvas px-3 py-2">
              <p className="text-[10.5px] text-ink-3">{l}</p>
              <p className="text-[17px] font-extrabold text-ink hv-num">{v}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-col divide-y divide-line-2">
          {MOCK_ROWS.map((r, i) => (
            <div key={r.name} className={`flex items-center gap-3 py-2.5 ${i === 0 ? 'bg-brand-soft/60 -mx-2 px-2 rounded-[10px]' : ''}`}>
              <Monogram name={r.name} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-[12.5px] font-bold text-ink truncate">{r.name}</p>
                <p className="text-[11px] text-ink-3 truncate">{r.role}</p>
              </div>
              <MatchPill category={r.cat} size="sm" className="max-sm:hidden" />
              <MatchMeter score={r.score} category={r.cat} className="w-[110px]" thin />
            </div>
          ))}
        </div>
      </div>
      <div className="hidden sm:block absolute -bottom-10 -left-4 lg:-left-10 w-[260px] hv-card shadow-pop p-4 rounded-[18px] animate-pop-in">
        <div className="flex items-center gap-3 mb-3">
          <Monogram name="سارا محمدی" size={38} />
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-bold text-ink">سارا محمدی</p>
            <p className="text-[11px] text-ink-3">۶ سال سابقه</p>
          </div>
          <ScoreBadge score={88} category="INTERVIEW" size={46} />
        </div>
        <p className="text-[12px] font-bold text-ink mb-1.5">دلایل تطابق</p>
        {['سابقه تخصصی جذب در محیط صنعتی', 'کاهش زمان استخدام با عدد'].map((t) => (
          <p key={t} className="flex items-start gap-1.5 text-[11.5px] text-ink-2 leading-relaxed">
            <CheckCircle2 className="w-3.5 h-3.5 text-high mt-[3px] shrink-0" />
            {t}
          </p>
        ))}
        <p className="text-[12px] font-bold text-ink mt-2 mb-1">نکات قابل بررسی</p>
        <p className="text-[11.5px] text-ink-2">فاصله کوتاه بین دو شغل آخر</p>
      </div>
    </div>
  );
}

function Feature({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="hv-card p-5">
      <span className="w-11 h-11 rounded-[12px] bg-brand-soft text-brand-strong flex items-center justify-center mb-4">
        <Icon className="w-[22px] h-[22px]" strokeWidth={1.7} />
      </span>
      <h3 className="text-[15px] font-bold text-ink">{title}</h3>
      <p className="text-[13px] text-ink-3 mt-1.5 leading-[1.9]">{text}</p>
    </div>
  );
}

export default function Landing() {
  useTitle(null);
  const { status } = useAuth();
  const demo = useDemoLogin();
  const authed = status === 'authed';

  return (
    <div className="min-h-screen bg-surface text-ink" dir="rtl">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-surface/90 backdrop-blur border-b border-line-2">
        <div className="max-w-[1200px] mx-auto px-5 h-16 sm:h-[72px] flex items-center gap-6">
          <Link to="/" aria-label="هویدا">
            <HovidaLogo height={32} />
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-[14px] font-semibold text-ink-2">
            <a href="#features" className="hover:text-ink">
              امکانات
            </a>
            <a href="#how" className="hover:text-ink">
              روش کار
            </a>
            <a href="#trust" className="hover:text-ink">
              اعتماد و امنیت
            </a>
          </nav>
          <div className="mr-auto flex items-center gap-2">
            {authed ? (
              <ButtonLink to="/app" iconEnd={ArrowLeft}>
                ورود به فضای کاری
              </ButtonLink>
            ) : (
              <>
                <ButtonLink to="/login" variant="ghost" className="max-sm:hidden">
                  ورود
                </ButtonLink>
                <ButtonLink to="/signup">ساخت فضای کاری</ButtonLink>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="max-w-[1200px] mx-auto px-5 pt-12 sm:pt-16 pb-20 lg:pb-28 grid lg:grid-cols-[1.05fr_1fr] gap-14 lg:gap-12 items-center">
          <div>
            <Chip tone="brand" icon={Sparkles} className="h-7 px-3 text-[12.5px]">
              تحلیل هوشمند رزومه برای تیم‌های منابع انسانی
            </Chip>
            <h1 className="mt-5 text-[34px] sm:text-[46px] lg:text-[52px] font-black leading-[1.35] tracking-[-0.01em]">
              آنچه مهم است،
              <br />
              <span className="text-brand-strong">روشن می‌شود.</span>
            </h1>
            <p className="mt-5 text-[16px] sm:text-[18px] text-ink-2 leading-[1.95] max-w-[540px]">
              تحلیل هوشمند رزومه‌ها برای تصمیم‌های بهتر در منابع انسانی. هویدا هر رزومه را با معیارهای همان فرصت شغلی می‌سنجد، برای هر
              امتیاز شاهدی از متن رزومه می‌آورد و تصمیم نهایی را به شما می‌سپارد.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {authed ? (
                <ButtonLink to="/app" size="lg" iconEnd={ArrowLeft}>
                  ادامه در فضای کاری
                </ButtonLink>
              ) : (
                <>
                  <ButtonLink to="/signup" size="lg" iconEnd={ArrowLeft}>
                    ساخت فضای کاری سازمان
                  </ButtonLink>
                  <Button size="lg" variant="secondary" icon={Sparkles} onClick={demo.start} loading={demo.loading}>
                    ورود به نسخه نمایشی
                  </Button>
                </>
              )}
            </div>
            <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-ink-3">
              {['تصمیم نهایی همیشه با شماست', 'داده‌های هر سازمان جداگانه', 'فارسی، شمسی و راست‌به‌چپ'].map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4 text-brand" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="lg:pl-6">
            <ProductMock />
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="bg-canvas border-y border-line-2">
        <div className="max-w-[1200px] mx-auto px-5 py-16 grid md:grid-cols-3 gap-4">
          <Feature
            icon={Target}
            title="دقت در تحلیل"
            text="هر رزومه با معیارهای وزن‌دار همان فرصت شغلی سنجیده می‌شود و برای هر معیار، نقل‌قولی مستقیم از رزومه به‌عنوان شاهد ثبت می‌شود."
          />
          <Feature
            icon={Timer}
            title="صرفه‌جویی در زمان"
            text="به‌جای خواندن ده‌ها رزومه از ابتدا تا انتها، با فهرستی مرتب‌شده بر اساس میزان تطابق و خلاصه‌ای کوتاه از هر کاندید شروع کنید."
          />
          <Feature
            icon={Scale}
            title="تصمیم‌گیری آگاهانه"
            text="دلایل تطابق و نکات قابل بررسی کنار هم دیده می‌شوند؛ کاندیداها را کنار هم مقایسه کنید و تصمیم خود را با یادداشت ثبت کنید."
          />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="max-w-[1200px] mx-auto px-5 py-20">
        <div className="max-w-[640px]">
          <p className="text-[13px] font-bold text-brand-ink">روش کار</p>
          <h2 className="text-[28px] sm:text-[32px] font-extrabold mt-2 leading-snug">سه قدم تا فهرستی روشن از بهترین کاندیداها</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-5 mt-10">
          {[
            {
              icon: BriefcaseBusiness,
              title: 'فرصت شغلی را تعریف کنید',
              text: 'دپارتمان و عنوان شغل را بنویسید؛ هویدا معیارهای وزن‌دار و چند پرسش ساده چک‌باکسی پیشنهاد می‌دهد که می‌توانید ویرایششان کنید.',
            },
            {
              icon: UploadCloud,
              title: 'رزومه‌ها را بارگذاری کنید',
              text: 'PDF، Word، تصویر اسکن‌شده یا یک فایل ZIP. تحلیل در پس‌زمینه انجام می‌شود و هر زمان می‌توانید رزومه تازه اضافه کنید.',
            },
            {
              icon: FileCheck2,
              title: 'با شواهد تصمیم بگیرید',
              text: 'فهرست بر اساس میزان تطابق مرتب می‌شود. دلایل، نکات قابل بررسی و فایل اصلی را ببینید و تأیید، رد یا بررسی بیشتر را ثبت کنید.',
            },
          ].map((s, i) => (
            <div key={s.title} className="relative hv-card p-6">
              <span className="absolute top-5 left-5 text-[40px] font-black text-line-2 leading-none hv-num">{(i + 1).toLocaleString('fa-IR')}</span>
              <span className="w-11 h-11 rounded-[12px] bg-brand-strong text-white flex items-center justify-center mb-4">
                <s.icon className="w-[21px] h-[21px]" strokeWidth={1.8} />
              </span>
              <h3 className="text-[16px] font-bold">{s.title}</h3>
              <p className="text-[13.5px] text-ink-3 mt-2 leading-[1.9]">{s.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Evidence */}
      <section className="bg-canvas border-y border-line-2">
        <div className="max-w-[1200px] mx-auto px-5 py-20 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-[13px] font-bold text-brand-ink">شواهد، نه حدس</p>
            <h2 className="text-[28px] sm:text-[32px] font-extrabold mt-2 leading-snug">هوش مصنوعی پیشنهاد می‌دهد؛ شما تصمیم می‌گیرید.</h2>
            <p className="text-[15px] text-ink-2 mt-4 leading-[1.95]">
              هویدا هرگز نمی‌گوید «استخدام کنید» یا «رد کنید». فقط میزان تطابق را با یکی از چهار برچسب روشن توصیف می‌کند و دلیلش را از متن
              خود رزومه نشان می‌دهد. وقتی اطلاعات کافی نیست، صادقانه می‌گوید «اطلاعات ناکافی».
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <MatchPill category="INTERVIEW" />
              <MatchPill category="REVIEW" />
              <MatchPill category="REJECT" />
              <MatchPill category="UNJUDGEABLE" />
            </div>
            <ul className="mt-7 flex flex-col gap-3 text-[14px] text-ink-2">
              {[
                'نام، جنسیت، سن و وضعیت تأهل هیچ اثری در امتیاز ندارد.',
                'وقتی هوش مصنوعی در دسترس نیست، نتیجه با برچسب «تحلیل محلی» از نتیجه هوشمند جدا می‌شود.',
                'برای رزومه‌های حساس، «بازبینی دقیق» فایل اصلی را بند به بند دوباره می‌خواند.',
              ].map((t) => (
                <li key={t} className="flex items-start gap-2.5">
                  <CheckCircle2 className="w-[18px] h-[18px] text-brand mt-0.5 shrink-0" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div className="hv-card p-5 sm:p-6 shadow-raise">
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-[15px] font-extrabold">فاطمه نجفی</p>
                <p className="text-[12px] text-ink-3">حسابدار ارشد · ۹ سال سابقه</p>
              </div>
              <ScoreBadge score={91} category="INTERVIEW" />
            </div>
            <p className="text-[13px] font-bold mb-2.5 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-high" />
              دلایل تطابق
            </p>
            {[
              ['تسلط بر حسابداری بهای تمام‌شده', '«استقرار سیستم بهای تمام‌شده استاندارد در کارخانه»'],
              ['آشنایی با سامانه مودیان', '«راه‌اندازی صدور صورتحساب الکترونیکی در سامانه مودیان»'],
            ].map(([p, q]) => (
              <div key={p} className="mb-3 pr-6">
                <p className="text-[13.5px] font-semibold">{p}</p>
                <p className="text-[12.5px] text-ink-3 mt-0.5">{q}</p>
              </div>
            ))}
            <p className="text-[13px] font-bold mb-2 mt-4 flex items-center gap-1.5">
              <span className="w-4 h-4 rounded-full bg-review-soft text-review-ink text-[10px] font-black flex items-center justify-center">!</span>
              نکات قابل بررسی
            </p>
            <div className="pr-6">
              <p className="text-[13.5px] font-semibold">حقوق درخواستی در سقف بازه</p>
              <p className="text-[12.5px] text-ink-3 mt-0.5">«حقوق درخواستی: ۵۵ میلیون تومان»</p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-[1200px] mx-auto px-5 py-20">
        <div className="max-w-[640px]">
          <p className="text-[13px] font-bold text-brand-ink">امکانات</p>
          <h2 className="text-[28px] sm:text-[32px] font-extrabold mt-2 leading-snug">هر آنچه تیم جذب برای یک تصمیم روشن نیاز دارد</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
          <Feature icon={ListChecks} title="معیار اختصاصی هر فرصت" text="معیارهای وزن‌دار و پرسش‌نامه ساده برای هر فرصت شغلی، قابل ویرایش پیش از شروع تحلیل." />
          <Feature icon={Columns3} title="مقایسه کنار هم" text="تا چهار کاندید یک فرصت را معیار به معیار، با سابقه، تحصیلات و مهارت‌ها کنار هم ببینید." />
          <Feature icon={Archive} title="بانک استعداد" text="کاندیداهای ارزشمند را برای فرصت‌های آینده با یادداشت و برچسب نگه دارید." />
          <Feature icon={BarChart3} title="گزارش‌های روشن" text="روند رزومه‌های دریافتی، توزیع تطابق، عملکرد دپارتمان‌ها و قیف تصمیم‌گیری." />
          <Feature icon={MessageSquareText} title="پیام‌های آماده" text="پیش‌نویس دعوت به مصاحبه، درخواست اطلاعات یا اعلام نتیجه با امضای سازمان شما." />
          <Feature icon={UsersRound} title="کار تیمی" text="اعضای تیم با نقش مدیر یا عضو؛ هر تصمیم با نام تصمیم‌گیرنده و زمان ثبت می‌شود." />
          <Feature icon={Languages} title="فارسی‌محور" text="تاریخ شمسی، اعداد فارسی، نیم‌فاصله و جست‌وجویی که به «ی/ي» و فاصله حساس نیست." />
          <Feature icon={CalendarDays} title="همیشه در دسترس" text="روی دسکتاپ و موبایل؛ تحلیل در پس‌زمینه ادامه دارد و پایان آن اطلاع داده می‌شود." />
        </div>
      </section>

      {/* Trust */}
      <section id="trust" className="bg-[#1f2a23] text-white">
        <div className="max-w-[1200px] mx-auto px-5 py-20 grid lg:grid-cols-[1fr_1.2fr] gap-12">
          <div>
            <p className="text-[13px] font-bold text-[#7ee29a]">اعتماد و امنیت</p>
            <h2 className="text-[28px] sm:text-[32px] font-extrabold mt-2 leading-snug">داده‌های کاندیداها امانت شماست.</h2>
            <p className="text-[15px] text-white/70 mt-4 leading-[1.95]">
              هر سازمان فضای کاری جداگانه دارد و هیچ داده‌ای بین سازمان‌ها دیده نمی‌شود. موتور هوش مصنوعی را مدیر سامانه انتخاب می‌کند:
              Gemini یا سرویس‌های سازگار با OpenAI، از جمله درگاه‌های داخلی.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {[
              { icon: ShieldCheck, t: 'جداسازی کامل داده‌ها', d: 'هر درخواست فقط به داده‌های سازمان خودش دسترسی دارد.' },
              { icon: KeyRound, t: 'رمزنگاری رمز عبور', d: 'رمزها با scrypt نگهداری می‌شوند و نشست‌ها قابل ابطال‌اند.' },
              { icon: Lock, t: 'پیوندهای کوتاه‌عمر', d: 'فایل رزومه فقط با پیوند امضاشده و ده‌دقیقه‌ای باز می‌شود.' },
              { icon: Trash2, t: 'حذف واقعی', d: 'با حذف رزومه یا فرصت شغلی، فایل اصلی هم برای همیشه پاک می‌شود.' },
            ].map((x) => (
              <div key={x.t} className="rounded-[16px] border border-white/10 bg-white/[0.04] p-5">
                <x.icon className="w-6 h-6 text-[#7ee29a]" strokeWidth={1.7} />
                <p className="text-[15px] font-bold mt-3">{x.t}</p>
                <p className="text-[13px] text-white/65 mt-1.5 leading-relaxed">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-[1200px] mx-auto px-5 py-20">
        <div className="rounded-[28px] bg-brand-soft px-6 sm:px-12 py-12 sm:py-14 flex flex-col lg:flex-row items-center gap-8 text-center lg:text-right">
          <HovidaMark size={72} />
          <div className="flex-1">
            <h2 className="text-[26px] sm:text-[30px] font-extrabold leading-snug">همین امروز روشن‌تر تصمیم بگیرید.</h2>
            <p className="text-[15px] text-ink-2 mt-2">فضای کاری سازمان خود را بسازید یا نسخه نمایشی را با داده‌های نمونه ببینید.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-3">
            {!authed && (
              <Button size="lg" variant="secondary" icon={Sparkles} onClick={demo.start} loading={demo.loading}>
                نسخه نمایشی
              </Button>
            )}
            <ButtonLink to={authed ? '/app' : '/signup'} size="lg" iconEnd={ArrowLeft}>
              {authed ? 'ورود به فضای کاری' : 'ساخت فضای کاری'}
            </ButtonLink>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line-2">
        <div className="max-w-[1200px] mx-auto px-5 py-10 flex flex-col md:flex-row items-center md:items-start justify-between gap-6">
          <div className="text-center md:text-right">
            <HovidaLogo height={30} />
            <p className="text-[13.5px] font-semibold text-ink-2 mt-3">هویدا • تحلیل دقیق‌تر، تصمیم بهتر</p>
            <p className="text-[12.5px] text-ink-3 mt-1">هویدا، همیشه یک قدم جلوتر</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-5 text-[13px] text-ink-3">
            <Link to="/login" className="hover:text-ink">
              ورود
            </Link>
            <Link to="/signup" className="hover:text-ink">
              ساخت فضای کاری
            </Link>
            <a href="#trust" className="hover:text-ink">
              امنیت
            </a>
            <span className="inline-flex items-center gap-1">
              <Users className="w-3.5 h-3.5" /> ساخته‌شده برای تیم‌های منابع انسانی ایران
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

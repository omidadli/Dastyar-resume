// ================================================================
// «پورتال دوزبانه» — the public career page in Persian and English.
//
// The portal is often the only page a candidate ever sees, and half the good
// candidates for an Iranian company read English more comfortably than Persian
// (or are outside Iran). The chrome is therefore translated here, while the job
// text itself stays in the language the recruiter wrote — an employer's words are
// never replaced by a machine translation behind their back. When a posting has
// no English version the page says so, in one honest line.
// ================================================================
import type { PortalLang } from '../types/careers';

type Dict = Record<string, string>;

const FA: Dict = {
  portal: 'فرصت‌های شغلی',
  languageName: 'فارسی',
  switchTo: 'English',
  openRoles: '{n} فرصت شغلی منتشرشده',
  noRolesHere: 'در حال حاضر فرصت شغلی منتشرشده‌ای نداریم.',
  noRolesTitle: 'به‌زودی فرصت‌های تازه این‌جا منتشر می‌شود',
  noRolesNote: 'می‌توانید بعداً دوباره سر بزنید.',
  deadline: 'مهلت',
  applyBy: 'مهلت درخواست',
  allRoles: 'همهٔ فرصت‌ها',
  notFoundTitle: 'این صفحهٔ استخدام در دسترس نیست',
  notFoundNote: 'نشانی را بررسی کنید یا با واحد منابع انسانی سازمان تماس بگیرید.',
  jobClosedTitle: 'این فرصت شغلی منتشر نشده است',
  aboutRole: 'دربارهٔ این نقش',
  requirements: 'آنچه مهم است',
  descriptionFallback: 'توضیحات این فرصت شغلی به‌زودی کامل می‌شود.',
  processTitle: 'دربارهٔ روند بررسی',
  processBody:
    'رزومهٔ شما با هوش مصنوعی و بر پایهٔ نیازهای همین نقش بررسی می‌شود؛ هیچ تصمیمی بدون بازبینی همکاران منابع انسانی گرفته نمی‌شود. اگر هم‌خوانی باشد، برای هماهنگی مصاحبه با شما تماس می‌گیریم.',
  sentTitle: 'درخواست شما ثبت شد',
  sendAnother: 'ارسال درخواست دیگر',
  expiredTitle: 'مهلت درخواست این فرصت تمام شده است',
  expiredWithDate: 'آخرین روز دریافت درخواست {date} بود.',
  expiredNoDate: 'این فرصت دیگر درخواست نمی‌پذیرد.',
  expiredLookAround: 'اگر فرصت‌های دیگری داریم، از فهرست ببینید.',
  applyTitle: 'ارسال درخواست',
  applyNote: 'چند دقیقه وقت می‌گیرد. اطلاعات فقط برای همین فرصت شغلی بررسی می‌شود.',
  name: 'نام و نام خانوادگی',
  email: 'ایمیل',
  emailHint: 'برای پاسخ، دست‌کم ایمیل یا موبایل لازم است.',
  phone: 'موبایل',
  city: 'شهر',
  fileChoose: 'انتخاب فایل رزومه (PDF، Word، تصویر، حداکثر ۸ مگابایت)',
  fileChosen: 'فایل انتخاب‌شده: {name}',
  fileRemove: 'برداشتن فایل',
  pastePlaceholder: 'یا متن رزومه را این‌جا بچسبانید…',
  aboutYourself: 'چند خط دربارهٔ خودتان (اختیاری)',
  aboutYourselfHint: 'مثلاً چرا این نقش برای شما جذاب است یا بازهٔ زمانی شروع همکاری.',
  heardFrom: 'چطور با ما آشنا شدید؟',
  heardFromOptional: 'انتخاب کنید (اختیاری)',
  fromPortal: 'پورتال شغلی',
  fromReferral: 'معرفی یکی از همکاران',
  fromSocial: 'شبکه‌های اجتماعی',
  fromSite: 'سایت سازمان',
  fromOther: 'سایر',
  refNote: 'شما از طرف «{ref}» به این صفحه آمده‌اید.',
  consent: 'موافقم رزومه‌ام برای بررسی همین فرصت شغلی نگه‌داری شود و در صورت نیاز همکاران منابع انسانی با من تماس بگیرند.',
  submit: 'ارسال درخواست',
  submitNote: 'رزومهٔ شما بلافاصله بررسی می‌شود؛ نتیجهٔ بررسی برای تیم منابع انسانی سازمان نمایش داده می‌شود.',
  errConsent: 'برای ارسال درخواست، تأیید نگه‌داری اطلاعات الزامی است.',
  errResume: 'رزومهٔ خود را بارگذاری کنید یا متن آن را بچسبانید.',
  errSize: 'حجم فایل بیش از {n} مگابایت است؛ فایل کوچک‌تری انتخاب کنید.',
  errGeneric: 'ارسال درخواست ممکن نشد؛ کمی بعد دوباره تلاش کنید.',
  footer: 'این صفحه با HOVIDA ساخته شده است؛ درخواست شما فقط به واحد منابع انسانی {org} می‌رسد.',
  originalNotice: 'این آگهی به فارسی نوشته شده است؛ متن اصلی کارفرما را می‌بینید.',
  eeoTitle: 'برابری فرصت‌ها (داوطلبانه و بی‌نام)',
  eeoNote: 'پاسخ‌های شما فقط برای بررسی منصفانه بودن فرایند استفاده می‌شود، در پروندهٔ بررسی‌شدهٔ شما کنار نامتان دیده نمی‌شود و هیچ تأثیری بر تصمیم ندارد. هر سه پرسش را می‌توانید بی‌پاسخ بگذارید.',
  eeoGender: 'جنسیت',
  eeoAge: 'گروه سنی',
  eeoDisability: 'معلولیت یا بیماری مزمن',
  eeoWoman: 'زن',
  eeoMan: 'مرد',
  eeoOther: 'دیگر / ترجیح می‌دهم توضیح ندهم',
  eeoDecline: 'ترجیح می‌دهم نگویم',
  eeoYes: 'بله',
  eeoNo: 'خیر',
  eeoAgeUnder25: 'زیر ۲۵ سال',
  eeoAge55: '۵۵ سال و بیشتر',
};

const EN: Dict = {
  portal: 'Careers',
  languageName: 'English',
  switchTo: 'فارسی',
  openRoles: '{n} open role(s)',
  noRolesHere: 'There are no open roles right now.',
  noRolesTitle: 'New roles will be published here soon',
  noRolesNote: 'You are welcome to check back later.',
  deadline: 'Apply by',
  applyBy: 'Apply by',
  allRoles: 'All roles',
  notFoundTitle: 'This careers page is not available',
  notFoundNote: 'Check the address, or contact the company’s HR team.',
  jobClosedTitle: 'This role is not published',
  aboutRole: 'About this role',
  requirements: 'What matters',
  descriptionFallback: 'The description of this role will be completed soon.',
  processTitle: 'How your application is reviewed',
  processBody:
    'Your résumé is reviewed against the requirements of this specific role. No decision is made without a human review by the HR team. If there is a match, we will contact you to arrange an interview.',
  sentTitle: 'Your application was received',
  sendAnother: 'Send another application',
  expiredTitle: 'The application deadline for this role has passed',
  expiredWithDate: 'The last day to apply was {date}.',
  expiredNoDate: 'This role no longer accepts applications.',
  expiredLookAround: 'Have a look at the other roles, if we have any.',
  applyTitle: 'Apply',
  applyNote: 'It takes a couple of minutes. Your details are used only for this role.',
  name: 'Full name',
  email: 'Email',
  emailHint: 'An email or a mobile number is needed so we can reply.',
  phone: 'Mobile',
  city: 'City',
  fileChoose: 'Choose your résumé file (PDF, Word, image, up to 8 MB)',
  fileChosen: 'Selected file: {name}',
  fileRemove: 'Remove file',
  pastePlaceholder: 'Or paste your résumé text here…',
  aboutYourself: 'A few lines about you (optional)',
  aboutYourselfHint: 'For example, why this role interests you or when you could start.',
  heardFrom: 'How did you hear about us?',
  heardFromOptional: 'Choose (optional)',
  fromPortal: 'Careers page',
  fromReferral: 'A colleague referred me',
  fromSocial: 'Social networks',
  fromSite: 'The company website',
  fromOther: 'Other',
  refNote: 'You arrived here through “{ref}”.',
  consent: 'I agree that my résumé is kept for this role and that the HR team may contact me if needed.',
  submit: 'Submit application',
  submitNote: 'Your résumé is reviewed immediately; the outcome is shown to this company’s HR team.',
  errConsent: 'Please agree to the retention of your details before submitting.',
  errResume: 'Attach your résumé or paste its text.',
  errSize: 'The file is larger than {n} MB; please choose a smaller one.',
  errGeneric: 'The application could not be sent; please try again shortly.',
  footer: 'This page is built with HOVIDA; your application goes only to the HR team of {org}.',
  originalNotice: 'This posting was written in Persian; the employer’s original text is shown.',
  eeoTitle: 'Equal opportunity (voluntary and anonymous)',
  eeoNote: 'Your answers are used only to check whether the process is fair. They are never shown next to your name to a reviewer and never affect a decision. All three questions are optional.',
  eeoGender: 'Gender',
  eeoAge: 'Age group',
  eeoDisability: 'Disability or chronic illness',
  eeoWoman: 'Woman',
  eeoMan: 'Man',
  eeoOther: 'Other / prefer to self-describe',
  eeoDecline: 'Prefer not to say',
  eeoYes: 'Yes',
  eeoNo: 'No',
  eeoAgeUnder25: 'Under 25',
  eeoAge55: '55 and over',
};

const DICTS: Record<PortalLang, Dict> = { fa: FA, en: EN };

/** `t('openRoles', { n: 3 })` — `{n}` style placeholders, no template strings. */
export function t(lang: PortalLang, key: string, vars?: Record<string, string | number>): string {
  let out = DICTS[lang][key] ?? DICTS.fa[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  return out;
}

/** Digits follow the language: ۳ فرصت for Persian, 3 roles for English. */
export function portalNumber(lang: PortalLang, n: number): string {
  return lang === 'en' ? n.toLocaleString('en-US') : n.toLocaleString('fa-IR');
}

export const PORTAL_DIR: Record<PortalLang, 'rtl' | 'ltr'> = { fa: 'rtl', en: 'ltr' };

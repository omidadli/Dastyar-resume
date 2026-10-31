# API هویدا و وب‌هوک خروجی

این سند همان چیزی است که در **تنظیمات › توسعه‌دهندگان** ساخته و مدیریت می‌شود. دو راه برای اتصال سامانه‌های دیگر:

| راه | چه کاری می‌کند | مناسب برای |
| --- | --- | --- |
| **API (کشش)** | سامانهٔ شما با یک کلید، فرصت‌ها و کارجوها را می‌خواند و در صورت نیاز تصمیم ثبت می‌کند | HRIS، داشبورد داخلی، گزارش‌ساز، افزونهٔ اکسل/پاوربی‌آی |
| **وب‌هوک (هل)** | هویدا در لحظهٔ وقوعِ رویداد یک درخواست JSON امضاشده به سامانهٔ شما می‌فرستد | اطلاع‌رسانی به HRIS، ساخت تیکت، پیام به کانال داخلی |

هر دو به **همین فضای کاری** تعلق دارند، از همان صفحه ساخته می‌شوند و با یک کلیک باطل/حذف می‌شوند.

---

## ۱) کلید API

### ساخت

تنظیمات › توسعه‌دهندگان › **کلیدهای API** › نام و دسترسی را انتخاب کنید › «ساخت کلید».

کلید **فقط یک بار** نمایش داده می‌شود و در سرور تنها **هش SHA-256** آن ذخیره است. اگر گم شد، کلید تازه بسازید و قدیمی را باطل کنید.

```
hvd_sk_9f2c1ab4d7e05c63_Xy7Q2m...        ← کلید کامل (فقط همان لحظه)
hvd_sk_9f2c1ab4d7e05c63••••••            ← آنچه بعداً در فهرست می‌بینید
```

### دسترسی‌ها

| محدوده | کارهایی که مجاز است |
| --- | --- |
| `read` | خواندن فرصت‌ها و کارجوها |
| `write` | همان + ثبت تصمیم (`approved` / `rejected` / `review` / `none`) |

هیچ کلیدی نمی‌تواند ایمیل بفرستد، فایل رزومه را پاک کند، یا عضو تیم اضافه کند. این کارها فقط از داخل برنامه و توسط یک انسان انجام می‌شود.

### فرستادن کلید

```bash
curl -H "Authorization: Bearer hvd_sk_…" https://hovida.example.ir/api/v1/jobs
```

سرآیند `X-Hovida-Api-Key: hvd_sk_…` هم پذیرفته می‌شود (برای پروکسی‌هایی که `Authorization` را حذف می‌کنند).

### محدودیت‌ها

* ۶۰۰ درخواست در دقیقه برای هر کلید (پاسخ `429` با `Retry-After: 60`).
* حداکثر ۲۰ کلید فعال در هر فضای کاری.
* هر درخواست در ستون «تعداد درخواست» و «آخرین استفاده» همان کلید ثبت می‌شود.
* تصمیم‌های ثبت‌شده با کلید، در تاریخچهٔ تیم با نام `کلید API «…»` می‌آیند — نه با نام یک نفر.

---

## ۲) مسیرها

نشانی پایه را از همان صفحه بردارید (مثلاً `https://hovida.example.ir/api/v1`). پاسخ‌ها همیشه `apiVersion: 1` دارند و خطاها به شکل `{ "error": "…", "code": "…" }` هستند.

### `GET /v1/health` — بدون کلید

```json
{ "apiVersion": 1, "ok": true, "service": "hovida", "version": "1.0.0", "time": "2026-10-27T08:00:00.000Z" }
```

برای مانیتورینگ بیرونی؛ کلید لازم ندارد و هیچ داده‌ای برنمی‌گرداند.

### `GET /v1/me`

```json
{
  "apiVersion": 1,
  "workspace": { "id": "org_…", "name": "شرکت نمونه" },
  "key": { "id": "9f2c1ab4d7e05c63", "name": "سامانهٔ منابع انسانی", "scopes": ["read", "write"] }
}
```

### `GET /v1/jobs`

پارامتر اختیاری: `status=open|closed|archived` (پیش‌فرض: همه).

```json
{
  "apiVersion": 1,
  "items": [
    {
      "id": "job_…",
      "roleTitle": "کارشناس شبکه",
      "departmentName": "فناوری اطلاعات",
      "location": "تهران",
      "employmentType": "full_time",
      "status": "open",
      "createdAtISO": "2026-10-01T…",
      "updatedAtISO": "2026-10-20T…",
      "stats": { "total": 12, "interview": 4, "review": 3, "reject": 5, "avgScore": 71, "approved": 2, "pending": 5 },
      "stages": [{ "id": "…", "name": "غربالگری", "kind": "screening" }]
    }
  ],
  "total": 1
}
```

### `GET /v1/jobs/:id`

همان شکل، به‌علاوهٔ `extraNotes` و معیارهای غربالگری این فرصت:

```json
"criteria": [{ "id": "c1", "title": "تجربهٔ شبکه", "weight": 40, "mustHave": true }]
```

### `GET /v1/candidates`

| پارامتر | معنی |
| --- | --- |
| `jobId` | فقط کارجویان یک فرصت |
| `departmentId` | فقط یک دپارتمان |
| `q` | جست‌وجوی متنی روی نام/مهارت/سابقه |
| `match` | `all` \| `high` \| `review` \| `low` \| `insufficient` |
| `novelty` | `all` \| `new` \| `duplicate` \| `unknown` |
| `decision` | `all` \| `undecided` \| `pending` \| `approved` \| `rejected` \| `review` |
| `sort` | `match` \| `newest` \| `oldest` \| `experience` \| `name` \| `decided` |
| `page`, `pageSize` | صفحه‌بندی (پیش‌فرض ۲۵، حداکثر ۱۰۰) |

> **اگر فضای کاری «غربالگری بی‌طرف» را روشن کرده باشد**، همان مسیرها نسخهٔ بی‌نام را
> برمی‌گردانند: `name` برابر «کارجوی ۲۴۸۱» و `contact` تهی است. کلید API همان چیزی را
> می‌بیند که مرورگر می‌بیند — پنهان‌سازی در لایهٔ داده است، نه در رابط کاربری.
> جزئیات: [`BLIND-SCREENING.md`](BLIND-SCREENING.md).

```json
{
  "apiVersion": 1,
  "items": [
    {
      "id": "res_…",
      "jobId": "job_…",
      "name": "مینا رضایی",
      "roleTitle": "کارشناس شبکه",
      "score": 82,
      "category": "INTERVIEW",
      "decision": "approved",
      "stageId": "…",
      "source": { "kind": "linkedin", "provider": "apify", "profileUrl": "…" },
      "contact": { "email": "mina@example.ir", "phone": "0912…" },
      "createdAtISO": "…",
      "decidedAtISO": "…"
    }
  ],
  "page": 1, "pageSize": 25, "total": 12, "totalPages": 1
}
```

### `GET /v1/candidates/:id`

تمام رکورد کارجو (`extractedText` حذف می‌شود، بقیه همان چیزی است که برنامه می‌بیند) به‌همراه فرصت:

```json
{ "apiVersion": 1, "candidate": { … }, "job": { "id": "job_…", "roleTitle": "…", "status": "open" } }
```

### `POST /v1/candidates/:id/decision` — نیازمند `write`

```bash
curl -X POST https://hovida.example.ir/api/v1/candidates/res_…/decision \
  -H "Authorization: Bearer hvd_sk_…" \
  -H "Content-Type: application/json" \
  -d '{"status":"approved","note":"تأیید از HRIS"}'
```

* `status` یکی از `approved` / `rejected` / `review` / `none`.
* `note` حداکثر ۴۰۰ کاراکتر (اختیاری).
* پاسخ: `{ "apiVersion": 1, "candidate": { … } }`.
* یک رویداد `decision` در فید تیم ثبت می‌شود و (اگر وب‌هوک مشترک شده باشد) به سامانهٔ شما هم می‌رود.

### کدهای خطا

| کد | HTTP | معنی |
| --- | --- | --- |
| `API_KEY_REQUIRED` | 401 | کلیدی فرستاده نشده |
| `API_KEY_INVALID` | 401 | کلید شناخته نشد |
| `API_KEY_REVOKED` | 401 | کلید باطل شده |
| `SCOPE_REQUIRED` | 403 | کلید `read` نمی‌تواند تصمیم ثبت کند |
| `ORG_SUSPENDED` | 403 | فضای کاری موقتاً متوقف است |
| `JOB_NOT_FOUND` / `CANDIDATE_NOT_FOUND` | 404 | شناسه پیدا نشد |
| `INVALID_STATUS` | 400 | مقدار `status` مجاز نیست |
| `ASSESSMENT_NOT_FOUND` | 404 | آزمون پیدا نشد (یا مال این فضای کاری نیست) |
| `ALREADY_COMPLETED` / `NO_RESULT` / `BAD_SCORE` | 409 / 400 | آزمون پیش‌تر نتیجه دارد، یا نتیجهٔ فرستاده‌شده ناقص/خارج از ۰–۱۰۰ است |
| `RATE_LIMITED` | 429 | بیش از ۶۰۰ درخواست در دقیقه |

---

## ۳) وب‌هوک خروجی

در همان صفحه: نام، نشانی `https://…` و رویدادهای مورد نظر. بلافاصله پس از ثبت، یک رویداد آزمایشی (`ping`) فرستاده می‌شود تا همان‌جا بفهمید اتصال برقرار است یا نه.

### رویدادها

| رویداد | چه وقت فرستاده می‌شود |
| --- | --- |
| `application.received` | درخواست تازه از پورتال شغلی |
| `decision` | تصمیم روی کارجو (تأیید/رد/نیاز به بررسی) |
| `message.sent` | پیام فرستاده‌شده به کارجو |
| `interview.scheduled` | مصاحبهٔ ثبت‌شده |
| `stage.moved` | جابه‌جایی کارجو در تختهٔ جذب |
| `scorecard.added` | کارت ارزیابی تازه |
| `offer.sent` | ارسال پیشنهاد شغلی |
| `offer.accepted` | پذیرش پیشنهاد |
| `offer.declined` | رد پیشنهاد |
| `automation.run` | اجرای اتوماسیون جذب |
| `automation.approved` | تأیید پیشنهاد اتوماسیون |
| `comment.added` | یادداشت تیمی روی کارجو |
| `ping` | فقط هنگام «ارسال آزمایشی» — مشترک‌شدنی نیست |

### بدنهٔ درخواست

```json
{
  "id": "dlv_…",
  "event": "decision",
  "apiVersion": 1,
  "occurredAt": "2026-10-27T08:12:00.000Z",
  "workspace": { "id": "org_…", "name": "شرکت نمونه" },
  "actor": { "id": "usr_…", "name": "مدیر" },
  "message": "«مینا رضایی» را برای «کارشناس شبکه» تأیید کرد",
  "links": { "jobId": "job_…", "candidateId": "res_…" }
}
```

### سرآیندها

```
Content-Type: application/json
User-Agent: Hovida-Webhooks/1
X-Hovida-Event: decision
X-Hovida-Delivery: dlv_…
X-Hovida-Signature: t=1793180528,v1=2bdf205f77ef9ca4…
```

### بررسی امضا (اجباری برای امنیت)

امضا = `HMAC-SHA256(secret, "<t>.<raw-body>")` با کلید مخفی همان وب‌هوک (چهار کاراکتر آخرش در صفحه نمایش داده می‌شود).

**دریافت‌کننده باید:**

1. مقدار `t` را از سرآیند بخواند و اگر بیش از ۵ دقیقه از زمان فعلی گذشته بود، رد کند (جلوگیری از بازپخش).
2. امضا را با **بدنهٔ خام** (پیش از پارس JSON) دوباره حساب کند.
3. مقایسه را زمان‌ثابت انجام دهد.

نمونهٔ Node:

```js
import crypto from 'crypto';

export function verify(rawBody, header, secret, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 || '', 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

نمونهٔ Python:

```python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    if abs(time.time() - int(parts["t"])) > 300:
        return False
    expected = hmac.new(secret.encode(), f'{parts["t"]}.'.encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

### تلاش دوباره و ثبت خطا

* زمان انتظار هر تلاش: ۸ ثانیه.
* خطای شبکه یا پاسخ `5xx`: یک بار دیگر پس از ۴۰۰ میلی‌ثانیه تلاش می‌شود.
* پاسخ `2xx`: موفق. `4xx`: خطای شما (نشانی/امضا) و تلاش دوباره ندارد.
* وضعیت هر ارسال (کد پاسخ، مدت، متن خطا) در «آخرین ارسال‌ها»ی همان صفحه می‌ماند؛ پس از چند خطای پیاپی، نشان قرمز روی همان وب‌هوک ظاهر می‌شود.
* **هیچ رویدادی از دست نمی‌رود، اما هیچ عملی هم به‌خاطر وب‌هوک کند نمی‌شود:** ارسال ناهمگام است و خطای آن هرگز تصمیم یا ارسال ایمیل را متوقف نمی‌کند.

### سرور داخلی و گواهی خودامضا

نشانی وب‌هوک باید `https` باشد. اگر دریافت‌کننده روی شبکهٔ داخلی با `http` است، میزبان آن را در متغیر محیطی سرور اضافه کنید:

```bash
WEBHOOK_ALLOW_HOSTS=hris.internal:8080,10.0.0.14:3000
```

همین متغیر برای وب‌هوک چت (Mattermost / Rocket.Chat) هم استفاده می‌شود. میزبان‌های دیگر همچنان رد می‌شوند.

---

## ۴) نمونهٔ کامل: ثبت کارجو در HRIS

```bash
KEY="hvd_sk_…"
BASE="https://hovida.example.ir/api/v1"

# ۱) فرصت‌های باز
curl -s -H "Authorization: Bearer $KEY" "$BASE/jobs?status=open" | jq '.items[] | {id, roleTitle}'

# ۲) کارجویان تأییدشدهٔ یک فرصت
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/candidates?jobId=job_123&decision=approved&pageSize=100" | jq '.items[] | {name, score, contact}'

# ۳) ثبت تصمیم برای کارجوی دیگری
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"status":"review","note":"نیاز به مصاحبهٔ فنی"}' \
  "$BASE/candidates/res_456/decision" | jq '.candidate.decisionStatus'
```

---

## ۵) کیت مصاحبه (داخل برنامه، نه با کلید API)

```http
GET /api/jobs/<jobId>/interview-kit
GET /api/jobs/<jobId>/interview-kit?resumeId=<resumeId>
GET /api/interview-kit/bank
```

پاسخ `{kit}` با بخش‌ها، زمان پیشنهادی، و برای هر پرسش `listen` و `red` است؛ مسیر
`/api/interview-kit/bank` فهرست بانک را می‌دهد (۳۰ بسته، ۳۰ نقش، ۷۰ پرسش). جزئیات و
نمونه در [`INTERVIEW-KIT.md`](INTERVIEW-KIT.md). این مسیرها نیاز به نشست کاربر دارند و
کلید API به آن‌ها دسترسی ندارد — کیت سرورِ محتواست، نه دادهٔ یکپارچه‌سازی.

---

## ۵ب) عملکرد تیم و هزینهٔ استخدام (داخل برنامه)

```http
GET    /api/reports/team?range=90     → { members, totals, concentration, fastShare }
GET    /api/reports/cost?range=365    → { entries, totals, byKind, hires, perHire, assumption, hours, byJob }
POST   /api/costs                     → { entry }        (مدیر/مالک)
PATCH  /api/costs/:id                 → { entry }        (مدیر/مالک)
DELETE /api/costs/:id                 → { ok }           (مدیر/مالک)
PUT    /api/costs/assumption          → { assumption }   (مدیر/مالک)
```

هزینه و نرخ ساعتی مالی سازمان‌اند: خواندن و نوشتنشان فقط با نقش مدیر یا مالک. گزارش
عملکرد تیم برای همهٔ اعضا باز است. جزئیات، فرمول و نمونه در
[`TEAM-AND-COST.md`](TEAM-AND-COST.md).

---

## ۵ج) ورود سازمانی (SSO با OIDC) — داخل برنامه

```http
GET    /api/auth/sso/lookup?email=sara@company.ir  → { available, orgName, passwordBlocked }   (عمومی)
GET    /api/auth/sso/start?email=…&next=/app/jobs  → 302 به authorization_endpoint            (عمومی)
GET    /api/auth/sso/callback?code=…&state=…       → 302 /app#sso=<token>  یا  /login?sso=…  (عمومی)
GET    /api/org/sso        → { sso }                        (مدیر/مالک)
PUT    /api/org/sso        → { sso }                        (مدیر/مالک)
DELETE /api/org/sso        → { ok }                         (مدیر/مالک)
POST   /api/org/sso/check  → { ok, issuer, message, keys }   (مدیر/مالک؛ هیچ چیز ذخیره نمی‌شود)
```

`/lookup` عمداً فقط سه فیلد برمی‌گرداند — نه فهرست اعضا، نه تنظیمات سازمان — و محدودیت
نرخ دارد. `clientSecret` هرگز در پاسخ نمی‌آید؛ فقط `clientSecretSet: true`. توکن نشست در
fragment بازمی‌گردد و پاسخ callback سرآیند `Referrer-Policy: no-referrer` دارد.
جدول کامل دلیل‌های بازگشت (`?sso=none|misconfigured|provider|expired|off|cancelled|code|denied|failed`)
و ترتیب راه‌اندازی در [`SSO.md`](SSO.md) است.

---

## ۵د) آزمون و ارزیابی (داخل برنامه + قرارداد ارائه‌دهنده)

```http
GET    /api/assessments/templates?jobTitle=…  → { templates, suggestedId }
GET    /api/assessments/templates/:id         → پیش‌نمایش بانک (بدون امتیاز گزینه‌ها)
GET    /api/assessments?resumeId=&jobId=      → { items, summary }
POST   /api/assessments                       → { assessment }   (فقط لینک؛ هیچ ایمیلی نمی‌رود)
POST   /api/assessments/:id/send              → { assessment, emailed }
POST   /api/assessments/:id/cancel            → { assessment }
POST   /api/assessments/:id/result            → { assessment }   (نتیجهٔ ارائه‌دهنده/انسانی)

GET    /api/assessment/public/:token          → { assessment, canAnswer }   (عمومی)
POST   /api/assessment/public/:token/start    → { assessment }
POST   /api/assessment/public/:token/submit   → { assessment, thanks }      (یک‌بار)
```

با کلید API (برای ارائه‌دهندهٔ آزمون):

```http
GET  /api/v1/assessments/:id           (scope: read)
POST /api/v1/assessments/:id/result    (scope: write)  body: { score?, dimensions?, note? }
```

نتیجهٔ بیرونی با `source: "external"` ثبت می‌شود. صفحهٔ عمومی هیچ امتیاز گزینه، هیچ نام
بُعد و هیچ شناسهٔ داخلی دریافت نمی‌کند. جدول کامل، فرمول امتیاز و «چه چیزی این نیست» در
[`ASSESSMENT.md`](ASSESSMENT.md) است.

---

## ۵هـ) گردش تأیید پیشنهاد شغلی (داخل برنامه)

```http
GET   /api/org          → { org, members }                     (org.offerApproval)
PATCH /api/org          body: { offerApproval: { enabled, steps: [{ id, label, approverId }] } }
POST  /api/offers/:id/approval   body: { decision: "approved" | "rejected", note? }
```

تا وقتی یک مرحله «در انتظار» است، `POST /api/offers/:id/send` با
`409 { code: "OFFER_APPROVAL_PENDING" }` و نام همان تأییدکننده برمی‌گردد. زنجیره هنگام
ساخت پیشنهاد روی آن کپی می‌شود. جزئیات و قاعده‌ها در [`OFFER-APPROVAL.md`](OFFER-APPROVAL.md).

---

## ۶) آنچه در این API نیست (و چرا)

| نیست | دلیل |
| --- | --- |
| ارسال ایمیل/پیامک از طریق API | فرستادن پیام به کارجو تصمیم انسانی است؛ فقط از داخل برنامه و با تاریخچهٔ کامل |
| حذف کارجو | حذف دادهٔ شخصی باید از رابط کاربری و با تأیید صریح انجام شود |
| دانلود فایل رزومه | فایل با لینک امضاشده و کوتاه‌عمر سرو می‌شود؛ در API عمومی باز نمی‌شود |
| افزودن عضو یا تغییر نقش | مدیریت هویت از مسیر ورود سازمانی انجام می‌شود |
| کیت مصاحبه | محتوای مصاحبه با نقش و معیار گره خورده و از نشست کاربر ساخته می‌شود؛ برای یکپارچه‌سازی، فهرست بانک را می‌توان از همین مسیر داخلی خواند |

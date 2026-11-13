# «استعلام مرجع» — structured reference checks

Every ATS records *something* about what a candidate's former colleagues said.
Most record it as a free-text note the recruiter types the next morning, which
is exactly where memory and bias live. This one records a **structure**: who was
asked, in what relation, what they scored, in their own words — and whether the
answer came from the referee or from a phone call HR wrote down.

**Where it lives:** `رزومه‌ها → [کارجو] → استعلام مرجع` (`/app/candidates/:id/references`).
**Who sees it:** the hiring team. Never the candidate, never another referee.
**Who can start it:** any member of the workspace — but only after consent.

---

## The order of operations (and why it is that order)

### 1. Consent comes first — and it is a record, not a checkbox

A reference check is personal data about the candidate *and* about a third
person who never signed up for anything. So the API refuses to send or record
anything until an admin or member has recorded consent:

```
POST /api/references/:resumeId/consent  { note }
```

The record keeps **when** it was taken, **who** took it, and a note about how
(«تلفنی، ۱۴۰۳/۰۵/۱۲ — گفت با دو مرجع تماس بگیریم»). Attempts to send or to
record a phone answer before that fail with `409 CONSENT_REQUIRED`, and the page
shows the consent form instead of a greyed-out button that explains nothing.

### 2. The referee answers, not the recruiter

Each referee gets a private link (`/reference/<token>`, no account, no install)
with six questions — a duration, three 1–5 dimensions, one «would you work with
them again?» and two free-text boxes. Three minutes, and a visible way to say no.

| Dimension | What it asks |
|---|---|
| کیفیت کار | Was the work done properly and on time? |
| کار تیمی | Was it easy to work with them? |
| تعهد و وقت‌شناسی | Could you rely on their word and their presence? |
| همکاری دوباره | ۱ «هرگز» … ۵ «حتماً» |

The page never carries the candidate's e-mail, phone, score, stage, notes or
decision — proved at the wire in the test, not just intended.

### 3. Phone calls are allowed — and labelled forever

Many Iranian referees prefer a call. HR can type what they heard with
«ثبت پاسخ تلفنی»; the row is stored as `source: 'phone'` with the recorder's
name, and the UI shows it in a different colour. Nobody can later mistake a
recruiter's summary for a verbatim answer.

### 4. Nothing is decided automatically

The summary is an average plus the referees' own words:

* averages per dimension and for «همکاری دوباره»;
* `needsReview` when any referee answered ۱ or ۲ to «همکاری دوباره» — a flag for
  a human, **never** a rejection;
* a one-line headline in plain Persian.

The candidate's stage and decision are untouched by this feature. The test
asserts exactly that.

---

## Rules that keep it humane and safe

| Rule | Behaviour |
|---|---|
| One answer per referee | A second submit returns `409 ALREADY_ANSWERED`; nothing is merged or overwritten. |
| One reminder, then stop | A second `remind` returns `409 ALREADY_REMINDED`; a referee is doing us a favour, not a lead. |
| Saying no is a complete answer | `decline` closes the link, stores the optional reason, and blocks every future reminder. |
| The link expires (21 days) | An expired token refuses answers with `409 EXPIRED` and the page says to ask for a new link. |
| At most five referees | `TOO_MANY_REFEREES` — two or three is the honest number anyway. |
| No duplicates | The same e-mail cannot be added twice to one candidate. |
| A referee needs a channel | At least an e-mail or a phone number (`CONTACT_REQUIRED`). |
| Shared sending budget | Sending respects the workspace's hourly e-mail limit, like every other path. |
| Blind screening blocks it | A reference call names the candidate out loud, so `BLIND_REVEAL_REQUIRED` until the identity is revealed. |
| Erasure covers referees | A candidate's data-subject request deletes the consent record and every referee row — a third party's phone number and words go with it. |
| Tenant walls | Another workspace gets `404` for the candidate and cannot reach the referee page's internals. |

---

## API

| Method | Path | Who | What |
|---|---|---|---|
| `GET` | `/api/references/:resumeId` | member | consent, referees, summary |
| `POST` | `/api/references/:resumeId/consent` | member | record consent (date + name + note) |
| `POST` | `/api/references/:resumeId/referees` | member | add a referee |
| `PATCH` | `/api/references/referees/:id` | member | edit while unanswered |
| `DELETE` | `/api/references/referees/:id` | member | remove while unanswered |
| `POST` | `/api/references/referees/:id/send` | member | e-mail the private link |
| `POST` | `/api/references/referees/:id/remind` | member | one nudge |
| `POST` | `/api/references/referees/:id/record` | member | record a phone answer |
| `GET` | `/api/reference/public/:token` | public | what the referee may see |
| `POST` | `/api/reference/public/:token/open` | public | mark «باز شد» |
| `POST` | `/api/reference/public/:token/answer` | public | submit once |
| `POST` | `/api/reference/public/:token/decline` | public | say no, politely |

Answers are stored with the candidate and removed with it. The e-mail invitation
uses the workspace's own letterhead (see `docs/BRANDING.md`).

---

## Proof

`npm run test:references` (44 checks) starts the built server with a throwaway
SMTP server and proves: consent gates both sending and phone records (with no
letter leaving); the referee page carries no candidate contact details, scores,
notes or decision; opening is tracked; an answer cannot be submitted twice; a
decline closes the link and blocks reminders; a phone record is labelled with the
recorder's name; averages are honest (5 and 2 → 3.5) and a «با تردید» answer
raises «نیازمند بررسی» **without moving the candidate's stage or decision**; the
referee limit, duplicate and channel validation hold; another workspace cannot
open the candidate; blind mode blocks new referees; and erasing the candidate
kills every referee link.

## Honest limits

| Not done | Why |
|---|---|
| Referee identity verification | We cannot prove the person behind the link is who they claim. The record says who was *invited*, and the summary is one input among many — it is not presented as verified fact. |
| Automated reference outreach at scale | Deliberate: each referee is added by a human, because a reference check is a personal request, not a campaign. |
| Reference checks in the mobile app | The referee page is mobile-first (that part works); the HR side is web-only like the rest of the panel. |

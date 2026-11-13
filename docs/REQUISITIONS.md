# نیازمندسنجی و سرفصل نیرو — requisitions with numbers

Most ATSs let anyone with a login open a job and start hiring. That is how a
company ends up with eleven openings and a headcount plan for three. A
requisition is the control that fixes it: *this role, this many seats, this
salary band, for this reason, approved by this person*.

The competitors that do this are the ones with an HRIS underneath — Personio,
HiBob, SAP SuccessFactors, Workday; Ashby calls it "openings" with hire targets.
Among Iranian products it is close to absent, and where it exists it is a
spreadsheet column. Here it is a first-class record that the rest of the product
respects.

---

## The lifecycle

```
draft ──submit──▶ pending ──approve──▶ approved ──(seats used)──▶ filled
                     │                    │
                     └──reject──▶ rejected│
                                          ├──hold──▶ on_hold ──resume──▶ approved
                                          └──cancel──▶ cancelled (only with zero hires)
```

| Status | What it means |
| --- | --- |
| پیش‌نویس | being written; cannot back an opening |
| در انتظار تأیید | waiting for a named approver; **not usable** by any opening yet |
| تأییدشده | seats granted; openings may attach and publish |
| تکمیل‌شده | every granted seat is filled by an **accepted offer** |
| رد‌شده | with the approver's reason; editable, then resubmittable |
| متوقف | approved but paused (budget review, reorg); no new opening attaches |
| لغو‌شده | closed for good; refused if any hire exists (use «توقف» instead) |

With a chain configured the row is still «در انتظار تأیید» between signatures —
it only becomes «تأییدشده» after the **last** step. See «زنجیرهٔ تأیید» below.

## What is enforced, and where

1. **A draft, pending, rejected, held or filled requisition cannot back an
   opening.** `POST /api/requisitions/:id/jobs` refuses with
   `REQUISITION_NOT_OPEN` and a sentence that says which state it is in.
2. **Department match.** An opening from another department cannot spend this
   headcount (`DEPARTMENT_MISMATCH`) — salary bands and seats belong to a
   department's plan.
3. **An approver may grant fewer seats than asked.** `approvedSlots ≤ slots`; the
   number asked for stays on the record, and the history keeps both with the note
   (`BAD_APPROVED_SLOTS` if someone tries to grant more).
4. **Nobody approves their own request — unless they are the only approver in the
   workspace.** In a one-person workspace the rule would otherwise make hiring
   impossible, so self-approval is allowed *and written into the history* («تنها
   تأییدکنندهٔ فضای کاری، خودِ درخواست‌دهنده بود»), and the page says so before the
   button. The moment a second eligible approver exists, it is a 403 again.
5. **«Filled» is counted, not typed.** Accepted offers on the attached openings
   are the only source. No endpoint accepts a filled number.
6. **A requisition with a hire cannot be cancelled** (`HAS_HIRES`) — the hire is
   history, not a mistake to erase.
7. **Approving requires a reason to exist.** Submitting with fewer than 20
   characters of justification is refused (`JUSTIFICATION_REQUIRED`).

## زنجیرهٔ تأیید — the approval chain

One decision is the default; a workspace that has to split hiring authority (the
manager approves the role, finance approves the cost, the founder approves the
hire) can configure an ordered chain of up to **four** steps:

```json
{
  "chain": [
    { "id": "step-1", "label": "مدیر فنی", "approverId": "usr_…" },
    { "id": "step-2", "label": "مالی", "approverId": "usr_…" }
  ]
}
```

The rules that make it a control rather than a form with more fields:

- **The chain is copied onto the request at submit time.** Editing the setting
  afterwards never rewrites a request already circulating: each request is
  approved by the chain that existed the day it was sent. The copy is on the row
  (`approvals[]`), step by step, so the history cannot drift from the setting.
- **Strictly in order.** Only the step whose turn it is can be decided; an earlier
  approver cannot sign twice, a later one cannot jump the queue (`NOT_APPROVER`,
  with a sentence naming whose turn it is).
- **The request stays «در انتظار تأیید» until the last signature.** Intermediate
  approvals record `step_approved` in the history; only the final one sets
  `status: approved`, `approvedSlots` and the decision's author and date.
- **A step may grant fewer seats, and the reduction cascades.** The ceiling for
  every later step is the smallest number already granted; nobody further down the
  chain can raise it back up (`BAD_APPROVED_SLOTS` names the ceiling).
- **A rejection ends the request there.** That step is `rejected` and every later
  step is written as `skipped` — not left «waiting» on a request nobody will sign.
  Editing the rejected request clears the old signatures; resubmitting asks
  everyone again.
- **The requester never signs their own request**, not even as owner/admin. The
  only exception is the one-person workspace, which is stated on the page and in
  the history.
- **An admin may sign «به‌جای» the named approver** when that person is
  unreachable. The step records `onBehalf: true`, the history says whose place was
  taken, and the decision is attributed to the person who actually signed.
- **The setting is sanitised**: unknown members and duplicate signers are dropped,
  more than four steps are truncated, and an empty label falls back to the
  person's own name rather than rendering a blank chip.

The requisition page draws the chain as a timeline (step, person, status, date,
note, seats granted), with «مرحلهٔ ۲ از ۳» in the header and buttons only for the
person whose turn it is — otherwise the server's own sentence. The list shows the
same progress per row («در انتظار «مالی» — مرحلهٔ ۲ از ۳»), and the inbox names the
one person to chase.

An **empty** `chain` means one decision, exactly as before — the single-decision
path was not replaced, it is the `chain.length === 0` branch.

## The publish gate

`GET/PUT /api/requisitions/settings` — per workspace, **off by default**:

```json
{ "requireApprovedForPublish": true, "approverUserIds": ["usr_…"], "chain": [] }
```

When on, `POST /api/jobs/:id/publish` refuses with:

- `REQUISITION_REQUIRED` — the opening is attached to nothing, and the message
  tells the person to create a requisition and attach it;
- `REQUISITION_NOT_APPROVED` — attached, but the requisition is draft/pending/
  rejected/held;
- `REQUISITION_FILLED` — every granted seat is used.

Existing public openings are untouched: the gate guards *new* publication. That is
stated on the settings card, because a rule that silently unpublishes live
openings would be worse than no rule.

`approverUserIds` names people who may decide even without the admin role; empty
means admins/owners. It applies to the **single-decision** path and to a chain that
has no steps; when a chain exists, the step names the approver and
`approverUserIds` is not consulted. Everyone else sees the queue and the reason,
not the button.

## Money

`saltMin`/`salaryMax` are gross monthly toman, optional but all-or-nothing
(`BAD_SALARY_RANGE` for a reversed band). The record shows the **monthly cost of
the granted seats at the band's mid point** — an estimate, labelled as one, not a
budget commitment. The list header adds the monthly cost of everything still
unfilled, so «what would filling the plan cost» has an answer.

## کنترل بازهٔ حقوق — the offer is checked against the band

A band nobody checks is a number in a drawer. Every door into an offer runs the
same check (`server/offer-band.ts`):

| Door | When it runs |
| --- | --- |
| `POST /api/offers` | creating the draft |
| `PATCH /api/offers/:id` | editing a draft (a carried-over reason only survives while the ceiling is unchanged) |
| `POST /api/offers/:id/revise` | a negotiated new version needs **its own** reason |
| `POST /api/offers/:id/send` | re-checked last: the opening may have been attached to a requisition after the draft was written |

Verdicts, recorded on the offer as `band`:

| status | meaning | behaviour |
| --- | --- | --- |
| `in` | inside the approved band | allowed |
| `above` | above the approved ceiling | **refused (409 `OFFER_ABOVE_BAND`)** unless a written reason (≥ 10 chars) is given; the reason and the author's name are stored, and the event goes to the activity trail |
| `below` | below the approved floor | allowed and **flagged** — usually a typo worth a second look |
| `no_band` | the requisition has no salary numbers | allowed; nothing invented |
| `no_amount` | the offer has no salary figure | allowed; nothing compared |

Annual salaries are converted to monthly before comparing. The refusal carries the
numbers (`code`, ceiling, offer amount) so the dialog asks for a reason instead of
showing a dead end; the candidate's page receives **no band data at all**. The
requisition page lists the over-band offers with their reasons, next to the cost.

## Where it shows up

- **Sidebar → «نیازمندسنجی»** (`/app/requisitions`): rollup (approved / filled /
  remaining seats, waiting decisions, monthly open cost), a per-department table,
  filters, and a capacity bar per request.
- **`/app/requisitions/:id`**: the reason and the money before the buttons, the
  seats asked for vs granted, attached openings, and the full history with names.
- **«کارتابل تأیید»** gains a «نیازمندسنجی» queue. It does **not** decide there:
  the row links to the requisition page, where the justification, the band and the
  remaining seats are on screen (`canAct: false` with that reason).
- **On the opening itself** — «ایجاد فرصت شغلی» step 1 and the «نیازمندسنجی» tab of
  `/app/jobs/:id`:
  - creating an opening can attach a requisition in the same request; the check
    runs **before** anything is written, so a refused link never leaves a
    half-made opening behind;
  - the tab shows the seat being spent (code, granted seats, filled, remaining,
    who approved it and when), lets you switch or detach, and links to the
    requisition;
  - the picker lists **every** requisition of that department. Ones that cannot be
    used are shown with the server's own sentence
    (`REQUISITION_NOT_OPEN` / «وضعیت … سرفصل باز ندارد») instead of a silent grey
    row or, worse, disappearing;
  - the workspace's publishing rule is printed on the tab either way — when it is
    off it says «این فضا سخت‌گیری نمی‌کند», and when it blocks, the refusal is the
    server's (`REQUISITION_REQUIRED`), shown before you press publish.

  Attaching from the job **detaches the previous one only after the new target
  passes** its own checks — a refused switch leaves the opening where it was.
  Several openings may spend one requisition: it is a pool of seats, and seats are
  closed by accepted offers, not by counting job records.

## Privacy / tenancy

Requisitions are internal records: no candidate data, no letter leaves the
workspace. Every endpoint is scoped to the workspace (404 across tenants),
settings are admin-only, and the whole set is deleted with the workspace.

## Activity trail

`requisition.created` · `requisition.updated` · `requisition.submitted` ·
`requisition.approved` · `requisition.rejected` · `requisition.settings`

## Tests

`npm run test:requisition-chain` — 74 checks: sanitising the chain (unknown
member, duplicate signer, blank label, five steps truncated), the chain copied at
submit and **not** rewritten when the setting changes mid-flight, «مرحلهٔ ۱ از ۳»,
the requester refused, a later step refused with the name of the current one, an
admin acting «به‌جای» with the note in the history, a step granting fewer seats and
the ceiling cascading, the request staying pending until the last signature, the
default on each step being the ceiling, the inbox naming the right person, a
rejection turning later steps into `skipped`, editing-and-resubmitting asking
everyone again, an emptied chain keeping the old single decision, and tenant walls.

`npm run test:requisitions` — 67 checks against the built server: validation,
submit-without-reason, self-approval refused *and* the one-person exception,
granting fewer seats, granting more refused, attaching to unapproved/over-full
requisitions, department mismatch, the publish gate in all three refusal modes,
counting a real accepted offer into «filled», rollup arithmetic, hold/resume,
cancel-with-hire refused, the inbox row, tenant walls, admin-only settings.

`npm run test:job-requisition` — 48 checks from the *opening's* side: a draft
refused with no job created, the same after approval, wrong department and unknown
id, the job payload (attached row, department-only options, the gate flag), two
openings sharing one pool, the publish gate refusing and then passing, the refusal
that keeps the old link, detach, member can link, tenant walls.

`npm run test:offer-band` — 31 checks: no requisition means no verdict, in-band and
below-floor, refusal above the ceiling with both numbers on the response, a
two-word reason rejected, the reason carrying over edits, the reason *not*
carrying over a raised ceiling, annual conversion, an offer with no number, the
send re-check when the opening is attached after the draft, a negotiated version
needing its own reason, no band on the candidate's page, and the over-band list on
the requisition.

## Not done yet — by choice

- **Parallel or conditional steps** (approve by finance only when the band is
  above a threshold, or two people at once). The chain is a fixed ordered list on
  purpose: a condition nobody can see on the page is a rule nobody trusts.
- **A real department budget with burn-down.** We show the cost of the plan; we do
  not claim to know a budget nobody typed in.
- **Blocking (rather than recording) an over-band offer.** We refuse it until a
  human writes why; we do not refuse it forever. A hard ceiling needs a policy
  decision the workspace has not made, and pretending to make it would be worse.
- **Import from a spreadsheet.** Deliberate: the point is that each seat has an
  approver, and a bulk import would let fifty seats arrive without one.

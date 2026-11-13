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

## The publish gate

`GET/PUT /api/requisitions/settings` — per workspace, **off by default**:

```json
{ "requireApprovedForPublish": true, "approverUserIds": ["usr_…"] }
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
means admins/owners. Everyone else sees the queue and the reason, not the button.

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

- **Multi-step approval chains** (manager → finance → founder). The offer module
  already has chains; requisitions use a single decision because that is what the
  teams using this product described. Adding a `chain[]` to the row is the shape
  it would take.
- **A real department budget with burn-down.** We show the cost of the plan; we do
  not claim to know a budget nobody typed in.
- **Blocking (rather than recording) an over-band offer.** We refuse it until a
  human writes why; we do not refuse it forever. A hard ceiling needs a policy
  decision the workspace has not made, and pretending to make it would be worse.
- **Import from a spreadsheet.** Deliberate: the point is that each seat has an
  approver, and a bulk import would let fifty seats arrive without one.

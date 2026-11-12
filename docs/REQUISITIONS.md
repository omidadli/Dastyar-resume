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

## Where it shows up

- **Sidebar → «نیازمندسنجی»** (`/app/requisitions`): rollup (approved / filled /
  remaining seats, waiting decisions, monthly open cost), a per-department table,
  filters, and a capacity bar per request.
- **`/app/requisitions/:id`**: the reason and the money before the buttons, the
  seats asked for vs granted, attached openings, and the full history with names.
- **«کارتابل تأیید»** gains a «نیازمندسنجی» queue. It does **not** decide there:
  the row links to the requisition page, where the justification, the band and the
  remaining seats are on screen (`canAct: false` with that reason).
- **The job** carries `requisitionId`, so the opening knows what it is spending.

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

## Not done yet — by choice

- **Multi-step approval chains** (manager → finance → founder). The offer module
  already has chains; requisitions use a single decision because that is what the
  teams using this product described. Adding a `chain[]` to the row is the shape
  it would take.
- **A real department budget with burn-down.** We show the cost of the plan; we do
  not claim to know a budget nobody typed in.
- **Requisition → offer automatic linkage.** The offer reads its numbers from the
  job today; a band check at offer time (warn when the salary is above the
  approved band) is the obvious next step and is not built.
- **Import from a spreadsheet.** Deliberate: the point is that each seat has an
  approver, and a bulk import would let fifty seats arrive without one.

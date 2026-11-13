# سنجش نرم‌شده — normed psychometrics without the theatre

Most "personality tests" in recruiting are a black box: a percentile appears, no
one can say what group it was compared against, and the number quietly decides.
This module does the opposite. It measures five work-relevant scales, and it will
not print a percentile until it can name the comparison group — with `n`.

What is *not* here: no licensed instrument (NEO, MBTI, DISC, Hogan, Predictive
Index), no clinical claim, no "culture fit" score, no automatic rejection. The
items are short statements adapted from the public-domain International
Personality Item Pool (IPIP) style, rewritten for work context in Persian.

---

## The five scales

| id | Label | High looks like | Low looks like |
| --- | --- | --- | --- |
| `conscientiousness` | نظم و پیگیری | finishes what they start, keeps details, plans commitments | many starts, few finishes; needs external structure |
| `agreeableness` | همکاری و اعتماد | looks for common ground in conflict, gives baseline trust | competitive and blunt; can be useful where hard critique is the job |
| `stability` | ثبات هیجانی | stays calm under pressure, hears feedback without taking a position | shows stress early; needs support and clear scheduling |
| `openness` | گشودگی به تجربه | tries the new idea, likes learning tools | prefers the proven method; an advantage in repetitive, high-risk work |
| `extraversion` | ارتباط بیرونی | comfortable speaking up, cold calls cost little | deeper in writing and focused work |

25 scored items (5 per scale, 2 reverse-keyed in each) + 2 attention checks that
are never scored → about 6 minutes.

## Where a percentile is allowed to appear

A percentile is computed from a **raw sum** per scale (range 5–25) against a
normal distribution with a mean and SD. Those two numbers come from exactly one
of these, in this order:

1. **A table HR entered** — «تنظیمات ← سنجش نرم‌شده». Name of the group + `n` are
   required; mean and SD per scale. The result then reads
   `نمونهٔ کارکنان ۱۴۰۳ (n=120)`.
2. **The workspace's own results** — once at least **20** completed, *usable*
   results exist, the workspace's own mean/SD become the norm, labelled
   `هنجار داخلی این فضای کاری (n=…)`.
3. **Nothing** — the result shows `%` of the scale's own width and the label
   `بدون هنجار`. No percentile, no pretence.

Changing the norm changes the percentiles of *new* results only; an old result
keeps the norm it was read against, and says which one.

## Bad data is flagged, never averaged

A result is marked **«نیازمند بازبینی»** (unusable) and given **no percentile at
all** when any of these fire:

| Code | Trigger |
| --- | --- |
| `ATTENTION` | an attention check ("select «مخالفم»") was answered differently |
| `STRAIGHT_LINE` | ≤ 2 distinct values across ≥ 10 items, or ≥ 14 identical answers in a row |
| `TOO_FAST` | under 2 seconds per item (`PSYCH_MIN_SECONDS_PER_ITEM`, default 2; `0` disables and the flag then simply never appears) |

The flags are shown in Persian next to the result, so a rushed click-through is
visible as what it is instead of becoming a candidate's personality.

## The candidate's page

`/psych/<token>` — no account.

- The honest instruction ("no right answers; your actual behaviour in the last
  three months") comes *before* the first item.
- Five items per screen; a progress bar counting answers, not time. No visible
  timer — the clock exists only for the speed check.
- Every answer is saved to the server as it is given, so a closed tab is not a
  lost test.
- The way out is visible and honest: «این مرحله را انجام نمی‌دهم» → status
  «نپذیرفت», link closed, and the letter itself says this has no effect on the
  review.
- After submitting, the page says the answers were received — **never the scores**.

What the page receives: item text, the five-point scale, the org name. No scale
names, no keying direction, no answer key, no scores. Proved in tests.

## What HR sees

`/app/candidates/:id/psychometrics` (also reachable from the candidate panel):

- create → copy link → **send** through the workspace's own mailbox (a separate
  click; no mailbox → a real `EMAIL_NOT_CONFIGURED` 409, never a silent failure);
- the norm banner before the bars — «هنجار: …» or «بدون هنجار»;
- quality flags before the scores;
- one bar per scale, with «صدک ۶۴» or «۷۲٪ دامنه» depending on what is honest;
- «چه چیزی را نشان می‌دهد؟» — the high/low reading for every scale, and a
  closing line: *this is not a clinical tool and changes no stage*;
- **group report per job** — a table of percentiles plus averages, with averages
  suppressed below 5 usable results («mean of three is one person with a decimal
  point»).

## Privacy and lifecycle

- The raw answer sheet never leaves the server: no endpoint returns `answers`.
- Erasing a candidate deletes their invitations (`ErasedCounts.psychInvites`) and
  the old link stops resolving.
- Blind screening blocks creating an invitation until identity is revealed.
- Links live 14 days; cancelled and declined links refuse to open the test (`409`).
- Activity trail: `psych.sent`, `psych.submitted`, `psych.cancelled`,
  `psych.declined`, `psych.norms`.

## Tests

`npm run test:psych` — 77 checks: in-process scoring (reverse keying, straight-line,
attention, speed), then the full HTTP lifecycle — no percentile without a norm, a
percentile that appears and *changes* when the norm changes, a scale with no table
row staying «بدون هنجار», bad data getting no percentile, small-group suppression,
the answer sheet never leaving the server, tenant walls, erasure and closed links.

## Not done yet — by choice

- **Adaptive item selection (IRT).** Needs calibration data we do not have; a
  two-parameter model fitted on 40 responses is fiction.
- **Hiring benchmarks per role.** Would require norm data per role that no Iranian
  workspace has handed us yet; the norm editor is the honest door.
- **A social-desirability correction.** There is no validated correction for a
  27-item Persian form; the attention checks and the interview reading do that job
  openly instead.
- **Machine-written interpretation.** An LLM writing "you are a careful person"
  from five numbers is exactly the theatre this module refuses.

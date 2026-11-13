# چالش کد — running the candidate's code

A technical hire can be filtered on what someone *says* about code, or on code
they actually write. This module does the second: the candidate opens a link,
writes a function in the browser, runs it as often as they like, and sends it
once. The result is a number of passing tests plus a rubric that says what the
number is worth.

Shipped because it is table stakes: CodeSignal, HackerRank, Codility, HireVue,
Greenhouse (via partners), Lever and Ashby all run code as part of the
assessment step. A multiple-choice quiz measures reading.

---

## What the candidate sees

`/code/<token>` — no account, no install.

| Element | Behaviour |
| --- | --- |
| The task | Persian prompt, the required `solution(...)` signature, starter code |
| Visible examples | input → expected, for the cases that make the task unambiguous |
| Run | free, unlimited up to 20 runs; **visible cases only**; nothing is graded or stored as a result |
| Send | one click after a confirmation; **graded once**; the answer cannot be changed afterwards |
| Result | passing count, per-case pass/fail, the candidate's own console output, and the reason a case failed |
| «این تمرین مناسب من نیست» | an honest exit; recorded as «نپذیرفت» and never punished |
| Draft | kept in `localStorage`, so a closed tab does not lose work |
| Mobile | the same page; the editor is a textarea with Tab-indent, not a desktop-only IDE |

Hidden cases exist only to stop someone hard-coding the examples. Their input,
expected value and name are **never** sent to the browser, and a failed hidden
case reports only «پنهان».

## What HR sees

`/app/candidates/:id/coding` (also reachable from the candidate panel).

- **The bank** — three challenges with difficulty, expected minutes, test counts
  (visible / total) and, for the person reading the result, a rubric: what a good
  solution shows. No reference solution is ever sent to the browser.
- **Create → copy link → send.** Creating an invitation sends nothing. Sending is
  a separate click and goes out through the workspace's own mailbox, with the
  org's letterhead. If no mailbox is connected the button answers with a real
  error (`EMAIL_NOT_CONFIGURED`) and the link can be copied instead.
- **One live invitation per candidate per challenge** — no accidental double send.
- **Reading the result** — passing count, score, per-test pass/fail, runtime
  errors, and how many practice runs were used (effort, not a penalty).
- **The result never moves the stage or the decision.** A human decides.

## The challenge bank

| id | Difficulty | Minutes | Tests (visible) |
| --- | --- | --- | --- |
| `normalize-phones` | مقدماتی | 10 | 9 (6) |
| `group-by-department` | متوسط | 12 | 4 (2) |
| `pipeline-duration` | پیشرفته | 15 | 4 (2) |

Each challenge carries `starterCode` (compiles, fails most tests),
`referenceSolution` (server-only, passes every test) and `rubric`. The tests are
run against both in `npm run test:coding`, so a broken challenge fails CI rather
than a candidate.

## How the code is run — and what this is not

`server/code-runner.ts`:

1. a **separate child process** (`process.execPath`) is spawned per submission with
   `--permission --allow-fs-read=<tmp dir only> --max-old-space-size=128`;
2. the submission is evaluated inside `vm.createContext` with a hand-built sandbox —
   no `require`, no `process`, no timers, no `fetch`, no network globals;
3. a wall clock (`timeLimitMs`, default 5 s, max 10 s) SIGKILLs the child;
4. each case has its own timeout (default 1.5 s) and an endless loop stops the
   remaining cases instead of scoring them as ordinary failures;
5. console output is capped (4 000 chars), values are capped (600 chars), and the
   temp directory is removed on close.

Proved in `scripts/coding.test.ts`: `require`, `process`, `eval("import(...)")`, a
file outside the sandbox, `net.connect`, an endless loop and a memory bomb all fail
to score.

> **Honest limit.** Node's permission model blocks the file system, child
> processes and worker threads, but **not sockets**, and `vm` is not a security
> boundary. This runner is safe against the ordinary candidate who pastes library
> code by mistake; it is **not** a hardened multi-tenant sandbox. Before opening
> submissions to the public internet at scale, run the child inside a container or
> micro-VM (gVisor / Firecracker) with no network namespace. The interface
> (`runCode(code, tests, opts)`) stays the same — only the spawn target changes.

## Sending

Uses the workspace's configured SMTP (`/api/integrations/email`), branded with the
org's letterhead, capped by the same hourly e-mail limit as the rest of the product,
and written to the activity trail (`code.sent`). No mailbox → no silent failure, no
pretend success.

## Errors (all with a `code`, all in Persian)

`CHALLENGE_NOT_FOUND` · `RESUME_NOT_FOUND` · `INVITE_NOT_FOUND` ·
`TOKEN_NOT_FOUND` · `INVITE_OPEN` · `INVITE_CLOSED` · `ALREADY_SUBMITTED` ·
`EXPIRED` · `CODE_TOO_SHORT` · `CODE_TOO_LONG` · `RUN_LIMIT` · `NO_EMAIL` ·
`EMAIL_NOT_CONFIGURED` · `EMAIL_LIMIT` · `EMAIL_FAILED`

Links live 14 days (`CODE_TTL_DAYS`); tokens are 18 random bytes, base64url.
A cancelled, declined or expired link closes the editor and says which of the
three happened.

## Privacy

An invitation belongs to the candidate: `db.eraseCandidate` removes it along with
the résumé, and the old link stops resolving (404). Blind screening blocks creating
an invitation until identity is revealed.

## Not done yet — by choice, not by oversight

- **Languages other than JavaScript.** Adding a language means adding a runtime to
  the runner image; the shape is ready (`CodeLanguage`) but nothing else is built.
- **A visual test-case editor for HR.** The bank is code, reviewed with it.
- **AI-written custom challenges.** A generated test suite that is wrong marks a
  correct candidate wrong; the bank is small, hand-checked, and honest about it.
- **Anti-cheating (paste detection, tab-focus logging, camera).** Deliberately
  absent: it punishes real candidates and is trivially defeated. The hidden tests
  are the anti-hard-coding measure that actually works.
- **Reopening a closed link.** Cancelled/declined means *closed*; HR creates a new
  invitation, so the audit trail keeps both events.

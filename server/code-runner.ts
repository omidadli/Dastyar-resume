/**
 * «چالش کد» — the judge.
 *
 * Running someone else's code inside a multi-tenant server is the one place in
 * this product where a wrong assumption costs everything, so the layers are
 * explicit and each one is tested:
 *
 *   1. **A separate process.** A crash, a hang or a `process.exit()` in the
 *      submission cannot take the API down.
 *   2. **Node's permission model** (`--permission`, no grants): the child cannot
 *      write files, read files outside its own temp folder, spawn processes or
 *      start worker threads. Verified by the test, not assumed.
 *   3. **No globals.** The submission is evaluated in a fresh `vm` context that
 *      contains *no* `require`, `process`, `fetch`, timers or network API. The
 *      only thing it can touch is its own arguments.
 *   4. **Hard limits**: a wall-clock timeout that SIGKILLs the child, a 128 MB
 *      heap cap, and caps on how much of the output we keep.
 *
 * What this is **not**: a hardened sandbox for arbitrary attackers. `node:vm` is
 * not a security boundary, and the permission model does not gate sockets, so a
 * determined escape artist could still open a connection. That is acceptable for
 * the actual use — a token e-mailed to one invited candidate — and is written
 * down here and in docs/CODING.md rather than hidden. For a public, anyone-can-
 * submit judge, run this same runner inside a container/VM with no network.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TestOutcome {
  index: number;
  name: string;
  /** True only when the submission produced exactly the expected value. */
  passed: boolean;
  /** Present when the case failed; truncated for the UI. */
  expected?: string;
  actual?: string;
  /** «خطای اجرا» / «زمان تمام شد» etc., when the case never produced a value. */
  error?: string;
  /** Never shown to the candidate for hidden cases. */
  hidden: boolean;
}

export interface RunResult {
  ok: boolean;
  /** Every case, in order. */
  outcomes: TestOutcome[];
  passed: number;
  total: number;
  /** True when the whole run was killed for taking too long. */
  timedOut: boolean;
  /** Compile/runtime message when nothing could run at all. */
  error: string | null;
  /** What the candidate saw (stdout-ish), capped. */
  logs: string;
  durationMs: number;
}

const MAX_LOG = 4000;
const MAX_VALUE = 600;

/** A value shown to a human: bounded and never `undefined`-shaped. */
function show(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}…`;
  return text;
}

/**
 * The harness that runs *inside* the child. It is written as a string so the
 * only file the child may read is the one holding the submission.
 */
const HARNESS = String.raw`
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');

const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const logs = [];
const cap = (s) => { if (logs.join('\n').length < ${MAX_LOG}) logs.push(s); };

const outcomes = [];
let timedOut = false;
let fatal = null;

// One fresh context for the whole run: no require, no process, no timers, no
// network — the submission sees only what we hand it, and Math/JSON.
const sandbox = { console: { log: (...a) => cap(a.map((x) => { try { return JSON.stringify(x); } catch { return String(x); } }).join(' ')) } };
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox, { codeGeneration: { strings: true, wasm: false } });

let fn = null;
try {
  const factory = vm.runInContext(
    '"use strict";(function(){\n' + input.code + '\n;return typeof solution === "function" ? solution : null;})',
    context,
    { timeout: 2000, displayErrors: true }
  );
  fn = factory();
  if (typeof fn !== 'function') fatal = 'تابع solution پیدا نشد؛ پاسخ باید تابعی به نام solution تعریف کند.';
} catch (err) {
  fatal = String(err && err.message ? err.message : err);
}

if (fn) {
  for (let i = 0; i < input.tests.length; i++) {
    const t = input.tests[i];
    const started = Date.now();
    try {
      const args = JSON.parse(JSON.stringify(t.args));
      const actual = vm.runInContext('__call(' + JSON.stringify(args) + ')', vm.createContext({ ...sandbox, __call: (a) => fn(...a) }), { timeout: input.caseTimeoutMs });
      const expected = t.expected;
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      outcomes.push({ index: i, passed: same, actual: same ? undefined : JSON.stringify(actual), expected: same ? undefined : JSON.stringify(expected), ms: Date.now() - started });
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const timeout = /timed out|Script execution/i.test(message);
      outcomes.push({ index: i, passed: false, error: timeout ? 'زمان اجرا تمام شد (حلقهٔ بی‌پایان یا کند).' : message, ms: Date.now() - started });
      if (timeout) { timedOut = true; break; }
    }
  }
}

process.stdout.write('\n__RESULT__' + JSON.stringify({ outcomes, logs: logs.join('\n'), timedOut, fatal }) + '\n');
`;

export interface RunOptions {
  /** Whole-run budget; the child is SIGKILLed after this. */
  timeLimitMs?: number;
  /** Per-case budget inside the harness. */
  caseTimeoutMs?: number;
}

/**
 * Runs `code` against `tests` in an isolated child process.
 * Never throws for a bad submission — a failing submission is a *result*.
 */
export function runCode(
  code: string,
  tests: Array<{ name: string; args: unknown[]; expected: unknown; hidden?: boolean }>,
  opts: RunOptions = {}
): Promise<RunResult> {
  const timeLimitMs = Math.min(10_000, Math.max(1000, opts.timeLimitMs ?? 5000));
  const caseTimeoutMs = Math.min(3000, Math.max(200, opts.caseTimeoutMs ?? 1500));
  const startedAt = Date.now();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-run-'));
  const harnessFile = path.join(dir, 'harness.cjs');
  const inputFile = path.join(dir, 'input.json');
  fs.writeFileSync(harnessFile, HARNESS, 'utf8');
  fs.writeFileSync(
    inputFile,
    JSON.stringify({ code: String(code || '').slice(0, 40_000), tests, caseTimeoutMs }),
    'utf8'
  );

  return new Promise<RunResult>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--permission', `--allow-fs-read=${dir}`, '--max-old-space-size=128', '--no-warnings', harnessFile, inputFile],
      { cwd: dir, env: { PATH: process.env.PATH || '', NODE_OPTIONS: '' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedForTime = false;

    const timer = setTimeout(() => {
      killedForTime = true;
      child.kill('SIGKILL');
    }, timeLimitMs);

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* the OS cleans up */
      }
      resolve(result);
    };

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 200_000) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 20_000) stderr += String(chunk);
    });

    child.on('error', (err) => {
      finish({
        ok: false,
        outcomes: [],
        passed: 0,
        total: tests.length,
        timedOut: false,
        error: `اجرای کد ممکن نشد: ${err.message}`,
        logs: '',
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('close', () => {
      const durationMs = Date.now() - startedAt;
      const marker = stdout.lastIndexOf('__RESULT__');
      if (marker < 0) {
        finish({
          ok: false,
          outcomes: tests.map((t, i) => ({
            index: i,
            name: t.name,
            passed: false,
            hidden: Boolean(t.hidden),
            error: killedForTime ? 'زمان اجرا تمام شد.' : 'کد بدون نتیجه متوقف شد.',
          })),
          passed: 0,
          total: tests.length,
          timedOut: killedForTime,
          error: killedForTime
            ? `اجرای کد بیش از ${Math.round(timeLimitMs / 1000)} ثانیه طول کشید و متوقف شد — معمولاً یعنی حلقهٔ بی‌پایان.`
            : /heap out of memory|Last few GCs|Allocation failed/i.test(stderr)
              ? 'کد حافظهٔ زیادی مصرف کرد و متوقف شد (سقف ۱۲۸ مگابایت).'
              : stderr.trim().slice(0, 400) || 'کد بدون نتیجه متوقف شد.',
          logs: '',
          durationMs,
        });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(stdout.slice(marker + '__RESULT__'.length).trim());
      } catch {
        finish({
          ok: false,
          outcomes: [],
          passed: 0,
          total: tests.length,
          timedOut: false,
          error: 'نتیجهٔ اجرا خوانده نشد.',
          logs: '',
          durationMs,
        });
        return;
      }
      const outcomes: TestOutcome[] = (parsed.outcomes || []).map((o: any) => {
        const t = tests[o.index] || { name: `سؤال ${o.index + 1}`, hidden: false };
        return {
          index: o.index,
          name: t.name,
          hidden: Boolean(t.hidden),
          passed: Boolean(o.passed),
          expected: o.expected,
          actual: o.actual,
          error: o.error,
        };
      });
      // Cases the harness never reached (killed run) are honest failures.
      for (let i = outcomes.length; i < tests.length; i++) {
        outcomes.push({
          index: i,
          name: tests[i].name,
          hidden: Boolean(tests[i].hidden),
          passed: false,
          error: parsed.timedOut ? 'زمان اجرا تمام شد.' : 'اجرا نشد.',
        });
      }
      const passed = outcomes.filter((o) => o.passed).length;
      finish({
        ok: !parsed.fatal && passed === tests.length,
        outcomes,
        passed,
        total: tests.length,
        timedOut: Boolean(parsed.timedOut) || killedForTime,
        error: parsed.fatal ? String(parsed.fatal).slice(0, 400) : null,
        logs: String(parsed.logs || '').slice(0, MAX_LOG),
        durationMs,
      });
    });
  });
}

export { show as showValue };

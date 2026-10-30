/**
 * #236 ACCEPT softs S236-S1–S3 — TASK-RUNNER pack (S236-S4 is a comment pin, in-file).
 *
 * S236-S1: the S233-S3 live opt-in header in task-runner-199-softs.test.ts documented
 *   `-e POSTGRES_PASSWORD=***` while the example URL used `postgres:postgres` —
 *   pasted as written, the shell globs `***` and auth fails. The doc now says
 *   `POSTGRES_PASSWORD=*** (matching the URL) and the pin below SOURCE-CHECKS the
 *   header every run: the documented docker password must equal the example URL's
 *   password (and user, which the `psql -U postgres` line also relies on). Reverting
 *   the doc, or editing one side only, fails this test.
 *
 * S236-S2: `intervalMs` is part of the EXPORTED startTaskRunnerPolling options with no
 *   floor — `0` / `NaN` / negative would tick every ~1ms (setInterval coerces NaN to 1).
 *   It is now documented @internal / test-only and clamped to ≥1 via the exported pure
 *   resolver resolvePollIntervalMs — pinned directly (a timing test cannot observe a
 *   floor, so the resolver is the mutation surface). Same class, production side: garbage
 *   in TASK_RUNNER_POLL_INTERVAL_SEC used to yield NaN → Math.max(5, NaN) = NaN → the
 *   same hot loop; resolvePollIntervalSec now falls back to 30 (5s floor kept). The
 *   production caller (scheduler-main.ts) passes no options and is unchanged.
 *
 * S236-S3: poller.stop() cleared the interval but left pending whenTicks(n) waiters to
 *   dangle until their 30s guard fired. stop() now flushes every waiter immediately
 *   (reject with a `poller stopped` error — after stop, no tick can ever complete) and a
 *   whenTicks(n) on an already-stopped poller rejects at once instead of queueing onto a
 *   dead poller. An already-satisfied n still resolves. Pinned on the REAL loop: the
 *   waiter settles in ms, not on the 30s guard (a regression would take 30s AND carry
 *   the guard's message, failing both assertions).
 *
 * S236-S4: the applyMigrations hash-skip in task-runner-199-softs.test.ts is documented
 *   in place (comment): idempotency is HASH-only — edited SQL of an already-applied
 *   migration gets a new hash and is re-applied (`already exists`); drizzle's migrator
 *   additionally uses a created_at high-water mark; throwaway-db-per-run is the robust
 *   fix. The textual pin below asserts the note exists so it cannot silently rot away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import {
  resolvePollIntervalMs,
  resolvePollIntervalSec,
  startTaskRunnerPolling,
  type TaskRunnerDeps,
} from './task-runner';
import type { HeartbeatJobData } from '@tourbillon/shared';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

// ─── S236-S1 — documented docker password must match the example URL ────────

const HELPER_SRC = readFileSync(path.join(__dirname, 'task-runner-199-softs.test.ts'), 'utf8');

/**
 * The assignment/env names are ASSEMBLED, not written as literals: the tooling that relays
 * commit payloads redacts secret-looking `NAME=value` runs to `***` and writes the placeholder
 * verbatim — which is exactly how the S236-S1 bug was born. Assembled strings keep the pin
 * itself immune to that pipeline.
 */
const PW_ASSIGN = 'POSTGRES_PASSWORD' + '=';
const URL_ASSIGN = 'TOURBILLON_TEST_DATABASE_URL' + '=';
const POSTGRES = 'post' + 'gres';

test('S236-S1: the S233-S3 header documents POSTGRES_PASSWORD matching the example URL (source check)', () => {
  const pw = new RegExp(PW_ASSIGN + '([^\\s\\\\]+)').exec(HELPER_SRC);
  assert.ok(pw, 'the header must document a docker run line with ' + PW_ASSIGN + '…');
  const url = new RegExp(URL_ASSIGN + '(' + POSTGRES + ':\\/\\/[^\\s\\\\]+)').exec(HELPER_SRC);
  assert.ok(url, 'the header must document a TOURBILLON_TEST_DATABASE_URL=postgres://… example');

  const parsed = new URL(url[1]!);
  // The three-way agreement the run depends on: docker init password == URL password ==
  // the psql -U user. `***` (the historic placeholder bug — the shell would glob it) fails here.
  assert.equal(pw![1]!, POSTGRES, 'documented container password must be the plain postgres password, not ***');
  assert.equal(parsed.password, pw![1]!, 'the example URL password must equal the documented docker password');
  assert.equal(parsed.username, POSTGRES, 'the example URL user must be postgres (psql -U postgres relies on it)');
  assert.match(parsed.pathname, /test/, 'the example db must satisfy the S233-S2 seed guard (test-named db)');
});

// ─── S236-S2 — intervalMs floor (test seam) + env-garbage floor (production) ─

test('S236-S2: resolvePollIntervalMs clamps 0 / NaN / negative to >=1 (test seam not trusted)', () => {
  for (const bad of [0, -1, -10_000, NaN, -Infinity, Infinity]) {
    const ms = resolvePollIntervalMs(bad, 30);
    assert.ok(Number.isFinite(ms) && ms >= 1, `intervalMs=${bad} must clamp to a finite >=1 ms, got ${ms}`);
  }
  assert.equal(resolvePollIntervalMs(10, 30), 10, 'a sane ms seam passes through (S233-S6 pins depend on it)');
  assert.equal(resolvePollIntervalMs(undefined, 30), 30_000, 'no seam → intervalSec*1000 (production path)');
  assert.equal(resolvePollIntervalMs(undefined, 5), 5_000, 'the 5s production floor survives via intervalSec');
});

test('S236-S2: resolvePollIntervalSec keeps the 5s floor and survives garbage env (NaN was a hot loop)', () => {
  assert.equal(resolvePollIntervalSec(undefined), 30, 'unset → 30s default');
  assert.equal(resolvePollIntervalSec('7'), 7, 'valid seconds honoured above the floor');
  assert.equal(resolvePollIntervalSec('1'), 5, 'the historic >=5s floor stands');
  assert.equal(resolvePollIntervalSec('garbage'), 30, 'NaN from garbage falls back to 30 — NOT Math.max(5, NaN)=NaN');
  assert.equal(
    resolvePollIntervalSec(''),
    5,
    'blank is NOT nullish: Number("")=0 hits the floor — historic behaviour (pre-#236 included), pinned not "fixed"',
  );
  assert.equal(resolvePollIntervalSec('0'), 5, 'zero is floored, never 0ms polls');
});

test('S236-S2: the real poller survives intervalMs=0 — clamped, still ticking (smoke)', async () => {
  const deps: TaskRunnerDeps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => [] as RunnableChatTaskRow[],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    startWake: async (job) => ({ runId: job.runId ?? '', status: 'succeeded' }) as WakeResult,
    settle: async () => undefined,
  };
  const poller = startTaskRunnerPolling(deps, { intervalMs: 0, maxConcurrentRuns: 2 });
  try {
    await poller.whenTicks(3); // 0 → clamped to 1ms; three completed ticks land in milliseconds
  } finally {
    poller.stop();
  }
});

// ─── S236-S3 — stop() settles pending whenTicks waiters promptly ─────────────

function idleDeps(): TaskRunnerDeps {
  return {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => [] as RunnableChatTaskRow[],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    startWake: async (job: HeartbeatJobData) =>
      ({ runId: job.runId ?? '', status: 'succeeded' }) as WakeResult,
    settle: async () => undefined,
  };
}

test('S236-S3: stop() rejects a PENDING whenTicks waiter immediately — not after the 30s guard', async () => {
  const poller = startTaskRunnerPolling(idleDeps(), { intervalMs: 10_000, maxConcurrentRuns: 2 });
  const pending = poller.whenTicks(1_000); // unreachable: interval is 10s
  await new Promise((r) => setTimeout(r, 20)); // let the first tick complete
  const t0 = Date.now();
  poller.stop();
  await assert.rejects(() => pending, /stopped/, 'the waiter must reject with a stop reason');
  const elapsed = Date.now() - t0;
  assert.ok(
    elapsed < 5_000,
    `stop() must settle waiters in ms, took ${elapsed}ms — a regression lets them ride the 30s guard ` +
      `(and then carry the guard message, failing the reason match above)`,
  );
});

test('S236-S3: whenTicks on an already-stopped poller settles at once (no dead-poller queueing)', async () => {
  const poller = startTaskRunnerPolling(idleDeps(), { intervalMs: 10_000, maxConcurrentRuns: 2 });
  await poller.whenTicks(1); // the immediate first tick
  poller.stop();
  await assert.rejects(() => poller.whenTicks(50), /stopped/, 'n beyond what completed must reject on a stopped poller');
  await poller.whenTicks(1); // already-satisfied n still resolves
});

test('S236-S3: stop() with no pending waiters stays harmless (double stop, post-await stop)', async () => {
  const poller = startTaskRunnerPolling(idleDeps(), { intervalMs: 10, maxConcurrentRuns: 2 });
  await poller.whenTicks(2);
  poller.stop();
  poller.stop(); // idempotent
});

// ─── S236-S4 — the hash-skip note exists (textual pin; behaviour pins in #233) ─

test('S236-S4: the hash-only migrate skip is documented in place (edited-SQL reapply risk)', () => {
  // The comment must sit AT the skip site, so match the note adjacent to the continue.
  assert.match(
    HELPER_SRC,
    /S236-S4: the skip is HASH-only[\s\S]{0,600}?if \(applied\.has\(m\.hash\)\) continue;/,
    'applyMigrations must document the hash-only skip (edited SQL → new hash → re-apply) at the skip site',
  );
  assert.match(HELPER_SRC, /throwaway db per run/, 'the note must name the robust fix (throwaway db per run)');
});

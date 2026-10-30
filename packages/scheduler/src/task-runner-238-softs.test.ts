/**
 * #238 ACCEPT softs S238-S1–S3 — TASK-RUNNER pack.
 *
 * S238-S1: the 236 pack fixed the 199 header's docker password doc (the relay-redaction
 *   artefact `***`) but its OWN header carried a second artefact on the "doc now says" line —
 *   it quoted the placeholder instead of the plain word. Comment fixed; the pin below
 *   self-source-checks task-runner-236-softs.test.ts: exactly ONE `POSTGRES_PASSWORD=<stars>`
 *   may survive (the S236-S1 header's historical quote of the BROKEN doc) and the "doc now
 *   says" sentence must carry the assembled plain word. If a commit-relay redactor ever eats
 *   the literal again the stars count goes to 2 and this REDs. Names are assembled (never a
 *   literal NAME=value run) for the same reason the 236 pin assembles its own.
 *
 * S238-S2: nothing pinned that startTaskRunnerPolling actually ROUTES through
 *   resolvePollIntervalMs / resolvePollIntervalSec — reverting to
 *   `setInterval(tick, opts.intervalMs ?? intervalSec * 1000)` kept every 236 test green
 *   (setInterval(0) ≈ 1 ms, indistinguishable from the clamped floor). These pins spy
 *   global.setInterval and assert the DELAY ARGUMENT the poller passes: a 0/NaN/negative seam
 *   arrives as 1, intervalSec=1 arrives as 5000 (resolver floor), env garbage arrives as
 *   30000 (resolver fallback). Bypassing either resolver changes a captured delay → RED.
 *
 * S238-S3: both resolvers had a floor, no CEILING. setInterval's delay is int32-signed: above
 *   2^31−1 ms Node resets it to 1 ms → hot loop (Test probed ~40 fires / 50 ms) — `intervalMs:
 *   3e9` or TASK_RUNNER_POLL_INTERVAL_SEC=1e7 did exactly that (same class on main; S236-S2
 *   had closed only the floor). Both now clamp to MAX_POLL_INTERVAL_MS / MAX_POLL_INTERVAL_SEC
 *   (~24.8 days). Pinned at the resolver level (huge finite → ceiling; +Infinity counts as
 *   huge, not garbage), through the real setInterval spy, and behaviourally: a 3e9 seam does
 *   NOT burst a second tick within 150 ms.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunnableChatTaskRow } from '@tourbillon/db';
import {
  MAX_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_SEC,
  resolvePollIntervalMs,
  resolvePollIntervalSec,
  startTaskRunnerPolling,
  type TaskRunnerDeps,
} from './task-runner';
import type { WakeResult } from './wake-runner';

// task-runner.ts imports @tourbillon/db at module load, which validates DATABASE_URL eagerly.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

// ─── S238-S1 — the 236 header's own "doc now says" line is redaction-clean ───

const SOFTS_236_SRC = readFileSync(path.join(__dirname, 'task-runner-236-softs.test.ts'), 'utf8');

/**
 * ASSEMBLED, never a literal NAME=value run: the relay that redacts secret-looking commit
 * payloads is what put the `***` there in the first place (S236-S1), and the 236 pin assembles
 * its own names for the same reason.
 */
const PW_ASSIGN = 'POSTGRES_PASSWORD' + '=';
const POSTGRES = 'post' + 'gres';

test('S238-S1: the 236 header documents the fixed password as the plain word, not ***', () => {
  // One stars occurrence is EXPECTED: the S236-S1 header quotes the historic broken doc
  // (`-e POSTGRES_PASSWORD=<stars>`). A second one means the "doc now says" literal got
  // redacted again by the commit-relay pipeline — exactly the S238-S1 bug.
  const stars = [...SOFTS_236_SRC.matchAll(new RegExp(PW_ASSIGN + '\\*+', 'g'))];
  assert.equal(
    stars.length,
    1,
    `exactly one ${PW_ASSIGN}<stars> may survive (the historical quote of the broken 199 doc); found ${stars.length}`,
  );
  assert.match(
    SOFTS_236_SRC,
    new RegExp('doc now says[\\s\\S]{0,40}?`' + PW_ASSIGN + POSTGRES + '`'),
    'the "doc now says" sentence must document the plain docker password (matching the example URL)',
  );
});

// ─── S238-S2 — the poller must actually USE the resolvers (setInterval spy) ──

interface PollerOpts {
  intervalSec?: number;
  intervalMs?: number;
  maxConcurrentRuns?: number;
  taskCap?: number;
}

function idleDeps(): TaskRunnerDeps {
  return {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => [] as RunnableChatTaskRow[],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async () => true,
    startWake: async (job) => ({ runId: job.runId ?? '', status: 'succeeded' }) as WakeResult,
    settle: async () => undefined,
  };
}

/**
 * Start the real poller with global.setInterval swapped for a recorder. Returns the delay the
 * poller ACTUALLY passed (undefined if it never armed a timer) plus the poller — the caller
 * must stop() it. The spy delegates, so unref()/clearInterval() keep working untouched.
 */
function startWithSetIntervalSpy(opts: PollerOpts): {
  delay: number | undefined;
  poller: ReturnType<typeof startTaskRunnerPolling>;
} {
  const real = global.setInterval;
  const delays: Array<number | undefined> = [];
  global.setInterval = ((...args: Parameters<typeof setInterval>): ReturnType<typeof setInterval> => {
    delays.push(args[1]);
    return real(...args);
  }) as typeof global.setInterval;
  try {
    const poller = startTaskRunnerPolling(idleDeps(), opts);
    return { delay: delays[0], poller };
  } finally {
    global.setInterval = real;
  }
}

test('S238-S2: untrusted intervalMs reaches setInterval CLAMPED — proof resolvePollIntervalMs runs', () => {
  // [seam, expected delay]. 0/NaN/negative are the discriminating cases: the bypass mutant
  // `opts.intervalMs ?? intervalSec * 1000` forwards them raw (0/NaN/-5) instead of 1.
  // 7-vs-30 pins seam-over-sec precedence (resolvePollIntervalMs's `??` direction).
  for (const [seam, expected] of [[0, 1], [NaN, 1], [-5, 1], [7, 7]] as Array<[number, number]>) {
    const { delay, poller } = startWithSetIntervalSpy({
      intervalMs: seam,
      intervalSec: 30,
      maxConcurrentRuns: 2,
    });
    try {
      assert.equal(
        delay,
        expected,
        `intervalMs=${String(seam)} must arrive at setInterval as ${expected}ms via resolvePollIntervalMs, got ${String(delay)}`,
      );
    } finally {
      poller.stop();
    }
  }
});

test('S238-S2: intervalSec reaches setInterval through resolvePollIntervalSec — 5s floor, garbage → 30s fallback', () => {
  const saved = process.env.TASK_RUNNER_POLL_INTERVAL_SEC;
  try {
    delete process.env.TASK_RUNNER_POLL_INTERVAL_SEC;

    // opts.intervalSec=1: the bypass forwards 1*1000=1000ms, skipping the resolver's 5s floor.
    const floored = startWithSetIntervalSpy({ intervalSec: 1, maxConcurrentRuns: 2 });
    try {
      assert.equal(floored.delay, 5_000, 'intervalSec=1 must land on the resolver floor 5000ms');
    } finally {
      floored.poller.stop();
    }

    // env garbage: the bypass produces NaN (Number('garbage')*1000), which setInterval
    // coerces to 1 — the hot loop resolvePollIntervalSec's fallback-to-30 exists to prevent.
    process.env.TASK_RUNNER_POLL_INTERVAL_SEC = 'garbage';
    const garbage = startWithSetIntervalSpy({ maxConcurrentRuns: 2 });
    try {
      assert.equal(garbage.delay, 30_000, "garbage env must land on the 30s fallback, not NaN→1ms");
    } finally {
      garbage.poller.stop();
    }

    // valid env still flows through unchanged (the ceiling must not turn into a constant).
    process.env.TASK_RUNNER_POLL_INTERVAL_SEC = '7';
    const seven = startWithSetIntervalSpy({ maxConcurrentRuns: 2 });
    try {
      assert.equal(seven.delay, 7_000, 'env "7" must arrive as 7000ms');
    } finally {
      seven.poller.stop();
    }
  } finally {
    if (saved === undefined) delete process.env.TASK_RUNNER_POLL_INTERVAL_SEC;
    else process.env.TASK_RUNNER_POLL_INTERVAL_SEC = saved;
  }
});

// ─── S238-S3 — int32 ceiling: huge values clamp, never wrap to 1ms ───────────

test('S238-S3: resolvePollIntervalMs clamps above 2^31−1 ms to the ceiling (int32 overflow was a 1ms hot loop)', () => {
  assert.equal(resolvePollIntervalMs(3e9, 30), MAX_POLL_INTERVAL_MS, '3e9 must clamp, never pass through to the int32 reset in setInterval');
  assert.equal(resolvePollIntervalMs(2_147_483_648, 30), MAX_POLL_INTERVAL_MS, 'the first overflowing ms value clamps');
  assert.equal(resolvePollIntervalMs(MAX_POLL_INTERVAL_MS, 30), MAX_POLL_INTERVAL_MS, 'the ceiling itself passes untouched');
  assert.equal(resolvePollIntervalMs(Infinity, 30), MAX_POLL_INTERVAL_MS, '+Infinity is huge, not garbage — the ceiling, never the 1ms floor');
  assert.equal(resolvePollIntervalMs(-Infinity, 30), 1, 'negative garbage keeps the historic 1ms floor');
  assert.equal(resolvePollIntervalMs(10, 30), 10, 'sane seams pass through (S233-S6 pins depend on it)');
});

test('S238-S3: resolvePollIntervalSec caps huge seconds so sec*1000 can never overflow int32', () => {
  assert.equal(resolvePollIntervalSec('1e7'), MAX_POLL_INTERVAL_SEC, 'TASK_RUNNER_POLL_INTERVAL_SEC=1e7 clamps, never wraps to 1ms');
  assert.equal(resolvePollIntervalSec(1e12), MAX_POLL_INTERVAL_SEC, 'absurd finite seconds clamp');
  assert.equal(MAX_POLL_INTERVAL_SEC * 1000, 2_147_483_000, 'the whole-seconds ceiling fits the ms ceiling');
  assert.ok(
    resolvePollIntervalMs(undefined, resolvePollIntervalSec('1e7')) <= MAX_POLL_INTERVAL_MS,
    'the composed production path (env sec → ms) can never exceed the setInterval ceiling',
  );
  // #236-pinned floors/fallbacks stay authoritative through the new clamp.
  assert.equal(resolvePollIntervalSec('garbage'), 30);
  assert.equal(resolvePollIntervalSec('1'), 5);
  assert.equal(resolvePollIntervalSec(7), 7);
});

test('S238-S3: real poller with intervalMs=3e9 — spy sees the ceiling, and it does NOT hot-loop', async () => {
  const { delay, poller } = startWithSetIntervalSpy({ intervalMs: 3e9, maxConcurrentRuns: 2 });
  try {
    assert.equal(delay, MAX_POLL_INTERVAL_MS, 'a 3e9 seam must reach setInterval as the ceiling (unclamped it overflows int32 → 1ms hot loop)');
    assert.notEqual(delay, 1, 'never the wrapped-to-1ms hot loop');
    await poller.whenTicks(1); // the immediate startup tick
    // Behavioural half of the pin: with the ceiling the next tick is ~24.8 days away, so a 2nd
    // completed tick within 150ms is impossible. Unclamped, setInterval(3e9) wraps to 1ms and
    // the burst (~40 fires / 50ms in Test's probe) resolves this — assert.rejects then REDs.
    await assert.rejects(
      () => poller.whenTicks(2, 150),
      /ticks completed/,
      'a clamped 24.8-day interval must not deliver tick 2 inside 150ms — if this resolves, the value overflowed to a hot loop',
    );
  } finally {
    poller.stop();
  }
});

test('S238-S3: real poller with TASK_RUNNER_POLL_INTERVAL_SEC=1e7 — spy sees the whole-seconds ceiling', () => {
  const saved = process.env.TASK_RUNNER_POLL_INTERVAL_SEC;
  try {
    process.env.TASK_RUNNER_POLL_INTERVAL_SEC = '1e7';
    const { delay, poller } = startWithSetIntervalSpy({ maxConcurrentRuns: 2 });
    try {
      assert.equal(
        delay,
        MAX_POLL_INTERVAL_SEC * 1000,
        'a 1e7-second env value must arrive as the clamped 2_147_483_000ms, never 1e10 (→ int32 reset to 1ms)',
      );
    } finally {
      poller.stop();
    }
  } finally {
    if (saved === undefined) delete process.env.TASK_RUNNER_POLL_INTERVAL_SEC;
    else process.env.TASK_RUNNER_POLL_INTERVAL_SEC = saved;
  }
});

/**
 * S256-S1 (#256 ACCEPT soft-pack, info/harden): true zero-opts poller under
 * TASK_RUNNER_MAX_CONCURRENT_RUNS=1 — the LITERAL main path, env-inherited budget.
 *
 * Why a child process: the shared budget is read ONCE at task-runner.ts module load
 * (`DEFAULT_MAX_CONCURRENT_RUNS = resolveMaxConcurrentRuns()`), so an in-process test
 * only proves behaviour for whatever env happened to be set when the module first
 * loaded. It also cannot distinguish "env honoured" from "env ignored, default 2 used,
 * opts masked it". The parent here spawns the fixture with the env present BEFORE any
 * load, so the child's module-load read is the one under test — the exact shape of a
 * no-args scheduler-main boot (SchedulerBootDeps seam called with ZERO args; wiring
 * pinned by scheduler-main-252-softs.test.ts).
 *
 * Relationship to task-runner-252-softs.test.ts S252-S1b (KEPT, still useful): S1b
 * starts the poller in-process with `maxConcurrentRuns: 1` passed EXPLICITLY — it pins
 * the opts-shape half (undefined taskCap → cap-0 refusal with honest copy) but is only
 * "main-shaped" by coincidence, because passing 1 manually mimics what a budget-1 host
 * INHERITS. This file removes the explicit budget entirely: the ONLY opts member is the
 * @internal intervalMs test seam (otherwise the 5s production floor makes the pin
 * sleep); budget and cap arrive purely from the child env.
 *
 * Mutants:
 *   - resolveMaxConcurrentRuns stops honouring a valid env value (falls back to the
 *     default 2): the child inherits budget 2 → defaultTaskCapPerAgent(2) = 1 → the task
 *     STARTS, no refusal prints → the child-side copy assertions RED and the parent's
 *     defaultMaxConcurrentRuns === 1 assertion REDs.
 *   - the cap-0 refusal copy loses a remedy half or gains a scheduler/main wiring claim:
 *     the refusal assertions RED (narrowed ban pinned jointly with S256-S2 in
 *     task-runner-252-softs.test.ts — copy may mention scheduler words as long as it
 *     does not tie opts.taskCap to the boot path).
 *   - a stray opts/taskCap default appears in startTaskRunnerPolling: the refusal
 *     disappears (cap ≥ 1) and claims/jobs become non-empty → RED.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAP_ZERO_REFUSAL, FORBIDDEN_TASKCAP_WIRING_CLAIM } from './task-runner-copy-pins';

// task-runner.ts (loaded by the child) validates DATABASE_URL at module load; the child
// inherits this value via the env spread below.
process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TSX_CLI = path.resolve(HERE, '../node_modules/.bin/tsx');
const CHILD = path.join(HERE, '__fixtures__', 'main-shaped-zero-opts-child.ts');

/**
 * S256-S2 (shared with task-runner-252-softs.test.ts): the cap-0 copy may NOT tie the
 * opts.taskCap remedy to the scheduler boot path — main starts the poller with ZERO args
 * (pinned by scheduler-main-252-softs.test.ts). Deliberately NARROWER than a plain
 * /scheduler/i: only a taskCap↔boot-path wiring CLAIM is forbidden, never a mere mention.
 * S266-S1 (#266 soft-pack): the matcher now lives in ./task-runner-copy-pins.ts (S266-S4
 * dedup) and additionally requires a wiring VERB in the same clause between taskCap and the
 * boot-path word, so harmless nearby copy ("…see the scheduler log") passes — contract
 * pinned both directions by the S266-S1 corpus test in task-runner-252-softs.test.ts.
 */

interface ChildReport {
  defaultMaxConcurrentRuns: number;
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  claims: string[];
  jobs: unknown[];
}

function runChild(): ChildReport {
  const env = { ...process.env };
  // Drop any host-set value FIRST, then set the literal — the child must see the pin's
  // env, not inherit a coincidental match from the gate host (gate runs also execute the
  // suite with this var set to 1 externally).
  delete env.TASK_RUNNER_MAX_CONCURRENT_RUNS;
  env.TASK_RUNNER_MAX_CONCURRENT_RUNS = '1';
  const proc = spawnSync(TSX_CLI, [CHILD], { env, encoding: 'utf-8', timeout: 120_000 });
  const out = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  assert.equal(proc.status, 0, `child fixture must exit 0 (zero-opts poll under env=1):\n${out}`);
  const jsonLine = (proc.stdout ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .at(-1);
  assert.ok(jsonLine, `child printed its JSON report:\n${out}`);
  return JSON.parse(jsonLine!) as ChildReport;
}

test('S256-S1: zero-opts startTaskRunnerPolling under TASK_RUNNER_MAX_CONCURRENT_RUNS=1 inherits budget 1 and prints the honest cap-0 refusal', () => {
  const r = runChild();

  // The env read at module load was honoured (default is 2 — 1 can only come from the
  // env), i.e. this really was the budget-1 main shape.
  assert.equal(
    r.defaultMaxConcurrentRuns,
    1,
    'the child module-load DEFAULT_MAX_CONCURRENT_RUNS must be the inherited env value 1, ' +
      'not the default 2 — if this is 2 the env was ignored and the whole pin is vacuous',
  );

  const refusals = r.warns.filter((l) => CAP_ZERO_REFUSAL.test(l.msg));
  assert.ok(refusals.length >= 1, 'the zero-opts tick on a budget-1 host prints the refusal');
  for (const refusal of refusals) {
    assert.match(
      refusal.msg,
      /TASK_RUNNER_MAX_CONCURRENT_RUNS/,
      'env remedy named — the only knob a no-args main boot can turn',
    );
    assert.match(
      refusal.msg,
      /opts\.taskCap/,
      'opts-only remedy named for opts-aware call sites',
    );
    assert.doesNotMatch(
      refusal.msg,
      FORBIDDEN_TASKCAP_WIRING_CLAIM,
      'the copy must not claim the scheduler boot path can pass opts.taskCap (zero-args ' +
        'seam pinned by scheduler-main-252-softs.test.ts); narrowed ban, see S256-S2',
    );
  }
  assert.deepEqual(r.claims, [], 'the inherited cap-0 tick never claims a task');
  assert.deepEqual(r.jobs, [], 'the inherited cap-0 tick never reaches a wake');
});

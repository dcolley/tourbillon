/**
 * S256-S1 (#256 ACCEPT soft-pack, info/harden): the CHILD half of the true zero-opts pin.
 *
 * scheduler-main starts the task poller through the SchedulerBootDeps seam with ZERO
 * arguments, so the real main tick calls startTaskRunnerPolling(deps) — NO opts object at
 * all — and the shared budget is inherited from the module-load read of
 * TASK_RUNNER_MAX_CONCURRENT_RUNS (task-runner.ts: `DEFAULT_MAX_CONCURRENT_RUNS =
 * resolveMaxConcurrentRuns()` runs when the module first loads). In-process tests cannot
 * reproduce that: this test file's own process may already have loaded task-runner.ts
 * under a different env, and task-runner-252-softs.test.ts S252-S1b (kept — still useful
 * for the opts-shape half) passes `maxConcurrentRuns: 1` EXPLICITLY, which only
 * coincidentally matches what a budget-1 host inherits.
 *
 * This file IS the literal main path: the parent spawns it with
 * TASK_RUNNER_MAX_CONCURRENT_RUNS=1 in the child's env BEFORE any module load, imports
 * task-runner.ts fresh, and starts the poller with one opts member only —
 * `intervalMs: 20`, the @internal test seam that exists so real-loop pins don't sleep
 * through the 5s production floor. Every budget/cap decision the main tick makes is
 * inherited, never supplied: taskCap arrives at pollTaskRunner as undefined, exactly like
 * a no-args boot on a budget-1 host.
 *
 * Prints one JSON line for the parent to assert (see task-runner-256-softs.test.ts):
 * the module-load DEFAULT_MAX_CONCURRENT_RUNS (must be 1 — proves the env was honoured,
 * not silently ignored in favour of the default 2), the tick count, and every warn line
 * the tick produced (the cap-0 refusal must be there, with both honest remedy halves and
 * no scheduler/main wiring claim).
 */
export {};

process.env.DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';

interface Collector {
  warns: Array<{ msg: string; data?: Record<string, unknown> }>;
  claims: string[];
  jobs: unknown[];
}

async function run(): Promise<void> {
  // Imported AFTER the env is guaranteed present — same eager-DATABASE_URL guard the
  // sibling pins use, but here it must land before the dynamic import below.
  const { startTaskRunnerPolling, DEFAULT_MAX_CONCURRENT_RUNS } = await import('../task-runner');
  type TaskRunnerDeps = import('../task-runner').TaskRunnerDeps;

  const c: Collector = { warns: [], claims: [], jobs: [] };
  const deps = {
    db: null as unknown as TaskRunnerDeps['db'],
    listRunnable: async () => [
      {
        companyId: 'company-1',
        agentId: 'agent-1',
        title: 'Ship the runbook',
        notes: null,
        position: 0,
        attempts: 0,
        paused: false,
        sourceThreadId: null,
        agentName: 'Ada',
        agentUrlKey: 'ada',
        agentStatus: 'active',
        companyStatus: 'active',
      },
    ],
    countActiveRuns: async () => ({ total: 0, task: 0 }),
    claim: async (taskId: string) => {
      c.claims.push(taskId);
      return true;
    },
    startWake: async (job: { runId?: string }) => {
      c.jobs.push(job);
      return { runId: job.runId ?? '', status: 'succeeded' };
    },
    settle: async () => {},
    log: {
      info: () => {},
      warn: (msg: string, data?: Record<string, unknown>) => c.warns.push({ msg, data }),
    },
  } as unknown as TaskRunnerDeps;

  // THE literal main shape: no maxConcurrentRuns, no taskCap — only the millisecond
  // interval seam so one tick completes in milliseconds instead of sleeping past the 5s
  // production floor. Budget and cap are INHERITED from the child env, exactly like a
  // no-args scheduler-main boot on a TASK_RUNNER_MAX_CONCURRENT_RUNS=1 host.
  const poller = startTaskRunnerPolling(deps, { intervalMs: 20 });
  try {
    await poller.whenTicks(1);
  } finally {
    poller.stop();
  }

  process.stdout.write(
    `${JSON.stringify({
      defaultMaxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
      warns: c.warns,
      claims: c.claims,
      jobs: c.jobs,
    })}\n`,
  );
}

void run().catch((err) => {
  process.stderr.write(`main-shaped zero-opts child failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});

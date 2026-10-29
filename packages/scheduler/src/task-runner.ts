/**
 * TASK-RUNNER: the async Run Task queue.
 *
 * `chat_tasks` (the Assistant's private per-agent to-do list) is executed as **Run Task** wakes
 * that share the scheduler's per-agent run budget with heartbeats (Derek, 27 Oct product lock:
 * inference load first — tasks WAIT while the agent's slots are busy, they never stack a
 * parallel unlimited runner on top). A Run Task is a different KIND of job (private chat task,
 * not a company issue), not a second heartbeat: no checkout lock, no issue comment thread, no
 * board visibility.
 *
 * The per-agent shared budget (what the scheduler can run at once, heartbeats included):
 *   freeByBudget = maxConcurrentRuns - activeRuns(agent)      // heartbeat rows count too
 *   freeByCap    = taskCap - activeTaskRuns(agent)            // default min(2, budget-1), never above budget
 *   free         = max(0, min(freeByBudget, freeByCap))
 * `activeRuns` is read from `heartbeat_runs` (queued/running rows whose lastSeenAt is not
 * stale — the same staleness definition as the sweep), so heartbeats and Run Tasks draw from
 * ONE slot pool. Paused tasks and tasks with no attempt budget left never enter the queue; a
 * failed run re-queues to `pending` while attempts last, then parks to `waiting_on_user`.
 *
 * Task wakes bypass the per-agent heartbeat single-flight gate (startTaskWake) — a task would
 * otherwise coalesce behind heartbeats forever — but stay bounded by the slot budget above.
 * Heartbeat wakes are untouched: same lock, same coalescing, same budget.
 *
 * All DB + wake I/O goes through TaskRunnerDeps so the poll logic is unit-testable with fakes
 * (and the production wiring is one `createDefaultTaskRunnerDeps()` away).
 */
import { and, eq, or, isNull, gte, sql } from 'drizzle-orm';
import { db, heartbeatRuns } from '@tourbillon/db';
import {
  listRunnableChatTasks,
  listPendingChatTaskCompanySettings,
  claimChatTaskRun,
  finishChatTaskRun,
  reconcileStaleChatTaskRuns,
  type ChatTaskDb,
  type ChatTaskReconcileResult,
  type RunnableChatTaskRow,
} from '@tourbillon/db';
import type { HeartbeatJobData, ResolvedTaskRunnerSettings, TaskRunnerSettings } from '@tourbillon/shared';
import {
  createTraceLogger,
  resolveHeartbeatLivenessConfig,
  resolveTaskRunnerSettings,
  TASK_PROGRESS_SSE_TYPE,
} from '@tourbillon/shared';
import { randomUUID } from 'crypto';
import type { WakeResult } from './wake-runner';

/** Ceiling for the per-agent Run Task concurrency cap — inside maxConcurrentRuns, never above it. */
export const RUN_TASK_CAP_PER_AGENT = 2;
/** Shared run budget (heartbeat + task) when nothing overrides it. */
export const TASK_RUNNER_DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * Parse TASK_RUNNER_MAX_CONCURRENT_RUNS: unset/blank/garbage → default 2; an explicit 0 is
 * VALID and is the global kill switch (the poller never starts — heartbeats unaffected).
 *
 * S3 edge case (documented behaviour, not a bug): with an explicit budget of 1 there is no
 * task capacity left after the heartbeat reservation — defaultTaskCapPerAgent(1) = 0 — so
 * Run Tasks never start even though the poller runs. Use 0 for the kill switch; anything
 * that should also run tasks needs a budget of at least 2.
 */
export function resolveMaxConcurrentRuns(
  raw: string | undefined = process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS,
): number {
  if (raw === undefined || raw.trim() === '') return TASK_RUNNER_DEFAULT_MAX_CONCURRENT_RUNS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return TASK_RUNNER_DEFAULT_MAX_CONCURRENT_RUNS;
  return Math.trunc(parsed);
}

/** Default shared run budget (heartbeat + task) when nothing overrides it. 0 = kill switch. */
export const DEFAULT_MAX_CONCURRENT_RUNS = resolveMaxConcurrentRuns();

/**
 * S3 (#196): the effective default task cap reserves ONE slot of the shared budget for the
 * heartbeat side. Task wakes deliberately bypass the per-agent heartbeat single-flight gate and
 * heartbeats never consult the task-runner slots before firing, so a task cap equal to the full
 * budget let defaults stack 2 task runs + 1 heartbeat = 3 live runs on one budget of 2. With the
 * reservation, tasks never exceed budget-1 and heartbeats never exceed 1 (agentLocks), so total
 * live (task + heartbeat) respects the shared budget WITHOUT touching the heartbeat path. An
 * explicit `taskCap` opt still overrides this default.
 */
export function defaultTaskCapPerAgent(maxConcurrentRuns: number): number {
  return Math.max(0, Math.min(RUN_TASK_CAP_PER_AGENT, maxConcurrentRuns - 1));
}

export interface TaskRunSlotState {
  /** Runs (heartbeat + task) currently occupying the agent's slot budget. */
  total: number;
  /** Of those, the ones that are Run Task (invocationSource === 'task'). */
  task: number;
}

export interface TaskRunnerDeps {
  db: ChatTaskDb;
  /** Pending, non-paused, attempt-budget-left tasks in claim order. */
  listRunnable(): Promise<RunnableChatTaskRow[]>;
  /** How many run slots the agent is currently burning (both kinds). */
  countActiveRuns(agentId: string): Promise<TaskRunSlotState>;
  /** Atomic claim guard: only claims a still-pending, unpaused task with attempts left. */
  claim(taskId: string, runId: string, maxAttempts: number): Promise<boolean>;
  /** Fire one Run Task wake; resolves when the run fully finishes. */
  startWake(job: HeartbeatJobData): Promise<WakeResult>;
  /** Settle the chat_tasks row after the run (only touches in_progress rows). */
  settle(taskId: string, status: 'pending' | 'waiting_on_user' | 'done', note?: string): Promise<void>;
  /** High-level progress event for the parent chat (SSE chip), never a tool transcript. */
  emitProgress?(event: ChatTaskProgressEvent): void;
  /**
   * S199a: warn/error are optional so existing info-only loggers still satisfy the interface,
   * but the poll-failure path PREFERS them (greppable by level) and only falls back to info.
   */
  log?: {
    info: (msg: string, data?: Record<string, unknown>) => void;
    warn?: (msg: string, data?: Record<string, unknown>) => void;
    error?: (msg: string, data?: Record<string, unknown>) => void;
  };
}

export interface ChatTaskProgressEvent {
  companyId: string;
  agentId: string;
  chatTaskId: string;
  runId: string;
  /** High-level stage shown to the board: task started / finished / needs another look. */
  stage: 'started' | 'done' | 'needs_review';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  title: string;
}

/** How many task runs an agent may start right now (never negative). */
export function freeTaskRunSlots(
  slot: TaskRunSlotState,
  maxConcurrentRuns = DEFAULT_MAX_CONCURRENT_RUNS,
  taskCap = defaultTaskCapPerAgent(maxConcurrentRuns),
): number {
  return Math.max(0, Math.min(maxConcurrentRuns - slot.total, taskCap - slot.task));
}

/** One task + one free slot → one Run Task wake job (kind 'task', base model, full tools). */
export function buildTaskRunWake(task: RunnableChatTaskRow, runId: string): HeartbeatJobData {
  return {
    agentId: task.agentId,
    agentName: task.agentName,
    companyId: task.companyId,
    invocationSource: 'task',
    wakeReason: 'task',
    kind: 'task',
    runId,
    // Deliberately NOT taskId — this is not an issue assignment; no checkout lock, no parking.
    chatTaskId: task.taskId,
    chatTaskTitle: task.title,
    chatTaskNotes: task.notes ?? undefined,
  };
}

/**
 * Settle a finished task run: completed → `done`; failed with attempts left → `pending`
 * (fresh attempt, new run); failed with none left / skipped → `waiting_on_user` (parked).
 * Exported for tests + reuse; matches finishChatTaskRun's status set.
 */
export function taskRunSettleStatus(
  result: Pick<WakeResult, 'status'>,
  attemptsUsed: number,
  maxAttempts = 2,
): 'pending' | 'waiting_on_user' | 'done' {
  if (result.status === 'succeeded') return 'done';
  if (result.status === 'failed' && attemptsUsed < maxAttempts) return 'pending';
  return 'waiting_on_user';
}

export interface TaskRunPollSummary {
  polled: number;
  /** Task runs started this tick, one entry per claimed task. */
  started: Array<{ agentId: string; taskId: string; runId: string; done: Promise<void> }>;
  /** Agents that had pending tasks but no free slot (or no attempt budget) this tick. */
  skippedFull: number;
  /** Rows skipped because their agent or company is not active (never claimed, B1). */
  skippedInactive: number;
  /** Rows skipped because the company disabled Run Task (settings.taskRunner.enabled=false, S1). */
  skippedDisabled: number;
  /**
   * S199c: agents whose slot-count/claim work threw this tick. They are skipped in isolation —
   * the rest of the queue still gets its turn (one bad agent must never starve the tick).
   */
  skippedErrored: number;
}

/**
 * S199b: how long a "task-run slots full, deferring" line stays quiet per agent after being
 * logged. The poller ticks every 30s; without this window a busy agent's deferral printed a
 * line every tick forever. First deferral always logs; repeats inside the window are silent.
 */
export const DEFER_LOG_WINDOW_MS = 10 * 60_000;

/**
 * S1: dig the taskRunner block out of the companies.settings jsonb and resolve it with the
 * shared defaults/clamps. `enabled=false` skips enqueue for the whole company; the other
 * resolved fields (maxConcurrentTasks, maxAttemptsPerTask) drive the per-agent gating below.
 */
export function resolveTaskRunnerSettingsForCompany(companySettings: unknown): ResolvedTaskRunnerSettings {
  const block = (companySettings ?? undefined) as { taskRunner?: TaskRunnerSettings } | undefined;
  return resolveTaskRunnerSettings(block);
}

/**
 * One poll tick: find runnable tasks, gate them through the shared slot budget, claim each
 * winner atomically, and fire its Run Task wake. Nothing here blocks on model latency — the
 * wake promises settle + emit their own progress events as they finish.
 */
export async function pollTaskRunner(
  deps: TaskRunnerDeps,
  opts: {
    limit?: number;
    maxAttempts?: number;
    maxConcurrentRuns?: number;
    taskCap?: number;
    /**
     * S199b: per-agent memory for the "task-run slots full, deferring" rate limit. The poller
     * loop owns one Map across ticks; tests can inject their own. Absent (bare pollTaskRunner
     * calls in tests) → every deferral logs, the historic behaviour.
     */
    deferLogMemory?: Map<string, number>;
    /** S199b: quiet window, default DEFER_LOG_WINDOW_MS. */
    deferLogWindowMs?: number;
    /** S199b: clock injection for tests (defaults to Date.now). */
    now?: () => number;
  } = {},
): Promise<TaskRunPollSummary> {
  const maxConcurrent = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;

  const rows = await deps.listRunnable();
  const summary: TaskRunPollSummary = {
    polled: rows.length,
    started: [],
    skippedFull: 0,
    skippedInactive: 0,
    skippedDisabled: 0,
    skippedErrored: 0,
  };
  // S233-S7: no early return on `rows.length === 0` — the defer-log cleanup below still has
  // to run, and an empty queue means every agent has left it (clear the whole Map).

  // Group in claim order (the query already orders by agentId → position → createdAt).
  // One agent belongs to one company, so an agent group shares one resolved settings block.
  const byAgent = new Map<string, { tasks: RunnableChatTaskRow[]; settings: ResolvedTaskRunnerSettings }>();
  for (const row of rows) {
    if (row.paused === true) continue; // paused skips enqueue (product lock)
    // B1 (PR #196 hold): a paused/archived agent or company must NEVER be claimed — claiming
    // burns runner_attempts and runWake's `skipped` parks the task to waiting_on_user, so on
    // first boot every inactive agent's to-dos would be silently parked. Skip before the slot
    // check and before the claim; the row stays pending (attempts untouched) until the agent
    // is active again. Not `skippedFull` — this is not a budget deferral.
    if (row.agentStatus !== 'active' || row.companyStatus !== 'active') {
      summary.skippedInactive += 1;
      continue;
    }
    // S1: company master switch (settings.taskRunner.enabled === false) — same discipline as
    // B1: skip before the claim, the row stays pending with its attempt budget untouched.
    const settings = resolveTaskRunnerSettingsForCompany(row.companySettings);
    if (!settings.enabled) {
      summary.skippedDisabled += 1;
      continue;
    }
    const group = byAgent.get(row.agentId);
    if (group) group.tasks.push(row);
    else byAgent.set(row.agentId, { tasks: [row], settings });
  }

  // S199b + S233-S7: the defer-log rate limit memory drops an agent when it gets free slots
  // again (pollOneAgent) AND when it has LEFT this tick's runnable queue (no row grouped for
  // it at all — drained, cancelled, paused, inactive or company-disabled). Historic behaviour
  // was only the free-slot drop: an agent whose tasks emptied kept its stamp forever (bounded
  // leak) and, if it refilled inside the quiet window, its next deferral was silenced even
  // though its deferral history had reset. An empty queue clears the whole Map.
  if (opts.deferLogMemory) {
    for (const agentId of opts.deferLogMemory.keys()) {
      if (!byAgent.has(agentId)) opts.deferLogMemory.delete(agentId);
    }
  }
  if (byAgent.size === 0) return summary;

  const now = opts.now ?? Date.now;
  const deferLogWindowMs = opts.deferLogWindowMs ?? DEFER_LOG_WINDOW_MS;

  for (const [agentId, group] of byAgent) {
    // S199c: one agent's countActiveRuns/claim blowing up (a DB hiccup, a driver bug like the
    // post-#196 Date crash) must NOT abort the tick for every other agent — before this, the
    // throw escaped pollTaskRunner and the poller's .catch swallowed the whole tick, starving
    // the queue until the next interval. Isolate per agent: log, count, continue.
    try {
      await pollOneAgent(agentId, group);
    } catch (err) {
      summary.skippedErrored += 1;
      const data = { agentId, error: err instanceof Error ? err.message : String(err) };
      if (deps.log?.error) deps.log.error('task-run agent poll failed', data);
      else if (deps.log?.warn) deps.log.warn('task-run agent poll failed', data);
      else deps.log?.info('task-run agent poll failed', data);
    }
  }
  return summary;

  async function pollOneAgent(
    agentId: string,
    group: { tasks: RunnableChatTaskRow[]; settings: ResolvedTaskRunnerSettings },
  ): Promise<void> {
    const { tasks, settings } = group;
    // opts overrides win (tests + explicit callers); otherwise the resolved company settings
    // clamp per agent. Defaults land on the historic 2/2 values.
    const maxAttempts = opts.maxAttempts ?? settings.maxAttemptsPerTask;
    // S3 (#196) x S1 (#202): the default task cap honours BOTH the company's per-company
    // maxConcurrentTasks AND the heartbeat-slot reservation — tasks never exceed either the
    // company budget or budget-1 (one slot stays free for the heartbeat side). An explicit
    // opts.taskCap still overrides.
    const taskCap =
      opts.taskCap ?? Math.min(settings.maxConcurrentTasks, defaultTaskCapPerAgent(maxConcurrent));
    const slot = await deps.countActiveRuns(agentId);
    const free = freeTaskRunSlots(slot, maxConcurrent, taskCap);
    if (free <= 0) {
      summary.skippedFull += 1;
      // S199b: the default logger has no level filtering, so an every-tick line here meant a
      // busy agent printed "task-run slots full, deferring" once per 30s tick forever. Keep
      // the FIRST deferral loud; repeats for the same agent inside the quiet window stay
      // silent. Once the agent gets free slots again the memory entry is dropped, so the
      // NEXT time it defers it is loud again. The skippedFull counter is untouched — the
      // tick summary still counts every deferral, only the log line is rate-limited.
      const lastLoggedAt = opts.deferLogMemory?.get(agentId);
      if (lastLoggedAt === undefined || now() - lastLoggedAt >= deferLogWindowMs) {
        deps.log?.info('task-run slots full, deferring', { agentId, pending: tasks.length, slot });
        opts.deferLogMemory?.set(agentId, now());
      }
      return;
    }
    if (opts.deferLogMemory) opts.deferLogMemory.delete(agentId);
    const batch = tasks.slice(0, free);
    for (const task of batch) {
      const runId = randomUUID();
      const claimed = await deps.claim(task.taskId, runId, maxAttempts);
      if (!claimed) continue; // paused / cancelled / re-prioritised / attempt budget gone
      const job = buildTaskRunWake(task, runId);
      deps.emitProgress?.({
        companyId: task.companyId,
        agentId,
        chatTaskId: task.taskId,
        runId,
        stage: 'started',
        status: 'running',
        title: task.title,
      });
      const done = (async () => {
        let result: WakeResult;
        try {
          result = await deps.startWake(job);
        } catch (err) {
          result = {
            runId,
            status: 'failed',
            errorText: err instanceof Error ? err.message : String(err),
          };
        }
        const settle = taskRunSettleStatus(result, task.attempts + 1, maxAttempts);
        await deps.settle(task.taskId, settle, result.errorText);
        deps.emitProgress?.({
          companyId: task.companyId,
          agentId,
          chatTaskId: task.taskId,
          runId,
          stage: settle === 'done' ? 'done' : 'needs_review',
          status: result.status,
          title: task.title,
        });
      })();
      summary.started.push({ agentId, taskId: task.taskId, runId, done });
    }
  }
}

// ─── Production wiring ───────────────────────────────────────────────────────

/** Live runs currently burning the agent's shared slot budget (heartbeat + task, both kinds). */
export async function countActiveRuns(
  database: ChatTaskDb,
  agentId: string,
): Promise<TaskRunSlotState> {
  const { staleSec } = resolveHeartbeatLivenessConfig();
  const staleCutoff = new Date(Date.now() - staleSec * 1000);
  const rows = await database
    .select({ invocationSource: heartbeatRuns.invocationSource })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.status} in ('queued', 'running')`,
        // A dead run stops eating budget the same way the stale sweep defines it: stale means
        // lastSeenAt older than the liveness window. Fresh-or-null still counts (run in flight).
        // HOTFIX (post-#196, TEST 28 Oct): a raw sql`${staleCutoff}` interpolates the Date into
        // postgres.js and throws ERR_INVALID_ARG_TYPE every tick — use the drizzle gte operator
        // (same style as wake-runner's lt(lastSeenAt, cutoff)) so it binds as a real parameter.
        or(isNull(heartbeatRuns.lastSeenAt), gte(heartbeatRuns.lastSeenAt, staleCutoff)),
      ),
    );
  let task = 0;
  for (const row of rows) {
    if (row.invocationSource === 'task') task += 1;
  }
  return { total: rows.length, task };
}

export interface DefaultTaskRunnerDepsOptions {
  database?: ChatTaskDb;
  startWake?: (job: HeartbeatJobData) => Promise<WakeResult>;
  emitProgress?: (event: ChatTaskProgressEvent) => void;
  log?: TaskRunnerDeps['log'];
}

/** The poll logic as a TaskRunnerDeps over the real database + wake runner. */
export function createDefaultTaskRunnerDeps(
  options: DefaultTaskRunnerDepsOptions = {},
): TaskRunnerDeps {
  const database = options.database ?? (db as unknown as ChatTaskDb);
  return {
    db: database,
    // S3 (#202 ACCEPT softs): list against each company's RESOLVED maxAttemptsPerTask, not a
    // fixed 5. Without this, pending rows whose attempts already spent a lowered company
    // budget were listed every tick and refused by the claim every tick — permanently. The
    // caps come from the same resolver the poller/claim/sweep use (one budget, one source).
    listRunnable: async () => {
      const pendingCompanies = await listPendingChatTaskCompanySettings(database);
      const maxAttemptsByCompany: Record<string, number> = {};
      for (const c of pendingCompanies) {
        maxAttemptsByCompany[c.companyId] = resolveTaskRunnerSettingsForCompany(c.companySettings)
          .maxAttemptsPerTask;
      }
      return listRunnableChatTasks(database, { limit: 25, maxAttemptsByCompany });
    },
    countActiveRuns: (agentId) => countActiveRuns(database, agentId),
    claim: (taskId, runId, maxAttempts) =>
      claimChatTaskRun(database, { taskId, runId, attemptBudget: maxAttempts }).then(
        (row) => row !== null,
      ),
    // Dynamic imports keep the pure queue logic importable (and unit-testable) without an
    // eager ioredis client / full Mastra stack at module load.
    startWake: options.startWake ?? ((job) => import('./wake-runner').then((m) => m.startTaskWake(job))),
    settle: (taskId, status, note) =>
      finishChatTaskRun(database, { taskId, status, note }).then(() => undefined),
    // HOTFIX (post-#196): production called startTaskRunnerPolling() with no log, so every
    // poll failure (e.g. the countActiveRuns Date crash) was silent. Default to the scheduler
    // trace logger so failures surface in scheduler logs.
    log: options.log ?? createTraceLogger('task-run', {}),
    emitProgress:
      options.emitProgress ??
      ((event) => {
        // Minimal parent-chat bridge: one SSE event per stage. No tool transcript, no replies.
        // S4 (#196): the type is the shared pinned constant, so the enum, the publisher and the
        // web parser can no longer drift apart (the old `task_run_update`/`chat_task_progress` gap).
        void import('./redis-pub')
          .then(({ redisPub }) =>
            redisPub.publish(
              `sse:${event.companyId}`,
              JSON.stringify({ type: TASK_PROGRESS_SSE_TYPE, ...event }),
            ),
          )
          .catch(() => undefined);
      }),
  };
}

export interface TaskRunnerPoller {
  /**
   * S236-S3: stopping ALSO settles every pending `whenTicks` waiter immediately — after stop()
   * no further tick can ever complete, so a waiter would otherwise sit on its 30s guard
   * timeout for no reason. Pending waiters reject with a `poller stopped` error (an already
   * satisfied n still resolves).
   */
  stop(): void;
  /**
   * S233-S6: resolves once `n` ticks have COMPLETED (success or tick-level failure). The
   * real-loop behaviour pins used to sleep 50–11_500 ms and hope the right number of ticks
   * had fired; they await this instead. A ref'd timeout guard keeps the event loop alive
   * while waiting (the poll interval itself is unref'd for scheduler shutdown hygiene, so
   * without the guard node would drain the loop and cancel the pending test) and REJECTS
   * with the completed-tick count after timeoutMs — a stalled poller fails fast instead of
   * hanging. The kill-switch stub (maxConcurrentRuns = 0) resolves immediately — a poller
   * that never starts never ticks, and a test must not hang on it.
   */
  whenTicks(n?: number, timeoutMs?: number): Promise<void>;
}

/**
 * S236-S2: resolve the poller's setInterval delay. `intervalMs` is an @internal, TEST-ONLY
 * seam (see startTaskRunnerPolling) and is NOT trusted: `0` / `NaN` / negative clamp to ≥1 ms
 * so a mistyped option can never turn the scheduler into a ~1ms hot loop. Production callers
 * omit it and land on `intervalSec * 1000` — the 5s floor / env default. Exported (pure) so
 * the clamp is pinned directly instead of being timing-inferred.
 */
export function resolvePollIntervalMs(
  intervalMs: number | undefined,
  intervalSec: number,
): number {
  const raw = intervalMs ?? intervalSec * 1000;
  return Number.isFinite(raw) ? Math.max(1, raw) : 1;
}

/**
 * S236-S2 (same class, production side): the seconds interval keeps its historic 5s floor, but
 * garbage in TASK_RUNNER_POLL_INTERVAL_SEC used to yield NaN — which setInterval coerces to 1,
 * i.e. the very hot loop the floor exists to prevent. Non-finite input falls back to 30.
 */
export function resolvePollIntervalSec(
  raw: string | number | undefined,
  fallbackSec = 30,
): number {
  const parsed = Number(raw ?? fallbackSec);
  return Math.max(5, Number.isFinite(parsed) ? parsed : fallbackSec);
}

/**
 * S2 (#196 follow-up): stale Run Task sweep for chat_tasks — the chat-side mirror of
 * sweepStaleHeartbeatRuns. A Run Task whose heartbeat_runs row went terminal (stale sweep /
 * startup sweep), missing (crash between claim and wake insert), or stale itself can never
 * settle: the in-memory loop that owns finishChatTaskRun died with the old worker. Settle
 * those rows back to `pending` (attempts left) or `waiting_on_user` (budget exhausted),
 * using the same liveness window as the heartbeat sweep. Runs on the scheduler stale-sweep
 * interval and once at boot (startup-sweep.ts).
 */
export async function sweepStaleChatTaskRuns(
  database: ChatTaskDb = db as unknown as ChatTaskDb,
): Promise<ChatTaskReconcileResult> {
  const { staleSec } = resolveHeartbeatLivenessConfig();
  const cutoff = new Date(Date.now() - staleSec * 1000);
  return reconcileStaleChatTaskRuns(database, {
    staleCutoff: cutoff,
    // S-soft: park/re-queue on the company's OWN resolved budget (settings.taskRunner.
    // maxAttemptsPerTask, clamped) — the same number the claim used. Budget 1 parks, never
    // re-queues in a loop; a fixed 2 here would re-queue past the company's limit forever.
    resolveMaxAttempts: (settings) => resolveTaskRunnerSettingsForCompany(settings).maxAttemptsPerTask,
  });
}

/**
 * Poller loop for scheduler startup. Non-reentrant (a slow tick skips, never queues) and
 * never rejects — errors land in the log so one bad task cannot kill the scheduler.
 * TASK_RUNNER_MAX_CONCURRENT_RUNS=0 is the global kill switch: the loop never starts.
 */
export function startTaskRunnerPolling(
  deps?: TaskRunnerDeps,
  opts: {
    intervalSec?: number;
    /**
     * S233-S6 test seam: an explicit millisecond interval that BYPASSES the 5s production
     * floor, so real-loop pins complete many ticks in milliseconds instead of sleeping. It
     * wins over intervalSec when both are given. Production callers pass neither (or just
     * intervalSec) and stay floored at 5s / the env default.
     *
     * S236-S2: @internal / TEST-ONLY and NOT trusted — `0` / `NaN` / negative clamp to ≥1 ms
     * via resolvePollIntervalMs, so a mistyped option can never hot-loop the scheduler.
     */
    intervalMs?: number;
    maxConcurrentRuns?: number;
    taskCap?: number;
  } = {},
): TaskRunnerPoller {
  const maxConcurrent = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (maxConcurrent <= 0) {
    // Kill switch honoured before anything is wired up: no interval, no poll, no claims.
    deps?.log?.info('task-run poller disabled (max concurrent runs = 0)');
    return {
      stop: () => undefined,
      // S233-S6: a never-starting poller never ticks; resolve immediately so a test awaiting
      // whenTicks on the kill switch cannot hang.
      whenTicks: async () => undefined,
    };
  }
  const intervalSec = resolvePollIntervalSec(opts.intervalSec ?? process.env.TASK_RUNNER_POLL_INTERVAL_SEC);
  const runner = deps ?? createDefaultTaskRunnerDeps();
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  // S236-S3: once stopped, no tick can ever complete — new whenTicks(n) callers must not
  // queue onto a dead poller either.
  let stopped = false;
  // S199b: one Map for the whole poller lifetime → the defer-log rate limit persists across
  // ticks (30s each), so a busy agent logs its first deferral and then stays quiet.
  const deferLogMemory = new Map<string, number>();

  // S233-S6: tick-completion ledger for whenTicks(). A tick is counted once its promise
  // settles — success OR tick-level failure — mirroring what the old sleeps implicitly waited
  // for. Waiters are one-shot and fire in arrival order once the count reaches their n.
  // S236-S3: each waiter also carries an `abort` so stop() can settle it promptly instead of
  // leaving it on its 30s guard timer.
  let ticksCompleted = 0;
  const tickWaiters: Array<{ n: number; resolve: () => void; abort: (err: Error) => void }> = [];
  const settleTick = (): void => {
    ticksCompleted += 1;
    for (let i = tickWaiters.length - 1; i >= 0; i -= 1) {
      if (ticksCompleted >= tickWaiters[i]!.n) {
        tickWaiters.splice(i, 1)[0]!.resolve();
      }
    }
  };

  const tick = (): void => {
    if (busy) return;
    busy = true;
    void pollTaskRunner(runner, {
      maxConcurrentRuns: maxConcurrent,
      taskCap: opts.taskCap,
      deferLogMemory,
    })
      .then((summary) => {
        if (summary.polled > 0) {
          runner.log?.info('task-run poll', {
            polled: summary.polled,
            started: summary.started.length,
            deferred: summary.skippedFull,
            inactive: summary.skippedInactive,
            disabled: summary.skippedDisabled,
            // S233-S4: per-agent isolation (S199c) was invisible in the per-tick line — an
            // agent whose slot-count/claim work threw was counted only in summary.skippedErrored,
            // which the log dropped on the floor. Surface it so a quietly-erroring agent shows up.
            errored: summary.skippedErrored,
          });
        }
      })
      .catch((err) => {
        // S199a: poll failures used to log at `info` — buried in the noise, not greppable by
        // level. Raise to error → warn → info (first available) so the message content is
        // unchanged but the line carries a level the log tooling can filter on.
        const data = { error: err instanceof Error ? err.message : String(err) };
        if (runner.log?.error) runner.log.error('task-run poll failed', data);
        else if (runner.log?.warn) runner.log.warn('task-run poll failed', data);
        else runner.log?.info('task-run poll failed', data);
      })
      .finally(() => {
        busy = false;
        settleTick();
      });
  };

  const intervalMs = resolvePollIntervalMs(opts.intervalMs, intervalSec);
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      // S236-S3: a stopped poller can never complete another tick, so a pending whenTicks(n)
      // is a guaranteed guard-timeout reject with a 30s delay for no reason. Settle every
      // waiter NOW — the guard timers are cleared in `abort`, and an already-satisfied n
      // never sat in this list (whenTicks resolves it up front).
      stopped = true;
      const stopErr = new Error('task-run poller stopped before the awaited tick count completed');
      for (const waiter of tickWaiters.splice(0)) waiter.abort(stopErr);
    },
    whenTicks: (n = 1, timeoutMs = 30_000) =>
      ticksCompleted >= n
        ? Promise.resolve()
        : stopped
          ? Promise.reject(new Error(`whenTicks(${n}): task-run poller is stopped (${ticksCompleted}/${n} ticks completed)`))
          : new Promise<void>((resolve, reject) => {
              const waiter: { n: number; resolve: () => void; abort: (err: Error) => void } = {
                n,
                resolve: () => undefined,
                abort: () => undefined,
              };
              const settle = (fn: () => void): void => {
                clearTimeout(guard);
                const i = tickWaiters.indexOf(waiter);
                if (i >= 0) tickWaiters.splice(i, 1);
                fn();
              };
              // Ref'd guard timer: also keeps the event loop alive so the unref'd poll interval
              // actually fires while a test awaits ticks; a stalled poller REJECTS fast.
              const guard = setTimeout(() => {
                settle(() =>
                  reject(
                    new Error(`whenTicks(${n}): only ${ticksCompleted}/${n} ticks completed after ${timeoutMs}ms`),
                  ),
                );
              }, timeoutMs);
              waiter.resolve = () => settle(resolve);
              // S236-S3: stop() calls this — same one-shot settle, different rejection cause.
              waiter.abort = (err: Error) => settle(() => reject(err));
              tickWaiters.push(waiter);
            }),
  };
}

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
 *   freeByCap    = taskCap - activeTaskRuns(agent)            // default 2, never above budget
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
  claimChatTaskRun,
  finishChatTaskRun,
  reconcileStaleChatTaskRuns,
  type ChatTaskDb,
  type ChatTaskReconcileResult,
  type RunnableChatTaskRow,
} from '@tourbillon/db';
import type { HeartbeatJobData, ResolvedTaskRunnerSettings, TaskRunnerSettings } from '@tourbillon/shared';
import { createTraceLogger, resolveHeartbeatLivenessConfig, resolveTaskRunnerSettings } from '@tourbillon/shared';
import { randomUUID } from 'crypto';
import type { WakeResult } from './wake-runner';

/** Default per-agent Run Task concurrency cap — inside maxConcurrentRuns, never above it. */
export const RUN_TASK_CAP_PER_AGENT = 2;
/** Shared run budget (heartbeat + task) when nothing overrides it. */
export const TASK_RUNNER_DEFAULT_MAX_CONCURRENT_RUNS = 2;

/**
 * Parse TASK_RUNNER_MAX_CONCURRENT_RUNS: unset/blank/garbage → default 2; an explicit 0 is
 * VALID and is the global kill switch (the poller never starts — heartbeats unaffected).
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
  log?: { info: (msg: string, data?: Record<string, unknown>) => void };
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
  taskCap = RUN_TASK_CAP_PER_AGENT,
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
}

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
  opts: { limit?: number; maxAttempts?: number; maxConcurrentRuns?: number; taskCap?: number } = {},
): Promise<TaskRunPollSummary> {
  const maxConcurrent = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;

  const rows = await deps.listRunnable();
  const summary: TaskRunPollSummary = {
    polled: rows.length,
    started: [],
    skippedFull: 0,
    skippedInactive: 0,
    skippedDisabled: 0,
  };
  if (rows.length === 0) return summary;

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

  for (const [agentId, group] of byAgent) {
    const { tasks, settings } = group;
    // opts overrides win (tests + explicit callers); otherwise the resolved company settings
    // clamp per agent. Defaults land on the historic 2/2 values.
    const maxAttempts = opts.maxAttempts ?? settings.maxAttemptsPerTask;
    const taskCap = opts.taskCap ?? settings.maxConcurrentTasks;
    const slot = await deps.countActiveRuns(agentId);
    const free = freeTaskRunSlots(slot, maxConcurrent, taskCap);
    if (free <= 0) {
      summary.skippedFull += 1;
      deps.log?.info('task-run slots full, deferring', { agentId, pending: tasks.length, slot });
      continue;
    }
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
  return summary;
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
    listRunnable: () => listRunnableChatTasks(database, { limit: 25, maxAttempts: 5 }),
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
        void import('./redis-pub')
          .then(({ redisPub }) =>
            redisPub.publish(
              `sse:${event.companyId}`,
              JSON.stringify({ type: 'chat_task_progress', ...event }),
            ),
          )
          .catch(() => undefined);
      }),
  };
}

export interface TaskRunnerPoller {
  stop(): void;
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
  return reconcileStaleChatTaskRuns(database, { staleCutoff: cutoff });
}

/**
 * Poller loop for scheduler startup. Non-reentrant (a slow tick skips, never queues) and
 * never rejects — errors land in the log so one bad task cannot kill the scheduler.
 * TASK_RUNNER_MAX_CONCURRENT_RUNS=0 is the global kill switch: the loop never starts.
 */
export function startTaskRunnerPolling(
  deps?: TaskRunnerDeps,
  opts: { intervalSec?: number; maxConcurrentRuns?: number; taskCap?: number } = {},
): TaskRunnerPoller {
  const maxConcurrent = opts.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (maxConcurrent <= 0) {
    // Kill switch honoured before anything is wired up: no interval, no poll, no claims.
    deps?.log?.info('task-run poller disabled (max concurrent runs = 0)');
    return {
      stop: () => undefined,
    };
  }
  const intervalSec = Math.max(5, opts.intervalSec ?? Number(process.env.TASK_RUNNER_POLL_INTERVAL_SEC ?? 30));
  const runner = deps ?? createDefaultTaskRunnerDeps();
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = (): void => {
    if (busy) return;
    busy = true;
    void pollTaskRunner(runner, {
      maxConcurrentRuns: maxConcurrent,
      taskCap: opts.taskCap,
    })
      .then((summary) => {
        if (summary.polled > 0) {
          runner.log?.info('task-run poll', {
            polled: summary.polled,
            started: summary.started.length,
            deferred: summary.skippedFull,
            inactive: summary.skippedInactive,
            disabled: summary.skippedDisabled,
          });
        }
      })
      .catch((err) => {
        runner.log?.info('task-run poll failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        busy = false;
      });
  };

  timer = setInterval(tick, intervalSec * 1000);
  timer.unref?.();
  tick();
  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

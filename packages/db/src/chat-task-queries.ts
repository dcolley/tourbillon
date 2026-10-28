/**
 * TASK-1: the Assistant's private chat task list — query layer.
 *
 * One private, todo-style list per (company, agent): what the agent said it would do in chat,
 * is doing, or is waiting on the human for. Deliberately NOT company issues — no assignees, no
 * board visibility, nothing goes through the control plane. Every function takes the
 * `{ companyId, agentId }` scope and filters by it, so one agent can never read or write
 * another agent's rows, and neither can another company.
 *
 * The list is keyed by the same scope as `assistant_active_threads`, so it survives Clear chat
 * (a Clear pins a fresh Mastra thread; the rows stay). `sourceThreadId` records the thread the
 * item was created in, for audit only. `requestedBy*` records who asked for it (the board user
 * on the chat request, best-effort — Derek, 26 Oct); `notes` may carry the interested-parties
 * list ("Notify: …" lines) — there is no notify transport in this story.
 *
 * Same shape as company-llm-provider-queries: `database` is injectable (the app pool by default,
 * an in-memory PGlite database in tests).
 */
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { db } from './client';
import type * as schema from './schema/index';
import { agents, companies, heartbeatRuns } from './schema/index';
import { CHAT_TASK_OPEN_STATUSES, chatTasks, type ChatTask, type ChatTaskStatus } from './schema/chat-tasks';

/** Any Drizzle Postgres database over this schema (the app pool, or an in-memory one in tests). */
export type ChatTaskDb = PgDatabase<PgQueryResultHKT, typeof schema>;

const defaultDb = db as unknown as ChatTaskDb;

/** The (company, agent) scope one chat task list belongs to. */
export interface ChatTaskScope {
  companyId: string;
  agentId: string;
}

/** Who asked for a task, best-effort (may name a non-user until real login, #107). */
export interface ChatTaskRequester {
  userId?: string | null;
  displayName?: string | null;
}

export interface ListChatTasksOptions {
  /** Include `done` + `cancelled` (default: open items only). */
  includeClosed?: boolean;
}

export interface AddChatTaskInput {
  title: string;
  notes?: string | null;
  status?: ChatTaskStatus;
  /** Omitted = after the current tail (max position + 1). */
  position?: number;
  sourceThreadId?: string | null;
  /** Stamped by the tool layer from the chat request context, never supplied by the model. */
  requestedBy?: ChatTaskRequester | null;
}

export interface UpdateChatTaskInput {
  id: string;
  title?: string;
  notes?: string | null;
  status?: ChatTaskStatus;
  position?: number;
  /** Overridable (Derek, 26 Oct): e.g. the human says "that one's Bob's". */
  requestedBy?: ChatTaskRequester | null;
}

const scopeWhere = (scope: ChatTaskScope) => [
  eq(chatTasks.companyId, scope.companyId),
  eq(chatTasks.agentId, scope.agentId),
];

const OPEN_STATUSES = [...CHAT_TASK_OPEN_STATUSES];

/** Open = not done and not cancelled. */
export function isOpenChatTaskStatus(status: ChatTaskStatus): boolean {
  return (CHAT_TASK_OPEN_STATUSES as readonly string[]).includes(status);
}

/**
 * The agent's task list. Open items by default (`includeClosed` also returns done/cancelled),
 * ordered by `position` then creation time.
 */
export async function listChatTasks(
  scope: ChatTaskScope,
  options: ListChatTasksOptions = {},
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask[]> {
  const where = options.includeClosed
    ? and(...scopeWhere(scope))
    : and(...scopeWhere(scope), inArray(chatTasks.status, OPEN_STATUSES));
  return database
    .select()
    .from(chatTasks)
    .where(where)
    .orderBy(asc(chatTasks.position), asc(chatTasks.createdAt));
}

/** Number of open (not done/cancelled) items in the agent's list — used to cap the list size. */
export async function countOpenChatTasks(
  scope: ChatTaskScope,
  database: ChatTaskDb = defaultDb,
): Promise<number> {
  const [row] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(chatTasks)
    .where(and(...scopeWhere(scope), inArray(chatTasks.status, OPEN_STATUSES)));
  return Number(row?.n ?? 0);
}

/**
 * Add one item to the agent's list. Position defaults to the tail; `done` gets `completedAt`
 * set immediately (an item added as already-done is a bookkeeping entry, still legal).
 */
export async function addChatTask(
  scope: ChatTaskScope,
  input: AddChatTaskInput,
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask> {
  const status: ChatTaskStatus = input.status ?? 'pending';
  let position = input.position;
  if (position === undefined) {
    const [tail] = await database
      .select({ max: sql<number>`coalesce(max(${chatTasks.position}), -1)::int` })
      .from(chatTasks)
      .where(and(...scopeWhere(scope)));
    position = Number(tail?.max ?? -1) + 1;
  }
  const now = new Date();
  const [row] = await database
    .insert(chatTasks)
    .values({
      companyId: scope.companyId,
      agentId: scope.agentId,
      title: input.title.trim(),
      notes: input.notes?.trim() || null,
      status,
      position,
      requestedByUserId: input.requestedBy?.userId?.trim() || null,
      requestedByDisplayName: input.requestedBy?.displayName?.trim() || null,
      sourceThreadId: input.sourceThreadId ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: status === 'done' ? now : null,
    })
    .returning();
  return row!;
}

/** Update title/notes/status/position/requestedBy of one item. Null = the id is not in this agent's list. */
export async function updateChatTask(
  scope: ChatTaskScope,
  input: UpdateChatTaskInput,
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) updates.title = input.title.trim();
  if (input.notes !== undefined) updates.notes = input.notes?.trim() || null;
  if (input.position !== undefined) updates.position = input.position;
  if (input.requestedBy !== undefined) {
    updates.requestedByUserId = input.requestedBy?.userId?.trim() || null;
    updates.requestedByDisplayName = input.requestedBy?.displayName?.trim() || null;
  }
  if (input.status !== undefined) {
    updates.status = input.status;
    updates.completedAt = input.status === 'done' ? new Date() : null;
  }
  const [row] = await database
    .update(chatTasks)
    .set(updates)
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .returning();
  return row ?? null;
}

/** Move one item to another status; an optional note is appended to `notes`. */
export async function setChatTaskStatus(
  scope: ChatTaskScope,
  input: { id: string; status: ChatTaskStatus; note?: string | null },
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const [existing] = await database
    .select()
    .from(chatTasks)
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .limit(1);
  if (!existing) return null;
  const note = input.note?.trim();
  const notes = note ? [existing.notes, note].filter(Boolean).join('\n') : existing.notes;
  const now = new Date();
  const [row] = await database
    .update(chatTasks)
    .set({
      status: input.status,
      notes,
      updatedAt: now,
      completedAt: input.status === 'done' ? now : null,
    })
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .returning();
  return row ?? null;
}

// ─── TASK-RUNNER ──────────────────────────────────────────────────────────────
// The async Run Task queue shares the scheduler's per-agent run budget with
// heartbeats: these reads/writes let the scheduler task-runner poller find
// pending tasks, claim them ONLY when a budget slot frees, and record the
// outcome. Paused items never appear in `listRunnableChatTasks` (paused skips
// enqueue — product lock), and one-task attempt budget is bounded by
// `maxAttempts` so a failing task parks itself to `waiting_on_user`.

export interface RunnableChatTaskRow {
  taskId: string;
  companyId: string;
  agentId: string;
  title: string;
  notes: string | null;
  position: number;
  attempts: number;
  /** Always false in practice (the query filters paused rows); the task-runner double-checks it. */
  paused: boolean;
  sourceThreadId: string | null;
  agentName: string;
  agentUrlKey: string;
  agentStatus: string;
  companyStatus: string;
  /**
   * Raw companies.settings jsonb. The poller reads `settings.taskRunner` through
   * resolveTaskRunnerSettings (enabled / maxConcurrentTasks / maxAttemptsPerTask, S1).
   */
  companySettings: unknown;
}

/**
 * Pending, non-paused chat tasks with attempt budget left, in claim order
 * (per agent, then position, then age). Joined against agents + companies so
 * the caller can skip inactive agents/companies before burning a run slot.
 */
export async function listRunnableChatTasks(
  database: ChatTaskDb,
  opts: { limit?: number; maxAttempts?: number } = {},
): Promise<RunnableChatTaskRow[]> {
  const maxAttempts = opts.maxAttempts ?? 2;
  return database
    .select({
      taskId: chatTasks.id,
      companyId: chatTasks.companyId,
      agentId: chatTasks.agentId,
      title: chatTasks.title,
      notes: chatTasks.notes,
      position: chatTasks.position,
      attempts: chatTasks.runnerAttempts,
      paused: chatTasks.paused,
      sourceThreadId: chatTasks.sourceThreadId,
      agentName: agents.name,
      agentUrlKey: agents.urlKey,
      agentStatus: agents.status,
      companyStatus: companies.status,
      companySettings: companies.settings,
    })
    .from(chatTasks)
    .innerJoin(agents, eq(agents.id, chatTasks.agentId))
    .innerJoin(companies, eq(companies.id, chatTasks.companyId))
    .where(
      and(
        eq(chatTasks.status, 'pending'),
        eq(chatTasks.paused, false),
        sql`${chatTasks.runnerAttempts} < ${maxAttempts}`,
      ),
    )
    .orderBy(asc(chatTasks.agentId), asc(chatTasks.position), asc(chatTasks.createdAt))
    .limit(opts.limit ?? 25);
}

/**
 * Claim one task for a Run Task (conditional pending→in_progress). Returns the
 * claimed row, or null when it is no longer claimable (paused, cancelled, or
 * another worker got there first). The attempt count and run id are written in
 * the same statement — a claim cannot double-fire, which is what keeps the
 * shared run budget honest.
 */
export async function claimChatTaskRun(
  database: ChatTaskDb,
  input: { taskId: string; runId: string; attemptBudget?: number },
): Promise<ChatTask | null> {
  const maxAttempts = input.attemptBudget ?? 2;
  const [row] = await database
    .update(chatTasks)
    .set({
      status: 'in_progress',
      runnerAttempts: sql`${chatTasks.runnerAttempts} + 1`,
      runnerLastRunId: input.runId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(chatTasks.id, input.taskId),
        eq(chatTasks.status, 'pending'),
        sql`NOT ${chatTasks.paused}`,
        sql`${chatTasks.runnerAttempts} < ${maxAttempts}`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * End a claimed Run Task: back to `pending` (retry budget left), or to
 * `waiting_on_user` / `done`. Only touches `in_progress` rows — a cancelled or
 * re-prioritised task is never silently resurrected.
 */
export async function finishChatTaskRun(
  database: ChatTaskDb,
  input: { taskId: string; status: 'pending' | 'waiting_on_user' | 'done'; note?: string | null },
): Promise<ChatTask | null> {
  const [existing] = await database
    .select()
    .from(chatTasks)
    .where(eq(chatTasks.id, input.taskId))
    .limit(1);
  if (!existing) return null;
  const note = input.note?.trim();
  const notes = note ? [existing.notes, note].filter(Boolean).join('\n') : existing.notes;
  const now = new Date();
  const [row] = await database
    .update(chatTasks)
    .set({
      status: input.status,
      notes,
      updatedAt: now,
      completedAt: input.status === 'done' ? now : null,
    })
    .where(and(eq(chatTasks.id, input.taskId), eq(chatTasks.status, 'in_progress')))
    .returning();
  return row ?? null;
}

// ─── TASK-RUNNER reconcile (S2, #196 follow-up) ──────────────────────────────
// If the scheduler dies mid-Run-Task, the in-memory poll loop that would have called
// finishChatTaskRun is gone: the chat_tasks row can stay `in_progress` forever while its
// heartbeat_runs row is failed (startup sweep), stale (interval sweep), or never inserted
// (crash between claim and wake). These reads settle exactly those runner-owned rows back to
// a sane state, mirroring the heartbeat sweep's liveness rule.

export interface StaleChatTaskRunRow {
  taskId: string;
  companyId: string;
  agentId: string;
  title: string;
  /** runner_attempts at read time (the same budget claim/finish use). */
  attempts: number;
  runnerLastRunId: string;
  /**
   * Raw companies.settings jsonb (null when the company row is missing). The reconciler reads
   * `settings.taskRunner.maxAttemptsPerTask` through `resolveMaxAttempts` (S-soft), so a park
   * decision uses the SAME budget the poller claimed with — never a fixed 2.
   */
  companySettings: unknown;
}

/**
 * Runner-claimed `in_progress` rows whose linked Run Task wake can no longer settle them:
 * the linked heartbeat_runs row is terminal, missing, or stale (`last_seen_at` older than
 * `staleCutoff` — the same liveness definition `sweepStaleHeartbeatRuns` and
 * `countActiveRuns` use; a live-status row with a null `last_seen_at` counts as live, like
 * the budget read). `runner_last_run_id IS NOT NULL` keeps human-set `in_progress` rows
 * (setChatTaskStatus, never claimed) off-limits, and the `updated_at < staleCutoff` grace
 * keeps the reconciler from racing a fresh claim whose heartbeat_runs row is not inserted
 * yet (claim → insert is not atomic).
 */
export async function listStaleChatTaskRuns(
  database: ChatTaskDb,
  opts: { staleCutoff: Date; limit?: number },
): Promise<StaleChatTaskRunRow[]> {
  // HOTFIX (same class as #199's countActiveRuns): the repo's postgres-js client runs with
  // prepare:false, so drizzle hands (sql, params) straight to client.unsafe() — a raw Date in
  // this template's params throws ERR_INVALID_ARG_TYPE on every reconcile call (boot + sweep →
  // scheduler exit 1). Pre-serialise the cutoff to ISO; the timestamp column compares it fine.
  const deadRun = sql`not exists (
    select 1 from ${heartbeatRuns} live
    where live.id = ${chatTasks.runnerLastRunId}
      and live.status in ('queued', 'running')
      and (live.last_seen_at is null or live.last_seen_at >= ${opts.staleCutoff.toISOString()})
  )`;
  // isNotNull() guards the WHERE; Drizzle cannot narrow the column type, so the cast is the
  // only way to hand back a non-null runnerLastRunId (the filter makes it safe).
  const rows = (await database
    .select({
      taskId: chatTasks.id,
      companyId: chatTasks.companyId,
      agentId: chatTasks.agentId,
      title: chatTasks.title,
      attempts: chatTasks.runnerAttempts,
      runnerLastRunId: chatTasks.runnerLastRunId,
      companySettings: companies.settings,
    })
    .from(chatTasks)
    // LEFT join: a chat row whose company row vanished must still be reconciled (settings
    // read as null → default budget), never stranded in_progress by an inner-join miss.
    .leftJoin(companies, eq(companies.id, chatTasks.companyId))
    .where(
      and(
        eq(chatTasks.status, 'in_progress'),
        isNotNull(chatTasks.runnerLastRunId),
        lt(chatTasks.updatedAt, opts.staleCutoff),
        deadRun,
      ),
    )
    .orderBy(asc(chatTasks.updatedAt))
    .limit(opts.limit ?? 50)) as StaleChatTaskRunRow[];
  return rows;
}

export interface ChatTaskReconcileResult {
  requeued: number;
  parked: number;
  /** The rows settled this pass, for logging/tests. */
  reconciled: StaleChatTaskRunRow[];
}

/**
 * Settle crashed/stale Run Task rows: attempts left → `pending` (the poller picks it up as a
 * fresh attempt), budget exhausted → `waiting_on_user` (parked for the human), with a short
 * note appended to `notes`. Goes through finishChatTaskRun, so the in_progress guard still
 * applies — a run that settles normally between the read and the write is left alone.
 * Callers pass `staleCutoff = now - HEARTBEAT_STALE_SEC` (interval sweep) or `bootTime`
 * (startup reconcile, where nothing claimed before boot can still be live).
 */
export async function reconcileStaleChatTaskRuns(
  database: ChatTaskDb,
  opts: {
    staleCutoff: Date;
    /** Fixed budget override (tests / explicit callers) — wins over `resolveMaxAttempts`. */
    maxAttempts?: number;
    /**
     * S-soft (#196 follow-up): per-company attempt budget — resolves the row's raw
     * companies.settings jsonb to the SAME maxAttemptsPerTask the poller claimed with
     * (settings.taskRunner.maxAttemptsPerTask, clamped). Budget 1 therefore PARKS on the
     * first lost run instead of re-queueing forever. Default budget 2 when unset.
     */
    resolveMaxAttempts?: (companySettings: unknown) => number;
    now?: Date;
    limit?: number;
  },
): Promise<ChatTaskReconcileResult> {
  const stale = await listStaleChatTaskRuns(database, opts);
  const result: ChatTaskReconcileResult = { requeued: 0, parked: 0, reconciled: [] };
  for (const row of stale) {
    const maxAttempts = opts.maxAttempts ?? opts.resolveMaxAttempts?.(row.companySettings) ?? 2;
    const requeue = row.attempts < maxAttempts;
    const settled = await finishChatTaskRun(database, {
      taskId: row.taskId,
      status: requeue ? 'pending' : 'waiting_on_user',
      note: requeue
        ? '[runner] Run Task lost (worker died or run row missing); re-queued for a fresh attempt.'
        : '[runner] Run Task lost (worker died or run row missing); attempt budget exhausted — parked.',
    });
    if (settled) {
      if (requeue) result.requeued += 1;
      else result.parked += 1;
      result.reconciled.push(row);
    }
  }
  return result;
}

/** Task-runner pause/resume: a paused task skips enqueue until resumed. */
export async function setChatTaskPaused(
  scope: ChatTaskScope,
  input: { id: string; paused: boolean },
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const [row] = await database
    .update(chatTasks)
    .set({ paused: input.paused, updatedAt: new Date() })
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .returning();
  return row ?? null;
}

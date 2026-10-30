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
import { recordChatTaskActivity } from './chat-task-activity';

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

/**
 * S263-S4 (#263 softs): read one item from this agent's own list. The tool-side audit row
 * needs the PRIOR status ("Status queued → done", matching the runner rows' previousProductStatus
 * pairing), which the post-update row alone cannot give. Same (companyId, agentId) scope as every
 * other chat-task read — a foreign id is null, never another agent's row.
 */
export async function getChatTask(
  scope: ChatTaskScope,
  input: { id: string },
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  const [row] = await database
    .select()
    .from(chatTasks)
    .where(and(eq(chatTasks.id, input.id), ...scopeWhere(scope)))
    .limit(1);
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

/** The Run Task claim-order projection (joined rows carry agent/company liveness for the poller). */
const runnableProjection = {
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
};

/**
 * Pending, non-paused chat tasks with attempt budget left, in claim order, joined against
 * agents + companies so the caller can skip inactive agents/companies before burning a run slot.
 *
 * S8 (#196) fairness: a single global `order by agentId limit N` let one agent's backlog starve
 * every agent behind it (25+ pending rows for agent A meant agent B never appeared). Candidates
 * are now picked per agent: each runnable agent gets a fair share of the global limit
 * (ceil(limit / agents), optionally capped by `perAgentLimit`), filled in claim order
 * (position, then age) inside that agent. Agents keep their claim-order prefix; nobody starves.
 */
export async function listRunnableChatTasks(
  database: ChatTaskDb,
  opts: {
    limit?: number;
    maxAttempts?: number;
    perAgentLimit?: number;
    /**
     * S3 (#202 ACCEPT softs): per-company RESOLVED attempt caps (the company's
     * settings.taskRunner.maxAttemptsPerTask, clamped — the caller resolves it, the db layer
     * stays settings-blind). A pending row whose attempts already spent its OWN company's
     * budget drops out of the listing entirely, instead of being listed and refused by the
     * claim every tick (the old fixed `maxAttempts` bound listed rows over a lowered company
     * budget forever). Companies absent from the map fall back to the historic listing bound
     * (5 — the pre-fix fixed cap) so an unknown company never starves behind the CASE. The
     * EMPTY map uses the SAME bound (#208 S3): a task inserted between the company read and
     * this listing must not be held to a different (tighter) fallback than a task whose
     * company simply raced out of the map.
     */
    maxAttemptsByCompany?: Record<string, number>;
  } = {},
): Promise<RunnableChatTaskRow[]> {
  const entries = Object.entries(opts.maxAttemptsByCompany ?? {});
  // #208 S3: ONE fallback for both branches. The old `(entries.length ? 5 : 2)` meant the
  // empty-map path capped at 2 while the CASE's ELSE capped at 5 — the same raced-in task was
  // judged by two different bounds depending on whether the company read happened to see it.
  const defaultCap = opts.maxAttempts ?? 5;
  // Searched CASE: one cap per company, bind params throughout (no inlined SQL). At least one
  // ::int cast matters — Postgres cannot infer an untyped CASE parameter's type when NO branch
  // is typed and would compare `integer < text` (PGlite raises; verified empirically: dropping
  // BOTH casts fails, either single cast alone still infers the int type — same class of
  // bind-typing bug as #199/#202).
  const attemptsFilter = entries.length
    ? sql`${chatTasks.runnerAttempts} < (case ${sql.join(
        entries.map(
          ([companyId, cap]) => sql`when ${chatTasks.companyId} = ${companyId} then ${Math.trunc(cap)}::int`,
        ),
        sql` `,
      )} else ${defaultCap}::int end)`
    : sql`${chatTasks.runnerAttempts} < ${defaultCap}`;
  const limit = opts.limit ?? 25;
  const runnableWhere = and(
    eq(chatTasks.status, 'pending'),
    eq(chatTasks.paused, false),
    attemptsFilter,
  );

  const agentRows = await database
    .selectDistinct({ agentId: chatTasks.agentId })
    .from(chatTasks)
    .where(runnableWhere)
    .orderBy(asc(chatTasks.agentId));
  const agentIds = agentRows.map((r) => r.agentId);
  if (agentIds.length === 0 || limit <= 0) return [];

  // Fair share per agent; ceil so small agent counts still fill the global limit, max(1,·) so
  // an agent is never left out purely because there are more agents than slots this tick.
  const fairShare = Math.max(1, Math.min(opts.perAgentLimit ?? limit, Math.ceil(limit / agentIds.length)));
  // Caller's per-agent ceiling — backfill never hands one agent more than it asked for.
  const perAgentCeiling = opts.perAgentLimit ?? Number.POSITIVE_INFINITY;

  const picked: RunnableChatTaskRow[] = [];
  const fetchedByAgent = new Map<string, number>();
  const fetchChunk = async (agentId: string, offset: number, cap: number): Promise<RunnableChatTaskRow[]> => {
    const rows = await database
      .select(runnableProjection)
      .from(chatTasks)
      .innerJoin(agents, eq(agents.id, chatTasks.agentId))
      .innerJoin(companies, eq(companies.id, chatTasks.companyId))
      .where(and(runnableWhere, eq(chatTasks.agentId, agentId)))
      .orderBy(asc(chatTasks.position), asc(chatTasks.createdAt))
      .offset(offset)
      .limit(cap);
    fetchedByAgent.set(agentId, (fetchedByAgent.get(agentId) ?? 0) + rows.length);
    return rows;
  };

  for (const agentId of agentIds) {
    const remaining = limit - picked.length;
    if (remaining <= 0) break;
    picked.push(...(await fetchChunk(agentId, 0, Math.min(fairShare, remaining))));
  }

  // S7 (#205 softs) backfill: fair share UNDER-fills the global limit when an agent has fewer
  // rows than its share (A: 30 rows, B: 1, limit 25 → old code returned 14, wasting 11 idle
  // slots this tick — slots are gated per agent downstream anyway, so B's unused share cannot be
  // borrowed by anyone). One extra pass tops up from the agents that FILLED their share (they
  // may have more rows); agents that returned fewer than fairShare are exhausted, so they are
  // never re-queried. Bounded: at most one further chunk per agent, per-agent ceiling honoured,
  // claim order (position, then age) preserved inside each agent.
  //
  // S210c (#210 softs) — the offset(already) race, documented not fixed: `already` counts rows
  // pass 1 saw, but pass 2 re-reads the live table `already` rows into the SAME (position,
  // createdAt) order. A concurrent claim (or insert/pause) between the passes shifts that
  // window, so within one tick a row can be skipped (claimed after pass 1, so pass 2's offset
  // pages past it) or re-listed (a row shifted left into the offset). Both are harmless:
  // claimChatTaskRun is a CAS (`WHERE status = 'pending'` plus pause/attempt guards), so a
  // re-listed row just fails its second claim, and a skipped row is pending again for the NEXT
  // tick's listing — no task is lost, no slot is double-spent.
  for (const agentId of agentIds) {
    const remaining = limit - picked.length;
    if (remaining <= 0) break;
    const already = fetchedByAgent.get(agentId) ?? 0;
    if (already < fairShare || already >= perAgentCeiling) continue;
    const cap = Math.min(fairShare, remaining, perAgentCeiling - already);
    if (cap <= 0) continue;
    picked.push(...(await fetchChunk(agentId, already, cap)));
  }
  return picked;
}

/**
 * S9 (#196): move one task to the FRONT of its agent's list so it truly sorts first.
 *
 * `updateChatTask({ position: 0 })` alone does not: an older row already sitting at 0 keeps
 * winning the (position, createdAt) tiebreak, so the "prioritised" task is still claimed last.
 * Front-prioritisation therefore assigns `min(position) - 1` across the agent's own rows — the
 * `position` column is a plain integer, and one strictly-below-everything value sorts ahead of
 * all of them in both listChatTasks and the Run Task claim order. Repeated prioritisation walks
 * negative; that is fine and stays collision-free. An explicit `position` still passes straight
 * through to the normal update (caller-owned ordering, same semantics as updateMyTask).
 */
export async function prioritizeChatTask(
  scope: ChatTaskScope,
  input: { id: string; position?: number },
  database: ChatTaskDb = defaultDb,
): Promise<ChatTask | null> {
  let position = input.position;
  if (position === undefined) {
    const [head] = await database
      .select({ min: sql<number>`coalesce(min(${chatTasks.position}), 0)::int` })
      .from(chatTasks)
      .where(and(...scopeWhere(scope)));
    position = Number(head?.min ?? 0) - 1;
  }
  return updateChatTask(scope, { id: input.id, position }, database);
}

/**
 * S3 (#202 ACCEPT softs): the (companyId, settings) pairs that currently HAVE runnable work —
 * one row per company with at least one pending, unpaused chat task. The scheduler resolves
 * each company's maxAttemptsPerTask from this and feeds `listRunnableChatTasks` a per-company
 * cap, so over-budget pending rows never re-enter the listing. Grouped, not joined to tasks:
 * this is a small company-level read that precedes the (capped) task listing.
 *
 * #208 S2: grouped on the companies PK (functional dependency covers `settings` — cleaner than
 * grouping on the jsonb value) and ORDERED by company id. A caller-supplied `limit` is then a
 * STABLE lowest-id prefix; previously the read had `limit 100` with no ORDER BY, so past 100
 * pending companies the ones silently dropped from the map fell back to the listing's default
 * cap — re-opening the exact lowered-budget relisting bug the per-company CASE exists to fix.
 * There is deliberately NO default limit: one row per company with pending work is a tiny read,
 * and any silent truncation re-opens that bug (pass `limit` only when the caller accepts it).
 */
export async function listPendingChatTaskCompanySettings(
  database: ChatTaskDb,
  opts: { limit?: number } = {},
): Promise<Array<{ companyId: string; companySettings: unknown }>> {
  const query = database
    .select({ companyId: companies.id, companySettings: companies.settings })
    .from(chatTasks)
    .innerJoin(companies, eq(companies.id, chatTasks.companyId))
    .where(and(eq(chatTasks.status, 'pending'), eq(chatTasks.paused, false)))
    .groupBy(companies.id)
    .orderBy(asc(companies.id));
  return opts.limit === undefined ? query : query.limit(opts.limit);
}

/**
 * S245-S3a (#245): one company's raw `settings` jsonb by id — the LIVE read the chat-side
 * addMyTask warning uses on every call, mirroring how the scheduler poller re-resolves
 * `settings.taskRunner` per tick from the row. The chat controller caches its tool assembly,
 * so a flag computed only at build time goes stale when Settings toggles
 * `taskRunner.enabled`; this read is the freshness seam. Returns null when the company row
 * does not exist; THROWS on a db hiccup — callers decide their fallback (never swallow here).
 */
export async function getCompanySettingsSnapshot(
  companyId: string,
  database: ChatTaskDb = defaultDb,
): Promise<unknown | null> {
  const row = await database.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { settings: true },
  });
  return row?.settings ?? null;
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
    /**
     * TASK-AUDIT (#258): write one activity_log lifecycle row per settled run
     * (chat_task.error re-queue / chat_task.parked park). Opt-in so the db layer stays
     * audit-silent for callers that don't want it; the scheduler sweep turns it on. Best-effort
     * (recordChatTaskActivity never throws here).
     */
    audit?: boolean;
    /**
     * S263-S3: a failed audit insert is swallowed by contract — without this sink it is
     * invisible. The scheduler sweep passes a logger so a broken audit write surfaces in
     * scheduler logs while the settle itself still goes through (best-effort, never throws).
     */
    onAuditError?: (err: unknown, row: StaleChatTaskRunRow) => void;
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
      if (opts.audit) {
        await recordChatTaskActivity({
          companyId: row.companyId,
          taskId: row.taskId,
          action: requeue ? 'chat_task.error' : 'chat_task.parked',
          actorType: 'system',
          actorId: 'task-runner',
          actorName: 'Task runner',
          details: {
            agentId: row.agentId,
            ...(row.runnerLastRunId ? { runId: row.runnerLastRunId } : {}),
            title: row.title,
            status: requeue ? 'pending' : 'waiting_on_user',
            productStatus: 'error',
            previousStatus: 'in_progress',
            previousProductStatus: 'running',
            attempts: row.attempts,
            note: 'Run Task lost (worker died or run row missing).',
          },
        }, {
          database,
          // S263-S3: never silent — the caller's sink hears about a broken audit insert
          // (still best-effort: recordChatTaskActivity swallows when no sink is given).
          ...(opts.onAuditError ? { onError: (err: unknown) => opts.onAuditError!(err, row) } : {}),
        });
      }
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

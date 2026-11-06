/**
 * TASK-1: the Assistant's private chat task list — the seven AgentController tools (five list tools + TASK-RUNNER's pause/prioritise controls).
 *
 * One private, todo-style list per (company, agent), stored in `chat_tasks` (Tourbillon-owned,
 * not company issues). The agent uses these to track what it said it would do in chat; when the
 * human asks "what's left / status / what are you working on?" it answers from `listMyTasks`.
 * `getInbox` stays for assigned company ISSUES only — that is the source of the old confusion
 * this closes.
 *
 * Scope comes ONLY from the chat request context (`agentId` + `companyId` via
 * `extractToolRuntimeContext`); there is no model-supplied agent/company parameter, and a call
 * without a context returns an error and writes nothing. Registered for dashboard chat and Run Task wakes (wake kind 'task') only —
 * never in CONTROL_PLANE_TOOLS / ROLE_TOOLS / heartbeat runs.
 *
 * Transport: direct Postgres (`toolDb()` → the app pool, injectable in tests) through the
 * @tourbillon/db chat-task query layer. `source_thread_id` is stamped from the runtime context's
 * threadId (or the heartbeat AsyncLocalStorage context) for audit; `requestedBy` is stamped from
 * the chat request's session user when one is resolvable (see apps/web request-user plumbing).
 */
import { createTool } from '@mastra/core/tools';
import {
  addChatTask,
  countOpenChatTasks,
  getChatTask,
  getCompanySettingsSnapshot,
  listChatTasks,
  prioritizeChatTask,
  resumeChatTask,
  setChatTaskPaused,
  setChatTaskStatus,
  updateChatTask,
  recordChatTaskActivity,
  chatTaskProductStatus,
  CHAT_TASK_STATUSES,
  CHAT_TASK_ASK_PREFIX,
  CHAT_TASK_FAILURE_PREFIX,
  CHAT_TASK_RECENT_COMPLETED_DEFAULT_MIN,
  composeChatTaskNoteLine,
  extractChatTaskNoteLine,
  hasChatTaskUserFacingSignal,
  setChatTaskNoteLine,
  isOpenChatTaskStatus,
  type ChatTask,
  type ChatTaskScope,
} from '@tourbillon/db';
import { resolveTaskRunnerSettings, createTraceLogger, type CompanySettings } from '@tourbillon/shared';
import { z } from 'zod';
import { extractToolRuntimeContext } from './api-client';
import { getCurrentHeartbeatContext } from '../heartbeat-context';
import { toolDb } from './tool-db';

/** Ids of the seven chat-task tools — used to keep them out of heartbeat/issue tool sets. */
export const CHAT_TASK_TOOL_IDS = [
  'listMyTasks',
  'addMyTask',
  'updateMyTask',
  'completeMyTask',
  'cancelMyTask',
  'pauseMyTask',
  'prioritizeMyTask',
] as const;

/** Hard cap so the list stays a memory aid, not a backlog. */
export const CHAT_TASK_LIST_CAP = 50;

const CHAT_TASK_TITLE_MAX = 200;

function missingScope(): { error: string; message: string } {
  return {
    error: 'missing_scope',
    message:
      'Chat-task tools need the chat request context (agentId + companyId). Nothing was read or written.',
  };
}

/** Scope + audit info from the request context only — never from model-supplied ids. */
function chatTaskScope(requestContext: unknown): (ChatTaskScope & { threadId?: string }) | null {
  const ctx = extractToolRuntimeContext(requestContext);
  if (!ctx.agentId || !ctx.companyId) return null;
  // /api/agui wraps chat runs in runWithHeartbeatContext too, so fall back to the ALS context.
  const threadId = ctx.threadId ?? getCurrentHeartbeatContext()?.threadId;
  return { companyId: ctx.companyId, agentId: ctx.agentId, threadId };
}

function requestingUser(requestContext: unknown): { userId?: string; displayName?: string } | null {
  const ctx = extractToolRuntimeContext(requestContext);
  if (!ctx.requestingUserId && !ctx.requestingUserDisplayName) return null;
  return { userId: ctx.requestingUserId, displayName: ctx.requestingUserDisplayName };
}

const statusSchema = z.enum(CHAT_TASK_STATUSES);

function statusCounts(tasks: ChatTask[]): string {
  const open = tasks.filter((t) => isOpenChatTaskStatus(t.status));
  const by = (s: string) => tasks.filter((t) => t.status === s).length;
  const bits = Object.entries({
    pending: by('pending'),
    in_progress: by('in_progress'),
    waiting_on_user: by('waiting_on_user'),
    done: by('done'),
    cancelled: by('cancelled'),
  })
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return `${open.length} open (${bits.join(', ') || 'none'})`;
}

function row(task: ChatTask) {
  const ask = extractChatTaskNoteLine(task.notes, CHAT_TASK_ASK_PREFIX);
  const failure = extractChatTaskNoteLine(task.notes, CHAT_TASK_FAILURE_PREFIX);
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    ...(task.notes ? { notes: task.notes } : {}),
    // #340: the structured signals the concierge needs verbatim — `ask` = what the human must
    // supply; `failure` = an honest runner-failure park (present it as a FAILURE, never as a
    // question to the human).
    ...(ask ? { ask } : {}),
    ...(failure ? { failure } : {}),
    ...(task.requestedByDisplayName ? { requestedBy: task.requestedByDisplayName } : {}),
  };
}

const notFound = (id: string) => ({
  error: 'task_not_found',
  message: `No chat task "${id}" in your list. Call listMyTasks to see it.`,
});

/**
 * #340 (PM product ask): `waiting_on_user` without a stated ask is a LYING status — the
 * observed case parked "Run Task lost (worker died…)" on the human with nothing to answer.
 * Any agent-driven move INTO waiting_on_user must carry the concrete ask; a runner FAILURE
 * park is the runner's own `failure:` note path and must never be faked as a user wait.
 */
function missingAsk(): { error: string; message: string } {
  return {
    error: 'missing_ask',
    message:
      'waiting_on_user must state what the human needs to supply — pass ask: "the concrete input / ' +
      'decision / action you need" (or put an "ask: …" line in notes). If this is actually a ' +
      'lost/failed Run Task, do NOT mark it waiting_on_user: report the failure (the runner ' +
      'already stamps a "failure:" note) and let the human decide whether to resume it.',
  };
}

/**
 * TASK-AUDIT (#258): lifecycle audit row for a human/agent-driven chat-task change (the runner
 * writes its own claim/start/settle rows from the scheduler). The ACTOR is the agent owning the
 * list — that is who made the change, whatever chat turn asked for it; the board user who
 * requested it rides in details.requestedBy when the tool context resolved one. Best-effort:
 * `recordChatTaskActivity` never throws at this caller (losing an audit row must not lose the
 * write the human just asked for). S263-S3: the swallow is never silent — a failed insert warns
 * through the scheduler-style trace logger, same "…activity log failed" shape as the runner path.
 */
const auditTracer = createTraceLogger('chat-task-tools', {});

async function logToolActivity(
  scope: ChatTaskScope & { threadId?: string },
  task: ChatTask,
  action: 'chat_task.created' | 'chat_task.updated',
  requestContext: unknown,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const runId = extractToolRuntimeContext(requestContext).runId;
  await recordChatTaskActivity({
    companyId: scope.companyId,
    taskId: task.id,
    action,
    actorType: 'agent',
    actorId: scope.agentId,
    details: {
      title: task.title,
      status: task.status,
      productStatus: chatTaskProductStatus(task.status),
      ...(runId ? { runId } : {}),
      ...(task.sourceThreadId ? { threadId: task.sourceThreadId } : {}),
      ...(task.requestedByDisplayName ? { requestedBy: task.requestedByDisplayName } : {}),
      ...extra,
    },
  }, {
    database: toolDb(),
    onError: (err: unknown) =>
      auditTracer.warn('chat-task activity log failed', {
        taskId: task.id,
        action,
        error: err instanceof Error ? err.message : String(err),
      }),
  });
}

export const listMyTasksTool = createTool({
  id: 'listMyTasks',
  description:
    'List YOUR private chat task list — the to-dos you promised in this chat. DEFAULT (#337): ' +
    'incomplete tasks (pending / in_progress / waiting_on_user) PLUS tasks COMPLETED in the last ' +
    `${CHAT_TASK_RECENT_COMPLETED_DEFAULT_MIN} minutes — the "what is on / what just finished" shape for chat. ` +
    'Pass recentCompletedMinutes to widen/narrow that tail (0 = incomplete only) or includeClosed ' +
    'for the FULL done + cancelled history. ' +
    'This is NOT company issues or assignments — for assigned company ISSUES use getInbox instead. ' +
    'Answers TASK questions ("what is on the task list") only — "what issues are open / on the board" ' +
    'is an ISSUES question: use getInbox / search, never this list (#342). ' +
    'A "list" request is READ-ONLY: report this result and stop — never call updateMyTask / addMyTask / ' +
    'completeMyTask / cancelMyTask to answer a list request. ' +
    'Call this FIRST whenever the human asks what is left, what you are working on, your status, ' +
    'what you promised, or whether something got done — then answer in plain language from the result. ' +
    'A waiting_on_user row carries an `ask` field: tell the human exactly that. A row with a ' +
    '`failure` field is a runner FAILURE park — say so; do not invent a question for it. ' +
    'Never invent items: if the list is empty, answer in plain text instead; do not call showTaskList for it ' +
    '(the card needs at least one task).',
  inputSchema: z.object({
    includeClosed: z.boolean().optional().describe('Also return the FULL done and cancelled history (default false).'),
    recentCompletedMinutes: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 60)
      .optional()
      .describe(
        `With includeClosed unset: include done tasks completed within this many minutes ` +
          `(default ${CHAT_TASK_RECENT_COMPLETED_DEFAULT_MIN}; 0 = incomplete only).`,
      ),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const tasks = await listChatTasks(
      scope,
      {
        includeClosed: inputData.includeClosed,
        ...(inputData.recentCompletedMinutes !== undefined
          ? { recentCompletedMinutes: inputData.recentCompletedMinutes }
          : {}),
      },
      toolDb(),
    );
    const open = tasks.filter((t) => isOpenChatTaskStatus(t.status));
    return {
      summary:
        tasks.length === 0
          ? 'No open tasks.'
          : `${statusCounts(tasks)}${open.length === tasks.length ? '' : ' (includes tasks completed in the recent window)'}`,
      count: tasks.length,
      open: open.length,
      tasks: tasks.map(row),
    };
  },
});

const addMyTaskInputSchema = z.object({
  titles: z
    .array(z.string().min(1).max(CHAT_TASK_TITLE_MAX))
    .min(1)
    .max(10)
    .describe('One or more task titles, e.g. ["Draft the runbook", "Check the restore backup"].'),
  notes: z.string().max(2000).optional().describe('Optional context/next step, or a "notify:" list of interested parties.'),
  status: statusSchema.optional().describe('Initial status (default pending).'),
  ask: z
    .string()
    .max(500)
    .optional()
    .describe(
      'Required with status=waiting_on_user: the concrete input / decision / action you need ' +
        'from the human (stored as an "ask:" line on the notes).',
    ),
});

/** #242 live-chat copy: queue non-simple work for Run Task, then STOP — no in-turn grind. */
const ADD_MY_TASK_CHAT_DESCRIPTION =
  'Queue work for the async Run Task queue (taskRunner) and record it on YOUR private chat task ' +
  'list (NOT company issues — do not use createIssue/createSubtask for chat to-dos). Use this ' +
  'whenever a chat ask is NOT simple — multi-step investigation, planning that adapts across ' +
  'goals/issues, or anything needing a tool loop: add it here with an imperative title (+ notes ' +
  'capturing what to do), tell the human it is queued for Run Task, and let taskRunner execute it ' +
  '— do NOT grind tool loops for it in the live chat turn (progress returns as <task-progress …> ' +
  'updates). Also use when the human asks you to remember to do something. Simple one-shot asks ' +
  '(a plain answer, one read, a clarifying question) stay in the live turn. Optional notes may ' +
  'name interested parties to notify about progress (there is no automatic notifying). ' +
  'Titles are imperative, ≤200 chars.';

/**
 * S243-S2 (#243 soft-pack): the addMyTask copy registered on background Run Task wakes
 * (wake kind 'task'). Same id/schema/execute as the chat copy — only the description differs.
 * A Run Task wake EXECUTES the queued work; calling addMyTask there to re-queue the same work
 * is always wrong (it would loop the task against itself). The wake kind reaches this copy via
 * assembleAgentTools({ chatTaskTools: 'run-task-wake' }) — set from wake.kind === 'task' in
 * packages/scheduler/src/wake-runner.ts.
 */
const ADD_MY_TASK_WAKE_DESCRIPTION =
  'Record a genuinely NEW follow-up on YOUR private chat task list from inside a background ' +
  'Run Task wake (NOT company issues — do not use createIssue/createSubtask for chat to-dos). ' +
  'You are EXECUTING a queued task right now: do the work directly with your tools and track it ' +
  'with updateMyTask / completeMyTask — do NOT call addMyTask to re-queue the work you are ' +
  'already executing (queueing for Run Task is the live chat turn\'s job; re-queueing here just ' +
  'loops the task). Only add a task that Run Task should pick up LATER, after this run. ' +
  'Titles are imperative, ≤200 chars.';

/**
 * S243-S3 (#243 soft-pack) product rule: addMyTask ALWAYS records the task, but when the
 * company disabled Run Task (settings.taskRunner.enabled === false) the tool RESULT carries an
 * operator warning — "queued but Run Task is OFF — enable it or break the ask into simple steps
 * done live in chat" — so the Concierge never claims a queue that will never drain and never
 * infinite-loops tools trying to work the ask live instead. Bounded on purpose: no scheduler
 * change. S245-S3a moved the decision from build time to execute time: the company row is
 * re-read LIVE per addMyTask (resolveRunTaskQueueState) so a cached chat controller can never
 * serve a stale verdict; the agent-factory flag derived with resolveTaskRunnerSettings() is the
 * fallback when that read fails, mirroring the scheduler poller's own enabled check
 * (packages/scheduler/src/task-runner.ts).
 */
export const RUN_TASK_DISABLED_WARNING =
  ' WARNING: this company has Run Task turned OFF (settings taskRunner.enabled=false) — no Run ' +
  'Task will start for it. Tell the operator to enable Run Task in Settings, or break the ask ' +
  'into simple steps you can do live in chat.';

/**
 * S245-S3b (#245): the company switch is not the only way the queue freezes. The GLOBAL budget
 * (env TASK_RUNNER_MAX_CONCURRENT_RUNS) reaching 0 is the kill switch (poller never starts) and
 * 1 leaves zero task capacity after the heartbeat reservation — either way addMyTask would keep
 * promising "queued for Run Task" while nothing can EVER start. Mirrors the scheduler's
 * resolveMaxConcurrentRuns + defaultTaskCapPerAgent semantics (unset/blank/garbage → default 2;
 * negative → garbage → 2). Read from THIS process's env: per the standard setup both web and
 * scheduler source the same root .env, so the chat warning and the poller agree; a split-env
 * deployment degrades to the company-level warning only (never a false all-clear from stale data).
 */
export const RUN_TASK_CAPACITY_ZERO_WARNING =
  ' WARNING: the Run Task queue has ZERO task capacity right now ' +
  '(TASK_RUNNER_MAX_CONCURRENT_RUNS is 0 — kill switch — or 1, leaving no slot after the ' +
  'heartbeat reservation) — no Run Task will start for it. Tell the operator to raise ' +
  'TASK_RUNNER_MAX_CONCURRENT_RUNS to at least 2, or break the ask into simple steps you can ' +
  'do live in chat.';

/** Why the queue is frozen — surfaced on the tool result for triage. */
export type RunTaskQueueReason = 'company_disabled' | 'no_task_capacity';

/** Mirrors scheduler resolveMaxConcurrentRuns(0/1 ⇒ no task capacity). Pure; env injectable. */
export function globalRunTaskCapacityZero(
  raw: string | undefined = process.env.TASK_RUNNER_MAX_CONCURRENT_RUNS,
): boolean {
  if (raw === undefined || raw.trim() === '') return false; // unset/blank → default 2 → has capacity
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return false; // garbage/negative → default 2
  return Math.trunc(parsed) <= 1; // 0 = kill switch; 1 = heartbeat reservation eats the only slot
}

/**
 * S245-S3a (#245): resolve the queue state LIVE on every addMyTask call. The chat controller is
 * cached per agent (apps/web/lib/chat/registry.ts), so the flag computed when it was BUILT goes
 * stale the moment Settings flips `taskRunner.enabled` — the warning lied in both directions
 * until the process restarted. Re-reading the company row per ask (the same source the poller
 * re-reads every tick) is the smallest correct fix. A db hiccup falls back to the build-time
 * flag (better a stale warning than a dropped queue message); the task write itself never
 * depends on this read.
 */
export async function resolveRunTaskQueueState(
  companyId: string,
  staticFallback: boolean,
  readSettings: (companyId: string) => Promise<unknown | null> = (id) =>
    getCompanySettingsSnapshot(id, toolDb()),
): Promise<{ reason: RunTaskQueueReason | null; warning: string }> {
  let companyDisabled: boolean;
  try {
    const settings = await readSettings(companyId);
    // Same discipline as the poller's resolveTaskRunnerSettingsForCompany: pull the block
    // straight off the jsonb. parseCompanySettings is a WHITELIST parser that drops taskRunner
    // (deliberately — it never passes credentials around) — running the raw row through it
    // would make every company look enabled and the warning could never fire.
    const block = (settings ?? undefined) as Pick<CompanySettings, 'taskRunner'> | undefined;
    companyDisabled = !resolveTaskRunnerSettings(block).enabled;
  } catch {
    companyDisabled = staticFallback;
  }
  if (companyDisabled) return { reason: 'company_disabled', warning: RUN_TASK_DISABLED_WARNING };
  if (globalRunTaskCapacityZero()) {
    return { reason: 'no_task_capacity', warning: RUN_TASK_CAPACITY_ZERO_WARNING };
  }
  return { reason: null, warning: '' };
}

async function runAddMyTask(
  inputData: z.infer<typeof addMyTaskInputSchema>,
  requestContext: unknown,
  opts: { runTaskDisabled: boolean },
) {
  const scope = chatTaskScope(requestContext);
  if (!scope) return missingScope();
  const database = toolDb();
  const titles = inputData.titles.map((t) => t.trim()).filter(Boolean);
  if (titles.length === 0) {
    return { error: 'empty_titles', message: 'At least one non-empty task title is required.' };
  }
  const open = await countOpenChatTasks(scope, database);
  if (open + titles.length > CHAT_TASK_LIST_CAP) {
    return {
      error: 'task_list_full',
      message: `Your task list is capped at ${CHAT_TASK_LIST_CAP} open tasks (${open} open now). Finish or cancel some first.`,
    };
  }
  // #340: an item ADDED as waiting_on_user must already state the ask (same rule as updateMyTask).
  let notes = inputData.notes ?? null;
  if (inputData.ask?.trim()) {
    notes = setChatTaskNoteLine(notes, composeChatTaskNoteLine(CHAT_TASK_ASK_PREFIX, inputData.ask));
  }
  if (inputData.status === 'waiting_on_user' && !hasChatTaskUserFacingSignal(notes)) {
    return missingAsk();
  }
  const added: ChatTask[] = [];
  for (const title of titles) {
    const task = await addChatTask(
      scope,
      {
        title,
        notes,
        status: inputData.status,
        sourceThreadId: scope.threadId ?? null,
        requestedBy: requestingUser(requestContext),
      },
      database,
    );
    added.push(task);
    // TASK-AUDIT (#258): enqueue = the "queued" entry of the documented lifecycle
    // (pending stored, product word queued) — one audit row per added task.
    await logToolActivity(scope, task, 'chat_task.created', requestContext);
  }
  // S245-S3a: resolved AFTER the writes (the task is recorded whatever the queue says) and
  // LIVE per call — a cached controller's build-time flag must never be the last word.
  const queue = await resolveRunTaskQueueState(scope.companyId, opts.runTaskDisabled);
  return {
    ok: true,
    message:
      `Added ${added.length} task${added.length === 1 ? '' : 's'}.` + queue.warning,
    ...(queue.reason
      ? { runTaskDisabled: true, runTaskDisabledReason: queue.reason }
      : {}),
    tasks: added.map(row),
  };
}

/**
 * Build the addMyTask tool for a run context. `context: 'run-task-wake'` swaps in the wake copy
 * (execute queued work — do not re-queue, S243-S2); `runTaskDisabled` is the BUILD-TIME fallback
 * for the operator warning (S243-S3) — at execute time the company row is re-read LIVE and wins
 * over it (S245-S3a); the flag only speaks when that read fails. Callers must not mutate the
 * returned tool.
 */
export function createAddMyTaskTool(opts?: {
  context?: 'chat' | 'run-task-wake';
  runTaskDisabled?: boolean;
}) {
  const wake = opts?.context === 'run-task-wake';
  const runTaskDisabled = opts?.runTaskDisabled === true;
  return createTool({
    id: 'addMyTask',
    description: wake ? ADD_MY_TASK_WAKE_DESCRIPTION : ADD_MY_TASK_CHAT_DESCRIPTION,
    inputSchema: addMyTaskInputSchema,
    execute: async (inputData, { requestContext }) =>
      runAddMyTask(inputData, requestContext, { runTaskDisabled }),
  });
}

/** Live-chat registration: queue non-simple work for Run Task, then STOP in-turn. */
export const addMyTaskTool = createAddMyTaskTool();

/** S243-S2: Run Task wake registration — same tool id, wake-aware description. */
export const addMyTaskRunTaskWakeTool = createAddMyTaskTool({ context: 'run-task-wake' });

export const updateMyTaskTool = createTool({
  id: 'updateMyTask',
  description:
    'Update one of YOUR chat tasks by id — your private chat task list, NOT company issues: rename it, ' +
    'replace its notes, move its status (pending / in_progress / waiting_on_user / done / cancelled), ' +
    'reorder it, or change who requested it (when the human corrects who a to-do belongs to). ' +
    'Moving INTO waiting_on_user REQUIRES ask: "what you need from the human" (#340 — a user wait ' +
    'without a stated ask is rejected). Moving waiting_on_user → pending RESUMES it: the Run Task ' +
    'attempt budget resets and taskRunner re-claims it — use it after the human answers the ask ' +
    '(put their answer into notes so the next run sees it). Do NOT set a parked task to ' +
    'in_progress yourself: in_progress belongs to the Run Task claim, and a bare flip only ' +
    'LIES about a running run (#339). To restart a parked task use status pending (a real ' +
    're-queue); a parked -> in_progress flip is converted into that re-queue for you.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    title: z.string().min(1).max(CHAT_TASK_TITLE_MAX).optional(),
    notes: z.string().max(2000).optional().describe('Replaces the notes text ("") clears it.'),
    status: statusSchema.optional(),
    ask: z
      .string()
      .max(500)
      .optional()
      .describe(
        'Required when status=waiting_on_user: the concrete input / decision / action the human ' +
          'must supply (stored as an "ask:" line on the notes, replacing any previous ask).',
      ),
    position: z.number().int().min(0).optional().describe('Ordering within your list (lower = earlier).'),
    requestedBy: z
      .object({
        userId: z.string().max(64).optional(),
        displayName: z.string().max(120).optional(),
      })
      .optional()
      .describe('Override who asked for this task (use when the human says whose it is).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    // S263-S4 (#263 softs): read the PRIOR status when a status move is requested — the audit
    // row carries "from → to" like the runner rows (previousStatus/previousProductStatus), and a
    // move to the status the task already holds is not a move at all (no row, per "audit only
    // real status moves"). The prior row also feeds the #340 ask gate and the resume reset below.
    // S269-S4 (#269 softs, known): this read and the write below are SEPARATE statements — a
    // concurrent move can record a stale `from` or skip the row. Best-effort audit only; task
    // state is unaffected (the scoped UPDATE still settles from the live row). Same shape in
    // completeMyTask / cancelMyTask.
    const previous = inputData.status !== undefined || inputData.ask !== undefined
      ? await getChatTask(scope, { id: inputData.id }, toolDb())
      : null;
    // #340: a REAL move into waiting_on_user must state the ask — either the fresh `ask` param
    // or an "ask:" line the caller's notes already carry. A row whose only signal is a runner
    // `failure:` line has NO ask, so hand-moving such a park onto the human is rejected by the
    // same gate: the ask gate is the only way in. Already-waiting rows are exempt (not a move).
    if (inputData.status === 'waiting_on_user' && previous && previous.status !== 'waiting_on_user') {
      const candidateNotes = inputData.notes !== undefined ? inputData.notes : previous.notes;
      const freshAsk = Boolean(inputData.ask?.trim());
      const hasAskLine = extractChatTaskNoteLine(candidateNotes, CHAT_TASK_ASK_PREFIX) !== null;
      if (!freshAsk && !hasAskLine) return missingAsk();
    }
    let notes = inputData.notes;
    if (inputData.ask?.trim()) {
      const base = notes !== undefined ? notes : previous?.notes ?? null;
      notes = setChatTaskNoteLine(base, composeChatTaskNoteLine(CHAT_TASK_ASK_PREFIX, inputData.ask));
    }
    // #340 go-between resume: waiting_on_user → pending re-queues for Run Task with a FRESH
    // attempt budget (the exhausted budget was spent on the failed/lost runs — the human's
    // reply is new input, so the task is claimable again). CAS-guarded; a concurrent move just
    // no-ops and the UPDATE below settles the fields from the live row.
    if (inputData.status === 'pending' && previous?.status === 'waiting_on_user') {
      await resumeChatTask(scope, { id: inputData.id }, toolDb());
    }
    // #339(b) false-restart guard: a parked task flipped straight to in_progress is a LYING
    // status — in_progress belongs to the Run Task claim and a bare flip never re-dispatches a
    // run, yet the concierge was reporting "running again". Coerce the flip into the REAL
    // thing: resume (waiting_on_user -> pending, fresh attempt budget) so taskRunner actually
    // claims it, and answer truthfully instead of confirming a run that does not exist.
    if (inputData.status === 'in_progress' && previous?.status === 'waiting_on_user') {
      const resumed = await resumeChatTask(scope, { id: inputData.id }, toolDb());
      if (resumed) {
        await logToolActivity(scope, resumed, 'chat_task.updated', requestContext, {
          changes: { status: { from: previous.status, to: resumed.status } },
          previousStatus: previous.status,
          previousProductStatus: chatTaskProductStatus(previous.status),
        });
        return {
          ok: true,
          message:
            `Task ${resumed.id} was parked, so the bare in_progress flip was refused: it was ` +
            'RE-QUEUED as pending instead — taskRunner will start a fresh run. Say it is ' +
            're-queued, NOT running.',
          task: row(resumed),
        };
      }
    }
    const updated = await updateChatTask(
      scope,
      {
        id: inputData.id,
        ...(inputData.title !== undefined ? { title: inputData.title } : {}),
        ...(notes !== undefined ? { notes } : {}),
        ...(inputData.status !== undefined ? { status: inputData.status } : {}),
        ...(inputData.position !== undefined ? { position: inputData.position } : {}),
        ...(inputData.requestedBy !== undefined ? { requestedBy: inputData.requestedBy } : {}),
      },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    // TASK-AUDIT (#258): audit only real status moves (renames/notes stay row-silent).
    if (inputData.status !== undefined && (!previous || previous.status !== updated.status)) {
      await logToolActivity(scope, updated, 'chat_task.updated', requestContext, {
        changes: { status: { ...(previous ? { from: previous.status } : {}), to: updated.status } },
        ...(previous
          ? {
              previousStatus: previous.status,
              previousProductStatus: chatTaskProductStatus(previous.status),
            }
          : {}),
      });
    }
    return { ok: true, message: `Task ${updated.id} → ${updated.status}.`, task: row(updated) };
  },
});

export const completeMyTaskTool = createTool({
  id: 'completeMyTask',
  description:
    'Mark one of YOUR chat tasks done by id — private chat list, NOT company issues — with an optional ' +
    'one-line note (what you did / where the result lives). Use it as soon as a promised to-do is actually finished.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    note: z.string().max(2000).optional().describe('Optional note appended to the task notes.'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    // S263-S4: prior status for the "from" side; already-done = no move → row-silent.
    const previous = await getChatTask(scope, { id: inputData.id }, toolDb());
    const updated = await setChatTaskStatus(
      scope,
      { id: inputData.id, status: 'done', note: inputData.note },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    // TASK-AUDIT (#258): the settle word — product "done".
    if (!previous || previous.status !== updated.status) {
      await logToolActivity(scope, updated, 'chat_task.updated', requestContext, {
        changes: { status: { ...(previous ? { from: previous.status } : {}), to: 'done' } },
        ...(previous
          ? {
              previousStatus: previous.status,
              previousProductStatus: chatTaskProductStatus(previous.status),
            }
          : {}),
        ...(inputData.note ? { note: inputData.note } : {}),
      });
    }
    return { ok: true, message: `Task ${updated.id} → done.`, task: row(updated) };
  },
});

export const cancelMyTaskTool = createTool({
  id: 'cancelMyTask',
  description:
    'Drop one of YOUR chat tasks (status → cancelled) — private chat list, NOT company issues — with an ' +
    'optional reason. Use when the human says to drop/forget a to-do, or a promised step is no longer needed. ' +
    'Cancelled items stay in the list and are hidden from the default listMyTasks view.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    reason: z.string().max(2000).optional().describe('Optional reason appended to the task notes.'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    // S263-S4: prior status for the "from" side; already-cancelled = no move → row-silent.
    const previous = await getChatTask(scope, { id: inputData.id }, toolDb());
    const updated = await setChatTaskStatus(
      scope,
      { id: inputData.id, status: 'cancelled', note: inputData.reason },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    // TASK-AUDIT (#258): drop = a terminal move too, audited like the others.
    if (!previous || previous.status !== updated.status) {
      await logToolActivity(scope, updated, 'chat_task.updated', requestContext, {
        changes: { status: { ...(previous ? { from: previous.status } : {}), to: 'cancelled' } },
        ...(previous
          ? {
              previousStatus: previous.status,
              previousProductStatus: chatTaskProductStatus(previous.status),
            }
          : {}),
        ...(inputData.reason ? { reason: inputData.reason } : {}),
      });
    }
    return { ok: true, message: `Task ${updated.id} → cancelled.`, task: row(updated) };
  },
});

export const pauseMyTaskTool = createTool({
  id: 'pauseMyTask',
  description:
    'Pause or resume one of YOUR chat tasks (private chat list, NOT company issues). Paused tasks SKIP the ' +
    'Run Task queue — no Run Task is auto-started for them until resumed. Use when the human says to hold ' +
    'off on / park a to-do, or to pick a parked one back up.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    paused: z
      .boolean()
      .optional()
      .describe('true pauses (default), false resumes (lets Run Task start it again).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    const paused = inputData.paused ?? true;
    const updated = await setChatTaskPaused(scope, { id: inputData.id, paused }, toolDb());
    if (!updated) return notFound(inputData.id);
    return {
      ok: true,
      message: `Task ${updated.id} ${paused ? 'paused — Run Task will skip it' : 'resumed — eligible for Run Task again'}.`,
      task: row(updated),
    };
  },
});

export const prioritizeMyTaskTool = createTool({
  id: 'prioritizeMyTask',
  description:
    'Move one of YOUR chat tasks up the list (private chat list, NOT company issues). Lower position = ' +
    'picked up sooner by the Run Task queue. Use when the human reprioritises their to-dos.',
  inputSchema: z.object({
    id: z.string().min(1).describe('Chat task id (from listMyTasks).'),
    position: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Target position in your list (default 0 = front, ahead of the rest).'),
  }),
  execute: async (inputData, { requestContext }) => {
    const scope = chatTaskScope(requestContext);
    if (!scope) return missingScope();
    // S9 (#196): the default front-of-list move goes through prioritizeChatTask, which assigns
    // min(position)-1 — a plain position:0 would tie with an existing 0-row and still lose the
    // (position, createdAt) tiebreak to the older task. Explicit positions pass through.
    const updated = await prioritizeChatTask(
      scope,
      { id: inputData.id, ...(inputData.position !== undefined ? { position: inputData.position } : {}) },
      toolDb(),
    );
    if (!updated) return notFound(inputData.id);
    return {
      ok: true,
      message:
        inputData.position === undefined
          ? `Task ${updated.id} moved to the front of your list (ahead of every other task).`
          : `Task ${updated.id} moved to position ${updated.position}.`,
      task: row(updated),
    };
  },
});

/** The seven chat-task tools as one group (chat AgentController + Run Task wakes — see chat-controller.ts). */
export const CHAT_TASK_TOOLS = {
  listMyTasks: listMyTasksTool,
  addMyTask: addMyTaskTool,
  updateMyTask: updateMyTaskTool,
  completeMyTask: completeMyTaskTool,
  cancelMyTask: cancelMyTaskTool,
  pauseMyTask: pauseMyTaskTool,
  prioritizeMyTask: prioritizeMyTaskTool,
};

/**
 * S243-S2: the Run Task wake variant of the group — same seven tools, but addMyTask carries the
 * wake-aware description (execute the queued work; never re-queue via addMyTask).
 */
export const RUN_TASK_WAKE_CHAT_TASK_TOOLS = {
  ...CHAT_TASK_TOOLS,
  addMyTask: addMyTaskRunTaskWakeTool,
};

/** True for ids that belong to the private chat list (guards + toolset labelling). */
export function isChatTaskToolId(id: string): boolean {
  return (CHAT_TASK_TOOL_IDS as readonly string[]).includes(id);
}

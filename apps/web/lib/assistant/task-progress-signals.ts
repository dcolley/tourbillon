/**
 * CONCIERGE-QUEUE-SIGNAL: the TASK-RUNNER → parent free-chat bridge (pure core).
 *
 * The scheduler emits one high-level `chat_task_progress` event per Run Task transition
 * (started / done / needs_review) on the company's SSE redis channel
 * (`{ type: 'chat_task_progress', ...ChatTaskProgressEvent }` — see packages/scheduler
 * task-runner's emitProgress). This module turns each event into a TYPED reactive
 * `task-progress` signal (Mastra `queueSignal`, via @tourbillon/mastra/concierge-signal) on the
 * agent's pinned free-chat thread — so the concierge can talk about its background work on
 * the next turn, without fake user messages or mid-token interrupts.
 *
 * Kept dependency-free (no `@/` imports, no redis, no db) so it is unit-testable with fakes;
 * the real subscriber + wiring lives in task-progress-bridge.ts (started from instrumentation).
 *
 * Multi-replica (soft-pack S2): every web replica psubscribes `sse:*`, so each replica sees
 * every event. `handleTaskProgressEvent` claims the event (via deps.claimEvent — the bridge
 * backs it with an atomic redis SET NX EX on a `taskProgressClaimKey` key) before doing any
 * work, making delivery single-consumer across replicas. The claim FAILS OPEN in the bridge:
 * a duplicate is worse than nothing here, but a dropped notification is worse than a duplicate,
 * so a redis error delivers on every replica rather than dropping everywhere.
 *
 * Wake policy (TB-363 MUST-4, PM Q1 ruling 25 Nov): the notice itself must never cause a
 * SECOND chat reply. Tool-sourced transitions (`event.source === 'tool'` — the concierge moved
 * the task itself) and `started` are persisted as compact status LINES without waking the model
 * (deliver receives wake=false → Agent-level `ifIdle.behavior:'persist'`, S4-lean); runner
 * transitions in the reactive stages (done / waiting_on_user / needs_review / failed) keep the
 * queueSignal wake — that wake is the feature (#339 go-between), and it is the ONE reply the
 * transition may produce, not a second one after a tool notice.
 *
 * Idle-wake cost (soft-pack S3, pinned by tests): every WAKING transition goes through
 * queueSignal, so a transition on an IDLE thread wakes a full concierge LLM turn. Mastra 1.78
 * `Session.queueSignal(signal, { tracingContext, tracingOptions, requestContext })` exposes no
 * queue-without-wake option (agent-controller-…js:5723 drops ifIdle), which is why the
 * no-wake path above uses the Agent-level queueSignal with `ifIdle.behavior:'persist'`.
 */
import {
  queueConciergeSignal,
  taskProgressSignalPayload,
  type TaskProgressEventShape,
  type TaskProgressSignalPayload,
} from '@tourbillon/mastra/concierge-signal';
// S4 (#196) closed properly (#205 softs): this used to be a SECOND `satisfies`-pinned literal
// copy of the wire type — value-checked twice, single-sourced nowhere, so the publisher and the
// parser could drift the moment one side changed. The shared constant is now the one source of
// truth; re-exported here so the bridge's importers keep their existing path.
import { TASK_PROGRESS_SSE_TYPE, isTaskProgressStage, isTaskProgressStatus } from '@tourbillon/shared/types';
export { TASK_PROGRESS_SSE_TYPE };

export type TaskProgressEvent = TaskProgressEventShape;

/** Parse one `sse:{companyId}` payload; null for anything that is not a Run Task progress event. */
export function parseTaskProgressMessage(raw: string): TaskProgressEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const e = data as Record<string, unknown>;
  if (e.type !== TASK_PROGRESS_SSE_TYPE) return null;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const stage = str(e.stage);
  const status = str(e.status);
  // S304-S2 (#304): this accept set is deliberately narrower than the heartbeat read paths —
  // S298-S1 counts/filters/maps coalesced/cancelled, but those are heartbeat_runs ROW statuses,
  // not statuses of THIS channel. The scheduler cannot emit coalesced/cancelled here: the only
  // publisher is task-runner's emitProgress (packages/scheduler/src/task-runner.ts), whose
  // ChatTaskProgressEvent.status is exactly the four shared words, consumed through the ONE
  // union (S307-S2): isTaskProgressStatus / TASK_PROGRESS_STATUSES from @tourbillon/shared/types
  // is the accept set here, no local copy. `started` uses the 'running'
  // literal and done/needs_review carry WakeResult.status ('succeeded' | 'failed' | 'skipped':
  // a coalesced wake resolves as 'skipped', a force-kill persists 'failed'), and a cancelled
  // chat task never reaches emitProgress (the claim guard returns false -> continue).
  // Pinned by task-progress-signals.test.ts (behaviour + this comment); widen only if the
  // publisher type widens, in the same commit as the scheduler change.
  // #339: the stage accept set is now the shared TASK_PROGRESS_STAGES tuple — `waiting_on_user`
  // (relay the stated ask) and `failed` (report the failure) landed WITH the scheduler publisher
  // and the concierge-signal payload in the same commit.
  // #339: stages come from the shared accept set (was a local three-word copy).
  if (!isTaskProgressStage(stage) || !isTaskProgressStatus(status)) {
    return null;
  }
  const companyId = str(e.companyId);
  const agentId = str(e.agentId);
  const chatTaskId = str(e.chatTaskId);
  const runId = str(e.runId);
  const title = str(e.title);
  if (!companyId || !agentId || !chatTaskId || !runId || !title) return null;
  const detail = str(e.detail);
  // TB-363 (MUST-4, PM Q1): 'tool' marks a concierge-tool-sourced transition — the bridge
  // persists its notice without waking a model turn. Anything else is runner-shaped (wake).
  return {
    companyId,
    agentId,
    chatTaskId,
    runId,
    stage,
    status,
    title,
    ...(detail ? { detail } : {}),
    ...(e.source === 'tool' ? { source: 'tool' as const } : {}),
  };
}

/**
 * Stable cross-replica dedupe key for one emitted transition (soft-pack S2). One Run Task
 * emits each stage at most once per runId (a retry re-queues with a NEW runId), so
 * (companyId, chatTaskId, runId, stage) identifies exactly one notification.
 */
export function taskProgressBareClaimKey(event: TaskProgressEvent): string {
  return `concierge-signal:seen:${event.companyId}:${event.chatTaskId}:${event.runId}:${event.stage}`;
}

export function taskProgressClaimKey(event: TaskProgressEvent): string {
  // TB-363 MUST-7 (PM N-3): a runner-origin settle that carries SUBSTANTIVE detail (a real
  // ask, an error reason, a result summary) is the runner's go-between REPLY content, not a
  // status echo. It must survive collapse against the concierge tool's status-line notice, so
  // the wake (and its content item) still fires — the ONE notice stays deduped by stage.
  // Status-only settles keep the bare identity and still collapse with the tool emit (A11b).
  const substantive =
    event.source !== 'tool' && typeof event.detail === 'string' && event.detail.trim().length > 0;
  return (
    taskProgressBareClaimKey(event) +
    (substantive ? `:reply:${event.detail!.trim().slice(0, 120)}` : '')
  );
}

/** TB-363 MUST-7: the runner settle whose go-between reply carries real content. */
export function isSubstantiveRunnerReply(event: TaskProgressEvent): boolean {
  return (
    event.source !== 'tool'
    && typeof event.detail === 'string'
    && event.detail.trim().length > 0
  );
}

/** The agent-row slice the bridge needs (kept minimal for tests). */
export interface TaskProgressAgentRecord {
  id: string;
  companyId: string;
  /** agents.status — anything but 'active' (paused / archived / pending_approval) skips (S4). */
  status: string;
  /** companies.status — same rule; a paused/archived tenant must not be woken (S4, #196-B1 class). */
  companyStatus: string;
  /**
   * agents.runtime_config (NOT NULL, DB default {}). Origin-bound getChatSession /
   * createChatController read runtimeConfig.mail; dropping this field makes
   * `runtimeConfig.mail` throw and silently fails notice delivery (H3).
   */
  runtimeConfig?: unknown;
}

export interface TaskProgressBridgeDeps<A extends TaskProgressAgentRecord> {
  /** The agent row by id (null when missing/archived-and-gone). */
  getAgent(agentId: string): Promise<A | null>;
  /**
   * TN-ORIGIN (v2 §1.1, §14.3 R8): the TASK'S OWN originating thread, resolved from the
   * authoritative scoped `chat_tasks.source_thread_id` row for (companyId, agentId, chatTaskId).
   * The active pin (assistant_active_threads) is NEVER consulted for routing — a notice for a
   * task created on T1 must persist on T1 whatever thread the agent's chat is pinned to.
   * A missing task / missing origin returns an explicit skip reason (no pin fallback, H2);
   * a lookup ERROR must propagate (surfaced, never counted as a skip — C3).
   */
  getTaskOrigin(event: TaskProgressEvent): Promise<TaskProgressOriginResolution>;
  /**
   * Deliver one typed signal on the ORIGIN thread's free-chat session (queue for the next
   * turn; Mastra wakes the thread when idle, queues behind the run when the ORIGIN itself is
   * busy). An unrelated busy thread must never drop or delay this delivery (v2 §1.3/§6).
   * Return false when the target session is unavailable.
   * TB-363 (MUST-4): `wake=false` means PERSIST the notice without starting a model turn
   * (tool-sourced transitions + `started`, PM Q1); `wake=true` keeps the reactive wake.
   */
  deliver(agent: A, threadId: string, payload: TaskProgressSignalPayload, wake: boolean): Promise<boolean>;
  /**
   * Single-consumer claim across web replicas (S2): true = first claimer, deliver; false =
   * another replica already claimed this transition, skip. Called before any db work.
   */
  claimEvent(event: TaskProgressEvent): Promise<boolean>;
  /**
   * TB-363 MUST-6: release a claim when a persist-path delivery landed nothing, so a
   * redelivery can retry instead of being swallowed as 'skipped:duplicate'.
   */
  unclaim?(event: TaskProgressEvent): Promise<void>;
  /**
   * TB-363 MUST-7 (PM N-3): true when the concierge tool's status line already landed for
   * this (companyId, chatTaskId, runId, stage) — the runner's substantive go-between reply
   * then rides a TRANSIENT signal (content item, no second stored notice row).
   */
  toolLineLanded?(event: TaskProgressEvent): Promise<boolean>;
  /**
   * TB-363 (R2): called after a SUCCESSFUL delivery ('queued') with the resolved origin
   * threadId — the bridge publishes a `chat_task_notice` poke on `sse:{companyId}` so an open
   * chat page merges the thread's history and shows the notice without a reload. Called once
   * per delivered event (never on a skip). A notify failure must never fail delivery: the
   * implementation logs (S3) — the queue entry is already persisted.
   */
  notify?: (event: TaskProgressEvent, threadId: string) => Promise<void> | void;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void } | undefined;
}

/**
 * Explicit origin-resolution outcomes (H2, reconciliation C3). Malformed/legacy rows
 * (task gone, or created before source_thread_id existed) skip with a RECORDED reason and
 * zero queue entries anywhere — this is a diagnostic boundary for exceptional input only,
 * never a waiver for a valid-T1 delivery. `skipped:*` outcomes never fall back to the pin.
 */
export type TaskProgressOriginResolution =
  | { threadId: string }
  | { skip: 'task-not-found' }
  | { skip: 'missing-origin' };

export type TaskProgressHandled =
  | 'queued'
  | 'skipped:duplicate'
  | 'skipped:no-agent'
  | 'skipped:company-mismatch'
  | 'skipped:inactive'
  | 'skipped:task-not-found'
  | 'skipped:missing-origin'
  | 'skipped:no-session';

/**
 * Route one Run Task progress event to the task's ORIGINATING thread (TASK-1 audit column
 * `chat_tasks.source_thread_id`, resolved company+agent scoped). The active pin is never a
 * routing input (v2 §1.1/§14.3 R8): a task created on T1 delivers on T1 whatever thread the
 * chat is pinned to, idle or busy. A missing task or missing origin is an explicit recorded
 * skip (no pin fallback, H2/C3) — zero queue entries, and the claim already consumed for the
 * event identity stays consumed (no retry promise). A lookup error PROPAGATES (surfaced, not
 * a skip). A paused/archived agent or company is skipped (S4 — same class as the #196-B1
 * runner guard: an inactive tenant must not be woken into an LLM turn). A duplicate seen by
 * another replica is skipped (S2 — claim first, before any db work).
 */
export async function handleTaskProgressEvent<A extends TaskProgressAgentRecord>(
  deps: TaskProgressBridgeDeps<A>,
  event: TaskProgressEvent,
): Promise<TaskProgressHandled> {
  if (!(await deps.claimEvent(event))) return 'skipped:duplicate';
  const agent = await deps.getAgent(event.agentId);
  if (!agent) return 'skipped:no-agent';
  if (agent.companyId !== event.companyId) {
    deps.log?.warn('[concierge-signal] task progress agent/company mismatch', {
      agentId: event.agentId,
      eventCompany: event.companyId,
      agentCompany: agent.companyId,
    });
    return 'skipped:company-mismatch';
  }
  if (agent.status !== 'active' || agent.companyStatus !== 'active') {
    deps.log?.warn('[concierge-signal] task progress skipped (agent or company inactive)', {
      agentId: event.agentId,
      agentStatus: agent.status,
      companyStatus: agent.companyStatus,
    });
    return 'skipped:inactive';
  }
  // TN-ORIGIN: authoritative scoped origin lookup. Errors propagate (C3: an error is an
  // error, never a silent skip); absence gets an explicit recorded skip reason (H2).
  const origin = await deps.getTaskOrigin(event);
  if ('skip' in origin) {
    deps.log?.warn(`[concierge-signal] task progress skipped (${origin.skip})`, {
      agentId: event.agentId,
      chatTaskId: event.chatTaskId,
      companyId: event.companyId,
      claimConsumed: true,
    });
    return `skipped:${origin.skip}`;
  }
  // TB-363 (MUST-4, PM Q1): the notice must never be a SECOND chat reply. Tool-sourced moves
  // (concierge's own updateMyTask/completeMyTask) and `started` persist as a compact status
  // LINE only; runner-origin reactive stages keep the wake (the #339 go-between turn).
  const wake = event.source !== 'tool' && event.stage !== 'started';
  // TB-363 MUST-7 (PM N-3): a substantive runner go-between for a transition the concierge
  // tool's status line ALREADY covers delivers as a transient signal — the reply's content
  // item still appears, but no second notice row is stored (the one notice stays the line).
  let payload = taskProgressSignalPayload(event);
  if (wake && isSubstantiveRunnerReply(event) && (await deps.toolLineLanded?.(event))) {
    payload = { ...payload, transient: true };
  }
  const delivered = await deps.deliver(agent, origin.threadId, payload, wake);
  if (!delivered) {
    // TB-363 MUST-6: on the persist (no-wake) path a false deliver means NOTHING landed
    // (no chat agent, or Mastra refused with 'blocked'/'discard'). Release the claim so a
    // redelivery can retry — the claim must not be consumed for a notice that never landed.
    // The wake path keeps its historical claim-consumed semantics.
    if (!wake) {
      await deps.unclaim?.(event);
      deps.log?.warn('[concierge-signal] task progress persist failed — claim released', {
        agentId: event.agentId,
        chatTaskId: event.chatTaskId,
        claimConsumed: false,
      });
    }
    return 'skipped:no-session';
  }
  // TB-363 (R2): poke the open page AFTER the queue entry is in (never on a skip). A notify
  // error is surfaced (S3) but never turns a delivered notice into a failure.
  try {
    await deps.notify?.(event, origin.threadId);
  } catch (err) {
    deps.log?.warn('[concierge-signal] task progress notice poke failed (delivered)', {
      agentId: event.agentId,
      chatTaskId: event.chatTaskId,
      threadId: origin.threadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return 'queued';
}

/** Convenience for deps implementations: map a progress event onto the queueConciergeSignal call. */
export async function queueTaskProgressSignal(
  session: Parameters<typeof queueConciergeSignal>[0],
  payload: TaskProgressSignalPayload,
): Promise<string> {
  const { signalId } = await queueConciergeSignal(session, payload);
  return signalId;
}

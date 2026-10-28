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
 * Idle-wake cost (soft-pack S3, pinned by tests): every transition — INCLUDING `started` —
 * goes through queueSignal, so a transition on an IDLE thread wakes a full concierge LLM turn.
 * Mastra 1.78 `Session.queueSignal(signal, { tracingContext, tracingOptions, requestContext })`
 * exposes no queue-without-wake option, so `started` cannot be parked cheaply today.
 * TODO: revisit if the queue grows a non-waking enqueue, or product drops `started`
 * notifications (done / needs_review are the reactive states that justify a wake).
 */
import {
  queueConciergeSignal,
  taskProgressSignalPayload,
  type TaskProgressEventShape,
  type TaskProgressSignalPayload,
} from '@tourbillon/mastra/concierge-signal';

export const TASK_PROGRESS_SSE_TYPE = 'chat_task_progress';

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
  if (
    (stage !== 'started' && stage !== 'done' && stage !== 'needs_review') ||
    (status !== 'running' && status !== 'succeeded' && status !== 'failed' && status !== 'skipped')
  ) {
    return null;
  }
  const companyId = str(e.companyId);
  const agentId = str(e.agentId);
  const chatTaskId = str(e.chatTaskId);
  const runId = str(e.runId);
  const title = str(e.title);
  if (!companyId || !agentId || !chatTaskId || !runId || !title) return null;
  return { companyId, agentId, chatTaskId, runId, stage, status, title };
}

/**
 * Stable cross-replica dedupe key for one emitted transition (soft-pack S2). One Run Task
 * emits each stage at most once per runId (a retry re-queues with a NEW runId), so
 * (companyId, chatTaskId, runId, stage) identifies exactly one notification.
 */
export function taskProgressClaimKey(event: TaskProgressEvent): string {
  return `concierge-signal:seen:${event.companyId}:${event.chatTaskId}:${event.runId}:${event.stage}`;
}

/** The agent-row slice the bridge needs (kept minimal for tests). */
export interface TaskProgressAgentRecord {
  id: string;
  companyId: string;
  /** agents.status — anything but 'active' (paused / archived / pending_approval) skips (S4). */
  status: string;
  /** companies.status — same rule; a paused/archived tenant must not be woken (S4, #196-B1 class). */
  companyStatus: string;
}

export interface TaskProgressBridgeDeps<A extends TaskProgressAgentRecord> {
  /** The agent row by id (null when missing/archived-and-gone). */
  getAgent(agentId: string): Promise<A | null>;
  /** The agent's PINNED free-chat thread (assistant_active_threads), or null when none yet. */
  getActiveThreadId(scope: { companyId: string; agentId: string }): Promise<string | null>;
  /**
   * Deliver one typed signal on the agent's free-chat session (queue for the next turn;
   * Mastra wakes the thread when idle). Return false when the target session is unavailable.
   */
  deliver(agent: A, threadId: string, payload: TaskProgressSignalPayload): Promise<boolean>;
  /**
   * Single-consumer claim across web replicas (S2): true = first claimer, deliver; false =
   * another replica already claimed this transition, skip. Called before any db work.
   */
  claimEvent(event: TaskProgressEvent): Promise<boolean>;
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
}

export type TaskProgressHandled =
  | 'queued'
  | 'skipped:duplicate'
  | 'skipped:no-agent'
  | 'skipped:company-mismatch'
  | 'skipped:inactive'
  | 'skipped:no-thread'
  | 'skipped:no-session';

/**
 * Route one Run Task progress event to the agent's pinned free-chat thread. A never-chatted
 * agent (no pinned thread) is skipped — there is no conversation to wake. A paused/archived
 * agent or company is skipped too (S4 — same class as the #196-B1 runner guard: an inactive
 * tenant must not be woken into an LLM turn). A duplicate seen by another replica is skipped
 * (S2 — claim first, before any db work). Never throws.
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
  const threadId = await deps.getActiveThreadId({ companyId: event.companyId, agentId: event.agentId });
  if (!threadId) return 'skipped:no-thread';
  const payload = taskProgressSignalPayload(event);
  const delivered = await deps.deliver(agent, threadId, payload);
  return delivered ? 'queued' : 'skipped:no-session';
}

/** Convenience for deps implementations: map a progress event onto the queueConciergeSignal call. */
export async function queueTaskProgressSignal(
  session: Parameters<typeof queueConciergeSignal>[0],
  payload: TaskProgressSignalPayload,
): Promise<string> {
  const { signalId } = await queueConciergeSignal(session, payload);
  return signalId;
}

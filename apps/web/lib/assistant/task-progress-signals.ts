/**
 * CONCIERGE-QUEUE-SIGNAL: the TASK-RUNNER → parent free-chat bridge (pure core).
 *
 * The scheduler emits one high-level `chat_task_progress` event per Run Task transition
 * (started / done / needs_review) on the company's SSE redis channel
 * (`{ type: 'chat_task_progress', ...ChatTaskProgressEvent }` — see packages/scheduler
 * task-runner's emitProgress). This module turns each event into a TYPED reactive
 * `task-progress` signal (Mastra `queueSignal`, via packages/mastra concierge-signal) on the
 * agent's pinned free-chat thread — so the concierge can talk about its background work on
 * the next turn, without fake user messages or mid-token interrupts.
 *
 * Kept dependency-free (no `@/` imports, no redis, no db) so it is unit-testable with fakes;
 * the real subscriber + wiring lives in task-progress-bridge.ts (started from instrumentation).
 */
import {
  queueConciergeSignal,
  taskProgressSignalPayload,
  type TaskProgressEventShape,
  type TaskProgressSignalPayload,
} from '../../../../packages/mastra/src/concierge-signal';
import type { SSEEventType } from '../../../../packages/shared/src/types';

// S4 (#196): type-level pin against the shared SSE enum — if `chat_task_progress` ever stops
// being a member of SSEEventType (the old `task_run_update` drift), this line fails the build.
export const TASK_PROGRESS_SSE_TYPE = 'chat_task_progress' satisfies SSEEventType;

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

/** The agent row slice the bridge needs (kept minimal for tests). */
export interface TaskProgressAgentRecord {
  id: string;
  companyId: string;
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
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void };
}

export type TaskProgressHandled =
  | 'queued'
  | 'skipped:no-agent'
  | 'skipped:company-mismatch'
  | 'skipped:no-thread'
  | 'skipped:no-session';

/**
 * Route one Run Task progress event to the agent's pinned free-chat thread. A never-chatted
 * agent (no pinned thread) is skipped — there is no conversation to wake. Never throws.
 */
export async function handleTaskProgressEvent<A extends TaskProgressAgentRecord>(
  deps: TaskProgressBridgeDeps<A>,
  event: TaskProgressEvent,
): Promise<TaskProgressHandled> {
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

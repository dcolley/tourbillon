/**
 * TASK-AUDIT (#258): chat_task lifecycle rows for `activity_log`.
 *
 * The board audits chat tasks / Run Task from the Activity page (item-type filter "Tasks").
 * Every lifecycle transition writes one row with `entity_type = 'chat_task'`; the write and the
 * status change are separate statements on purpose — audit is best-effort and must never block
 * or fail the queue itself (callers decide what to do with a write error, see `onError`).
 *
 * Lifecycle vocabulary (product ask: pending → queued → running → error/done). NO status
 * rename in `chat_tasks` — the stored statuses stay pending / in_progress / waiting_on_user /
 * done / cancelled so `listMyTasks` and the chat widgets keep working unchanged; the product
 * words ride on the audit row instead:
 *
 *   enqueue (addMyTask)                 chat_task.created   stored pending            productStatus queued
 *   runner claim                        chat_task.queued    stored in_progress        productStatus queued
 *   Run Task wake fires                 chat_task.started   stored in_progress        productStatus running
 *   settle: succeeded                   chat_task.done      stored done               productStatus done
 *   settle: failed, retry budget left   chat_task.error     stored pending (re-queue) productStatus error
 *   settle: attempts exhausted / lost   chat_task.parked    stored waiting_on_user    productStatus error
 *
 * Actor rule: runner-driven rows (queued / started / done / error / parked) are `system` with
 * the actorId naming the writer ('task-runner' poller, or the caller for tool-side writes);
 * human/agent-driven rows (created / status updates) are `actorType: 'agent'` with the owning
 * agent as actorId — the actor is whoever asked for the change, the runner is never credited
 * with the agent's own edits. `details.runId` carries the heartbeat_runs id when one is known
 * so the Activity view can link the run.
 */
import { activityLog } from './schema/activity-log';
import type { ChatTaskStatus } from './schema/chat-tasks';
import type { ChatTaskDb } from './chat-task-queries';
import { db as defaultDb } from './client';

/** The lifecycle actions written to `activity_log.action` for entity_type 'chat_task'. */
export const CHAT_TASK_ACTIVITY_ACTIONS = [
  'chat_task.created',
  'chat_task.updated',
  'chat_task.queued',
  'chat_task.started',
  'chat_task.done',
  'chat_task.error',
  'chat_task.parked',
] as const;

export type ChatTaskActivityAction = (typeof CHAT_TASK_ACTIVITY_ACTIONS)[number];

/**
 * Product-facing lifecycle word for a stored chat-task status (the audit copy of the documented
 * lifecycle map above). Runner transitions pass the OUTCOME explicitly via `productStatus`.
 */
export function chatTaskProductStatus(status: ChatTaskStatus): string {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'in_progress':
      return 'running';
    case 'waiting_on_user':
      return 'error';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
  }
}

export interface RecordChatTaskActivityInput {
  companyId: string;
  /** The chat_tasks row this transition belongs to (never a bare id from the model). */
  taskId: string;
  action: ChatTaskActivityAction;
  actorType: 'agent' | 'user' | 'system';
  /** Agent id for agent actors; the writer's name ('task-runner', …) for system actors. */
  actorId: string;
  actorName?: string | null;
  /** Free-form detail payload (runId, status, changes, attempts, note…). */
  details?: Record<string, unknown>;
  /** Same-action grouping id (ACT-1 discipline). */
  correlationId?: string | null;
}

/**
 * Insert one chat_task lifecycle row. Best-effort by contract: an insert failure is handed to
 * `onError` (defaults to swallow) and never throws at the queue/tool caller — losing an audit
 * row must not lose the transition itself.
 */
export async function recordChatTaskActivity(
  input: RecordChatTaskActivityInput,
  options: {
    database?: ChatTaskDb;
    onError?: (err: unknown) => void;
  } = {},
): Promise<void> {
  const database = options.database ?? (defaultDb as unknown as ChatTaskDb);
  try {
    await database.insert(activityLog).values({
      companyId: input.companyId,
      actorType: input.actorType,
      actorId: input.actorId,
      actorName: input.actorName ?? null,
      action: input.action,
      entityType: 'chat_task',
      entityId: input.taskId,
      details: input.details ?? {},
      correlationId: input.correlationId ?? null,
    });
  } catch (err) {
    if (options.onError) options.onError(err);
  }
}


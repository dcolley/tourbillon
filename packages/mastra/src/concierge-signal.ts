/**
 * CONCIERGE-QUEUE-SIGNAL: typed reactive signals into the parent free-chat.
 *
 * Mastra's `queueSignal` (Session / Agent) queues a TYPED signal for the next thread turn —
 * same ordering as `queueMessage`, but it renders to the model as tagged XML context
 * (`<task-progress …>…</task-progress>`), never as a fake user message. Idle thread → the
 * signal starts a run immediately; active thread → it waits for the current run, then a new
 * run picks it up. That is exactly the TASK-RUNNER parent UX: high-level Run Task progress
 * (started / needs another look / done / needs a decision) reaching the concierge's free-chat
 * as a reactive signal — not tool transcripts, not user-text stuffing, and NOT a mid-token
 * `sendSignal` interrupt (product lock: routine progress is queued for the next turn).
 *
 * The helpers here are deliberately structural (duck-typed session/agent): the web process
 * owns the long-lived AgentController sessions, and the bridge that calls these lives there.
 */

/** Tag name the free-chat concierge sees on Run Task progress signals. */
export const TASK_PROGRESS_TAG_NAME = 'task-progress';

/** Signal attribute values Mastra accepts (AgentSignalAttributes). */
export type ConciergeSignalAttributes = Record<string, string | number | boolean | null | undefined>;

/** Keep the model-side attribute bag small and printable. */
export const CONCIERGE_ATTRIBUTE_VALUE_LIMIT = 120;
export const CONCIERGE_CONTENTS_LIMIT = 500;

/** Minimal shape of Mastra's `AgentSignalInput` this helper writes. */
export interface ConciergeSignalInput {
  /** Stable id so a later dismiss/pause can cancel THIS queued signal by id. */
  id?: string;
  tagName?: string;
  attributes?: ConciergeSignalAttributes;
  contents: string;
}

/** The one Session method this helper needs (Mastra Session.queueSignal). */
export interface QueueSignalSession {
  queueSignal(
    signal: { type: 'reactive'; tagName?: string; attributes?: ConciergeSignalAttributes; contents: string; id?: string },
    opts?: Record<string, unknown>,
  ): Promise<void> | void;
}

/** The one Agent method the cancel path needs (Mastra Agent.cancelQueuedMessages). */
export interface QueuedSignalCancelAgent {
  cancelQueuedMessages?(target: {
    threadId: string;
    signalIds: string[];
    resourceId?: string;
  }): { cancelledSignalIds: string[] } | Promise<{ cancelledSignalIds: string[] }>;
}

function printableAttribute(value: unknown): string | number | boolean | null | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    return value.length > CONCIERGE_ATTRIBUTE_VALUE_LIMIT
      ? `${value.slice(0, CONCIERGE_ATTRIBUTE_VALUE_LIMIT - 1)}…`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined; // objects/arrays never belong in the attribute bag
}

/** Drop non-printable values and clamp long strings (model-visible, keep it small). */
export function sanitizeSignalAttributes(
  attributes: Record<string, unknown> | undefined,
): ConciergeSignalAttributes {
  if (!attributes) return {};
  const out: ConciergeSignalAttributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const printable = printableAttribute(value);
    if (printable !== undefined) out[key] = printable;
  }
  return out;
}

function clampContents(contents: string): string {
  const trimmed = contents.trim();
  if (trimmed.length <= CONCIERGE_CONTENTS_LIMIT) return trimmed;
  return `${trimmed.slice(0, CONCIERGE_CONTENTS_LIMIT - 1)}…`;
}

/**
 * Queue a typed reactive signal onto a free-chat session for its NEXT turn (idle → wakes the
 * thread immediately; active → waits for the current run — ordering is Mastra's, owned by the
 * shared queue). Returns the signal id for later cancellation. Never sends mid-token.
 */
export async function queueConciergeSignal(
  session: QueueSignalSession,
  input: ConciergeSignalInput,
): Promise<{ signalId: string }> {
  const id = input.id ?? `sig-${randomId()}`;
  await session.queueSignal({
    type: 'reactive',
    tagName: input.tagName ?? TASK_PROGRESS_TAG_NAME,
    attributes: sanitizeSignalAttributes(input.attributes),
    contents: clampContents(input.contents),
    id,
  });
  return { signalId: id };
}

/**
 * Cancel queued concierge signals by id (user dismissed / paused the task before delivery).
 * No-op returning [] when the agent cannot cancel (older Mastra, or nothing queued).
 */
export async function cancelQueuedConciergeSignals(
  agent: QueuedSignalCancelAgent,
  target: { resourceId?: string; threadId: string; signalIds: string[] },
): Promise<string[]> {
  if (!agent.cancelQueuedMessages || target.signalIds.length === 0) return [];
  const result = await agent.cancelQueuedMessages({
    threadId: target.threadId,
    signalIds: target.signalIds,
    ...(target.resourceId ? { resourceId: target.resourceId } : {}),
  });
  return result.cancelledSignalIds ?? [];
}

// ─── TASK-RUNNER progress → signal payload ──────────────────────────────────

/**
 * The Run Task progress event the scheduler emits (structurally ChatTaskProgressEvent from
 * packages/scheduler task-runner — kept structural so packages/mastra never imports the
 * scheduler).
 */
export interface TaskProgressEventShape {
  companyId: string;
  agentId: string;
  chatTaskId: string;
  runId: string;
  stage: 'started' | 'done' | 'needs_review';
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  title: string;
}

export interface TaskProgressSignalPayload {
  tagName: string;
  attributes: ConciergeSignalAttributes;
  contents: string;
}

/**
 * Map a Run Task transition to the parent free-chat signal payload: small attributes +
 * one short human line the model can talk about. The four product states (started / done /
 * needs another look / needs a decision): `needs_review` splits on status — a failed run
 * needs another look (it retries), a skipped one is parked and needs a human decision.
 */
export function taskProgressSignalPayload(event: TaskProgressEventShape): TaskProgressSignalPayload {
  const title = event.title.trim() || 'untitled task';
  let contents: string;
  switch (event.stage) {
    case 'started':
      contents = `Background task started: "${title}". I will report back when it finishes.`;
      break;
    case 'done':
      contents = `Background task done: "${title}".`;
      break;
    case 'needs_review':
      contents =
        event.status === 'skipped'
          ? `Background task "${title}" is blocked and needs a decision from the human.`
          : `Background task "${title}" did not finish and needs another look.`;
      break;
    default:
      contents = `Background task update for "${title}".`;
  }
  return {
    tagName: TASK_PROGRESS_TAG_NAME,
    attributes: sanitizeSignalAttributes({
      taskId: event.chatTaskId,
      runId: event.runId,
      stage: event.stage,
      status: event.status,
    }),
    contents,
  };
}

function randomId(): string {
  // crypto.randomUUID is available on every Node we support; tiny indirection for stubs.
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

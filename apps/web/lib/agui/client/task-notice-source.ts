/**
 * TB-363 (R2 / B2): the browser half of open-page task-notice delivery.
 *
 * The web bridge publishes `{ type: 'chat_task_notice', companyId, agentId, chatTaskId, runId,
 * stage, threadId }` on the Redis `sse:{companyId}` channel after it queues the notice row on
 * the origin thread; `/api/sse/[companyId]` fans that channel out to the browser as
 * `data: <json>` frames. This module is the ONE consumer of that poke for the assistant chat:
 * it opens the EventSource, filters frames down to the notice type (and this company), and
 * hands the caller `{ threadId, agentId }` — which is exactly what
 * `AgentChatClient.handleTaskNotice` takes. The notice content itself always arrives THROUGH
 * THE STORE (history merge), never from this frame, so a lost poke only delays delivery to the
 * next poll/merge — the poke is a fast path, not a source of truth.
 */
import { TASK_PROGRESS_NOTICE_SSE_TYPE } from '@tourbillon/shared/types';

/** The poke fields the chat client needs to decide whether the notice is for THIS thread. */
export interface TaskNoticePoke {
  threadId?: string;
  agentId?: string;
}

/** Minimal EventSource surface this module uses (fake-injectable in tests). */
export interface TaskNoticeEventSourceLike {
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface TaskNoticeSourceOptions {
  companyId: string;
  /** Called for every `chat_task_notice` poke addressed to this company. */
  onNotice: (poke: TaskNoticePoke) => void;
  /** Test seam: construct the EventSource (defaults to the browser global). */
  newEventSource?: (url: string) => TaskNoticeEventSourceLike;
}

/**
 * Open the company SSE stream and forward notice pokes. Returns a disposer that closes the
 * stream. Non-JSON frames, other event types, and foreign companyIds are ignored; connection
 * errors need no handling here — EventSource reconnects by itself, and the client's idle
 * notice poll covers anything missed while down.
 */
export function watchTaskNotices(opts: TaskNoticeSourceOptions): () => void {
  const factory =
    opts.newEventSource ??
    // Single-step cast: the DOM EventSource satisfies this interface at runtime (its richer
    // MessageEvent arg still carries `data`); the types differ only in parameter variance.
    (typeof EventSource !== 'undefined' ? (url: string) => new EventSource(url) as TaskNoticeEventSourceLike : undefined);
  if (!factory) return () => {}; // SSR / non-browser: no poke channel, polls still deliver.

  let source: TaskNoticeEventSourceLike;
  try {
    source = factory(`/api/sse/${encodeURIComponent(opts.companyId)}`);
  } catch {
    return () => {};
  }

  source.onmessage = (event: { data: string }) => {
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof payload !== 'object' || payload === null) return;
    const frame = payload as Record<string, unknown>;
    if (frame.type !== TASK_PROGRESS_NOTICE_SSE_TYPE) return;
    if (frame.companyId !== opts.companyId) return;
    opts.onNotice({
      threadId: typeof frame.threadId === 'string' ? frame.threadId : undefined,
      agentId: typeof frame.agentId === 'string' ? frame.agentId : undefined,
    });
  };
  // EventSource retries on its own; the idle notice poll backstops anything missed while down.
  source.onerror = () => {};

  return () => {
    source.onmessage = null;
    source.onerror = null;
    try {
      source.close();
    } catch {
      // already closed
    }
  };
}

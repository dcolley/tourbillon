/**
 * AGUI-1: one AG-UI run as an SSE response body, driven by an AgentController session.
 *
 * The run stays open across Mastra run restarts that belong to the same user turn (a steer aborts and
 * restarts; a queued follow-up starts right after the turn ends), so a client sees one RUN_STARTED …
 * RUN_FINISHED pair per request. Client disconnect (AG-UI `abortRun()` aborts the fetch) aborts the
 * session run.
 */
import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';
import { AGUI_CUSTOM, createAguiEventMapper, type AguiSourceEvent } from './session-events';

/**
 * Mastra Agent thread-queue API (`@mastra/core` Agent): messages queued on a thread while a run is
 * active (e.g. `session.followUp()`) wait in the agent runtime's pending-signal queue for that thread,
 * not in the session, and survive `session.abort()`.
 */
export interface AguiThreadQueue {
  subscribeThreadEvents?(
    scope: { resourceId: string; threadId: string },
    listener: (event: { type: string; count?: number }) => void,
  ): () => void;
  abortThreadStream?(options: {
    resourceId: string;
    threadId: string;
    clearPendingSignals?: boolean;
    localOnly?: boolean;
  }): boolean;
}

/** The parts of an AgentController session this module uses (Mastra `Session` satisfies it). */
export interface AguiSession {
  subscribe(listener: (event: AguiSourceEvent) => void): () => void;
  abort(): void;
  getCurrentRunId(): string | null | undefined;
  /** Mastra: drops follow-ups still being prepared and the follow-up binding. */
  cleanupFollowUpBinding?(): void;
  /** Mastra: the session's run machinery; its agent owns the thread's queued follow-ups. */
  readonly machinery?: { getAgent(): AguiThreadQueue };
}

function threadQueue(session: AguiSession): AguiThreadQueue | undefined {
  try {
    return session.machinery?.getAgent();
  } catch {
    return undefined;
  }
}

/**
 * Client gone: stop the run and drop every queued turn so nothing runs for a closed stream:
 * - Mastra follow-ups still being prepared (`cleanupFollowUpBinding`);
 * - Mastra follow-ups already queued on the thread (`mastraQueued` > 0): the agent runtime's pending
 *   signals for the thread are cleared (`abortThreadStream({ clearPendingSignals: true })`);
 * - AG-UI follow-ups queued on the run claim: dropped when `onClose` releases the claim.
 */
function abortAndDropQueued(
  session: AguiSession,
  target: { resourceId?: string; threadId?: string; mastraQueued: number },
): void {
  try {
    session.cleanupFollowUpBinding?.();
  } catch {
    /* best effort */
  }
  if (session.getCurrentRunId()) session.abort();
  if (target.mastraQueued > 0 && target.resourceId && target.threadId) {
    try {
      threadQueue(session)?.abortThreadStream?.({
        resourceId: target.resourceId,
        threadId: target.threadId,
        clearPendingSignals: true,
        localOnly: true,
      });
    } catch {
      /* best effort */
    }
  }
}

const continuationExpected = new WeakMap<object, number>();

/** Called before `session.steer()` so an open AG-UI run keeps streaming through the restart. */
export function expectRunContinuation(session: object): void {
  continuationExpected.set(session, (continuationExpected.get(session) ?? 0) + 1);
}

function takeContinuation(session: object): boolean {
  const n = continuationExpected.get(session) ?? 0;
  if (n <= 0) return false;
  if (n === 1) continuationExpected.delete(session);
  else continuationExpected.set(session, n - 1);
  return true;
}

function peekContinuation(session: object): boolean {
  return (continuationExpected.get(session) ?? 0) > 0;
}

export interface AguiRunStreamOptions {
  session: AguiSession;
  threadId: string;
  runId: string;
  /** Mastra thread the run is bound to (filters tool events from other threads). */
  mastraThreadId?: string;
  /** Mastra resource of that thread; with `mastraThreadId`, lets a disconnect clear the thread's queue. */
  resourceId?: string;
  /** Starts the turn (e.g. `session.sendMessage`); resolves when Mastra reports the turn done. */
  start: () => Promise<void>;
  /** Request abort signal; abort ends the stream and aborts the session run. */
  signal?: AbortSignal;
  /** Quiet period after a run ends before RUN_FINISHED, to catch an immediate restart. */
  settleMs?: number;
  /** Longest wait for an expected restart (steer / queued follow-up). */
  continuationTimeoutMs?: number;
  /** SSE comment keep-alive interval. */
  heartbeatMs?: number;
  /** Called once when the stream closes for any reason (finish, error, client disconnect). */
  onClose?: () => void;
  /**
   * Next turn queued on this run (AG-UI follow-up), started after the current turn completes. Queued
   * turns that have not started when the stream closes are never started.
   */
  takeQueuedTurn?: () => (() => Promise<void>) | undefined;
  /**
   * Queued turns that will not run: those already dropped plus those still queued when the run ends.
   * When non-zero, a `tourbillon.follow_up_dropped` CUSTOM event (`{ count }`) is sent before
   * RUN_FINISHED / RUN_ERROR so the client knows its follow-up was not processed.
   */
  droppedQueuedTurns?: () => number;
}

export const AGUI_SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

const encoder = new EventEncoder();
const textEncoder = new TextEncoder();

export function encodeAguiEvents(events: BaseEvent[]): Uint8Array {
  return textEncoder.encode(events.map((e) => encoder.encodeSSE(e)).join(''));
}

/** Short complete run (RUN_STARTED, extra events, RUN_FINISHED) — used for control requests. */
export function aguiControlStream(opts: {
  threadId: string;
  runId: string;
  events: BaseEvent[];
  result?: unknown;
}): ReadableStream<Uint8Array> {
  const events: BaseEvent[] = [
    { type: EventType.RUN_STARTED, threadId: opts.threadId, runId: opts.runId } as BaseEvent,
    ...opts.events,
    {
      type: EventType.RUN_FINISHED,
      threadId: opts.threadId,
      runId: opts.runId,
      outcome: { type: 'success' },
      ...(opts.result !== undefined ? { result: opts.result } : {}),
    } as BaseEvent,
  ];
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encodeAguiEvents(events));
      ctrl.close();
    },
  });
}

export function aguiRunStream(opts: AguiRunStreamOptions): ReadableStream<Uint8Array> {
  const settleMs = opts.settleMs ?? 250;
  const continuationTimeoutMs = opts.continuationTimeoutMs ?? 15_000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const mapper = createAguiEventMapper({
    threadId: opts.threadId,
    runId: opts.runId,
    mastraThreadId: opts.mastraThreadId,
  });
  const { session } = opts;

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let sawAgentStart = false;
  let running = false;
  let queuedFollowUps = 0;
  let onAbort: (() => void) | undefined;
  let unsubscribeQueue: (() => void) | undefined;
  /** Messages queued on the Mastra thread (any session), from the agent's thread events. */
  let mastraQueued = 0;
  const dropAll = () => {
    const queued = Math.max(mastraQueued, queuedFollowUps);
    abortAndDropQueued(session, { resourceId: opts.resourceId, threadId: opts.mastraThreadId, mastraQueued: queued });
  };

  let closeNotified = false;
  const notifyClose = () => {
    if (closeNotified) return;
    closeNotified = true;
    try {
      opts.onClose?.();
    } catch {
      /* ignore */
    }
  };

  const clearFinishTimer = () => {
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = undefined;
  };

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (events: BaseEvent[]) => {
        if (closed || events.length === 0) return;
        try {
          ctrl.enqueue(encodeAguiEvents(events));
        } catch {
          teardown();
        }
      };

      const teardown = () => {
        if (closed) return;
        closed = true;
        clearFinishTimer();
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribeQueue?.();
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
        notifyClose();
      };

      const finish = (override?: Parameters<typeof mapper.finish>[0]) => {
        if (closed) return;
        const events = mapper.finish(override);
        let dropped = 0;
        try {
          dropped = opts.droppedQueuedTurns?.() ?? 0;
        } catch {
          /* ignore */
        }
        if (dropped > 0) {
          // After any closing message/tool events, before RUN_FINISHED / RUN_ERROR.
          events.splice(Math.max(events.length - 1, 0), 0, {
            type: EventType.CUSTOM,
            name: AGUI_CUSTOM.followUpDropped,
            value: { count: dropped },
          } as BaseEvent);
        }
        write(events);
        teardown();
      };

      const scheduleFinish = (delayMs: number) => {
        clearFinishTimer();
        finishTimer = setTimeout(() => {
          finishTimer = undefined;
          if (!running) finish();
        }, delayMs);
      };

      write([{ type: EventType.RUN_STARTED, threadId: opts.threadId, runId: opts.runId } as BaseEvent]);

      unsubscribe = session.subscribe((event) => {
        if (closed) return;
        write(mapper.map(event));
        if (event.type === 'agent_start') {
          sawAgentStart = true;
          running = true;
          clearFinishTimer();
          takeContinuation(session);
        } else if (event.type === 'follow_up_queued') {
          queuedFollowUps = typeof event.count === 'number' ? event.count : 0;
        } else if (event.type === 'agent_end') {
          running = false;
          if (event.reason === 'complete' && opts.takeQueuedTurn) {
            const next = opts.takeQueuedTurn();
            if (next) {
              // Keep the run open for the queued turn; start it once the finished turn has settled.
              scheduleFinish(continuationTimeoutMs);
              setTimeout(() => {
                if (closed) return;
                next().catch((err: unknown) => {
                  finish({ error: err instanceof Error ? err.message : String(err) });
                });
              }, 0);
              return;
            }
          }
          const restartExpected =
            (event.reason === 'aborted' && peekContinuation(session)) ||
            (event.reason === 'complete' && queuedFollowUps > 0);
          scheduleFinish(restartExpected ? continuationTimeoutMs : settleMs);
        }
      });

      if (opts.resourceId && opts.mastraThreadId) {
        try {
          unsubscribeQueue = threadQueue(session)?.subscribeThreadEvents?.(
            { resourceId: opts.resourceId, threadId: opts.mastraThreadId },
            (event) => {
              if (event.type === 'queue-count-changed' && typeof event.count === 'number') mastraQueued = event.count;
            },
          );
        } catch {
          unsubscribeQueue = undefined;
        }
      }

      if (opts.signal) {
        onAbort = () => {
          if (closed) return;
          dropAll();
          // The client has gone; nothing more can be delivered.
          teardown();
        };
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      if (heartbeatMs > 0) {
        heartbeat = setInterval(() => {
          if (closed) return;
          try {
            ctrl.enqueue(textEncoder.encode(': keep-alive\n\n'));
          } catch {
            teardown();
          }
        }, heartbeatMs);
      }

      opts.start().then(
        () => {
          // Turn reported done. If no agent_start was seen the turn never ran (nothing to stream).
          if (!sawAgentStart && !closed) scheduleFinish(settleMs);
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          finish({ error: message });
        },
      );
    },
    cancel() {
      if (closed) return;
      closed = true;
      clearFinishTimer();
      if (heartbeat) clearInterval(heartbeat);
      dropAll();
      unsubscribe?.();
      unsubscribeQueue?.();
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      notifyClose();
    },
  });
}

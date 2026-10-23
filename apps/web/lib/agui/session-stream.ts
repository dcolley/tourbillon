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
import { createAguiEventMapper, type AguiSourceEvent } from './session-events';

/** The parts of an AgentController session this module uses (Mastra `Session` satisfies it). */
export interface AguiSession {
  subscribe(listener: (event: AguiSourceEvent) => void): () => void;
  abort(): void;
  getCurrentRunId(): string | null | undefined;
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
        if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
        try {
          ctrl.close();
        } catch {
          /* already closed */
        }
      };

      const finish = (override?: Parameters<typeof mapper.finish>[0]) => {
        if (closed) return;
        write(mapper.finish(override));
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
          const restartExpected =
            (event.reason === 'aborted' && peekContinuation(session)) ||
            (event.reason === 'complete' && queuedFollowUps > 0);
          scheduleFinish(restartExpected ? continuationTimeoutMs : settleMs);
        }
      });

      if (opts.signal) {
        onAbort = () => {
          if (closed) return;
          if (session.getCurrentRunId()) session.abort();
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
      unsubscribe?.();
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
      if (session.getCurrentRunId()) session.abort();
    },
  });
}

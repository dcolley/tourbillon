/**
 * AGUI-1: one AG-UI run as an SSE response body, driven by an AgentController session.
 *
 * The run stays open across Mastra run restarts that belong to the same user turn (a steer aborts and
 * restarts; a queued follow-up starts right after the turn ends), so a client sees one RUN_STARTED …
 * RUN_FINISHED pair per request.
 *
 * STREAM-1: a client disconnect (the fetch aborted or the body cancelled: AG-UI `abortRun()`, a closed
 * tab, iPad Safari suspending a backgrounded page) only detaches that subscriber. The session run keeps
 * going, queued turns still start, and the run claim is released only when the run itself ends. A
 * later request can re-attach (`attach`): it gets the events of this AG-UI run so far, replayed, then
 * the live events up to RUN_FINISHED / RUN_ERROR. Only an explicit `abort` action stops the run.
 */
import { EventType, type BaseEvent } from '@ag-ui/core';
import { EventEncoder } from '@ag-ui/encoder';
import { AGUI_CUSTOM, createAguiEventMapper, errorMessage, type AguiSourceEvent } from './session-events';

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
  /** Mastra resource of that thread. */
  resourceId?: string;
  /** Starts the turn (e.g. `session.sendMessage`); resolves when Mastra reports the turn done. */
  start: () => Promise<void>;
  /**
   * Request abort signal. STREAM-1: abort only detaches this request's subscriber; the session run
   * keeps going (stop it with the `abort` action).
   */
  signal?: AbortSignal;
  /** Quiet period after a run ends before RUN_FINISHED, to catch an immediate restart. */
  settleMs?: number;
  /** Longest wait for an expected restart (steer / queued follow-up). */
  continuationTimeoutMs?: number;
  /** SSE comment keep-alive interval. */
  heartbeatMs?: number;
  /**
   * Called once when the AG-UI run ends (RUN_FINISHED / RUN_ERROR). STREAM-1: not on a client
   * disconnect; a detached run still ends (and calls this) when its session run ends.
   */
  onClose?: () => void;
  /**
   * STREAM-1: receives the run's `attach` function once the stream starts, so a later request can
   * re-subscribe (see `AguiRunAttach`). Typically stored on the run claim.
   */
  onAttachable?: (attach: AguiRunAttach) => void;
  /** STREAM-1: most bytes of this run's events kept for replay to a re-attaching client. */
  replayLimitBytes?: number;
  /**
   * Next turn queued on this run (AG-UI follow-up), started after the current turn completes (also
   * while no client is attached).
   */
  takeQueuedTurn?: () => (() => Promise<void>) | undefined;
  /**
   * Queued turns that will not run: those already dropped plus those still queued when the run ends.
   * When non-zero, a `tourbillon.follow_up_dropped` CUSTOM event (`{ count }`) is sent before
   * RUN_FINISHED / RUN_ERROR so the client knows its follow-up was not processed.
   */
  droppedQueuedTurns?: () => number;
  /** Tool calls resumed by this run (announced by an earlier run); see AguiEventMapperOptions. */
  resumedToolCallIds?: readonly string[];
  /**
   * Mastra 1.78: `respondToToolSuspension` no longer throws when the resume fails on the session's
   * active thread — it emits a session `error` event instead. Set on a resume run so that event ends
   * the AG-UI run (through the normal finish path, honouring `publicRunError`) instead of the stream
   * waiting for an `agent_end` that never comes and closing as RUN_FINISHED.
   */
  errorIsTerminal?: boolean;
  /**
   * When set, RUN_ERROR carries this message instead of the engine's error text; the original text
   * is logged server-side (truncated).
   */
  publicRunError?: string;
  /**
   * OBS-1: trace of this run (the trace id passed to Mastra in `tracingOptions`). Sent as a
   * `tourbillon.trace` CUSTOM event right after RUN_STARTED and added to the RUN_FINISHED `result`
   * (`{ reason, traceId, traceUrl? }`). Omitted when tracing is off.
   */
  trace?: { traceId: string; traceUrl?: string };
}

/**
 * STREAM-1: a new response body for an open AG-UI run: the run's events so far (from RUN_STARTED; or
 * only RUN_STARTED when the replay buffer overflowed), then its live events up to RUN_FINISHED /
 * RUN_ERROR. `signal` aborting detaches it again. Null once the run has ended.
 */
export type AguiRunAttach = (signal?: AbortSignal) => ReadableStream<Uint8Array> | null;

/** Default replay buffer for a re-attaching client (per open run). */
export const AGUI_REPLAY_LIMIT_BYTES = 2 * 1024 * 1024;

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

function traceValue(trace: { traceId: string; traceUrl?: string }): { traceId: string; traceUrl?: string } {
  return trace.traceUrl ? { traceId: trace.traceId, traceUrl: trace.traceUrl } : { traceId: trace.traceId };
}

export function aguiRunStream(opts: AguiRunStreamOptions): ReadableStream<Uint8Array> {
  const settleMs = opts.settleMs ?? 250;
  const continuationTimeoutMs = opts.continuationTimeoutMs ?? 15_000;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const replayLimit = opts.replayLimitBytes ?? AGUI_REPLAY_LIMIT_BYTES;
  const mapper = createAguiEventMapper({
    threadId: opts.threadId,
    runId: opts.runId,
    mastraThreadId: opts.mastraThreadId,
    resumedToolCallIds: opts.resumedToolCallIds,
  });
  const { session } = opts;

  /** The AG-UI run has ended (terminal events sent to every attached client). */
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let finishTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let sawAgentStart = false;
  let running = false;
  let queuedFollowUps = 0;
  /** errorIsTerminal: message of the last session `error` event seen before the turn started. */
  let startError: string | undefined;

  /** STREAM-1: attached response bodies (the first request's, plus any re-attached ones). */
  type Sink = { ctrl: ReadableStreamDefaultController<Uint8Array>; detach: () => void };
  const sinks = new Set<Sink>();
  /** Encoded events of this run so far, replayed to a client that re-attaches. */
  const replay: Uint8Array[] = [];
  let replayBytes = 0;
  let replayOverflow = false;
  let runStarted: Uint8Array | undefined;

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

  const enqueue = (sink: Sink, chunk: Uint8Array) => {
    try {
      sink.ctrl.enqueue(chunk);
    } catch {
      // That client has gone: detach it; the run carries on.
      sink.detach();
    }
  };

  const record = (chunk: Uint8Array) => {
    if (replayOverflow) return;
    if (replayBytes + chunk.byteLength > replayLimit) {
      // Too much to replay: a re-attaching client gets RUN_STARTED and the live events only.
      replayOverflow = true;
      replay.length = 0;
      replayBytes = 0;
      return;
    }
    replay.push(chunk);
    replayBytes += chunk.byteLength;
  };

  const write = (events: BaseEvent[]) => {
    if (closed || events.length === 0) return;
    const chunk = encodeAguiEvents(events);
    record(chunk);
    for (const sink of [...sinks]) enqueue(sink, chunk);
  };

  /** Ends the AG-UI run: closes every attached body, stops listening, releases the claim. */
  const teardown = () => {
    if (closed) return;
    closed = true;
    clearFinishTimer();
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    for (const sink of [...sinks]) {
      sinks.delete(sink);
      try {
        sink.ctrl.close();
      } catch {
        /* already closed */
      }
      sink.detach();
    }
    replay.length = 0;
    notifyClose();
  };

  const finish = (override?: Parameters<typeof mapper.finish>[0]) => {
    if (closed) return;
    const events = mapper.finish(override);
    if (opts.publicRunError) {
      for (const event of events) {
        if (event.type !== EventType.RUN_ERROR) continue;
        const raw = String((event as { message?: unknown }).message ?? '');
        console.warn('[agui] run failed', { runId: opts.runId.slice(0, 100), error: raw.slice(0, 300) });
        (event as { message?: string }).message = opts.publicRunError;
      }
    }
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
    if (opts.trace) {
      for (let i = 0; i < events.length; i++) {
        const e = events[i] as BaseEvent & { result?: unknown };
        if (e.type !== EventType.RUN_FINISHED) continue;
        const result = e.result && typeof e.result === 'object' ? (e.result as Record<string, unknown>) : {};
        events[i] = { ...e, result: { ...result, ...traceValue(opts.trace) } } as BaseEvent;
      }
    }
    write(events);
    teardown();
  };

  const scheduleFinish = (delayMs: number, override?: () => Parameters<typeof mapper.finish>[0]) => {
    clearFinishTimer();
    finishTimer = setTimeout(() => {
      finishTimer = undefined;
      if (!running) finish(override?.());
    }, delayMs);
  };

  /** A response body attached to this run; `signal` aborting (or the body cancelled) detaches it. */
  const openSink = (signal: AbortSignal | undefined, first: Uint8Array[]): ReadableStream<Uint8Array> => {
    let sink: Sink | undefined;
    let onAbort: (() => void) | undefined;
    const detach = () => {
      if (sink) sinks.delete(sink);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      onAbort = undefined;
    };
    return new ReadableStream<Uint8Array>({
      start(ctrl) {
        sink = { ctrl, detach };
        for (const chunk of first) ctrl.enqueue(chunk);
        if (closed) {
          ctrl.close();
          return;
        }
        if (signal?.aborted) return;
        sinks.add(sink);
        if (signal) {
          onAbort = () => {
            // STREAM-1: the client has gone (or is suspended): detach only; the run keeps going.
            detach();
            try {
              ctrl.close();
            } catch {
              /* already closed */
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      },
      cancel() {
        detach();
      },
    });
  };

  const attach: AguiRunAttach = (signal) => {
    if (closed || !runStarted) return null;
    return openSink(signal, replayOverflow ? [runStarted] : [...replay]);
  };

  const begin = () => {
    write([
      { type: EventType.RUN_STARTED, threadId: opts.threadId, runId: opts.runId } as BaseEvent,
      ...(opts.trace
        ? [{ type: EventType.CUSTOM, name: AGUI_CUSTOM.trace, value: traceValue(opts.trace) } as BaseEvent]
        : []),
    ]);
    runStarted = encodeAguiEvents([
      { type: EventType.RUN_STARTED, threadId: opts.threadId, runId: opts.runId } as BaseEvent,
    ]);

    unsubscribe = session.subscribe((event) => {
      if (closed) return;
      write(mapper.map(event));
      if (event.type === 'agent_start') {
        sawAgentStart = true;
        running = true;
        startError = undefined;
        clearFinishTimer();
        takeContinuation(session);
      } else if (event.type === 'error' && opts.errorIsTerminal && !sawAgentStart) {
        // 1.78 resume failure: the session emits `error` instead of rejecting; the run never starts.
        startError = errorMessage(event.error) ?? 'Agent run failed';
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

    if (heartbeatMs > 0) {
      const keepAlive = textEncoder.encode(': keep-alive\n\n');
      heartbeat = setInterval(() => {
        if (closed) return;
        for (const sink of [...sinks]) enqueue(sink, keepAlive);
      }, heartbeatMs);
    }

    try {
      opts.onAttachable?.(attach);
    } catch {
      /* ignore */
    }

    opts.start().then(
      () => {
        // Turn reported done. If no agent_start was seen the turn never ran (nothing to stream).
        // errorIsTerminal: a recorded session `error` (1.78 resume failure) ends the run as
        // RUN_ERROR (mapped through publicRunError) rather than a silent RUN_FINISHED. A late
        // agent_start clears the error and cancels this finish, as a restart would.
        if (!sawAgentStart && !closed) {
          scheduleFinish(settleMs, () => (startError ? { error: startError } : undefined));
        }
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        finish({ error: message });
      },
    );
  };

  // The first request's body is the first sink; the run starts with it, attached or not.
  const stream = openSink(opts.signal, []);
  begin();
  return stream;
}

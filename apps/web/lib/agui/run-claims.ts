/**
 * AGUI-1: one AG-UI run at a time per thread and per session.
 *
 * `claimAguiRun` is synchronous, so a route that checks and claims without an await in between cannot
 * accept two parallel runs. The claim is released when the run's stream closes (finish, error or client
 * disconnect).
 *
 * Follow-ups sent while an AG-UI run is open are queued on the claim (not in the Mastra session), so they
 * are started by the open stream after the current turn completes and are dropped with the claim when
 * the stream closes: nothing runs for a client that has gone.
 *
 * Scope: in-process. The chat controllers and their Mastra sessions (run state, follow-up queue,
 * approvals) live in this process's controller cache, as for /api/chat/*, so the claim lives next to
 * the session it guards.
 */

import type { AssistantTracingOptions } from '@tourbillon/mastra';

export type AguiQueuedTurn = () => Promise<void>;

export interface AguiRunClaim {
  /** Queue a turn to start after the current one completes (no-op once released). */
  queueTurn(turn: AguiQueuedTurn): number;
  /** Next queued turn, if any. */
  takeQueuedTurn(): AguiQueuedTurn | undefined;
  queuedTurns(): number;
  /** Drops the queued turns that have not started; returns how many were dropped. */
  dropQueuedTurns(): number;
  /** Queued turns dropped so far (by `dropQueuedTurns`), for telling the client. */
  droppedTurns(): number;
  release(): void;
  readonly released: boolean;
  /** OBS-1: tracing options of the open run, so follow-ups queued on it join the same trace. */
  readonly tracingOptions?: AssistantTracingOptions;
}

const g = globalThis as unknown as {
  tourbillonAguiThreadClaims?: Map<string, AguiRunClaim>;
  tourbillonAguiSessionClaims?: WeakMap<object, AguiRunClaim>;
};

function threadClaims(): Map<string, AguiRunClaim> {
  if (!g.tourbillonAguiThreadClaims) g.tourbillonAguiThreadClaims = new Map();
  return g.tourbillonAguiThreadClaims;
}

function sessionClaims(): WeakMap<object, AguiRunClaim> {
  if (!g.tourbillonAguiSessionClaims) g.tourbillonAguiSessionClaims = new WeakMap();
  return g.tourbillonAguiSessionClaims;
}

function threadKey(resourceId: string, threadId: string): string {
  return `${resourceId}\u0000${threadId}`;
}

export function isAguiRunClaimed(session: object, resourceId: string, threadId: string): boolean {
  return sessionClaims().has(session) || threadClaims().has(threadKey(resourceId, threadId));
}

/** CHAT-5: true while any session has an AG-UI run claimed on this thread. */
export function isAguiThreadRunClaimed(resourceId: string, threadId: string): boolean {
  return threadClaims().has(threadKey(resourceId, threadId));
}

/**
 * True when the thread's run is claimed by a different session (e.g. another `sessionScope` of the
 * same agent). Control actions that act on a run (abort, steer, follow-up, tool approval / resume)
 * must be refused then: only the session that owns the open run may act on it.
 */
export function isAguiThreadClaimedByOtherSession(session: object, resourceId: string, threadId: string): boolean {
  const holder = threadClaims().get(threadKey(resourceId, threadId));
  return holder !== undefined && sessionClaims().get(session) !== holder;
}

/** The open AG-UI run of this session on this thread, if there is one. */
export function activeAguiRun(session: object, resourceId: string, threadId: string): AguiRunClaim | undefined {
  const claim = sessionClaims().get(session);
  return claim && threadClaims().get(threadKey(resourceId, threadId)) === claim ? claim : undefined;
}

/** Claims the run for this session and thread, or returns null when either is already claimed. */
export function claimAguiRun(
  session: object,
  resourceId: string,
  threadId: string,
  options: { tracingOptions?: AssistantTracingOptions } = {},
): AguiRunClaim | null {
  if (isAguiRunClaimed(session, resourceId, threadId)) return null;
  const key = threadKey(resourceId, threadId);
  const queue: AguiQueuedTurn[] = [];
  let released = false;
  let dropped = 0;
  const claim: AguiRunClaim = {
    queueTurn(turn) {
      if (!released) queue.push(turn);
      return queue.length;
    },
    takeQueuedTurn() {
      return released ? undefined : queue.shift();
    },
    queuedTurns() {
      return queue.length;
    },
    dropQueuedTurns() {
      const n = queue.length;
      dropped += n;
      queue.length = 0;
      return n;
    },
    droppedTurns() {
      return dropped;
    },
    release() {
      if (released) return;
      released = true;
      queue.length = 0;
      if (threadClaims().get(key) === claim) threadClaims().delete(key);
      if (sessionClaims().get(session) === claim) sessionClaims().delete(session);
    },
    get released() {
      return released;
    },
    ...(options.tracingOptions ? { tracingOptions: options.tracingOptions } : {}),
  };
  threadClaims().set(key, claim);
  sessionClaims().set(session, claim);
  return claim;
}

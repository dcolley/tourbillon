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

export type AguiQueuedTurn = () => Promise<void>;

export interface AguiRunClaim {
  /** Queue a turn to start after the current one completes (no-op once released). */
  queueTurn(turn: AguiQueuedTurn): number;
  /** Next queued turn, if any. */
  takeQueuedTurn(): AguiQueuedTurn | undefined;
  queuedTurns(): number;
  dropQueuedTurns(): void;
  release(): void;
  readonly released: boolean;
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

/** The open AG-UI run of this session on this thread, if there is one. */
export function activeAguiRun(session: object, resourceId: string, threadId: string): AguiRunClaim | undefined {
  const claim = sessionClaims().get(session);
  return claim && threadClaims().get(threadKey(resourceId, threadId)) === claim ? claim : undefined;
}

/** Claims the run for this session and thread, or returns null when either is already claimed. */
export function claimAguiRun(session: object, resourceId: string, threadId: string): AguiRunClaim | null {
  if (isAguiRunClaimed(session, resourceId, threadId)) return null;
  const key = threadKey(resourceId, threadId);
  const queue: AguiQueuedTurn[] = [];
  let released = false;
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
      queue.length = 0;
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
  };
  threadClaims().set(key, claim);
  sessionClaims().set(session, claim);
  return claim;
}

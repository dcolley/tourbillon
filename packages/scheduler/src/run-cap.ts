/**
 * Company-wide concurrent-run cap (companies.settings.maxConcurrentRuns).
 *
 * Race safety: with a cap set, "count in-flight runs" and "insert the new running row" happen in
 * ONE transaction that first takes a per-company transaction-scoped advisory lock
 * (pg_advisory_xact_lock(RUN_CAP_LOCK_NAMESPACE, hashtext(companyId))). Every capped start for a
 * company queues on that lock, so starts are serialised: under READ COMMITTED each statement takes
 * a fresh snapshot, so the count (run after the lock is granted) sees every row committed by the
 * previous holder, and the lock is only released at COMMIT, after this start's row is visible.
 * Two starters can therefore never both see "cap - 1" and both start. Other companies hash to other
 * keys and never wait on each other (a rare hash collision only serialises, it never miscounts).
 *
 * No cap (null) keeps the old single INSERT with no lock or transaction.
 *
 * Over the cap the wake is DEFERRED, never failed or dropped: the caller waits a short jittered
 * backoff (or until a run of the same company finishes in this process) and tries the whole wake
 * again, re-reading agent/company state, the cap and the wake context each time.
 */

/** int4 namespace for the run-cap advisory lock (ASCII "RCAP"). */
export const RUN_CAP_LOCK_NAMESPACE = 0x52434150;

/** Backoff between deferred attempts. Exported (mutable) so tests can shorten it. */
export const runCapTiming = { baseMs: 2_000, maxMs: 15_000 };

/** Exponential backoff capped at runCapTiming.maxMs, with ±20% jitter so waiters don't stampede. */
export function runCapBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(runCapTiming.maxMs, runCapTiming.baseMs * 2 ** Math.min(Math.max(attempt, 0), 16));
  return Math.max(1, Math.round(exp * (0.8 + 0.4 * random())));
}

const slotWaiters = new Map<string, Set<() => void>>();

/** Resolve after `ms`, or earlier when notifyRunSlotFreed(companyId) is called. */
export function waitForRunSlot(companyId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let waiters = slotWaiters.get(companyId);
    if (!waiters) {
      waiters = new Set();
      slotWaiters.set(companyId, waiters);
    }
    const set = waiters;
    const wake = () => {
      clearTimeout(timer);
      set.delete(wake);
      if (set.size === 0 && slotWaiters.get(companyId) === set) slotWaiters.delete(companyId);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    set.add(wake);
  });
}

/** A run of this company finished in this process: let its deferred wakes retry now. */
export function notifyRunSlotFreed(companyId: string): void {
  const waiters = slotWaiters.get(companyId);
  if (!waiters) return;
  for (const wake of [...waiters]) wake();
}

export type RunSlotDecision =
  | { started: true }
  | { started: false; inFlight: number; cap: number };

/**
 * Start a run unless the company is at its cap. `withCompanyLock` must run `fn` inside a
 * transaction that holds the company's advisory lock; `countInFlight` and `startRun` must use
 * that same transaction so the check and the insert are atomic with respect to other starters.
 */
export async function startRunUnderCap<Tx>(opts: {
  cap: number | null;
  startUncapped: () => Promise<void>;
  withCompanyLock: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  countInFlight: (tx: Tx) => Promise<number>;
  startRun: (tx: Tx) => Promise<void>;
}): Promise<RunSlotDecision> {
  const { cap } = opts;
  if (cap === null) {
    await opts.startUncapped();
    return { started: true };
  }
  return opts.withCompanyLock(async (tx) => {
    const inFlight = await opts.countInFlight(tx);
    if (inFlight >= cap) return { started: false, inFlight, cap };
    await opts.startRun(tx);
    return { started: true };
  });
}

/**
 * Company-wide FIFO of deferred wakes (in memory; persistence is a follow-up). One entry per agent:
 * the per-agent lock means an agent has at most one wake waiting, and further wakes for it are
 * coalesced into that entry. Only the OLDEST entry of a company tries to start; a fresh wake that
 * arrives while older ones wait joins the back, so repeated timer wakes cannot jump the queue.
 */
export interface DeferrableWake {
  agentId: string;
  companyId: string;
  wakeReason: string;
  taskId?: string;
  approvalId?: string;
  wakeCommentId?: string;
}

export interface DeferredWake<W extends DeferrableWake = DeferrableWake> {
  companyId: string;
  agentId: string;
  /** Earliest enqueue time; coalescing never moves an entry back. */
  enqueuedAt: number;
  /** The wake that runs when this entry reaches the front (a non-timer wake wins over a timer). */
  wake: W;
  /** Distinct wake reasons merged into this entry, in arrival order. */
  reasons: string[];
}

const deferredQueues = new Map<string, DeferredWake[]>();
const deferredByAgent = new Map<string, DeferredWake>();

export function enqueueDeferredWake<W extends DeferrableWake>(wake: W, now = Date.now()): DeferredWake<W> {
  const existing = deferredByAgent.get(wake.agentId);
  if (existing) return existing as DeferredWake<W>;
  const entry: DeferredWake<W> = {
    companyId: wake.companyId,
    agentId: wake.agentId,
    enqueuedAt: now,
    wake,
    reasons: [wake.wakeReason],
  };
  const queue = deferredQueues.get(wake.companyId) ?? [];
  queue.push(entry);
  deferredQueues.set(wake.companyId, queue);
  deferredByAgent.set(wake.agentId, entry);
  return entry;
}

/** Drop an entry (its run started, was skipped or errored) and let the next oldest try now. */
export function removeDeferredWake(entry: DeferredWake): void {
  const queue = deferredQueues.get(entry.companyId);
  const idx = queue ? queue.indexOf(entry) : -1;
  if (queue && idx >= 0) {
    queue.splice(idx, 1);
    if (queue.length === 0) deferredQueues.delete(entry.companyId);
  }
  if (deferredByAgent.get(entry.agentId) === entry) deferredByAgent.delete(entry.agentId);
  if (idx >= 0) notifyRunSlotFreed(entry.companyId);
}

/** How many of the company's deferred wakes are older than `entry` (all of them for a fresh wake). */
export function deferredWakesAhead(companyId: string, entry?: DeferredWake): number {
  const queue = deferredQueues.get(companyId) ?? [];
  const idx = entry ? queue.indexOf(entry) : -1;
  return idx < 0 ? queue.length : idx;
}

export function deferredWakeForAgent(agentId: string): DeferredWake | undefined {
  return deferredByAgent.get(agentId);
}

/**
 * Fold a further wake for an agent into its deferred entry (keeps the earliest enqueue time).
 * A non-timer wake replaces a timer one; two non-timer wakes merge only when they target the same
 * thing. Returns false when they differ (the caller keeps it as the usual follow-up, never lost).
 */
export function coalesceIntoDeferredWake<W extends DeferrableWake>(entry: DeferredWake<W>, wake: W): boolean {
  const cur = entry.wake;
  const sameTarget =
    cur.wakeReason === wake.wakeReason &&
    cur.taskId === wake.taskId &&
    cur.approvalId === wake.approvalId &&
    cur.wakeCommentId === wake.wakeCommentId;
  if (cur.wakeReason !== 'timer' && wake.wakeReason !== 'timer' && !sameTarget) return false;
  if (cur.wakeReason === 'timer' && wake.wakeReason !== 'timer') entry.wake = wake;
  if (!entry.reasons.includes(wake.wakeReason)) entry.reasons.push(wake.wakeReason);
  return true;
}

/**
 * Scheduler shutdown: deferred wakes are in memory and are dropped. Log ONE warning line with the
 * count, each non-timer wake's agentId + wake type (timer wakes re-fire, so only counted). No
 * payloads. Returns whether a line was written.
 */
export function warnDroppedDeferredWakes(logger: {
  warn: (message: string, data?: Record<string, unknown>) => void;
}): boolean {
  const entries = [...deferredQueues.values()].flat().sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  if (entries.length === 0) return false;
  const timer = entries.filter((e) => e.wake.wakeReason === 'timer');
  const dropped = entries
    .filter((e) => e.wake.wakeReason !== 'timer')
    .map((e) => ({ agentId: e.agentId, wakeType: e.wake.wakeReason }));
  logger.warn('scheduler shutdown: dropping deferred wakes (company concurrent-run cap)', {
    count: entries.length,
    timerCount: timer.length,
    dropped,
  });
  return true;
}

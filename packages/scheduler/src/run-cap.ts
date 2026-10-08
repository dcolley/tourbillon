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

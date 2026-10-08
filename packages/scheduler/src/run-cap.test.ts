/**
 * Company concurrent-run cap core (no DB): cap decision, lock-serialised race safety,
 * slot notifications and backoff bounds. The wake-runner wiring is covered in
 * wake-runner-run-cap.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coalesceIntoDeferredWake,
  deferredWakeForAgent,
  deferredWakesAhead,
  enqueueDeferredWake,
  removeDeferredWake,
  notifyRunSlotFreed,
  runCapBackoffMs,
  runCapTiming,
  sameWakeTarget,
  startRunUnderCap,
  takeDeferredWakeAfterAttempt,
  waitForRunSlot,
  wakeTargetForLog,
} from './run-cap';

const tick = () => new Promise<void>((r) => setImmediate(r));

/** In-memory "company" whose count/insert yield between steps, like real DB round trips. */
function fakeCompany(initialRunning: number) {
  let running = initialRunning;
  let maxSeen = initialRunning;
  let lockedTxs = 0;
  let uncapped = 0;
  let chain = Promise.resolve();
  const mutexLock = async <T>(fn: (tx: 'tx') => Promise<T>): Promise<T> => {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    await prev;
    lockedTxs += 1;
    try {
      return await fn('tx');
    } finally {
      release();
    }
  };
  const noLock = async <T>(fn: (tx: 'tx') => Promise<T>): Promise<T> => fn('tx');
  return {
    get running() { return running; },
    get maxSeen() { return maxSeen; },
    get lockedTxs() { return lockedTxs; },
    get uncapped() { return uncapped; },
    opts(cap: number | null, lock: 'mutex' | 'none' = 'mutex') {
      return {
        cap,
        startUncapped: async () => {
          uncapped += 1;
          running += 1;
        },
        withCompanyLock: lock === 'mutex' ? mutexLock : noLock,
        countInFlight: async (_tx: 'tx') => {
          await tick();
          return running;
        },
        startRun: async (_tx: 'tx') => {
          await tick();
          running += 1;
          maxSeen = Math.max(maxSeen, running);
        },
      };
    },
  };
}

describe('startRunUnderCap', () => {
  it('under the cap: starts the run inside the locked transaction', async () => {
    const c = fakeCompany(1);
    assert.deepEqual(await startRunUnderCap(c.opts(2)), { started: true });
    assert.equal(c.running, 2);
    assert.equal(c.lockedTxs, 1);
  });

  it('at the cap: does not start, reports in-flight/cap (caller defers, never fails)', async () => {
    const c = fakeCompany(2);
    assert.deepEqual(await startRunUnderCap(c.opts(2)), { started: false, inFlight: 2, cap: 2 });
    assert.equal(c.running, 2, 'no run row inserted');
  });

  it('null cap: plain insert with no lock or count (unchanged default behaviour)', async () => {
    const c = fakeCompany(50);
    assert.deepEqual(await startRunUnderCap(c.opts(null)), { started: true });
    assert.equal(c.uncapped, 1);
    assert.equal(c.lockedTxs, 0);
  });

  it('race: 12 concurrent starters with cap 3 → exactly 3 start when count+insert share the lock', async () => {
    const c = fakeCompany(0);
    const results = await Promise.all(Array.from({ length: 12 }, () => startRunUnderCap(c.opts(3))));
    assert.equal(results.filter((r) => r.started).length, 3);
    assert.equal(c.running, 3);
    assert.equal(c.maxSeen, 3);
  });

  it('control: without the lock the same race overshoots the cap (why the lock is needed)', async () => {
    const c = fakeCompany(0);
    await Promise.all(Array.from({ length: 12 }, () => startRunUnderCap(c.opts(3, 'none'))));
    assert.ok(c.running > 3, `expected overshoot without a lock, got ${c.running}`);
  });
});

describe('deferred-wake slot waiting', () => {
  it('notifyRunSlotFreed wakes only that company’s waiters early', async () => {
    let a = false;
    let b = false;
    const wa = waitForRunSlot('company-a', 60_000).then(() => (a = true));
    const wb = waitForRunSlot('company-b', 30).then(() => (b = true));
    notifyRunSlotFreed('company-a');
    await wa;
    assert.equal(a, true);
    assert.equal(b, false, 'company-b waiter is not woken by company-a');
    await wb; // falls back to its own timer
    assert.equal(b, true);
  });

  it('backoff grows from base, is capped at max and jittered ±20%', () => {
    const saved = { ...runCapTiming };
    try {
      runCapTiming.baseMs = 2000;
      runCapTiming.maxMs = 15000;
      assert.equal(runCapBackoffMs(0, () => 0.5), 2000);
      assert.equal(runCapBackoffMs(1, () => 0.5), 4000);
      assert.equal(runCapBackoffMs(10, () => 0.5), 15000);
      assert.equal(runCapBackoffMs(0, () => 0), 1600);
      assert.equal(runCapBackoffMs(50, () => 0.999999), 18000);
    } finally {
      Object.assign(runCapTiming, saved);
    }
  });
});

describe('deferred-wake FIFO queue', () => {
  const w = (agentId: string, wakeReason: string, extra: Record<string, string> = {}) => ({
    agentId,
    companyId: 'q-co',
    wakeReason,
    ...extra,
  });

  it('orders per company, counts entries ahead, and a fresh wake sees all of them ahead', () => {
    const a = enqueueDeferredWake(w('qa', 'on_demand'), 1);
    const b = enqueueDeferredWake(w('qb', 'timer'), 2);
    try {
      assert.equal(deferredWakesAhead('q-co', a), 0);
      assert.equal(deferredWakesAhead('q-co', b), 1);
      assert.equal(deferredWakesAhead('q-co'), 2);
      assert.equal(deferredWakesAhead('other-co'), 0);
      assert.equal(enqueueDeferredWake(w('qa', 'timer'), 9), a, 'one entry per agent');
    } finally {
      removeDeferredWake(a);
      removeDeferredWake(b);
    }
    assert.equal(deferredWakesAhead('q-co'), 0);
    assert.equal(deferredWakeForAgent('qa'), undefined);
  });

  it('removing an entry wakes the company waiters so the next oldest tries now', async () => {
    const a = enqueueDeferredWake(w('qc', 'on_demand'));
    let woke = false;
    const waiting = waitForRunSlot('q-co', 60_000).then(() => (woke = true));
    removeDeferredWake(a);
    await waiting;
    assert.equal(woke, true);
  });

  it('coalesce: keeps earliest enqueue time, non-timer replaces timer, reasons merged once', () => {
    const e = enqueueDeferredWake(w('qd', 'timer'), 100);
    try {
      assert.equal(coalesceIntoDeferredWake(e, w('qd', 'timer')), true);
      assert.equal(coalesceIntoDeferredWake(e, w('qd', 'assignment', { taskId: 't1' })), true);
      assert.equal(e.wake.wakeReason, 'assignment');
      assert.equal(coalesceIntoDeferredWake(e, w('qd', 'timer')), true);
      assert.equal(e.wake.wakeReason, 'assignment', 'a later timer does not replace it');
      assert.equal(coalesceIntoDeferredWake(e, w('qd', 'assignment', { taskId: 't1' })), true, 'same target merges');
      assert.equal(coalesceIntoDeferredWake(e, w('qd', 'assignment', { taskId: 't2' })), false, 'other task stays separate');
      assert.equal(e.enqueuedAt, 100);
      assert.deepEqual(e.reasons, ['timer', 'assignment']);
    } finally {
      removeDeferredWake(e);
    }
  });

  it('take after attempt: returns a wake folded in after the attempt read the entry, and removes it in the same step', () => {
    const e = enqueueDeferredWake(w('qe', 'timer'), 1);
    const used = e.wake;
    assert.equal(coalesceIntoDeferredWake(e, w('qe', 'assignment', { taskId: 't9' })), true);
    const replacement = takeDeferredWakeAfterAttempt(e, used);
    assert.deepEqual(replacement, w('qe', 'assignment', { taskId: 't9' }));
    assert.equal(deferredWakeForAgent('qe'), undefined, 'entry gone: later wakes become the follow-up');
    assert.equal(deferredWakesAhead('q-co'), 0);
  });

  it('take after attempt: nothing folded in (or only merged into the same wake) → no replacement', () => {
    const e = enqueueDeferredWake(w('qf', 'on_demand'), 1);
    assert.equal(coalesceIntoDeferredWake(e, w('qf', 'timer')), true);
    assert.equal(coalesceIntoDeferredWake(e, w('qf', 'on_demand')), true);
    assert.equal(takeDeferredWakeAfterAttempt(e, e.wake), undefined);
    assert.equal(deferredWakeForAgent('qf'), undefined);
  });

  it('same target / log target: ids only, no payload fields', () => {
    assert.equal(sameWakeTarget(w('x', 'assignment', { taskId: 't1' }), w('x', 'assignment', { taskId: 't1' })), true);
    assert.equal(sameWakeTarget(w('x', 'assignment', { taskId: 't1' }), w('x', 'assignment', { taskId: 't2' })), false);
    assert.equal(sameWakeTarget(w('x', 'timer'), w('x', 'on_demand')), false);
    assert.deepEqual(
      wakeTargetForLog({ ...w('x', 'approval', { approvalId: 'ap1', note: 'secret-note' }) } as never),
      { approvalId: 'ap1' },
    );
    assert.deepEqual(wakeTargetForLog(w('x', 'timer')), {});
  });
});

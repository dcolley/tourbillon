/** WID-1: widget call owners (only the session that asked a widget may answer it). */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasOtherSessionPendingWidget,
  pendingOwnedWidgetCalls,
  recordWidgetOwner,
  resetWidgetOwnersForTests,
  retireWidgetOwnersOfController,
  trackWidgetOwners,
  widgetOwnerSweepThresholdForTests,
  widgetOwnerThreadCountForTests,
  widgetOwnership,
} from './widget-owners';

type Listener = (event: { type: string; [k: string]: unknown }) => void;

function fakeSession(parked: string[] = []) {
  const listeners = new Set<Listener>();
  return {
    suspensions: { has: ({ toolCallId }: { toolCallId: string }) => parked.includes(toolCallId) },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: { type: string; [k: string]: unknown }) {
      for (const l of listeners) l(event);
    },
    listeners,
  };
}

describe('WID-1 widget owners', () => {
  beforeEach(() => resetWidgetOwnersForTests());

  it('the first recorded session owns the call; other sessions, threads and resources do not', () => {
    const a = fakeSession();
    const b = fakeSession();
    recordWidgetOwner(a, 'r', 't', 'c1');
    recordWidgetOwner(b, 'r', 't', 'c1');
    assert.equal(widgetOwnership(a, 'r', 't', 'c1'), 'owner');
    assert.equal(widgetOwnership(b, 'r', 't', 'c1'), 'other');
    assert.equal(widgetOwnership(a, 'r', 't2', 'c1'), 'unknown');
    assert.equal(widgetOwnership(a, 'r2', 't', 'c1'), 'unknown');
    assert.equal(widgetOwnership(a, 'r', 't', 'c2'), 'unknown');
  });

  it('tracks widget suspensions on the thread only, and stops when unsubscribed', () => {
    const s = fakeSession();
    const stop = trackWidgetOwners(s, 'r', 't', (name) => name === 'picker');
    s.emit({ type: 'tool_suspended', toolCallId: 'w1', toolName: 'picker', threadId: 't' });
    s.emit({ type: 'tool_suspended', toolCallId: 'w2', toolName: 'picker', threadId: 'other' });
    s.emit({ type: 'tool_suspended', toolCallId: 'x1', toolName: 'notAWidget', threadId: 't' });
    s.emit({ type: 'tool_approval_required', toolCallId: 'w3', toolName: 'picker', threadId: 't' });
    assert.equal(widgetOwnership(s, 'r', 't', 'w1'), 'owner');
    assert.equal(widgetOwnership(s, 'r', 't', 'w2'), 'unknown');
    assert.equal(widgetOwnership(s, 'r', 't', 'x1'), 'unknown');
    assert.equal(widgetOwnership(s, 'r', 't', 'w3'), 'unknown');
    stop();
    assert.equal(s.listeners.size, 0);
    s.emit({ type: 'tool_suspended', toolCallId: 'w4', toolName: 'picker', threadId: 't' });
    assert.equal(widgetOwnership(s, 'r', 't', 'w4'), 'unknown');
  });

  it('lists the calls this session asked on the thread that are still parked in it', () => {
    const s = fakeSession(['w1', 'w3']);
    const other = fakeSession(['w2']);
    recordWidgetOwner(s, 'r', 't', 'w1');
    recordWidgetOwner(s, 'r', 't', 'w2');
    recordWidgetOwner(s, 'r', 't2', 'w3');
    recordWidgetOwner(other, 'r', 't', 'w2b');
    assert.deepEqual(pendingOwnedWidgetCalls(s, 'r', 't'), ['w1']);
    assert.deepEqual(pendingOwnedWidgetCalls(other, 'r', 't'), []);
  });

  it('caps records per thread, dropping the oldest settled record first and never a pending one', () => {
    const s = fakeSession(['c0']);
    for (let i = 0; i < 101; i += 1) recordWidgetOwner(s, 'r', 't', `c${i}`);
    assert.equal(widgetOwnership(s, 'r', 't', 'c0'), 'owner', 'pending record kept');
    assert.equal(widgetOwnership(s, 'r', 't', 'c1'), 'unknown', 'oldest settled record dropped');
    assert.equal(widgetOwnership(s, 'r', 't', 'c2'), 'owner');
    assert.equal(widgetOwnership(s, 'r', 't', 'c100'), 'owner');
    assert.deepEqual(pendingOwnedWidgetCalls(s, 'r', 't'), ['c0']);
  });

  it("one resource's records never evict another's pending widget or its steer guard", () => {
    const owner = fakeSession(['mine']);
    recordWidgetOwner(owner, 'company-a', 't', 'mine');
    const flood = fakeSession();
    for (let t = 0; t < 12_000; t += 1) recordWidgetOwner(flood, 'company-b', `t${t}`, 'c');
    for (let i = 0; i < 500; i += 1) recordWidgetOwner(flood, 'company-b', 't0', `x${i}`);
    assert.equal(widgetOwnership(owner, 'company-a', 't', 'mine'), 'owner');
    assert.deepEqual(pendingOwnedWidgetCalls(owner, 'company-a', 't'), ['mine'], 'steer guard intact');
    assert.equal(hasOtherSessionPendingWidget(fakeSession(), 'company-a', 't'), true);
    assert.ok(widgetOwnerThreadCountForTests() <= 10_001, `swept: ${widgetOwnerThreadCountForTests()}`);
  });

  it('reports a widget pending for another session on the thread only', () => {
    const owner = fakeSession(['w1']);
    const other = fakeSession(['w1']);
    recordWidgetOwner(owner, 'r', 't', 'w1');
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't'), true);
    assert.equal(hasOtherSessionPendingWidget(owner, 'r', 't'), false, 'the owner is not refused');
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't2'), false);
    assert.equal(hasOtherSessionPendingWidget(other, 'r2', 't'), false);
    const settled = fakeSession();
    recordWidgetOwner(settled, 'r', 't3', 'w9');
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't3'), false, 'answered widgets do not block');
  });

  it('the sweep threshold doubles past pending survivors, so a full table is not re-swept on every insert', () => {
    const pending = fakeSession(['p']);
    assert.equal(widgetOwnerSweepThresholdForTests(), 10_000);
    for (let t = 0; t < 10_000; t += 1) recordWidgetOwner(pending, 'r', `t${t}`, 'p');
    assert.equal(widgetOwnerThreadCountForTests(), 10_000);
    recordWidgetOwner(pending, 'r', 'next', 'p');
    // Sweep ran (nothing settled to drop), and the next one waits for twice the survivors.
    assert.equal(widgetOwnerThreadCountForTests(), 10_001);
    assert.equal(widgetOwnerSweepThresholdForTests(), 20_000);
    recordWidgetOwner(pending, 'r', 'next2', 'p');
    assert.equal(widgetOwnerSweepThresholdForTests(), 20_000, 'no new sweep below the threshold');
  });
});

describe('WID-1 widget owners that have gone', () => {
  beforeEach(() => resetWidgetOwnersForTests());

  it('owner collected: its call counts as gone; refused only while still parked in the asking session', () => {
    const RealWeakRef = globalThis.WeakRef;
    const collected = new Set<object>();
    class TestWeakRef<T extends object> {
      constructor(private readonly target: T) {}
      deref(): T | undefined {
        return collected.has(this.target) ? undefined : this.target;
      }
    }
    (globalThis as { WeakRef: unknown }).WeakRef = TestWeakRef;
    try {
      const owner = fakeSession(['w1']);
      recordWidgetOwner(owner, 'r', 't', 'w1');
      collected.add(owner);
      const fannedOut = fakeSession(['w1']);
      const fresh = fakeSession();
      assert.equal(widgetOwnership(fresh, 'r', 't', 'w1'), 'gone');
      assert.equal(hasOtherSessionPendingWidget(fannedOut, 'r', 't'), true, 'still parked here: fail closed');
      assert.equal(hasOtherSessionPendingWidget(fresh, 'r', 't'), false);
      assert.deepEqual(pendingOwnedWidgetCalls(owner, 'r', 't'), []);
    } finally {
      (globalThis as { WeakRef: unknown }).WeakRef = RealWeakRef;
    }
  });

  it('controller dropped: parked owner runs are aborted once, records settle, other sessions may act', () => {
    const oldController = {};
    const liveController = {};
    let parked = ['w1', 'w2'];
    let aborts = 0;
    const owner = {
      ...fakeSession(),
      suspensions: { has: ({ toolCallId }: { toolCallId: string }) => parked.includes(toolCallId) },
      abort: () => {
        aborts += 1;
        parked = [];
      },
    };
    const onLive = fakeSession(['w3']);
    recordWidgetOwner(owner, 'r', 't', 'w1', oldController);
    recordWidgetOwner(owner, 'r', 't2', 'w2', oldController);
    recordWidgetOwner(onLive, 'r', 't3', 'w3', liveController);
    const other = fakeSession();
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't'), true);

    assert.equal(retireWidgetOwnersOfController(oldController), 1);
    assert.equal(aborts, 1, 'one abort per owner session');
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't'), false);
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't2'), false);
    assert.equal(widgetOwnership(other, 'r', 't', 'w1'), 'gone');
    assert.equal(widgetOwnership(owner, 'r', 't', 'w1'), 'gone', 'the dropped session itself is gone too');
    // A session on another controller is untouched.
    assert.equal(widgetOwnership(onLive, 'r', 't3', 'w3'), 'owner');
    assert.equal(hasOtherSessionPendingWidget(other, 'r', 't3'), true);
  });

  it('controller dropped: an owner whose abort fails still counts as gone (no stranded thread)', () => {
    const controller = {};
    const owner = { ...fakeSession(['w1']), abort: () => { throw new Error('engine said no'); } };
    const fannedOutOnNewController = fakeSession();
    recordWidgetOwner(owner, 'r', 't', 'w1', controller);
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(retireWidgetOwnersOfController(controller), 1);
    } finally {
      console.warn = warn;
    }
    assert.equal(hasOtherSessionPendingWidget(fannedOutOnNewController, 'r', 't'), false);
    assert.equal(widgetOwnership(fannedOutOnNewController, 'r', 't', 'w1'), 'gone');
  });

  it('a record whose controller was collected counts as gone', () => {
    const RealWeakRef = globalThis.WeakRef;
    const collected = new Set<object>();
    class TestWeakRef<T extends object> {
      constructor(private readonly target: T) {}
      deref(): T | undefined {
        return collected.has(this.target) ? undefined : this.target;
      }
    }
    (globalThis as { WeakRef: unknown }).WeakRef = TestWeakRef;
    try {
      const controller = {};
      const owner = fakeSession(['w1']);
      recordWidgetOwner(owner, 'r', 't', 'w1', controller);
      assert.equal(widgetOwnership(owner, 'r', 't', 'w1'), 'owner');
      collected.add(controller);
      assert.equal(widgetOwnership(owner, 'r', 't', 'w1'), 'gone');
      assert.equal(hasOtherSessionPendingWidget(fakeSession(), 'r', 't'), false);
    } finally {
      (globalThis as { WeakRef: unknown }).WeakRef = RealWeakRef;
    }
  });
});

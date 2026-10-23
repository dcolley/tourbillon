/** WID-1: widget call owners (only the session that asked a widget may answer it). */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingOwnedWidgetCalls,
  recordWidgetOwner,
  resetWidgetOwnersForTests,
  trackWidgetOwners,
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

  it('keeps a bounded number of records, dropping the oldest first', () => {
    const s = fakeSession();
    for (let i = 0; i < 5001; i += 1) recordWidgetOwner(s, 'r', 't', `c${i}`);
    assert.equal(widgetOwnership(s, 'r', 't', 'c0'), 'unknown');
    assert.equal(widgetOwnership(s, 'r', 't', 'c1'), 'owner');
    assert.equal(widgetOwnership(s, 'r', 't', 'c5000'), 'owner');
  });
});

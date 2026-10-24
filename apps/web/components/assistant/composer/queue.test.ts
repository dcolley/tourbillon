/** CHAT-1: composer follow-up queue. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUEUED, editQueued, enqueue, removeQueued, takeNext, type QueuedMessage } from './queue';

const item = (id: string, text = id, attachments: QueuedMessage['attachments'] = []): QueuedMessage => ({ id, text, attachments });
const ref = { path: 'resources/chat-uploads/a/t/x.txt', name: 'x.txt', size: 1, mediaType: 'text/plain' };

describe('CHAT-1 composer queue', () => {
  it('enqueues in order without mutating', () => {
    const q0: QueuedMessage[] = [];
    const r1 = enqueue(q0, item('a'));
    assert.ok(r1.ok);
    const r2 = enqueue(r1.ok ? r1.queue : [], item('b'));
    assert.ok(r2.ok);
    assert.deepEqual(r2.ok && r2.queue.map((q) => q.id), ['a', 'b']);
    assert.equal(q0.length, 0);
  });

  it('refuses empty items and a full queue', () => {
    assert.deepEqual(enqueue([], item('a', '   ')), { ok: false, reason: 'empty' });
    assert.ok(enqueue([], item('a', '', [ref])).ok, 'attachments alone are enough');
    const full = Array.from({ length: MAX_QUEUED }, (_, i) => item(`q${i}`));
    assert.deepEqual(enqueue(full, item('x')), { ok: false, reason: 'full' });
  });

  it('edits and removes by id; an empty edit removes the item unless it has attachments', () => {
    const q = [item('a'), item('b'), item('c', 'c', [ref])];
    assert.deepEqual(editQueued(q, 'b', 'B!').map((x) => x.text), ['a', 'B!', 'c']);
    assert.deepEqual(editQueued(q, 'b', '  ').map((x) => x.id), ['a', 'c']);
    assert.deepEqual(editQueued(q, 'c', '').map((x) => x.id), ['a', 'b', 'c']);
    assert.deepEqual(removeQueued(q, 'a').map((x) => x.id), ['b', 'c']);
    assert.deepEqual(removeQueued(q, 'zz').length, 3);
    assert.equal(q[1].text, 'b');
  });

  it('takeNext returns the head and the rest', () => {
    assert.deepEqual(takeNext([item('a'), item('b')]), { next: item('a'), rest: [item('b')] });
    assert.deepEqual(takeNext([]), { next: undefined, rest: [] });
  });
});

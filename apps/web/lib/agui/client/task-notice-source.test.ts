/**
 * TB-363 (B2) — the browser poke channel. At base bdd1d970 the bridge's `chat_task_notice`
 * publish had ZERO browser consumers (no EventSource anywhere), so `handleTaskNotice` was dead
 * code and the poke fast path did not exist. This pins the wire contract between the bridge
 * publisher (apps/web/lib/assistant/task-progress-bridge.ts) and the chat client:
 * `{ type: 'chat_task_notice', companyId, threadId, agentId, ... }` frames on
 * /api/sse/[companyId] reach `onNotice`; everything else is ignored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { watchTaskNotices, type TaskNoticeEventSourceLike } from './task-notice-source';
import { TASK_PROGRESS_NOTICE_SSE_TYPE } from '@tourbillon/shared/types';

class FakeSource implements TaskNoticeEventSourceLike {
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(public readonly url: string) {}
  close(): void {
    this.closed = true;
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

function harness(companyId = 'co-1') {
  const opened: FakeSource[] = [];
  const pokes: Array<{ threadId?: string; agentId?: string }> = [];
  const dispose = watchTaskNotices({
    companyId,
    onNotice: (poke) => pokes.push(poke),
    newEventSource: (url) => {
      const s = new FakeSource(url);
      opened.push(s);
      return s;
    },
  });
  return { opened, pokes, dispose };
}

const frame = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ type: TASK_PROGRESS_NOTICE_SSE_TYPE, companyId: 'co-1', threadId: 't-1', agentId: 'a-1', ...over });

describe('TB-363 B2 watchTaskNotices (browser poke channel)', () => {
  it('the wire contract: the poke type constant is the shared SSE event type', () => {
    // The bridge publishes exactly this string; renaming either side without the other kills R2.
    assert.equal(TASK_PROGRESS_NOTICE_SSE_TYPE, 'chat_task_notice');
  });

  it('opens ONE EventSource on the company SSE route for the given company', () => {
    const { opened } = harness('co-9');
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.url, '/api/sse/co-9');
  });

  it('a chat_task_notice frame for this company reaches onNotice with threadId + agentId', () => {
    const { opened, pokes } = harness();
    opened[0]!.emit(frame());
    assert.deepEqual(pokes, [{ threadId: 't-1', agentId: 'a-1' }]);
  });

  it('the connected frame, foreign types, and foreign companies are all ignored', () => {
    const { opened, pokes } = harness();
    const s = opened[0]!;
    s.emit(JSON.stringify({ type: 'connected', companyId: 'co-1' }));
    s.emit(JSON.stringify({ type: 'chat_task_progress', companyId: 'co-1', stage: 'done' }));
    s.emit(frame({ companyId: 'evil-co' }));
    s.emit('not json at all {');
    s.emit('42');
    s.emit('null');
    assert.deepEqual(pokes, []);
  });

  it('non-string threadId/agentId arrive as undefined (handleTaskNotice treats them as broadcast)', () => {
    const { opened, pokes } = harness();
    opened[0]!.emit(frame({ threadId: 7, agentId: null }));
    assert.deepEqual(pokes, [{ threadId: undefined, agentId: undefined }]);
  });

  it('dispose closes the source and detaches handlers; later emits are inert', () => {
    const { opened, pokes, dispose } = harness();
    const s = opened[0]!;
    dispose();
    assert.equal(s.closed, true);
    s.emit(frame()); // onmessage nulled — must not reach onNotice
    assert.deepEqual(pokes, []);
    dispose(); // idempotent
  });

  it('a throwing EventSource constructor degrades to the poll backstop, not a crash', () => {
    const dispose = watchTaskNotices({
      companyId: 'co-1',
      onNotice: () => {
        throw new Error('unreachable');
      },
      newEventSource: () => {
        throw new Error('no EventSource here');
      },
    });
    assert.doesNotThrow(() => dispose());
  });

  it('without a browser EventSource (SSR/Node) it is a no-op', () => {
    assert.equal(typeof EventSource, 'undefined', 'this runs under node, so the global is absent');
    let called = 0;
    const dispose = watchTaskNotices({ companyId: 'co-1', onNotice: () => called++ });
    assert.equal(called, 0);
    assert.doesNotThrow(() => dispose());
  });
});

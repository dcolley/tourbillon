/** STEER-1: steerPreservingTurn unit tests (fake session; the real-Mastra run is in *.mastra.test.ts). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineOriginalAndSteer,
  inFlightUserTurns,
  steerPreservingTurn,
  trackInFlightUserTurns,
  userTurnsFromEvent,
  type SteerableSession,
} from './steer-preserving-turn';

const THREAD = 'thread-1';

function userSignalEvent(id: string, contents: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: 'message_start',
    message: {
      id,
      role: 'signal',
      content: {
        format: 2,
        parts: [{ type: 'data-user-message', data: { id, type: 'user', tagName: 'user', contents, createdAt: '2026-10-25T18:00:00.000Z', ...extra } }],
      },
    },
  };
}

function fakeSession(opts: { stored?: string[]; failSave?: boolean; failList?: boolean } = {}) {
  const listeners: Array<(e: any) => void> = [];
  const calls: string[] = [];
  const saved: any[] = [];
  const sent: string[] = [];
  let threadId: string | null = THREAD;
  const session = {
    subscribe(fn: (e: any) => void) {
      listeners.push(fn);
      return () => {};
    },
    thread: {
      getId: () => threadId,
      async listMessages() {
        calls.push('list');
        if (opts.failList) throw new Error('db down');
        return [...(opts.stored ?? []), ...saved.map((s) => s.id)].map((id) => ({ id }));
      },
    },
    identity: { getResourceId: () => 'res-1' },
    abort() {
      calls.push('abort');
    },
    async sendMessage({ content }: { content: string }) {
      calls.push('send');
      sent.push(content);
    },
    sendSignalToThread(input: any, target: any) {
      calls.push('save');
      if (opts.failSave) return { accepted: Promise.reject(new Error('save failed')) };
      saved.push({ ...input, target });
      return { accepted: Promise.resolve({ accepted: true }) };
    },
  };
  const emit = (e: any) => listeners.forEach((l) => l(e));
  return {
    session: session as unknown as SteerableSession,
    emit,
    calls,
    saved,
    sent,
    switchThread: (id: string) => (threadId = id),
  };
}

describe('STEER-1 userTurnsFromEvent', () => {
  it('reads user signals only', () => {
    assert.deepEqual(userTurnsFromEvent(userSignalEvent('u1', 'hello'), THREAD).map((t) => [t.id, t.contents]), [['u1', 'hello']]);
    assert.deepEqual(userTurnsFromEvent({ type: 'message_start', message: { role: 'assistant', content: { parts: [] } } }, THREAD), []);
    // A signal Mastra already persisted (sendSignalToThread echo) carries text parts, not data-user-message.
    assert.deepEqual(
      userTurnsFromEvent({ type: 'message_start', message: { role: 'signal', content: { parts: [{ type: 'text', text: 'x' }] } } }, THREAD),
      [],
    );
  });
});

describe('STEER-1 trackInFlightUserTurns', () => {
  it('holds the current run only and is scoped to the thread', () => {
    const f = fakeSession();
    trackInFlightUserTurns(f.session);
    trackInFlightUserTurns(f.session); // idempotent: one listener
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', 'ORIGINAL A'));
    f.emit(userSignalEvent('a', 'ORIGINAL A'));
    assert.deepEqual(inFlightUserTurns(f.session, THREAD).map((t) => t.id), ['a']);
    assert.deepEqual(inFlightUserTurns(f.session, 'other-thread'), []);
    f.emit({ type: 'agent_start' });
    assert.deepEqual(inFlightUserTurns(f.session, THREAD), []);
  });
});

describe('STEER-1 steerPreservingTurn', () => {
  it('original missing from storage: saved once (same id) before the steer, steer sent once unchanged', async () => {
    const f = fakeSession();
    trackInFlightUserTurns(f.session);
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', 'ORIGINAL A'));

    const result = await steerPreservingTurn(f.session, { content: 'STEER B' });
    assert.deepEqual(f.calls, ['abort', 'list', 'save', 'send']);
    assert.deepEqual(result, { alreadyStored: [], persisted: ['a'], inlined: [] });
    assert.equal(f.saved.length, 1);
    assert.equal(f.saved[0].id, 'a');
    assert.equal(f.saved[0].contents, 'ORIGINAL A');
    assert.equal(f.saved[0].createdAt, '2026-10-25T18:00:00.000Z');
    assert.deepEqual(f.saved[0].target, { resourceId: 'res-1', threadId: THREAD });
    assert.deepEqual(f.sent, ['STEER B'], 'original goes to history, not into the steer text: once in the prompt');
  });

  it('original already stored (run had finished): nothing saved, steer sent as-is', async () => {
    const f = fakeSession({ stored: ['a'] });
    trackInFlightUserTurns(f.session);
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', 'ORIGINAL A'));
    const result = await steerPreservingTurn(f.session, { content: 'STEER B' });
    assert.deepEqual(result, { alreadyStored: ['a'], persisted: [], inlined: [] });
    assert.equal(f.saved.length, 0);
    assert.deepEqual(f.sent, ['STEER B']);
  });

  it('no in-flight turn: abort then send, no storage calls (same as session.steer)', async () => {
    const f = fakeSession();
    trackInFlightUserTurns(f.session);
    await steerPreservingTurn(f.session, { content: 'STEER B' });
    assert.deepEqual(f.calls, ['abort', 'send']);
    assert.deepEqual(f.sent, ['STEER B']);
  });

  it('save fails: original carried inline in the steer message exactly once', async () => {
    const f = fakeSession({ failSave: true });
    trackInFlightUserTurns(f.session);
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', [{ type: 'text', text: 'ORIGINAL A' }]));
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = await steerPreservingTurn(f.session, { content: 'STEER B' });
      assert.deepEqual(result, { alreadyStored: [], persisted: [], inlined: ['a'] });
    } finally {
      console.warn = warn;
    }
    assert.equal(f.sent.length, 1);
    const text = f.sent[0]!;
    assert.equal(text.split('ORIGINAL A').length - 1, 1);
    assert.equal(text.split('STEER B').length - 1, 1);
    assert.ok(text.indexOf('ORIGINAL A') < text.indexOf('STEER B'));
  });

  it('storage lookup fails: treated as missing and saved (upsert by id keeps it single)', async () => {
    const f = fakeSession({ failList: true });
    trackInFlightUserTurns(f.session);
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', 'ORIGINAL A'));
    const result = await steerPreservingTurn(f.session, { content: 'STEER B' });
    assert.deepEqual(result.persisted, ['a']);
    assert.deepEqual(f.sent, ['STEER B']);
  });

  it('turns from another thread are not replayed', async () => {
    const f = fakeSession();
    trackInFlightUserTurns(f.session);
    f.emit({ type: 'agent_start' });
    f.emit(userSignalEvent('a', 'ORIGINAL A'));
    f.switchThread('thread-2');
    await steerPreservingTurn(f.session, { content: 'STEER B' });
    assert.equal(f.saved.length, 0);
    assert.deepEqual(f.sent, ['STEER B']);
  });

  it('combineOriginalAndSteer: no originals → steer unchanged', () => {
    assert.equal(combineOriginalAndSteer([], 'B'), 'B');
    assert.equal(combineOriginalAndSteer(['  '], 'B'), 'B');
  });
});

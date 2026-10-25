/** OBS-2: reaction input, stored shape, message id mapping and the Phoenix annotation payload. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSISTANT_FEEDBACK_METADATA_KEY,
  FEEDBACK_REASON_MAX,
  buildMessageFeedback,
  feedbackAnnotation,
  feedbackInputSchema,
  feedbackMessageId,
  feedbackTargets,
  normaliseFeedbackReason,
  readThreadFeedback,
} from './feedback';

const NOW = new Date('2026-10-25T00:00:00.000Z');

describe('OBS-2 feedback helpers', () => {
  it('input: rating required; reason capped; tags from the preset list; no extra keys', () => {
    assert.equal(feedbackInputSchema.safeParse({ messageId: 'm-1', rating: 'up' }).success, true);
    assert.equal(feedbackInputSchema.safeParse({ messageId: 'm-1', rating: 'down', reason: 'x', tags: ['incorrect'] }).success, true);
    for (const bad of [
      {},
      { messageId: 'm-1' },
      { messageId: 'm-1', rating: 'meh' },
      { messageId: '..', rating: 'up' },
      { messageId: 'a/b', rating: 'up' },
      { messageId: 'm-1', rating: 'down', tags: ['made-up'] },
      { messageId: 'm-1', rating: 'down', reason: 'x'.repeat(FEEDBACK_REASON_MAX + 1) },
      { messageId: 'm-1', rating: 'up', traceId: 'abc' },
    ]) {
      assert.equal(feedbackInputSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
    }
  });

  it('stored entry: thumbs up drops reason and tags; down keeps a cleaned reason and ordered unique tags', () => {
    assert.deepEqual(buildMessageFeedback({ messageId: 'm', rating: 'up', reason: 'nice', tags: ['unsafe'] }, NOW), {
      rating: 'up',
      reason: null,
      tags: [],
      updatedAt: NOW.toISOString(),
    });
    assert.deepEqual(
      buildMessageFeedback({ messageId: 'm', rating: 'down', reason: '  wrong\u202E \u0007date\n ', tags: ['unsafe', 'incorrect', 'unsafe'] }, NOW),
      { rating: 'down', reason: 'wrong date', tags: ['incorrect', 'unsafe'], updatedAt: NOW.toISOString() },
    );
    assert.equal(normaliseFeedbackReason('   '), null);
    assert.equal(normaliseFeedbackReason(undefined), null);
  });

  it('maps every text / reasoning segment id back to the Mastra message id', () => {
    assert.equal(feedbackMessageId('msg-1'), 'msg-1');
    assert.equal(feedbackMessageId('msg-1:text:2'), 'msg-1');
    assert.equal(feedbackMessageId('msg-1:reasoning:0'), 'msg-1');
  });

  it('reads one user’s reactions from thread metadata and ignores malformed entries', () => {
    const metadata = {
      agentId: 'a',
      [ASSISTANT_FEEDBACK_METADATA_KEY]: {
        m1: { u1: { rating: 'down', reason: 'bad', tags: ['incorrect', 'nope'], updatedAt: 't' }, u2: { rating: 'up' } },
        m2: { u1: { rating: 'sideways' } },
        m3: 'junk',
        '..': { u1: { rating: 'up' } },
      },
    };
    assert.deepEqual(readThreadFeedback(metadata, 'u1'), {
      m1: { rating: 'down', reason: 'bad', tags: ['incorrect'], updatedAt: 't' },
    });
    assert.deepEqual(Object.keys(readThreadFeedback(metadata, 'u2')), ['m1']);
    assert.deepEqual(readThreadFeedback(undefined, 'u1'), {});
    assert.deepEqual(readThreadFeedback({ [ASSISTANT_FEEDBACK_METADATA_KEY]: [] }, 'u1'), {});
  });

  it('annotation: HUMAN label + score + reason, stable identifier per user and message', () => {
    const ctx = { traceId: 'ABCDEF0123', messageId: 'm1', threadId: 't1', agentId: 'a1', companyId: 'c1', userKey: 'board' };
    const down = feedbackAnnotation(ctx, buildMessageFeedback({ messageId: 'm1', rating: 'down', reason: 'wrong', tags: ['incorrect'] }, NOW));
    assert.deepEqual(down, {
      trace_id: 'abcdef0123',
      name: 'user_feedback',
      annotator_kind: 'HUMAN',
      identifier: 'user:board:message:m1',
      result: { label: 'thumbs_down', score: 0, explanation: 'wrong' },
      metadata: { userId: 'board', messageId: 'm1', threadId: 't1', agentId: 'a1', companyId: 'c1', tags: ['incorrect'] },
    });
    const up = feedbackAnnotation(ctx, buildMessageFeedback({ messageId: 'm1', rating: 'up' }, NOW));
    assert.equal(up.identifier, down.identifier);
    assert.deepEqual(up.result, { label: 'thumbs_up', score: 1, explanation: null });
  });

  it('targets: last segment of each finished assistant message; none for the message an open run is writing', () => {
    const items = [
      { kind: 'user', id: 'u1' },
      { kind: 'assistant', id: 'm1', streaming: false },
      { kind: 'tool', id: 'call-1' },
      { kind: 'assistant', id: 'm1:text:1', streaming: false },
      { kind: 'user', id: 'u2' },
      { kind: 'assistant', id: 'm2', streaming: true },
    ];
    assert.deepEqual([...feedbackTargets(items, true)], [['m1:text:1', 'm1']]);
    const done = items.map((i) => (i.id === 'm2' ? { ...i, streaming: false } : i));
    assert.deepEqual([...feedbackTargets(done, false)], [
      ['m1:text:1', 'm1'],
      ['m2', 'm2'],
    ]);
    assert.deepEqual([...feedbackTargets(done, true)], [['m1:text:1', 'm1']]);
  });
});

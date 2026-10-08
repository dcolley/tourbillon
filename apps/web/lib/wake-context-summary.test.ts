import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wakeContextSummary } from './wake-context-summary';

describe('WC6 run detail line', () => {
  it('formats header/comment sizes and annotations', () => {
    assert.equal(
      wakeContextSummary({ wakeContext: { mode: 'v2', headerChars: 2169, commentChars: 4147, annotated: 11 } }),
      'Wake context: header 2169 chars, comments 4147 chars, 11 annotations',
    );
    assert.equal(
      wakeContextSummary({ wakeContext: { mode: 'v2', headerChars: 10, commentChars: 20, annotated: 1 } }),
      'Wake context: header 10 chars, comments 20 chars, 1 annotation',
    );
  });
  it('marks T1-only runs, and context failures', () => {
    assert.match(wakeContextSummary({ wakeContext: { mode: 't1', commentChars: 900 } })!, /header 0 chars, comments 900 chars, 0 annotations \(newest comments only\)$/);
    assert.match(wakeContextSummary({ wakeContext: { mode: 't1', error: 'db down' } })!, /\(live state unavailable; newest comments only\)$/);
  });
  it('#122 follow-up B1: render fallbacks are named (v2 → T1, and the minimal message)', () => {
    assert.match(
      wakeContextSummary({ wakeContext: { mode: 't1', fallback: 'v2_render_failed', commentChars: 5 } })!,
      /\(compressed view failed to render; newest comments only\)$/,
    );
    assert.equal(
      wakeContextSummary({ wakeContext: { mode: 'minimal', fallback: 't1_render_failed' } }),
      'Wake context: minimal message (the wake details could not be rendered)',
    );
    // S5: the error is a short code; the summary never prints it.
    assert.doesNotMatch(
      wakeContextSummary({ wakeContext: { mode: 't1', error: 'wake_context_query_failed' } })!,
      /wake_context_query_failed/,
    );
  });
  it('older runs without wakeContext show nothing', () => {
    assert.equal(wakeContextSummary({ wakeReason: 'timer' }), null);
    assert.equal(wakeContextSummary(null), null);
    assert.equal(wakeContextSummary({ wakeContext: 'x' }), null);
  });
});

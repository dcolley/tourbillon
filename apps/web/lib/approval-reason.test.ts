import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REJECT_REASON_MAX_CHARS,
  checkDecisionReason,
} from './approval-reason';

describe('checkDecisionReason (S2)', () => {
  it('approve: missing/empty/blank/zero-width → ok with undefined; non-string → 400', () => {
    for (const raw of [undefined, null, '', '  \n\t', '\u200B\u200C\u200D\u2060\uFEFF', '  \u200B  ']) {
      assert.deepEqual(checkDecisionReason('approved', raw), { ok: true, reason: undefined });
    }
    assert.deepEqual(checkDecisionReason('approved', 42), {
      ok: false,
      code: 'reason_not_string',
      message: 'reason must be a string',
    });
  });

  it('reject: missing/empty/blank/zero-width → reason_required', () => {
    for (const raw of [undefined, null, '', '  \n\t', '\u200B\u200C', '\u200D', '\u2060', '\uFEFF', ' \u200B\n']) {
      const r = checkDecisionReason('rejected', raw);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'reason_required');
    }
  });

  it('reject: non-string JSON values → reason_not_string', () => {
    for (const raw of [42, true, { a: 1 }, ['x']]) {
      const r = checkDecisionReason('rejected', raw);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.code, 'reason_not_string');
    }
  });

  it('trims edges (whitespace + zero-width) and keeps the middle', () => {
    assert.deepEqual(checkDecisionReason('rejected', '  \u200BSplit it\uFEFF\n'), {
      ok: true,
      reason: 'Split it',
    });
  });

  it('cap: at most 2000 chars after trim; longer refused, not truncated', () => {
    const ok = 'x'.repeat(REJECT_REASON_MAX_CHARS);
    assert.deepEqual(checkDecisionReason('rejected', `  ${ok}  `), { ok: true, reason: ok });
    const over = 'y'.repeat(REJECT_REASON_MAX_CHARS + 1);
    const r = checkDecisionReason('rejected', over);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, 'reason_too_long');
      assert.match(r.message, /2000/);
    }
    // Approve over the cap is also refused (same field).
    assert.equal(checkDecisionReason('approved', over).ok, false);
  });
});

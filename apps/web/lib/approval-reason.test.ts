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

  it('only invisible characters count as no reason (shared set)', () => {
    const each = ['\u00AD', '\u180E', '\u200E', '\u200F', '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u3164', '\u2800', '\u061C', '\u115F', '\uFFA0', '\u034F'];
    for (const raw of [...each, each.join(''), ` ${each.join(' ')}\u200B\n`]) {
      const r = checkDecisionReason('rejected', raw);
      assert.equal(r.ok, false, JSON.stringify(raw));
      if (!r.ok) assert.equal(r.code, 'reason_required');
      assert.deepEqual(checkDecisionReason('approved', raw), { ok: true, reason: undefined });
    }
    assert.deepEqual(checkDecisionReason('rejected', '\u200E\u2800 Too risky \u3164'), { ok: true, reason: 'Too risky' });
  });

  it('cap counts code points (as the MCP schema does), not UTF-16 units', () => {
    const emoji = '😀'.repeat(REJECT_REASON_MAX_CHARS);
    assert.equal(emoji.length, REJECT_REASON_MAX_CHARS * 2);
    assert.deepEqual(checkDecisionReason('rejected', emoji), { ok: true, reason: emoji });
    const r = checkDecisionReason('rejected', `${emoji}😀`);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'reason_too_long');
  });

  it('linear trim: 100k reason with a long blank run finishes quickly', () => {
    // Inner blank run must not make the pre-cap trim quadratic (regex `[...]+$` did).
    const raw = 'a' + ' '.repeat(100_000) + 'b';
    const t0 = Date.now();
    const r = checkDecisionReason('rejected', raw);
    const ms = Date.now() - t0;
    // Trim keeps the inner blanks; the value then exceeds the 2,000 code-point cap.
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'reason_too_long');
    assert.ok(ms < 500, `trim took ${ms}ms (budget 500ms)`);
  });
});

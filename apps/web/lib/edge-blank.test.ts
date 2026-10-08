import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isEdgeBlankChar, trimEdgeBlank } from './edge-blank';

/** PM's invisible set (#131 ruling + follow-up), beyond JS `\s`. One entry per code point. */
const PM_INVISIBLES = [
  '\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF',
  '\u00AD', '\u180E', '\u200E', '\u200F',
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E',
  '\u2066', '\u2067', '\u2068', '\u2069',
  '\u3164', '\u2800',
  '\u061C', '\u115F', '\uFFA0', '\u034F',
];

const hex = (s: string) => [...s].map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

describe('trimEdgeBlank (shared with approval-reason)', () => {
  it('strips whitespace and zero-width at both ends; middle kept', () => {
    assert.equal(trimEdgeBlank('  \u200BSplit it\uFEFF\n'), 'Split it');
    assert.equal(trimEdgeBlank('\u200B\u200C\u200D\u2060\uFEFF'), '');
    assert.equal(trimEdgeBlank('ok'), 'ok');
  });

  it('every PM invisible alone, doubled, or with spaces trims to empty', () => {
    for (const ch of PM_INVISIBLES) {
      assert.equal(isEdgeBlankChar(ch), true, hex(ch));
      assert.equal(trimEdgeBlank(ch), '', hex(ch));
      assert.equal(trimEdgeBlank(`${ch}${ch}`), '', hex(ch));
      assert.equal(trimEdgeBlank(` ${ch} \u00A0${ch}\t`), '', hex(ch));
    }
    assert.equal(trimEdgeBlank(PM_INVISIBLES.join(' ')), '');
  });

  it('every PM invisible is trimmed from either edge of a real value', () => {
    for (const ch of PM_INVISIBLES) {
      assert.equal(trimEdgeBlank(`${ch}Chief${ch}`), 'Chief', hex(ch));
      assert.equal(trimEdgeBlank(` ${ch} Chief ${ch} `), 'Chief', hex(ch));
    }
  });

  it('invisibles in the middle are kept (edge trim only)', () => {
    assert.equal(trimEdgeBlank('Chief\u200BOfficer'), 'Chief\u200BOfficer');
    assert.equal(trimEdgeBlank(' \u200EChief\u200BOfficer\u200F '), 'Chief\u200BOfficer');
    for (const ch of PM_INVISIBLES) {
      assert.equal(trimEdgeBlank(`A${ch}B`), `A${ch}B`, hex(ch));
    }
    assert.equal(trimEdgeBlank('A B'), 'A B');
  });

  it('does not treat visible neighbours as blank', () => {
    for (const ch of ['a', '-', '\u00AC', '\u2801', '\u3165', '\uFFA1', '\u2065']) {
      assert.equal(trimEdgeBlank(ch), ch, hex(ch));
    }
  });

  it('linear on long blank runs (no regex backtracking)', () => {
    const big = ' '.repeat(200_000) + 'x' + '\u200B'.repeat(200_000) + 'y';
    const t0 = Date.now();
    assert.equal(trimEdgeBlank(big), 'x' + '\u200B'.repeat(200_000) + 'y');
    assert.ok(Date.now() - t0 < 1000);
  });
});

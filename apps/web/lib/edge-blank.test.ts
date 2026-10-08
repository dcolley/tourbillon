import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { codePointLength, trimEdgeBlank } from './edge-blank';

const INVISIBLE = [
  '\u00AD', '\u034F', '\u061C', '\u115F', '\u1160', '\u180E', '\u200B', '\u200C', '\u200D', '\u200E', '\u200F',
  '\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064',
  '\u2066', '\u2067', '\u2068', '\u2069', '\u2800', '\u3164', '\uFEFF', '\uFFA0', '\u00A0', '\u3000',
];

describe('trimEdgeBlank (shared by approval reasons and agent titles)', () => {
  it('strips whitespace and invisible characters at both ends; middle kept', () => {
    assert.equal(trimEdgeBlank('  \u200BSplit it\uFEFF\n'), 'Split it');
    assert.equal(trimEdgeBlank('\u200E\u2800 Split\u00ADit \u3164\u202E'), 'Split\u00ADit');
    assert.equal(trimEdgeBlank('ok'), 'ok');
  });
  it('a value made only of invisible characters is empty', () => {
    for (const ch of INVISIBLE) assert.equal(trimEdgeBlank(ch), '', `U+${ch.codePointAt(0)!.toString(16)}`);
    assert.equal(trimEdgeBlank(INVISIBLE.join(' ')), '');
  });
  it('visible text, including non-Latin letters and emoji, is kept', () => {
    for (const s of ['é', '漢字', 'ハ', '한', '😀', 'a\u200Db']) assert.equal(trimEdgeBlank(s), s);
  });
});

describe('codePointLength', () => {
  it('counts code points, not UTF-16 units', () => {
    assert.equal(codePointLength('abc'), 3);
    assert.equal(codePointLength('😀😀'), 2);
    assert.equal('😀😀'.length, 4);
    assert.equal(codePointLength(''), 0);
  });
});

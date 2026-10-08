import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { capLines, compactComment, compactLines } from './compact';
import { WAKE_P1_COMMENT_CAP, WAKE_P2_COMMENT_CAP } from './constants';

describe('WC3 compactComment / compactLines', () => {
  it('drops empty, > quote and 💾 memory lines; strips ** __ `; collapses whitespace', () => {
    const body = [
      '**Headline**   with   `code` and __under__',
      '',
      '> quoted old text',
      '💾 Saved to memory: blah',
      '   middle    line   ',
      'Last: ask the Board',
    ].join('\n');
    assert.deepEqual(compactLines(body), ['Headline with code and under', 'middle line', 'Last: ask the Board']);
    assert.equal(compactComment(body).text, 'Headline with code and under / middle line / Last: ask the Board');
    assert.equal(compactComment(body).truncated, false);
  });

  it('over the cap keeps the first line, as much middle as fits, … and the last line; length <= cap', () => {
    const middle = Array.from({ length: 40 }, (_, i) => `middle sentence number ${i} with some words`);
    const body = ['FIRST LINE headline', ...middle, 'LAST LINE next step'].join('\n');
    for (const cap of [WAKE_P2_COMMENT_CAP, WAKE_P1_COMMENT_CAP, 120]) {
      const { text, truncated } = compactComment(body, cap);
      assert.ok(truncated);
      assert.ok(text.length <= cap, `${text.length} <= ${cap}`);
      assert.ok(text.startsWith('FIRST LINE headline / middle sentence number 0'), text);
      assert.ok(text.endsWith(' … / LAST LINE next step'), text);
      assert.ok(!text.includes('> '));
    }
  });

  it('a single long line is cut with … at the cap', () => {
    const { text } = capLines(['x '.repeat(3000).trim()], WAKE_P1_COMMENT_CAP);
    assert.ok(text.length <= WAKE_P1_COMMENT_CAP);
    assert.ok(text.endsWith('…'));
  });

  it('huge first and last lines still fit the cap (head and tail are shortened)', () => {
    const body = ['A'.repeat(2000), 'mid', 'Z'.repeat(2000)].join('\n');
    const { text } = compactComment(body, WAKE_P2_COMMENT_CAP);
    assert.ok(text.length <= WAKE_P2_COMMENT_CAP, String(text.length));
    assert.ok(text.startsWith('AAA'));
    assert.ok(text.includes(' … / ZZZ'));
  });

  it('is deterministic', () => {
    const body = 'one\n\ntwo **three**\n> four\nfive';
    assert.equal(compactComment(body, 10).text, compactComment(body, 10).text);
  });
});

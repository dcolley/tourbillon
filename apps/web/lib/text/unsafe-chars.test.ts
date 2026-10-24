/** Unsafe-character rules shared by label validation (assistant thread titles, UI-2/UI-2b). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findUnsafeChars } from './unsafe-chars';

const cp = (n: number) => String.fromCodePoint(n);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('findUnsafeChars', () => {
  it('control characters (C0, C1, line/paragraph separators)', () => {
    for (const n of [0x00, 0x09, 0x0a, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029]) assert.equal(findUnsafeChars(`a${cp(n)}b`), 'control', n.toString(16));
  });

  it('bidi controls: U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C', () => {
    for (const n of [...range(0x202a, 0x202e), ...range(0x2066, 0x2069), 0x200e, 0x200f, 0x061c]) {
      assert.equal(findUnsafeChars(`a${cp(n)}b`), 'bidi', n.toString(16));
    }
  });

  it('zero-width characters: U+200B–200D, U+2060, U+FEFF', () => {
    for (const n of [...range(0x200b, 0x200d), 0x2060, 0xfeff]) assert.equal(findUnsafeChars(`a${cp(n)}b`), 'zero-width', n.toString(16));
  });

  it('ordinary text, including non-Latin scripts and emoji, is fine', () => {
    for (const s of ['Quarterly plan', 'Plan für 2027', 'مرحبا بالعالم', 'שלום', '日本語のタイトル', 'Launch 🚀', 'a\u00A0b', 'x\u2027y', 'x\u2030y', 'x\u2065y', 'x\u206Ay']) {
      assert.equal(findUnsafeChars(s), null, JSON.stringify(s));
    }
  });
});

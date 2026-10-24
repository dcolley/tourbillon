/**
 * Characters that user-supplied labels (titles, names) should not contain: they are invisible or
 * change how surrounding text is displayed, so a label could look different from what it stores.
 * Pure and dependency-free, for both server validation and client-side checks.
 */

/** C0/C1 control characters and the Unicode line/paragraph separators. */
export const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/**
 * Bidirectional formatting controls: embeddings/overrides U+202A–202E, isolates U+2066–2069,
 * the LRM/RLM marks U+200E/U+200F and the Arabic letter mark U+061C.
 */
export const BIDI_CONTROL_CHARS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;

/** Zero-width characters: ZWSP/ZWNJ/ZWJ U+200B–200D, word joiner U+2060, BOM / ZWNBSP U+FEFF. */
export const ZERO_WIDTH_CHARS = /[\u200B-\u200D\u2060\uFEFF]/;

export type UnsafeCharKind = 'control' | 'bidi' | 'zero-width';

/** The first kind of unsafe character found in `s`, or null. */
export function findUnsafeChars(s: string): UnsafeCharKind | null {
  if (CONTROL_CHARS.test(s)) return 'control';
  if (BIDI_CONTROL_CHARS.test(s)) return 'bidi';
  if (ZERO_WIDTH_CHARS.test(s)) return 'zero-width';
  return null;
}

export const UNSAFE_CHAR_MESSAGES: Record<UnsafeCharKind, string> = {
  control: 'must not contain control characters',
  bidi: 'must not contain bidirectional text controls',
  'zero-width': 'must not contain zero-width characters',
};

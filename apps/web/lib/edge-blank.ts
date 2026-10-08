/**
 * One set of invisible characters, shared by approval decision reasons and agent title
 * validation (`trimEdgeBlank`): a value made only of these, or of whitespace, is empty.
 *
 * - whitespace (`\s`: spaces, tabs, line breaks, NBSP, U+2000–U+200A, U+3000, U+FEFF…);
 * - zero-width and joiners: U+200B–U+200D, U+2060–U+2064, U+034F;
 * - soft hyphen U+00AD and Mongolian vowel separator U+180E;
 * - direction marks: LRM/RLM U+200E/U+200F, ALM U+061C, embeddings/overrides U+202A–U+202E,
 *   isolates U+2066–U+2069;
 * - blank-looking fillers: Hangul U+115F, U+1160, U+3164, U+FFA0 and Braille blank U+2800.
 */
export const INVISIBLE_CHARS =
  '\\s\\u00AD\\u034F\\u061C\\u115F\\u1160\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u2800\\u3164\\uFEFF\\uFFA0';

const EDGE_BLANK_RE = new RegExp(`^[${INVISIBLE_CHARS}]+|[${INVISIBLE_CHARS}]+$`, 'g');

/** Trim whitespace and invisible characters (INVISIBLE_CHARS) from both ends. */
export function trimEdgeBlank(value: string): string {
  return value.replace(EDGE_BLANK_RE, '');
}

/** Length in code points (what JSON Schema `maxLength` counts), not UTF-16 units. */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * One shared blank/invisible set for agent titles and approval reasons
 * (#131's approval-reason.ts should import trimEdgeBlank from here, not keep its own regex).
 *
 * Stripped from both ends (a string made only of these is empty after the trim):
 * - JS `\s` whitespace (incl. U+00A0, U+1680, U+2000–U+200A, U+2028/9, U+202F, U+205F, U+3000, U+FEFF)
 * - zero-width: U+200B–U+200D, U+2060, U+FEFF
 * - U+00AD soft hyphen, U+034F combining grapheme joiner, U+061C Arabic letter mark,
 *   U+115F / U+3164 / U+FFA0 Hangul fillers, U+180E Mongolian vowel separator,
 *   U+200E / U+200F LRM / RLM, U+202A–U+202E bidi embeddings/overrides,
 *   U+2066–U+2069 bidi isolates, U+2800 braille blank.
 * Characters in the middle of a string are kept.
 */
export const EDGE_BLANK_CLASS =
  '\\s\\u00AD\\u034F\\u061C\\u115F\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\u2800\\u3164\\uFEFF\\uFFA0';

const EDGE_BLANK_CHAR_RE = new RegExp(`[${EDGE_BLANK_CLASS}]`);

/** True when the single UTF-16 unit `ch` is in the shared blank/invisible set. */
export function isEdgeBlankChar(ch: string): boolean {
  return ch.length === 1 && EDGE_BLANK_CHAR_RE.test(ch);
}

/**
 * Trim whitespace and invisible characters (EDGE_BLANK_CLASS) from both ends.
 * Linear scan (no `[...]+$` regex, which backtracks quadratically on long blank runs).
 */
export function trimEdgeBlank(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isEdgeBlankChar(value[start])) start++;
  while (end > start && isEdgeBlankChar(value[end - 1])) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

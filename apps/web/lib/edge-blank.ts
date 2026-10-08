/**
 * Edge trim shared by agent title validation and (when #131 lands) approval reasons:
 * strip whitespace and zero-width characters (U+200B–U+200D, U+2060, U+FEFF) from both ends.
 * A string that is only those characters is empty after this trim.
 */
const EDGE_BLANK_RE = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

/** Trim whitespace and zero-width characters from both ends. */
export function trimEdgeBlank(value: string): string {
  return value.replace(EDGE_BLANK_RE, '');
}

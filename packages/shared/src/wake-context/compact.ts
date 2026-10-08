import { WAKE_P1_COMMENT_CAP, WAKE_P2_COMMENT_CAP } from './constants';
import { cutAtWord, truncateEnd } from './format';

export const COMPACT_LINE_SEP = ' / ';
const MID_ELLIPSIS = ' … / ';

/**
 * WC3 AC2: drop empty lines, `>` quote lines and `💾` memory lines; strip `**`, `__` and
 * backticks; collapse whitespace. Returns the surviving lines (join with ` / `).
 */
export function compactLines(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    let s = raw.trim();
    if (!s || s.startsWith('>') || s.startsWith('💾')) continue;
    s = s.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * WC3 AC3: fit lines into `cap` chars. Over the cap: first line, as much of the middle as fits,
 * `…`, then the last line. Result length is always <= cap.
 */
export function capLines(lines: string[], cap: number): { text: string; truncated: boolean } {
  const joined = lines.join(COMPACT_LINE_SEP);
  if (joined.length <= cap) return { text: joined, truncated: false };
  if (lines.length === 1) return { text: truncateEnd(joined, cap), truncated: true };

  let tail = lines[lines.length - 1];
  const tailMax = Math.floor(cap * 0.4);
  if (tail.length > tailMax) tail = truncateEnd(tail, tailMax);
  let head = lines[0];
  const headMax = cap - tail.length - MID_ELLIPSIS.length;
  if (head.length > headMax) head = truncateEnd(head, Math.max(headMax, 0));

  const middle = lines.slice(1, -1).join(COMPACT_LINE_SEP);
  const room = cap - head.length - tail.length - COMPACT_LINE_SEP.length - MID_ELLIPSIS.length;
  if (middle && room >= 20) {
    const mid = cutAtWord(middle, room);
    if (mid) return { text: `${head}${COMPACT_LINE_SEP}${mid}${MID_ELLIPSIS}${tail}`, truncated: true };
  }
  const text = `${head}${MID_ELLIPSIS}${tail}`;
  return { text: text.length <= cap ? text : truncateEnd(text, cap), truncated: true };
}

export type WakeCommentTier = 1 | 2;

export function tierCap(tier: WakeCommentTier): number {
  return tier === 1 ? WAKE_P1_COMMENT_CAP : WAKE_P2_COMMENT_CAP;
}

/** Compact a comment body and fit it to `cap` (default: the P2 cap). */
export function compactComment(
  body: string,
  cap: number = WAKE_P2_COMMENT_CAP,
): { text: string; truncated: boolean } {
  return capLines(compactLines(body), cap);
}

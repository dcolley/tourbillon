const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

function sameUtcDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * Agent-facing short UTC time: `07:38Z` when on the same UTC day as `refIso`,
 * otherwise `Oct 7 21:04Z`. Deterministic (never reads the clock).
 */
export function formatWakeTime(iso: string, refIso?: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hm = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
  if (refIso) {
    const r = new Date(refIso);
    if (!Number.isNaN(r.getTime()) && sameUtcDay(d, r)) return hm;
  }
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hm}`;
}

/** `21:04:54Z` (UTC). */
export function formatWakeClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

const graphemes =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
/** Look-back window for re-syncing grapheme boundaries (longer clusters are pathological). */
const GRAPHEME_WINDOW = 64;

/**
 * S3: the longest prefix of `s` that is at most `max` UTF-16 units and ends on a grapheme
 * boundary, so a hard cut never splits a surrogate pair, an emoji ZWJ sequence, a flag or a
 * base + combining mark. Only a small window around the cut is segmented.
 */
export function sliceAtGrapheme(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  let end = max;
  if (graphemes) {
    const start = Math.max(0, max - GRAPHEME_WINDOW);
    const windowText = s.slice(start, Math.min(s.length, max + GRAPHEME_WINDOW));
    let boundary = start;
    for (const seg of graphemes.segment(windowText)) {
      const segEnd = start + seg.index + seg.segment.length;
      if (segEnd > max) break;
      boundary = segEnd;
    }
    // A window starting mid-cluster can only make us cut earlier, never mid-surrogate (below).
    end = boundary;
  }
  // Never leave a lone high surrogate.
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** Cut at a word boundary at or before `max` chars (no ellipsis); hard cuts are grapheme-safe. */
export function cutAtWord(s: string, max: number): string {
  if (max <= 0) return '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp >= Math.floor(max * 0.6) ? cut.slice(0, sp) : sliceAtGrapheme(s, max)).trimEnd();
}

/** Truncate to at most `max` chars, ending in `…` when cut. */
export function truncateEnd(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return '…'.slice(0, Math.max(max, 0));
  return `${cutAtWord(s, max - 1)}…`;
}

/** Candidate prefixes end within the first RULING_SCAN_CHARS of a note. */
export const RULING_SCAN_CHARS = 600;
const RULING_MEMO_MAX = 32;
/** The header renders 2–3 times per wake with mostly the same notes: compute once. */
const rulingMemo = new Map<string, { prefix: string; count: number } | null>();

/**
 * WC4 AC2: the shared, sentence-terminated prefix that 2+ Board decision notes start with.
 * Among candidate prefixes (each ends at `.`, `!` or `?` followed by whitespace or the end of the
 * note) the one saving the most text is chosen: length × (notes sharing it − 1); ties go to the
 * longer prefix. Returns null when no prefix of at least `minChars` is shared by 2+ notes.
 */
export function sharedRulingPrefix(
  notes: Array<string | null | undefined>,
  minChars = 40,
): { prefix: string; count: number } | null {
  const texts = notes.map((n) => (typeof n === 'string' ? n : '').trim()).filter(Boolean);
  if (texts.length < 2) return null;
  // Only the scanned head (+1 char, for the `p ` / `p\n` checks) affects the result.
  const memoKey = `${minChars}\u0000${texts.map((t) => t.slice(0, RULING_SCAN_CHARS + 1)).join('\u0001')}`;
  const memo = rulingMemo.get(memoKey);
  if (memo !== undefined) return memo;
  const candidates = new Set<string>();
  for (const t of texts) {
    // S2: a shared ruling is a lead sentence or two; only the head of each note is scanned.
    const scan = Math.min(t.length, RULING_SCAN_CHARS);
    for (let i = 0; i < scan; i++) {
      const ch = t[i];
      if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 === t.length || /\s/.test(t[i + 1]))) {
        if (i + 1 >= minChars) candidates.add(t.slice(0, i + 1));
      }
    }
  }
  let best: { prefix: string; count: number; score: number } | null = null;
  for (const p of [...candidates].sort()) {
    const count = texts.filter((t) => t === p || t.startsWith(`${p} `) || t.startsWith(`${p}\n`)).length;
    if (count < 2) continue;
    const score = p.length * (count - 1);
    if (!best || score > best.score || (score === best.score && p.length > best.prefix.length)) {
      best = { prefix: p, count, score };
    }
  }
  const result = best ? { prefix: best.prefix, count: best.count } : null;
  if (rulingMemo.size >= RULING_MEMO_MAX) rulingMemo.clear();
  rulingMemo.set(memoKey, result);
  return result;
}

/** A note with the shared prefix (and a leading `Decision:`) removed. */
export function noteRemainder(note: string | null | undefined, prefix: string | null): string {
  let t = (note ?? '').trim();
  if (prefix && t.startsWith(prefix)) t = t.slice(prefix.length).trim();
  return t.replace(/^Decision:\s*/i, '').replace(/\s+/g, ' ').trim();
}

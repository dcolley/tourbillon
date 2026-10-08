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
  const texts = notes.map((n) => (n ?? '').trim()).filter(Boolean);
  if (texts.length < 2) return null;
  const candidates = new Set<string>();
  for (const t of texts) {
    for (let i = 0; i < t.length; i++) {
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
  return best ? { prefix: best.prefix, count: best.count } : null;
}

/** A note with the shared prefix (and a leading `Decision:`) removed. */
export function noteRemainder(note: string | null | undefined, prefix: string | null): string {
  let t = (note ?? '').trim();
  if (prefix && t.startsWith(prefix)) t = t.slice(prefix.length).trim();
  return t.replace(/^Decision:\s*/i, '').replace(/\s+/g, ' ').trim();
}

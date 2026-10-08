import { WAKE_DEDUPE_JACCARD, WAKE_DEDUPE_SHINGLE } from './constants';

/** 5-word shingles over lower-cased word tokens. */
export function shingles(text: string, k: number = WAKE_DEDUPE_SHINGLE): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const out = new Set<string>();
  if (words.length === 0) return out;
  if (words.length < k) {
    out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + k <= words.length; i++) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

/** WC4 AC1: similarity strictly above 0.8. */
export function isNearDuplicate(a: Set<string>, b: Set<string>, threshold: number = WAKE_DEDUPE_JACCARD): boolean {
  return jaccard(a, b) > threshold;
}

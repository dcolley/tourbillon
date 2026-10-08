import type { WakeCommentTier } from './compact';

/** WC3 AC1: decision-bearing comment bodies. */
export const WAKE_DECISION_RE = /Board (answered|ruling|decided)|\bAPPROVED\b|\bREJECTED\b/;

/** WC3 AC4: a comment whose whole body is the "Checked out issue" notice. */
export function isCheckedOutNotice(body: string): boolean {
  return /^\W*Checked out issue\W*$/iu.test(body.trim());
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface ClassifyPriorityInput {
  authorType: 'user' | 'agent' | string;
  authorName: string;
  body: string;
  isNewest: boolean;
  /** The woken agent. */
  agentName?: string | null;
  agentUrlKey?: string | null;
}

/**
 * WC3 AC1. P1: user/Board author, the newest comment, decision-bearing comments, and other
 * authors mentioning the agent by name or `@urlKey`. Everything else is P2.
 */
export function classifyPriority(c: ClassifyPriorityInput): WakeCommentTier {
  if (c.authorType === 'user') return 1;
  if (c.isNewest) return 1;
  if (WAKE_DECISION_RE.test(c.body)) return 1;
  const name = c.agentName?.trim();
  const sameAuthor = name && c.authorName.trim().toLowerCase() === name.toLowerCase();
  if (!sameAuthor) {
    if (name && new RegExp(`(^|[^\\p{L}\\p{N}_])@?${escapeRe(name)}(?![\\p{L}\\p{N}_])`, 'iu').test(c.body)) return 1;
    const key = c.agentUrlKey?.trim();
    if (key && new RegExp(`@${escapeRe(key)}(?![\\p{L}\\p{N}_-])`, 'iu').test(c.body)) return 1;
  }
  return 2;
}

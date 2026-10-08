/** Wake-context (WC1–6) constants. Pure: no DB, no clock, no model calls. */

/** Live-state header budget (chars). */
export const WAKE_HEADER_MAX_CHARS = 2400;
/** Comment-section budget (chars), heading included. */
export const WAKE_COMMENTS_MAX_CHARS = 4500;
/** Soft cap on the whole wake message (chars). */
export const WAKE_TOTAL_SOFT_MAX_CHARS = 7500;
/**
 * Comment budget when the live context is off or failed (T1 only). Same 3,000 chars as the
 * pre-WC renderer so flag-off wakes only change in which comments are kept (newest, not oldest).
 */
export const WAKE_COMMENTS_T1_MAX_CHARS = 3000;

/** Per-comment caps by priority tier. */
export const WAKE_P1_COMMENT_CAP = 1200;
export const WAKE_P2_COMMENT_CAP = 420;

/** Comments fetched into the enqueue-time payload (the budget decides what is shown). */
export const DEFAULT_WAKE_MAX_COMMENTS = 20;

/** Header limits. */
export const WAKE_HEADER_MAX_APPROVAL_ROWS = 10;
export const WAKE_HEADER_MAX_OTHER_ISSUES = 10;
export const WAKE_HEADER_MAX_BLOCKERS = 10;
export const WAKE_HEADER_NOTE_CHARS = 110;

/** Near-duplicate threshold: 5-word-shingle Jaccard similarity strictly above this. */
export const WAKE_DEDUPE_JACCARD = 0.8;
export const WAKE_DEDUPE_SHINGLE = 5;

/** Context version recorded in contextSnapshot.wakeContext. */
export const WAKE_CONTEXT_VERSION = 1;

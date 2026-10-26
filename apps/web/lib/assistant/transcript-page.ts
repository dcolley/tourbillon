/**
 * CHAT-PAGE-1: the assistant chat transcript is paged. Opening a chat loads only the newest
 * ASSISTANT_TRANSCRIPT_PAGE_SIZE stored messages; "Load previous" fetches the page before the oldest
 * message shown. Paging is by query params on the existing messages route (no schema change):
 *
 *   GET /api/assistant/agents/[agentId]/threads/[threadId]/messages?limit=20            newest 20
 *   GET /api/assistant/agents/[agentId]/threads/[threadId]/messages?limit=20&before=<id> the 20 before <id>
 *
 * Both answer `{ messages, hasMore }` (oldest first). Without `limit` and `before` the route still
 * returns every message (`hasMore: false`), as before.
 *
 * Client-safe (no server imports): shared by the route, the thread service and the chat client.
 */

/** Messages per transcript page (open and each "Load previous"). */
export const ASSISTANT_TRANSCRIPT_PAGE_SIZE = 20;
/** Largest `limit` the messages route accepts. */
export const ASSISTANT_TRANSCRIPT_MAX_PAGE_SIZE = 100;
/** Longest `before` cursor accepted (stored message ids are uuids / short ids). */
const MAX_CURSOR_LENGTH = 200;

export interface TranscriptPageQuery {
  limit: number;
  /** Stored message id: return the messages strictly older than it. Null: the newest page. */
  before: string | null;
}

export type TranscriptPageQueryResult =
  | { ok: true; query: TranscriptPageQuery | null }
  | { ok: false; error: string };

/**
 * Reads `limit` / `before` from the messages route's query string. No paging params → `query: null`
 * (the whole transcript, as before). `before` without `limit` pages with the default size.
 */
export function parseTranscriptPageQuery(params: URLSearchParams): TranscriptPageQueryResult {
  const rawLimit = params.get('limit');
  const rawBefore = params.get('before');
  if (rawLimit === null && rawBefore === null) return { ok: true, query: null };
  let limit = ASSISTANT_TRANSCRIPT_PAGE_SIZE;
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) return { ok: false, error: 'limit must be a positive integer' };
    limit = Number(rawLimit);
    if (limit < 1 || limit > ASSISTANT_TRANSCRIPT_MAX_PAGE_SIZE) {
      return { ok: false, error: `limit must be between 1 and ${ASSISTANT_TRANSCRIPT_MAX_PAGE_SIZE}` };
    }
  }
  let before: string | null = null;
  if (rawBefore !== null) {
    const trimmed = rawBefore.trim();
    if (!trimmed || trimmed.length > MAX_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      return { ok: false, error: 'before must be a message id' };
    }
    before = trimmed;
  }
  return { ok: true, query: { limit, before } };
}

export interface TranscriptSlice<T> {
  /**
   * The window held enough messages to answer (or nothing older exists). When false the caller widens
   * the window (more of the newest messages) and slices again.
   */
  complete: boolean;
  /** The cursor is in the window (always true for the newest page). */
  found: boolean;
  /** The page, oldest first. */
  messages: T[];
  /** Older messages exist before this page. */
  hasMore: boolean;
}

/**
 * One page out of a window of the thread's newest messages (oldest first). `exhausted`: the window is
 * the whole thread (it returned fewer rows than asked for). A page is complete when the cursor is
 * found with at least one message before the page start (so `hasMore` is known), or the window is
 * the whole thread.
 */
export function sliceTranscriptPage<T extends { id: string }>(
  window: readonly T[],
  opts: { limit: number; before: string | null; exhausted: boolean },
): TranscriptSlice<T> {
  const end = opts.before === null ? window.length : window.findIndex((m) => m.id === opts.before);
  if (end < 0) return { complete: opts.exhausted, found: false, messages: [], hasMore: false };
  const start = Math.max(0, end - opts.limit);
  if (start === 0 && !opts.exhausted) {
    // The window starts inside (or right at) the page: older messages may exist beyond it.
    return { complete: false, found: true, messages: [], hasMore: false };
  }
  return { complete: true, found: true, messages: window.slice(start, end), hasMore: start > 0 };
}

/**
 * First window to read for a page: the newest page needs `limit + 1` (one extra row tells whether
 * older messages exist); a `before` page starts at twice that and doubles until the cursor is found.
 */
export function initialTranscriptWindow(query: TranscriptPageQuery): number {
  return query.before === null ? query.limit + 1 : Math.max(2 * query.limit + 1, 41);
}

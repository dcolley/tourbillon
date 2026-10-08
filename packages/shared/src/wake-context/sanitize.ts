import type { WakeCommentInput } from './comments';

/**
 * #122 follow-up (Test gate B1/S1): untrusted wake-payload comments made safe to render.
 *
 * B1: the payload comes from JSON (enqueue time) and must never make the renderer throw. A
 * non-array → []; null / non-object entries are dropped; body, authorName, authorType and
 * createdAt become strings ('' when missing). Unknown authorType falls back to 'agent' (the less
 * trusted tier: only 'user' is a Board/user author).
 */
export function sanitizeWakeComments(raw: unknown): WakeCommentInput[] {
  if (!Array.isArray(raw)) return [];
  const out: WakeCommentInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const c: WakeCommentInput = {
      body: asText(e.body),
      authorType: typeof e.authorType === 'string' && e.authorType ? e.authorType : 'agent',
      authorName: asText(e.authorName),
      createdAt: asText(e.createdAt),
    };
    if (typeof e.id === 'string') c.id = e.id;
    out.push(c);
  }
  return out;
}

/** String as-is; finite numbers / booleans stringified; anything else ''. */
export function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') return String(v);
  return '';
}

/** Angle brackets the system uses for `⟨now STATUS time⟩`, plus look-alikes. */
const MARKER_OPEN_RE = /[⟨〈〈《⦉⦑]/g;
const MARKER_CLOSE_RE = /[⟩〉〉》⦊⦒]/g;
const LIVE_STATE_RE = /LIVE[\s_\-·.]*STATE/gi;

/**
 * S1: only the system may emit `⟨now …⟩` annotations or a `LIVE STATE` block. In comment text the
 * marker brackets become plain parentheses and "LIVE STATE" (any case/spacing) becomes
 * "live-state (quoted)", so a forged annotation or header reads as what it is: comment text.
 */
export function neutraliseSystemMarkers(text: string): string {
  return text
    .replace(MARKER_OPEN_RE, '(')
    .replace(MARKER_CLOSE_RE, ')')
    .replace(LIVE_STATE_RE, 'live-state (quoted)');
}

/** Every line break / separator (\r, \n, U+0085, U+2028, U+2029, VT, FF). */
export const LINE_BREAK_RE = /\r\n|[\r\n\u000b\u000c\u0085\u2028\u2029]/g;

/** Single-line form: every whitespace run (line breaks included) → one space, trimmed. */
export function flattenInline(text: string): string {
  return text.replace(/[\s\u0085\u2028\u2029]+/g, ' ').trim();
}

export const CONTINUATION_INDENT = '    ';

/**
 * S1 (T1 / fallback layout): keep a comment's line structure but indent every continuation line,
 * so no comment line can start at column 0 and pose as a header or a new comment.
 */
export function indentContinuationLines(text: string): string {
  return text.replace(LINE_BREAK_RE, `\n${CONTINUATION_INDENT}`);
}

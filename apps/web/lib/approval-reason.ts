/**
 * Decision reason (approval note) rules, shared by the board form, the board JSON API and MCP
 * decide_approval:
 * - must be a string when given (null/undefined count as not given);
 * - trimmed (whitespace and invisible characters at either end);
 * - required to reject: empty, or only whitespace/invisible characters, is refused;
 * - at most REJECT_REASON_MAX_CHARS code points after trimming (as the MCP schema's maxLength
 *   counts): longer is refused, never cut.
 */
export const REJECT_REASON_MAX_CHARS = 2_000;

/**
 * Whitespace plus invisible characters: zero-width U+200B–U+200D, U+2060, U+FEFF; soft hyphen
 * U+00AD; U+180E; LRM/RLM U+200E/U+200F; ALM U+061C; bidi embeddings/overrides U+202A–U+202E and
 * isolates U+2066–U+2069; fillers U+115F, U+3164, U+FFA0, U+2800; U+034F.
 * TODO: import trimEdgeBlank from the shared lib/edge-blank helper (#142) once it is on the merge
 * base, and drop this copy; the set here is meant to stay identical to it until then.
 */
const EDGE_BLANK_CLASS =
  '\\s\\u00AD\\u034F\\u061C\\u115F\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\u2800\\u3164\\uFEFF\\uFFA0';

const EDGE_BLANK_CHAR_RE = new RegExp(`[${EDGE_BLANK_CLASS}]`);

/** True when the single UTF-16 unit `ch` is in the shared blank/invisible set. */
function isEdgeBlankChar(ch: string): boolean {
  return ch.length === 1 && EDGE_BLANK_CHAR_RE.test(ch);
}

/**
 * Trim whitespace and invisible characters from both ends.
 * Linear scan (no `[...]+$` regex, which slows sharply on long blank runs).
 */
function trimEdgeBlank(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isEdgeBlankChar(value[start])) start++;
  while (end > start && isEdgeBlankChar(value[end - 1])) end--;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

/** Length in code points (what the MCP schema's maxLength counts), not UTF-16 units. */
function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

export type DecisionReasonError = 'reason_not_string' | 'reason_required' | 'reason_too_long';

export type DecisionReasonResult =
  | { ok: true; reason: string | undefined }
  | { ok: false; code: DecisionReasonError; message: string };

export const DECISION_REASON_MESSAGES: Record<DecisionReasonError, string> = {
  reason_not_string: 'reason must be a string',
  reason_required: 'A reason is required to reject (it is sent to the requesting agent as Board feedback)',
  reason_too_long: `reason must be at most ${REJECT_REASON_MAX_CHARS} characters`,
};

const fail = (code: DecisionReasonError): DecisionReasonResult => ({ ok: false, code, message: DECISION_REASON_MESSAGES[code] });

/** Validate and normalise a decision reason. `reason` is the trimmed text, or undefined if none. */
export function checkDecisionReason(decision: 'approved' | 'rejected', raw: unknown): DecisionReasonResult {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') return fail('reason_not_string');
  const trimmed = typeof raw === 'string' ? trimEdgeBlank(raw) : '';
  if (!trimmed) return decision === 'rejected' ? fail('reason_required') : { ok: true, reason: undefined };
  if (codePointLength(trimmed) > REJECT_REASON_MAX_CHARS) return fail('reason_too_long');
  return { ok: true, reason: trimmed };
}

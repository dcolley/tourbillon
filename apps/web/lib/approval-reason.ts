/**
 * Decision reason (approval note) rules, shared by the board form, the board JSON API and MCP
 * decide_approval:
 * - must be a string when given (null/undefined count as not given);
 * - trimmed (whitespace and zero-width characters at either end);
 * - required to reject: empty, whitespace-only or zero-width-only is refused;
 * - at most REJECT_REASON_MAX_CHARS characters after trimming: longer is refused, never cut.
 */
export const REJECT_REASON_MAX_CHARS = 2_000;

/** Whitespace plus U+200B–U+200D, U+2060 and U+FEFF. */
const EDGE_BLANK_RE = /^[\s\u200B-\u200D\u2060\uFEFF]+|[\s\u200B-\u200D\u2060\uFEFF]+$/g;

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
  const trimmed = typeof raw === 'string' ? raw.replace(EDGE_BLANK_RE, '') : '';
  if (!trimmed) return decision === 'rejected' ? fail('reason_required') : { ok: true, reason: undefined };
  if (trimmed.length > REJECT_REASON_MAX_CHARS) return fail('reason_too_long');
  return { ok: true, reason: trimmed };
}

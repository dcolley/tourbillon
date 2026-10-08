/**
 * Decision reason (approval note) rules, shared by the board form, the board JSON API and MCP
 * decide_approval:
 * - must be a string when given (null/undefined count as not given);
 * - trimmed (whitespace and invisible characters at either end; one shared set, ./edge-blank);
 * - required to reject: empty, or only whitespace/invisible characters, is refused;
 * - at most REJECT_REASON_MAX_CHARS code points after trimming (as the MCP schema's maxLength
 *   counts): longer is refused, never cut.
 */
import { codePointLength, trimEdgeBlank } from './edge-blank';

export const REJECT_REASON_MAX_CHARS = 2_000;

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

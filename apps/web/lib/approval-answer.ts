/**
 * APR-2: turn a submitted decision into a stored outcome + response fields, with the shared
 * validator. Used by the Board decide route and MCP `decide_approval`.
 *
 * Accepted input:
 * - legacy `decision`: approved | rejected (binary questions and legacy approvals only)
 * - `status`: answered | declined, with `value` (answered) and optional `reason`
 * A binary answer is stored as approved / reject → rejected; any other answer as `answered`.
 */
import type { Approval } from '@tourbillon/db';
import type { ApprovalOutcomeStatus } from '@tourbillon/shared';
import { validateHitlAnswer, type HitlFieldError } from '@tourbillon/shared/hitl';
import { hitlRequestOf } from './hitl-host';

export interface DecisionSubmission {
  decision?: unknown;
  status?: unknown;
  value?: unknown;
  reason?: unknown;
  note?: unknown;
}

export type ResolvedDecision =
  | { ok: true; outcome: ApprovalOutcomeStatus; value?: unknown; reason?: string; note?: string }
  | { ok: false; status: 400 | 422; error: string; fields?: HitlFieldError[] };

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

export function resolveDecision(
  approval: Pick<Approval, 'hitlRequest'>,
  input: DecisionSubmission,
  opts: { openedRefs?: ReadonlySet<string> } = {},
): ResolvedDecision {
  const request = hitlRequestOf(approval);
  const answerType = request?.answerType ?? 'binary';
  const reason = str(input.reason) ?? str(input.note);
  const note = str(input.note) ?? str(input.reason);

  let status: 'answered' | 'declined';
  let value: unknown;
  if (input.status === 'declined') {
    status = 'declined';
    if (input.value !== undefined && input.value !== '') {
      return { ok: false, status: 422, error: 'Invalid answer', fields: [{ field: '/value', message: 'value must be absent when declining' }] };
    }
  } else if (input.status === undefined || input.status === 'answered' || input.status === '') {
    status = 'answered';
    if (input.value !== undefined && input.value !== '') value = input.value;
    else if (input.decision === 'approved' || input.decision === 'rejected') {
      if (answerType !== 'binary') {
        return {
          ok: false,
          status: 422,
          error: 'Invalid answer',
          fields: [{ field: '/value', message: `this approval asks a ${answerType} question; send value`, hint: 'Send status and value.' }],
        };
      }
      value = input.decision === 'approved' ? 'approve' : 'reject';
    } else if (input.decision !== undefined && input.decision !== '') {
      return { ok: false, status: 400, error: 'decision must be approved or rejected' };
    } else {
      return { ok: false, status: 400, error: 'decision must be approved or rejected' };
    }
  } else {
    return { ok: false, status: 422, error: 'Invalid answer', fields: [{ field: '/status', message: 'status must be "answered" or "declined"' }] };
  }

  if (status === 'answered' && answerType === 'secret') {
    return {
      ok: false,
      status: 422,
      error: 'Invalid answer',
      fields: [
        {
          field: '/value',
          message: 'secret answers must be encrypted on the reviewer device, which this host does not support yet',
          hint: 'Decline instead.',
        },
      ],
    };
  }

  if (request) {
    const fields = validateHitlAnswer(request, { status, value, reason }, { openedRefs: opts.openedRefs });
    if (fields.length > 0) return { ok: false, status: 422, error: 'Invalid answer', fields };
  } else if (status === 'answered' && value !== 'approve' && value !== 'reject') {
    return { ok: false, status: 422, error: 'Invalid answer', fields: [{ field: '/value', message: 'value must be "approve" or "reject"' }] };
  }

  const outcome: ApprovalOutcomeStatus =
    status === 'declined' ? 'declined' : answerType === 'binary' ? (value === 'approve' ? 'approved' : 'rejected') : 'answered';
  return { ok: true, outcome, ...(status === 'answered' ? { value } : {}), reason, note };
}

/** Form posts carry strings; a number question's value is parsed once here (never trimmed). */
export function formValueFor(answerType: string, raw: string[]): unknown {
  if (answerType === 'multi') return raw;
  const v = raw[0];
  if (v === undefined) return undefined;
  if (answerType === 'number') return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? Number(v) : v;
  return v;
}

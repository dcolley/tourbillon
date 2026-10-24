/**
 * APR-2: the approval shape returned by the agent approval APIs. Adds the hitl request, response,
 * deadline and presentedAt, and never returns a token: `hitlyResumeToken` is removed from
 * `payload`, and `/o/` link tokens are never part of an approval.
 */
import type { Approval } from '@tourbillon/db';

const TOKEN_KEYS = new Set(['hitlyResumeToken']);

export function publicApprovalPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>).filter(([k]) => !TOKEN_KEYS.has(k)));
}

export function approvalForApi(approval: Approval) {
  return {
    id: approval.id,
    companyId: approval.companyId,
    type: approval.type,
    status: approval.status,
    requestedByAgentId: approval.requestedByAgentId,
    decidedByUserId: approval.decidedByUserId,
    issueIds: approval.issueIds,
    payload: publicApprovalPayload(approval.payload),
    note: approval.note,
    decidedAt: approval.decidedAt,
    hitlyApprovalId: approval.hitlyApprovalId,
    hitlyError: approval.hitlyError,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    hitlRequest: approval.hitlRequest ?? null,
    hitlResponse: approval.hitlResponse ?? null,
    idempotencyKey: approval.idempotencyKey ?? null,
    deadline: approval.deadline ?? null,
    presentedAt: approval.presentedAt ?? null,
  };
}

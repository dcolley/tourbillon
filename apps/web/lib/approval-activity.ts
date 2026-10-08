/**
 * activity_log rows for approval lifecycle events (PM decision on #130): every path that creates
 * or decides an approval writes exactly one `approval.created` / `approval.decided` row with the
 * actor that path has and the note. Built here so every write site uses the same shape.
 */
import type { NewActivityLogEntry } from '@tourbillon/db';

export type ApprovalActorType = 'agent' | 'user' | 'system';

export interface ApprovalActor {
  type: ApprovalActorType;
  id: string;
  name: string | null;
}

/** Actors for the decide paths that have no individual user identity. */
export const APPROVAL_ACTORS = {
  /** Board UI form and the board JSON API (board session or board JWT; one shared operator identity). */
  board: { type: 'user', id: 'board', name: 'Board' },
  /** MCP `decide_approval` (board company token). Matches approvals.decided_by_user_id = 'mcp'. */
  mcp: { type: 'user', id: 'mcp', name: 'Board (via MCP)' },
  /** HITLy resume callback. Matches approvals.decided_by_user_id = 'hitly'. */
  hitly: { type: 'system', id: 'hitly', name: 'HITLy' },
} as const satisfies Record<string, ApprovalActor>;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Null-safe actor: a missing id becomes 'unknown' (activity_log.actor_id is NOT NULL). */
function actorFields(actor: Partial<ApprovalActor> | null | undefined) {
  return {
    actorType: (actor?.type ?? 'system') as ApprovalActorType,
    actorId: text(actor?.id) ?? 'unknown',
    actorName: text(actor?.name),
  };
}

export function approvalCreatedActivity(input: {
  approval: { id: string; companyId: string; type: string; issueIds?: string[] | null; payload?: unknown };
  actor: Partial<ApprovalActor> | null | undefined;
}): NewActivityLogEntry {
  const { approval } = input;
  const payload =
    approval.payload && typeof approval.payload === 'object' && !Array.isArray(approval.payload)
      ? (approval.payload as Record<string, unknown>)
      : {};
  return {
    companyId: approval.companyId,
    ...actorFields(input.actor),
    action: 'approval.created',
    entityType: 'approval',
    entityId: approval.id,
    details: {
      approvalId: approval.id,
      type: approval.type,
      status: 'pending',
      title: text(payload.title),
      // For `created`, the note is the request summary (or none).
      note: text(payload.summary),
      issueIds: approval.issueIds ?? [],
    },
  };
}

export function approvalDecidedActivity(input: {
  approval: { id: string; companyId: string; type: string; issueIds?: string[] | null };
  decision: 'approved' | 'rejected';
  note: string | null | undefined;
  actor: Partial<ApprovalActor> | null | undefined;
}): NewActivityLogEntry {
  const { approval } = input;
  return {
    companyId: approval.companyId,
    ...actorFields(input.actor),
    action: 'approval.decided',
    entityType: 'approval',
    entityId: approval.id,
    details: {
      approvalId: approval.id,
      type: approval.type,
      decision: input.decision,
      status: input.decision,
      note: text(input.note),
      issueIds: approval.issueIds ?? [],
    },
  };
}

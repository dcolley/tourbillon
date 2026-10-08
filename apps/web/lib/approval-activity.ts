/**
 * activity_log rows for approval lifecycle events (PM decision on #130): every path that creates
 * or decides an approval writes exactly one `approval.created` / `approval.decided` row with the
 * actor that path has and the note. Built here so every write site uses the same shape.
 *
 * Stored text (title, notes) goes through #130's approval scrubber (lib/approval-redaction)
 * before it is written: values under credential keys in the approval payload (e.g. the HITLy
 * resume token), credential-looking assignments, Bearer/Basic, URL query tokens and known token
 * shapes never reach activity_log. Details carry no payload fields beyond the title.
 */
import type { NewActivityLogEntry } from '@tourbillon/db';
import { collectValuesUnderSensitiveKeys, createApprovalRedactor } from './approval-redaction';

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

/**
 * Scrubber for text stored in activity rows about one approval (lifecycle rows and the
 * `issue.updated` rows a decide writes). Known values: strings under credential keys in the
 * approval payload. Returns trimmed scrubbed text, or null for blank input.
 */
export function approvalActivityScrubber(payload: unknown): (v: unknown) => string | null {
  const redact = createApprovalRedactor(collectValuesUnderSensitiveKeys(payload));
  return (v) => {
    const t = text(v);
    return t === null ? null : redact.text(t);
  };
}

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
  const scrub = approvalActivityScrubber(payload);
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
      title: scrub(payload.title),
      // For `created`, the note is the request summary (or none).
      note: scrub(payload.summary),
      issueIds: approval.issueIds ?? [],
    },
  };
}

export function approvalDecidedActivity(input: {
  /** `payload` (when given) supplies known secret values to scrub from the note. */
  approval: { id: string; companyId: string; type: string; issueIds?: string[] | null; payload?: unknown };
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
      note: approvalActivityScrubber(approval.payload)(input.note),
      issueIds: approval.issueIds ?? [],
    },
  };
}

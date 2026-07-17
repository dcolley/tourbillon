import { BOARD_ASSIGNEE_SELECT_VALUE, BOARD_USER_ID } from './constants';

export class IssueAssigneeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueAssigneeError';
  }
}

export interface IssueAssigneeFields {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function coerceUserId(raw: string | null): string | null {
  if (!raw) return null;
  if (raw === BOARD_ASSIGNEE_SELECT_VALUE || raw === BOARD_USER_ID) {
    return BOARD_USER_ID;
  }
  if (raw !== BOARD_USER_ID) {
    throw new IssueAssigneeError(
      `Invalid assigneeUserId "${raw}". Only "${BOARD_USER_ID}" is supported.`,
    );
  }
  return BOARD_USER_ID;
}

/**
 * Resolve exclusive assignees for create/update.
 * Undefined fields mean “not provided” (keep current on update; null on create).
 */
export function resolveIssueAssignees(opts: {
  currentAgentId?: string | null;
  currentUserId?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
}): IssueAssigneeFields {
  const agentInRequest = opts.assigneeAgentId !== undefined;
  const userInRequest = opts.assigneeUserId !== undefined;

  if (!agentInRequest && !userInRequest) {
    return {
      assigneeAgentId: opts.currentAgentId ?? null,
      assigneeUserId: opts.currentUserId ?? null,
    };
  }

  let nextAgent = agentInRequest
    ? emptyToNull(opts.assigneeAgentId)
    : (opts.currentAgentId ?? null);
  let nextUser = userInRequest
    ? coerceUserId(emptyToNull(opts.assigneeUserId))
    : (opts.currentUserId ?? null);

  if (agentInRequest && userInRequest) {
    if (nextAgent && nextUser) {
      throw new IssueAssigneeError(
        'Set either assigneeAgentId or assigneeUserId, not both.',
      );
    }
    // Both provided and exclusive — already consistent when one is null.
    return { assigneeAgentId: nextAgent, assigneeUserId: nextUser };
  }

  if (agentInRequest) {
    // Setting or clearing agent clears user (exclusive ownership).
    nextUser = nextAgent ? null : null;
    return { assigneeAgentId: nextAgent, assigneeUserId: null };
  }

  // userInRequest only
  nextAgent = nextUser ? null : null;
  return { assigneeAgentId: null, assigneeUserId: nextUser };
}

/** Whether a stored assigneeUserId is the board. */
export function isBoardAssignee(assigneeUserId: string | null | undefined): boolean {
  return assigneeUserId === BOARD_USER_ID;
}

/**
 * Parse dashboard form assignee select: empty / agent id / board sentinel.
 */
export function assigneesFromFormSelect(
  selectValue: string | null | undefined,
): IssueAssigneeFields {
  const raw = selectValue?.trim() || '';
  if (!raw) {
    return { assigneeAgentId: null, assigneeUserId: null };
  }
  if (raw === BOARD_ASSIGNEE_SELECT_VALUE || raw === BOARD_USER_ID) {
    return { assigneeAgentId: null, assigneeUserId: BOARD_USER_ID };
  }
  return { assigneeAgentId: raw, assigneeUserId: null };
}

/** Value to show in assignee &lt;select&gt; for an issue. */
export function formSelectValueFromAssignees(
  assigneeAgentId: string | null | undefined,
  assigneeUserId: string | null | undefined,
): string {
  if (isBoardAssignee(assigneeUserId)) return BOARD_ASSIGNEE_SELECT_VALUE;
  return assigneeAgentId ?? '';
}

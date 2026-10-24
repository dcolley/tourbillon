/**
 * APR-FIX: what happens to the issues linked to an approval once it is decided.
 *
 * Pure logic only (no db import) so every decide path shares one rule and it can be unit tested:
 * - Board decide (`/api/approvals/:id/decide`)
 * - HITLy callback (`/api/approvals/:id/hitly-resume`)
 * - MCP `decide_approval`
 *
 * The db-bound side (load rows, write status, wake agents) lives in `approval-restore-db.ts`.
 */
import type { IssueStatus } from '@tourbillon/db';

export type ApprovalDecision = 'approved' | 'rejected';

const ISSUE_STATUSES: readonly IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
];

/**
 * Dependency states that no longer hold an issue back. A `blocked_by_issue_ids` entry whose issue
 * is in any other status is unfinished. `done` and `cancelled` are the two closed states of an
 * issue (the only statuses with no further work); a blocker id that does not resolve to an issue
 * in the same company is ignored.
 */
export const FINISHED_ISSUE_STATUSES: readonly IssueStatus[] = ['done', 'cancelled'];

export function isUnfinishedIssueStatus(status: string): boolean {
  return !(FINISHED_ISSUE_STATUSES as readonly string[]).includes(status);
}

function asIssueStatus(value: unknown): IssueStatus | undefined {
  return typeof value === 'string' && (ISSUE_STATUSES as readonly string[]).includes(value)
    ? (value as IssueStatus)
    : undefined;
}

/**
 * Status an issue gets when its approval is decided.
 * - already `done` / `cancelled`: kept as-is (the issue was closed while the approval was pending).
 * - rejected: `blocked`.
 * - approved with unfinished dependencies: `blocked`, whatever status was saved.
 * - approved otherwise: the status saved when the approval was created (or the current one if none
 *   was saved); a saved/current `blocked` becomes `todo`.
 */
export function resolveRestoreStatus(input: {
  decision: ApprovalDecision;
  priorStatus: unknown;
  currentStatus: IssueStatus;
  unfinishedBlockerCount: number;
}): IssueStatus {
  if (!isUnfinishedIssueStatus(input.currentStatus)) return input.currentStatus;
  if (input.decision !== 'approved') return 'blocked';
  if (input.unfinishedBlockerCount > 0) return 'blocked';
  const candidate = asIssueStatus(input.priorStatus) ?? input.currentStatus;
  return candidate === 'blocked' ? 'todo' : candidate;
}

export interface LinkedIssueForRestore {
  id: string;
  identifier: string | null;
  status: IssueStatus;
  boardApprovalId: string | null;
  blockedByIssueIds: string[] | null;
  assigneeAgentId: string | null;
}

export interface DependencyRef {
  id: string;
  identifier: string | null;
  status: IssueStatus;
}

export interface IssueRef {
  id: string;
  identifier: string | null;
}

export interface IssueRestoreOutcome {
  issueId: string;
  identifier: string | null;
  /** false when the issue is held by a different approval and was left untouched. */
  restored: boolean;
  status: IssueStatus;
  /** Unfinished dependencies that keep the issue blocked (approved decisions only). */
  remainingBlockers: IssueRef[];
  assigneeAgentId: string | null;
  /** true when the issue was already done/cancelled: halt cleared, status left alone. */
  alreadyClosed?: boolean;
}

/** Ids of every dependency referenced by the linked issues (deduped, self-references dropped). */
export function dependencyIdsOf(linked: LinkedIssueForRestore[]): string[] {
  const ids = new Set<string>();
  for (const issue of linked) {
    for (const id of issue.blockedByIssueIds ?? []) {
      if (id && id !== issue.id) ids.add(id);
    }
  }
  return [...ids];
}

export function planApprovalRestore(input: {
  approvalId: string;
  decision: ApprovalDecision;
  priorStatuses: Record<string, unknown> | null | undefined;
  linked: LinkedIssueForRestore[];
  /** Rows for `dependencyIdsOf(linked)`, already scoped to the approval's company. */
  dependencies: DependencyRef[];
}): IssueRestoreOutcome[] {
  const priorStatuses = input.priorStatuses ?? {};
  const deps = new Map(input.dependencies.map((d) => [d.id, d]));

  return input.linked.map((issue) => {
    // Only clear the halt for issues still bound to this approval.
    if (issue.boardApprovalId && issue.boardApprovalId !== input.approvalId) {
      return {
        issueId: issue.id,
        identifier: issue.identifier,
        restored: false,
        status: issue.status,
        remainingBlockers: [],
        assigneeAgentId: issue.assigneeAgentId,
      };
    }

    const unfinished: IssueRef[] = [];
    if (input.decision === 'approved') {
      const seen = new Set<string>();
      for (const id of issue.blockedByIssueIds ?? []) {
        if (!id || id === issue.id || seen.has(id)) continue;
        seen.add(id);
        const dep = deps.get(id);
        if (dep && isUnfinishedIssueStatus(dep.status)) {
          unfinished.push({ id: dep.id, identifier: dep.identifier });
        }
      }
    }

    const status = resolveRestoreStatus({
      decision: input.decision,
      priorStatus: priorStatuses[issue.id],
      currentStatus: issue.status,
      unfinishedBlockerCount: unfinished.length,
    });

    return {
      issueId: issue.id,
      identifier: issue.identifier,
      restored: true,
      status,
      remainingBlockers: status === 'blocked' ? unfinished : [],
      assigneeAgentId: issue.assigneeAgentId,
      alreadyClosed: !isUnfinishedIssueStatus(issue.status),
    };
  });
}

const issueKey = (ref: IssueRef) => ref.identifier || ref.id;

/** Comment posted on one linked issue: states what actually happened to that issue. */
export function formatApprovalDecisionComment(input: {
  source: string;
  decision: ApprovalDecision;
  title: string;
  note?: string | null;
  outcome: IssueRestoreOutcome | undefined;
}): string {
  const label = input.decision === 'approved' ? 'Approved' : 'Rejected';
  const lines: Array<string | null> = [
    `**${input.source} ${label}:** ${input.title}`,
    input.note ? `Note: ${input.note}` : null,
  ];
  const outcome = input.outcome;

  if (outcome?.restored && outcome.alreadyClosed) {
    lines.push(`Status unchanged (${outcome.status}): this issue was already closed.`);
  } else if (input.decision === 'rejected') {
    lines.push('This issue remains blocked. Triage, revise the request, or cancel as appropriate.');
  } else if (!outcome) {
    lines.push('Status unchanged.');
  } else if (!outcome.restored) {
    lines.push(`Status unchanged (${outcome.status}): this issue is held by another approval.`);
  } else if (outcome.remainingBlockers.length > 0) {
    const keys = outcome.remainingBlockers.map(issueKey).join(', ');
    lines.push(
      `Still blocked by ${keys} (unfinished ${outcome.remainingBlockers.length === 1 ? 'dependency' : 'dependencies'}). ` +
        'Move it on once they are done or cancelled.',
    );
  } else {
    lines.push(`Status restored to ${outcome.status}. Continue work if still assigned.`);
  }

  return lines.filter(Boolean).join('\n');
}

export interface ApprovalWakeTarget {
  agentId: string;
  role: 'requester' | 'assignee';
  /** Linked issue ids for this wake; the first one becomes the wake's task. */
  issueIds: string[];
}

/**
 * Who to wake after a decision: the requesting agent (all linked issues), plus, for approvals, the
 * assignee of every issue that is free to move again (restored, still open and not blocked). One wake
 * per agent: an assignee who is also the requester is woken once, as requester.
 */
export function planApprovalWakes(input: {
  decision: ApprovalDecision;
  requesterAgentId: string | null | undefined;
  issueIds: string[];
  outcomes: IssueRestoreOutcome[];
}): ApprovalWakeTarget[] {
  const targets: ApprovalWakeTarget[] = [];
  if (input.requesterAgentId) {
    targets.push({ agentId: input.requesterAgentId, role: 'requester', issueIds: [...input.issueIds] });
  }
  if (input.decision !== 'approved') return targets;

  const byAssignee = new Map<string, string[]>();
  for (const o of input.outcomes) {
    if (!o.restored || o.alreadyClosed || o.status === 'blocked' || !o.assigneeAgentId) continue;
    if (o.assigneeAgentId === input.requesterAgentId) continue;
    const list = byAssignee.get(o.assigneeAgentId) ?? [];
    list.push(o.issueId);
    byAssignee.set(o.assigneeAgentId, list);
  }
  for (const [agentId, issueIds] of byAssignee) targets.push({ agentId, role: 'assignee', issueIds });
  return targets;
}

/** Why a wake did not go out. Coarse categories only: no scheduler text is copied. */
export type WakeSkipReason =
  | 'paused'
  | 'archived'
  | 'pending_approval'
  | 'agent_not_found'
  | 'company_inactive'
  | 'over_budget'
  | 'skipped';

export function wakeSkipReasonFromAgentStatus(status: string | null | undefined): WakeSkipReason | null {
  if (status === 'active') return null;
  if (status === 'paused' || status === 'archived' || status === 'pending_approval') return status;
  return status ? 'skipped' : 'agent_not_found';
}

/** Map the scheduler's skip text onto a category. */
export function wakeSkipReasonFromScheduler(text: string | null | undefined): WakeSkipReason {
  const t = (text ?? '').toLowerCase();
  const agent = /agent status (\w+)/.exec(t);
  if (agent) return wakeSkipReasonFromAgentStatus(agent[1]) ?? 'skipped';
  if (t.includes('company status')) return 'company_inactive';
  if (t.includes('budget')) return 'over_budget';
  return 'skipped';
}

const SKIP_REASON_TEXT: Record<WakeSkipReason, string> = {
  paused: 'paused',
  archived: 'archived',
  pending_approval: 'pending approval',
  agent_not_found: 'no longer in this company',
  company_inactive: 'in a company that is not active',
  over_budget: 'over its token budget',
  skipped: 'not runnable right now',
};

/** Issue activity text when a post-decision wake was skipped. */
export function formatWakeSkippedComment(input: {
  role: ApprovalWakeTarget['role'];
  agentName: string | null | undefined;
  reason: WakeSkipReason;
}): string {
  const who = input.agentName ? `agent ${input.agentName}` : 'agent';
  const why = SKIP_REASON_TEXT[input.reason];
  return input.role === 'assignee'
    ? `Wake skipped: assignee ${who} is ${why}, so nobody will pick this issue up until the agent is resumed or the issue is reassigned.`
    : `Wake skipped: requesting ${who} is ${why} and was not told about this decision.`;
}

/** Issue activity text when a post-decision wake could not be delivered (scheduler error). */
export function formatWakeFailedComment(input: {
  role: ApprovalWakeTarget['role'];
  agentName: string | null | undefined;
}): string {
  const who = input.agentName ? `agent ${input.agentName}` : 'agent';
  return input.role === 'assignee'
    ? `Wake not delivered: the scheduler did not take the wake for assignee ${who}, so nobody will pick this issue up until the agent is woken again.`
    : `Wake not delivered: the scheduler did not take the wake for requesting ${who}, so it was not told about this decision.`;
}

/**
 * APR-FIX: db side of an approval decision, shared by the Board decide route, the HITLy callback
 * and MCP `decide_approval`. Rules live in `approval-restore.ts`.
 */
import { db, issues, agents, activityLog } from '@tourbillon/db';
import { and, eq, inArray } from 'drizzle-orm';
import { enqueueApprovalWake } from '@/lib/wake-client';
import type { ApprovalOutcomeStatus, ApprovalWakeResponse } from '@tourbillon/shared';
import {
  dependencyIdsOf,
  formatWakeFailedComment,
  formatWakeSkippedComment,
  planApprovalRestore,
  planApprovalWakes,
  wakeSkipReasonFromAgentStatus,
  wakeSkipReasonFromScheduler,
  type ApprovalDecision,
  type ApprovalWakeTarget,
  type IssueRestoreOutcome,
  type LinkedIssueForRestore,
  type WakeSkipReason,
} from './approval-restore';

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface DecisionActor {
  /** activity_log.actor_id, e.g. 'board', 'hitly', 'mcp'. */
  actorId: string;
  actorName: string;
}

/**
 * Restore every issue linked to a decided approval, inside the caller's transaction.
 * Company-scoped reads and writes. When `activityActor` is set, one `issue.updated` entry is
 * written per restored issue (`applyApprovalDecision` always sets it, for every path).
 */
export async function restoreLinkedIssuesForDecision(
  tx: DbTransaction,
  input: {
    companyId: string;
    approvalId: string;
    decision: ApprovalDecision;
    priorStatuses: Record<string, unknown> | null | undefined;
    issueIds: string[];
    note?: string;
    activityActor?: DecisionActor;
  },
): Promise<IssueRestoreOutcome[]> {
  if (input.issueIds.length === 0) return [];

  const linked = (await tx
    .select({
      id: issues.id,
      identifier: issues.identifier,
      status: issues.status,
      boardApprovalId: issues.boardApprovalId,
      blockedByIssueIds: issues.blockedByIssueIds,
      assigneeAgentId: issues.assigneeAgentId,
    })
    .from(issues)
    .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, input.issueIds)))) as LinkedIssueForRestore[];

  const depIds = input.decision === 'approved' ? dependencyIdsOf(linked) : [];
  const dependencies =
    depIds.length > 0
      ? await tx
          .select({ id: issues.id, identifier: issues.identifier, status: issues.status })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, depIds)))
      : [];

  const outcomes = planApprovalRestore({
    approvalId: input.approvalId,
    decision: input.decision,
    priorStatuses: input.priorStatuses,
    linked,
    dependencies,
  });

  const now = new Date();
  for (const outcome of outcomes) {
    if (!outcome.restored) continue;

    await tx
      .update(issues)
      .set({ status: outcome.status, boardApprovalId: null, updatedAt: now })
      .where(and(eq(issues.id, outcome.issueId), eq(issues.companyId, input.companyId)));

    if (input.activityActor) {
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: 'system',
        actorId: input.activityActor.actorId,
        actorName: input.activityActor.actorName,
        action: 'issue.updated',
        entityType: 'issue',
        entityId: outcome.issueId,
        details: {
          status: outcome.status,
          boardApprovalId: null,
          approvalId: input.approvalId,
          decision: input.decision,
          note: input.note,
          ...(outcome.remainingBlockers.length > 0
            ? { remainingBlockerIds: outcome.remainingBlockers.map((b) => b.id) }
            : {}),
        },
      });
    }
  }

  return outcomes;
}

export interface ApprovalWakeResult {
  target: ApprovalWakeTarget;
  /**
   * 'sent' when the scheduler took the wake; 'skipped' when the agent cannot run; 'failed' on an
   * error (a value-free log line plus an `issue.wake_failed` entry on each affected issue).
   */
  result: 'sent' | 'skipped' | 'failed';
  skipReason?: WakeSkipReason;
}

/**
 * Wake the requester and the assignees of issues that can move again (see `planApprovalWakes`).
 * Never throws. A wake that is skipped because the agent cannot run (paused, archived, ...) is
 * written to each affected issue's activity so the Board can see nobody will pick it up.
 */
export async function wakeAgentsForDecision(input: {
  companyId: string;
  approvalId: string;
  decision: ApprovalDecision;
  /** APR-2: stored status sent in the wake (defaults to `decision`). */
  outcome?: ApprovalOutcomeStatus;
  /** APR-2: response fields the requester reads in its wake. */
  response?: ApprovalWakeResponse;
  note?: string;
  issueIds: string[];
  requesterAgentId: string | null | undefined;
  outcomes: IssueRestoreOutcome[];
  actor: DecisionActor;
  logPrefix: string;
}): Promise<ApprovalWakeResult[]> {
  const targets = planApprovalWakes({
    decision: input.decision,
    requesterAgentId: input.requesterAgentId,
    issueIds: input.issueIds,
    outcomes: input.outcomes,
  });

  // Only write activity on issues we loaded for this company.
  const knownIssueIds = new Set(input.outcomes.map((o) => o.issueId));

  async function recordOnIssues(target: ApprovalWakeTarget, action: string, details: Record<string, unknown>) {
    for (const issueId of target.issueIds) {
      if (!knownIssueIds.has(issueId)) continue;
      try {
        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: 'system',
          actorId: input.actor.actorId,
          actorName: input.actor.actorName,
          action,
          entityType: 'issue',
          entityId: issueId,
          details,
        });
      } catch (err) {
        console.error(`${input.logPrefix} failed to record ${action} on issue`, issueId, err);
      }
    }
  }

  const results: ApprovalWakeResult[] = [];
  for (const target of targets) {
    let agentName: string | null = null;
    let skipReason: WakeSkipReason | null = null;
    let result: ApprovalWakeResult['result'] = 'sent';

    try {
      const agent = await db.query.agents.findFirst({
        where: and(eq(agents.id, target.agentId), eq(agents.companyId, input.companyId)),
      });
      agentName = agent?.name ?? null;
      skipReason = wakeSkipReasonFromAgentStatus(agent?.status);

      if (!skipReason) {
        const wake = await enqueueApprovalWake({
          approvalId: input.approvalId,
          agentId: target.agentId,
          companyId: input.companyId,
          status: input.outcome ?? input.decision,
          note: input.note,
          ...(input.response ? { response: input.response } : {}),
          linkedIssueIds: target.issueIds,
        });
        if (wake && wake.outcome === 'skipped') skipReason = wakeSkipReasonFromScheduler(wake.skipReason);
      }
    } catch (err) {
      console.error(`${input.logPrefix} failed to trigger approval wake:`, err);
      // Value-free trace: ids and role only, no scheduler text.
      console.warn(`${input.logPrefix} approval wake not delivered`, {
        approvalId: input.approvalId,
        agentId: target.agentId,
        role: target.role,
      });
      result = 'failed';
      await recordOnIssues(target, 'issue.wake_failed', {
        approvalId: input.approvalId,
        agentId: target.agentId,
        role: target.role,
        reason: 'wake_failed',
        comment: formatWakeFailedComment({ role: target.role, agentName }),
      });
    }

    if (skipReason) {
      result = 'skipped';
      await recordOnIssues(target, 'issue.wake_skipped', {
        approvalId: input.approvalId,
        agentId: target.agentId,
        role: target.role,
        reason: skipReason,
        comment: formatWakeSkippedComment({ role: target.role, agentName, reason: skipReason }),
      });
    }

    results.push({ target, result, ...(skipReason ? { skipReason } : {}) });
  }
  return results;
}

/**
 * Board 'Archive agent' (permanent).
 *
 * 1. One transaction, company-scoped:
 *    - agents.status → 'archived' and runtimeConfig.heartbeat.enabled → false, plus an
 *      `agent.archived` activity row (with the counts below). From then on #119's rule refuses any
 *      reactivation (setAgentActive*), #120/#123 refuses the agent's run/chat tokens (401), the
 *      scheduler skips every wake (status !== 'active') and never keeps its timer (archived →
 *      resolveAgentTimerSchedule inactive).
 *    - Every PENDING approval the agent requested is rejected the way a board reject does it
 *      (decide route): status rejected, note ARCHIVE_REJECT_REASON, decided by the board, an
 *      `approval.decided` row, linked issues still bound to it → blocked with an `issue.updated`
 *      row and the board's "Board Rejected" comment. The approval wake is NOT sent (the agent is
 *      archived and would never run it).
 *    - Every open issue assigned to the agent (any status but done/cancelled) is unassigned:
 *      in_progress → todo, other statuses kept, checkout lock cleared, an `issue.updated` row and
 *      a system comment ARCHIVE_UNASSIGN_COMMENT.
 *    - Every in_progress issue with no assignee whose checkout lock belongs to the agent (its
 *      checkout_run_id is one of the agent's runs, or execution_agent_name_key is the agent) is
 *      put back to todo with the lock cleared and an `issue.updated` row. The checkout route does
 *      not require the caller to be the assignee, so this catches those holds before run-stop
 *      releases the locks.
 * 2. Timer: ask the scheduler to re-sync the agent's Mastra timer schedule, which pauses it.
 *    Best effort: if the scheduler is down, its boot reconcile pauses it (the config is off).
 * 3. In-flight run(s) (queued/running): stopped through the scheduler's force-kill with reason
 *    'agent_archived' (aborts the run's AbortController; row → cancelled, AGENT_ARCHIVED_RUN_ERROR;
 *    checkout locks released). If the scheduler can't be reached, the row is recorded cancelled
 *    here with the same reason and its checkout locks are released; the run's token already 401s.
 *    Unassigned in_progress holds are reset again just before this stop so a checkout that landed
 *    during the archive transaction is still matched while its lock is present.
 *
 * 4. Post-commit sweep (once): an agent request already past auth when the archive committed can
 *    still land. The sweep rejects any approval the agent created in that window, unassigns any
 *    issue assigned to it, puts back to todo an issue the archive unassigned that a late write
 *    moved to in_progress (no assignee left), and again resets unassigned in_progress holds whose
 *    lock belongs to the agent — then stops any run that started in the window. Same rows, actors
 *    and comments as step 1; nothing is written twice.
 *
 * Idempotent: archiving an already-archived agent writes no second `agent.archived` row (the
 * archived status is set by a conditional update, so of two concurrent archives only one does
 * step 1) and reports `changed: false`; the timer/run clean-up and the sweep are re-run, which
 * write nothing when there is nothing left to stop.
 *
 * Archiving is permanent: there is no unarchive.
 */
import {
  db,
  agents,
  activityLog,
  approvals,
  issues,
  heartbeatRuns,
  releaseStaleCheckoutLocksForRun,
  CHECKOUT_LOCK_CLEAR_FIELDS,
  type Agent,
  type IssueStatus,
} from '@tourbillon/db';
import { and, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import {
  AGENT_ARCHIVED_RUN_CODE,
  AGENT_ARCHIVED_RUN_ERROR,
  DEFAULT_RUNTIME_CONFIG,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import { invalidateChatControllerForAgent } from './chat';
import {
  requestAgentTimerScheduleSync,
  requestHeartbeatForceKill,
  type SchedulerForceKillOutcome,
} from './wake-client';
import type { ArchiveImpact } from './agent-archive-copy';

export type { ArchiveImpact } from './agent-archive-copy';

/** Note on every approval auto-rejected by an archive (sent nowhere: the agent is archived). */
export const ARCHIVE_REJECT_REASON = 'Requesting agent archived';
/** System comment on every issue unassigned by an archive. */
export const ARCHIVE_UNASSIGN_COMMENT = 'Unassigned: agent archived';
/** Issue statuses an archive unassigns (everything but done/cancelled). */
export const ARCHIVE_OPEN_ISSUE_STATUSES: IssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'];
/** The board has no per-user identity yet (#107): same shared operator actor as a board decide. */
const BOARD_ACTOR = { actorType: 'user' as const, actorId: 'board', actorName: 'Board' };
const SYSTEM_ACTOR = { actorType: 'system' as const, actorId: 'system', actorName: 'System' };


export type ArchivedRunOutcome = {
  runId: string;
  /** aborted: scheduler aborted it; recorded: scheduler unreachable, row cancelled here. */
  outcome: 'aborted' | 'recorded' | 'already_finished';
};

export interface ArchiveAgentResult {
  agent: Agent;
  /** false when the agent was already archived (idempotent no-op). */
  changed: boolean;
  /** 'synced': scheduler paused the timer now; 'deferred': scheduler down, boot reconcile pauses it. */
  timerSync: 'synced' | 'deferred';
  runs: ArchivedRunOutcome[];
  /** What this archive did (zero when `changed` is false). */
  approvalsRejected: number;
  issuesUnassigned: number;
}

export interface ArchiveAgentDeps {
  killRun: (runId: string, companyId: string) => Promise<SchedulerForceKillOutcome>;
  syncTimer: (agentId: string) => Promise<void>;
  invalidateChat: (agentId: string) => void;
}

const defaultDeps: ArchiveAgentDeps = {
  killRun: (runId, companyId) => requestHeartbeatForceKill(runId, companyId, AGENT_ARCHIVED_RUN_CODE),
  syncTimer: requestAgentTimerScheduleSync,
  invalidateChat: invalidateChatControllerForAgent,
};

/**
 * Archive an agent of `companyId` (looked up by id or urlKey inside that company only, so another
 * company's agent is indistinguishable from a missing one). Returns null when not found (404).
 */
export async function archiveAgent(
  agentIdOrUrlKey: string,
  companyId: string,
  deps: ArchiveAgentDeps = defaultDeps,
): Promise<ArchiveAgentResult | null> {
  const key = agentIdOrUrlKey?.trim();
  if (!key || !companyId) return null;

  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, companyId), or(eq(agents.id, key), eq(agents.urlKey, key))),
  });
  if (!agent) return null;

  let current: Agent = agent;
  let changed = false;
  let approvalsRejected = 0;
  let issuesUnassigned = 0;
  /** Issues step 1 unassigned (and commented on): the sweep re-checks them and never re-comments. */
  let unassignedIssueIds: string[] = [];

  if (agent.status !== 'archived') {
    const runtimeConfig = (agent.runtimeConfig ?? {}) as AgentRuntimeConfig;
    const nextRuntimeConfig: AgentRuntimeConfig = {
      ...runtimeConfig,
      heartbeat: { ...(runtimeConfig.heartbeat ?? DEFAULT_RUNTIME_CONFIG.heartbeat), enabled: false },
    };
    const done = await db.transaction(async (tx) => {
      // Guarded on status so a concurrent archive can't write twice (the loser writes nothing).
      const [updated] = await tx
        .update(agents)
        .set({ status: 'archived', runtimeConfig: nextRuntimeConfig, updatedAt: new Date() })
        .where(and(eq(agents.id, agent.id), eq(agents.companyId, companyId), ne(agents.status, 'archived')))
        .returning();
      if (!updated) return null;
      const rejected = await rejectPendingApprovals(tx, agent.id, companyId);
      const unassigned = await unassignOpenIssues(tx, agent.id, companyId, new Set());
      await resetUnassignedInProgressHeldByAgent(tx, agent.id, companyId);
      await tx.insert(activityLog).values({
        companyId,
        ...BOARD_ACTOR,
        action: 'agent.archived',
        entityType: 'agent',
        entityId: agent.id,
        details: {
          previousStatus: agent.status,
          heartbeatWasEnabled: Boolean(runtimeConfig.heartbeat?.enabled),
          approvalsRejected: rejected,
          issuesUnassigned: unassigned.length,
        },
      });
      return { updated, rejected, unassigned };
    });

    if (done) {
      current = done.updated;
      changed = true;
      approvalsRejected = done.rejected;
      issuesUnassigned = done.unassigned.length;
      unassignedIssueIds = done.unassigned;
      deps.invalidateChat(agent.id);
    } else {
      current =
        (await db.query.agents.findFirst({
          where: and(eq(agents.id, agent.id), eq(agents.companyId, companyId)),
        })) ?? agent;
    }
  }

  let timerSync: ArchiveAgentResult['timerSync'] = 'synced';
  try {
    await deps.syncTimer(agent.id);
  } catch {
    timerSync = 'deferred';
  }

  // Reset unassigned in_progress holds before run-stop releases their locks (a checkout that
  // landed during the archive transaction is visible now; step 1 may have missed it).
  if (current.status === 'archived') {
    await db.transaction(async (tx) => {
      await resetUnassignedInProgressHeldByAgent(tx, agent.id, companyId);
    });
  }

  const runs = await stopInFlightRuns(agent.id, companyId, deps, []);

  // 4. Post-commit sweep, once (only once the agent is archived; a concurrent toggle can no longer
  // undo that, see setAgentActiveWithOutcome). Issue/approval cleanup runs before the late run
  // stop so unassigned holds are still matched while their locks are present.
  if (current.status === 'archived') {
    const swept = await db.transaction(async (tx) => {
      const rejected = await rejectPendingApprovals(tx, agent.id, companyId);
      const unassigned = await unassignOpenIssues(tx, agent.id, companyId, new Set(unassignedIssueIds));
      await resetLateInProgress(tx, agent.id, companyId, unassignedIssueIds);
      await resetUnassignedInProgressHeldByAgent(tx, agent.id, companyId);
      return { rejected, unassigned };
    });
    approvalsRejected += swept.rejected;
    issuesUnassigned += swept.unassigned.filter((id) => !unassignedIssueIds.includes(id)).length;
    const lateRuns = await stopInFlightRuns(agent.id, companyId, deps, runs.map((r) => r.runId));
    runs.push(...lateRuns);
  }

  return { agent: current, changed, timerSync, runs, approvalsRejected, issuesUnassigned };
}

/**
 * Stop the agent's queued/running runs (except `skipRunIds`, already handled) through the
 * scheduler's force-kill; if the scheduler can't be reached, record them cancelled here.
 */
async function stopInFlightRuns(
  agentId: string,
  companyId: string,
  deps: ArchiveAgentDeps,
  skipRunIds: string[],
): Promise<ArchivedRunOutcome[]> {
  const inFlight = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ['queued', 'running']),
        skipRunIds.length > 0 ? notInArray(heartbeatRuns.id, skipRunIds) : undefined,
      ),
    );

  const runs: ArchivedRunOutcome[] = [];
  for (const run of inFlight) {
    const outcome = await deps.killRun(run.id, companyId);
    if (outcome === 'aborted' || outcome === 'already_finished') {
      runs.push({ runId: run.id, outcome });
      continue;
    }
    runs.push({ runId: run.id, outcome: await recordRunCancelled(run.id) });
  }
  return runs;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Reject the agent's pending approvals inside the archive transaction, mirroring the board
 * decide route's reject (apps/web/app/api/approvals/[approvalId]/decide/route.ts): approval row,
 * linked issues still bound to it → blocked, `issue.updated` rows and the "Board Rejected"
 * comment. No approval wake: the requesting agent is archived. Returns the number rejected.
 */
async function rejectPendingApprovals(tx: Tx, agentId: string, companyId: string): Promise<number> {
  const pending = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.requestedByAgentId, agentId),
        eq(approvals.status, 'pending'),
      ),
    );

  let rejected = 0;
  const now = new Date();
  for (const approval of pending) {
    const [row] = await tx
      .update(approvals)
      .set({
        status: 'rejected',
        note: ARCHIVE_REJECT_REASON,
        decidedAt: now,
        // Same as a board decide (decide route): no per-user decider yet, so the label reads "Board".
        decidedByUserId: null,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, approval.id), eq(approvals.companyId, companyId), eq(approvals.status, 'pending')))
      .returning();
    if (!row) continue;
    rejected += 1;

    const issueIds = approval.issueIds ?? [];
    await tx.insert(activityLog).values({
      companyId,
      ...BOARD_ACTOR,
      action: 'approval.decided',
      entityType: 'approval',
      entityId: approval.id,
      details: {
        approvalId: approval.id,
        type: approval.type,
        decision: 'rejected',
        status: 'rejected',
        note: ARCHIVE_REJECT_REASON,
        issueIds,
        reason: 'agent_archived',
      },
    });

    if (issueIds.length === 0) continue;
    const payload = (approval.payload ?? {}) as { title?: unknown };
    const title = typeof payload.title === 'string' ? payload.title : approval.type;
    const comment = [
      `**Board Rejected:** ${title}`,
      `Note: ${ARCHIVE_REJECT_REASON}`,
      'Linked issues remain blocked. Triage, revise the request, or cancel as appropriate.',
    ].join('\n');

    const linked = await tx
      .select({ id: issues.id, status: issues.status, boardApprovalId: issues.boardApprovalId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIds)));
    for (const issue of linked) {
      // Same rule as the decide route: only issues still halted by this approval change status.
      if (!issue.boardApprovalId || issue.boardApprovalId === approval.id) {
        await tx
          .update(issues)
          .set({ status: 'blocked', boardApprovalId: null, updatedAt: now })
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId)))
          .returning({ id: issues.id });
        await tx.insert(activityLog).values({
          companyId,
          actorType: 'system',
          actorId: 'board',
          actorName: 'Board',
          action: 'issue.updated',
          entityType: 'issue',
          entityId: issue.id,
          details: {
            status: 'blocked',
            boardApprovalId: null,
            approvalId: approval.id,
            decision: 'rejected',
            note: ARCHIVE_REJECT_REASON,
          },
        });
      }
      // The decide route comments on every linked issue.
      await tx.insert(activityLog).values({
        companyId,
        ...BOARD_ACTOR,
        action: 'issue.commented',
        entityType: 'issue',
        entityId: issue.id,
        details: { body: comment, comment },
      });
    }
  }
  return rejected;
}

/**
 * Unassign the agent's open issues inside the archive transaction: in_progress → todo, other
 * statuses kept, checkout lock cleared, an `issue.updated` row and a system comment each (no second
 * comment on an issue in `alreadyCommented`). Returns the ids unassigned.
 */
async function unassignOpenIssues(
  tx: Tx,
  agentId: string,
  companyId: string,
  alreadyCommented: Set<string>,
): Promise<string[]> {
  const open = await tx
    .select({ id: issues.id, status: issues.status, checkoutRunId: issues.checkoutRunId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ARCHIVE_OPEN_ISSUE_STATUSES),
      ),
    );

  const unassigned: string[] = [];
  const now = new Date();
  for (const issue of open) {
    const status: IssueStatus = issue.status === 'in_progress' ? 'todo' : issue.status;
    const [row] = await tx
      .update(issues)
      .set({ assigneeAgentId: null, status, ...CHECKOUT_LOCK_CLEAR_FIELDS, updatedAt: now })
      .where(and(eq(issues.id, issue.id), eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId)))
      .returning({ id: issues.id });
    if (!row) continue;
    unassigned.push(issue.id);
    await tx.insert(activityLog).values({
      companyId,
      ...SYSTEM_ACTOR,
      action: 'issue.updated',
      entityType: 'issue',
      entityId: issue.id,
      details: {
        assigneeAgentId: null,
        previousAssigneeAgentId: agentId,
        ...(status !== issue.status ? { status, previousStatus: issue.status } : {}),
        ...(issue.checkoutRunId ? { previousCheckoutRunId: issue.checkoutRunId } : {}),
        reason: 'agent_archived',
      },
    });
    if (alreadyCommented.has(issue.id)) continue;
    await tx.insert(activityLog).values({
      companyId,
      ...SYSTEM_ACTOR,
      action: 'issue.commented',
      entityType: 'issue',
      entityId: issue.id,
      details: { body: ARCHIVE_UNASSIGN_COMMENT, comment: ARCHIVE_UNASSIGN_COMMENT },
    });
  }
  return unassigned;
}

/**
 * Sweep: an issue step 1 unassigned that a late write (a checkout or status update already in
 * flight) then moved to in_progress is left in_progress with nobody on it. Put it back to todo with
 * the lock cleared and an `issue.updated` row (it already has its unassign comment).
 */
async function resetLateInProgress(
  tx: Tx,
  agentId: string,
  companyId: string,
  unassignedIssueIds: string[],
): Promise<void> {
  if (unassignedIssueIds.length === 0) return;
  const now = new Date();
  const rows = await tx
    .update(issues)
    .set({ status: 'todo', ...CHECKOUT_LOCK_CLEAR_FIELDS, updatedAt: now })
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.id, unassignedIssueIds),
        eq(issues.status, 'in_progress'),
        isNull(issues.assigneeAgentId),
        isNull(issues.assigneeUserId),
      ),
    )
    .returning({ id: issues.id });
  for (const row of rows) {
    await tx.insert(activityLog).values({
      companyId,
      ...SYSTEM_ACTOR,
      action: 'issue.updated',
      entityType: 'issue',
      entityId: row.id,
      details: {
        status: 'todo',
        previousStatus: 'in_progress',
        previousAssigneeAgentId: agentId,
        reason: 'agent_archived',
      },
    });
  }
}

/**
 * Put back to todo any in_progress issue with no assignee whose checkout lock belongs to the
 * agent (checkout_run_id in the agent's runs, or execution_agent_name_key = agent). The checkout
 * route does not require the caller to be the assignee; run-stop would otherwise leave these
 * in_progress with no assignee and no lock. One `issue.updated` row each; no unassign comment
 * (there was no assignee to remove).
 */
async function resetUnassignedInProgressHeldByAgent(
  tx: Tx,
  agentId: string,
  companyId: string,
): Promise<void> {
  const agentRuns = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.companyId, companyId)));
  const runIds = agentRuns.map((r) => r.id);
  const held = await tx
    .select({ id: issues.id, checkoutRunId: issues.checkoutRunId })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, 'in_progress'),
        isNull(issues.assigneeAgentId),
        isNull(issues.assigneeUserId),
        or(
          eq(issues.executionAgentNameKey, agentId),
          runIds.length > 0 ? inArray(issues.checkoutRunId, runIds) : undefined,
        ),
      ),
    );
  if (held.length === 0) return;
  const now = new Date();
  for (const issue of held) {
    const [row] = await tx
      .update(issues)
      .set({ status: 'todo', ...CHECKOUT_LOCK_CLEAR_FIELDS, updatedAt: now })
      .where(
        and(
          eq(issues.id, issue.id),
          eq(issues.companyId, companyId),
          eq(issues.status, 'in_progress'),
          isNull(issues.assigneeAgentId),
          isNull(issues.assigneeUserId),
        ),
      )
      .returning({ id: issues.id });
    if (!row) continue;
    await tx.insert(activityLog).values({
      companyId,
      ...SYSTEM_ACTOR,
      action: 'issue.updated',
      entityType: 'issue',
      entityId: row.id,
      details: {
        status: 'todo',
        previousStatus: 'in_progress',
        ...(issue.checkoutRunId ? { previousCheckoutRunId: issue.checkoutRunId } : {}),
        reason: 'agent_archived',
      },
    });
  }
}

/**
 * What archiving would do now (confirm dialog / GET route): the agent's pending approvals and
 * open issues, inside `companyId` only. Null when the agent isn't in that company. An already
 * archived agent reports zeros (a repeat archive changes nothing).
 */
export async function getArchiveImpact(
  agentIdOrUrlKey: string,
  companyId: string,
): Promise<(ArchiveImpact & { agentId: string; archived: boolean }) | null> {
  const key = agentIdOrUrlKey?.trim();
  if (!key || !companyId) return null;
  const agent = await db.query.agents.findFirst({
    where: and(eq(agents.companyId, companyId), or(eq(agents.id, key), eq(agents.urlKey, key))),
    columns: { id: true, status: true },
  });
  if (!agent) return null;
  if (agent.status === 'archived') {
    return { agentId: agent.id, archived: true, pendingApprovals: 0, openIssues: 0 };
  }
  const [pending, open] = await Promise.all([
    db
      .select({ id: approvals.id })
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, companyId),
          eq(approvals.requestedByAgentId, agent.id),
          eq(approvals.status, 'pending'),
        ),
      ),
    db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.assigneeAgentId, agent.id),
          inArray(issues.status, ARCHIVE_OPEN_ISSUE_STATUSES),
        ),
      ),
  ]);
  return { agentId: agent.id, archived: false, pendingApprovals: pending.length, openIssues: open.length };
}


/** Scheduler unreachable: record the cancellation (only if the row is still in flight). */
async function recordRunCancelled(runId: string): Promise<ArchivedRunOutcome['outcome']> {
  const rows = await db
    .update(heartbeatRuns)
    .set({ status: 'cancelled', finishedAt: new Date(), errorText: AGENT_ARCHIVED_RUN_ERROR })
    .where(and(eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, ['queued', 'running'])))
    .returning({ id: heartbeatRuns.id });
  if (rows.length === 0) return 'already_finished';
  await releaseStaleCheckoutLocksForRun(runId).catch(() => undefined);
  return 'recorded';
}

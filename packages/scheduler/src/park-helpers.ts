import { db, activityLog, issues, type Issue } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';

export interface ActivityEntry {
  action: string;
  createdAt: Date | null;
  details: Record<string, unknown> | null;
}

/**
 * Find the issue to park for this run.
 * - If taskId is provided (assignment wake), use it directly
 * - If taskId is absent (timer/on-demand wake), find by checkoutRunId
 */
export async function findIssueToPark(
  runId: string,
  agentId: string,
  companyId: string,
  taskId?: string,
): Promise<Issue | null> {
  if (taskId) {
    // Assignment wake: check the assigned issue
    return (await db.query.issues.findFirst({ where: eq(issues.id, taskId) })) ?? null;
  } else {
    // Timer/on-demand wake with no taskId: find the issue this run checked out
    return (
      (await db.query.issues.findFirst({
        where: and(
          eq(issues.companyId, companyId),
          eq(issues.checkoutRunId, runId),
          eq(issues.executionAgentNameKey, agentId),
        ),
      })) ?? null
    );
  }
}

/**
 * Check if a subtask was created under this parent issue during this run.
 * Subtasks write issue.created on the CHILD, not the parent, so we need
 * to check for child issues with this parentId that were created by this run.
 */
export async function hasSubtaskCreated(
  parentIssueId: string,
  runId: string,
): Promise<boolean> {
  // Find child issues created during this run
  const childIssues = await db.query.issues.findMany({
    where: eq(issues.parentId, parentIssueId),
    columns: { id: true },
  });

  if (childIssues.length === 0) return false;

  const childIds = childIssues.map((c) => c.id);

  // Check if any child has issue.created activity from this run
  const childActivities = await db.query.activityLog.findMany({
    where: and(
      eq(activityLog.entityType, 'issue'),
      eq(activityLog.action, 'issue.created'),
    ),
    columns: { entityId: true, details: true },
  });

  return childActivities.some((a) => {
    const details = a.details as { runId?: string } | null;
    return details?.runId === runId && a.entityId && childIds.includes(a.entityId);
  });
}

/**
 * Detect if material work was performed on this issue during this run.
 * Material work includes:
 * - issue.updated (status/comment changes)
 * - Subtask creation (child issue with parentId === this issue)
 * 
 * Note: approval.created is NOT checked because createApproval immediately
 * blocks the issue and clears the lock, so parkNoProgressIssue never runs.
 */
export async function hasMaterialWork(
  issue: Issue,
  runId: string,
): Promise<boolean> {
  const checkoutTime = issue.executionLockedAt ?? new Date(0);

  // Check for updateIssue calls on this issue
  const parentActivities = await db.query.activityLog.findMany({
    where: and(
      eq(activityLog.entityId, issue.id),
      eq(activityLog.entityType, 'issue'),
    ),
    columns: { action: true, details: true, createdAt: true },
  });

  const hasUpdate = parentActivities.some((a) => {
    if (!a.createdAt || a.createdAt < checkoutTime) return false;
    const details = a.details as { runId?: string } | null;
    if (details?.runId !== runId) return false;
    return a.action === 'issue.updated';
  });

  if (hasUpdate) return true;

  // Check for subtask creation (createSubtask writes issue.created on the child)
  return await hasSubtaskCreated(issue.id, runId);
}

/**
 * Decide whether to park this issue based on:
 * - Still in_progress with this run's lock
 * - No material work performed
 */
export function shouldParkIssue(
  issue: Issue,
  runId: string,
): boolean {
  return issue.status === 'in_progress' && issue.checkoutRunId === runId;
}

import type { HeartbeatJobData, WakeReason } from '@tourbillon/shared';

/**
 * Rebuild a HeartbeatJobData for a *retry* wake from a failed run's
 * contextSnapshot. The retry is a NEW run (new runId, empty model context) —
 * we only reconstruct the wake routing data so the scheduler can rebuild the
 * wake message (buildWakeMessage reads wakeReason/taskId/wakePayloadJson/
 * approval fields), not replay the transcript.
 *
 * Rules:
 * - Always sets agentId/companyId and resumeOfRunId (lineage on the NEW row).
 * - Task-scoped reasons (assignment, issue_* ) need taskId + wakePayloadJson
 *   to survive; otherwise degrade to on_demand.
 * - approval_resolved needs approvalId to survive; otherwise on_demand.
 * - Context-free reasons (timer, on_demand, automation, agent_mail) survive.
 * - Empty/junk snapshots fall back to plain on_demand (same shape as
 *   triggerAgentHeartbeat in apps/web/lib/heartbeat.ts).
 */

/** Wake reasons that need a taskId + payload to be useful on the scheduler side. */
const TASK_SCOPED_REASONS: ReadonlySet<string> = new Set([
  'assignment',
  'issue_commented',
  'issue_comment_mentioned',
  'issue_blockers_resolved',
  'issue_children_completed',
]);

/** Reasons that carry no task/approval context and can be replayed as-is. */
const CONTEXT_FREE_REASONS: ReadonlySet<string> = new Set([
  'timer',
  'on_demand',
  'automation',
  'agent_mail',
]);

const VALID_WAKE_REASONS: ReadonlySet<string> = new Set([
  'timer',
  'assignment',
  'on_demand',
  'issue_commented',
  'issue_comment_mentioned',
  'issue_blockers_resolved',
  'issue_children_completed',
  'approval_resolved',
  'automation',
  'agent_mail',
]);

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value.filter((v) => nonEmptyString(v)) as string[];
  return cleaned.length > 0 ? cleaned : undefined;
}

export function buildRetryHeartbeatJobData(
  failedRun: {
    id: string;
    agentId: string;
    companyId: string;
    contextSnapshot: unknown;
  },
): HeartbeatJobData {
  const snapshot = (failedRun.contextSnapshot ?? {}) as Record<string, unknown>;

  const base = {
    agentId: failedRun.agentId,
    companyId: failedRun.companyId,
    resumeOfRunId: failedRun.id,
  };

  const wakeReasonRaw = nonEmptyString(snapshot.wakeReason);
  if (!wakeReasonRaw || !VALID_WAKE_REASONS.has(wakeReasonRaw)) {
    return { ...base, invocationSource: 'on_demand', wakeReason: 'on_demand' };
  }

  const taskId = nonEmptyString(snapshot.taskId);
  const payloadJson = nonEmptyString(snapshot.wakePayloadJson);
  const linkedIssueIds = nonEmptyStringArray(snapshot.linkedIssueIds);

  // Approval retry: preserve approval context when approvalId survives.
  if (wakeReasonRaw === 'approval_resolved') {
    const approvalId = nonEmptyString(snapshot.approvalId);
    if (approvalId) {
      const approvalStatus = snapshot.approvalStatus;
      return {
        ...base,
        invocationSource: 'approval_resolved',
        wakeReason: 'approval_resolved',
        approvalId,
        ...(approvalStatus === 'approved' || approvalStatus === 'rejected'
          ? {
              approvalStatus: approvalStatus,
              approvalNote: nonEmptyString(snapshot.approvalNote) ?? undefined,
            }
          : {}),
        ...(taskId ? { taskId } : {}),
        ...(linkedIssueIds ? { linkedIssueIds } : {}),
      };
    }
    return { ...base, invocationSource: 'on_demand', wakeReason: 'on_demand' };
  }

  // Task-scoped retry: preserve reason + payload so the scheduler can rebuild
  // the wake message from wakePayloadJson / refetch comments via taskId.
  if (TASK_SCOPED_REASONS.has(wakeReasonRaw)) {
    if (taskId && payloadJson) {
      return {
        ...base,
        invocationSource: wakeReasonRaw as WakeReason,
        wakeReason: wakeReasonRaw as WakeReason,
        taskId,
        wakePayloadJson: payloadJson,
        ...(linkedIssueIds ? { linkedIssueIds } : {}),
      };
    }
    return { ...base, invocationSource: 'on_demand', wakeReason: 'on_demand' };
  }

  // Context-free reason (timer, on_demand, automation, agent_mail): replay as-is.
  return {
    ...base,
    invocationSource: wakeReasonRaw as WakeReason,
    wakeReason: wakeReasonRaw as WakeReason,
    ...(taskId ? { taskId } : {}),
    ...(payloadJson ? { wakePayloadJson: payloadJson } : {}),
  };
}

import type { Issue } from './schema/issues';

/**
 * Determine whether to insert an issue.checked_out activity log entry.
 * 
 * Only insert when:
 * - status was not already in_progress, OR
 * - this is a different agent taking over (executionAgentNameKey changed)
 * 
 * Avoids duplicate checkout spam when the same agent re-checkouts an in_progress
 * issue (just rotating runId for a new heartbeat).
 */
export function shouldInsertCheckoutActivity(
  issue: Pick<Issue, 'status' | 'executionAgentNameKey'>,
  checkoutAgentId: string,
): boolean {
  return issue.status !== 'in_progress' || issue.executionAgentNameKey !== checkoutAgentId;
}

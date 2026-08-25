import { ISSUE_STATUS_WORK_PRIORITY } from './constants';

export interface InboxIssue {
  id: string;
  status: string;
  priority: string;
  blockedByIssueIds?: string[] | null;
}

/**
 * Sort inbox issues with combined status + priority logic:
 * - Critical/high unblocked workable tasks rank first (above medium/low in_progress)
 * - Then status priority (in_progress > in_review > todo > blocked)
 * - Finally issue priority within same status
 */
export function sortInboxIssues<T extends InboxIssue>(issues: T[]): T[] {
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...issues].sort((a, b) => {
    const aIsHighPriority = priorityOrder[a.priority] <= 1; // critical or high
    const bIsHighPriority = priorityOrder[b.priority] <= 1;
    const aIsBlocked = a.status === 'blocked' || (a.blockedByIssueIds && a.blockedByIssueIds.length > 0);
    const bIsBlocked = b.status === 'blocked' || (b.blockedByIssueIds && b.blockedByIssueIds.length > 0);
    const aIsWorkable = ['in_progress', 'todo'].includes(a.status) && !aIsBlocked;
    const bIsWorkable = ['in_progress', 'todo'].includes(b.status) && !bIsBlocked;

    // High-priority workable tasks rank first
    if (aIsHighPriority && aIsWorkable && !(bIsHighPriority && bIsWorkable)) return -1;
    if (bIsHighPriority && bIsWorkable && !(aIsHighPriority && aIsWorkable)) return 1;

    // Then status priority (in_progress > in_review > todo > blocked)
    const statusDiff =
      (ISSUE_STATUS_WORK_PRIORITY[a.status] ?? 99) - (ISSUE_STATUS_WORK_PRIORITY[b.status] ?? 99);
    if (statusDiff !== 0) return statusDiff;

    // Finally issue priority
    return (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99);
  });
}

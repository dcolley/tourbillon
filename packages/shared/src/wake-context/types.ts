/**
 * Live state for a task-bearing wake, read from the DB at run start (scheduler
 * `buildWakeContext`). Plain JSON so it can be logged, persisted and replayed.
 */
export interface WakeApprovalRef {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | string;
  decidedAt: string | null;
  createdAt: string;
  note: string | null;
  /** payload.title, used when there is no Board note (e.g. pending). */
  title?: string | null;
  /** True when linked via approvals.issue_ids; false when only cited by id in a comment. */
  linked: boolean;
}

export interface WakeIssueRef {
  identifier: string;
  status: string;
}

export interface WakeLiveContext {
  version: number;
  /** Run start (ISO). The header's "from the database at" time and the "today" reference. */
  asOf: string;
  agent: { id: string; name: string; urlKey?: string | null };
  task: {
    id: string;
    identifier: string;
    title: string;
    status: string;
    priority: string;
    assignee: { kind: 'self' | 'agent' | 'user' | 'none'; name?: string | null };
  };
  parent: WakeIssueRef | null;
  blockers: WakeIssueRef[];
  /**
   * Approvals linked to the task plus every approval resolved (same company, by 8-hex id prefix)
   * from tokens in the candidate comments. The renderer lists only linked ones and those cited
   * in the comments it actually shows.
   */
  approvals: WakeApprovalRef[];
  /** Issues resolved (same company) from identifiers in the candidate comments. */
  referencedIssues: WakeIssueRef[];
  /** The agent's latest activity_log row on this issue before the run (ISO), or null. */
  lastActivityAt: string | null;
  /** User/Board comments on this issue after lastActivityAt and before the run. */
  userCommentsSinceLastActivity: number;
}

export interface WakeContextBudgets {
  headerMaxChars: number;
  commentsMaxChars: number;
  totalSoftMaxChars: number;
}

/** Which renderer failed: v2 → T1 was used; t1 → the minimal message was used. */
export type WakeRenderFallback = 'v2_render_failed' | 't1_render_failed';

/** Recorded as contextSnapshot.wakeContext (WC6 AC2). */
export interface WakeContextStats {
  version: number;
  /**
   * 'v2' = live header + T1–T7; 't1' = newest-first fill only (flag off, no task, or build failed);
   * 'minimal' = wake reason + task id only (both renderers failed; #122 follow-up B1).
   */
  mode: 'v2' | 't1' | 'minimal';
  /** Set when a renderer threw and a simpler layout was used instead (never set on success). */
  fallback?: WakeRenderFallback;
  headerChars: number;
  commentChars: number;
  totalChars: number;
  /** Comments in the payload window ("last N"). */
  considered: number;
  shown: number;
  hidden: number;
  dropped: number;
  deduped: number;
  condensed: number;
  annotated: number;
  /** 8-hex ids of approvals listed in the header. */
  approvalsListed: string[];
}

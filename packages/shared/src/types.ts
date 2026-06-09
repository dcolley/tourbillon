// ─── Wake Loop Types ───────────────────────────────────────────────────────

export type WakeReason =
  | 'timer'
  | 'assignment'
  | 'on_demand'
  | 'issue_commented'
  | 'issue_comment_mentioned'
  | 'issue_blockers_resolved'
  | 'issue_children_completed'
  | 'approval_resolved'
  | 'automation';

export interface HeartbeatJobData {
  agentId: string;
  companyId: string;
  invocationSource: WakeReason;
  wakeReason: WakeReason;
  taskId?: string;
  wakeCommentId?: string;
  approvalId?: string;
  approvalStatus?: 'approved' | 'rejected';
  linkedIssueIds?: string[];
  wakePayloadJson?: string;
}

// ─── API Types ─────────────────────────────────────────────────────────────

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';
export type AgentStatus = 'active' | 'paused' | 'archived' | 'pending_approval';
export type AdapterType = 'lmstudio' | 'process' | 'http';

export interface WakePayload {
  issue: {
    id: string;
    identifier: string;
    title: string;
    status: IssueStatus;
    priority: IssuePriority;
    assigneeAgentId: string;
  };
  newComments: Array<{
    id: string;
    body: string;
    authorType: 'user' | 'agent';
    authorName: string;
    createdAt: string;
  }>;
  fallbackFetchNeeded: boolean;
  dependencyBlocked?: boolean;
}

export interface AgentRuntimeConfig {
  heartbeat: {
    enabled: boolean;
    intervalSec: number;
    wakeOnAssignment: boolean;
    wakeOnDemand: boolean;
    wakeOnAutomation: boolean;
  };
  timeout: {
    heartbeatSec: number;
    graceSec: number;
  };
  model?: {
    temperature?: number;
  };
}

export const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  heartbeat: {
    enabled: false,
    intervalSec: 0,
    wakeOnAssignment: true,
    wakeOnDemand: true,
    wakeOnAutomation: false,
  },
  timeout: {
    heartbeatSec: 300,
    graceSec: 30,
  },
};

// ─── SSE Event Types ───────────────────────────────────────────────────────

export type SSEEventType =
  | 'heartbeat.started'
  | 'heartbeat.completed'
  | 'heartbeat.failed'
  | 'agent.budget_exceeded'
  | 'issue.status_changed'
  | 'issue.assigned'
  | 'approval.created'
  | 'approval.decided';

export interface SSEEvent {
  type: SSEEventType;
  companyId: string;
  agentId?: string;
  issueId?: string;
  runId?: string;
  approvalId?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

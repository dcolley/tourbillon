import type { AgentModelSettings } from './model-settings';

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
  | 'automation'
  | 'agent_mail';

export interface HeartbeatJobData {
  agentId: string;
  agentName?: string;
  companyId: string;
  invocationSource: WakeReason;
  wakeReason: WakeReason;
  taskId?: string;
  wakeCommentId?: string;
  approvalId?: string;
  approvalStatus?: 'approved' | 'rejected';
  /** Board decision note (approval_resolved wakes). */
  approvalNote?: string;
  linkedIssueIds?: string[];
  wakePayloadJson?: string;
  /** Agent mail data (agent_mail wakes). */
  mailId?: string;
  mailFromAgentId?: string;
  mailFromAgentName?: string;
  mailBody?: string;
}

// ─── API Types ─────────────────────────────────────────────────────────────

export type IssueStatus = 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done' | 'blocked' | 'cancelled';
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low';
export type AgentStatus = 'active' | 'paused' | 'archived' | 'pending_approval';
export type AdapterType = 'lmstudio' | 'ollama' | 'process' | 'http' | 'harness_local';

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

export type HeartbeatScheduleMode = 'interval' | 'cron';

export interface AgentRuntimeConfig {
  heartbeat: {
    enabled: boolean;
    intervalSec: number;
    cronExpression?: string;
    timezone?: string;
    scheduleMode?: HeartbeatScheduleMode;
    wakeOnAssignment: boolean;
    wakeOnDemand: boolean;
    wakeOnAutomation: boolean;
    /** Maximum model steps per heartbeat (default 30). Aborts when exceeded. */
    maxSteps?: number;
  };
  timeout: {
    heartbeatSec: number;
    graceSec: number;
  };
  /** Per-agent LLM generation overrides (merged over provider defaults). */
  model?: AgentModelSettings;
  budget?: {
    /** When false, heartbeats and UI limits ignore the monthly token cap. Default: true. */
    enforce?: boolean;
  };
  /** Tier-2 granular tool ids (goal/project/issue management). */
  assignedTools?: string[];
  /** Per-agent API key overrides for MCP servers (server id → key). */
  mcpCredentials?: Record<string, string>;
  /** Per-agent SearXNG base URL override (no trailing slash). */
  searxngUrl?: string;
  /** Per-agent SearXNG API key override (optional). */
  searxngApiKey?: string;
  /** Per-agent Tavily API key override. */
  tavilyApiKey?: string;
  /** Per-server MCP tool allow/deny lists (agent capabilities UI). */
  mcpToolPolicy?: Record<string, { allow?: string[]; deny?: string[] }>;
  /** Per-agent sandbox overrides for code-execution toolset. */
  codeExecution?: {
    timeoutMs?: number;
    isolation?: 'none' | 'seatbelt' | 'bwrap';
  };
  /**
   * Knowledge-graph memory mounts (when `knowledge-graph` toolset is enabled).
   * Defaults: private on, company off.
   */
  knowledgeGraph?: {
    private?: boolean;
    company?: boolean;
  };
  /**
   * Direct messages to other agents (sendToAgent tool).
   * When false, sendToAgent is unavailable. Default: true.
   */
  mail?: {
    enabled?: boolean;
  };
}

/** Company Observational Memory compaction model (Observer + Reflector). */
export interface ObservationalMemorySettings {
  /** When true and providerId+modelId are set, OM compaction is active. */
  enabled?: boolean;
  /** FK to llm_providers.id (system-wide registry). */
  providerId?: string;
  /** Model id on that provider (same as agents.modelId). */
  modelId?: string;
}

/** Company-level integration settings stored in companies.settings jsonb. */
export interface CompanySettings {
  mcpCredentials?: Record<string, string>;
  searxngUrl?: string;
  searxngApiKey?: string;
  tavilyApiKey?: string;
  observationalMemory?: ObservationalMemorySettings;
}

export const DEFAULT_RUNTIME_CONFIG: AgentRuntimeConfig = {
  heartbeat: {
    enabled: false,
    intervalSec: 0,
    scheduleMode: 'interval',
    wakeOnAssignment: true,
    wakeOnDemand: true,
    wakeOnAutomation: false,
    maxSteps: 30,
  },
  timeout: {
    heartbeatSec: 300,
    graceSec: 30,
  },
  budget: {
    enforce: true,
  },
};

/** Whether monthly token budget limits apply for this agent. */
export function isAgentBudgetEnforced(runtimeConfig: AgentRuntimeConfig): boolean {
  return runtimeConfig.budget?.enforce !== false;
}

export function isAgentBudgetExceeded(
  spentMonthlyTokens: number,
  budgetMonthlyTokens: number,
  runtimeConfig: AgentRuntimeConfig,
): boolean {
  if (!isAgentBudgetEnforced(runtimeConfig)) return false;
  return spentMonthlyTokens >= budgetMonthlyTokens;
}

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

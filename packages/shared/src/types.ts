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

/**
 * Stored approval status after a decision (APR-2). `approved` / `rejected` are binary answers;
 * `answered` is any other answer; `declined`, `cancelled` and `expired` carry no answer value.
 */
export type ApprovalOutcomeStatus = 'approved' | 'rejected' | 'answered' | 'declined' | 'cancelled' | 'expired';

/** The `hitl/response/v0` fields an approval_resolved wake carries to the requester (APR-2). */
export interface ApprovalWakeResponse {
  status: 'answered' | 'declined' | 'cancelled' | 'expired';
  /** Answer value (answered only). Absent for secret answers; see `encrypted`. */
  value?: unknown;
  /** True when the answer is an encrypted secret; the value is never put in a wake. */
  encrypted?: boolean;
  reason?: string;
  decidedBy?: { kind: 'human' | 'group' | 'service'; id: string; display?: string };
  answerType?: string;
}

export interface HeartbeatJobData {
  agentId: string;
  agentName?: string;
  companyId: string;
  invocationSource: WakeReason;
  wakeReason: WakeReason;
  taskId?: string;
  wakeCommentId?: string;
  approvalId?: string;
  approvalStatus?: ApprovalOutcomeStatus;
  /** Board decision note (approval_resolved wakes). */
  approvalNote?: string;
  /** Response to the approval's question (approval_resolved wakes, APR-2). */
  approvalResponse?: ApprovalWakeResponse;
  linkedIssueIds?: string[];
  wakePayloadJson?: string;
  /** Lineage: runId of the failed run this retry re-attempts (retry-in-new-heartbeat). */
  resumeOfRunId?: string;
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
    allowNetwork?: boolean;
    /**
     * Egress allow-list: hosts or CIDRs (e.g. ['api.example.com', '10.0.0.0/8']).
     * When defined (including empty), this replaces `allowNetwork`.
     * Empty → no sandbox network: bwrap `--unshare-net` (no proxy socket bound);
     * seatbelt denies network*; isolation=none uses Landlock+seccomp (TCP/UDP
     * and AF_UNIX sockets) or refuses. Residual: isolation=none still sees the
     * host filesystem; this is not a kernel IP filter.
     * Non-empty → isolation=bwrap only (per-run unix-socket proxy).
     * isolation=none and isolation=seatbelt refuse a non-empty list.
     * The proxy blocks localhost/LAN/link-local/CGNAT by default. A private
     * destination is allowed only by an exact IP, a CIDR, or an exact hostname
     * whose resolved IPs are in that range. Wildcards never allow a private IP.
     * Cloud metadata is never allowed, even when listed: 169.254.0.0/16,
     * fe80::/10, fd00:ec2::254, 100.100.100.200, and hostnames metadata /
     * metadata.google.internal. Loopback overrides must be an exact IP.
     *
     * Legacy `allowNetwork: true` with no list uses the proxy in public-internet
     * mode (public destinations allowed; private ranges blocked) when
     * isolation=bwrap. isolation=none/seatbelt cannot enforce the proxy: the
     * run is not refused; a per-run warning is logged instead.
     */
    egressAllowList?: string[];
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
   * `browser` toolset options (only meaningful when the toolset is enabled).
   * screenshots: expose browser_screenshot. Default off.
   */
  browser?: {
    screenshots?: boolean;
  };
  /**
   * Direct messages to other agents (sendToAgent tool).
   * When false, sendToAgent is unavailable. Default: true.
   */
  mail?: {
    enabled?: boolean;
  };
  /**
   * Per-agent Observational Memory config (Observer + Reflector).
   * When missing or mode='inherit', inherits company OM settings.
   */
  observationalMemory?: {
    /** inherit = use company OM; off = disable OM; on = enable with overrides. */
    mode?: 'inherit' | 'off' | 'on';
    /** Override: FK to llm_providers.id (system-wide registry). */
    providerId?: string;
    /** Override: Model id on that provider. */
    modelId?: string;
    /** Override: Max output tokens for OM model calls. */
    maxOutputTokens?: number;
    /** Override: Observation threshold (message tokens). */
    observeAfterTokens?: number;
    /** Override: Reflection threshold (observation tokens). */
    reflectAfterTokens?: number;
    /** Override: Temperature for OM model calls. */
    temperature?: number;
  };
  /**
   * Per-agent secrets/environment variables (AC-B1.1).
   * Injected into code-execution sandbox runtime as environment variables.
   * Values are write-only after save (never redisplayed or logged).
   */
  secrets?: Record<string, string>;
}

/** Company Observational Memory compaction model (Observer + Reflector). */
export interface ObservationalMemorySettings {
  /** When true and providerId+modelId are set, OM compaction is active. */
  enabled?: boolean;
  /** FK to llm_providers.id (system-wide registry). */
  providerId?: string;
  /** Model id on that provider (same as agents.modelId). */
  modelId?: string;
  /** Max output tokens for both Observer and Reflector (default 8192, min 1024). */
  maxOutputTokens?: number;
  /** Observation threshold in message tokens (default 30000, min 8000). */
  observeAfterTokens?: number;
  /** Reflection threshold in observation tokens (default 40000, min 8000). */
  reflectAfterTokens?: number;
  /** Temperature for both Observer and Reflector (optional; empty = Mastra defaults 0.3/0). */
  temperature?: number;
}

/** HITLy approval gate settings. */
export interface HitlyGateSettings {
  /** When true, new approvals POST to HITLy. */
  enabled?: boolean;
  /** HITLy base URL (e.g. http://localhost:3001). */
  baseUrl?: string;
  /** Tourbillon resume host HITLy can reach (e.g. https://tourbillon.example.com). */
  resumeHost?: string;
  /** HITLy project ID (e.g. prj_...). */
  projectId?: string;
  /** HITLy project API key (ingest Bearer token). */
  apiKey?: string;
  /** Optional approval types to forward (default: all types). */
  types?: string[];
}

/**
 * CONCIERGE-MODEL-1: the company's chat-model pair (the "concierge" model).
 * Set = Assistant free-chat (AgentController) runs use this pair for agents without an
 * explicit model choice; unset (or provider unavailable) = each agent keeps its own model.
 */
export interface ConciergeModelSettings {
  /** Registry provider id (llm_providers.id); chosen from the providers on for the company. */
  providerId?: string;
  /** Model id served by that provider. Never a pinned default baked into code. */
  modelId?: string;
}

/** Company-level integration settings stored in companies.settings jsonb. */
export interface CompanySettings {
  mcpCredentials?: Record<string, string>;
  searxngUrl?: string;
  searxngApiKey?: string;
  tavilyApiKey?: string;
  /** CONCIERGE-MODEL-1: company-level concierge (front-desk) chat model; per-agent model when unset. */
  conciergeModel?: ConciergeModelSettings;
  observationalMemory?: ObservationalMemorySettings;
  hitlyGate?: HitlyGateSettings;
  /** Wake compression (WC1–6): live-state header + compacted comments. Overrides the env default. */
  wakeContextV2?: boolean;
  /** Per-company wake budgets (chars); unset fields use the shared defaults. */
  wakeContextBudgets?: {
    headerMaxChars?: number;
    commentsMaxChars?: number;
    totalSoftMaxChars?: number;
  };
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

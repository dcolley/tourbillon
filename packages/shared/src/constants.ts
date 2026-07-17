// ─── Budget thresholds ────────────────────────────────────────────────────
export const BUDGET_WARNING_THRESHOLD = 0.8;   // 80%: critical-only mode
export const BUDGET_PAUSE_THRESHOLD = 1.0;      // 100%: auto-pause

// ─── Heartbeat defaults ───────────────────────────────────────────────────
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 300;
export const DEFAULT_HEARTBEAT_GRACE_SEC = 30;

// ─── Legacy queue name constants (heartbeats use WakeRunner; kept for URL/path compat) ─
/** @deprecated Heartbeats use WakeRunner; constant kept for URL/path compat. */
export const QUEUE_HEARTBEAT = 'heartbeat';
/** @deprecated Unused. */
export const QUEUE_ROUTINES = 'routines';
/** @deprecated Approval wakes use WakeRunner; constant kept for path compat. */
export const QUEUE_APPROVAL_WAKES = 'approval-wakes';

// ─── Issue status ordering (for priority selection) ───────────────────────
export const ISSUE_STATUS_WORK_PRIORITY: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  blocked: 3,
  backlog: 4,
};

/** Statuses the checkoutIssue tool may acquire — must cover getInbox workable statuses. */
export const CHECKOUT_EXPECTED_STATUSES = [
  'in_progress',
  'in_review',
  'todo',
  'blocked',
  'backlog',
] as const;

// ─── Board (human) assignee ───────────────────────────────────────────────
/** Stable v1 user id for issues assigned to the human board (dashboard operator). */
export const BOARD_USER_ID = 'board';
export const BOARD_DISPLAY_NAME = 'Board';
/** Form/select sentinel for “assign to board” (maps to BOARD_USER_ID). */
export const BOARD_ASSIGNEE_SELECT_VALUE = '__board__';

// ─── Agent roles ──────────────────────────────────────────────────────────
export const ROLE_DEFAULT_SKILLS: Record<string, string[]> = {
  ceo:      ['control-plane', 'plan-to-tasks', 'create-agent', 'para-memory'],
  cto:      ['control-plane', 'plan-to-tasks', 'para-memory'],
  engineer: ['control-plane', 'para-memory'],
  pm:       ['control-plane', 'plan-to-tasks', 'para-memory'],
  qa:       ['control-plane', 'para-memory'],
  designer: ['control-plane', 'para-memory'],
};

/** Toolset skill markdown filenames — excluded from dynamic per-agent skill scans. */
export const TOOLSET_SKILL_FILENAMES = ['buffer-skills.md', 'code-execution-skills.md'] as const;

export const TOOLSET_SKILL_FILENAME_SET = new Set<string>(TOOLSET_SKILL_FILENAMES);

export const TOOLSET_CATALOG = [
  {
    id: 'roster',
    label: 'Agent roster',
    description: 'See other agents in the company (listAgents) — needed to assign work.',
  },
  {
    id: 'comments',
    label: 'Comments',
    description: 'Post markdown comments on issues.',
  },
  {
    id: 'approvals',
    label: 'Approvals',
    description: 'Submit governance approval requests.',
  },
  {
    id: 'web-search',
    label: 'Web search',
    description: 'Search the web via SearXNG JSON API (requires SEARXNG_URL or company settings).',
  },
  {
    id: 'web-search-tavily',
    label: 'Web search (Tavily)',
    description: 'Cloud web search via Tavily (requires TAVILY_API_KEY or company/agent key).',
  },
  {
    id: 'buffer',
    label: 'Buffer',
    description:
      'Schedule X/Twitter posts and threads via Buffer MCP (requires API key). Toolset skill auto-injected from agents/{urlKey}/skills/.',
  },
  {
    id: 'code-execution',
    label: 'Code execution',
    description:
      'Isolated local sandbox via Mastra workspace (mastra_workspace_execute_command, file tools). Configured under Code & execution on the agent page.',
  },
  {
    id: 'nitter',
    label: 'Nitter / X search',
    description: 'Search tweets and users via a self-hosted Nitter instance (requires NITTER_URL).',
  },
] as const;

export type ToolsetId = (typeof TOOLSET_CATALOG)[number]['id'];

export const VALID_TOOLSET_IDS = new Set<string>(TOOLSET_CATALOG.map((t) => t.id));

export const ROLE_DEFAULT_TOOLSETS: Record<string, string[]> = {
  ceo:      ['comments', 'approvals', 'roster', 'web-search'],
  cto:      ['comments', 'approvals', 'roster'],
  engineer: ['comments', 'code-execution'],
  pm:       ['comments', 'approvals', 'roster', 'web-search'],
  qa:       ['comments', 'code-execution'],
  designer: ['comments'],
};

/** Per-agent integration credential keys (overrides company/env). */
export const AGENT_INTEGRATION_CREDENTIALS = [
  {
    id: 'tavilyApiKey',
    label: 'Tavily API key',
    envHint: 'TAVILY_API_KEY',
    inputType: 'password' as const,
  },
  {
    id: 'bufferApiKey',
    label: 'Buffer API key',
    envHint: 'BUFFER_API_KEY',
    inputType: 'password' as const,
  },
  {
    id: 'searxngUrl',
    label: 'SearXNG URL',
    envHint: 'SEARXNG_URL',
    inputType: 'url' as const,
  },
  {
    id: 'searxngApiKey',
    label: 'SearXNG API key',
    envHint: 'SEARXNG_API_KEY',
    inputType: 'password' as const,
  },
] as const;

export type AgentIntegrationCredentialId = (typeof AGENT_INTEGRATION_CREDENTIALS)[number]['id'];

export const VALID_AGENT_INTEGRATION_CREDENTIAL_IDS = new Set<string>(
  AGENT_INTEGRATION_CREDENTIALS.map((entry) => entry.id),
);

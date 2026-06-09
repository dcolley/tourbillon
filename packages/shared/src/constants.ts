// ─── Budget thresholds ────────────────────────────────────────────────────
export const BUDGET_WARNING_THRESHOLD = 0.8;   // 80%: critical-only mode
export const BUDGET_PAUSE_THRESHOLD = 1.0;      // 100%: auto-pause

// ─── Heartbeat defaults ───────────────────────────────────────────────────
export const DEFAULT_HEARTBEAT_TIMEOUT_SEC = 300;
export const DEFAULT_HEARTBEAT_GRACE_SEC = 30;

// ─── BullMQ queue names ───────────────────────────────────────────────────
export const QUEUE_HEARTBEAT = 'heartbeat';
export const QUEUE_ROUTINES = 'routines';
export const QUEUE_APPROVAL_WAKES = 'approval-wakes';

// ─── Issue status ordering (for priority selection) ───────────────────────
export const ISSUE_STATUS_WORK_PRIORITY: Record<string, number> = {
  in_progress: 0,
  in_review: 1,
  todo: 2,
  blocked: 3,
  backlog: 4,
};

// ─── Agent roles ──────────────────────────────────────────────────────────
export const ROLE_DEFAULT_SKILLS: Record<string, string[]> = {
  ceo:      ['control-plane', 'plan-to-tasks', 'create-agent', 'para-memory'],
  cto:      ['control-plane', 'plan-to-tasks', 'para-memory'],
  engineer: ['control-plane', 'para-memory'],
  pm:       ['control-plane', 'plan-to-tasks', 'para-memory'],
  qa:       ['control-plane', 'para-memory'],
  designer: ['control-plane', 'para-memory'],
};

export const ROLE_DEFAULT_TOOLSETS: Record<string, string[]> = {
  ceo:      ['comments', 'approvals', 'agent-management', 'web-search'],
  cto:      ['comments', 'approvals', 'planning'],
  engineer: ['comments', 'planning'],
  pm:       ['comments', 'approvals', 'planning', 'web-search'],
  qa:       ['comments'],
  designer: ['comments'],
};

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const API_URL = () => process.env.INTERNAL_API_URL ?? 'http://localhost:3000';

function headers(apiKey: string, runId?: string): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (runId) h['X-Paperclip-Run-Id'] = runId;
  return h;
}

// ─────────────────────────────────────────────────────────────────────────────
// TIER 1 — UNIVERSAL: every agent always receives these tools
// ─────────────────────────────────────────────────────────────────────────────

export const getIdentityTool = createTool({
  id: 'getIdentity',
  description:
    'Get your agent identity, role, budget status, and chain of command. ' +
    'Call at start of heartbeat if not already in context.',
  inputSchema: z.object({}),
  execute: async (_input, { context }) => {
    const { apiKey } = context as { apiKey: string };
    const res = await fetch(`${API_URL()}/api/agents/me`, {
      headers: headers(apiKey),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const getInboxTool = createTool({
  id: 'getInbox',
  description:
    'Get your compact assignment list. Returns todo, in_progress, in_review, ' +
    'and blocked tasks assigned to you. Use this to pick work at the start of a heartbeat.',
  inputSchema: z.object({}),
  execute: async (_input, { context }) => {
    const { apiKey } = context as { apiKey: string };
    const res = await fetch(`${API_URL()}/api/agents/me/inbox-lite`, {
      headers: headers(apiKey),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const checkoutIssueTool = createTool({
  id: 'checkoutIssue',
  description:
    'Atomically checkout a task before doing any work on it. ' +
    'Returns 409 if owned by another agent — NEVER retry a 409, pick a different task.',
  inputSchema: z.object({
    issueId: z.string().describe('The issue UUID to checkout'),
  }),
  execute: async ({ issueId }, { context }) => {
    const { apiKey, runId, agentId } = context as { apiKey: string; runId: string; agentId: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}/checkout`, {
      method: 'POST',
      headers: headers(apiKey, runId),
      body: JSON.stringify({
        agentId,
        expectedStatuses: ['todo', 'backlog', 'blocked', 'in_review'],
      }),
    });
    if (res.status === 409) {
      return { conflict: true, message: 'Task owned by another agent. Pick a different task.' };
    }
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const getHeartbeatContextTool = createTool({
  id: 'getHeartbeatContext',
  description:
    'Get compact context for a task: state, ancestors, goal info, and comment cursor. ' +
    'Always call this before reading the full comment thread.',
  inputSchema: z.object({ issueId: z.string() }),
  execute: async ({ issueId }, { context }) => {
    const { apiKey } = context as { apiKey: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}/heartbeat-context`, {
      headers: headers(apiKey),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const getCommentsTool = createTool({
  id: 'getComments',
  description: 'Get comments on a task. Use after parameter for incremental updates (preferred). Omit for full thread (cold start only).',
  inputSchema: z.object({
    issueId: z.string(),
    after: z.string().optional().describe('Last seen comment ID for incremental fetch'),
  }),
  execute: async ({ issueId, after }, { context }) => {
    const { apiKey } = context as { apiKey: string };
    const url = new URL(`${API_URL()}/api/issues/${issueId}/comments`);
    if (after) { url.searchParams.set('after', after); url.searchParams.set('order', 'asc'); }
    const res = await fetch(url.toString(), { headers: headers(apiKey) });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const updateIssueTool = createTool({
  id: 'updateIssue',
  description:
    'Update issue status, add a comment, change priority or assignee. ' +
    'Always include a comment explaining what changed and the next action.',
  inputSchema: z.object({
    issueId: z.string(),
    status: z
      .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'])
      .optional(),
    comment: z.string().optional().describe('Markdown comment — what was done, what remains, who owns the next step'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    assigneeAgentId: z.string().optional(),
    assigneeUserId: z.string().optional(),
    blockedByIssueIds: z.array(z.string()).optional().describe('Replaces current blockers. Send [] to clear all.'),
  }),
  execute: async ({ issueId, ...body }, { context }) => {
    const { apiKey, runId } = context as { apiKey: string; runId: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}`, {
      method: 'PATCH',
      headers: headers(apiKey, runId),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const createSubtaskTool = createTool({
  id: 'createSubtask',
  description:
    'Create a child issue to delegate work to another agent. ' +
    'Always set parentId and goalId — no orphan tasks allowed.',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    parentId: z.string().describe('Parent issue ID — required'),
    goalId: z.string().describe('Goal/initiative ID — required for traceability'),
    assigneeAgentId: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
    blockedByIssueIds: z.array(z.string()).optional(),
    billingCode: z.string().optional(),
    inheritExecutionWorkspaceFromIssueId: z.string().optional(),
  }),
  execute: async (body, { context }) => {
    const { apiKey, runId, companyId } = context as { apiKey: string; runId: string; companyId: string };
    const res = await fetch(`${API_URL()}/api/companies/${companyId}/issues`, {
      method: 'POST',
      headers: headers(apiKey, runId),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

// Bundle export — Tier 1 tools
export const CONTROL_PLANE_TOOLS = {
  getIdentityTool,
  getInboxTool,
  checkoutIssueTool,
  getHeartbeatContextTool,
  getCommentsTool,
  updateIssueTool,
  createSubtaskTool,
};

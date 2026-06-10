import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';

export const getIdentityTool = createTool({
  id: 'getIdentity',
  description:
    'Get your agent identity, role, budget status, and chain of command. ' +
    'Call at start of heartbeat if not already in context.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => {
    const res = await tracedAgentFetch('getIdentity', requestContext, '/api/agents/me');
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
  execute: async (_inputData, { requestContext }) => {
    const res = await tracedAgentFetch('getInbox', requestContext, '/api/agents/me/inbox-lite');
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
  execute: async (inputData, { requestContext }) => {
    const { issueId } = inputData;
    const { agentId } = extractToolRuntimeContext(requestContext);
    const res = await tracedAgentFetch('checkoutIssue', requestContext, `/api/issues/${issueId}/checkout`, {
      method: 'POST',
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
    'Get compact context for a task: state, ancestors, goal info, latestCommentId, and commentCount. ' +
    'Always call this before reading the full comment thread.',
  inputSchema: z.object({ issueId: z.string() }),
  execute: async (inputData, { requestContext }) => {
    const { issueId } = inputData;
    const res = await tracedAgentFetch('getHeartbeatContext', requestContext, `/api/issues/${issueId}/heartbeat-context`);
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const getCommentsTool = createTool({
  id: 'getComments',
  description:
    'Get comments on a task. Omit after on cold start (assignment/reassignment). ' +
    'For incremental updates within a run, pass latestId from a prior getComments response.',
  inputSchema: z.object({
    issueId: z.string(),
    after: z.string().optional().describe('latestId from a prior getComments response (incremental only)'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { issueId, after } = inputData;
    const path = after
      ? `/api/issues/${issueId}/comments?after=${encodeURIComponent(after)}&order=asc`
      : `/api/issues/${issueId}/comments`;
    const res = await tracedAgentFetch('getComments', requestContext, path);
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
  execute: async (inputData, { requestContext }) => {
    const { issueId, ...body } = inputData;
    const res = await tracedAgentFetch('updateIssue', requestContext, `/api/issues/${issueId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const listGoalsTool = createTool({
  id: 'listGoals',
  description:
    'List company goals with issue stats and needsAttention flag. ' +
    'CEO: call when inbox is empty to find goals requiring planning or follow-up.',
  inputSchema: z.object({
    status: z
      .enum(['active', 'completed', 'archived', 'all'])
      .default('active')
      .describe('Filter goals by status — default active'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const query = inputData.status !== 'active' ? `?status=${encodeURIComponent(inputData.status)}` : '?status=active';
    const res = await tracedAgentFetch(
      'listGoals',
      requestContext,
      `/api/companies/${companyId}/goals${query}`
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const getGoalDetailTool = createTool({
  id: 'getGoalDetail',
  description:
    'Get full goal context: description, linked issues, stats, and needsAttention. ' +
    'Call before decomposing a goal into tasks.',
  inputSchema: z.object({
    goalId: z.string().describe('Goal UUID'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const { goalId } = inputData;
    const res = await tracedAgentFetch(
      'getGoalDetail',
      requestContext,
      `/api/companies/${companyId}/goals/${goalId}`
    );
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
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('createSubtask', requestContext, `/api/companies/${companyId}/issues`, {
      method: 'POST',
      body: JSON.stringify(inputData),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const CONTROL_PLANE_TOOLS = {
  getIdentityTool,
  getInboxTool,
  listGoalsTool,
  getGoalDetailTool,
  checkoutIssueTool,
  getHeartbeatContextTool,
  getCommentsTool,
  updateIssueTool,
  createSubtaskTool,
};

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
    'When status is in_review, you MUST set assigneeAgentId to the reviewer (task requester first, else reportsTo from getIdentity) so they receive it in their inbox. ' +
    'Always include a comment explaining what changed and the next action.',
  inputSchema: z.object({
    issueId: z.string(),
    status: z
      .enum(['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'])
      .optional(),
    comment: z.string().optional().describe('Markdown comment — what was done, what remains, who owns the next step'),
    priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    assigneeAgentId: z
      .string()
      .optional()
      .describe('Required when setting status to in_review — assign the reviewer so they see it in getInbox'),
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

export const listWorkspaceFilesTool = createTool({
  id: 'listWorkspaceFiles',
  description:
    'List files and folders in the company shared workspace. ' +
    'Use during work to discover reference docs (start with resources/).',
  inputSchema: z.object({
    path: z.string().optional().describe('Relative directory path, default root'),
    recursive: z.boolean().optional().describe('List nested entries recursively'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const params = new URLSearchParams();
    if (inputData.path) params.set('path', inputData.path);
    if (inputData.recursive) params.set('recursive', 'true');
    const query = params.toString();
    const res = await tracedAgentFetch(
      'listWorkspaceFiles',
      requestContext,
      `/api/companies/${companyId}/workspace${query ? `?${query}` : ''}`
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const readWorkspaceFileTool = createTool({
  id: 'readWorkspaceFile',
  description:
    'Read a text file from the company shared workspace. ' +
    'Path is relative to the workspace root (e.g. resources/brand-guide.md).',
  inputSchema: z.object({
    path: z.string().describe('Relative file path within the company workspace'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch(
      'readWorkspaceFile',
      requestContext,
      `/api/companies/${companyId}/workspace/file?path=${encodeURIComponent(inputData.path)}`
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const writeWorkspaceFileTool = createTool({
  id: 'writeWorkspaceFile',
  description:
    'Create or update a text file in the company shared workspace. ' +
    'Comment on the issue when the write affects the current task.',
  inputSchema: z.object({
    path: z.string().describe('Relative file path within the company workspace'),
    content: z.string().describe('UTF-8 text content'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch(
      'writeWorkspaceFile',
      requestContext,
      `/api/companies/${companyId}/workspace/file`,
      {
        method: 'PUT',
        body: JSON.stringify(inputData),
      }
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const deleteWorkspaceFileTool = createTool({
  id: 'deleteWorkspaceFile',
  description:
    'Delete a file or empty directory from the company shared workspace. ' +
    'Prefer moving material to archives/ over deleting.',
  inputSchema: z.object({
    path: z.string().describe('Relative path to delete'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch(
      'deleteWorkspaceFile',
      requestContext,
      `/api/companies/${companyId}/workspace/file?path=${encodeURIComponent(inputData.path)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const createSubtaskTool = createTool({
  id: 'createSubtask',
  description:
    'Create a child issue to delegate work to another agent. ' +
    'Always set parentId and goalId — no orphan tasks allowed. ' +
    'assigneeAgentId is required for work to start; omit only to defer assignment to CEO (creates backlog).',
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
  checkoutIssueTool,
  getHeartbeatContextTool,
  getCommentsTool,
  updateIssueTool,
  listWorkspaceFilesTool,
  readWorkspaceFileTool,
  writeWorkspaceFileTool,
  deleteWorkspaceFileTool,
  createSubtaskTool,
};

import { createTool } from '@mastra/core/tools';
import { CHECKOUT_EXPECTED_STATUSES } from '@tourbillon/shared';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';
import { SKILL_TOOLS } from './skill-tools';

function formatInTimezone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'long',
    timeZoneName: 'shortOffset',
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = get('year');
  const month = get('month');
  const day = get('day');
  // Some locales emit "24" for midnight with hour12: false; normalize to 00.
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const second = get('second');

  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}:${second}`,
    dayOfWeek: get('weekday'),
    utcOffset: get('timeZoneName') || 'UTC',
    local: `${year}-${month}-${day}T${hour}:${minute}:${second}`,
  };
}

export const getDateTimeTool = createTool({
  id: 'getDateTime',
  description:
    'Get the current date and time. Defaults to UTC. ' +
    'Pass an IANA timezone (e.g. America/New_York, Europe/London) for local wall-clock time. ' +
    'Use whenever you need today\'s date, the current time, day of week, or to reason about deadlines/schedules.',
  inputSchema: z.object({
    timezone: z
      .string()
      .optional()
      .describe('IANA timezone, e.g. Europe/London. Defaults to UTC.'),
  }),
  execute: async (inputData) => {
    const now = new Date();
    const timezone = inputData.timezone?.trim() || 'UTC';

    try {
      const local = formatInTimezone(now, timezone);
      return {
        utc: now.toISOString(),
        unixMs: now.getTime(),
        timezone,
        ...local,
      };
    } catch {
      return {
        error: 'invalid_timezone',
        message: `Unrecognized IANA timezone "${timezone}". Try UTC, America/New_York, Europe/London, etc.`,
        utc: now.toISOString(),
        unixMs: now.getTime(),
        timezone: 'UTC',
        ...formatInTimezone(now, 'UTC'),
      };
    }
  },
});

export const getIdentityTool = createTool({
  id: 'getIdentity',
  description:
    'Get your agent identity, role, budget status, chain of command, and board.assigneeUserId ' +
    '(use that id when assigning human/Board work). Call at start of heartbeat if not already in context.',
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
    'Atomically checkout a task before doing any work on it (including resuming in_progress work). ' +
    'On 409 conflict, pick the next inbox task — never retry the same issue in one heartbeat.',
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
        expectedStatuses: [...CHECKOUT_EXPECTED_STATUSES],
      }),
    });
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      if (body.code === 'lock_conflict') {
        return {
          conflict: true,
          conflictReason: 'lock',
          message:
            'Another heartbeat run holds the checkout lock on this task. Pick a different inbox task.',
        };
      }
      return {
        conflict: true,
        conflictReason: body.code ?? 'checkout_conflict',
        message:
          body.error ??
          'Cannot checkout this task right now. Pick a different inbox task.',
      };
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
    'To assign human/board work, set assigneeUserId to getIdentity.board.assigneeUserId (clears assigneeAgentId). ' +
    'Do not set both assigneeAgentId and assigneeUserId. ' +
    'If the issue is board-halted (pendingBoardApproval / boardApprovalId), do not change status — wait for wakeReason approval_resolved after the board decides. Comments are still allowed. ' +
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
      .describe('Required when setting status to in_review — assign the reviewer so they see it in getInbox. Mutually exclusive with assigneeUserId'),
    assigneeUserId: z
      .string()
      .optional()
      .describe('Use getIdentity.board.assigneeUserId for Board/human work. Mutually exclusive with assigneeAgentId'),
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
    'Create a child issue to delegate work to another agent or the Board. ' +
    'Always set parentId and goalId — no orphan tasks allowed. ' +
    'goalId must come from getHeartbeatContext.goal.id or listGoals; never the issue id. ' +
    'Assign with assigneeAgentId (listAgents) or assigneeUserId (getIdentity.board.assigneeUserId); ' +
    'omit both only to defer assignment to CEO (creates backlog).',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    parentId: z.string().describe('Parent issue ID — required'),
    goalId: z
      .string()
      .describe(
        'Goal UUID from getHeartbeatContext.goal.id or listGoals — must exist in goals; never invent or reuse issue/agent ids',
      ),
    assigneeAgentId: z
      .string()
      .optional()
      .describe('Agent UUID from listAgents — mutually exclusive with assigneeUserId'),
    assigneeUserId: z
      .string()
      .optional()
      .describe('Use getIdentity.board.assigneeUserId for Board/human work — mutually exclusive with assigneeAgentId'),
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

export const sendToAgentTool = createTool({
  id: 'sendToAgent',
  description:
    'Send a short message to another agent in your company. ' +
    'The recipient will be woken with your message. This is NOT operator chat, NOT a council, NOT an issue comment. ' +
    'Use for quick agent-to-agent coordination that does not require an issue. ' +
    'Cannot send to yourself.',
  inputSchema: z.object({
    toAgentId: z.string().optional().describe('Agent UUID — use this OR toAgentUrlKey, not both'),
    toAgentUrlKey: z.string().optional().describe('Agent urlKey (e.g. "cto") — use this OR toAgentId, not both'),
    body: z.string().describe('Message body — keep it short and actionable'),
    inReplyTo: z.string().optional().describe('Mail ID if replying to a received message'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId, agentId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    if (!agentId) {
      return { error: 'missing_agent', message: 'agentId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('sendToAgent', requestContext, `/api/companies/${companyId}/agent-mail`, {
      method: 'POST',
      body: JSON.stringify(inputData),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

export const CONTROL_PLANE_TOOLS = {
  getDateTimeTool,
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
  sendToAgentTool,
  ...SKILL_TOOLS,
};

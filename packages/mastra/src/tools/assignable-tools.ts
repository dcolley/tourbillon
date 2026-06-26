import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';

const createIssueTool = createTool({
  id: 'createIssue',
  description:
    'Create a top-level issue linked to a goal. Use for first-layer tasks under a goal. ' +
    'For sub-issues under an existing task, use createSubtask instead. ' +
    'assigneeAgentId is required for work to start; omit only to defer assignment to CEO (creates backlog).',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    goalId: z.string().describe('Goal ID — required for traceability'),
    parentId: z.string().optional().describe('Optional parent issue ID for nested work'),
    assigneeAgentId: z.string().optional(),
    priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
    blockedByIssueIds: z.array(z.string()).optional(),
    billingCode: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('createIssue', requestContext, `/api/companies/${companyId}/issues`, {
      method: 'POST',
      body: JSON.stringify(inputData),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const listGoalsTool = createTool({
  id: 'listGoals',
  description:
    'List company goals with issue stats and needsAttention flag. ' +
    'CEO/PM: call when inbox is empty to find goals requiring planning or follow-up.',
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
      `/api/companies/${companyId}/goals${query}`,
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const getGoalDetailTool = createTool({
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
      `/api/companies/${companyId}/goals/${goalId}`,
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const createGoalTool = createTool({
  id: 'createGoal',
  description: 'Create a new company goal. CEO/PM use when board direction requires a new outcome.',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    status: z.enum(['active', 'completed', 'archived']).default('active'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('createGoal', requestContext, `/api/companies/${companyId}/goals`, {
      method: 'POST',
      body: JSON.stringify(inputData),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const updateGoalTool = createTool({
  id: 'updateGoal',
  description: 'Update a goal title, description, status, or owner agent.',
  inputSchema: z.object({
    goalId: z.string(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    status: z.enum(['active', 'completed', 'archived']).optional(),
    ownerAgentId: z.string().nullable().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const { goalId, ...patch } = inputData;
    const res = await tracedAgentFetch(
      'updateGoal',
      requestContext,
      `/api/companies/${companyId}/goals/${goalId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const listProjectsTool = createTool({
  id: 'listProjects',
  description: 'List company projects with optional goal filter.',
  inputSchema: z.object({
    goalId: z.string().optional().describe('Filter to projects under this goal'),
    status: z
      .enum(['active', 'paused', 'completed', 'archived', 'all'])
      .default('all')
      .describe('Filter projects by status'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const params = new URLSearchParams();
    if (inputData.goalId) params.set('goalId', inputData.goalId);
    if (inputData.status && inputData.status !== 'all') params.set('status', inputData.status);
    const query = params.toString() ? `?${params.toString()}` : '';
    const res = await tracedAgentFetch(
      'listProjects',
      requestContext,
      `/api/companies/${companyId}/projects${query}`,
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const getProjectDetailTool = createTool({
  id: 'getProjectDetail',
  description: 'Get full project context: linked issues, stats, goal, and owner.',
  inputSchema: z.object({
    projectId: z.string().describe('Project UUID'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const { projectId } = inputData;
    const res = await tracedAgentFetch(
      'getProjectDetail',
      requestContext,
      `/api/companies/${companyId}/projects/${projectId}`,
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const createProjectTool = createTool({
  id: 'createProject',
  description: 'Create a project under a goal for grouping related issues.',
  inputSchema: z.object({
    title: z.string(),
    description: z.string().optional(),
    goalId: z.string().describe('Parent goal ID — required'),
    status: z.enum(['active', 'paused', 'completed', 'archived']).default('active'),
    ownerAgentId: z.string().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch(
      'createProject',
      requestContext,
      `/api/companies/${companyId}/projects`,
      {
        method: 'POST',
        body: JSON.stringify(inputData),
      },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const updateProjectTool = createTool({
  id: 'updateProject',
  description: 'Update a project title, description, status, goal, or owner.',
  inputSchema: z.object({
    projectId: z.string(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    status: z.enum(['active', 'paused', 'completed', 'archived']).optional(),
    goalId: z.string().optional(),
    ownerAgentId: z.string().nullable().optional(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const { projectId, ...patch } = inputData;
    const res = await tracedAgentFetch(
      'updateProject',
      requestContext,
      `/api/companies/${companyId}/projects/${projectId}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const putPlanDocumentTool = createTool({
  id: 'putPlanDocument',
  description: 'Create or update the plan document on an issue. Plans go here — not in descriptions or repo files.',
  inputSchema: z.object({
    issueId: z.string(),
    body: z.string().describe('Markdown content of the plan'),
    baseRevisionId: z.string().nullable().default(null).describe('Pass current revision ID when updating existing plan'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { issueId, body, baseRevisionId } = inputData;
    const res = await tracedAgentFetch('putPlanDocument', requestContext, `/api/issues/${issueId}/documents/plan`, {
      method: 'PUT',
      body: JSON.stringify({ title: 'Plan', format: 'markdown', body, baseRevisionId }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const requestConfirmationTool = createTool({
  id: 'requestConfirmation',
  description:
    'Create a confirmation interaction on an issue — pauses for a yes/no board/user decision. ' +
    'After calling this, set the issue to in_review and assign assigneeAgentId to the reviewer (requester first, else reportsTo from getIdentity).',
  inputSchema: z.object({
    issueId: z.string(),
    question: z.string(),
    context: z.string().describe('Background context to help the reviewer decide'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { issueId, question, context: questionContext } = inputData;
    const res = await tracedAgentFetch('requestConfirmation', requestContext, `/api/issues/${issueId}/interactions`, {
      method: 'POST',
      body: JSON.stringify({ type: 'request_confirmation', question, context: questionContext }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

/** Granular Tier-2 tools keyed by tool id for assembly at wake time. */
export const ASSIGNABLE_TOOLS: Record<string, ReturnType<typeof createTool>> = {
  createIssue: createIssueTool,
  listGoals: listGoalsTool,
  getGoalDetail: getGoalDetailTool,
  createGoal: createGoalTool,
  updateGoal: updateGoalTool,
  listProjects: listProjectsTool,
  getProjectDetail: getProjectDetailTool,
  createProject: createProjectTool,
  updateProject: updateProjectTool,
  putPlanDocument: putPlanDocumentTool,
  requestConfirmation: requestConfirmationTool,
};

/** Mastra tools record keys (legacy naming: `${id}Tool`). */
export function assignableToolsForIds(toolIds: string[]): Record<string, unknown> {
  const tools: Record<string, unknown> = {};
  for (const toolId of toolIds) {
    const tool = ASSIGNABLE_TOOLS[toolId];
    if (tool) tools[`${toolId}Tool`] = tool;
  }
  return tools;
}

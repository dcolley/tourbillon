import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';

const addCommentTool = createTool({
  id: 'addComment',
  description: 'Post a markdown comment on an issue thread.',
  inputSchema: z.object({
    issueId: z.string(),
    body: z.string().describe('Markdown content of the comment'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { issueId, body } = inputData;
    const res = await tracedAgentFetch('addComment', requestContext, `/api/issues/${issueId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const createApprovalTool = createTool({
  id: 'createApproval',
  description: 'Submit a governance approval request to the board. Use for hires, large spend, irreversible actions.',
  inputSchema: z.object({
    type: z.string().default('request_board_approval'),
    issueIds: z.array(z.string()).default([]),
    payload: z.object({
      title: z.string(),
      summary: z.string(),
      recommendedAction: z.string().optional(),
      risks: z.array(z.string()).optional(),
    }),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId, agentId } = extractToolRuntimeContext(requestContext);
    if (!companyId || !agentId) {
      return { error: 'missing_context', message: 'companyId/agentId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('createApproval', requestContext, `/api/companies/${companyId}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ ...inputData, requestedByAgentId: agentId }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const listAgentsTool = createTool({
  id: 'listAgents',
  description: 'List all agents in the company with their roles and current status. Use to find agent IDs for assignment.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('listAgents', requestContext, `/api/companies/${companyId}/agents`);
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const requestConfirmationTool = createTool({
  id: 'requestConfirmation',
  description:
    'Create a confirmation interaction on an issue — pauses for a yes/no board/user decision. ' +
    'Set the issue to in_review after calling this.',
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

const createIssueTool = createTool({
  id: 'createIssue',
  description:
    'Create a top-level issue linked to a goal. Use for first-layer tasks under a goal. ' +
    'For sub-issues under an existing task, use createSubtask instead.',
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

const rosterTools = { listAgentsTool };

export const ROLE_TOOLS: Record<string, Record<string, unknown>> = {
  roster: rosterTools,
  'agent-management': rosterTools, // legacy alias
  comments: { addCommentTool },
  approvals: { createApprovalTool },
  planning: { createIssueTool, putPlanDocumentTool, requestConfirmationTool },
  'web-search': {},
};

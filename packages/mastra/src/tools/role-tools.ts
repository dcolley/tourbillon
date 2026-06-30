import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';
import { NITTER_TOOLS } from './nitter-tools';
import { SEARXNG_TOOLS } from './searxng-tools';

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

const rosterTools = { listAgentsTool };

export const ROLE_TOOLS: Record<string, Record<string, unknown>> = {
  roster: rosterTools,
  'agent-management': rosterTools, // legacy alias
  comments: { addCommentTool },
  approvals: { createApprovalTool },
  'web-search': SEARXNG_TOOLS,
  nitter: NITTER_TOOLS,
};

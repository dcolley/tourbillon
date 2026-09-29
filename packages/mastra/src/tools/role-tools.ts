import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { extractToolRuntimeContext, tracedAgentFetch } from './api-client';
import { NITTER_TOOLS } from './nitter-tools';
import { SEARXNG_TOOLS } from './searxng-tools';
import { TAVILY_TOOLS } from './tavily-tools';

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
  description:
    'Submit a board governance approval (hires, large spend, irreversible actions). ' +
    'Before filing, call listApprovals with targeted filters (e.g., type: "hire_agent", q: "CFO") to check for an equivalent approved or pending request. Do not re-file if an equivalent exists. ' +
    'Linked issues in issueIds are halted (status blocked) until the board decides at /approval. ' +
    'Post a comment on linked issues explaining why. This is not agent-to-agent review — use in_review + reassign for that.',
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

const listApprovalsTool = createTool({
  id: 'listApprovals',
  description:
    'Search and filter board approvals by status, type, or free-text query. Use targeted filters (type + q) to find prior decisions before filing a new request. ' +
    'Server-side filtering ensures efficient queries without paging through raw lists.',
  inputSchema: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'all']).default('all').describe('Filter by approval status'),
    type: z.string().optional().describe('Filter by approval type (e.g., "hire_agent", "request_board_approval")'),
    q: z.string().optional().describe('Free-text search in title, summary, and note (case-insensitive)'),
    createdAfter: z.string().optional().describe('ISO 8601 date - filter approvals created after this date'),
    decidedAfter: z.string().optional().describe('ISO 8601 date - filter approvals decided after this date'),
    limit: z.number().int().min(1).max(50).default(20).describe('Maximum number of results'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_context', message: 'companyId not present in tool runtime context' };
    }
    
    // Build query params
    const params = new URLSearchParams();
    if (inputData.status) params.append('status', inputData.status);
    if (inputData.type) params.append('type', inputData.type);
    if (inputData.q) params.append('q', inputData.q);
    if (inputData.createdAfter) params.append('createdAfter', inputData.createdAfter);
    if (inputData.decidedAfter) params.append('decidedAfter', inputData.decidedAfter);
    if (inputData.limit) params.append('limit', inputData.limit.toString());
    
    const res = await tracedAgentFetch(
      'listApprovals',
      requestContext,
      `/api/companies/${companyId}/approvals?${params.toString()}`
    );
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const getApprovalTool = createTool({
  id: 'getApproval',
  description: 'Read the full details of a single approval by its ID. Use after listApprovals to inspect a specific prior decision.',
  inputSchema: z.object({
    approvalId: z.string().describe('The approval ID to fetch'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_context', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch(
      'getApproval',
      requestContext,
      `/api/companies/${companyId}/approvals/${inputData.approvalId}`
    );
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

const createAgentTool = createTool({
  id: 'createAgent',
  description: 'Create a new agent record in the company after board approval. Returns the created agent with id, urlKey, and default role settings.',
  inputSchema: z.object({
    name: z.string().describe('Agent display name (e.g., "Sarah Chen")'),
    title: z.string().describe('Job title (e.g., "Chief Financial Officer")'),
    role: z.enum(['ceo', 'cto', 'engineer', 'pm', 'qa', 'designer', 'custom']).describe('Agent role'),
    urlKey: z.string().optional().describe('Short slug for URLs (e.g., "cfo"). Auto-slugified from name if omitted.'),
    reportsToId: z.string().nullable().optional().describe('Agent ID this hire reports to in the org chart'),
    runtimeType: z.enum(['agent', 'harness']).optional().describe('Runtime type: agent (default) or harness (multi-heartbeat coding)'),
    instructionsBundleSoulMd: z.string().optional().describe('Agent personality and values (SOUL.md content)'),
    instructionsBundleAgentsMd: z.string().optional().describe('Agent team knowledge (AGENTS.md content)'),
    codeExecutionEnabled: z.boolean().optional().describe('Override code-execution toolset: true to add, false to remove'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { companyId } = extractToolRuntimeContext(requestContext);
    if (!companyId) {
      return { error: 'missing_company', message: 'companyId not present in tool runtime context' };
    }
    const res = await tracedAgentFetch('createAgent', requestContext, `/api/companies/${companyId}/agents`, {
      method: 'POST',
      body: JSON.stringify(inputData),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const rosterTools = { listAgentsTool, createAgentTool };

export const ROLE_TOOLS: Record<string, Record<string, unknown>> = {
  roster: rosterTools,
  'agent-management': rosterTools, // legacy alias
  comments: { addCommentTool },
  approvals: { createApprovalTool, listApprovalsTool, getApprovalTool },
  'web-search': SEARXNG_TOOLS,
  'web-search-tavily': TAVILY_TOOLS,
  nitter: NITTER_TOOLS,
};

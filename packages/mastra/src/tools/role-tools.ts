import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const API_URL = () => process.env.INTERNAL_API_URL ?? 'http://localhost:3000';

function headers(apiKey: string, runId?: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (runId) h['X-Paperclip-Run-Id'] = runId;
  return h;
}

// ─── Tier 2: Role-gated tools ────────────────────────────────────────────────────────────

const addCommentTool = createTool({
  id: 'addComment',
  description: 'Post a markdown comment on an issue thread.',
  inputSchema: z.object({
    issueId: z.string(),
    body: z.string().describe('Markdown content of the comment'),
  }),
  execute: async ({ issueId, body }, { context }) => {
    const { apiKey, runId } = context as { apiKey: string; runId: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}/comments`, {
      method: 'POST',
      headers: headers(apiKey, runId),
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
  execute: async (body, { context }) => {
    const { apiKey, runId, companyId, agentId } = context as {
      apiKey: string; runId: string; companyId: string; agentId: string;
    };
    const res = await fetch(`${API_URL()}/api/companies/${companyId}/approvals`, {
      method: 'POST',
      headers: headers(apiKey, runId),
      body: JSON.stringify({ ...body, requestedByAgentId: agentId }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

const listAgentsTool = createTool({
  id: 'listAgents',
  description: 'List all agents in the company with their roles and current status. Use to find agent IDs for assignment.',
  inputSchema: z.object({}),
  execute: async (_input, { context }) => {
    const { apiKey, companyId } = context as { apiKey: string; companyId: string };
    const res = await fetch(`${API_URL()}/api/companies/${companyId}/agents`, {
      headers: headers(apiKey),
    });
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
  execute: async ({ issueId, question, context: ctx }, { context }) => {
    const { apiKey, runId } = context as { apiKey: string; runId: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}/interactions`, {
      method: 'POST',
      headers: headers(apiKey, runId),
      body: JSON.stringify({ type: 'request_confirmation', question, context: ctx }),
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
  execute: async ({ issueId, body, baseRevisionId }, { context }) => {
    const { apiKey, runId } = context as { apiKey: string; runId: string };
    const res = await fetch(`${API_URL()}/api/issues/${issueId}/documents/plan`, {
      method: 'PUT',
      headers: headers(apiKey, runId),
      body: JSON.stringify({ title: 'Plan', format: 'markdown', body, baseRevisionId }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, message: await res.text() };
    return res.json();
  },
});

// ─── Toolset registry: toolset ID → tools map ──────────────────────────────────────────

export const ROLE_TOOLS: Record<string, Record<string, unknown>> = {
  'comments':          { addCommentTool },
  'approvals':         { createApprovalTool },
  'agent-management':  { listAgentsTool },
  'planning':          { putPlanDocumentTool, requestConfirmationTool },
  'web-search':        {},  // populated at runtime by MCP — see mcp-tools.ts
};

import { createTool } from '@mastra/core/tools';
import { db, agents, companies, eq } from '@tourbillon/db';
import { z } from 'zod';
import { extractToolRuntimeContext } from './api-client';
import { assembleAgentTools } from '../agent-factory';
import { parseCompanySettings } from '@tourbillon/shared';
import type { CompanySettings } from '@tourbillon/shared';
import { serializeToolInputSchema } from './tool-schema-serialize';

async function loadAgentRecord(agentId: string | undefined) {
  if (!agentId) return null;
  return db.query.agents.findFirst({ where: eq(agents.id, agentId) });
}

function extractToolDescription(tool: unknown): string {
  if (!tool || typeof tool !== 'object') return '';
  if ('description' in tool && typeof tool.description === 'string') {
    return tool.description.trim();
  }
  return '';
}

function extractOneLineDescription(description: string, maxChars = 240): string {
  const trimmed = description.trim();
  const firstLine = trimmed.split('\n')[0]?.trim() || '';
  if (firstLine.length <= maxChars) return firstLine;
  return firstLine.slice(0, maxChars - 1) + '…';
}

function extractToolSchema(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object') return null;
  
  if ('inputSchema' in tool && tool.inputSchema) {
    // Never return the live Zod object: tool results must be structuredClone-safe.
    return serializeToolInputSchema(tool.inputSchema);
  }
  
  return null;
}

function extractToolId(key: string, tool: unknown): string {
  if (
    tool &&
    typeof tool === 'object' &&
    'id' in tool &&
    typeof (tool as { id: unknown }).id === 'string'
  ) {
    return (tool as { id: string }).id;
  }
  return key.replace(/Tool$/, '');
}

function getToolsetForId(toolId: string): string | undefined {
  const toolsetMap: Record<string, string> = {
    addComment: 'comments',
    listAgents: 'roster',
    createApproval: 'approvals',
    searxngSearch: 'web-search',
    searxngNewsSearch: 'web-search',
    webSearchTavily: 'web-search-tavily',
  };
  
  if (toolId.startsWith('mastra_workspace_')) return 'code-execution';
  if (toolId.startsWith('mcp_')) return 'mcp';
  if (toolId.startsWith('nitter_')) return 'nitter';
  if (toolId.startsWith('buffer_')) return 'buffer';
  
  return toolsetMap[toolId];
}

export const listToolsTool = createTool({
  id: 'listTools',
  description:
    'List all tools currently available to you (id + one-line description + optional toolset/tier). ' +
    'Call when unsure what capabilities you have or before exploring unfamiliar tools. ' +
    'Use getToolDetails(id) to fetch the full schema for a tool before first use. ' +
    'Prefer calling tools directly once you know their parameters — no invokeTool wrapper needed.',
  inputSchema: z.object({}),
  execute: async (_inputData, { requestContext }) => {
    const { agentId, companyId } = extractToolRuntimeContext(requestContext);
    const agent = await loadAgentRecord(agentId);
    if (!agent) {
      return { error: 'agent_not_found', message: 'Could not resolve agent for listTools' };
    }

    const company = companyId
      ? await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
      : null;
    const companySettings: CompanySettings | null = company
      ? parseCompanySettings(company.settings)
      : null;

    const tools = await assembleAgentTools(agent, {
      companySettings,
      allowedMcpServerIds: agent.mcpServerIds ?? [],
    });

    const catalog = Object.entries(tools).map(([key, tool]) => {
      const id = extractToolId(key, tool);
      const description = extractToolDescription(tool);
      const oneLine = extractOneLineDescription(description);
      const toolset = getToolsetForId(id);

      return {
        id,
        description: oneLine,
        ...(toolset ? { toolset } : {}),
      };
    });

    catalog.sort((a, b) => a.id.localeCompare(b.id));

    return {
      tools: catalog,
      count: catalog.length,
    };
  },
});

export const getToolDetailsTool = createTool({
  id: 'getToolDetails',
  description:
    'Get the full description and input schema for one tool by id (from listTools). ' +
    'Call before first use of a tool whose parameters you do not know. ' +
    'Once you know the schema, prefer calling the tool directly — no invokeTool wrapper needed.',
  inputSchema: z.object({
    id: z.string().describe('Tool id, e.g. webSearchTavily or createSubtask'),
  }),
  execute: async (inputData, { requestContext }) => {
    const { agentId, companyId } = extractToolRuntimeContext(requestContext);
    const agent = await loadAgentRecord(agentId);
    if (!agent) {
      return { error: 'agent_not_found', message: 'Could not resolve agent for getToolDetails' };
    }

    const company = companyId
      ? await db.query.companies.findFirst({ where: eq(companies.id, companyId) })
      : null;
    const companySettings: CompanySettings | null = company
      ? parseCompanySettings(company.settings)
      : null;

    const tools = await assembleAgentTools(agent, {
      companySettings,
      allowedMcpServerIds: agent.mcpServerIds ?? [],
    });

    let foundTool: unknown = null;
    let foundKey = '';

    for (const [key, tool] of Object.entries(tools)) {
      const toolId = extractToolId(key, tool);
      if (toolId === inputData.id || key === inputData.id) {
        foundTool = tool;
        foundKey = key;
        break;
      }
    }

    if (!foundTool) {
      const availableIds = Object.entries(tools).map(([key, tool]) => extractToolId(key, tool));
      availableIds.sort();
      return {
        error: 'tool_not_found',
        message: `No tool with id "${inputData.id}" is available to this agent`,
        availableIds,
      };
    }

    const id = extractToolId(foundKey, foundTool);
    const description = extractToolDescription(foundTool);
    const inputSchema = extractToolSchema(foundTool);
    const toolset = getToolsetForId(id);

    return {
      id,
      description,
      ...(inputSchema ? { inputSchema } : {}),
      ...(toolset ? { toolset } : {}),
    };
  },
});

export const TOOL_DISCOVERY_TOOLS = {
  listToolsTool,
  getToolDetailsTool,
};

import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import type { Agent as AgentRecord } from '@paperclip-mastra/db';
import { lmstudio, getModelId } from './provider';
import { CONTROL_PLANE_TOOLS } from './tools/control-plane-tools';
import { ROLE_TOOLS } from './tools/role-tools';
import { loadSkillsForAgent } from './skills/skill-loader';
import { buildMCPTools } from './tools/mcp-tools';

const memory = new Memory({
  storage: new PostgresStore({
    connectionString: process.env.DATABASE_URL!,
  }),
  options: {
    lastMessages: 20,
    semanticRecall: {
      topK: 5,
      messageRange: { before: 2, after: 2 },
    },
  },
});

/**
 * Create a fully-equipped Mastra Agent for a given agent DB record.
 * Tool tiers:
 *   Tier 1 (universal)     — CONTROL_PLANE_TOOLS (always included)
 *   Tier 2 (role-gated)    — ROLE_TOOLS by assignedToolsets
 *   Tier 3 (capability)    — MCP tools by mcpServerIds
 */
export async function createAgentWithSkills(
  agentRecord: AgentRecord
): Promise<Agent> {
  // ── Tier 1: Universal control plane tools
  const tools: Record<string, unknown> = { ...CONTROL_PLANE_TOOLS };

  // ── Tier 2: Role-gated toolsets
  for (const toolsetId of agentRecord.assignedToolsets ?? []) {
    const roleTools = ROLE_TOOLS[toolsetId];
    if (roleTools) Object.assign(tools, roleTools);
  }

  // ── Tier 3: MCP capability-gated tools
  if (agentRecord.mcpServerIds?.length) {
    const mcpTools = await buildMCPTools(agentRecord.mcpServerIds, agentRecord.companyId);
    Object.assign(tools, mcpTools);
  }

  // ── Assemble system prompt from AGENTS.md + SKILL.md files
  const skillContents = await loadSkillsForAgent(agentRecord);
  const systemPrompt = assembleSystemPrompt(agentRecord, skillContents);

  return new Agent({
    name: agentRecord.name,
    instructions: systemPrompt,
    model: lmstudio(getModelId(agentRecord.modelId)),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory,
  });
}

function assembleSystemPrompt(
  agentRecord: AgentRecord,
  skillContents: Array<{ slug: string; content: string }>
): string {
  const parts: string[] = [];

  if (agentRecord.instructionsBundleAgentsMd) {
    parts.push(`## Your Identity and Role\n\n${agentRecord.instructionsBundleAgentsMd}`);
  }

  for (const skill of skillContents) {
    parts.push(`---\n\n${skill.content}`);
  }

  return parts.join('\n\n');
}

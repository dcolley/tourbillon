import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { formatTrace, modelProviderOverridesFromAgent, resolveModelProviderConfig } from '@tourbillon/shared';
import { getEmbeddingModel, getLanguageModelForAgent } from './provider';
import { CONTROL_PLANE_TOOLS } from './tools/control-plane-tools';
import { ROLE_TOOLS } from './tools/role-tools';
import { loadSkillsForAgent } from './skills/skill-loader';
import { buildMCPTools } from './tools/mcp-tools';
import { getInternalApiUrl } from './tools/api-client';

const globalForMastra = globalThis as unknown as {
  mastraMemory?: Memory;
};

function getAgentMemory(): Memory {
  if (!globalForMastra.mastraMemory) {
    const connectionString = process.env.DATABASE_URL!;
    const semanticRecallEnabled = process.env.MEMORY_SEMANTIC_RECALL === 'true';
    const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL;

    const config: ConstructorParameters<typeof Memory>[0] = {
      storage: new PostgresStore({ id: 'tourbillon-memory', connectionString }),
      options: {
        lastMessages: 20,
        ...(semanticRecallEnabled && embeddingModel
          ? {
              semanticRecall: {
                topK: 5,
                messageRange: 2,
                scope: 'resource' as const,
              },
            }
          : {}),
      },
    };

    if (semanticRecallEnabled && embeddingModel) {
      config.vector = new PgVector({ id: 'tourbillon-vector', connectionString });
      config.embedder = getEmbeddingModel(embeddingModel);
    }

    globalForMastra.mastraMemory = new Memory(config);
  }
  return globalForMastra.mastraMemory;
}

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

  const providerOverrides = modelProviderOverridesFromAgent(
    agentRecord.adapterType,
    agentRecord.adapterConfig,
  );
  const providerConfig = resolveModelProviderConfig(providerOverrides, agentRecord.modelId);

  console.log(
    formatTrace('agent-factory', { agentId: agentRecord.id, agentName: agentRecord.name }, 'agent ready', {
      urlKey: agentRecord.urlKey,
      modelId: agentRecord.modelId,
      provider: providerConfig.provider,
      apiMode: providerConfig.apiMode,
      modelBaseURL: providerConfig.baseURL,
      apiBase: getInternalApiUrl(),
      toolCount: Object.keys(tools).length,
      tools: Object.keys(tools),
      skillCount: skillContents.length,
    })
  );

  return new Agent({
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory: getAgentMemory(),
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

import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
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
import { buildCodeExecutionWorkspace } from './execution-workspace';
import { getMastraInstance } from './mastra-instance';
import { isObservabilityEnabled } from '@tourbillon/shared';

const globalForMastra = globalThis as unknown as {
  mastraMemory?: Memory;
};

export function getAgentMemory(): Memory {
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

export async function assembleAgentTools(
  agentRecord: AgentRecord,
  options?: { allowedMcpServerIds?: string[] },
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = { ...CONTROL_PLANE_TOOLS };

  for (const toolsetId of agentRecord.assignedToolsets ?? []) {
    const roleTools = ROLE_TOOLS[toolsetId];
    if (roleTools) Object.assign(tools, roleTools);
  }

  if (agentRecord.mcpServerIds?.length) {
    const mcpTools = await buildMCPTools(
      agentRecord.mcpServerIds,
      agentRecord.companyId,
      options?.allowedMcpServerIds ?? [],
    );
    Object.assign(tools, mcpTools);
  }

  return tools;
}

export async function assembleAgentSystemPrompt(agentRecord: AgentRecord): Promise<string> {
  const skillContents = await loadSkillsForAgent(agentRecord);
  return assembleSystemPrompt(agentRecord, skillContents);
}

/**
 * Create a fully-equipped Mastra Agent for a given agent DB record.
 * Tool tiers:
 *   Tier 1 (universal)     — CONTROL_PLANE_TOOLS (always included)
 *   Tier 2 (role-gated)    — ROLE_TOOLS by assignedToolsets
 *   Tier 3 (capability)    — MCP tools by mcpServerIds
 */
export async function createAgentWithSkills(
  agentRecord: AgentRecord,
  options?: { allowedMcpServerIds?: string[] }
): Promise<Agent> {
  const tools = await assembleAgentTools(agentRecord, options);

  const skillContents = await loadSkillsForAgent(agentRecord);
  const systemPrompt = assembleSystemPrompt(agentRecord, skillContents);

  const providerOverrides = modelProviderOverridesFromAgent(
    agentRecord.adapterType,
    agentRecord.adapterConfig,
  );
  const providerConfig = resolveModelProviderConfig(providerOverrides, agentRecord.modelId);

  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;

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
      codeExecutionEnabled,
    })
  );

  const agent = new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory: getAgentMemory(),
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
  });

  return agent;
}

export async function createDurableAgentWithSkills(
  agentRecord: AgentRecord,
  options?: { allowedMcpServerIds?: string[]; maxSteps?: number },
): Promise<ReturnType<typeof createDurableAgent>> {
  const agent = await createAgentWithSkills(agentRecord, options);
  const durableAgent = createDurableAgent({
    agent,
    maxSteps: options?.maxSteps ?? 30,
  });

  // DurableAgent workflows read mastra.observability from __registerMastra on the
  // wrapper — registering only the inner Agent leaves spans with no exporter.
  if (isObservabilityEnabled()) {
    const mastra = getMastraInstance();
    mastra.removeAgent(agentRecord.id);
    mastra.addAgent(durableAgent, agentRecord.id);
  }

  return durableAgent;
}

function assembleSystemPrompt(
  agentRecord: AgentRecord,
  skillContents: Array<{ slug: string; content: string }>
): string {
  const parts: string[] = [];

  if (agentRecord.instructionsBundleSoulMd?.trim()) {
    parts.push(`## Your Soul\n\n${agentRecord.instructionsBundleSoulMd.trim()}`);
  }

  if (agentRecord.instructionsBundleAgentsMd?.trim()) {
    parts.push(`## Your Identity and Role\n\n${agentRecord.instructionsBundleAgentsMd.trim()}`);
  }

  for (const skill of skillContents) {
    parts.push(`---\n\n${skill.content}`);
  }

  return parts.join('\n\n');
}

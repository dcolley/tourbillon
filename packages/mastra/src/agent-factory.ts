import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { getLlmProviderRowById } from '@tourbillon/db';
import { formatTrace, modelProviderOverridesFromAgent, resolveModelProviderConfig, resolveAssignedTools, type AgentRuntimeConfig, type CompanySettings, isSearxngConfigured } from '@tourbillon/shared';
import { getEmbeddingModel, getLanguageModelForAgent, llmProviderRowToRecord } from './provider';
import { CONTROL_PLANE_TOOLS } from './tools/control-plane-tools';
import { ROLE_TOOLS } from './tools/role-tools';
import { assignableToolsForIds } from './tools/assignable-tools';
import { loadSkillsForAgent } from './skills/skill-loader';
import { buildMCPTools } from './tools/mcp-tools';
import { SEARXNG_TOOLS } from './tools/searxng-tools';
import { getInternalApiUrl } from './tools/api-client';
import { buildCodeExecutionWorkspace } from './execution-workspace';
import { resolveAgentModelSettings } from './model-settings';
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

export interface AssembleAgentToolsOptions {
  allowedMcpServerIds?: string[];
  companySettings?: CompanySettings | null;
}

export async function assembleAgentTools(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = { ...CONTROL_PLANE_TOOLS };
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const companySettings = options?.companySettings ?? null;

  const booleanToolsets = (agentRecord.assignedToolsets ?? []).filter((id) => id !== 'planning');
  for (const toolsetId of booleanToolsets) {
    const roleTools = ROLE_TOOLS[toolsetId];
    if (roleTools) Object.assign(tools, roleTools);
  }

  if (!isSearxngConfigured(companySettings, runtimeConfig)) {
    for (const key of Object.keys(SEARXNG_TOOLS)) {
      delete tools[key];
    }
  }

  const assignedToolIds = resolveAssignedTools({
    role: agentRecord.role,
    assignedToolsets: agentRecord.assignedToolsets,
    runtimeConfig,
  });
  Object.assign(tools, assignableToolsForIds(assignedToolIds));

  const needsMcp =
    (agentRecord.assignedToolsets?.includes('buffer') ?? false) ||
    (agentRecord.mcpServerIds?.length ?? 0) > 0;

  if (needsMcp) {
    const mcpTools = await buildMCPTools(agentRecord, {
      allowedMcpServerIds: options?.allowedMcpServerIds ?? [],
      companySettings,
    });
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
 *   Tier 2 (role-gated)    — boolean ROLE_TOOLS by assignedToolsets + granular tools by runtimeConfig.assignedTools
 *   Tier 3 (capability)    — MCP tools by mcpServerIds
 */
export async function createAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions
): Promise<Agent> {
  const tools = await assembleAgentTools(agentRecord, options);

  const skillContents = await loadSkillsForAgent(agentRecord);
  const systemPrompt = assembleSystemPrompt(agentRecord, skillContents);

  const providerOverrides = modelProviderOverridesFromAgent(
    agentRecord.adapterType,
    agentRecord.adapterConfig,
  );
  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const providerConfig = resolveModelProviderConfig(
    providerOverrides,
    agentRecord.modelId,
    providerRecord,
  );

  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;
  const modelSettings = resolveAgentModelSettings(agentRecord, providerRecord);

  console.log(
    formatTrace('agent-factory', { agentId: agentRecord.id, agentName: agentRecord.name }, 'agent ready', {
      urlKey: agentRecord.urlKey,
      modelId: agentRecord.modelId,
      provider: providerConfig.provider,
      providerId: providerConfig.providerId,
      providerName: providerConfig.providerName,
      apiMode: providerConfig.apiMode,
      modelBaseURL: providerConfig.baseURL,
      apiBase: getInternalApiUrl(),
      toolCount: Object.keys(tools).length,
      tools: Object.keys(tools),
      skillCount: skillContents.length,
      codeExecutionEnabled,
      modelSettings,
    })
  );

  const agent = new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord, providerRecord),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory: getAgentMemory(),
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...(modelSettings ? { defaultOptions: { modelSettings } } : {}),
  });

  return agent;
}

export async function createDurableAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & { maxSteps?: number },
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

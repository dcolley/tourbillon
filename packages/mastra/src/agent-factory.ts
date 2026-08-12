import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { getLlmProviderRowById } from '@tourbillon/db';
import {
  formatTrace,
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
  resolveAssignedTools,
  resolveObservationalMemoryModel,
  type AgentRuntimeConfig,
  type CompanySettings,
  isSearxngConfigured,
  isTavilyConfigured,
  isCodeExecutionAvailable,
} from '@tourbillon/shared';
import {
  getEmbeddingModel,
  getLanguageModelForAgent,
  getLanguageModelForProviderRecord,
  llmProviderRowToRecord,
} from './provider';
import { CONTROL_PLANE_TOOLS } from './tools/control-plane-tools';
import { ROLE_TOOLS } from './tools/role-tools';
import { assignableToolsForIds } from './tools/assignable-tools';
import {
  formatSkillsCatalogSection,
  prepareAgentSkills,
} from './skills/on-demand-skills';
import { agentNeedsMcpTools } from '@tourbillon/shared/mcp-registry';
import { buildMCPTools } from './tools/mcp-tools';
import { SEARXNG_TOOLS } from './tools/searxng-tools';
import { TAVILY_TOOLS } from './tools/tavily-tools';
import { getInternalApiUrl } from './tools/api-client';
import { buildCodeExecutionWorkspace } from './execution-workspace';
import { resolveAgentGenerationOptions, toMastraDefaultOptions } from './model-settings';
import { getMastraInstance } from './mastra-instance';
import { isMastraTracingEnabled } from '@tourbillon/shared';
import {
  buildHeartbeatInputProcessors,
  resolveHeartbeatContextTokenLimit,
} from './heartbeat-processors';

const globalForMastra = globalThis as unknown as {
  /** Memory instances keyed by OM config (or `base` when OM is off). */
  mastraMemoryByKey?: Map<string, Memory>;
};

function memoryCacheKey(companySettings?: CompanySettings | null): string {
  const om = resolveObservationalMemoryModel(companySettings);
  return om ? `om:${om.providerId}:${om.modelId}` : 'base';
}

/**
 * Shared Mastra Memory for durable Agent and harness AgentController.
 * When company Observational Memory is configured, returns a Memory with OM
 * enabled using that provider/model (never the Gemini default).
 */
export async function getAgentMemory(
  companySettings?: CompanySettings | null,
): Promise<Memory> {
  if (!globalForMastra.mastraMemoryByKey) {
    globalForMastra.mastraMemoryByKey = new Map();
  }
  const key = memoryCacheKey(companySettings);
  const cached = globalForMastra.mastraMemoryByKey.get(key);
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL!;
  const semanticRecallEnabled = process.env.MEMORY_SEMANTIC_RECALL === 'true';
  const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL;
  const om = resolveObservationalMemoryModel(companySettings);

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

  if (om) {
    const omModel = await getLanguageModelForProviderRecord(om.providerId, om.modelId);
    config.options = {
      ...config.options,
      observationalMemory: {
        // Explicit LanguageModel — never observationalMemory: true (Gemini default).
        model: omModel,
        scope: 'thread',
        observation: {
          messageTokens: 30_000,
          bufferOnIdle: true,
        },
        reflection: {
          observationTokens: 40_000,
        },
      },
    };
  }

  if (semanticRecallEnabled && embeddingModel) {
    config.vector = new PgVector({ id: 'tourbillon-vector', connectionString });
    config.embedder = getEmbeddingModel(embeddingModel);
  }

  const memory = new Memory(config);
  globalForMastra.mastraMemoryByKey.set(key, memory);
  return memory;
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

  if (!isTavilyConfigured(companySettings, runtimeConfig)) {
    for (const key of Object.keys(TAVILY_TOOLS)) {
      delete tools[key];
    }
  }

  const assignedToolIds = resolveAssignedTools({
    role: agentRecord.role,
    assignedToolsets: agentRecord.assignedToolsets,
    runtimeConfig,
  });
  Object.assign(tools, assignableToolsForIds(assignedToolIds));

  if (agentNeedsMcpTools(agentRecord)) {
    const mcpTools = await buildMCPTools(agentRecord, {
      allowedMcpServerIds: options?.allowedMcpServerIds ?? [],
      companySettings,
    });
    Object.assign(tools, mcpTools);
  }

  return tools;
}

export async function shouldAttachCodeExecutionWorkspace(
  agentRecord: AgentRecord,
): Promise<boolean> {
  const toolsetOn = agentRecord.assignedToolsets?.includes('code-execution') ?? false;
  if (!toolsetOn) return false;

  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const availability = await isCodeExecutionAvailable(runtimeConfig);
  if (!availability.available) {
    console.warn(
      formatTrace(
        'agent-factory',
        { agentId: agentRecord.id, agentName: agentRecord.name },
        'code execution unavailable — workspace omitted',
        { reason: availability.reason },
      ),
    );
    return false;
  }
  return true;
}

export async function assembleAgentSystemPrompt(agentRecord: AgentRecord): Promise<string> {
  const prepared = await prepareAgentSkills(agentRecord);
  return assembleSystemPrompt(agentRecord, prepared);
}

/**
 * Create a fully-equipped Mastra Agent for a given agent DB record.
 * Tool tiers:
 *   Tier 1 (universal)     — CONTROL_PLANE_TOOLS (always included; includes listSkills/getSkill)
 *   Tier 2 (role-gated)    — boolean ROLE_TOOLS by assignedToolsets + granular tools by runtimeConfig.assignedTools
 *   Tier 3 (capability)    — MCP tools by mcpServerIds
 *
 * Skills: control-plane is inlined; other skills are listed in a catalog and loaded via getSkill.
 */
export async function createAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions
): Promise<Agent> {
  const tools = await assembleAgentTools(agentRecord, options);

  const prepared = await prepareAgentSkills(agentRecord);
  const systemPrompt = assembleSystemPrompt(agentRecord, prepared);

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

  const codeExecutionEnabled = await shouldAttachCodeExecutionWorkspace(agentRecord);
  const generationOptions = resolveAgentGenerationOptions(agentRecord, providerRecord);
  const inputProcessors = buildHeartbeatInputProcessors();

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
      skillCount: prepared.catalog.length,
      alwaysInlineSkills: prepared.alwaysInline.map((s) => s.slug),
      onDemandSkills: prepared.catalog.filter((s) => !s.alwaysInline).map((s) => s.slug),
      contextTokenLimit: resolveHeartbeatContextTokenLimit(),
      codeExecutionEnabled,
      modelSettings: generationOptions.modelSettings,
      reasoning: generationOptions.reasoning,
    })
  );

  const agent = new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord, providerRecord),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory: await getAgentMemory(options?.companySettings ?? null),
    inputProcessors,
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...toMastraDefaultOptions(generationOptions),
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
  if (isMastraTracingEnabled()) {
    const mastra = getMastraInstance();
    mastra.removeAgent(agentRecord.id);
    mastra.addAgent(durableAgent, agentRecord.id);
  }

  return durableAgent;
}

function assembleSystemPrompt(
  agentRecord: AgentRecord,
  prepared: Awaited<ReturnType<typeof prepareAgentSkills>>,
): string {
  const parts: string[] = [];

  if (agentRecord.instructionsBundleSoulMd?.trim()) {
    parts.push(`## Your Soul\n\n${agentRecord.instructionsBundleSoulMd.trim()}`);
  }

  if (agentRecord.instructionsBundleAgentsMd?.trim()) {
    parts.push(`## Your Identity and Role\n\n${agentRecord.instructionsBundleAgentsMd.trim()}`);
  }

  // Baked-in control-plane (and any other always-inline skills) first.
  for (const skill of prepared.alwaysInline) {
    parts.push(`---\n\n${skill.content}`);
  }

  const catalogSection = formatSkillsCatalogSection(prepared.catalog);
  if (catalogSection) {
    parts.push(`---\n\n${catalogSection}`);
  }

  return parts.join('\n\n');
}

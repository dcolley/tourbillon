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
  resolveAllowedToolNames,
  resolveObservationalMemoryModel,
  resolveObservationalMemorySettings,
  type AgentRuntimeConfig,
  type CompanySettings,
  isCodeExecutionAvailable,
  toolKeyForId,
} from '@tourbillon/shared';
import {
  getEmbeddingModel,
  getLanguageModelForAgent,
  getLanguageModelForProviderRecord,
  llmProviderRowToRecord,
} from './provider';
import { CONTROL_PLANE_TOOLS } from './tools/control-plane-tools';
import { ROLE_TOOLS } from './tools/role-tools';
import { ASSIGNABLE_TOOLS } from './tools/assignable-tools';
import {
  formatSkillsCatalogSection,
  prepareAgentSkills,
} from './skills/on-demand-skills';
import { agentNeedsMcpTools } from '@tourbillon/shared/mcp-registry';
import { buildMCPTools } from './tools/mcp-tools';
import { withAgentSecretRedaction } from './tools/redact-tool-output';
import { getInternalApiUrl } from './tools/api-client';
import { buildCodeExecutionWorkspace } from './execution-workspace';
import {
  resolveAgentContextBudget,
  resolveAgentGenerationOptions,
  toMastraDefaultOptions,
} from './model-settings';
import { getMastraInstance } from './mastra-instance';
import { isMastraTracingEnabled } from '@tourbillon/shared';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';
import { assertMastraToolRegistryEmpty, gatedAgentOptions, type ToolGateSurface } from './tool-gate';

const globalForMastra = globalThis as unknown as {
  /** Memory instances keyed by resolved OM config (or `base` when OM is off). */
  mastraMemoryByKey?: Map<string, Memory>;
};

/**
 * Shared Mastra Memory for durable Agent and harness AgentController.
 * When agent or company Observational Memory is configured, returns a Memory with OM
 * enabled using the resolved provider/model/thresholds (never the Gemini default).
 */
export async function getAgentMemory(
  companySettings?: CompanySettings | null,
  agentRuntime?: AgentRuntimeConfig | null,
): Promise<Memory> {
  if (!globalForMastra.mastraMemoryByKey) {
    globalForMastra.mastraMemoryByKey = new Map();
  }
  const { memoryCacheKeyForAgent, resolveAgentObservationalMemory } = await import(
    '@tourbillon/shared/company-settings'
  );
  const key = memoryCacheKeyForAgent(companySettings, agentRuntime);
  const cached = globalForMastra.mastraMemoryByKey.get(key);
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL!;
  const semanticRecallEnabled = process.env.MEMORY_SEMANTIC_RECALL === 'true';
  const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL;
  const resolved = resolveAgentObservationalMemory(companySettings, agentRuntime);

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

  if (resolved) {
    const omModel = await getLanguageModelForProviderRecord(resolved.providerId, resolved.modelId);
    config.options = {
      ...config.options,
      observationalMemory: {
        // Explicit LanguageModel — never observationalMemory: true (Gemini default).
        model: omModel,
        scope: 'thread',
        observation: {
          messageTokens: resolved.observeAfterTokens,
          bufferOnIdle: true,
          modelSettings: {
            maxOutputTokens: resolved.maxOutputTokens,
            ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
          },
        },
        reflection: {
          observationTokens: resolved.reflectAfterTokens,
          modelSettings: {
            maxOutputTokens: resolved.maxOutputTokens,
            ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
          },
        },
      },
    };
  }

  if (semanticRecallEnabled && embeddingModel) {
    config.vector = new PgVector({ id: 'tourbillon-vector', connectionString });
    config.embedder = getEmbeddingModel(embeddingModel) as any;
  }

  const memory = new Memory(config);
  globalForMastra.mastraMemoryByKey.set(key, memory);
  return memory;
}

export interface AssembleAgentToolsOptions {
  allowedMcpServerIds?: string[];
  companySettings?: CompanySettings | null;
  /** Where the tools run (permission gate surface). Default: heartbeat. */
  surface?: ToolGateSurface;
}

/** Every static (non-MCP) tool by tool id. Selection comes from resolveAllowedToolNames. */
export const STATIC_TOOLS_BY_ID: Readonly<Record<string, unknown>> = (() => {
  const byId: Record<string, unknown> = {};
  const add = (tool: unknown) => {
    const id = (tool as { id?: unknown } | null)?.id;
    if (typeof id === 'string') byId[id] = tool;
  };
  for (const tool of Object.values(CONTROL_PLANE_TOOLS)) add(tool);
  for (const toolset of Object.values(ROLE_TOOLS)) for (const tool of Object.values(toolset)) add(tool);
  for (const tool of Object.values(ASSIGNABLE_TOOLS)) add(tool);
  return byId;
})();

export async function assembleAgentTools(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<Record<string, unknown>> {
  const companySettings = options?.companySettings ?? null;
  const tools: Record<string, unknown> = {};

  // Same allow-list the live tool permission gate evaluates per call (no drift).
  const allowed = resolveAllowedToolNames(agentRecord, { settings: companySettings });
  for (const toolId of allowed.staticToolIds) {
    const tool = STATIC_TOOLS_BY_ID[toolId];
    if (tool) tools[toolKeyForId(toolId)] = tool;
  }

  if (agentNeedsMcpTools(agentRecord)) {
    const mcpTools = await buildMCPTools(agentRecord, {
      allowedMcpServerIds: options?.allowedMcpServerIds ?? [],
      companySettings,
    });
    Object.assign(tools, mcpTools);
  }

  // #100: one choke point — no tool result may carry agent runtimeConfig secret values.
  // Each tool is also bound to this agent and re-checked against its live allow-list per call.
  return withAgentSecretRedaction(tools, {
    agentId: agentRecord.id,
    companyId: agentRecord.companyId,
    surface: options?.surface ?? 'heartbeat',
  });
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
  const tools = await assembleAgentTools(agentRecord, { ...options, surface: 'heartbeat' });

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
  const contextBudget = resolveAgentContextBudget(agentRecord, providerRecord, 'durable');
  const inputProcessors = buildHeartbeatInputProcessors({ limit: contextBudget.limiterLimit });

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
      contextTokenLimit: contextBudget.limiterLimit,
      maxContextTokens: contextBudget.contextTokens,
      outputReserve: contextBudget.outputReserve,
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
    ...(gatedAgentOptions(
      { agentId: agentRecord.id, companyId: agentRecord.companyId, surface: 'heartbeat' },
      tools,
    ) as object),
    memory: await getAgentMemory(options?.companySettings ?? null, agentRecord.runtimeConfig as AgentRuntimeConfig),
    inputProcessors,
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...toMastraDefaultOptions(generationOptions),
  });

  return agent;
}

export async function createDurableAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & { maxSteps?: number },
): Promise<any> {
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
    // Agent tools are resolved per agent (function-valued); none may land in the instance registry.
    assertMastraToolRegistryEmpty(mastra);
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

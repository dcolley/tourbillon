import { Agent } from '@mastra/core/agent';
import { createDurableAgent } from '@mastra/core/agent/durable';
import { Memory } from '@mastra/memory';
import { PostgresStore, PgVector } from '@mastra/pg';
import type { Agent as AgentRecord } from '@tourbillon/db';
import { resolveAgentProviderRow } from './company-provider';
import {
  CHAT_MEMORY_LAST_MESSAGES,
  formatTrace,
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
  resolveAssignedTools,
  resolveObservationalMemoryModel,
  resolveObservationalMemorySettings,
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
import { CHAT_TASK_TOOLS } from './tools/chat-task-tools';
import {
  formatSkillsCatalogSection,
  prepareAgentSkills,
} from './skills/on-demand-skills';
import { agentNeedsMcpTools } from '@tourbillon/shared/mcp-registry';
import { buildMCPTools } from './tools/mcp-tools';
import { withAgentSecretRedaction } from './tools/redact-tool-output';
import { SEARXNG_TOOLS } from './tools/searxng-tools';
import { TAVILY_TOOLS } from './tools/tavily-tools';
import { getInternalApiUrl } from './tools/api-client';
import { buildCodeExecutionWorkspace } from './execution-workspace';
import { buildAgentBrowser } from './browser';
import {
  resolveAgentContextBudget,
  resolveAgentGenerationOptions,
  toMastraDefaultOptions,
} from './model-settings';
import { getMastraInstance } from './mastra-instance';
import { isMastraTracingEnabled } from '@tourbillon/shared';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';
import { requireDatabaseUrl } from '@tourbillon/db/database-url';

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
  /**
   * CONCIERGE-OM: 'chat' forces the chat OM resolution (OM always attempted,
   * company `enabled:false` / agent `mode:'off'` ignored) and uses a separate
   * cache-key namespace so a chat controller never reuses a heartbeat-scoped
   * Memory instance whose OM resolved differently. 'heartbeat' (default) keeps
   * the existing optional-OM semantics unchanged.
   */
  memoryScope?: 'heartbeat' | 'chat',
): Promise<Memory> {
  if (!globalForMastra.mastraMemoryByKey) {
    globalForMastra.mastraMemoryByKey = new Map();
  }
  const chatScope = memoryScope === 'chat';
  const {
    memoryCacheKeyForAgent,
    resolveAgentObservationalMemory,
    memoryCacheKeyForChat,
    resolveChatObservationalMemory,
  } = await import('@tourbillon/shared/company-settings');
  const key = chatScope
    ? memoryCacheKeyForChat(companySettings, agentRuntime)
    : memoryCacheKeyForAgent(companySettings, agentRuntime);
  const cached = globalForMastra.mastraMemoryByKey.get(key);
  if (cached) return cached;

  const connectionString = requireDatabaseUrl('agent memory storage');
  const semanticRecallEnabled = process.env.MEMORY_SEMANTIC_RECALL === 'true';
  const embeddingModel = process.env.MEMORY_EMBEDDING_MODEL;
  const resolved = chatScope
    ? resolveChatObservationalMemory(companySettings, agentRuntime)
    : resolveAgentObservationalMemory(companySettings, agentRuntime);

  const config: ConstructorParameters<typeof Memory>[0] = {
    storage: new PostgresStore({ id: 'tourbillon-memory', connectionString }),
    options: {
      lastMessages: CHAT_MEMORY_LAST_MESSAGES,
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
  /**
   * TASK-1: dashboard-chat only — add the agent's private chat task list tools
   * (chat_tasks). Heartbeat / DurableAgent assemblies never set this, so the five
   * list tools stay out of every non-chat run.
   */
  chatTaskTools?: boolean;
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

  // Remove sendToAgent when DMs are disabled (default: enabled)
  const mailEnabled = runtimeConfig.mail?.enabled ?? true;
  if (!mailEnabled) {
    delete tools.sendToAgentTool;
  }

  // TASK-1: the private per-agent chat task list (chat_tasks) — chat AgentController only.
  if (options?.chatTaskTools) {
    Object.assign(tools, CHAT_TASK_TOOLS);
  }

  // #100: one choke point — no tool result may carry agent runtimeConfig secret values.
  return withAgentSecretRedaction(tools);
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
  // PRV-1: honour the company's provider switches (the wake runner records the warning).
  const { row: providerRow } = await resolveAgentProviderRow(agentRecord, { context: 'heartbeat' });
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const providerConfig = resolveModelProviderConfig(
    providerOverrides,
    agentRecord.modelId,
    providerRecord,
  );

  const codeExecutionEnabled = await shouldAttachCodeExecutionWorkspace(agentRecord);
  // Opt-in `browser` toolset: local headless Chromium, egress-guarded, closed at run end
  // by the wake runner (closeAgentBrowser). Undefined when the toolset is off.
  const browser = await buildAgentBrowser(agentRecord, {
    companySettings: options?.companySettings ?? null,
  });
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
      browserEnabled: Boolean(browser),
      modelSettings: generationOptions.modelSettings,
      reasoning: generationOptions.reasoning,
    })
  );

  const agent = new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord, providerRecord),
    tools: tools as any,
    memory: await getAgentMemory(options?.companySettings ?? null, agentRecord.runtimeConfig as AgentRuntimeConfig),
    inputProcessors,
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...(browser ? { browser } : {}),
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

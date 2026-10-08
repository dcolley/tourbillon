/**
 * Interactive dashboard chat via AgentController — orthogonal to WakeRunner heartbeats.
 * No control-plane inline; same tools as heartbeat; dedicated thread storage.
 */
import type { Agent as AgentRecord } from '@tourbillon/db';
import type {
  AgentController,
  AgentControllerMode,
  Session,
} from '@mastra/core/agent-controller';
import { AgentController as AgentControllerClass } from '@mastra/core/agent-controller';
import { Agent } from '@mastra/core/agent';
import { PostgresStore } from '@mastra/pg';
import {
  formatTrace,
  resolveObservationalMemoryModel,
  isMastraTracingEnabled,
  type CompanySettings,
  type AgentRuntimeConfig,
} from '@tourbillon/shared';
import {
  assembleAgentTools,
  getAgentMemory,
  type AssembleAgentToolsOptions,
} from './agent-factory';
import {
  formatChatSkillsCatalogSection,
  prepareAgentSkills,
} from './skills/on-demand-skills';
import {
  getLanguageModelForAgent,
  resolveAgentModelProvider,
  resolveAgentProviderRecord,
} from './provider';
import {
  resolveAgentContextBudget,
  resolveAgentGenerationOptions,
  toMastraDefaultOptions,
} from './model-settings';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';
import { getMastraInstance } from './mastra-instance';
import { buildChatWorkspace } from './execution-workspace';
import { getInternalApiUrl } from './tools/api-client';

const CHAT_IDENTITY_CHAR_LIMIT = 2000;

const CHAT_MODE_INSTRUCTIONS = `## Chat Mode

You are in a live dashboard conversation with a human operator — **not** a heartbeat wake.

Rules:
- Answer questions, discuss work, and use tools when they help the human.
- Do **not** run the control-plane heartbeat procedure (no inbox scan, checkout, or EXIT ritual).
- Do **not** mutate issues, goals, or projects unless the human clearly asks — prefer explaining and drafting.
- Do **not** sendToAgent / send mail unless the human clearly asks.
- You **may** read mail via \`getMessages\` when the human asks about your messages, or after you send a DM you are waiting on.
- If the human wants autonomous work done, suggest assigning an issue or using Wake / Run heartbeat.
- When methodology is needed, call \`getSkill(slug)\` first.
- When unsure what tools you have or how to use them, call \`listTools\` and \`getToolDetails(id)\`.
- Stay in the conversation; do not end with "EXIT".
- Page context may appear in a \`[Dashboard context]\` block on the human's message — treat that as authoritative for "this issue/goal/project".`;

export type ChatControllerState = {
  yolo?: boolean;
  permissionRules?: ReturnType<typeof buildChatPermissionRules>;
  chatContext?: {
    contextType?: string;
    contextId?: string;
    title?: string;
  };
  [key: string]: unknown;
};

export type ChatResourceContext = {
  contextType?: string;
  contextId?: string;
};

/**
 * Chat threads are scoped by company + dashboard context (issue/project/…),
 * not by agent — so you can switch agents and resume the same thread.
 */
export function buildChatResourceId(
  companyId: string,
  context: ChatResourceContext = {},
): string {
  const type = (context.contextType ?? 'free').trim() || 'free';
  const id = context.contextId?.trim();
  if (type === 'free' || !id) {
    return `company-${companyId}:chat:free`;
  }
  return `company-${companyId}:chat:${type}:${id}`;
}

export function buildChatControllerId(agentId: string, modelId?: string): string {
  const modelKey = modelId?.trim();
  return modelKey
    ? `tourbillon-chat-${agentId}::${modelKey}`
    : `tourbillon-chat-${agentId}`;
}

export function buildChatPermissionRules() {
  return {
    categories: {
      read: 'allow' as const,
      edit: 'deny' as const,
      execute: 'deny' as const,
      mcp: 'allow' as const,
    },
    tools: {} as Record<string, 'allow' | 'ask' | 'deny'>,
  };
}

function toolIdOf(key: string, tool: unknown): string {
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

function truncateForChat(text: string, limit = CHAT_IDENTITY_CHAR_LIMIT): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 1)}…`;
}

function assembleChatSystemPrompt(
  agentRecord: AgentRecord,
  prepared: Awaited<ReturnType<typeof prepareAgentSkills>>,
  toolIds: string[],
): string {
  const parts: string[] = [];

  if (agentRecord.instructionsBundleSoulMd?.trim()) {
    parts.push(
      `## Your Soul\n\n${truncateForChat(agentRecord.instructionsBundleSoulMd)}`,
    );
  }

  if (agentRecord.instructionsBundleAgentsMd?.trim()) {
    parts.push(
      `## Your Identity and Role\n\n${truncateForChat(agentRecord.instructionsBundleAgentsMd)}`,
    );
  }

  parts.push(CHAT_MODE_INSTRUCTIONS);

  for (const skill of prepared.alwaysInline) {
    parts.push(`---\n\n${skill.content}`);
  }

  const catalogSection = formatChatSkillsCatalogSection(prepared.catalog);
  if (catalogSection) {
    parts.push(`---\n\n${catalogSection}`);
  }

  // Tool discovery: listTools and getToolDetails are available for on-demand schema lookup.
  if (toolIds.length > 0) {
    parts.push(
      `---\n\n## Tools (on demand)\n\nYou have ${toolIds.length} tools available. Use \`listTools\` for a compact catalog and \`getToolDetails(id)\` for full schemas when needed.`,
    );
  }

  return parts.join('\n\n');
}

/**
 * Mastra Agent for interactive chat — same identity/model/tools as heartbeat, no control-plane loop.
 */
export async function createChatAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & { modelIdOverride?: string },
): Promise<Agent> {
  const effectiveRecord =
    options?.modelIdOverride && options.modelIdOverride !== agentRecord.modelId
      ? { ...agentRecord, modelId: options.modelIdOverride }
      : agentRecord;
  const tools = await assembleAgentTools(effectiveRecord, options);
  const prepared = await prepareAgentSkills(effectiveRecord, { mode: 'chat' });
  const toolIds = Object.values(tools)
    .map((t) =>
      t && typeof t === 'object' && 'id' in t && typeof (t as { id: unknown }).id === 'string'
        ? (t as { id: string }).id
        : null,
    )
    .filter((id): id is string => Boolean(id));
  const systemPrompt = assembleChatSystemPrompt(effectiveRecord, prepared, toolIds);

  // Agent's provider → registry default → env; host-mismatched base URL override → 409 error.
  const { record: providerRecord, config: providerConfig } =
    await resolveAgentModelProvider(effectiveRecord);
  const generationOptions = resolveAgentGenerationOptions(effectiveRecord, providerRecord);
  const contextBudget = resolveAgentContextBudget(effectiveRecord, providerRecord, 'chat');

  // Same Responses-API history sanitization as heartbeats (reasoning + tool-loop monologue).
  const inputProcessors = buildHeartbeatInputProcessors({ limit: contextBudget.limiterLimit });

  // Interactive chat is multi-turn. vLLM `/v1/responses` often crashes on replayed
  // assistant history (`AI_APICallError: 'role'`). Force chat-completions for chat only;
  // heartbeats keep the provider's configured apiMode.
  const chatApiMode = 'chat' as const;

  console.log(
    formatTrace('chat-agent', { agentId: effectiveRecord.id, agentName: effectiveRecord.name }, 'chat agent ready', {
      urlKey: effectiveRecord.urlKey,
      modelId: effectiveRecord.modelId,
      provider: providerConfig.provider,
      apiMode: chatApiMode,
      providerApiMode: providerConfig.apiMode,
      apiBase: getInternalApiUrl(),
      toolCount: toolIds.length,
      tools: toolIds,
      skillCount: prepared.catalog.length,
    }),
  );

  return new Agent({
    id: `${effectiveRecord.id}-chat`,
    name: `${effectiveRecord.name} (chat)`,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(effectiveRecord, providerRecord, {
      apiModeOverride: chatApiMode,
    }),
    tools: tools as never,
    memory: await getAgentMemory(options?.companySettings ?? null, effectiveRecord.runtimeConfig as AgentRuntimeConfig),
    inputProcessors,
    ...toMastraDefaultOptions(generationOptions),
  });
}

let chatThreadStorage: PostgresStore | null = null;

function getChatThreadStorage(): PostgresStore {
  if (!chatThreadStorage) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for chat controller storage');
    }
    chatThreadStorage = new PostgresStore({
      id: 'tourbillon-chat-threads',
      connectionString,
    });
  }
  return chatThreadStorage;
}

export function getChatThreadStorageForTests(): PostgresStore {
  return getChatThreadStorage();
}

/**
 * AgentController for dashboard chat. Long-lived in the web process — not destroyed per wake.
 */
export async function createChatController(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & {
    companySettings?: CompanySettings | null;
    modelIdOverride?: string;
  },
): Promise<AgentController<ChatControllerState>> {
  const agent = await createChatAgentWithSkills(agentRecord, options);
  const modes: AgentControllerMode[] = [
    {
      id: 'chat',
      name: 'Chat',
      metadata: { default: true },
      ...(options?.modelIdOverride
        ? { defaultModelId: options.modelIdOverride }
        : agentRecord.modelId
          ? { defaultModelId: agentRecord.modelId }
          : {}),
    },
  ];

  const { resolveAgentObservationalMemory } = await import('@tourbillon/shared/company-settings');
  const resolved = resolveAgentObservationalMemory(
    options?.companySettings ?? null,
    agentRecord.runtimeConfig as AgentRuntimeConfig,
  );
  const memory = await getAgentMemory(options?.companySettings ?? null, agentRecord.runtimeConfig as AgentRuntimeConfig);
  const { record: providerRecord } = await resolveAgentProviderRecord(agentRecord);
  const contextBudget = resolveAgentContextBudget(agentRecord, providerRecord, 'chat');

  // Session always requires a Workspace instance (Mastra AgentController contract).
  // Chat uses a tools-disabled workspace so sandbox schemas do not inflate context.
  return new AgentControllerClass<ChatControllerState>({
    id: buildChatControllerId(agentRecord.id, options?.modelIdOverride),
    resourceId: buildChatResourceId(agentRecord.companyId, { contextType: 'free' }),
    storage: getChatThreadStorage(),
    memory,
    agent,
    modes,
    workspace: buildChatWorkspace(),
    initialState: {
      yolo: true,
      permissionRules: buildChatPermissionRules(),
    },
    ...(isMastraTracingEnabled()
      ? { observability: getMastraInstance().observability }
      : {}),
    ...(resolved
      ? {
          omConfig: {
            defaultObserverModelId: resolved.modelId,
            defaultReflectorModelId: resolved.modelId,
            defaultObservationThreshold: resolved.observeAfterTokens,
            defaultReflectionThreshold: resolved.reflectAfterTokens,
            ...(resolved.maxOutputTokens ? { defaultMaxOutputTokens: resolved.maxOutputTokens } : {}),
            ...(resolved.temperature !== undefined ? { defaultTemperature: resolved.temperature } : {}),
          },
        }
      : {}),
    disableBuiltinTools: ['ask_user', 'submit_plan', 'subagent'],
  });
}

/** Cap chat thread history for Memory recall (UI still lists full stored messages). */
export const CHAT_THREAD_MESSAGE_CAP = 40;

/**
 * Bind session to a thread id, creating it with optional metadata tags when missing.
 */
export async function ensureChatThread(
  session: Session<ChatControllerState>,
  threadId: string,
  opts?: { title?: string; metadata?: Record<string, string> },
): Promise<void> {
  const existing = await session.thread.getById({ threadId });
  if (!existing) {
    const resourceId = session.identity.getResourceId();
    const now = new Date();
    const memory = await getChatThreadStorage().getStore('memory');
    if (!memory) {
      throw new Error('Chat memory store unavailable');
    }
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: opts?.title ?? threadId,
        createdAt: now,
        updatedAt: now,
        metadata: {
          kind: 'chat',
          ...(opts?.metadata ?? {}),
        },
      },
    });
  }

  if (session.thread.getId() !== threadId) {
    await session.thread.switch({ threadId });
  }
}

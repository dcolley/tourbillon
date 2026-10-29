/**
 * Interactive dashboard chat via AgentController — orthogonal to WakeRunner heartbeats.
 * No control-plane inline; same tools as heartbeat; dedicated thread storage.
 */
import type { Agent as AgentRecord } from '@tourbillon/db';
import { resolveAgentProviderRow } from './company-provider';
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
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
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
import { getLanguageModelForAgent, llmProviderRowToRecord } from './provider';
import {
  resolveAgentContextBudget,
  resolveAgentGenerationOptions,
  toMastraDefaultOptions,
} from './model-settings';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';
import { getMastraInstance } from './mastra-instance';
import { buildChatWorkspace } from './execution-workspace';
import { getInternalApiUrl } from './tools/api-client';
import { requestScopedTools } from './tools/widget-tools';
import { requireDatabaseUrl } from '@tourbillon/db/database-url';
import {
  ChatProviderUnavailableError,
  chatEffectiveRecord,
  chatModelOverrideKey,
  chatModelSource,
  type ChatModelOverrideOptions,
} from './chat-model-override';

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
- You have a **private chat task list** for this conversation (\`listMyTasks\`, \`addMyTask\`, \`updateMyTask\`, \`completeMyTask\`, \`cancelMyTask\`). It tracks what YOU promised in this chat — it is **not** company issues. When you commit to multi-step work, or the human asks you to remember something, add items; keep statuses current (\`waiting_on_user\` when you need their input).
- When the human asks what is left, what you are working on, your status, what you promised, or whether something got done: call \`listMyTasks\` and answer in plain language from the result. Do **not** call \`getInbox\`, \`getHeartbeatContext\`, \`searchIssues\`, or follow \`plan-to-tasks\` for those — assigned company issues are a separate system; check \`getInbox\` only when the human explicitly asks about issues/inbox/board.
- Never create company issues to track your own chat to-dos. If your list is empty, say so — do not invent items. The human may edit the list by talking ("drop the second one", "rename X", "add Y"); apply the change with the list tools.
- Background **Run Tasks** (your chat tasks running asynchronously) report progress into this conversation as \`<task-progress …>\` signal blocks (\`started\` / \`done\` / needs another look / needs a decision). These are **system notifications, not the human** — do not quote them as user messages; use them to keep the human informed when relevant, and act on \`needs a decision\` by asking them the actual question.
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

/** `modelId` is the override key part: a model id, or `chatModelOverrideKey(...)` for a CHAT-5 thread choice. */
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
 * Test seam for the chat assembly wiring (see chat-controller.wiring.test.ts). Production
 * callers omit it; tests inject recorders/stubs to pin the call sites that hand chat its
 * chat-scoped Memory, provider resolution, params-sized budget and OM config.
 */
export interface ChatAssemblyDeps {
  getMemory?: typeof getAgentMemory;
  resolveProviderRow?: typeof resolveAgentProviderRow;
}

/**
 * CONCIERGE-PARAMS wiring contract (pinned by chat-controller.wiring.test.ts): the chat run's
 * TokenLimiter trim limit AND generation settings are sized from the active chat model's
 * `params` (concierge pair) — dropping params at this site silently reverts the hard context
 * guard to the provider default window.
 */
export function buildChatRunConfig(
  effectiveRecord: AgentRecord,
  providerRecord: Parameters<typeof resolveAgentContextBudget>[1],
  options?: ChatModelOverrideOptions,
): {
  generationOptions: ReturnType<typeof resolveAgentGenerationOptions>;
  contextBudget: ReturnType<typeof resolveAgentContextBudget>;
  inputProcessors: ReturnType<typeof buildHeartbeatInputProcessors>;
} {
  const generationOptions = resolveAgentGenerationOptions(effectiveRecord, providerRecord, options?.params);
  if (options?.reasoningLevelOverride) generationOptions.reasoning = options.reasoningLevelOverride;
  const contextBudget = resolveAgentContextBudget(effectiveRecord, providerRecord, 'chat', options?.params);
  return {
    generationOptions,
    contextBudget,
    inputProcessors: buildHeartbeatInputProcessors({ limit: contextBudget.limiterLimit }),
  };
}

/**
 * CONCIERGE-OM wiring contract (pinned by chat-controller.wiring.test.ts): the chat
 * AgentController's omConfig must come from resolveChatObservationalMemory (free-chat forces
 * OM on when an observer model is resolvable), never the heartbeat resolver — that mismatch
 * showed "Off" in the chat menu while OM ran (B1 on #194).
 */
export async function buildChatOmConfig(
  companySettings: CompanySettings | null | undefined,
  agentRuntime: AgentRuntimeConfig | null | undefined,
): Promise<Record<string, never> | { omConfig: Record<string, unknown> }> {
  const { resolveChatObservationalMemory } = await import('@tourbillon/shared/company-settings');
  // CONCIERGE-OM: free-chat always attempts OM when an observer model is resolvable
  // (company OM model → concierge model → none). Company `enabled:false` and agent
  // `mode:'off'` do NOT disable it here; heartbeats still honour both switches.
  const resolved = resolveChatObservationalMemory(companySettings, agentRuntime);
  if (!resolved) return {} as Record<string, never>;
  return {
    omConfig: {
      defaultObserverModelId: resolved.modelId,
      defaultReflectorModelId: resolved.modelId,
      defaultObservationThreshold: resolved.observeAfterTokens,
      defaultReflectionThreshold: resolved.reflectAfterTokens,
      ...(resolved.maxOutputTokens ? { defaultMaxOutputTokens: resolved.maxOutputTokens } : {}),
      ...(resolved.temperature !== undefined ? { defaultTemperature: resolved.temperature } : {}),
    },
  };
}

/**
 * Mastra Agent for interactive chat — same identity/model/tools as heartbeat, no control-plane loop.
 */
export async function createChatAgentWithSkills(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & ChatModelOverrideOptions,
  deps?: ChatAssemblyDeps,
): Promise<Agent> {
  // CHAT-5: a thread may pick another model, provider and effort than the agent's.
  const effectiveRecord = chatEffectiveRecord(agentRecord, options);
  const tools = await assembleAgentTools(effectiveRecord, { ...options, chatTaskTools: true });
  const prepared = await prepareAgentSkills(effectiveRecord, { mode: 'chat' });
  const toolIds = Object.values(tools)
    .map((t) =>
      t && typeof t === 'object' && 'id' in t && typeof (t as { id: unknown }).id === 'string'
        ? (t as { id: string }).id
        : null,
    )
    .filter((id): id is string => Boolean(id));
  const systemPrompt = assembleChatSystemPrompt(effectiveRecord, prepared, toolIds);

  const modelSource = chatModelSource(effectiveRecord, options);
  const providerOverrides = modelProviderOverridesFromAgent(
    modelSource.adapterType,
    modelSource.adapterConfig,
  );
  // PRV-1: honour the company's provider switches; one activity warning per chat agent build.
  // CHAT-5: a provider the thread picked is used only while it is on for the company (no fallback).
  const { row: providerRow, fallbackFrom } = await (deps?.resolveProviderRow ?? resolveAgentProviderRow)(
    effectiveRecord,
    {
      context: 'chat',
      recordWarning: !options?.providerIdOverride,
    },
  );
  if (options?.providerIdOverride && (!providerRow || fallbackFrom || providerRow.id !== options.providerIdOverride)) {
    throw new ChatProviderUnavailableError();
  }
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const providerConfig = resolveModelProviderConfig(
    providerOverrides,
    effectiveRecord.modelId,
    providerRecord,
  );
  const { generationOptions, inputProcessors } = buildChatRunConfig(effectiveRecord, providerRecord, options);

  // Interactive chat is multi-turn. vLLM `/v1/responses` often crashes on replayed
  // assistant history (`AI_APICallError: 'role'`). Force chat-completions for chat only;
  // heartbeats keep the provider's configured apiMode.
  const chatApiMode = 'chat' as const;

  console.log(
    formatTrace('chat-agent', { agentId: effectiveRecord.id, agentName: effectiveRecord.name }, 'chat agent ready', {
      urlKey: effectiveRecord.urlKey,
      modelId: effectiveRecord.modelId,
      provider: providerConfig.provider,
      ...(options?.providerIdOverride || options?.reasoningLevelOverride
        ? { modelSource: 'thread', ...(options.reasoningLevelOverride ? { reasoning: options.reasoningLevelOverride } : {}) }
        : {}),
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
    model: getLanguageModelForAgent(modelSource, providerRecord, {
      apiModeOverride: chatApiMode,
    }),
    tools: tools as never,
    // CONCIERGE-OM: chat Agent gets the chat-scoped Memory (forced OM when a
    // model is resolvable) — same instance as the chat controller, not the
    // heartbeat-resolution Memory cache. The 'chat' scope argument is pinned by
    // chat-controller.wiring.test.ts; dropping it hands chat a heartbeat-keyed Memory.
    memory: await (deps?.getMemory ?? getAgentMemory)(
      options?.companySettings ?? null,
      effectiveRecord.runtimeConfig as AgentRuntimeConfig,
      'chat',
    ),
    inputProcessors,
    ...toMastraDefaultOptions(generationOptions),
  });
}

let chatThreadStorage: PostgresStore | null = null;

function getChatThreadStorage(): PostgresStore {
  if (!chatThreadStorage) {
    const connectionString = requireDatabaseUrl('chat controller storage');
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
  options?: AssembleAgentToolsOptions &
    ChatModelOverrideOptions & {
      companySettings?: CompanySettings | null;
    },
  deps?: ChatAssemblyDeps,
): Promise<AgentController<ChatControllerState>> {
  const agent = await createChatAgentWithSkills(agentRecord, options, deps);
  // S195-S4 (#195 ACCEPT): this used to also resolve the provider row and compute a
  // contextBudget here - both were dead (the Agent built above already carries the
  // params-sized budget and provider wiring; see buildChatRunConfig in
  // createChatAgentWithSkills). A source pin in chat-controller.wiring.test.ts keeps
  // the duplicate resolution from returning.
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

  const omConfigPart = await buildChatOmConfig(
    options?.companySettings ?? null,
    agentRecord.runtimeConfig as AgentRuntimeConfig,
  );
  const memory = await (deps?.getMemory ?? getAgentMemory)(
    options?.companySettings ?? null,
    agentRecord.runtimeConfig as AgentRuntimeConfig,
    'chat',
  );

  // Session always requires a Workspace instance (Mastra AgentController contract).
  // Chat uses a tools-disabled workspace so sandbox schemas do not inflate context.
  return new AgentControllerClass<ChatControllerState>({
    id: buildChatControllerId(agentRecord.id, chatModelOverrideKey(options)),
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
    ...omConfigPart,
    // TASK-1: Mastra's built-in task_* tools keep a per-THREAD list (dies on Clear,
    // no cancelled/waiting status). Chat gets the one private `chat_tasks` list instead —
    // keeping task_* on would give the agent two task lists.
    disableBuiltinTools: ['ask_user', 'submit_plan', 'subagent', 'task_write', 'task_update', 'task_complete', 'task_check'],
    // WID-1: request-scoped widget frontend tools (only when the AG-UI route offers them for a run).
    tools: requestScopedTools as never,
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

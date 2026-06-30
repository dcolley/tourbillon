import type { Agent as AgentRecord } from '@tourbillon/db';
import { getLlmProviderRowById } from '@tourbillon/db';
import type { Harness } from '@mastra/core/harness';
import { Harness as HarnessClass } from '@mastra/core/harness';
import type { HarnessMode } from '@mastra/core/harness';
import { PostgresStore } from '@mastra/pg';
import { Agent } from '@mastra/core/agent';
import { ensureExecutionWorkspace } from '@tourbillon/shared';
import {
  assembleAgentSystemPrompt,
  assembleAgentTools,
  getAgentMemory,
  type AssembleAgentToolsOptions,
} from './agent-factory';
import { getLanguageModelForAgent, llmProviderRowToRecord } from './provider';
import { resolveAgentModelSettings } from './model-settings';
import { buildCodeExecutionWorkspace } from './execution-workspace';

export function buildHarnessThreadId(agentRecord: AgentRecord, taskId?: string): string {
  return taskId
    ? `issue-${agentRecord.companyId}-${taskId}`
    : `agent-${agentRecord.id}`;
}

export async function buildHarnessCwd(
  agentRecord: AgentRecord,
  taskId?: string,
): Promise<string | undefined> {
  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;
  if (!codeExecutionEnabled) return undefined;
  return ensureExecutionWorkspace(agentRecord.companyId, taskId);
}

export function buildHarnessStorageConfig(): {
  backend: 'pg';
  connectionString: string;
} {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for harness storage');
  }
  return { backend: 'pg', connectionString };
}

export function buildHarnessPermissionRules(agentRecord: AgentRecord) {
  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;
  const mcpEnabled =
    (agentRecord.mcpServerIds?.length ?? 0) > 0 ||
    (agentRecord.assignedToolsets?.includes('buffer') ?? false);

  return {
    categories: {
      read: 'allow' as const,
      edit: codeExecutionEnabled ? ('allow' as const) : ('deny' as const),
      execute: codeExecutionEnabled ? ('allow' as const) : ('deny' as const),
      mcp: mcpEnabled ? ('allow' as const) : ('deny' as const),
    },
    tools: {},
  };
}

export async function buildHarnessWorkModes(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<HarnessMode<Record<string, unknown>>[]> {
  const tools = await assembleAgentTools(agentRecord, options);
  const systemPrompt = await assembleAgentSystemPrompt(agentRecord);
  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;
  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const modelSettings = resolveAgentModelSettings(agentRecord, providerRecord);

  const workAgent = new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord, providerRecord),
    tools: tools as Parameters<typeof Agent>[0]['tools'],
    memory: getAgentMemory(),
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...(modelSettings ? { defaultOptions: { modelSettings } } : {}),
  });

  return [
    {
      id: 'work',
      name: 'Work',
      default: true,
      agent: workAgent,
    },
  ];
}

export interface TourbillonHarnessState {
  yolo?: boolean;
  permissionRules?: ReturnType<typeof buildHarnessPermissionRules>;
}

/**
 * Headless Harness for Tourbillon heartbeats — uses the agent's LM Studio / Ollama
 * model directly instead of mastracode's cloud model router (which requires API keys
 * for provider prefixes like google/* even when running locally).
 */
export async function createTourbillonHarness(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & { cwd?: string },
): Promise<Harness<TourbillonHarnessState>> {
  const modes = await buildHarnessWorkModes(agentRecord, options);
  const codeExecutionEnabled = agentRecord.assignedToolsets?.includes('code-execution') ?? false;

  const harness = new HarnessClass<TourbillonHarnessState>({
    id: `tourbillon-${agentRecord.id}`,
    resourceId: `company-${agentRecord.companyId}`,
    storage: getHarnessThreadStorage(),
    memory: getAgentMemory(),
    modes,
    // Used only if OM/subagents resolve a model ID — always route to local provider.
    resolveModel: async () => {
      const row = agentRecord.providerId
        ? await getLlmProviderRowById(agentRecord.providerId)
        : null;
      const record = row ? llmProviderRowToRecord(row) : null;
      return getLanguageModelForAgent(agentRecord, record);
    },
    initialState: {
      yolo: true,
      permissionRules: buildHarnessPermissionRules(agentRecord),
    },
    ...(codeExecutionEnabled && options?.cwd
      ? { workspace: buildCodeExecutionWorkspace() }
      : {}),
    disableBuiltinTools: ['ask_user', 'submit_plan', 'subagent'],
  });

  return harness;
}

/** Cap harness thread history to avoid unbounded growth across heartbeats. */
export const HARNESS_THREAD_MESSAGE_CAP = 40;

let harnessThreadStorage: PostgresStore | null = null;

function getHarnessThreadStorage(): PostgresStore {
  if (!harnessThreadStorage) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for harness thread storage');
    }
    harnessThreadStorage = new PostgresStore({
      id: 'tourbillon-harness-threads',
      connectionString,
    });
  }
  return harnessThreadStorage;
}

/**
 * Switch to a harness thread, creating it in storage first if it does not exist.
 * Mastra's switchThread() throws when the thread ID is unknown — common on first heartbeat.
 */
export async function ensureHarnessThread(
  harness: Harness<TourbillonHarnessState>,
  threadId: string,
): Promise<void> {
  const threads = await harness.listThreads({ allResources: true });
  if (!threads.some((t) => t.id === threadId)) {
    const resourceId = harness.getDefaultResourceId();
    const now = new Date();
    const memory = await getHarnessThreadStorage().getStore('memory');
    if (!memory) {
      throw new Error('Harness memory store unavailable');
    }
    await memory.saveThread({
      thread: {
        id: threadId,
        resourceId,
        title: threadId,
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  await harness.switchThread({ threadId });
}

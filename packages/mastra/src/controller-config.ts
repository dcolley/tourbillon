import type { Agent as AgentRecord } from '@tourbillon/db';
import { getLlmProviderRowById } from '@tourbillon/db';
import type {
  AgentController,
  AgentControllerEvent,
  AgentControllerMode,
  Session,
} from '@mastra/core/agent-controller';
import { AgentController as AgentControllerClass } from '@mastra/core/agent-controller';
import { PostgresStore } from '@mastra/pg';
import { Agent } from '@mastra/core/agent';
import {
  ensureExecutionWorkspace,
  isMastraTracingEnabled,
  resolveObservationalMemoryModel,
} from '@tourbillon/shared';
import {
  assembleAgentSystemPrompt,
  assembleAgentTools,
  getAgentMemory,
  shouldAttachCodeExecutionWorkspace,
  type AssembleAgentToolsOptions,
} from './agent-factory';
import { getLanguageModelForAgent, llmProviderRowToRecord } from './provider';
import {
  resolveAgentContextBudget,
  resolveAgentGenerationOptions,
  toMastraDefaultOptions,
} from './model-settings';
import { buildChatWorkspace, buildCodeExecutionWorkspace } from './execution-workspace';
import { agentNeedsMcpTools } from '@tourbillon/shared/mcp-registry';
import { buildHeartbeatInputProcessors } from './heartbeat-processors';
import { getMastraInstance } from './mastra-instance';

export type { AgentController, AgentControllerEvent, AgentControllerMode, Session };

import { buildHarnessIdleThreadId } from './heartbeat-memory';

export function buildControllerThreadId(agentRecord: AgentRecord, taskId?: string): string {
  return taskId
    ? `issue-${agentRecord.companyId}-${taskId}`
    : buildHarnessIdleThreadId(agentRecord.id);
}

/** @deprecated Prefer {@link buildControllerThreadId}. */
export const buildHarnessThreadId = buildControllerThreadId;

export async function buildControllerCwd(
  agentRecord: AgentRecord,
  taskId?: string,
): Promise<string | undefined> {
  const codeExecutionEnabled = await shouldAttachCodeExecutionWorkspace(agentRecord);
  if (!codeExecutionEnabled) return undefined;
  return ensureExecutionWorkspace(agentRecord.companyId, taskId);
}

/** @deprecated Prefer {@link buildControllerCwd}. */
export const buildHarnessCwd = buildControllerCwd;

export function buildControllerStorageConfig(): {
  backend: 'pg';
  connectionString: string;
} {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for controller storage');
  }
  return { backend: 'pg', connectionString };
}

/** @deprecated Prefer {@link buildControllerStorageConfig}. */
export const buildHarnessStorageConfig = buildControllerStorageConfig;

export function buildControllerPermissionRules(
  agentRecord: AgentRecord,
  codeExecutionEnabled: boolean,
) {
  const mcpEnabled = agentNeedsMcpTools(agentRecord);

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

/** @deprecated Prefer {@link buildControllerPermissionRules}. */
export const buildHarnessPermissionRules = buildControllerPermissionRules;

async function buildBackingAgent(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<Agent> {
  const tools = await assembleAgentTools(agentRecord, options);
  const systemPrompt = await assembleAgentSystemPrompt(agentRecord);
  const codeExecutionEnabled = await shouldAttachCodeExecutionWorkspace(agentRecord);
  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const generationOptions = resolveAgentGenerationOptions(agentRecord, providerRecord);
  const contextBudget = resolveAgentContextBudget(agentRecord, providerRecord, 'harness');

  return new Agent({
    id: agentRecord.id,
    name: agentRecord.name,
    instructions: systemPrompt,
    model: getLanguageModelForAgent(agentRecord, providerRecord),
    tools: tools as any,
    memory: await getAgentMemory(options?.companySettings ?? null),
    inputProcessors: buildHeartbeatInputProcessors({ limit: contextBudget.limiterLimit }),
    ...(codeExecutionEnabled ? { workspace: buildCodeExecutionWorkspace() } : {}),
    ...toMastraDefaultOptions(generationOptions),
  });
}

/**
 * Build AgentController modes. Phase 1 ships a single default `work` mode;
 * plan/build/review modes can extend this later.
 */
export async function buildControllerModes(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<{ agent: Agent; modes: AgentControllerMode[] }> {
  const agent = await buildBackingAgent(agentRecord, options);
  return {
    agent,
    modes: [
      {
        id: 'work',
        name: 'Work',
        metadata: { default: true },
      },
    ],
  };
}

/** @deprecated Prefer {@link buildControllerModes}. */
export async function buildHarnessWorkModes(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions,
): Promise<AgentControllerMode[]> {
  const { modes, agent } = await buildControllerModes(agentRecord, options);
  // Preserve prior shape (per-mode agent) for any callers that still expect it.
  return modes.map((mode) => ({ ...mode, agent }));
}

export interface TourbillonControllerState {
  yolo?: boolean;
  permissionRules?: ReturnType<typeof buildControllerPermissionRules>;
  /** Allow createSession tags / projectPath without clobbering typed state. */
  projectPath?: string;
  [key: string]: unknown;
}

/** @deprecated Prefer {@link TourbillonControllerState}. */
export type TourbillonHarnessState = TourbillonControllerState;

/**
 * Headless AgentController for Tourbillon heartbeats — uses the agent's LM Studio /
 * Ollama model directly instead of mastracode's cloud model router.
 */
export async function createTourbillonController(
  agentRecord: AgentRecord,
  options?: AssembleAgentToolsOptions & { cwd?: string },
): Promise<AgentController<TourbillonControllerState>> {
  const { agent, modes } = await buildControllerModes(agentRecord, options);
  const codeExecutionEnabled = await shouldAttachCodeExecutionWorkspace(agentRecord);

  const om = resolveObservationalMemoryModel(options?.companySettings ?? null);
  const memory = await getAgentMemory(options?.companySettings ?? null);
  const providerRow = agentRecord.providerId
    ? await getLlmProviderRowById(agentRecord.providerId)
    : null;
  const providerRecord = providerRow ? llmProviderRowToRecord(providerRow) : null;
  const contextBudget = resolveAgentContextBudget(agentRecord, providerRecord, 'harness');

  // Session always requires a Workspace instance. Skip sandbox tool schemas
  // unless code-execution is enabled (same pattern as dashboard chat).
  return new AgentControllerClass<TourbillonControllerState>({
    id: `tourbillon-${agentRecord.id}`,
    resourceId: `company-${agentRecord.companyId}`,
    storage: getControllerThreadStorage(),
    memory,
    agent,
    modes,
    workspace: codeExecutionEnabled ? buildCodeExecutionWorkspace() : buildChatWorkspace(),
    initialState: {
      yolo: true,
      permissionRules: buildControllerPermissionRules(agentRecord, codeExecutionEnabled),
    },
    // Share Tourbillon exporters (Postgres UI + Phoenix) without __registerMastra,
    // which would also bind controller storage to the scheduler Mastra instance.
    ...(isMastraTracingEnabled()
      ? { observability: getMastraInstance().observability }
      : {}),
    ...(om
      ? {
          omConfig: {
            defaultObserverModelId: om.modelId,
            defaultReflectorModelId: om.modelId,
            defaultObservationThreshold: contextBudget.observationThreshold,
            defaultReflectionThreshold: contextBudget.reflectionThreshold,
          },
        }
      : {}),
    disableBuiltinTools: ['ask_user', 'submit_plan', 'subagent'],
  });
}

/** @deprecated Prefer {@link createTourbillonController}. */
export const createTourbillonHarness = createTourbillonController;

/** Cap controller thread history to avoid unbounded growth across heartbeats. */
export const CONTROLLER_THREAD_MESSAGE_CAP = 40;

/** @deprecated Prefer {@link CONTROLLER_THREAD_MESSAGE_CAP}. */
export const HARNESS_THREAD_MESSAGE_CAP = CONTROLLER_THREAD_MESSAGE_CAP;

let controllerThreadStorage: PostgresStore | null = null;

function getControllerThreadStorage(): PostgresStore {
  if (!controllerThreadStorage) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required for controller thread storage');
    }
    controllerThreadStorage = new PostgresStore({
      id: 'tourbillon-harness-threads',
      connectionString,
    });
  }
  return controllerThreadStorage;
}

/**
 * Bind the session to a deterministic Tourbillon thread id, creating it in
 * storage first if it does not exist. `createSession()` may auto-select a
 * different (most-recent or generated) thread — this always overrides it.
 */
export async function ensureControllerThread(
  session: Session<TourbillonControllerState>,
  threadId: string,
): Promise<void> {
  const existing = await session.thread.getById({ threadId });
  if (!existing) {
    const resourceId = session.identity.getResourceId();
    const now = new Date();
    const memory = await getControllerThreadStorage().getStore('memory');
    if (!memory) {
      throw new Error('Controller memory store unavailable');
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

  await session.thread.switch({ threadId });
  await trimControllerThreadHistory(session, threadId);
}

export async function deleteControllerThreadIfExists(threadId: string): Promise<void> {
  try {
    const memory = await getControllerThreadStorage().getStore('memory');
    if (!memory) return;
    await memory.deleteThread({ threadId });
  } catch {
    // Thread may not exist.
  }
}

/** Keep the newest `cap` messages so the Session cap is more than a list limit. */
export async function trimControllerThreadHistory(
  session: Session<TourbillonControllerState>,
  threadId: string,
  cap = CONTROLLER_THREAD_MESSAGE_CAP,
): Promise<void> {
  try {
    const messages = await session.thread.listMessages({ threadId });
    if (messages.length <= cap) return;
    const excessIds = messages
      .slice(0, messages.length - cap)
      .map((message) => message.id)
      .filter((id): id is string => Boolean(id));
    if (excessIds.length === 0) return;
    const memory = await getControllerThreadStorage().getStore('memory');
    if (!memory) return;
    await memory.deleteMessages(excessIds);
  } catch {
    // Trimming is best-effort — TokenLimiter still caps the model request.
  }
}

/** @deprecated Prefer {@link ensureControllerThread}. */
export const ensureHarnessThread = ensureControllerThread;

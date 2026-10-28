/**
 * CTX-1: context meter for an assistant thread (server side).
 *
 * The limit comes from the chat context budget of the model the thread actually runs on (the
 * thread's CHAT-5 choice when it is available, else the agent's model): see
 * `resolveAgentContextBudget` (packages/mastra/src/model-settings.ts). The used figure is an
 * estimate (lib/assistant/context-meter.ts). Read only: no run, no write, no migration.
 */
import {
  CHAT_MEMORY_LAST_MESSAGES,
  toolSchemaReserveForKind,
  type ContextBudget,
} from '@tourbillon/shared/context-budget';
import {
  resolveChatObservationalMemory,
  type AgentRuntimeConfig,
  type CompanySettings,
} from '@tourbillon/shared';
import { threadModelChoiceFromMetadata, type ThreadModelChoice } from './thread-model';
import { buildThreadContextMeter, type ContextMeterMessage, type ThreadContextMeter } from './context-meter';

export interface ContextMeterAgent {
  id: string;
  companyId: string;
  modelId: string | null;
  providerId: string | null;
  runtimeConfig?: unknown;
}

export interface ContextMeterDeps {
  /** Chat context budget for the agent, with the thread's model choice (null: agent default). */
  resolveBudget(agent: ContextMeterAgent, choice: ThreadModelChoice | null): Promise<ContextBudget>;
  /** OM observation threshold for the agent, or null when OM is off. */
  observeAfterTokens(agent: ContextMeterAgent): Promise<number | null>;
}

export async function threadContextMeter(
  agent: ContextMeterAgent,
  threadMetadata: unknown,
  messages: ContextMeterMessage[],
  deps: ContextMeterDeps,
): Promise<ThreadContextMeter> {
  const choice = threadModelChoiceFromMetadata(threadMetadata);
  const [budget, observeAfterTokens] = await Promise.all([
    deps.resolveBudget(agent, choice),
    deps.observeAfterTokens(agent).catch(() => null),
  ]);
  return buildThreadContextMeter({
    budget,
    messages,
    lastMessages: CHAT_MEMORY_LAST_MESSAGES,
    overheadTokens: toolSchemaReserveForKind('chat'),
    observeAfterTokens,
  });
}

/** Production deps: provider registry + company switches (PRV-1), company OM settings. */
export const defaultContextMeterDeps: ContextMeterDeps = {
  async resolveBudget(agent, choice) {
    const [{ resolveAgentContextBudget, chatEffectiveRecord }, { resolveCompanyLlmProviderRow }, { toLlmProviderRecord }, { resolveThreadRunModel }] =
      await Promise.all([
        import('../../../../packages/mastra/src/chat'),
        import('@tourbillon/db'),
        import('@tourbillon/shared/model-provider'),
        import('@/lib/chat/thread-model'),
      ]);
    const run = await resolveThreadRunModel(agent.companyId, choice);
    // Same record the chat controller builds from (a refused thread choice runs nothing; show the agent's).
    const effective = run.source === 'thread' && run.allowed ? chatEffectiveRecord(agent, run.opts) : agent;
    let row: Parameters<typeof toLlmProviderRecord>[0] | null = null;
    try {
      row = (await resolveCompanyLlmProviderRow(agent.companyId, effective.providerId)).row;
    } catch {
      row = null; // nothing on for the company: env budget
    }
    return resolveAgentContextBudget(effective as never, row ? toLlmProviderRecord(row) : null, 'chat');
  },
  async observeAfterTokens(agent) {
    const [{ db, companies }, { eq }, { parseCompanySettings }] = await Promise.all([
      import('@tourbillon/db'),
      import('drizzle-orm'),
      import('@tourbillon/shared'),
    ]);
    const company = await db.query.companies.findFirst({ where: eq(companies.id, agent.companyId) });
    // B1: the meter's compaction point must match what chat actually runs — free-chat forces OM
    // on (resolveChatObservationalMemory); the heartbeat resolver would return null here.
    return chatObserveAfterTokens(parseCompanySettings(company?.settings), (agent.runtimeConfig ?? null) as never);
  },
};

/**
 * CONCIERGE-OM B1: the OM observation threshold for the CHAT path, or null when no observer
 * model is resolvable. Uses resolveChatObservationalMemory (chat forces OM on), never the
 * heartbeat resolver — a regression to it makes this return null whenever heartbeats are off.
 */
export function chatObserveAfterTokens(
  companySettings: CompanySettings | null | undefined,
  agentRuntime?: AgentRuntimeConfig | null,
): number | null {
  return resolveChatObservationalMemory(companySettings, agentRuntime)?.observeAfterTokens ?? null;
}

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
import { toLlmProviderRecord } from '@tourbillon/shared/model-provider';
import { isThreadProviderAvailable } from '@/lib/chat/thread-model';
import type { AgentModelSettings } from '@tourbillon/shared/model-settings';
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

/**
 * Injectable DB boundary for the production meter deps (CONCIERGE-OM S6 / CONCIERGE-PARAMS S2,
 * gates #194/#195): the glue that loads company settings and the provider row is the only part
 * that needs Postgres, so tests override these three and exercise the REAL concierge-pair and
 * chat-OM branches of resolveBudget / observeAfterTokens. Overriding nothing = production.
 */
export interface ContextMeterRunContextDeps {
  /** The company row's raw settings blob (undefined: no such company). */
  loadCompanySettings(companyId: string): Promise<unknown>;
  /** True while the concierge pair's provider exists and is on for the company (PRV-1). */
  isProviderAvailable(companyId: string, providerId: string): Promise<boolean>;
  /** The provider row the effective model resolves to (null: nothing on for the company → env budget). */
  resolveProviderRow(
    companyId: string,
    providerId: string | null | undefined,
  ): Promise<{ row: Parameters<typeof toLlmProviderRecord>[0] | null }>;
}

/**
 * Production deps factory (PRV-1 provider registry + switches, company OM/concierge settings).
 * `defaultContextMeterDeps` is this with no overrides; tests pass fakes for the DB boundary.
 */
export function createContextMeterDeps(overrides: Partial<ContextMeterRunContextDeps> = {}): ContextMeterDeps {
  const load: ContextMeterRunContextDeps = {
    async loadCompanySettings(companyId) {
      const [{ db, companies }, { eq }] = await Promise.all([
        import('@tourbillon/db'),
        import('drizzle-orm'),
      ]);
      const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
      return company?.settings;
    },
    isProviderAvailable: isThreadProviderAvailable,
    async resolveProviderRow(companyId, providerId) {
      const { resolveCompanyLlmProviderRow } = await import('@tourbillon/db');
      return resolveCompanyLlmProviderRow(companyId, providerId);
    },
    ...overrides,
  };

  return {
    async resolveBudget(agent, choice) {
      const [
        { resolveAgentContextBudget, chatEffectiveRecord },
        { toLlmProviderRecord },
        { resolveThreadRunModel },
        { parseCompanySettings, resolveConciergeModel },
      ] = await Promise.all([
        import('../../../../packages/mastra/src/chat'),
        import('@tourbillon/shared/model-provider'),
        import('@/lib/chat/thread-model'),
        import('@tourbillon/shared'),
      ]);
      const run = await resolveThreadRunModel(agent.companyId, choice);
      // Same record the chat controller builds from (a refused thread choice runs nothing; show the agent's).
      let effective = run.source === 'thread' && run.allowed ? chatEffectiveRecord(agent, run.opts) : agent;
      // CONCIERGE-PARAMS: free chat (no thread model choice) with a company concierge pair uses that
      // pair while its provider is on — same resolution as registry.getOrCreateChatController and
      // resolveChatModelOptions, so the meter shows the budget the run actually gets (pair params
      // beat the provider default; an off/missing pair provider falls back to the agent's model).
      let params: AgentModelSettings | undefined;
      if (run.source === 'agent') {
        const settings = parseCompanySettings(await load.loadCompanySettings(agent.companyId));
        const pair = resolveConciergeModel(settings);
        if (pair && (await load.isProviderAvailable(agent.companyId, pair.providerId))) {
          effective = chatEffectiveRecord(agent, {
            modelIdOverride: pair.modelId,
            providerIdOverride: pair.providerId,
          });
          params = pair.params;
        }
      }
      let row: Parameters<typeof toLlmProviderRecord>[0] | null = null;
      try {
        row = (await load.resolveProviderRow(agent.companyId, effective.providerId)).row;
      } catch {
        row = null; // nothing on for the company: env budget
      }
      return resolveAgentContextBudget(
        effective as never,
        row ? toLlmProviderRecord(row) : null,
        'chat',
        params,
      );
    },
    async observeAfterTokens(agent) {
      const { parseCompanySettings } = await import('@tourbillon/shared');
      const raw = await load.loadCompanySettings(agent.companyId);
      // B1: the meter's compaction point must match what chat actually runs — free-chat forces OM
      // on (resolveChatObservationalMemory); the heartbeat resolver would return null here.
      return chatObserveAfterTokens(parseCompanySettings(raw), (agent.runtimeConfig ?? null) as never);
    },
  };
}

/** Production deps: provider registry + company switches (PRV-1), company OM settings. */
export const defaultContextMeterDeps: ContextMeterDeps = createContextMeterDeps();

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

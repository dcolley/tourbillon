/**
 * CHAT-5: read and change an assistant thread's model choice (server side).
 *
 * The choice is one metadata key on the thread (no new table). Saving checks, in order: the agent
 * is writable, the thread is the agent's (caller), no AG-UI run is open on the thread, the provider
 * exists and is switched on for the agent's company (PRV-1), and the effort level is one the model
 * supports. Responses list providers by id, name and type only (no URLs, keys or headers).
 */
import { inferReasoningCapabilities } from '@tourbillon/shared/reasoning-capabilities';
import type { LlmProviderType } from '@tourbillon/shared/model-provider';
import {
  ASSISTANT_THREAD_MODEL_KEY,
  effortLevelsForModel,
  parseThreadModelChoice,
  pickerProvidersForCompany,
  type ThreadModelChoice,
  type ThreadModelState,
} from './thread-model';

export interface ThreadModelAgent {
  id: string;
  companyId: string;
  modelId?: string | null;
  providerId?: string | null;
  status?: string | null;
}

export interface CompanyProviderEntry {
  id: string;
  name: string;
  type: string;
  enabledForCompany: boolean;
}

export interface ThreadModelDeps {
  listProviders(companyId: string): Promise<CompanyProviderEntry[]>;
  /** Provider the agent effectively runs on (PRV-1 fallback applied); null: none configured. */
  effectiveAgentProviderId(companyId: string, providerId: string | null | undefined): Promise<string | null>;
  isRunOpen(threadId: string): boolean;
  writeChoice(threadId: string, choice: ThreadModelChoice | null): Promise<boolean>;
}

export class ThreadModelError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ThreadModelError';
  }
}

export const THREAD_MODEL_RUN_OPEN_MESSAGE = 'A run is in progress on this thread; change the model when it has finished';

export async function threadModelState(
  agent: ThreadModelAgent,
  threadMetadata: unknown,
  deps: Pick<ThreadModelDeps, 'listProviders' | 'effectiveAgentProviderId'>,
): Promise<ThreadModelState> {
  const all = await deps.listProviders(agent.companyId);
  const providers = pickerProvidersForCompany(all);
  const raw = (threadMetadata as Record<string, unknown> | null | undefined)?.[ASSISTANT_THREAD_MODEL_KEY];
  const choice = parseThreadModelChoice(raw);
  const agentProviderId = await deps.effectiveAgentProviderId(agent.companyId, agent.providerId).catch(() => null);
  return {
    choice,
    choiceAvailable: choice ? providers.some((p) => p.id === choice.providerId) : true,
    agentDefault: {
      providerId: agentProviderId,
      providerName: providers.find((p) => p.id === agentProviderId)?.name ?? null,
      modelId: agent.modelId ?? null,
    },
    providers,
  };
}

/** Validate and store a choice (null: back to the agent default). Returns the stored choice. */
export async function saveThreadModelChoice(
  agent: ThreadModelAgent,
  threadId: string,
  choice: ThreadModelChoice | null,
  deps: ThreadModelDeps,
): Promise<ThreadModelChoice | null> {
  if (agent.status === 'archived') {
    throw new ThreadModelError('Agent is archived; its threads are read-only', 409);
  }
  if (deps.isRunOpen(threadId)) throw new ThreadModelError(THREAD_MODEL_RUN_OPEN_MESSAGE, 409, 'run_in_progress');

  let stored: ThreadModelChoice | null = null;
  if (choice) {
    const provider = (await deps.listProviders(agent.companyId)).find((p) => p.id === choice.providerId);
    if (!provider || !provider.enabledForCompany) {
      throw new ThreadModelError(
        'That provider is not available to this company',
        409,
        'provider_disabled_for_company',
      );
    }
    if (choice.reasoningLevel) {
      // Saved without a live model listing: LM Studio reports its own levels (the picker only offers
      // those), other providers use the shared heuristic.
      if (provider.type !== 'lmstudio') {
        const allowed = effortLevelsForModel(
          choice.modelId,
          inferReasoningCapabilities(choice.modelId, provider.type as LlmProviderType),
        );
        if (!allowed.includes(choice.reasoningLevel)) {
          throw new ThreadModelError('That effort level is not supported by this model', 400, 'effort_not_supported');
        }
      }
    }
    stored = {
      providerId: choice.providerId,
      modelId: choice.modelId,
      ...(choice.reasoningLevel ? { reasoningLevel: choice.reasoningLevel } : {}),
    };
  }
  if (!(await deps.writeChoice(threadId, stored))) throw new ThreadModelError('Thread not found', 404);
  return stored;
}

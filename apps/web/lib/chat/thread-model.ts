/**
 * CHAT-5: the model a chat run uses on a thread (server side).
 *
 * The thread's stored choice (thread metadata, see lib/assistant/thread-model.ts) wins over the
 * agent's configured model and over a `?modelId=` query. Before every run the provider is
 * re-checked: it must exist and be switched on for the agent's company (PRV-1). A provider that is
 * not available refuses the run with 409 `provider_disabled_for_company`; nothing falls back
 * silently to another provider. The Mastra chat controller checks the same again when it is built
 * (ChatProviderUnavailableError).
 */
import type { ChatModelOverrideOptions } from '../../../../packages/mastra/src/chat';
import type { ThreadModelChoice } from '@/lib/assistant/thread-model';

export const THREAD_PROVIDER_REFUSED_CODE = 'provider_disabled_for_company';
export const THREAD_PROVIDER_REFUSED_MESSAGE =
  "The model chosen for this thread uses a provider that is not available to this company. Choose another model or go back to the agent's default.";

export interface ThreadProviderDeps {
  /** True when the provider exists and is switched on for the company. */
  isProviderAvailable(companyId: string, providerId: string): Promise<boolean>;
}

/** Default check: provider row exists and PRV-1 has it on for the company. */
export async function isThreadProviderAvailable(companyId: string, providerId: string): Promise<boolean> {
  const { getLlmProviderPublic, isLlmProviderOnForCompany } = await import('@/lib/llm-providers');
  const provider = await getLlmProviderPublic(providerId);
  if (!provider) return false;
  return isLlmProviderOnForCompany(companyId, providerId);
}

export const defaultThreadProviderDeps: ThreadProviderDeps = { isProviderAvailable: isThreadProviderAvailable };

let activeDeps: ThreadProviderDeps = defaultThreadProviderDeps;

/** Test seam: replace the provider check (null restores the default). */
export function setThreadProviderDepsForTests(deps: ThreadProviderDeps | null): void {
  activeDeps = deps ?? defaultThreadProviderDeps;
}

/** Controller options for a thread choice (model, provider and, when set, effort). */
export function threadChoiceOverride(choice: ThreadModelChoice): ChatModelOverrideOptions {
  return {
    modelIdOverride: choice.modelId,
    providerIdOverride: choice.providerId,
    ...(choice.reasoningLevel ? { reasoningLevelOverride: choice.reasoningLevel } : {}),
  };
}

export type ThreadRunModel =
  | { source: 'agent' }
  | { source: 'thread'; choice: ThreadModelChoice; opts: ChatModelOverrideOptions; allowed: boolean };

/** What a run on this thread uses; `allowed: false` → refuse the run. */
export async function resolveThreadRunModel(
  companyId: string,
  choice: ThreadModelChoice | null,
  deps: ThreadProviderDeps = activeDeps,
): Promise<ThreadRunModel> {
  if (!choice) return { source: 'agent' };
  const allowed = await deps.isProviderAvailable(companyId, choice.providerId);
  return { source: 'thread', choice, opts: threadChoiceOverride(choice), allowed };
}

/** 409 body for a refused run or save (no provider details beyond the stable code). */
export function threadProviderRefusedBody(): { error: string; code: string } {
  return { error: THREAD_PROVIDER_REFUSED_MESSAGE, code: THREAD_PROVIDER_REFUSED_CODE };
}

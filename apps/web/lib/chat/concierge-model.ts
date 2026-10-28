/**
 * CONCIERGE-MODEL-1: company-level "concierge" model for AgentController free-chat runs.
 *
 * When the company configures a concierge pair (providerId + modelId in company settings),
 * Assistant free-chat runs use it unless the thread carries its own explicit model choice or the
 * request carries a `?modelId=` override (CHAT-5 choices win). When unset, incomplete, or when
 * the configured provider no longer exists or is switched off for the company, runs keep the
 * agent's own model (safe fallback, never a refusal). Nothing is pinned in code: the pair comes
 * from company settings only and no default model id is baked in.
 *
 * The resolved pair is handed over as `ChatModelOverrideOptions` so the controller cache key
 * distinguishes it (chatModelOverrideKey); clearing the setting therefore restores the agent
 * model on the next request (different cache key → fresh controller).
 */
import { resolveConciergeModel, type CompanySettings } from '@tourbillon/shared';
import type { ChatModelOverrideOptions } from '../../../../packages/mastra/src/chat';
import { defaultThreadProviderDeps, type ThreadProviderDeps } from './thread-model';

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/** True when the request already carries an explicit model/provider override (thread choice or `?modelId=`). */
export function hasExplicitChatModel(opts?: ChatModelOverrideOptions | null): boolean {
  return Boolean(clean(opts?.modelIdOverride) || clean(opts?.providerIdOverride));
}

/**
 * Controller options for a chat run on this agent:
 * - an explicit override (thread choice or `?modelId=`) passes through untouched — CHAT-5 wins;
 * - otherwise a configured company pair is applied while its provider exists and is on for the
 *   company (PRV-1); a disabled or missing provider is ignored → agent's own model;
 * - otherwise `undefined` — the agent's own model (unchanged pre-story behaviour).
 */
export async function resolveChatModelOptions(
  companyId: string,
  companySettings: CompanySettings | null | undefined,
  explicit?: ChatModelOverrideOptions | null,
  deps: ThreadProviderDeps = defaultThreadProviderDeps,
): Promise<ChatModelOverrideOptions | undefined> {
  if (hasExplicitChatModel(explicit)) return explicit ?? undefined;
  const pair = resolveConciergeModel(companySettings);
  if (!pair) return undefined;
  // Safe fallback: a pair whose provider is off for the company (or gone) is never used.
  if (!(await deps.isProviderAvailable(companyId, pair.providerId))) return undefined;
  // CONCIERGE-PARAMS: params ride along so the controller sizes its context budget
  // (TokenLimiter trim + CTX meter limit) with the model's real window, not the provider default.
  return {
    modelIdOverride: pair.modelId,
    providerIdOverride: pair.providerId,
    ...(pair.params ? { params: pair.params } : {}),
  };
}

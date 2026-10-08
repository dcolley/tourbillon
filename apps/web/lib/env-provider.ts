/**
 * Whether the server env explicitly configures an LLM provider. Shared by the GET /api/models
 * default path (#121) and registry seeding (ensureDefaultLlmProviders, #121 S5). Lives on its own
 * so llm-providers.ts can use it without importing the model-listing code.
 */
import type { ModelProviderConfig, ModelProviderKind } from '@tourbillon/shared';

/** Env vars that set the base URL for each provider kind (mirrors envBaseURL in @tourbillon/shared). */
export const BASE_URL_ENV: Record<ModelProviderKind, readonly string[]> = {
  lmstudio: ['LM_STUDIO_BASE_URL', 'LLM_BASE_URL'],
  ollama: ['OLLAMA_BASE_URL', 'LLM_BASE_URL'],
  vllm: ['LLM_BASE_URL'],
  openai: ['OPENAI_BASE_URL', 'LLM_BASE_URL'],
  'openai-compatible': ['LLM_BASE_URL', 'OPENAI_BASE_URL'],
};

/** Set and not blank after trimming. */
export function envSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * True when the env explicitly configures a provider: LLM_PROVIDER is set, or a base-URL var for
 * the resolved provider kind is set. With neither, env resolution only yields the built-in
 * localhost default, which is not "configured".
 */
export function envProviderConfigured(config: Pick<ModelProviderConfig, 'provider'>): boolean {
  if (envSet('LLM_PROVIDER')) return true;
  return (BASE_URL_ENV[config.provider] ?? []).some((name) => envSet(name));
}

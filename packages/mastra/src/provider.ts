import { createOpenAI } from '@ai-sdk/openai';

/**
 * LM Studio OpenAI-compatible provider.
 * Ensure LM Studio is running with local server enabled on port 1234.
 * Load any HuggingFace model (e.g. meta-llama/Llama-3.3-70B-Instruct).
 */
export const lmstudio = createOpenAI({
  apiKey: process.env.LM_STUDIO_API_KEY ?? 'lm-studio',
  baseURL: process.env.LM_STUDIO_BASE_URL ?? 'http://localhost:1234/v1',
});

/**
 * Get the model ID to use. Falls back to env var, then a sensible default.
 * Models available depend on what is loaded in LM Studio.
 */
export function getModelId(overrideModelId?: string | null): string {
  return (
    overrideModelId ??
    process.env.LM_STUDIO_DEFAULT_MODEL ??
    'meta-llama/Llama-3.3-70B-Instruct'
  );
}

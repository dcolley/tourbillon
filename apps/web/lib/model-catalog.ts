import {
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
  type ModelProviderOverrides,
} from '@tourbillon/shared';

export interface ListedModel {
  id: string;
}

export interface ListProviderModelsResult {
  models: ListedModel[];
  provider: string;
  baseURL: string;
}

export async function listProviderModels(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
): Promise<ListProviderModelsResult> {
  const config = resolveModelProviderConfig(overrides, modelId);

  if (!config.baseURL.trim()) {
    throw new Error('No model provider base URL is configured.');
  }

  const url = `${config.baseURL.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(
      `Could not list models from ${config.provider} (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }

  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  const models = (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id }));

  return {
    models,
    provider: config.provider,
    baseURL: config.baseURL,
  };
}

export async function listProviderModelsForAgent(
  adapterType: string,
  adapterConfig: unknown,
  modelId?: string | null,
): Promise<ListProviderModelsResult> {
  const overrides = modelProviderOverridesFromAgent(adapterType, adapterConfig);
  return listProviderModels(overrides, modelId);
}

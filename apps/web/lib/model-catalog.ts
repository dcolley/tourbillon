import {
  buildProviderRequestHeaders,
  modelProviderOverridesFromAgent,
  resolveModelProviderConfig,
  resolveModelProviderConfigFromRecord,
  type LlmProviderRecord,
  type ModelProviderConfig,
  type ModelProviderOverrides,
} from '@tourbillon/shared';

export interface ListedModel {
  id: string;
}

export interface ListProviderModelsResult {
  models: ListedModel[];
  provider: string;
  baseURL: string;
  providerId?: string;
  providerName?: string;
}

function resultFromConfig(config: ModelProviderConfig): Omit<ListProviderModelsResult, 'models'> {
  return {
    provider: config.provider,
    baseURL: config.baseURL,
    providerId: config.providerId,
    providerName: config.providerName,
  };
}

export async function listProviderModelsFromConfig(
  config: ModelProviderConfig,
): Promise<ListProviderModelsResult> {
  if (!config.baseURL.trim()) {
    throw new Error('No model provider base URL is configured.');
  }

  const url = `${config.baseURL.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: buildProviderRequestHeaders(config),
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
    ...resultFromConfig(config),
  };
}

export async function listProviderModels(
  overrides?: ModelProviderOverrides | null,
  modelId?: string | null,
  providerRecord?: LlmProviderRecord | null,
): Promise<ListProviderModelsResult> {
  const config = resolveModelProviderConfig(overrides, modelId, providerRecord);
  return listProviderModelsFromConfig(config);
}

export async function listProviderModelsForRecord(
  record: LlmProviderRecord,
  modelId?: string | null,
): Promise<ListProviderModelsResult> {
  const config = resolveModelProviderConfigFromRecord(record, modelId);
  return listProviderModelsFromConfig(config);
}

export async function listProviderModelsForAgent(
  adapterType: string,
  adapterConfig: unknown,
  modelId?: string | null,
  providerRecord?: LlmProviderRecord | null,
): Promise<ListProviderModelsResult> {
  const overrides = modelProviderOverridesFromAgent(adapterType, adapterConfig);
  return listProviderModels(overrides, modelId, providerRecord);
}

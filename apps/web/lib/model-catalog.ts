import {
  buildProviderRequestHeaders,
  inferReasoningCapabilities,
  modelProviderOverridesFromAgent,
  reasoningCapabilitiesFromNative,
  resolveModelProviderConfig,
  resolveModelProviderConfigFromRecord,
  type LlmProviderRecord,
  type ModelProviderConfig,
  type ModelProviderOverrides,
  type ModelReasoningCapabilities,
} from '@tourbillon/shared';

export interface ListedModel {
  id: string;
  reasoningCapabilities?: ModelReasoningCapabilities;
}

export interface ListProviderModelsResult {
  models: ListedModel[];
  provider: string;
  baseURL: string;
  providerId?: string;
  providerName?: string;
}

interface LmStudioNativeModel {
  type?: string;
  key?: string;
  loaded_instances?: Array<{ id?: string }>;
  variants?: string[];
  selected_variant?: string;
  capabilities?: {
    reasoning?: {
      allowed_options?: string[];
    };
  };
}

function resultFromConfig(config: ModelProviderConfig): Omit<ListProviderModelsResult, 'models'> {
  return {
    provider: config.provider,
    baseURL: config.baseURL,
    providerId: config.providerId,
    providerName: config.providerName,
  };
}

function lmStudioNativeBaseUrl(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

function collectLmStudioModelIds(entry: LmStudioNativeModel): string[] {
  const ids = new Set<string>();
  for (const instance of entry.loaded_instances ?? []) {
    if (instance.id) ids.add(instance.id);
  }
  if (entry.selected_variant) ids.add(entry.selected_variant);
  for (const variant of entry.variants ?? []) {
    ids.add(variant);
  }
  if (entry.key) ids.add(entry.key);
  return [...ids];
}

async function fetchLmStudioNativeModels(
  config: ModelProviderConfig,
): Promise<Map<string, ModelReasoningCapabilities>> {
  const capabilitiesById = new Map<string, ModelReasoningCapabilities>();

  if (config.provider !== 'lmstudio') {
    return capabilitiesById;
  }

  const url = `${lmStudioNativeBaseUrl(config.baseURL)}/api/v1/models`;
  try {
    const res = await fetch(url, {
      headers: buildProviderRequestHeaders(config),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return capabilitiesById;

    const body = (await res.json()) as { models?: LmStudioNativeModel[] };
    for (const entry of body.models ?? []) {
      if (entry.type && entry.type !== 'llm') continue;
      const reasoning = reasoningCapabilitiesFromNative(
        entry.capabilities?.reasoning?.allowed_options,
      );
      if (!reasoning) continue;

      for (const id of collectLmStudioModelIds(entry)) {
        capabilitiesById.set(id, reasoning);
      }
    }
  } catch {
    // Fall back to heuristics when native API is unavailable.
  }

  return capabilitiesById;
}

export function resolveModelReasoningCapabilities(
  modelId: string,
  providerType: ModelProviderConfig['provider'] | undefined,
  nativeCapabilities?: ModelReasoningCapabilities | null,
): ModelReasoningCapabilities {
  if (nativeCapabilities?.supported) {
    return nativeCapabilities;
  }
  return inferReasoningCapabilities(modelId, providerType);
}

export async function getModelReasoningCapabilities(
  modelId: string,
  config: ModelProviderConfig,
): Promise<ModelReasoningCapabilities> {
  if (config.provider === 'lmstudio') {
    const nativeById = await fetchLmStudioNativeModels(config);
    const native = nativeById.get(modelId);
    if (native?.supported) {
      return native;
    }
  }
  return inferReasoningCapabilities(modelId, config.provider);
}

export async function listProviderModelsFromConfig(
  config: ModelProviderConfig,
): Promise<ListProviderModelsResult> {
  if (!config.baseURL.trim()) {
    throw new Error('No model provider base URL is configured.');
  }

  const nativeCapabilities =
    config.provider === 'lmstudio' ? await fetchLmStudioNativeModels(config) : new Map();

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
    .map((id) => {
      const native = nativeCapabilities.get(id);
      const reasoningCapabilities = resolveModelReasoningCapabilities(
        id,
        config.provider,
        native,
      );
      return {
        id,
        ...(reasoningCapabilities.supported ? { reasoningCapabilities } : {}),
      };
    });

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

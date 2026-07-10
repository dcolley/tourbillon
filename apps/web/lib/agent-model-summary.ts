import type { Agent } from '@tourbillon/db';
import {
  modelProviderOverridesFromAgent,
  resolveModelProviderConfigFromEnv,
} from '@tourbillon/shared';
import type { LlmProviderPublic } from './llm-providers';

export interface AgentModelSummary {
  providerName: string;
  modelName: string;
}

export function getAgentModelSummary(
  agent: Pick<Agent, 'modelId' | 'providerId' | 'adapterType' | 'adapterConfig'>,
  providers: LlmProviderPublic[],
): AgentModelSummary {
  const provider =
    providers.find((entry) => entry.id === agent.providerId) ??
    providers.find((entry) => entry.isDefault) ??
    providers[0];

  if (provider) {
    return {
      providerName: provider.name,
      modelName: agent.modelId?.trim() || 'Default model',
    };
  }

  const config = resolveModelProviderConfigFromEnv(
    modelProviderOverridesFromAgent(agent.adapterType, agent.adapterConfig),
    agent.modelId,
  );

  return {
    providerName: config.providerName ?? config.provider,
    modelName: agent.modelId?.trim() || config.defaultModel,
  };
}

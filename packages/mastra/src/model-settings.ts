import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  applyContextWindowDefaults,
  resolveContextBudget,
  resolveModelSettings,
  toMastraModelSettings,
  type AgentModelSettings,
  type AgentRuntimeConfig,
  type ContextBudget,
  type ContextBudgetKind,
  type LlmProviderRecord,
  type ReasoningLevel,
} from '@tourbillon/shared';

export interface AgentGenerationOptions {
  modelSettings?: Omit<AgentModelSettings, 'reasoningLevel' | 'maxContextTokens'>;
  reasoning?: ReasoningLevel;
}

/** Resolve effective generation settings for an agent (provider defaults + agent overrides). */
export function resolveAgentModelSettings(
  agentRecord: AgentRecord,
  providerRecord?: LlmProviderRecord | null,
): Omit<AgentModelSettings, 'reasoningLevel' | 'maxContextTokens'> | undefined {
  return toMastraModelSettings(resolveMergedAgentModelSettings(agentRecord, providerRecord));
}

/** Merged provider + agent settings with context-window output default applied. */
export function resolveMergedAgentModelSettings(
  agentRecord: AgentRecord,
  providerRecord?: LlmProviderRecord | null,
): AgentModelSettings {
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  return applyContextWindowDefaults(
    resolveModelSettings(providerRecord?.defaultModelSettings, runtimeConfig.model),
  );
}

export function resolveAgentContextBudget(
  agentRecord: AgentRecord,
  providerRecord: LlmProviderRecord | null | undefined,
  kind: ContextBudgetKind,
): ContextBudget {
  const merged = resolveMergedAgentModelSettings(agentRecord, providerRecord);
  return resolveContextBudget({
    maxContextTokens: merged.maxContextTokens,
    maxOutputTokens: merged.maxOutputTokens,
    kind,
  });
}

/** Resolve numeric modelSettings and optional reasoning level for an agent. */
export function resolveAgentGenerationOptions(
  agentRecord: AgentRecord,
  providerRecord?: LlmProviderRecord | null,
): AgentGenerationOptions {
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  const merged = resolveMergedAgentModelSettings(agentRecord, providerRecord);
  const reasoningLevel = runtimeConfig.model?.reasoningLevel;

  const { reasoningLevel: _ignored, ...numericMerged } = merged;
  const modelSettings = toMastraModelSettings(numericMerged);
  const reasoning = reasoningLevel ?? undefined;

  return {
    ...(modelSettings ? { modelSettings } : {}),
    ...(reasoning ? { reasoning } : {}),
  };
}

/** Build Mastra defaultOptions from resolved generation options. */
export function toMastraDefaultOptions(
  options: AgentGenerationOptions,
): { defaultOptions: { modelSettings?: AgentGenerationOptions['modelSettings']; reasoning?: ReasoningLevel } } | Record<string, never> {
  const { modelSettings, reasoning } = options;
  if (!modelSettings && !reasoning) {
    return {};
  }

  return {
    defaultOptions: {
      ...(modelSettings ? { modelSettings } : {}),
      ...(reasoning ? { reasoning } : {}),
    },
  };
}

/** Build stream/generate call options from resolved generation options. */
export function toMastraCallOptions(
  options: AgentGenerationOptions,
): { modelSettings?: AgentGenerationOptions['modelSettings']; reasoning?: ReasoningLevel } {
  return {
    ...(options.modelSettings ? { modelSettings: options.modelSettings } : {}),
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  };
}

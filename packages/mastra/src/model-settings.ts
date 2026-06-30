import type { Agent as AgentRecord } from '@tourbillon/db';
import {
  resolveModelSettings,
  toMastraModelSettings,
  type AgentModelSettings,
  type AgentRuntimeConfig,
  type LlmProviderRecord,
} from '@tourbillon/shared';

/** Resolve effective generation settings for an agent (provider defaults + agent overrides). */
export function resolveAgentModelSettings(
  agentRecord: AgentRecord,
  providerRecord?: LlmProviderRecord | null,
): AgentModelSettings | undefined {
  const runtimeConfig = agentRecord.runtimeConfig as AgentRuntimeConfig;
  return toMastraModelSettings(
    resolveModelSettings(providerRecord?.defaultModelSettings, runtimeConfig.model),
  );
}

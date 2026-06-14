import { defaultAgentAdapterType, parseModelProviderKind } from './model-provider';
import type { AdapterType } from './types';

export const AGENT_RUNTIME_TYPES = ['agent', 'harness'] as const;
export type AgentRuntimeType = (typeof AGENT_RUNTIME_TYPES)[number];

export const HARNESS_ADAPTER_TYPE = 'harness_local' as const;

export function isHarnessAdapter(adapterType: string): boolean {
  return adapterType === HARNESS_ADAPTER_TYPE;
}

export function agentRuntimeFromAdapter(adapterType: string): AgentRuntimeType {
  return isHarnessAdapter(adapterType) ? 'harness' : 'agent';
}

export function agentRuntimeLabel(adapterType: string): string {
  return isHarnessAdapter(adapterType) ? 'Harness' : 'Agent';
}

export function resolveAdapterFieldsForRuntime(
  runtimeType: AgentRuntimeType,
): { adapterType: AdapterType; adapterConfig: Record<string, unknown> } {
  if (runtimeType === 'harness') {
    return {
      adapterType: HARNESS_ADAPTER_TYPE,
      adapterConfig: { provider: defaultAgentAdapterType() },
    };
  }
  return {
    adapterType: defaultAgentAdapterType(),
    adapterConfig: {},
  };
}

export function parseAgentRuntimeType(value: unknown): AgentRuntimeType | null {
  if (value === 'agent' || value === 'harness') return value;
  return null;
}

/** Resolve LLM provider for an agent record, including harness_local. */
export function resolveAgentModelProvider(adapterType: string, adapterConfig: unknown): string {
  if (isHarnessAdapter(adapterType)) {
    const cfg =
      adapterConfig && typeof adapterConfig === 'object' && !Array.isArray(adapterConfig)
        ? (adapterConfig as Record<string, unknown>)
        : {};
    const fromConfig = parseModelProviderKind(
      typeof cfg.provider === 'string' ? cfg.provider : undefined,
    );
    return fromConfig ?? defaultAgentAdapterType();
  }
  return parseModelProviderKind(adapterType) ?? defaultAgentAdapterType();
}

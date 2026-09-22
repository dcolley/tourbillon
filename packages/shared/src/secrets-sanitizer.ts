import type { AgentRuntimeConfig } from './types';

/**
 * AC-B1.2: Sanitize agent secrets from runtime config before logging, UI display, or observability.
 * Secrets must never appear in prompts, observability logs, or issue comments.
 * 
 * Replaces secret values with key count (e.g., "{ keys: ['KEY1', 'KEY2'] }") or removes entirely.
 */
export function sanitizeAgentSecrets<T extends { runtimeConfig?: unknown }>(
  agent: T,
  options: { showKeys?: boolean } = {}
): T {
  if (!agent.runtimeConfig || typeof agent.runtimeConfig !== 'object') {
    return agent;
  }

  const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;
  
  if (!runtimeConfig.secrets || typeof runtimeConfig.secrets !== 'object') {
    return agent;
  }

  const sanitized: AgentRuntimeConfig = {
    ...runtimeConfig,
    secrets: undefined, // Never include secret values
  };

  if (options.showKeys) {
    // For UI: show only key names, never values
    return {
      ...agent,
      runtimeConfig: {
        ...sanitized,
        // TypeScript doesn't like mixing types, but this is intentional for UI
        __secretKeys: Object.keys(runtimeConfig.secrets),
      } as unknown as typeof agent.runtimeConfig,
    };
  }

  // For logs/observability: completely remove secrets field
  return {
    ...agent,
    runtimeConfig: sanitized as typeof agent.runtimeConfig,
  };
}

/**
 * AC-B1.2: Sanitize runtime config in place (mutating).
 * Use when you need to strip secrets from an existing object reference.
 */
export function stripSecretsInPlace(runtimeConfig: AgentRuntimeConfig): void {
  if (runtimeConfig.secrets) {
    delete runtimeConfig.secrets;
  }
}

/**
 * AC-B1.2: Check if a string contains potential secret patterns.
 * Used to prevent accidental logging of secret values.
 */
export function containsPotentialSecret(text: string, secrets?: Record<string, string>): boolean {
  if (!secrets || typeof secrets !== 'object') {
    return false;
  }

  for (const value of Object.values(secrets)) {
    if (typeof value === 'string' && value.length > 0 && text.includes(value)) {
      return true;
    }
  }

  return false;
}

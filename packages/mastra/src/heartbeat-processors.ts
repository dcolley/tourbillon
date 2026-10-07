import {
  ProviderHistoryCompat,
  TokenLimiterProcessor,
  type InputProcessorOrWorkflow,
} from '@mastra/core/processors';
import {
  resolveContextBudget,
  resolveEnvContextTokenLimit,
  type AgentModelSettings,
  type ContextBudget,
  type ContextBudgetKind,
} from '@tourbillon/shared';
import {
  coalesceConsecutiveUserMessagesRule,
  stripAssistantReasoning,
  stripToolLoopAssistantMonologue,
} from './responses-tool-loop-compat';
import { PinPlainUserAfterTrimProcessor } from './qwen-plain-user-guard';

/**
 * Env fallback when neither provider nor agent sets maxContextTokens.
 * Env: HEARTBEAT_CONTEXT_TOKEN_LIMIT (default 120000)
 */
export function resolveHeartbeatContextTokenLimit(): number {
  return resolveEnvContextTokenLimit();
}

export function resolveHeartbeatContextBudget(
  settings: AgentModelSettings | null | undefined,
  kind: ContextBudgetKind,
): ContextBudget {
  return resolveContextBudget({
    maxContextTokens: settings?.maxContextTokens,
    maxOutputTokens: settings?.maxOutputTokens,
    kind,
  });
}

export function buildHeartbeatInputProcessors(
  options?: { limit?: number },
): InputProcessorOrWorkflow[] {
  return [
    new TokenLimiterProcessor({
      limit: options?.limit ?? resolveHeartbeatContextTokenLimit(),
      // Prefer contiguous recent history so the current tool loop stays coherent.
      trimMode: 'contiguous',
    }),
    // After contiguous trim: re-pin original plain user wake (Qwen requires ≥1)
    // or TripWire fail-closed — never send system+assistant+tool-only prompts.
    new PinPlainUserAfterTrimProcessor(),
    new ProviderHistoryCompat({
      additionalRules: [
        stripAssistantReasoning,
        stripToolLoopAssistantMonologue,
        coalesceConsecutiveUserMessagesRule,
      ],
    }),
  ];
}

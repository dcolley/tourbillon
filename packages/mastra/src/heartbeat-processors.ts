import {
  ProviderHistoryCompat,
  TokenLimiterProcessor,
  type InputProcessorOrWorkflow,
} from '@mastra/core/processors';
import { stripToolLoopAssistantMonologue } from './responses-tool-loop-compat';

/**
 * Cap model input tokens per agentic step so mid-heartbeat tool loops cannot
 * grow past the provider context window. Default leaves headroom under common
 * 128k–242k windows for system + next tool results.
 *
 * Env: HEARTBEAT_CONTEXT_TOKEN_LIMIT (default 120000)
 */
export function resolveHeartbeatContextTokenLimit(): number {
  const raw = process.env.HEARTBEAT_CONTEXT_TOKEN_LIMIT;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 8_000) return n;
  }
  return 120_000;
}

export function buildHeartbeatInputProcessors(): InputProcessorOrWorkflow[] {
  return [
    new TokenLimiterProcessor({
      limit: resolveHeartbeatContextTokenLimit(),
      // Prefer contiguous recent history so the current tool loop stays coherent.
      trimMode: 'contiguous',
    }),
    new ProviderHistoryCompat({
      additionalRules: [stripToolLoopAssistantMonologue],
    }),
  ];
}

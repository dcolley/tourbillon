/**
 * Fetch wrapper that injects sticky session headers for LLM inference requests.
 * Reads from HeartbeatContext to determine agent vs chat session IDs.
 */

import { getCurrentHeartbeatContext } from './heartbeat-context';
import type { StickinessType } from '@tourbillon/shared';

interface StickySessionConfig {
  stickiness: StickinessType;
  headerName: string;
}

/**
 * Build a stable session ID for sticky routing based on stickiness mode.
 * - agent: one stable ID per company + agent
 * - chat: one stable ID per chat thread
 */
function buildStickySessionId(
  stickiness: StickinessType,
  context: { companyId?: string; agentId?: string; threadId?: string },
): string | null {
  if (stickiness === 'agent') {
    if (context.companyId && context.agentId) {
      return `${context.companyId}:${context.agentId}`;
    }
    return null;
  }

  if (stickiness === 'chat') {
    if (context.threadId) {
      return context.threadId;
    }
    return null;
  }

  return null;
}

/**
 * Wrap fetch to inject sticky session headers when configured and context is available.
 */
export function createStickySessionFetch(
  baseFetch: typeof fetch,
  config: StickySessionConfig | null,
): typeof fetch {
  if (!config || config.stickiness === 'off' || !config.headerName.trim()) {
    return baseFetch;
  }

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const context = getCurrentHeartbeatContext();
    if (!context) {
      return baseFetch(input, init);
    }

    const sessionId = buildStickySessionId(config.stickiness, context);
    if (!sessionId) {
      return baseFetch(input, init);
    }

    const headers = new Headers(init?.headers);
    headers.set(config.headerName, sessionId);

    return baseFetch(input, {
      ...init,
      headers,
    });
  };
}

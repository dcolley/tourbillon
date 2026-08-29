/**
 * AsyncLocalStorage for passing heartbeat context (runId) through the async call chain
 * to the fetch wrapper without needing to thread it through Mastra's provider config.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface HeartbeatContext {
  runId: string;
  companyId?: string;
  agentId?: string;
}

export const heartbeatContextStorage = new AsyncLocalStorage<HeartbeatContext>();

/**
 * Get the current heartbeat context if available.
 * Returns undefined when called outside a heartbeat execution.
 */
export function getCurrentHeartbeatContext(): HeartbeatContext | undefined {
  return heartbeatContextStorage.getStore();
}

/**
 * Run a function with heartbeat context set.
 * Used by wake-runner to inject runId before calling agent.generate().
 */
export function runWithHeartbeatContext<T>(
  context: HeartbeatContext,
  fn: () => T | Promise<T>
): Promise<T> {
  return heartbeatContextStorage.run(context, async () => fn());
}

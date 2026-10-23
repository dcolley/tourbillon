/**
 * PRV-1: the provider a run uses, honouring the company's provider switches.
 *
 * Every run path (heartbeat agent, harness controller, dashboard chat) resolves the agent's
 * provider here instead of reading `agents.provider_id` directly:
 * - provider on for the company → used as before;
 * - provider off → the company default (falls back per `chooseCompanyLlmProvider`), with a
 *   warning in the activity log when `recordWarning` is set (written once per agent per
 *   provider change, not per run or chat turn; see `recordLlmProviderFallback`);
 * - nothing on → `NoEnabledLlmProviderError` (callers fail the run with its message).
 * Agents without a provider keep the existing env / registry-default path.
 */
import {
  recordLlmProviderFallback,
  resolveCompanyLlmProviderRow,
  type Agent as AgentRecord,
  type LlmProvider,
} from '@tourbillon/db';
import { formatTrace } from '@tourbillon/shared';

export type AgentProviderResolution = {
  row: LlmProvider | null;
  fallbackFrom: LlmProvider | null;
};

export type ResolveAgentProviderOptions = {
  context: 'heartbeat' | 'chat';
  /** Write the activity warning on fallback. Set at one call site per run / chat session. */
  recordWarning?: boolean;
  runId?: string | null;
};

export type ResolveAgentProviderDeps = {
  resolve?: typeof resolveCompanyLlmProviderRow;
  record?: (...args: Parameters<typeof recordLlmProviderFallback>) => Promise<unknown>;
  warn?: (line: string) => void;
};

export async function resolveAgentProviderRow(
  agent: Pick<AgentRecord, 'id' | 'name' | 'companyId' | 'providerId'>,
  options: ResolveAgentProviderOptions,
  deps: ResolveAgentProviderDeps = {},
): Promise<AgentProviderResolution> {
  const resolve = deps.resolve ?? resolveCompanyLlmProviderRow;
  const record = deps.record ?? recordLlmProviderFallback;
  const warn = deps.warn ?? ((line: string) => console.warn(line));

  const { row, fallbackFrom } = await resolve(agent.companyId, agent.providerId);
  if (row && fallbackFrom) {
    warn(
      formatTrace('company-provider', { agentId: agent.id, agentName: agent.name }, 'provider off for company, using fallback', {
        context: options.context,
        fromProviderId: fallbackFrom.id,
        toProviderId: row.id,
        ...(options.runId ? { runId: options.runId } : {}),
      }),
    );
    if (options.recordWarning) {
      try {
        await record({
          companyId: agent.companyId,
          agentId: agent.id,
          agentName: agent.name,
          from: fallbackFrom,
          to: row,
          context: options.context,
          runId: options.runId ?? null,
        });
      } catch (err) {
        // The run still goes ahead on the fallback; only the activity row is lost.
        warn(
          formatTrace('company-provider', { agentId: agent.id }, 'fallback warning not recorded', {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
  return { row, fallbackFrom };
}

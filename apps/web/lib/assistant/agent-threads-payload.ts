/**
 * S306-S4: one agent's sidebar thread payload — shared by the per-agent list
 * (`GET /api/assistant/agents/[agentId]/threads`) and the batch list
 * (`GET /api/assistant/threads?agentIds=…`), so both return the identical shape per agent.
 * The caller resolves (and so authorises) the agent first; nothing here widens the scope.
 */
import { listAssistantThreads, openAssistantSession } from './threads';
import { assistantOmSummary, resolveActiveAssistantThread } from './active-thread';

type ResolvedAgent = Parameters<typeof resolveActiveAssistantThread>[1] & Parameters<typeof assistantOmSummary>[0];

/** `?limit=`: a positive integer, capped at 200; anything else → the default page. */
export function parseAssistantThreadsLimit(raw: string | null): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : undefined;
}

export async function loadAgentThreadsPayload(
  agent: ResolvedAgent,
  opts: { query?: string | null; limit?: number; viewerKey: string },
) {
  const session = await openAssistantSession(agent);
  const threads = await listAssistantThreads(session, agent, {
    query: opts.query,
    limit: opts.limit,
    viewerKey: opts.viewerKey,
  });
  const initialThreadId = opts.query ? null : await resolveActiveAssistantThread(session, agent, threads);
  return {
    agentId: agent.id,
    threads,
    initialThreadId,
    observationalMemory: await assistantOmSummary(agent),
  };
}

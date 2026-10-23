import { db, agents, heartbeatRuns, approvals } from '@tourbillon/db';
import { and, eq, ne } from 'drizzle-orm';
import { agentChatStatus, type AssistantAgent } from './sidebar';

/**
 * UI-2: the active company's agents for the assistant sidebar, with status.
 * - running: the agent has a heartbeat run in progress;
 * - waiting: the agent has board approvals pending (shown as "waiting on you").
 * Archived agents are left out. Every query is scoped to `companyId`.
 */
export async function listAssistantAgents(companyId: string): Promise<AssistantAgent[]> {
  const [agentRows, runningRows, pendingRows] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        urlKey: agents.urlKey,
        icon: agents.icon,
        reportsToId: agents.reportsToId,
        status: agents.status,
      })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, 'archived'))),
    db
      .select({ agentId: heartbeatRuns.agentId })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, 'running'))),
    db
      .select({ agentId: approvals.requestedByAgentId })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending'))),
  ]);

  const running = new Set(runningRows.map((r) => r.agentId));
  const pending = new Map<string, number>();
  for (const row of pendingRows) {
    if (!row.agentId) continue;
    pending.set(row.agentId, (pending.get(row.agentId) ?? 0) + 1);
  }

  return agentRows
    .map((a) => {
      const pendingApprovals = pending.get(a.id) ?? 0;
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        title: a.title,
        urlKey: a.urlKey,
        icon: a.icon ?? null,
        reportsToId: a.reportsToId ?? null,
        active: a.status === 'active',
        status: agentChatStatus({ running: running.has(a.id), pendingApprovals }),
        pendingApprovals,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

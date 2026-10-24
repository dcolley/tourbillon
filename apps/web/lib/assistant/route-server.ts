/**
 * UI-2b: server side of the assistant view routes (see route.ts). Agents are looked up only in
 * the caller's active company, by url key or id; anything else is not found.
 */
import { notFound, redirect } from 'next/navigation';
import { and, eq, or } from 'drizzle-orm';
import { db, agents } from '@tourbillon/db';
import { getActiveCompanyOrNull } from '@/lib/company';
import { cleanRouteSegment, decideAssistantRoute, type AssistantRouteAgent, type AssistantRouteDecision } from './route';

/** The company's agent whose id or url key is `key` (id wins), else null. Never looks outside the company. */
export async function findCompanyAgentByKey(companyId: string, key: string): Promise<AssistantRouteAgent | null> {
  const rows = await db
    .select({ id: agents.id, urlKey: agents.urlKey })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), or(eq(agents.id, key), eq(agents.urlKey, key))))
    .limit(2);
  return rows.find((r) => r.id === key) ?? rows[0] ?? null;
}

export interface AssistantRouteDeps {
  activeCompanyId: () => Promise<string | null>;
  findAgent: (companyId: string, key: string) => Promise<AssistantRouteAgent | null>;
}

const defaultDeps: AssistantRouteDeps = {
  activeCompanyId: async () => (await getActiveCompanyOrNull())?.id ?? null,
  findAgent: findCompanyAgentByKey,
};

/**
 * Resolve an assistant URL. `null` means "no company selected": the layout shows the company
 * gate, so the page renders nothing of its own.
 */
export async function resolveAssistantRoute(
  input: { agentKey: unknown; threadId?: unknown; via: 'path' | 'query' },
  deps: AssistantRouteDeps = defaultDeps,
): Promise<AssistantRouteDecision | null> {
  const companyId = await deps.activeCompanyId();
  if (!companyId) return null;
  const key = cleanRouteSegment(input.agentKey as string | string[] | undefined);
  const hasThread = input.threadId !== undefined && input.threadId !== null && input.threadId !== '';
  const threadId = hasThread ? cleanRouteSegment(input.threadId as string | string[]) : null;
  if (!key) return { kind: 'not-found' };
  const agent = await deps.findAgent(companyId, key);
  return decideAssistantRoute({ agent, requestedKey: key, threadId, via: input.via, badThread: hasThread && !threadId });
}

/** Apply a decision in a page: redirect / 404, or return what to render. */
export function applyAssistantRoute(decision: AssistantRouteDecision | null): AssistantRouteDecision | null {
  if (decision?.kind === 'redirect') redirect(decision.location);
  if (decision?.kind === 'not-found') notFound();
  return decision;
}

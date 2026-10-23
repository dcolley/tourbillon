import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { AgentChat } from '@/components/assistant/agent-chat';

/** Agent url keys / ids and thread ids accepted from the query (same charset as the AG-UI endpoint). */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && ID.test(s) ? s : undefined;
}

/**
 * UI-1 / AGUI-1b: `/assistant?agent=<urlKey>[&thread=<id>]` opens the AG-UI chat with that agent;
 * without an agent, the placeholder (UI-2 adds the agent/thread sidebar).
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; thread?: string | string[] }>;
}) {
  const params = await searchParams;
  const agentId = one(params.agent);
  if (!agentId) return <AssistantEmptyState />;
  return <AgentChat key={`${agentId}:${one(params.thread) ?? ''}`} agentId={agentId} threadId={one(params.thread)} />;
}

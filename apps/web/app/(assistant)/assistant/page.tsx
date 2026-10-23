import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { AgentChat } from '@/components/assistant/agent-chat';

/** Agent url keys / ids and thread ids accepted from the query (same charset as the AG-UI endpoint). */
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
/** Dot-only values (`.`, `..`) would change the API path once the request URL is normalised. */
const DOT_ONLY = /^\.+$/;

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && ID.test(s) && !DOT_ONLY.test(s) ? s : undefined;
}

function AssistantThreadNotFound() {
  return (
    <p role="alert" className="p-6 text-sm text-destructive">
      Thread not found
    </p>
  );
}

/**
 * UI-1 / AGUI-1b: `/assistant?agent=<urlKey>[&thread=<id>]` opens the AG-UI chat with that agent
 * (without a thread, the agent's latest thread). Once open, the address bar shows the path form
 * `/assistant/<urlKey>/<threadId>`; those path routes (and redirects from this query form) are UI-2b's;
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
  const rawThread = Array.isArray(params.thread) ? params.thread[0] : params.thread;
  const threadId = one(params.thread);
  // A thread id that cannot be valid is reported like an unknown thread, not swapped for another one.
  if (rawThread !== undefined && !threadId) return <AssistantThreadNotFound />;
  return <AgentChat key={`${agentId}:${threadId ?? ''}`} agentId={agentId} threadId={threadId} />;
}

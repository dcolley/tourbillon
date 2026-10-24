import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { AgentChat } from '@/components/assistant/agent-chat';
import type { AssistantRouteDecision } from '@/lib/assistant/route';

/**
 * AGUI-1b: what the assistant path pages (`/assistant/<agent-url-key>[/<threadId>]`, UI-2b) render
 * for a resolved route: the agent chat for that agent (and thread; without one, the agent's latest
 * thread). The chat calls the API with the agent id and keeps the url key in the page link.
 * Anything else (no company selected) renders the empty state; redirects / not-found are applied
 * by applyAssistantRoute before this is reached.
 */
export function assistantRouteView(decision: AssistantRouteDecision | null) {
  if (decision?.kind !== 'render') return <AssistantEmptyState />;
  const { agent, threadId } = decision;
  return (
    <AgentChat
      key={`${agent.id}:${threadId ?? ''}`}
      agentId={agent.id}
      agentKey={agent.urlKey}
      threadId={threadId ?? undefined}
    />
  );
}

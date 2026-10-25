import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { AgentChat } from '@/components/assistant/agent-chat';
import type { AssistantRouteDecision } from '@/lib/assistant/route';
import type { OpenInChatContext } from '@/lib/assistant/open-in-chat';

/**
 * AGUI-1b: what the assistant path pages (`/assistant/<agent-url-key>[/<threadId>]`, UI-2b) render
 * for a resolved route: the agent chat for that agent (and thread; without one, the agent's latest
 * thread). The chat calls the API with the agent id and keeps the url key in the page link.
 * Anything else (no company selected) renders the empty state; redirects / not-found are applied
 * by applyAssistantRoute before this is reached.
 * UI-3: `context` (from `?context=<type>:<id>`, an Open in chat link) starts the composer with that
 * page context as a chip.
 * DM-1: `companyId` (the active company) lets the chat show the agent's DM activity strip.
 */
export function assistantRouteView(
  decision: AssistantRouteDecision | null,
  opts: { context?: OpenInChatContext | null; companyId?: string | null } = {},
) {
  if (decision?.kind !== 'render') return <AssistantEmptyState />;
  const { agent, threadId } = decision;
  return (
    <AgentChat
      key={`${agent.id}:${threadId ?? ''}`}
      agentId={agent.id}
      agentKey={agent.urlKey}
      threadId={threadId ?? undefined}
      {...(opts.context ? { initialContext: opts.context } : {})}
      {...(opts.companyId ? { companyId: opts.companyId } : {})}
    />
  );
}

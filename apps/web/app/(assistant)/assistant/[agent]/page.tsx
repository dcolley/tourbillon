import { assistantRouteView } from '@/components/assistant/assistant-route-view';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';
import { parseOpenInChatContext } from '@/lib/assistant/open-in-chat';

/**
 * `/assistant/<agent-url-key>`: agent chat, latest thread (an agent id in the URL redirects to the url key).
 * `?context=<type>:<id>` (UI-3 Open in chat) starts the composer with that page context.
 */
export default async function AssistantAgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ agent: string }>;
  searchParams: Promise<{ context?: string | string[]; contextTitle?: string | string[] }>;
}) {
  const { agent } = await params;
  const context = parseOpenInChatContext(await searchParams);
  return assistantRouteView(applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, via: 'path' })), { context });
}

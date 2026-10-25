import { assistantRouteView } from '@/components/assistant/assistant-route-view';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';
import { parseOpenInChatContext } from '@/lib/assistant/open-in-chat';

/** `/assistant/<agent-url-key>/<threadId>`: agent chat on that thread (an agent id in the URL redirects to the url key). */
export default async function AssistantThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ agent: string; threadId: string }>;
  searchParams: Promise<{ context?: string | string[]; contextTitle?: string | string[] }>;
}) {
  const { agent, threadId } = await params;
  const context = parseOpenInChatContext(await searchParams);
  return assistantRouteView(applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, threadId, via: 'path' })), { context });
}

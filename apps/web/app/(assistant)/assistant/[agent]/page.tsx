import { assistantRouteView } from '@/components/assistant/assistant-route-view';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';

/** `/assistant/<agent-url-key>`: agent chat, latest thread (an agent id in the URL redirects to the url key). */
export default async function AssistantAgentPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  return assistantRouteView(applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, via: 'path' })));
}

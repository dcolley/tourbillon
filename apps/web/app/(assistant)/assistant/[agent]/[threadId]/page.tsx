import { assistantRouteView } from '@/components/assistant/assistant-route-view';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';

/** `/assistant/<agent-url-key>/<threadId>`: agent chat on that thread (an agent id in the URL redirects to the url key). */
export default async function AssistantThreadPage({ params }: { params: Promise<{ agent: string; threadId: string }> }) {
  const { agent, threadId } = await params;
  return assistantRouteView(applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, threadId, via: 'path' })));
}

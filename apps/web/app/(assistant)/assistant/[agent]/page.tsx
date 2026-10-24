import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';

/** `/assistant/<agent-url-key>`: agent selected (an agent id in the URL redirects to the url key). */
export default async function AssistantAgentPage({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, via: 'path' }));
  return <AssistantEmptyState />;
}

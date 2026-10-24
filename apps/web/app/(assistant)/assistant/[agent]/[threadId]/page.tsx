import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';

/** `/assistant/<agent-url-key>/<threadId>`: thread open (an agent id in the URL redirects to the url key). */
export default async function AssistantThreadPage({ params }: { params: Promise<{ agent: string; threadId: string }> }) {
  const { agent, threadId } = await params;
  applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, threadId, via: 'path' }));
  return <AssistantEmptyState />;
}

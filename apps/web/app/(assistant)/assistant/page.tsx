import { AssistantEmptyState } from '@/components/assistant/assistant-shell';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';

/**
 * `/assistant`. Older `?agent=<key|id>[&thread=<id>]` links redirect to the canonical
 * `/assistant/<agent-url-key>[/<threadId>]` path (UI-2b).
 */
export default async function AssistantPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (params.agent !== undefined) {
    applyAssistantRoute(await resolveAssistantRoute({ agentKey: params.agent, threadId: params.thread, via: 'query' }));
  }
  return <AssistantEmptyState />;
}

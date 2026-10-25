import { assistantRouteView } from '@/components/assistant/assistant-route-view';
import { applyAssistantRoute, resolveAssistantRoute } from '@/lib/assistant/route-server';
import { parseOpenInChatContext } from '@/lib/assistant/open-in-chat';
import { getActiveCompanyOrNull } from '@/lib/company';

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
  const decision = applyAssistantRoute(await resolveAssistantRoute({ agentKey: agent, threadId, via: 'path' }));
  // DM-1: the chat's DM strip reads the company's agent mail through the board session.
  const companyId = decision?.kind === 'render' ? ((await getActiveCompanyOrNull())?.id ?? null) : null;
  return assistantRouteView(decision, { context, companyId });
}

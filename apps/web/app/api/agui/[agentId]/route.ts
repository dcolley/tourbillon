/**
 * AGUI-1: AG-UI endpoint for agent chat (server side).
 *
 * POST an AG-UI RunAgentInput; the response is an AG-UI SSE event stream. The turn runs on the same
 * AgentController session machinery as /api/chat/* (same controller cache, assembled agent, tools,
 * instructions, chat token and heartbeat context), with the same auth: board session + active company,
 * agent looked up inside that company only, agent tokens refused.
 *
 * Tourbillon options ride in `forwardedProps.tourbillon` (see lib/agui/run-input.ts):
 * - action: run (default) | steer | followUp | abort | toolApproval
 * - resourceId (must be one of the active company's chat resources), sessionScope, context
 * The AG-UI threadId is the Mastra memory thread id inside that resource.
 */
import { NextRequest, NextResponse } from 'next/server';
import { EventType, type BaseEvent } from '@ag-ui/core';
import {
  ChatAgentError,
  chatResourceId,
  createChatRequestContext,
  getChatSession,
  getOrCreateChatController,
  resolveChatAgent,
  type TourbillonChatSession,
} from '@/lib/chat';
import { wrapMessageWithDashboardContext } from '@/lib/chat/dashboard-context';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';
import { AguiInputError, parseAguiRequest } from '@/lib/agui/run-input';
import { AGUI_CUSTOM } from '@/lib/agui/session-events';
import {
  AGUI_SSE_HEADERS,
  aguiControlStream,
  aguiRunStream,
  expectRunContinuation,
} from '@/lib/agui/session-stream';
import { runWithHeartbeatContext } from '@tourbillon/mastra';

export const dynamic = 'force-dynamic';

/** Default session scope keeps AG-UI sessions apart from the assistant view's REST sessions. */
const DEFAULT_SESSION_SCOPE = 'agui';

type Agent = Awaited<ReturnType<typeof resolveChatAgent>>;

/** Resource ids are `company-<id>:chat:…` (buildChatResourceId); only the agent's company is accepted. */
function assertCompanyResource(agent: Agent, resourceId: string) {
  if (!resourceId.startsWith(`company-${agent.companyId}:chat:`)) {
    throw new ChatAgentError('Resource not found', 404);
  }
}

async function tagThreadToAgent(session: TourbillonChatSession, agent: Agent) {
  const current = session.thread.getId();
  if (!current) return;
  const thread = await session.thread.getById({ threadId: current });
  const metadata = (thread?.metadata as Record<string, unknown> | undefined) ?? {};
  if (!metadata.agentId) await session.thread.setSetting({ key: 'agentId', value: agent.id });
}

/**
 * Points the session at the AG-UI thread: resume it when it is this resource's thread for this agent,
 * create it when it does not exist, refuse anything else.
 */
async function bindThread(session: TourbillonChatSession, agent: Agent, resourceId: string, threadId: string) {
  if (session.thread.getId() === threadId) return;
  const existing = await session.thread.getById({ threadId });
  if (existing) {
    const ownerAgentId = (existing.metadata as Record<string, unknown> | undefined)?.agentId;
    if (existing.resourceId !== resourceId || (ownerAgentId && ownerAgentId !== agent.id)) {
      throw new ChatAgentError('Thread not found', 404);
    }
  }
  if (session.getCurrentRunId()) {
    throw new ChatAgentError('The session is busy with a run on another thread', 409);
  }
  if (existing) await session.thread.switch({ threadId });
  else await session.thread.create({ id: threadId });
}

function controlResponse(threadId: string, runId: string, action: string, value: Record<string, unknown>) {
  const events: BaseEvent[] = [
    { type: EventType.CUSTOM, name: AGUI_CUSTOM.control, value: { action, ...value } } as BaseEvent,
  ];
  return new Response(aguiControlStream({ threadId, runId, events, result: { action, ...value } }), {
    headers: AGUI_SSE_HEADERS,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  try {
    const { agentId: agentKey } = await params;
    // Auth + company scope first, before reading the body (same order as the chat routes' lookups).
    const agent = await resolveChatAgent(agentKey);

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const request = parseAguiRequest(body);
    const { input, action, props } = request;

    const resourceId = props.resourceId ?? chatResourceId(agent.companyId);
    assertCompanyResource(agent, resourceId);

    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: props.sessionScope ?? DEFAULT_SESSION_SCOPE,
    });
    const requestContext = createChatRequestContext(agent);
    const running = Boolean(session.getCurrentRunId());
    const onThread = session.thread.getId() === input.threadId;

    if (action === 'abort' || action === 'toolApproval' || ((action === 'steer' || action === 'followUp') && running)) {
      if (!onThread) throw new ChatAgentError('Thread not found', 404);
      if (action === 'abort') {
        if (running) session.abort();
        return controlResponse(input.threadId, input.runId, action, { accepted: running });
      }
      if (action === 'toolApproval') {
        for (const decision of request.toolDecisions) {
          await session.respondToToolApproval({
            toolCallId: decision.toolCallId,
            decision: decision.approved ? 'approve' : 'decline',
            requestContext: requestContext as never,
          });
        }
        return controlResponse(input.threadId, input.runId, action, {
          accepted: true,
          toolCallIds: request.toolDecisions.map((d) => d.toolCallId),
        });
      }
      const content = wrapMessageWithDashboardContext(request.message, request.context);
      if (action === 'steer') {
        expectRunContinuation(session);
        void session.steer({ content, requestContext: requestContext as never });
      } else {
        await tagThreadToAgent(session, agent);
        void session.followUp({ content, requestContext: requestContext as never });
      }
      return controlResponse(input.threadId, input.runId, action, { accepted: true });
    }

    // run (or steer / followUp on an idle session, which simply starts a turn).
    if (running) {
      throw new ChatAgentError('A run is already in progress; send steer or followUp instead', 409);
    }
    await bindThread(session, agent, resourceId, input.threadId);
    const content = wrapMessageWithDashboardContext(request.message, request.context);

    const stream = aguiRunStream({
      session,
      threadId: input.threadId,
      runId: input.runId,
      mastraThreadId: input.threadId,
      signal: req.signal,
      start: () =>
        runWithHeartbeatContext(
          { runId: `chat-${agent.id}`, companyId: agent.companyId, agentId: agent.id, threadId: input.threadId },
          async () => {
            await tagThreadToAgent(session, agent);
            await session.sendMessage({
              content,
              files: request.files.length > 0 ? request.files : undefined,
              requestContext: requestContext as never,
            });
          },
        ),
    });
    return new Response(stream, { headers: AGUI_SSE_HEADERS });
  } catch (err) {
    if (err instanceof AguiInputError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return chatErrorResponse(err);
  }
}

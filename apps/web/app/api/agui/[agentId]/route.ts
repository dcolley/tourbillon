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
 *
 * Thread ownership is checked on every request, for runs and for control actions alike: the thread
 * must exist, belong to the requested resource and be tagged to this agent. Threads are created
 * through the chat thread API; an unknown thread id is a 404 here and is never created.
 *
 * One run per thread and per session: the run is claimed synchronously (no await between the check
 * and the claim) and released when its stream closes. Follow-ups sent while the run is open are queued
 * on the claim and dropped when the stream closes. See lib/agui/run-claims.ts.
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
import { AguiInputError, aguiSessionScope, parseAguiRequest } from '@/lib/agui/run-input';
import { AGUI_CUSTOM } from '@/lib/agui/session-events';
import { activeAguiRun, claimAguiRun, isAguiRunClaimed } from '@/lib/agui/run-claims';
import {
  AGUI_SSE_HEADERS,
  aguiControlStream,
  aguiRunStream,
  expectRunContinuation,
} from '@/lib/agui/session-stream';
import { runWithHeartbeatContext } from '@tourbillon/mastra';

export const dynamic = 'force-dynamic';

type Agent = Awaited<ReturnType<typeof resolveChatAgent>>;

/** Resource ids are `company-<id>:chat:…` (buildChatResourceId); only the agent's company is accepted. */
function assertCompanyResource(agent: Agent, resourceId: string) {
  if (!resourceId.startsWith(`company-${agent.companyId}:chat:`)) {
    throw new ChatAgentError('Resource not found', 404);
  }
}

/** The thread must exist, sit in this resource and be tagged to this agent; anything else is a 404. */
async function assertOwnedThread(
  session: TourbillonChatSession,
  agent: Agent,
  resourceId: string,
  threadId: string,
) {
  const thread = await session.thread.getById({ threadId });
  const ownerAgentId = (thread?.metadata as Record<string, unknown> | undefined)?.agentId;
  if (!thread || thread.resourceId !== resourceId || ownerAgentId !== agent.id) {
    throw new ChatAgentError('Thread not found', 404);
  }
}

/** Points the session at the (already verified) AG-UI thread. */
async function bindThread(session: TourbillonChatSession, threadId: string) {
  if (session.thread.getId() === threadId) return;
  if (session.getCurrentRunId()) {
    throw new ChatAgentError('The session is busy with a run on another thread', 409);
  }
  await session.thread.switch({ threadId });
}

function controlResponse(threadId: string, runId: string, action: string, value: Record<string, unknown>) {
  const events: BaseEvent[] = [
    { type: EventType.CUSTOM, name: AGUI_CUSTOM.control, value: { action, ...value } } as BaseEvent,
  ];
  return new Response(aguiControlStream({ threadId, runId, events, result: { action, ...value } }), {
    headers: AGUI_SSE_HEADERS,
  });
}

type ToolApprovalResult = { accepted: boolean; reason?: string };

function toToolApprovalResult(result: unknown): ToolApprovalResult {
  const r = result as { accepted?: unknown; reason?: unknown } | undefined;
  if (r && r.accepted === true) return { accepted: true };
  return { accepted: false, reason: typeof r?.reason === 'string' ? r.reason : 'not_pending' };
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
      scope: aguiSessionScope(agent, props.sessionScope),
    });
    await assertOwnedThread(session, agent, resourceId, input.threadId);

    // ---- No await from here until the run is claimed (or the control action is decided). ----
    const requestContext = createChatRequestContext(agent);
    const running = Boolean(session.getCurrentRunId());
    const claimed = isAguiRunClaimed(session, resourceId, input.threadId);
    const active = activeAguiRun(session, resourceId, input.threadId);
    const onThread = session.thread.getId() === input.threadId;
    const heartbeat = {
      runId: `chat-${agent.id}`,
      companyId: agent.companyId,
      agentId: agent.id,
      threadId: input.threadId,
    };

    const queueOnOpenRun = action === 'followUp' && Boolean(active) && onThread;
    const isControl =
      action === 'abort' ||
      action === 'toolApproval' ||
      queueOnOpenRun ||
      ((action === 'steer' || action === 'followUp') && running);
    if (isControl) {
      if (!running && claimed && !queueOnOpenRun) {
        throw new ChatAgentError('A run is starting on this thread; retry shortly', 409);
      }
      if (!onThread) throw new ChatAgentError('Thread not found', 404);
      if (action === 'abort') {
        active?.dropQueuedTurns();
        if (running) session.abort();
        return controlResponse(input.threadId, input.runId, action, { accepted: running });
      }
      if (action === 'toolApproval') {
        const results: Array<ToolApprovalResult & { toolCallId: string }> = [];
        for (const decision of request.toolDecisions) {
          const result = await session.respondToToolApproval({
            toolCallId: decision.toolCallId,
            decision: decision.approved ? 'approve' : 'decline',
            requestContext: requestContext as never,
          });
          results.push({ toolCallId: decision.toolCallId, ...toToolApprovalResult(result) });
        }
        return controlResponse(input.threadId, input.runId, action, {
          accepted: results.length > 0 && results.every((r) => r.accepted),
          toolCallIds: request.toolDecisions.map((d) => d.toolCallId),
          results,
        });
      }
      const content = wrapMessageWithDashboardContext(request.message, request.context);
      if (action === 'steer') {
        expectRunContinuation(session);
        void session.steer({ content, requestContext: requestContext as never });
      } else if (active) {
        // Started by the open AG-UI stream once the current turn completes; dropped if it closes first.
        const queued = active.queueTurn(() =>
          runWithHeartbeatContext(heartbeat, () =>
            session.sendMessage({ content, requestContext: requestContext as never }),
          ),
        );
        return controlResponse(input.threadId, input.runId, action, { accepted: true, queued });
      } else {
        void session.followUp({ content, requestContext: requestContext as never });
      }
      return controlResponse(input.threadId, input.runId, action, { accepted: true });
    }

    // run (or steer / followUp on an idle session, which simply starts a turn).
    if (running) {
      throw new ChatAgentError('A run is already in progress; send steer or followUp instead', 409);
    }
    const claim = claimAguiRun(session, resourceId, input.threadId);
    if (!claim) {
      throw new ChatAgentError('A run is already in progress; send steer or followUp instead', 409);
    }
    // ---- Claimed: awaits are safe again; the claim is released when the stream closes. ----
    try {
      await bindThread(session, input.threadId);
    } catch (err) {
      claim.release();
      throw err;
    }
    const content = wrapMessageWithDashboardContext(request.message, request.context);

    const stream = aguiRunStream({
      session,
      threadId: input.threadId,
      runId: input.runId,
      mastraThreadId: input.threadId,
      signal: req.signal,
      onClose: claim.release,
      takeQueuedTurn: claim.takeQueuedTurn,
      start: () =>
        runWithHeartbeatContext(
          heartbeat,
          async () => {
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

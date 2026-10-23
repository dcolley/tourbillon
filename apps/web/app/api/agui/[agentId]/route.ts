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
 * must exist, belong to the requested resource and be tagged to this agent (`metadata.agentId`).
 * AG-UI clients must create threads through the REST chat thread API
 * (POST /api/chat/[agentId]/sessions/[resourceId]/threads), which tags the thread to the agent, and
 * then pass that id as the AG-UI threadId. This route never creates a thread: a client-chosen
 * threadId that does not exist is a 404, and an existing thread that is not tagged to this agent
 * (including untagged threads) is refused with 404.
 *
 * One run per thread and per session: the run is claimed synchronously (no await between the check
 * and the claim) and released when its stream closes. Control actions that act on a run (abort, steer,
 * followUp, toolApproval / AG-UI `resume`) are refused with 409 when the thread's run is claimed by
 * another session (e.g. another sessionScope of the same agent). Follow-ups sent while the run is open
 * are queued on the claim; any that will not run (abort, error, run ended first) are reported to the
 * client as a `tourbillon.follow_up_dropped` CUSTOM event on the open run, and the abort control
 * response carries `droppedFollowUps`. See lib/agui/run-claims.ts.
 *
 * Widgets (WID-1, see lib/agui/widgets.ts): widget tools declared by the client in `tools` and known
 * to the server are offered to the run as suspending frontend tools. An AG-UI `resume` entry for a
 * suspended widget call carries the user's answer (`payload: { answer }`) or a dismissal
 * (`status: 'cancelled'`); the answer is validated against the server spec, then the suspended tool
 * is resumed on a new streaming run (one widget per request). Refused with 400 when the answer is
 * invalid or mixed with other decisions, 409 when the call was already answered or a run is open.
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
import {
  activeAguiRun,
  claimAguiRun,
  isAguiRunClaimed,
  isAguiThreadClaimedByOtherSession,
} from '@/lib/agui/run-claims';
import {
  AGUI_SSE_HEADERS,
  aguiControlStream,
  aguiRunStream,
  expectRunContinuation,
} from '@/lib/agui/session-stream';
import { runWithHeartbeatContext } from '@tourbillon/mastra';
import { setRequestWidgetSpecs } from '@tourbillon/mastra/widget-tools';
import { assistantWidgetSpecIndex } from '@/components/assistant/widgets/specs';
import { selectWidgetSpecs, suspendedWidgetSpec, widgetResumeFromEntry } from '@/lib/agui/widgets';

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
    // Widget tools the client declared and the server knows (request-scoped, see lib/agui/widgets.ts).
    const offeredWidgets = selectWidgetSpecs(assistantWidgetSpecIndex, input.tools);
    if (offeredWidgets.length > 0) setRequestWidgetSpecs(requestContext, offeredWidgets);
    const running = Boolean(session.getCurrentRunId());
    const claimed = isAguiRunClaimed(session, resourceId, input.threadId);
    const active = activeAguiRun(session, resourceId, input.threadId);
    const claimedByOther = isAguiThreadClaimedByOtherSession(session, resourceId, input.threadId);
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
      // Only the session that owns the open run may act on it (approve / resume, abort, steer, follow up).
      if (claimedByOther) {
        throw new ChatAgentError('The run on this thread belongs to another session', 409);
      }
      if (!running && claimed && !queueOnOpenRun) {
        throw new ChatAgentError('A run is starting on this thread; retry shortly', 409);
      }
      if (!onThread) throw new ChatAgentError('Thread not found', 404);
      if (action === 'abort') {
        const droppedFollowUps = active?.dropQueuedTurns() ?? 0;
        if (running) session.abort();
        return controlResponse(input.threadId, input.runId, action, {
          accepted: running,
          ...(droppedFollowUps > 0 ? { droppedFollowUps } : {}),
        });
      }
      const widgetEntries =
        action === 'toolApproval'
          ? request.resume.filter((e) => suspendedWidgetSpec(assistantWidgetSpecIndex, session, e.toolCallId))
          : [];
      if (widgetEntries.length > 0) {
        if (request.toolDecisions.length !== 1) {
          return NextResponse.json(
            { error: 'Answer one widget per request, without other tool decisions' },
            { status: 400 },
          );
        }
        const entry = widgetEntries[0];
        const spec = suspendedWidgetSpec(assistantWidgetSpecIndex, session, entry.toolCallId)!;
        const decision = widgetResumeFromEntry(spec, entry);
        if (!decision.ok) {
          return NextResponse.json({ error: 'Invalid widget answer', issues: decision.issues }, { status: 400 });
        }
        if (claimed) throw new ChatAgentError('A run is open on this thread; retry shortly', 409);
        const responseClaim = session.claimToolSuspension(entry.toolCallId);
        if (!responseClaim.accepted) throw new ChatAgentError('This widget is no longer waiting for an answer', 409);
        const toolCallId = responseClaim.toolCallId;
        const claim = claimAguiRun(session, resourceId, input.threadId);
        if (!claim) {
          session.releaseToolResponse(toolCallId);
          throw new ChatAgentError('A run is open on this thread; retry shortly', 409);
        }
        // The resumed tool must be in this run's toolsets even if the client did not re-declare it.
        setRequestWidgetSpecs(requestContext, [...offeredWidgets.filter((s) => s.name !== spec.name), spec]);
        const stream = aguiRunStream({
          session,
          threadId: input.threadId,
          runId: input.runId,
          mastraThreadId: input.threadId,
          resourceId,
          signal: req.signal,
          resumedToolCallIds: [toolCallId],
          onClose: () => {
            session.releaseToolResponse(toolCallId);
            claim.release();
          },
          takeQueuedTurn: claim.takeQueuedTurn,
          droppedQueuedTurns: () => claim.droppedTurns() + claim.queuedTurns(),
          start: () =>
            runWithHeartbeatContext(heartbeat, () =>
              session.respondToToolSuspension({
                resumeData: decision.resume,
                toolCallId,
                requestContext: requestContext as never,
              }),
            ),
        });
        return new Response(stream, { headers: AGUI_SSE_HEADERS });
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
      resourceId,
      signal: req.signal,
      onClose: claim.release,
      takeQueuedTurn: claim.takeQueuedTurn,
      droppedQueuedTurns: () => claim.droppedTurns() + claim.queuedTurns(),
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

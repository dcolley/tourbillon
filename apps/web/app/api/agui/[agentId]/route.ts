/**
 * AGUI-1: AG-UI endpoint for agent chat (server side).
 *
 * POST an AG-UI RunAgentInput; the response is an AG-UI SSE event stream. The turn runs on the same
 * AgentController session machinery as /api/chat/* (same controller cache, assembled agent, tools,
 * instructions, chat token and heartbeat context), with the same auth: board session + active company,
 * agent looked up inside that company only, agent tokens refused.
 *
 * Tourbillon options ride in `forwardedProps.tourbillon` (see lib/agui/run-input.ts):
 * - action: run (default) | steer | followUp | abort | toolApproval | pending | attach
 * - resourceId (must be one of the active company's chat resources), sessionScope, context
 * The AG-UI threadId is the Mastra memory thread id inside that resource.
 *
 * Thread ownership is checked on every request, for runs and for control actions alike: the thread
 * must exist, belong to the requested resource and be tagged to this agent (`metadata.agentId`).
 * AG-UI clients create threads through the assistant threads API
 * (POST /api/assistant/agents/[agentId]/threads), which tags the thread to the agent, and then pass
 * that id as the AG-UI threadId. This route never creates a thread: a client-chosen
 * threadId that does not exist is a 404, and an existing thread that is not tagged to this agent
 * (including untagged threads) is refused with 404.
 *
 * One run per thread and per session: the run is claimed synchronously (no await between the check
 * and the claim) and released when the run ends. Control actions that act on a run (abort, steer,
 * followUp, toolApproval / AG-UI `resume`) are refused with 409 when the thread's run is claimed by
 * another session (e.g. another sessionScope of the same agent). Follow-ups sent while the run is open
 * are queued on the claim; any that will not run (abort, error, run ended first) are reported to the
 * client as a `tourbillon.follow_up_dropped` CUSTOM event on the open run, and the abort control
 * response carries `droppedFollowUps`. See lib/agui/run-claims.ts.
 *
 * The endpoint answers 404 when the assistant is turned off (ASSISTANT_ENABLED=false, see
 * lib/feature-flags.ts), checked before anything else.
 *
 * Widgets (WID-1, see lib/agui/widgets.ts): widget tools declared by the client in `tools` and known
 * to the server are offered to the run as suspending frontend tools. An AG-UI `resume` entry for a
 * suspended widget call carries the user's answer (`payload: { answer }`) or a dismissal
 * (`status: 'cancelled'`); the answer is validated against the server spec, then the suspended tool
 * is resumed on a new streaming run (one widget per request). Refused with 400 when the answer is
 * invalid, mixed with other decisions or for a widget call no AG-UI run asked; 409 when another
 * session asked the widget (only the asking session may answer or dismiss it, see
 * lib/agui/widget-owners.ts) or a run is open; while another session's widget is pending on the thread,
 * every action from other sessions is refused with 409; an owner's repeat after the answer gets
 * `accepted:false`. A steer is refused with 409 while this session has a widget waiting (answer or
 * dismiss it first); a follow-up is queued and runs after the answer. Run errors on a resumed widget
 * run carry a generic message; details are logged server-side.
 *
 * Parked cards (WID-3, see lib/agui/parked-widgets.ts): the run stays parked while a card waits, so
 * - action `pending` answers (control stream, nothing claimed) with the cards this session still has
 *   waiting on the thread (`widgets`, with the props they were asked with) and the card its run is
 *   parked on (`parked`, possibly on another thread), so a reloaded chat shows the cards again;
 * - a new run refused because this session's run is parked on a card gets a 409 that names the card
 *   (`pendingWidget: { threadId, toolCallId, toolName, label? }`); the client offers to answer or
 *   dismiss it, or to stop the run (action `abort` on that thread).
 *
 * STREAM-1: a client that goes away (closed or backgrounded tab, iPad Safari suspending the fetch) only
 * detaches from the run; the run, its claim and its queued follow-ups carry on. Only action `abort`
 * stops a run. Action `attach` gives the same session a new SSE body for its open run on the thread
 * (the run's events so far, replayed, then live; lib/agui/session-stream.ts); with no open run it
 * answers a control stream `{ accepted: false, running }`, and the client reloads the history.
 *
 * OBS-1: when Mastra tracing is on, each AG-UI run gets one trace id (attributes companyId, agentId,
 * threadId, view=assistant, provider, model; see buildAssistantTracingOptions). It is passed to the
 * turn and to follow-ups queued on the run, sent to the client as a `tourbillon.trace` CUSTOM event
 * and in the RUN_FINISHED result, and Mastra stamps it on the saved assistant message
 * (`content.metadata.traceId`). `traceUrl` is added only when PHOENIX_UI_BASE_URL is set.
 *
 * CHAT-5: a thread may carry its own model choice (provider, model, effort; thread metadata
 * `assistantModel`, set through /api/assistant/agents/[agentId]/threads/[threadId]/model). It wins
 * over the agent's model and over `?modelId=`. On every request the provider is re-checked (it must
 * exist and be on for the company, PRV-1); when it is not, every action except abort is refused
 * with 409 `provider_disabled_for_company`. The run's trace attributes then carry the chosen
 * provider and model, `modelSource=thread` and the effort when one is set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveChatRequestUser } from '@/lib/chat/request-user';
import { isAssistantAvailable } from '@/lib/feature-flags';
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
import { steerPreservingTurn } from '@/lib/chat/steer-preserving-turn';
import { chatErrorResponse } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';
import { resolveThreadRunModel, threadProviderRefusedBody, type ThreadRunModel } from '@/lib/chat/thread-model';
import { threadModelChoiceFromMetadata } from '@/lib/assistant/thread-model';
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
import { buildAssistantTracingOptions, runWithHeartbeatContext } from '@tourbillon/mastra';
import { phoenixUiBaseUrl } from '@tourbillon/shared';
import { buildTraceUrl } from '@/lib/assistant/trace-link';
import { setRequestWidgetSpecs } from '@tourbillon/mastra/widget-tools';
import { assistantWidgetSpecIndex } from '@/components/assistant/widgets/specs';
import { isWidgetAnswerEntry, selectWidgetSpecs, suspendedWidgetSpec, widgetResumeFromEntry } from '@/lib/agui/widgets';
import { parkedWidgetCall, parkedWidgetMessage, pendingWidgetCards } from '@/lib/agui/parked-widgets';
import {
  hasOtherSessionPendingWidget,
  pendingOwnedWidgetCalls,
  trackWidgetOwners,
  widgetCallArgs,
  widgetOwnership,
} from '@/lib/agui/widget-owners';

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
  return thread;
}

/** Points the session at the (already verified) AG-UI thread. */
async function bindThread(session: TourbillonChatSession, threadId: string) {
  if (session.thread.getId() === threadId) return;
  if (session.getCurrentRunId()) {
    throw new ChatAgentError('The session is busy with a run on another thread', 409);
  }
  await session.thread.switch({ threadId });
}

const isWidgetTool = (toolName: string) => Boolean(assistantWidgetSpecIndex.latest(toolName)?.frontendTool);

/**
 * A dismissal-shaped resume entry (`cancelled`, no payload) for a call that is neither a parked widget
 * nor a pending tool approval in this session: handled by the widget branch, which answers it with
 * `accepted:false` / `not_pending` and resumes nothing (an unknown answer is a 400).
 */
function isUnknownDismissal(
  session: { approval?: { getToolCallIds?(): string[] } },
  entry: { toolCallId: string; status: string; payload?: unknown },
): boolean {
  if (entry.status !== 'cancelled' || (entry.payload !== undefined && entry.payload !== null)) return false;
  const pendingApprovals = session.approval?.getToolCallIds?.() ?? [];
  return !pendingApprovals.includes(entry.toolCallId);
}

const WIDGET_RUN_ERROR = 'The widget answer could not be processed. Please try again.';

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

/** OBS-1: tracing options for one assistant run (undefined when Mastra tracing is off). */
function assistantTracing(
  agent: Agent,
  threadId: string,
  aguiRunId: string,
  modelIdOverride: string | undefined,
  runModel: ThreadRunModel,
) {
  const thread = runModel.source === 'thread' ? runModel.choice : null;
  return buildAssistantTracingOptions({
    companyId: agent.companyId,
    agentId: agent.id,
    agentUrlKey: agent.urlKey,
    threadId,
    provider: thread ? thread.providerId : agent.providerId,
    model: thread ? thread.modelId : (modelIdOverride ?? agent.modelId),
    aguiRunId,
    // CHAT-5: only set for a thread choice, so agent-default runs keep the same attributes.
    ...(thread ? { modelSource: 'thread' as const, reasoningLevel: thread.reasoningLevel ?? null } : {}),
  });
}

function traceUrlField(traceUrl: string | undefined): { traceUrl?: string } {
  return traceUrl ? { traceUrl } : {};
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  if (!isAssistantAvailable()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
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

    const modelIdOverride = chatModelIdFromSearch(req);
    const sessionScope = aguiSessionScope(agent, props.sessionScope);
    let controller = await getOrCreateChatController(agent, { modelIdOverride });
    let session = await getChatSession(controller, agent, { resourceId, scope: sessionScope });
    const thread = await assertOwnedThread(session, agent, resourceId, input.threadId);

    // CHAT-5: the thread's own model choice, re-checked against company enablement on every request.
    const runModel = await resolveThreadRunModel(agent.companyId, threadModelChoiceFromMetadata(thread.metadata));
    if (runModel.source === 'thread') {
      if (!runModel.allowed && action !== 'abort') {
        return NextResponse.json(threadProviderRefusedBody(), { status: 409 });
      }
      controller = await getOrCreateChatController(agent, runModel.opts);
      session = await getChatSession(controller, agent, {
        resourceId,
        scope: sessionScope,
        createInitialThread: false,
      });
    }

    // ---- No await from here until the run is claimed (or the control action is decided). ----
    const requestContext = createChatRequestContext(agent, {
      threadId: input.threadId,
      requestingUser: await resolveChatRequestUser(req.headers),
    });
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

    // While another session's widget is pending on this thread, only that session may act on the thread
    // (its run is parked on the widget): refuse every action from other sessions.
    if (hasOtherSessionPendingWidget(session, resourceId, input.threadId)) {
      throw new ChatAgentError('A widget on this thread is waiting on another session', 409);
    }
    // WID-3: the cards this session still has waiting here (a reloaded chat shows them again).
    if (action === 'pending') {
      const parked = parkedWidgetCall(assistantWidgetSpecIndex, session, resourceId);
      return controlResponse(input.threadId, input.runId, action, {
        accepted: true,
        widgets: pendingWidgetCards(assistantWidgetSpecIndex, session, resourceId, input.threadId),
        parked: parked ?? null,
      });
    }
    // STREAM-1: re-subscribe to this session's open run on the thread (nothing is claimed or started).
    if (action === 'attach') {
      const attached = onThread && !claimedByOther ? active?.attach(req.signal) : null;
      if (attached) return new Response(attached, { headers: AGUI_SSE_HEADERS });
      return controlResponse(input.threadId, input.runId, action, { accepted: false, running: running && onThread });
    }
    // A steer would abort the run parked on this session's widget and drop the widget: refuse it.
    if (action === 'steer' && onThread && pendingOwnedWidgetCalls(session, resourceId, input.threadId).length > 0) {
      throw new ChatAgentError('A widget is waiting for an answer; answer or dismiss it first', 409);
    }

    // One trace per AG-UI run; a follow-up queued on an open run joins that run's trace.
    const tracingOptions = active?.tracingOptions ?? assistantTracing(agent, input.threadId, input.runId, modelIdOverride, runModel);

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
          ? request.resume.filter(
              (e) =>
                Boolean(suspendedWidgetSpec(assistantWidgetSpecIndex, session, e.toolCallId)) ||
                widgetOwnership(session, resourceId, input.threadId, e.toolCallId) !== 'unknown' ||
                isWidgetAnswerEntry(e) ||
                isUnknownDismissal(session, e),
            )
          : [];
      if (widgetEntries.length > 0) {
        if (request.toolDecisions.length !== 1) {
          return NextResponse.json(
            { error: 'Answer one widget per request, without other tool decisions' },
            { status: 400 },
          );
        }
        const entry = widgetEntries[0];
        // Mastra parks the call in every session watching the thread: only the asking session may answer.
        const ownership = widgetOwnership(session, resourceId, input.threadId, entry.toolCallId);
        const spec = suspendedWidgetSpec(assistantWidgetSpecIndex, session, entry.toolCallId);
        // Parked here but asked by another session, or its owner has gone: fail closed.
        if (ownership === 'other' || (ownership !== 'owner' && spec)) {
          throw new ChatAgentError('This widget is waiting on another session', 409);
        }
        if (ownership === 'unknown' && !isUnknownDismissal(session, entry)) {
          return NextResponse.json({ error: 'Unknown widget call' }, { status: 400 });
        }
        if (!spec) {
          // Nothing to resume: the owner's widget was already answered or dismissed, its owner has gone
          // (controller dropped), or a dismissal / decline names a call that is no longer pending (e.g. an
          // approval settled just before it arrived).
          return controlResponse(input.threadId, input.runId, action, {
            accepted: false,
            toolCallIds: [entry.toolCallId],
            results: [{ toolCallId: entry.toolCallId, accepted: false, reason: 'not_pending' }],
          });
        }
        // WID-3: answers are checked against the args the card was asked with (recorded with the owner).
        const decision = widgetResumeFromEntry(
          spec,
          entry,
          new Date(),
          widgetCallArgs(resourceId, input.threadId, entry.toolCallId),
        );
        if (!decision.ok) {
          return NextResponse.json({ error: 'Invalid widget answer', issues: decision.issues }, { status: 400 });
        }
        const claim = claimAguiRun(session, resourceId, input.threadId);
        if (!claim) throw new ChatAgentError('A run is open on this thread; retry shortly', 409);
        // Mastra 1.78: the claim is keyed by the suspension ADDRESS (resourceId, threadId, runId,
        // toolCallId), not the tool call id — the same claimKey must be released and is what
        // interlocks a second concurrent answer of the same parked call.
        const responseClaim = session.claimToolSuspension(entry.toolCallId);
        if (!responseClaim.accepted) {
          claim.release();
          throw new ChatAgentError('This widget is no longer waiting for an answer', 409);
        }
        const { toolCallId, address, claimKey } = responseClaim;
        const untrackWidgets = trackWidgetOwners(session, resourceId, input.threadId, isWidgetTool, controller);
        // The resumed tool must be in this run's toolsets even if the client did not re-declare it.
        setRequestWidgetSpecs(requestContext, [...offeredWidgets.filter((s) => s.name !== spec.name), spec]);
        const stream = aguiRunStream({
          session,
          threadId: input.threadId,
          runId: input.runId,
          mastraThreadId: input.threadId,
          resourceId,
          signal: req.signal,
          onAttachable: claim.setAttach,
          resumedToolCallIds: [toolCallId],
          publicRunError: WIDGET_RUN_ERROR,
          onClose: () => {
            untrackWidgets();
            // Release the ADDRESS claim taken above (releasing the toolCallId would leak it).
            session.releaseToolResponse(claimKey);
            claim.release();
          },
          takeQueuedTurn: claim.takeQueuedTurn,
          droppedQueuedTurns: () => claim.droppedTurns() + claim.queuedTurns(),
          // 1.78: a resume failure on the active thread surfaces as a session `error` event
          // (respondToToolSuspension no longer throws) — end the run with the generic widget error.
          errorIsTerminal: true,
          start: () =>
            runWithHeartbeatContext(heartbeat, () =>
              session.respondToToolSuspension({
                resumeData: decision.resume,
                toolCallId,
                address,
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
        // STEER-1: keep the interrupted user turn in history for the steer run.
        void steerPreservingTurn(session, { content, requestContext }).catch((err) =>
          console.error('[agui] steer failed', err),
        );
      } else if (active) {
        // Started by the open AG-UI stream once the current turn completes; dropped if it closes first.
        const queued = active.queueTurn(() =>
          runWithHeartbeatContext(heartbeat, () =>
            session.sendMessage({
              content,
              requestContext: requestContext as never,
              ...(tracingOptions ? { tracingOptions } : {}),
            }),
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
      // WID-3: parked on one of this session's cards: say which, so the client can offer answer / dismiss / Stop.
      const parked = parkedWidgetCall(assistantWidgetSpecIndex, session, resourceId);
      if (parked) {
        return NextResponse.json(
          { error: parkedWidgetMessage(parked, parked.threadId === input.threadId), pendingWidget: parked },
          { status: 409 },
        );
      }
      throw new ChatAgentError('A run is already in progress; send steer or followUp instead', 409);
    }
    const claim = claimAguiRun(session, resourceId, input.threadId, { tracingOptions });
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
    // Records this session as the owner of any widget call the run asks (lib/agui/widget-owners.ts).
    const untrackWidgets = trackWidgetOwners(session, resourceId, input.threadId, isWidgetTool, controller);

    const stream = aguiRunStream({
      session,
      threadId: input.threadId,
      runId: input.runId,
      mastraThreadId: input.threadId,
      resourceId,
      signal: req.signal,
      onAttachable: claim.setAttach,
      onClose: () => {
        untrackWidgets();
        claim.release();
      },
      takeQueuedTurn: claim.takeQueuedTurn,
      droppedQueuedTurns: () => claim.droppedTurns() + claim.queuedTurns(),
      ...(tracingOptions
        ? {
            trace: {
              traceId: tracingOptions.traceId,
              ...traceUrlField(buildTraceUrl(phoenixUiBaseUrl(), tracingOptions.traceId)),
            },
          }
        : {}),
      start: () =>
        runWithHeartbeatContext(
          heartbeat,
          async () => {
            await session.sendMessage({
              content,
              files: request.files.length > 0 ? request.files : undefined,
              requestContext: requestContext as never,
              ...(tracingOptions ? { tracingOptions } : {}),
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

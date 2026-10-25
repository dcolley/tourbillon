/**
 * OBS-2: read and save the viewer's reactions on an assistant thread's messages.
 * The thread must be the agent's (same scope as the other assistant thread routes) and the message
 * an assistant message in that thread. The trace id comes from the stored message
 * (`content.metadata.traceId`, OBS-1), never from the client.
 */
import type { TourbillonChatSession } from '@/lib/chat';
import { traceIdFromMessage } from '@/lib/assistant/trace-link';
import { saveAssistantMessageFeedbackRow } from '@/lib/assistant/feedback-store';
import { postTraceAnnotation } from '@/lib/assistant/phoenix-annotations';
import { AssistantThreadError, assistantResourceId, requireAssistantThread } from './threads';
import {
  buildMessageFeedback,
  feedbackAnnotation,
  readThreadFeedback,
  type AnnotationOutcome,
  type FeedbackInput,
  type MessageFeedback,
  type ThreadFeedback,
  type TraceAnnotation,
} from './feedback';

type AgentLike = { id: string; companyId: string; status?: string | null };

export async function getAssistantThreadFeedback(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
  viewerKey: string,
): Promise<ThreadFeedback> {
  const thread = await requireAssistantThread(session, agent, threadId);
  return readThreadFeedback(thread.metadata, viewerKey);
}

export interface SaveFeedbackDeps {
  annotate?: (annotation: TraceAnnotation) => Promise<AnnotationOutcome>;
  now?: () => Date;
}

export interface SavedFeedback {
  messageId: string;
  feedback: MessageFeedback;
  annotation: AnnotationOutcome;
}

/** Saves (or replaces) the viewer's reaction, then annotates the message's trace when it has one. */
export async function saveAssistantMessageFeedback(
  session: TourbillonChatSession,
  agent: AgentLike,
  threadId: string,
  input: FeedbackInput,
  viewerKey: string,
  deps: SaveFeedbackDeps = {},
): Promise<SavedFeedback> {
  await requireAssistantThread(session, agent, threadId);
  const messages = await session.thread.listMessages({ threadId });
  const message = messages.find((m) => m.id === input.messageId);
  if (!message || message.role !== 'assistant') throw new AssistantThreadError('Message not found', 404);

  const feedback = buildMessageFeedback(input, deps.now?.() ?? new Date());
  const scope = { threadId, resourceId: assistantResourceId(agent.companyId), agentId: agent.id };
  if (!(await saveAssistantMessageFeedbackRow(scope, input.messageId, viewerKey, feedback))) {
    throw new AssistantThreadError('Thread not found', 404);
  }

  const traceId = traceIdFromMessage(message);
  const annotation: AnnotationOutcome = traceId
    ? await (deps.annotate ?? postTraceAnnotation)(
        feedbackAnnotation(
          { traceId, messageId: input.messageId, threadId, agentId: agent.id, companyId: agent.companyId, userKey: viewerKey },
          feedback,
        ),
      )
    : 'skipped';
  return { messageId: input.messageId, feedback, annotation };
}

/**
 * AGUI-1: maps AgentController session events (the same events the chat SSE stream sends) onto
 * AG-UI protocol events. Pure and stateful per run: one mapper per AG-UI run.
 */
import { EventType, type BaseEvent } from '@ag-ui/core';

/** Structural view of an AgentController event; only the fields read here are typed. */
export interface AguiSourceEvent {
  type: string;
  [key: string]: unknown;
}

export type AguiAgentEndReason = 'complete' | 'aborted' | 'error' | 'suspended';

export interface AguiEventMapperOptions {
  /** AG-UI thread id (echoed on RUN_STARTED / RUN_FINISHED). */
  threadId: string;
  /** AG-UI run id (echoed on RUN_STARTED / RUN_FINISHED). */
  runId: string;
  /** When set, tool events tagged with a different Mastra thread id are ignored. */
  mastraThreadId?: string;
}

export interface AguiPendingInterrupt {
  toolCallId: string;
  toolName: string;
  reason: 'tool_approval' | 'tool_suspended';
}

/** CUSTOM event names this endpoint emits (prefix keeps them apart from other producers). */
export const AGUI_CUSTOM = {
  toolApprovalRequired: 'tourbillon.tool_approval_required',
  toolSuspended: 'tourbillon.tool_suspended',
  followUpQueued: 'tourbillon.follow_up_queued',
  /** Queued follow-ups that will not run (run aborted, failed or ended first); value `{ count }`. */
  followUpDropped: 'tourbillon.follow_up_dropped',
  control: 'tourbillon.control',
} as const;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') {
    return (value as { message: string }).message;
  }
  return undefined;
}

/** JSON text for a tool result; Error objects keep name + message. */
export function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  if (result instanceof Error) return JSON.stringify({ error: { name: result.name, message: result.message } });
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function createAguiEventMapper(options: AguiEventMapperOptions) {
  const assistantMessages = new Set<string>();
  /** Mastra message id → open AG-UI text message id. */
  const openText = new Map<string, string>();
  /** Mastra message id → open AG-UI reasoning message id. */
  const openReasoning = new Map<string, string>();
  /** Mastra message id → number of text / reasoning segments started (tool calls split text). */
  const segments = new Map<string, number>();
  /** Tool call ids with TOOL_CALL_START sent. */
  const startedTools = new Set<string>();
  /** Tool call ids started but without TOOL_CALL_END yet. */
  const openTools = new Set<string>();
  const resultsSent = new Set<string>();
  const pendingInterrupts = new Map<string, AguiPendingInterrupt>();
  let lastError: string | undefined;
  let endReason: AguiAgentEndReason | undefined;
  let finished = false;

  const segmentId = (messageId: string, kind: 'text' | 'reasoning'): string => {
    const n = segments.get(messageId) ?? 0;
    segments.set(messageId, n + 1);
    if (kind === 'text' && n === 0) return messageId;
    return `${messageId}:${kind}:${n}`;
  };

  const closeReasoning = (messageId: string, out: BaseEvent[]) => {
    const id = openReasoning.get(messageId);
    if (!id) return;
    openReasoning.delete(messageId);
    out.push({ type: EventType.REASONING_MESSAGE_END, messageId: id } as BaseEvent);
    out.push({ type: EventType.REASONING_END, messageId: id } as BaseEvent);
  };

  const closeText = (messageId: string, out: BaseEvent[]) => {
    const id = openText.get(messageId);
    if (!id) return;
    openText.delete(messageId);
    out.push({ type: EventType.TEXT_MESSAGE_END, messageId: id } as BaseEvent);
  };

  const closeToolArgs = (toolCallId: string, out: BaseEvent[]) => {
    if (!openTools.has(toolCallId)) return;
    openTools.delete(toolCallId);
    out.push({ type: EventType.TOOL_CALL_END, toolCallId } as BaseEvent);
  };

  const startTool = (toolCallId: string, toolName: string, parentMessageId: string | undefined, out: BaseEvent[]) => {
    if (startedTools.has(toolCallId)) return false;
    if (parentMessageId) {
      closeText(parentMessageId, out);
      closeReasoning(parentMessageId, out);
    }
    startedTools.add(toolCallId);
    openTools.add(toolCallId);
    out.push({
      type: EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: toolName,
      ...(parentMessageId ? { parentMessageId } : {}),
    } as BaseEvent);
    return true;
  };

  const closeAll = (out: BaseEvent[]) => {
    for (const id of [...openReasoning.keys()]) closeReasoning(id, out);
    for (const id of [...openText.keys()]) closeText(id, out);
    for (const id of [...openTools]) closeToolArgs(id, out);
  };

  const otherThread = (event: AguiSourceEvent) =>
    options.mastraThreadId !== undefined &&
    typeof event.threadId === 'string' &&
    event.threadId !== options.mastraThreadId;

  function map(event: AguiSourceEvent): BaseEvent[] {
    if (finished || otherThread(event)) return [];
    const out: BaseEvent[] = [];
    switch (event.type) {
      case 'agent_start':
        endReason = undefined;
        lastError = undefined;
        break;
      case 'message_start': {
        const message = event.message as { id?: unknown; role?: unknown } | undefined;
        const id = str(message?.id);
        if (id && message?.role === 'assistant') assistantMessages.add(id);
        break;
      }
      case 'message_update': {
        const id = str(event.id);
        const update = event.event as { type?: unknown; delta?: unknown } | undefined;
        if (!id || !assistantMessages.has(id) || !update) break;
        const delta = typeof update.delta === 'string' ? update.delta : '';
        if (!delta) break;
        if (update.type === 'text-delta') {
          closeReasoning(id, out);
          let textId = openText.get(id);
          if (!textId) {
            textId = segmentId(id, 'text');
            openText.set(id, textId);
            out.push({ type: EventType.TEXT_MESSAGE_START, messageId: textId, role: 'assistant' } as BaseEvent);
          }
          out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: textId, delta } as BaseEvent);
        } else if (update.type === 'reasoning-delta') {
          closeText(id, out);
          let reasoningId = openReasoning.get(id);
          if (!reasoningId) {
            reasoningId = segmentId(id, 'reasoning');
            openReasoning.set(id, reasoningId);
            out.push({ type: EventType.REASONING_START, messageId: reasoningId } as BaseEvent);
            out.push({ type: EventType.REASONING_MESSAGE_START, messageId: reasoningId, role: 'reasoning' } as BaseEvent);
          }
          out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: reasoningId, delta } as BaseEvent);
        }
        break;
      }
      case 'message_end': {
        const id = str(event.id);
        if (id) {
          closeReasoning(id, out);
          closeText(id, out);
        }
        break;
      }
      case 'tool_input_start': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId) startTool(toolCallId, str(event.toolName) ?? 'tool', str(event.messageId), out);
        break;
      }
      case 'tool_input_delta': {
        const toolCallId = str(event.toolCallId);
        const delta = typeof event.argsTextDelta === 'string' ? event.argsTextDelta : '';
        if (toolCallId && delta && openTools.has(toolCallId)) {
          out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta } as BaseEvent);
        }
        break;
      }
      case 'tool_input_end': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId) closeToolArgs(toolCallId, out);
        break;
      }
      case 'tool_start':
      case 'tool_approval_required':
      case 'tool_suspended': {
        const toolCallId = str(event.toolCallId);
        if (!toolCallId) break;
        const toolName = str(event.toolName) ?? 'tool';
        if (startTool(toolCallId, toolName, undefined, out)) {
          out.push({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: serializeToolResult(event.args ?? {}),
          } as BaseEvent);
        }
        closeToolArgs(toolCallId, out);
        if (event.type === 'tool_approval_required' || event.type === 'tool_suspended') {
          const reason = event.type === 'tool_approval_required' ? 'tool_approval' : 'tool_suspended';
          pendingInterrupts.set(toolCallId, { toolCallId, toolName, reason });
          out.push({
            type: EventType.CUSTOM,
            name: reason === 'tool_approval' ? AGUI_CUSTOM.toolApprovalRequired : AGUI_CUSTOM.toolSuspended,
            value: { toolCallId, toolName, args: event.args ?? null },
          } as BaseEvent);
        }
        break;
      }
      case 'tool_suspension_cancelled': {
        const toolCallId = str(event.toolCallId);
        if (toolCallId) pendingInterrupts.delete(toolCallId);
        break;
      }
      case 'tool_end': {
        const toolCallId = str(event.toolCallId);
        if (!toolCallId || resultsSent.has(toolCallId)) break;
        pendingInterrupts.delete(toolCallId);
        if (startTool(toolCallId, str(event.toolName) ?? 'tool', undefined, out)) {
          out.push({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: '{}' } as BaseEvent);
        }
        closeToolArgs(toolCallId, out);
        resultsSent.add(toolCallId);
        out.push({
          type: EventType.TOOL_CALL_RESULT,
          messageId: `${toolCallId}:result`,
          toolCallId,
          role: 'tool',
          content: serializeToolResult(event.result),
          ...(event.isError === true || event.denied === true
            ? { metadata: { isError: event.isError === true, denied: event.denied === true } }
            : {}),
        } as BaseEvent);
        break;
      }
      case 'follow_up_queued': {
        const count = typeof event.count === 'number' ? event.count : 0;
        out.push({ type: EventType.CUSTOM, name: AGUI_CUSTOM.followUpQueued, value: { count } } as BaseEvent);
        break;
      }
      case 'error':
        lastError = errorMessage(event.error) ?? 'Agent run failed';
        break;
      case 'agent_end': {
        const reason = event.reason;
        endReason =
          reason === 'aborted' || reason === 'error' || reason === 'suspended' ? reason : 'complete';
        closeAll(out);
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** Terminal events for the AG-UI run. Safe to call once; later calls return []. */
  function finish(override?: { error?: string; reason?: AguiAgentEndReason }): BaseEvent[] {
    if (finished) return [];
    const out: BaseEvent[] = [];
    closeAll(out);
    finished = true;
    const reason = override?.reason ?? (override?.error ? 'error' : endReason ?? 'complete');
    if (reason === 'error') {
      out.push({
        type: EventType.RUN_ERROR,
        message: override?.error ?? lastError ?? 'Agent run failed',
        code: 'agent_error',
      } as BaseEvent);
      return out;
    }
    const interrupts = [...pendingInterrupts.values()];
    const outcome =
      reason === 'aborted'
        ? { type: 'cancelled' as const }
        : interrupts.length > 0
          ? {
              type: 'interrupt' as const,
              interrupts: interrupts.map((i) => ({ id: i.toolCallId, reason: i.reason, toolCallId: i.toolCallId })),
            }
          : { type: 'success' as const };
    out.push({
      type: EventType.RUN_FINISHED,
      threadId: options.threadId,
      runId: options.runId,
      outcome,
      result: { reason },
    } as BaseEvent);
    return out;
  }

  return {
    map,
    finish,
    get endReason() {
      return endReason;
    },
    get finished() {
      return finished;
    },
    pendingInterrupts: () => [...pendingInterrupts.values()],
  };
}

export type AguiEventMapper = ReturnType<typeof createAguiEventMapper>;
